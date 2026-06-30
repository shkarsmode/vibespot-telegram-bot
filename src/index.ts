import { GrammyError } from 'grammy';
import { BOT_COMMANDS, createBot } from './bot';
import { ConfigError, loadConfig } from './config';
import { configureSecretRedaction, logger } from './logger';

/**
 * Local entry point: runs the bot in long-polling mode (no public URL needed).
 * Production on Vercel uses the webhook handler in api/bot.ts instead.
 */
async function main(): Promise<void> {
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

  const bot = createBot(config);

  // The command menu is a nice-to-have; a failure here must not kill startup.
  try {
    await bot.api.setMyCommands(BOT_COMMANDS);
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
