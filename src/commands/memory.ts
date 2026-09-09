import { escapeHtml } from '../format';
import { MEMORY_MAX_LENGTH } from '../store';

/** Small string builders for Viby's per-chat memory. No Telegram I/O. */

export function buildRememberAck(fact: string, total: number): string {
  return [
    "📌 Got it — I'll remember that.",
    '',
    `<blockquote>${escapeHtml(fact.slice(0, MEMORY_MAX_LENGTH))}</blockquote>`,
    '',
    `<i>${total} fact${total === 1 ? '' : 's'} remembered for this chat. /memory to list, /forget to drop one.</i>`,
  ].join('\n');
}

export function buildMemoryList(items: string[]): string {
  if (!items.length) {
    return [
      '🧠 <b>Memory is empty</b>',
      '',
      'Tell me something worth keeping and I\'ll hold on to it:',
      '<code>/remember prod DB is near-empty on purpose</code>',
      '',
      '<i>Or just say "Viby, remember that …".</i>',
    ].join('\n');
  }
  const lines = items.map((item, index) => `${index + 1}. ${escapeHtml(item)}`);
  return [
    `🧠 <b>What I remember</b> <i>(${items.length})</i>`,
    '',
    ...lines,
    '',
    '<i>/forget &lt;number&gt; to drop one, /forget all to clear.</i>',
  ].join('\n');
}

export function buildForgetResult(removed: boolean, argument: string): string {
  if (argument.trim().toLowerCase() === 'all') {
    return '🧹 Cleared everything I remembered for this chat.';
  }
  return removed
    ? `🧹 Forgotten. <i>/memory to see what's left.</i>`
    : `I don't have a fact at that position. <i>Check /memory for the numbers.</i>`;
}
