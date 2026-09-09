import { Bot } from 'grammy';
import { OpenRouterClient } from '../src/ai/openrouter';
import { loadConfig } from '../src/config';
import { configureSecretRedaction, logger } from '../src/logger';

/**
 * The daily health check: GET /api/cron, run by Vercel Cron.
 *
 * Two things break Viby silently rather than loudly, and both have a date or a
 * number you can see coming:
 *
 *  - the Azure DevOps PAT expires, and the mobile client and wiki quietly stop
 *    being readable while every other answer still works;
 *  - the OpenRouter credit runs out mid-conversation, in front of the team.
 *
 * Neither shows up in an error log anyone reads, so this messages the
 * maintainer directly, and only when something actually needs doing — a cron
 * that reports "all fine" every morning is a cron people learn to ignore.
 */

interface VercelRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
}
interface VercelResponse {
  status(code: number): VercelResponse;
  send(body: string): void;
}

/** Warn this far ahead — a week is enough to rotate without it being urgent. */
const EXPIRY_WARNING_DAYS = 7;
/**
 * Five dollars is about 260 answers at the measured average — a week for a
 * five-person chat. Warning at two would have left roughly a day to react.
 */
const LOW_CREDIT_USD = 5;

const config = loadConfig();
configureSecretRedaction([
  config.vercelToken,
  config.telegramBotToken,
  config.telegramWebhookSecret,
  config.openRouterApiKey,
  config.githubToken,
  config.redisToken,
  config.azureToken,
]);

function daysUntil(isoDate: string): number | null {
  const then = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(then)) return null;
  return Math.ceil((then - Date.now()) / 86_400_000);
}

/**
 * Warnings, split by who actually needs them.
 *
 * The token expiring changes what the bot can answer, so the whole team should
 * see it coming rather than discover it as "Viby has gone stupid about the
 * app". The credit balance is a number only the account holder can act on, and
 * a running total of spend does not belong in a team chat.
 */
interface Warnings {
  team: string[];
  maintainer: string[];
}

async function collectWarnings(): Promise<Warnings> {
  const team: string[] = [];
  const maintainer: string[] = [];

  if (config.azureToken && config.azurePatExpires) {
    const left = daysUntil(config.azurePatExpires);
    if (left !== null && left <= EXPIRY_WARNING_DAYS) {
      team.push(
        left <= 0
          ? `🔑 <b>My Azure DevOps access has expired</b> (${config.azurePatExpires}). I can no longer read the <b>mobile client</b> or the <b>wiki</b> — ask me about those and I will come up empty. The GitHub repos are unaffected.`
          : `🔑 <b>My Azure DevOps access expires in ${left} day${left === 1 ? '' : 's'}</b>, on ${config.azurePatExpires}. After that I lose the <b>mobile client</b> and the <b>wiki</b>; the GitHub repos keep working.`,
      );
      team.push(
        'Whoever holds the token: rotate it at <code>dev.azure.com/fwollo/_usersSettings/tokens</code> with scope <b>Code = Read</b> only, then replace <code>AZURE_DEVOPS_PAT</code> in the Vercel project and redeploy.',
      );
    }
  }

  const credit = await new OpenRouterClient(config.openRouterApiKey).remainingCredit();
  if (credit !== null && credit < LOW_CREDIT_USD) {
    maintainer.push(
      `💳 <b>OpenRouter credit is down to $${credit.toFixed(2)}</b> — roughly ${Math.max(0, Math.floor(credit / 0.019))} more answers. Top up at openrouter.ai/credits before it runs out mid-conversation.`,
    );
  }

  return { team, maintainer };
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  // Vercel Cron signs its calls; without the secret set, anyone could poke this.
  const expected = process.env.CRON_SECRET?.trim();
  if (expected && req.headers.authorization !== `Bearer ${expected}`) {
    res.status(401).send('Unauthorised');
    return;
  }

  try {
    const { team, maintainer } = await collectWarnings();
    if (!team.length && !maintainer.length) {
      res.status(200).send('ok: nothing to report');
      return;
    }

    const owner = config.allowedUserIds[0];
    // Team warnings go to every group Viby serves; with no group configured
    // they fall back to the maintainer rather than going nowhere.
    const teamChats =
      config.groupEnabled && config.allowedChatIds.length
        ? config.allowedChatIds
        : owner !== undefined
          ? [owner]
          : [];

    const deliveries: { chatId: number; body: string }[] = [];
    if (team.length) {
      for (const chatId of teamChats) deliveries.push({ chatId, body: team.join('\n\n') });
    }
    if (maintainer.length && owner !== undefined) {
      deliveries.push({ chatId: owner, body: maintainer.join('\n\n') });
    }

    if (!deliveries.length) {
      logger.warn('Cron has warnings but no chat is configured to receive them');
      res.status(200).send('ok: nobody to tell');
      return;
    }

    const bot = new Bot(config.telegramBotToken);
    await bot.init();
    for (const { chatId, body } of deliveries) {
      try {
        await bot.api.sendMessage(chatId, body, {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        });
      } catch (err) {
        // One unreachable chat must not silence the others.
        logger.error(`Cron could not reach chat ${chatId}`, err);
      }
    }
    logger.info(`Cron delivered ${deliveries.length} message(s)`);
    res.status(200).send(`ok: warned (${deliveries.length})`);
  } catch (err) {
    logger.error('Cron check failed', err);
    // Still 200: a failed check must not make Vercel retry-storm the endpoint.
    res.status(200).send('ok: check failed');
  }
}
