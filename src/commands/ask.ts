import type { AppConfig } from '../config';
import { escapeHtml } from '../format';
import { logger } from '../logger';
import { scrubSecrets } from '../repo-read';
import { Store, type Effort } from '../store';
import { renderTelegramHtml } from '../telegram-md';
import type { VercelClient } from '../vercel';
import type { Sources } from '../sources';
import { runAgent } from '../ai/loop';
import { DEFAULT_EFFORT, EFFORTS, modelById, modelByKey, MODELS } from '../ai/models';
import { AiApiError, OpenRouterClient, type Usage } from '../ai/openrouter';
import { buildMessages, mentionsRecentWork } from '../ai/prompt';
import { buildToolSchemas, type ToolContext } from '../ai/tools';

/**
 * Orchestrates one answer. Follows the repo convention set by
 * `commands/deployments.ts`: it takes plain values, returns a string, and does
 * zero Telegram I/O — all `ctx` handling stays in `bot.ts`.
 */

/** Wall-clock budget for the whole agent run, inside the function's maxDuration. */
const TIME_BUDGET_MS = 60_000;

export class DailyLimitError extends Error {
  constructor(readonly used: number, readonly limit: number) {
    super(`Daily limit reached (${used}/${limit}).`);
    this.name = 'DailyLimitError';
  }
}

export interface AnswerDeps {
  openRouter: OpenRouterClient;
  sources: Sources;
  vercel: VercelClient;
  store: Store;
  config: AppConfig;
}

export interface AnswerInput {
  chatId: number;
  question: string;
  chatKind: 'dm' | 'group';
  repliedTo?: { author: string; text: string };
  onProgress?: (note: string) => void;
}

export interface AnswerResult {
  /** Telegram-HTML, ready to split and send. */
  html: string;
  usage: Usage;
  /** True when the question was handled locally and cost nothing. */
  free: boolean;
}

