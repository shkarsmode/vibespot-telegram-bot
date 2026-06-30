import { Bot, GrammyError, HttpError } from 'grammy';
import type { AppConfig } from './config';
import { buildDeploymentsReport } from './commands/deployments';
import { logger } from './logger';
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

/** Command menu registered with Telegram (the menu button next to the input). */
export const BOT_COMMANDS = [
  { command: 'deployments', description: 'Latest Vercel deployment status' },
  { command: 'help', description: 'Show help' },
];

/**
 * Build a fully-wired bot. Shared by the local long-polling entry point
 * (src/index.ts) and the Vercel webhook handler (api/bot.ts), so the command
 * behaviour is identical in both run modes.
 */
export function createBot(config: AppConfig): Bot {
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

  return bot;
}
