import { Bot, GrammyError, HttpError } from 'grammy';
import { ConfigError, loadConfig } from './config';
import { buildDeploymentsReport } from './commands/deployments';
import { configureSecretRedaction, logger } from './logger';
import { VercelClient } from './vercel';

const HELP = [
  '👋 <b>Vibespot Ops</b>',
  '',
  'I report live deployment status for the Vibespot projects.',
  '',
  '<b>Commands</b>',
  '/deployments — latest Vercel deployment status (Landing, Web Client, API/AI)',
  '/help — show this message',
].join('\n');

async function main(): Promise<void> {
  // ---- Configuration (fails fast with a clear message) --------------------
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      logger.error(`Configuration error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  // Scrub the real token values from every future log line (defense in depth).
  configureSecretRedaction([config.vercelToken, config.telegramBotToken]);

  const vercel = new VercelClient(config.vercelToken, config.vercelTeamId);
  const bot = new Bot(config.telegramBotToken);

  // ---- Optional allowlist -------------------------------------------------
  bot.use(async (ctx, next) => {
    if (config.allowedUserIds.length === 0) return next();
    const userId = ctx.from?.id;
    if (userId && config.allowedUserIds.includes(userId)) return next();
    logger.warn(`Blocked unauthorised user id=${userId ?? 'unknown'}`);
    if (ctx.chat) await ctx.reply('⛔ You are not authorised to use this bot.');
  });

  // ---- Commands -----------------------------------------------------------
  bot.command(['start', 'help'], (ctx) =>
    ctx.reply(HELP, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }),
  );

  bot.command('deployments', async (ctx) => {
    const loading = await ctx.reply('⏳ Fetching latest deployments…');
    try {
      const report = await buildDeploymentsReport(vercel, config.projects);
      await ctx.api.editMessageText(ctx.chat.id, loading.message_id, report, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      logger.error('Failed to build deployments report', err);
      try {
        await ctx.api.editMessageText(
          ctx.chat.id,
          loading.message_id,
          '⚠️ Could not load deployments right now. Please try again shortly.',
        );
      } catch (editErr) {
        logger.error('Failed to edit deployments message', editErr);
      }
    }
  });

  // ---- Centralised error handling -----------------------------------------
  bot.catch((err) => {
    const e = err.error;
    if (e instanceof GrammyError) {
      logger.error(`Telegram API error: ${e.description}`);
    } else if (e instanceof HttpError) {
      logger.error('Could not reach Telegram');
    } else {
      logger.error('Unhandled bot error', e);
    }
  });

  // ---- Command menu (non-essential) + graceful shutdown -------------------
  // A failure to register the menu must not prevent the bot from running.
  try {
    await bot.api.setMyCommands([
      { command: 'deployments', description: 'Latest Vercel deployment status' },
      { command: 'help', description: 'Show help' },
    ]);
  } catch (err) {
    logger.warn('Could not register the command menu (non-fatal).', err);
  }

  const stop = (signal: string) => {
    logger.info(`Received ${signal}, stopping bot…`);
    void bot.stop();
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));

  if (config.allowedUserIds.length === 0) {
    logger.warn('ALLOWED_USER_IDS is empty — the bot responds to everyone.');
  }

  await bot.start({
    onStart: (info) => logger.info(`Bot @${info.username} started (long polling).`),
  });
}

main().catch((err) => {
  // grammY validates the token lazily: an invalid (but non-empty) token is not
  // rejected at construction — it fails on the first Bot API call (getMe/start).
  if (err instanceof GrammyError && err.error_code === 401) {
    logger.error('Telegram rejected the bot token (HTTP 401). Check TELEGRAM_BOT_TOKEN.');
  } else if (err instanceof GrammyError && err.error_code === 409) {
    logger.error('Telegram conflict (HTTP 409): another instance is already polling this bot.');
  } else {
    logger.error('Fatal startup error', err);
    logger.error('Check TELEGRAM_BOT_TOKEN and network connectivity.');
  }
  process.exit(1);
});