/** "remember that X" / "запомни X" — handled locally, with no model call. */
const REMEMBER_INTENT =
  /^\s*(?:viby[\s,:-]*)?(?:please\s+)?(?:remember|memorize|запомни|запам'?ятай|запамятай)(?:\s+that)?[\s:,-]+(.+)$/is;

export function parseRememberIntent(text: string): string | null {
  const match = text.match(REMEMBER_INTENT);
  const fact = match?.[1]?.trim();
  return fact && fact.length > 2 ? fact : null;
}

/** Words that mean the question is about the phone app rather than the web client. */
const MOBILE_HINT = /\b(mobile|native|ios|iphone|android|expo|react[\s-]?native|the app)\b/i;

/**
 * Which repo's commits to pre-fetch for a question about recent work, or null
 * when the question is not about recent work at all. Handing the model the
 * wrong repo's history is worse than handing it none: it would be reading web
 * client commits while being asked what changed in the phone app.
 */
export function pickRecentRepo(question: string, available: string[]): string | null {
  if (!mentionsRecentWork(question)) return null;
  if (MOBILE_HINT.test(question) && available.includes('mobile')) return 'mobile';
  return available.includes('webclient') ? 'webclient' : null;
}

/** Short, token-free explanation for a failed model call. */
export function friendlyAiError(err: unknown): string {
  if (err instanceof DailyLimitError) {
    return `🚦 Daily limit reached for this chat (${err.used}/${err.limit} answers). It resets at 00:00 UTC.`;
  }
  if (err instanceof AiApiError) {
    switch (err.kind) {
      case 'unauthorized':
        return '⚠️ The OpenRouter key is invalid or expired.';
      case 'payment_required':
        return '⚠️ OpenRouter credits are exhausted — top up at openrouter.ai/credits.';
      case 'rate_limited':
        return '⚠️ The model is rate limited right now. Try again in a moment.';
      case 'bad_request':
        return '⚠️ The model rejected the request. Try /model to pick another one.';
      case 'network':
        return '⚠️ Could not reach OpenRouter (or it took too long).';
      default:
        return '⚠️ The model service returned an error.';
    }
  }
  return '⚠️ Something went wrong while answering. Please try again.';
}

function buildFooter(modelId: string, effort: Effort, toolsUsed: string[], usage: Usage): string {
  const label = modelById(modelId)?.key ?? modelId;
  const tokens = usage.promptTokens + usage.completionTokens;
  const parts = [
    label,
    effort,
    `${toolsUsed.length} tool${toolsUsed.length === 1 ? '' : 's'}`,
    `${(tokens / 1000).toFixed(1)}k tok`,
  ];
  if (usage.costUsd > 0) parts.push(`$${usage.costUsd.toFixed(4)}`);
  return `<i>${escapeHtml(parts.join(' · '))}</i>`;
}

export async function buildAnswer(deps: AnswerDeps, input: AnswerInput): Promise<AnswerResult> {
  const { store, config } = deps;

  // Local shortcut: "remember X" never reaches the model.
  const fact = parseRememberIntent(input.question);
  if (fact) {
    await store.addMemory(input.chatId, fact);
    return {
      html: `📌 Got it — I'll remember that.\n\n<blockquote>${escapeHtml(fact)}</blockquote>\n\nUse /memory to see everything, /forget to drop one.`,
      usage: { promptTokens: 0, completionTokens: 0, costUsd: 0, cachedTokens: 0 },
      free: true,
    };
  }

  // Cost guard runs before anything is spent.
  const calls = await store.bumpCallCount(input.chatId);
  if (calls > config.dailyCallLimit) {
    throw new DailyLimitError(calls - 1, config.dailyCallLimit);
  }

  const settings = await store.getSettings(input.chatId, {
    model: config.defaultModel,
    effort: DEFAULT_EFFORT,
  });
  const model =
    modelById(settings.model) ??
    modelByKey(settings.model) ??
    modelById(config.defaultModel) ??
    MODELS[0];
  const profile = EFFORTS[settings.effort];

  const memory = await store.listMemory(input.chatId);
  // One cheap, cached call — and it removes a whole tool round from the answer.
  const recentRepo = pickRecentRepo(input.question, deps.sources.listRepos().map((r) => r.key));
  const recentCommits = recentRepo
    ? await deps.sources
        .recentCommits(recentRepo, undefined, 12)
        .then((cs) => cs.map((c) => `${c.sha}  ${c.date.slice(0, 10)}  ${c.message}`))
        .catch(() => [])
    : [];
  const history = config.groupEnabled && input.chatKind === 'group'
    ? await store.getHistory(input.chatId, 12)
    : [];

  const toolCtx: ToolContext = {
    sources: deps.sources,
    vercel: deps.vercel,
    projects: config.projects,
    profile,
    charsUsed: { value: 0 },
  };

  const run = await runAgent({
    client: deps.openRouter,
    model,
    profile,
    messages: buildMessages({
      question: input.question,
      memory,
      history,
      profile,
      chatKind: input.chatKind,
      repliedTo: input.repliedTo,
      recentCommits,
      recentCommitsRepo: recentRepo ?? undefined,
    }),
    tools: buildToolSchemas(deps.sources),
    toolCtx,
    deadlineMs: Date.now() + TIME_BUDGET_MS,
    onProgress: input.onProgress,
  });

  await store.recordUsage(input.chatId, {
    tokensIn: run.usage.promptTokens,
    tokensOut: run.usage.completionTokens,
    costUsd: run.usage.costUsd,
  });

  logger.info(
    `Viby answered chat=${input.chatId} model=${model.key} effort=${profile.key} ` +
      `tools=${run.toolsUsed.length} stop=${run.stopReason} ` +
      `tokens=${run.usage.promptTokens}/${run.usage.completionTokens} cached=${run.usage.cachedTokens} ` +
      `cost=$${run.usage.costUsd.toFixed(4)}`,
  );

  const answer = run.text.trim() || 'I could not produce an answer for that. Try rephrasing?';
  // Scrub once more on the way out: the model may have quoted a fetched secret.
  const html = renderTelegramHtml(scrubSecrets(answer));
  const footer = buildFooter(model.id, profile.key, run.toolsUsed, run.usage);

  return { html: `${html}\n\n${footer}`, usage: run.usage, free: false };
}
