/**
 * The rules every repository source obeys before content reaches the model.
 *
 * GitHub and Azure DevOps are different APIs with different shapes, but what
 * may leave a repository — and how much of it — must not depend on which one a
 * file happened to come from. A third source cannot accidentally get weaker
 * rules, because there is only one copy of them: here.
 *
 * The concrete thing this exists to stop: the web client keeps live Mapbox and
 * TimeZoneDB tokens in plaintext.
 */

/** Hard caps so one tool call can never blow up the context. */
export const MAX_FILE_LINES = 200;
export const MAX_FILE_CHARS = 8_000;
export const MAX_OUTLINE_LINES = 400;

/** Lines worth keeping in an outline: declarations, decorators, HTTP calls. */
const OUTLINE_PATTERNS: RegExp[] = [
  /^\s*(export\s+)?(abstract\s+)?(class|interface|enum|type)\s+\w/,
  /^\s*export\s+(const|function|async\s+function|let|default)\s/,
  /^\s*@(Component|Injectable|NgModule|Directive|Pipe|Input|Output|ViewChild|HostListener)\b/,
  /^\s*(constructor)\s*\(/,
  /^\s{2,8}(public|private|protected|static|async|get|set)\s+[\w$]+\s*[(:<]/,
  /this\.http\.(get|post|put|patch|delete)\s*[<(]/,
];

/** Wiki and docs are prose: their structure is the heading tree, not declarations. */
const MARKDOWN_PATTERNS: RegExp[] = [
  /^\s{0,3}#{1,6}\s+\S/,
  /^\s{0,3}\|.*\|\s*$/,
];

/** Declaration (or heading) lines of a file, numbered and capped. */
export function outlineOf(text: string, path: string): { totalLines: number; outline: string } {
  const lines = text.split('\n');
  const patterns = /\.(md|markdown|mdx|txt)$/i.test(path) ? MARKDOWN_PATTERNS : OUTLINE_PATTERNS;
  const kept: string[] = [];
  for (let i = 0; i < lines.length && kept.length < MAX_OUTLINE_LINES; i++) {
    const line = lines[i];
    if (patterns.some((rx) => rx.test(line))) {
      kept.push(`${i + 1}| ${line.trim().slice(0, 200)}`);
    }
  }
  return { totalLines: lines.length, outline: kept.join('\n') };
}

// ---------------------------------------------------------------------------
// Secret scrubbing
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: RegExp[] = [
  /pk\.eyJ[A-Za-z0-9._-]{20,}/g, // Mapbox public token
  /sk\.eyJ[A-Za-z0-9._-]{20,}/g, // Mapbox secret token
  /sk-or-v1-[A-Za-z0-9]{32,}/g, // OpenRouter
  /sk-[A-Za-z0-9]{32,}/g, // OpenAI-style
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, // Telegram bot token
];

/**
 * Redact anything that looks like a credential, plus the value side of any
 * `token: '…'` / `apiKey = "…"` assignment. Deliberately aggressive — a false
 * positive costs the model a little context, a false negative leaks a secret.
 */
export function scrubSecrets(input: string): string {
  let text = input;
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, '«REDACTED»');
  }
  // key: 'value' / key = "value" — keep the key, drop the value.
  //
  // This key-name rule is the ONLY thing that catches a shapeless credential
  // such as the web client's `timeZoneDbToken: 'ON057IU2HV1L'` — 12 plain
  // alphanumerics that no value-shaped pattern can distinguish from real code.
  text = text.replace(
    /((?:api[_-]?key|apikey|token|secret|password|passwd|credential|client[_-]?secret|access[_-]?token|private[_-]?key)["']?\s*[:=]\s*)(['"`])([^'"`\n]{8,})\2/gi,
    (_m, head: string, quote: string) => `${head}${quote}«REDACTED»${quote}`,
  );
  return text;
}

/**
 * Paths Viby must never fetch at all. Scrubbing is the second line of defence;
 * for files that exist purely to hold credentials, refusing is the first.
 */
const DENIED_PATHS: { pattern: RegExp; reason: string }[] = [
  {
    pattern: /(^|\/)src\/environments\//i,
    reason: 'it holds live API tokens (Mapbox, TimeZoneDB)',
  },
  { pattern: /(^|\/)\.env(\.|$)/i, reason: 'it is an environment file' },
  { pattern: /\.(pem|key|p12|pfx|keystore|jks)$/i, reason: 'it is a private key' },
  { pattern: /(^|\/)(secrets?|credentials?)[^/]*$/i, reason: 'its name marks it as secret material' },
  {
    pattern: /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/i,
    reason: 'a lockfile is thousands of lines of noise',
  },
  {
    pattern: /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|eot|mp4|zip|gz|map)$/i,
    reason: 'it is a binary or generated asset',
  },
];

/** A human-readable reason when a path is off-limits, otherwise null. */
export function deniedPathReason(path: string): string | null {
  for (const { pattern, reason } of DENIED_PATHS) {
    if (pattern.test(path)) return reason;
  }
  return null;
}

export class PathDeniedError extends Error {
  constructor(readonly path: string, readonly reason: string) {
    super(`"${path}" cannot be read because ${reason}.`);
    this.name = 'PathDeniedError';
  }
}

// ---------------------------------------------------------------------------
// The vocabulary every source speaks
// ---------------------------------------------------------------------------

export type RepoErrorKind =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'too_large'
  | 'bad_request'
  | 'network'
  | 'http';

export class RepoApiError extends Error {
  constructor(
    readonly kind: RepoErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'RepoApiError';
  }
}

export interface TreeEntry {
  path: string;
  type: 'blob' | 'tree';
  size?: number;
}

export interface FileSlice {
  repo: string;
  branch: string;
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
  content: string;
}

export interface CodeHit {
  path: string;
  fragments: string[];
}

export interface FileChange {
  path: string;
  /** added | modified | removed | renamed */
  status: string;
  additions: number;
  deletions: number;
  /** The unified diff. Only filled in when one path was asked for by name. */
  patch?: string;
}

export interface ChangeSet {
  /** What was compared, for the result header. */
  label: string;
  /** Commits `head` is ahead of `base` by. Compare mode only. */
  aheadBy?: number;
  /** True when this squashes a whole branch range — diffs here are unreadable. */
  combined?: boolean;
  totalFiles: number;
  files: FileChange[];
}

export interface CommitInfo {
  sha: string;
  message: string;
  author: string;
  date: string;
}
