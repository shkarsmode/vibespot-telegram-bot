/**
 * Tiny logger with defensive secret redaction.
 *
 * Tokens are never intentionally passed into log calls, but this scrubs every
 * logged string two ways — by exact configured value and by token-shaped
 * pattern — so a token can never leak through console output.
 */

const REDACTORS: RegExp[] = [
  /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, // Telegram bot token
  /\bvcp_[A-Za-z0-9]{20,}\b/g, // Vercel token (new format)
  /\bsk-or-v1-[A-Za-z0-9]{32,}\b/g, // OpenRouter API key
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, // GitHub fine-grained PAT
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub classic token
  /\bpk\.eyJ[A-Za-z0-9._-]{20,}\b/g, // Mapbox public token (lives in the webclient repo)
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, // Authorization header value
];

/**
 * Exact secret values to scrub by literal match — more robust than the format
 * heuristics above because it covers any token format (e.g. a bare Vercel
 * account token with no `vcp_` prefix). Populate once at startup via
 * configureSecretRedaction().
 */
const exactSecrets = new Set<string>();

export function configureSecretRedaction(secrets: Array<string | undefined>): void {
  for (const secret of secrets) {
    if (secret && secret.length >= 8) exactSecrets.add(secret);
  }
}

export function redact(input: unknown): string {
  let text =
    typeof input === 'string'
      ? input
      : input instanceof Error
        ? `${input.name}: ${input.message}`
        : safeStringify(input);
  for (const secret of exactSecrets) {
    if (text.includes(secret)) text = text.split(secret).join('[REDACTED]');
  }
  for (const re of REDACTORS) text = text.replace(re, '[REDACTED]');
  return text;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function ts(): string {
  // toISOString is locale-independent and contains no secrets.
  return new Date().toISOString();
}

export const logger = {
  info(message: string, meta?: unknown): void {
    console.log(`${ts()} [info] ${redact(message)}${meta ? ' ' + redact(meta) : ''}`);
  },
  warn(message: string, meta?: unknown): void {
    console.warn(`${ts()} [warn] ${redact(message)}${meta ? ' ' + redact(meta) : ''}`);
  },
  error(message: string, meta?: unknown): void {
    console.error(`${ts()} [error] ${redact(message)}${meta ? ' ' + redact(meta) : ''}`);
  },
};
