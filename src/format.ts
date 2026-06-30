/** Presentation helpers shared by the command builders. */

/** Escape the five characters that matter for Telegram HTML parse mode. */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** An <a> tag with an escaped label. URLs are validated by the caller. */
export function link(label: string, url: string): string {
  return `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
}

/** First 7 chars of a commit SHA, or undefined. */
export function shortSha(sha: string | undefined): string | undefined {
  if (!sha) return undefined;
  return sha.slice(0, 7);
}

/** First non-empty line of a (possibly multi-line) commit message, trimmed. */
export function firstLine(message: string | undefined, max = 80): string | undefined {
  if (!message) return undefined;
  const line = message.split('\n').find((l) => l.trim().length > 0)?.trim();
  if (!line) return undefined;
  return line.length > max ? line.slice(0, max - 1).trimEnd() + '…' : line;
}

/**
 * Human-friendly "time ago" for a past epoch-ms timestamp.
 * Examples: "just now", "6 min ago", "1h 12m ago", "3d ago".
 */
export function timeAgo(epochMs: number | undefined, now: number = Date.now()): string {
  if (!epochMs || !Number.isFinite(epochMs)) return 'unknown';
  let seconds = Math.round((now - epochMs) / 1000);
  if (seconds < 0) seconds = 0;
  if (seconds < 45) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (hours < 24) {
    return remMinutes > 0 ? `${hours}h ${remMinutes}m ago` : `${hours}h ago`;
  }

  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  if (days < 7) {
    return remHours > 0 ? `${days}d ${remHours}h ago` : `${days}d ago`;
  }

  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
}

/** Ensure a value is an absolute http(s) URL; returns undefined otherwise. */
export function asHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}
