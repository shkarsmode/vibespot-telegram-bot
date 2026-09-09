import { runInBackground } from '../src/background';
import { createBot } from '../src/bot';
import { loadConfig } from '../src/config';
import { configureSecretRedaction, logger } from '../src/logger';
import { Store } from '../src/store';

/**
 * Vercel serverless webhook endpoint: POST /api/bot
 *
 * Vercel functions are short-lived per request, so the bot runs in webhook mode
 * here (Telegram pushes updates to this URL) instead of long polling. The local
 * `src/index.ts` entry still uses long polling for development.
 *
 * An AI answer can take tens of seconds, which is longer than Telegram is happy
 * to wait, so the handler acknowledges first and finishes the work in the
 * background. That makes de-duplication mandatory — see below.
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
configureSecretRedaction([
  config.vercelToken,
  config.telegramBotToken,
  config.telegramWebhookSecret,
  config.openRouterApiKey,
  config.githubToken,
  config.redisToken,
]);

// Reused across warm invocations; re-created on a cold start.
const bot = createBot(config);
const store = new Store(config.redisUrl, config.redisToken);
let initialized: Promise<void> | undefined;
function ensureInitialized(): Promise<void> {
  if (!initialized) initialized = bot.init();
  return initialized;
}

/**
 * Would this update cost money? A duplicate of one of these must never be
 * processed twice, so if we cannot check, we drop it.
 */
function mightCostMoney(update: Record<string, unknown>): boolean {
  const message = update.message as { text?: string } | undefined;
  return Boolean(message?.text) || Boolean(update.callback_query);
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  // Health check / friendly landing for GET.
  if (req.method === 'GET') {
    res.status(200).send('Viby is running.');
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

  const update = (req.body ?? {}) as Record<string, unknown>;
  const updateId = typeof update.update_id === 'number' ? update.update_id : undefined;

  // Because we ack before working, a Telegram retry would otherwise be answered
  // (and billed) twice. Fail CLOSED for anything that spends money.
  if (updateId !== undefined) {
    let fresh: boolean;
    try {
      fresh = await store.claimUpdate(updateId);
    } catch (err) {
      logger.error('Redis de-duplication failed', err);
      fresh = !mightCostMoney(update);
    }
    if (!fresh) {
      res.status(200).send('ok');
      return;
    }
  }

  try {
    await ensureInitialized();
    const pending = runInBackground(() =>
      bot
        .handleUpdate(update as unknown as Parameters<typeof bot.handleUpdate>[0])
        .catch((err) => logger.error('Webhook handler error', err)),
    );
    // No platform background support (local/dev): finish inline.
    if (pending) await pending;
  } catch (err) {
    logger.error('Webhook handler error', err);
  }

  // Always ack 200 so Telegram does not retry-storm on a transient error.
  res.status(200).send('ok');
}
