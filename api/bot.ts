import { createBot } from '../src/bot';
import { loadConfig } from '../src/config';
import { configureSecretRedaction, logger } from '../src/logger';

/**
 * Vercel serverless webhook endpoint: POST /api/bot
 *
 * Vercel functions are short-lived, so the bot runs in webhook mode here
 * (Telegram pushes updates to this URL) instead of long polling. The local
 * `src/index.ts` entry still uses long polling for development.
 */

/** Minimal shape of the Vercel Node request/response we rely on. */
interface VercelRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}
interface VercelResponse {
  status(code: number): VercelResponse;
  send(body: string): void;
}

const config = loadConfig();
configureSecretRedaction([config.vercelToken, config.telegramBotToken]);

// Reused across warm invocations; re-created on a cold start.
const bot = createBot(config);
let initialized: Promise<void> | undefined;
function ensureInitialized(): Promise<void> {
  if (!initialized) initialized = bot.init();
  return initialized;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  // Health check / friendly landing for GET.
  if (req.method === 'GET') {
    res.status(200).send('Vibespot Ops bot is running.');
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  // Only Telegram knows the secret token, so reject anything else.
  const expected = config.telegramWebhookSecret;
  if (expected && req.headers['x-telegram-bot-api-secret-token'] !== expected) {
    res.status(401).send('Unauthorised');
    return;
  }

  try {
    await ensureInitialized();
    await bot.handleUpdate(req.body as Parameters<typeof bot.handleUpdate>[0]);
  } catch (err) {
    logger.error('Webhook handler error', err);
  }
  // Always ack 200 so Telegram does not retry-storm on a transient error.
  res.status(200).send('ok');
}
