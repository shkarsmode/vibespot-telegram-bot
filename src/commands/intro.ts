import type { RepoConfig } from '../config';
import { escapeHtml } from '../format';

/**
 * Viby's self-introduction — shown on /start and the first time it is added to
 * a group. It has to answer, in one screen: who is this, what does it know,
 * how do I talk to it, and what will it refuse to do.
 */

export function buildIntro(botUsername: string, repos: RepoConfig[]): string {
  const knows = repos
    .map(
      (repo) =>
        `• <b>${escapeHtml(repo.label)}</b> — <code>${escapeHtml(repo.owner)}/${escapeHtml(repo.name)}</code> (${escapeHtml(repo.branches.join(', '))})`,
    )
    .join('\n');

  return [
    "👋 Hi, I'm <b>Viby</b> — the Vibespot engineering assistant.",
    '',
    '<b>What I know</b>',
    knows,
    "I read these live from GitHub, so I'm always on the current code — not a stale snapshot.",
    '',
    '<b>What I can do</b>',
    '• Answer questions about the codebase — where something lives, how a flow works, what changed recently. I cite real file paths and say which branch.',
    '• /deployments — live production status of Landing, Web Client and API/AI',
    '• Remember things for this chat — just say <i>"Viby, remember that …"</i>',
    '',
    '<b>Tune me</b>',
    '• /model — pick the model: cheap and fast, or slower and deeper',
    '• /effort — how hard I think and how many files I read',
    '• /usage — what today has cost so far (answers, tokens, $)',
    '',
    '<b>How to reach me</b>',
    '• Start your message with <b>Viby …</b>',
    `• Mention <b>@${escapeHtml(botUsername)}</b>, or reply to one of my messages`,
    '• Or use /ask',
    '',
    '<b>What I will not do</b>',
    "I only read. I can't write code, commit or deploy — and I never repeat secrets, tokens or keys.",
    '',
    '<i>I answer in English, keep it short, and use code blocks. /help for the full command list.</i>',
  ].join('\n');
}

export function buildHelp(botUsername: string): string {
  return [
    '🤖 <b>Viby</b> — Vibespot engineering assistant',
    '',
    '<b>Ask me anything about the code</b>',
    `Say <b>Viby …</b>, mention <b>@${escapeHtml(botUsername)}</b>, reply to me, or use /ask.`,
    '',
    '<b>Commands</b>',
    '/ask — ask a question about the codebase',
    '/deployments — latest Vercel deployment status',
    '/model — choose the AI model (cost vs depth)',
    '/effort — how hard I think and how many files I read',
    '/remember — save a fact for this chat',
    '/memory — list what I remember',
    '/forget — drop a fact (<code>/forget 2</code> or <code>/forget all</code>)',
    '/usage — today’s answers, tokens and cost',
    '/help — this message',
  ].join('\n');
}
