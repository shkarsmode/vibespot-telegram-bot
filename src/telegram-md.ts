import { asHttpUrl, escapeHtml } from './format';

/**
 * Markdown -> Telegram HTML, plus a splitter for Telegram's 4096-char limit.
 *
 * Telegram supports only a small tag set (b, i, s, u, code, pre, a, blockquote)
 * and rejects the whole message with "can't parse entities" if anything else
 * shows up. So: pull code out first, escape everything that remains, inject our
 * own tags, then put the (escaped) code back.
 */

const TELEGRAM_LIMIT = 4096;
/** Leave room for the footer and for re-opened code fences when splitting. */
const SAFE_LIMIT = 3_900;

const BLOCK_MARK = '\u0000B';
const INLINE_MARK = '\u0000I';

interface CodeBlock {
  language: string;
  code: string;
}

export function renderTelegramHtml(markdown: string): string {
  const blocks: CodeBlock[] = [];
  const inlines: string[] = [];

  // 1. Fenced code out of harm's way.
  let text = markdown.replace(/```([a-zA-Z0-9+#._-]*)\n?([\s\S]*?)```/g, (_m, lang: string, code: string) => {
    blocks.push({ language: lang.trim(), code: code.replace(/\n$/, '') });
    return `${BLOCK_MARK}${blocks.length - 1}\u0000`;
  });

  // 2. Inline code out too.
  text = text.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    inlines.push(code);
    return `${INLINE_MARK}${inlines.length - 1}\u0000`;
  });

  // 3. Everything left is prose — escape it before we add any tags.
  text = escapeHtml(text);

  // 4a. Line-level structure. Note `>` is already `&gt;` after escaping.
  text = text
    .split('\n')
    .map((line) => {
      const heading = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
      if (heading) return `<b>${heading[1].trim()}</b>`;
      if (/^\s*([-*_])\s*\1\s*\1[\s-*_]*$/.test(line)) return '——————————';
      return line.replace(/^(\s*)[-*+]\s+/, (_m, indent: string) => `${indent}• `);
    })
    .join('\n');

  // Contiguous quote lines collapse into one blockquote.
  text = text.replace(/(?:^&gt;\s?.*(?:\n|$))+/gm, (match) => {
    const body = match
      .replace(/\n$/, '')
      .split('\n')
      .map((l) => l.replace(/^&gt;\s?/, ''))
      .join('\n');
    return `<blockquote>${body}</blockquote>\n`;
  });

  // 4b. Inline structure. Links first so their text is not mangled by emphasis.
  text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => {
    const safe = asHttpUrl(url);
    return safe ? `<a href="${escapeHtml(safe)}">${label}</a>` : label;
  });
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  text = text.replace(/__([^_\n]+)__/g, '<b>$1</b>');
  text = text.replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, '<i>$1</i>');
  text = text.replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, '<i>$1</i>');
  text = text.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');

  // 5. Code goes back in, escaped.
  text = text.replace(new RegExp(`${INLINE_MARK}(\\d+)\u0000`, 'g'), (_m, index: string) => {
    return `<code>${escapeHtml(inlines[Number(index)] ?? '')}</code>`;
  });
  text = text.replace(new RegExp(`${BLOCK_MARK}(\\d+)\u0000`, 'g'), (_m, index: string) => {
    const block = blocks[Number(index)];
    if (!block) return '';
    const open = block.language
      ? `<pre><code class="language-${escapeHtml(block.language)}">`
      : '<pre><code>';
    return `${open}${escapeHtml(block.code)}</code></pre>`;
  });

  // 6. Tidy.
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Split rendered HTML into Telegram-sized messages without ever cutting a code
 * block open: if a `<pre>` has to span the boundary it is closed and reopened.
 */
export function splitForTelegram(html: string, limit: number = SAFE_LIMIT): string[] {
  if (html.length <= limit) return [html];

  const chunks: string[] = [];
  let current = '';
  let openFence: string | null = null;

  const flush = () => {
    if (!current.trim()) {
      current = '';
      return;
    }
    chunks.push(openFence ? `${current}</code></pre>` : current);
    current = openFence ?? '';
  };

  for (const line of html.split('\n')) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > limit && current) {
      flush();
      current = current ? `${current}\n${line}` : line;
    } else {
      current = candidate;
    }

    // Track whether we are inside a code block after this line.
    const opens = line.match(/<pre><code(?: class="language-[^"]*")?>/g);
    if (opens?.length) openFence = opens[opens.length - 1];
    if (line.includes('</code></pre>')) openFence = null;
  }

  if (current.trim()) chunks.push(openFence ? `${current}</code></pre>` : current);
  return chunks.filter((c) => c.trim().length > 0);
}

/** Plain-text fallback for when Telegram still refuses to parse the HTML. */
export function stripTelegramHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|blockquote|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .slice(0, TELEGRAM_LIMIT);
}
