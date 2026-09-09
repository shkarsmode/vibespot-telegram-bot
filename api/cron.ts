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

async function collectWarnings(): Promise<string[]> {
  const warnings: string[] = [];

  if (config.azureToken && config.azurePatExpires) {
    const left = daysUntil(config.azurePatExpires);
    if (left !== null && left <= EXPIRY_WARNING_DAYS) {
      warnings.push(
        left <= 0
          ? `🔑 <b>The Azure DevOps token has expired</b> (${config.azurePatExpires}). I can no longer read the mobile client or the wiki.`
          : `🔑 <b>The Azure DevOps token expires in ${left} day${left === 1 ? '' : 's'}</b> (${config.azurePatExpires}). After that I lose the mobile client and the wiki — the GitHub repos keep working.`,
      );
      warnings.push(
        'Rotate it at <code>dev.azure.com/fwollo/_usersSettings/tokens</code> — scope <b>Code = Read</b> only — then replace <code>AZURE_DEVOPS_PAT</code> in the Vercel project and redeploy.',
      );
    }
  }

  const credit = await new OpenRouterClient(config.openRouterApiKey).remainingCredit();
  if (credit !== null && credit < LOW_CREDIT_USD) {
    warnings.push(
      `💳 <b>OpenRouter credit is down to $${credit.toFixed(2)}</b> — roughly ${Math.max(0, Math.floor(credit / 0.019))} more answers. Top up at openrouter.ai/credits before it runs out mid-conversation.`,
    );
  }

  return warnings;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  // Vercel Cron signs its calls; without the secret set, anyone could poke this.
  const expected = process.env.CRON_SECRET?.trim();
  if (expected && req.headers.authorization !== `Bearer ${expected}`) {
    res.status(401).send('Unauthorised');
    return;
  }

  try {
    const warnings = await collectWarnings();
    if (!warnings.length) {
      res.status(200).send('ok: nothing to report');
      return;
    }

    const maintainer = config.allowedUserIds[0];
    if (maintainer === undefined) {
      logger.warn('Cron has warnings but ALLOWED_USER_IDS is empty, so there is nobody to tell');
      res.status(200).send('ok: no maintainer configured');
      return;
    }

    const bot = new Bot(config.telegramBotToken);
    await bot.init();
    await bot.api.sendMessage(maintainer, warnings.join('\n\n'), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
    logger.info(`Cron sent ${warnings.length} warning line(s)`);
    res.status(200).send('ok: warned');
  } catch (err) {
    logger.error('Cron check failed', err);
    // Still 200: a failed check must not make Vercel retry-storm the endpoint.
    res.status(200).send('ok: check failed');
  }
}
