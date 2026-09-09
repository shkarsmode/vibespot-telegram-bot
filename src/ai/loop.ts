import { logger } from '../logger';
import type { EffortProfile, ModelOption } from './models';
import type { ChatMessage, OpenRouterClient, ToolSchema, Usage } from './openrouter';
import { dispatchTool, type ToolContext } from './tools';

/**
 * The tool-calling loop.
 *
 * Three invariants keep providers from rejecting the conversation with a 400:
 *  1. the assistant message carrying `tool_calls` is appended verbatim, before
 *     any tool result;
 *  2. there is exactly one `tool` message per `tool_call.id`, in the same order;
 *  3. tool execution uses `allSettled`, so one failing tool never leaves an
 *     orphaned `tool_call_id`.
 */

/** Stop asking for tools once less than this remains — leave room to write the answer. */
const FINAL_ANSWER_RESERVE_MS = 12_000;

export type StopReason = 'stop' | 'max_iterations' | 'budget' | 'deadline' | 'length';

export interface AgentResult {
  text: string;
  usage: Usage;
  iterations: number;
  toolsUsed: string[];
  stopReason: StopReason;
}

export interface AgentInput {
  client: OpenRouterClient;
  model: ModelOption;
  profile: EffortProfile;
  messages: ChatMessage[];
  tools: ToolSchema[];
  toolCtx: ToolContext;
  /** Absolute epoch-ms after which we must stop calling tools. */
  deadlineMs: number;
  /** Called with a short note when the model starts a tool round. */
  onProgress?: (note: string) => void;
}

/** Tool results older than this many rounds are trimmed to their header. */
const KEEP_FULL_TOOL_RESULTS = 4;
const TRIMMED_TOOL_RESULT_CHARS = 400;

function addUsage(total: Usage, next: Usage): Usage {
  return {
    promptTokens: total.promptTokens + next.promptTokens,
    completionTokens: total.completionTokens + next.completionTokens,
    costUsd: total.costUsd + next.costUsd,
    cachedTokens: total.cachedTokens + next.cachedTokens,
  };
}

/**
 * Shrink the conversation before re-sending it.
 *
 * Every extra round re-sends every earlier tool result, so a six-round answer
 * pays for the same 40k characters six times — that, not the model, is what
 * makes a deep question expensive. Older results keep their first few hundred
 * characters (which carry the `repo@branch path (lines a-b)` header, the part
 * the model actually cites) and drop the body; the newest results stay intact
 * because those are what it is reasoning about right now.
 */
function trimOldToolResults(messages: ChatMessage[]): ChatMessage[] {
  const toolPositions = messages.reduce<number[]>((acc, message, index) => {
    if (message.role === 'tool') acc.push(index);
    return acc;
  }, []);
  if (toolPositions.length <= KEEP_FULL_TOOL_RESULTS) return messages;

  const firstKept = toolPositions[toolPositions.length - KEEP_FULL_TOOL_RESULTS];
  return messages.map((message, index) => {
    if (message.role !== 'tool' || index >= firstKept) return message;
    const content = message.content ?? '';
    if (content.length <= TRIMMED_TOOL_RESULT_CHARS) return message;
    const dropped = content.length - TRIMMED_TOOL_RESULT_CHARS;
    return {
      ...message,
      content: `${content.slice(0, TRIMMED_TOOL_RESULT_CHARS)}\n[… ${dropped} chars trimmed to save context — call the tool again if you need the rest]`,
    };
  });
}

function describeCall(name: string, rawArguments: string): string {
  try {
    const args = JSON.parse(rawArguments || '{}') as Record<string, unknown>;
    const detail = [args.path, args.path_prefix, args.query].find((v) => typeof v === 'string');
    return detail ? `${name} ${detail}` : name;
  } catch {
    return name;
  }
}

export async function runAgent(input: AgentInput): Promise<AgentResult> {
  const messages = [...input.messages];
  let usage: Usage = { promptTokens: 0, completionTokens: 0, costUsd: 0, cachedTokens: 0 };
  const toolsUsed: string[] = [];

  for (let iteration = 0; iteration < input.profile.maxIterations; iteration++) {
    const timeLeft = input.deadlineMs - Date.now();
    const outOfBudget = input.toolCtx.charsUsed.value >= input.profile.toolCharBudget;
    const outOfTime = timeLeft < FINAL_ANSWER_RESERVE_MS;
    const forceFinal = outOfBudget || outOfTime;

    const result = await input.client.chat({
      model: input.model.id,
      messages: trimOldToolResults(messages),
      tools: forceFinal ? undefined : input.tools,
      maxTokens: input.profile.maxAnswerTokens,
      reasoningEffort: input.model.supportsReasoning ? input.profile.reasoningEffort : undefined,
      cacheSystemPrompt: true,
    });
    usage = addUsage(usage, result.usage);

    if (!result.toolCalls.length) {
      return {
        text: result.content ?? '',
        usage,
        iterations: iteration + 1,
        toolsUsed,
        stopReason: forceFinal
          ? outOfTime
            ? 'deadline'
            : 'budget'
          : result.finishReason === 'length'
            ? 'length'
            : 'stop',
      };
    }

    // Invariant 1 — the assistant turn goes in exactly as received.
    messages.push({
      role: 'assistant',
      content: result.content,
      tool_calls: result.toolCalls,
    });

    input.onProgress?.(
      result.toolCalls.map((c) => describeCall(c.function.name, c.function.arguments)).join(', '),
    );

    // Invariant 3 — allSettled, so a thrown tool cannot drop its siblings.
    const settled = await Promise.allSettled(
      result.toolCalls.map((call) =>
        dispatchTool(call.function.name, call.function.arguments, input.toolCtx),
      ),
    );

    // Invariant 2 — one tool message per call, same order.
    result.toolCalls.forEach((call, index) => {
      const outcome = settled[index];
      const content =
        outcome.status === 'fulfilled'
          ? outcome.value
          : 'ERROR: the tool failed unexpectedly. Try a different approach.';
      if (outcome.status === 'rejected') {
        logger.warn(`Tool ${call.function.name} rejected`, outcome.reason);
      }
      messages.push({ role: 'tool', content, tool_call_id: call.id });
      toolsUsed.push(describeCall(call.function.name, call.function.arguments));
    });
  }

  // Iterations exhausted while the model still wanted tools: force one answer.
  messages.push({
    role: 'user',
    content:
      'Tool budget reached. Answer now with what you already have, and state plainly what you could not verify.',
  });
  const final = await input.client.chat({
    model: input.model.id,
    messages: trimOldToolResults(messages),
    maxTokens: input.profile.maxAnswerTokens,
    reasoningEffort: input.model.supportsReasoning ? input.profile.reasoningEffort : undefined,
    cacheSystemPrompt: true,
  });
  usage = addUsage(usage, final.usage);

  return {
    text: final.content ?? '',
    usage,
    iterations: input.profile.maxIterations,
    toolsUsed,
    stopReason: 'max_iterations',
  };
}
