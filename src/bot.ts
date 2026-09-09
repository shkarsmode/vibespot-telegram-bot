import { Bot, Context, GrammyError, HttpError } from 'grammy';
import { decideAccess, isGroupChat, isMaintainer, type AccessLists } from './access';
import type { AppConfig } from './config';
import { buildDeploymentsReport } from './commands/deployments';
import {
  buildAnswer,
  friendlyAiError,
  parseRememberIntent,
  type AnswerDeps,
} from './commands/ask';
import { buildHelp, buildIntro } from './commands/intro';
import { buildForgetResult, buildMemoryList, buildRememberAck } from './commands/memory';
import {
  buildEffortKeyboard,
  buildModelKeyboard,
  buildUsageReport,
  parseSettingsCallback,
} from './commands/settings';
import { buildWhoAmI } from './commands/whoami';
import { AzureClient } from './azure';
import { GithubClient } from './github';
import { logger } from './logger';
import { Sources } from './sources';
import { Store, type Effort } from './store';
import { splitForTelegram, stripTelegramHtml } from './telegram-md';
import { detectTrigger } from './triggers';
import { VercelClient } from './vercel';
import { DEFAULT_EFFORT, modelByKey } from './ai/models';
import { OpenRouterClient } from './ai/openrouter';

/** Command menu registered with Telegram (the menu button next to the input). */
export const BOT_COMMANDS = [
  { command: 'ask', description: 'Ask Viby about the Vibespot codebase' },
  { command: 'deployments', description: 'Latest Vercel deployment status' },
  { command: 'model', description: 'Choose the AI model' },
  { command: 'effort', description: 'How hard Viby thinks' },
  { command: 'remember', description: 'Save a fact for this chat' },
  { command: 'memory', description: 'List what Viby remembers' },
  { command: 'forget', description: 'Drop a remembered fact' },
  { command: 'usage', description: "Today's answers, tokens and cost" },
  { command: 'whoami', description: 'Show your Telegram ids (for the allowlist)' },
  { command: 'help', description: 'Show help' },
];

const HTML_OPTS = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } };

/**
 * Send HTML, falling back to plain text if Telegram rejects the markup.
 * Telegram answers "can't parse entities" with a 400 and drops the whole
 * message, so the fallback is what guarantees the user still gets the answer.
 */
async function sendHtml(
  ctx: Context,
  html: string,
  editMessageId?: number,
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;

  const send = async (body: string, asHtml: boolean, messageId?: number) => {
    const options = asHtml ? HTML_OPTS : { link_preview_options: { is_disabled: true } };
    if (messageId !== undefined) {
      await ctx.api.editMessageText(chatId, messageId, body, options);
    } else {
      await ctx.api.sendMessage(chatId, body, options);
    }
  };

  const chunks = splitForTelegram(html);
  for (let i = 0; i < chunks.length; i++) {
    const target = i === 0 ? editMessageId : undefined;
    try {
      await send(chunks[i], true, target);
    } catch (err) {
      if (err instanceof GrammyError && /parse entities|can't parse/i.test(err.description)) {
        logger.warn('Telegram rejected HTML; resending as plain text');
        await send(stripTelegramHtml(chunks[i]), false, target);
      } else {
        throw err;
      }
    }
  }
}

/**
 * Build a fully-wired bot. Shared by the local long-polling entry point
 * (src/index.ts) and the Vercel webhook handler (api/bot.ts), so the command
 * behaviour is identical in both run modes.
 */
export function createBot(config: AppConfig): Bot {
  const vercel = new VercelClient(config.vercelToken, config.vercelTeamId);
  const store = new Store(config.redisUrl, config.redisToken);
  const github = new GithubClient(config.githubToken, store, config.githubRepos);
  // Absent without a PAT, and then its repos are simply never registered.
  const azure = config.azureToken
    ? new AzureClient(config.azureToken, store, config.azureRepos)
    : undefined;
  const sources = new Sources([github, azure]);
  const openRouter = new OpenRouterClient(config.openRouterApiKey);
  const bot = new Bot(config.telegramBotToken);

  const deps: AnswerDeps = { openRouter, sources, vercel, store, config };

  const lists: AccessLists = {
    allowedUserIds: config.allowedUserIds,
    allowedChatIds: config.allowedChatIds,
    groupEnabled: config.groupEnabled,
  };

  const identify = (ctx: Context) => ({
    chatType: ctx.chat?.type ?? 'private',
    chatId: ctx.chat?.id ?? 0,
    userId: ctx.from?.id,
  });

  const isGroup = (ctx: Context): boolean => isGroupChat(ctx.chat?.type ?? '');
  const isOwner = (ctx: Context): boolean => isMaintainer(identify(ctx), lists);

  /**
   * Gate for the few actions that change how Viby behaves — model, effort,
   * memory. Anyone in an allowed chat may ask questions; only a maintainer may
   * retune it. In a group we stay quiet rather than spamming refusals.
   */
  const requireMaintainer = async (ctx: Context): Promise<boolean> => {
    if (isOwner(ctx)) return true;
    if (!isGroup(ctx)) await ctx.reply('⛔ Only maintainers can change this.');
    return false;
  };

  // ---- 0. /whoami runs BEFORE the gate, so a locked-down bot can still be
  //         handed a new group. It echoes only the caller's own ids back.
  bot.command('whoami', async (ctx) => {
    const identity = identify(ctx);
    await ctx.reply(
      buildWhoAmI({
        ...identity,
        displayName: ctx.from?.first_name ?? ctx.from?.username ?? 'you',
        isMaintainer: isMaintainer(identity, lists),
        chatAllowed: decideAccess(identity, lists) === 'allow',
      }),
      HTML_OPTS,
    );
  });

  // ---- 1. The access gate: who may talk to this bot at all -----------------
  bot.use(async (ctx, next) => {
    if (!ctx.chat) return;
    const decision = decideAccess(identify(ctx), lists);
    if (decision === 'allow') return next();
    if (decision === 'refuse') {
      await ctx.reply('⛔ This bot is private to the Vibespot team.');
    }
    // 'ignore' — an unserved group or a channel: not a word.
  });

  // ---- 2. History capture (group context; inert until groups are enabled) --
  //         After the gate, so nothing is stored for a chat we do not serve.
  bot.use(async (ctx, next) => {
    const text = ctx.message?.text;
    if (config.groupEnabled && isGroup(ctx) && text && ctx.chat) {
      const name = ctx.from?.first_name ?? ctx.from?.username ?? 'someone';
      await store.pushHistory(ctx.chat.id, `${name}: ${text.slice(0, 200)}`);
    }
    // Never short-circuit: this is an observer, not a gate.
    return next();
  });

  // ---- 3. Commands ---------------------------------------------------------
  bot.command(['start', 'help'], async (ctx) => {
    const username = ctx.me?.username ?? 'the bot';
    const body = ctx.message?.text?.startsWith('/start')
      ? buildIntro(username, config.repos)
      : buildHelp(username);
    await ctx.reply(body, HTML_OPTS);
  });

  bot.command('deployments', async (ctx) => {
    const loading = await ctx.reply('⏳ Fetching latest deployments…');
    try {
      const report = await buildDeploymentsReport(vercel, config.projects);
      await ctx.api.editMessageText(ctx.chat.id, loading.message_id, report, HTML_OPTS);
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

  bot.command('model', async (ctx) => {
    const settings = await store.getSettings(ctx.chat.id, {
      model: config.defaultModel,
      effort: DEFAULT_EFFORT,
    });
    const view = buildModelKeyboard(settings.model);
    await ctx.reply(view.text, { ...HTML_OPTS, reply_markup: view.keyboard });
  });

  bot.command('effort', async (ctx) => {
    const settings = await store.getSettings(ctx.chat.id, {
      model: config.defaultModel,
      effort: DEFAULT_EFFORT,
    });
    const view = buildEffortKeyboard(settings.effort);
    await ctx.reply(view.text, { ...HTML_OPTS, reply_markup: view.keyboard });
  });

  bot.command('usage', async (ctx) => {
    const [usage, settings] = await Promise.all([
      store.getUsage(ctx.chat.id),
      store.getSettings(ctx.chat.id, { model: config.defaultModel, effort: DEFAULT_EFFORT }),
    ]);
    await ctx.reply(buildUsageReport(usage, settings, config.dailyCallLimit), HTML_OPTS);
  });

  bot.command('remember', async (ctx) => {
    const fact = (ctx.match ?? '').toString().trim();
    if (!fact) {
      await ctx.reply('Give me something to remember: <code>/remember …</code>', HTML_OPTS);
      return;
    }
    await store.addMemory(ctx.chat.id, fact);
    const all = await store.listMemory(ctx.chat.id);
    await ctx.reply(buildRememberAck(fact, all.length), HTML_OPTS);
  });

  bot.command('memory', async (ctx) => {
    await ctx.reply(buildMemoryList(await store.listMemory(ctx.chat.id)), HTML_OPTS);
  });

  bot.command('forget', async (ctx) => {
    if (!(await requireMaintainer(ctx))) return;
    const argument = (ctx.match ?? '').toString().trim();
    if (argument.toLowerCase() === 'all') {
      await store.clearMemory(ctx.chat.id);
      await ctx.reply(buildForgetResult(true, argument), HTML_OPTS);
      return;
    }
    const position = Number(argument);
    if (!Number.isInteger(position)) {
      await ctx.reply('Use <code>/forget 2</code> or <code>/forget all</code>.', HTML_OPTS);
      return;
    }
    const removed = await store.forgetMemory(ctx.chat.id, position);
    await ctx.reply(buildForgetResult(removed, argument), HTML_OPTS);
  });

  bot.command('ask', async (ctx) => {
    const question = (ctx.match ?? '').toString().trim();
    if (!question) {
      await ctx.reply('Ask me something: <code>/ask where do map pins collapse?</code>', HTML_OPTS);
      return;
    }
    await answer(ctx, question);
  });

  // ---- 4. Settings callbacks ----------------------------------------------
  bot.on('callback_query:data', async (ctx) => {
    const parsed = parseSettingsCallback(ctx.callbackQuery.data);
    if (!parsed || !ctx.chat) {
      await ctx.answerCallbackQuery();
      return;
    }
    let toast: string;
    if (parsed.kind === 'model') {
      const model = modelByKey(parsed.key);
      if (!model) {
        await ctx.answerCallbackQuery({ text: 'Unknown model.' });
        return;
      }
      await store.setSetting(ctx.chat.id, 'model', model.id);
      toast = `Model: ${model.label}`;
    } else {
      await store.setSetting(ctx.chat.id, 'effort', parsed.key as Effort);
      toast = `Effort: ${parsed.key}`;
    }
    logger.info(
      `Setting changed chat=${ctx.chat.id} by=${ctx.from?.id} ${parsed.kind}=${parsed.key}`,
    );

    const settings = await store.getSettings(ctx.chat.id, {
      model: config.defaultModel,
      effort: DEFAULT_EFFORT,
    });
    const view =
      parsed.kind === 'model'
        ? buildModelKeyboard(settings.model)
        : buildEffortKeyboard(settings.effort);
    try {
      await ctx.editMessageText(view.text, { ...HTML_OPTS, reply_markup: view.keyboard });
    } catch (err) {
      logger.warn('Could not refresh the settings keyboard', err);
    }
    await ctx.answerCallbackQuery({ text: toast });
  });

  // ---- 5. Introduce itself when added to a group --------------------------
  bot.on('my_chat_member', async (ctx) => {
    if (!config.groupEnabled) return;
    const status = ctx.myChatMember.new_chat_member.status;
    const wasOut = ['left', 'kicked'].includes(ctx.myChatMember.old_chat_member.status);
    if (!wasOut || !['member', 'administrator'].includes(status)) return;
    if (!ctx.chat) return;
    // Only introduce once a day per chat, so a remove/re-add is not spammy.
    if (!(await store.claimOnce(`viby:intro:${ctx.chat.id}`, 86_400))) return;
    await ctx.reply(buildIntro(ctx.me?.username ?? 'the bot', config.repos), HTML_OPTS);
  });

  // ---- 6. AI fallback — registered LAST so commands win --------------------
  bot.on('message:text', async (ctx) => {
    const trigger = detectTrigger({
      chatType: ctx.chat.type,
      chatId: ctx.chat.id,
      text: ctx.message.text,
      botUsername: ctx.me?.username ?? '',
      botId: ctx.me?.id ?? 0,
      replyToUserId: ctx.message.reply_to_message?.from?.id,
      groupEnabled: config.groupEnabled,
      allowedChatIds: config.allowedChatIds,
    });
    if (!trigger) return;

    const replyText = ctx.message.reply_to_message?.text;
    await answer(ctx, trigger.question, replyText
      ? {
          author: ctx.message.reply_to_message?.from?.first_name ?? 'someone',
          text: replyText,
        }
      : undefined);
  });

  /** Shared answering flow: lock, placeholder, agent run, edit in the result. */
  async function answer(
    ctx: Context,
    question: string,
    repliedTo?: { author: string; text: string },
  ): Promise<void> {
    if (!ctx.chat) return;
    const chatId = ctx.chat.id;

    if (!(await store.acquireChatLock(chatId))) {
      await ctx.reply('⏳ Still working on the previous question — one at a time.');
      return;
    }

    // A "remember this" never needs a placeholder or a model call.
    if (parseRememberIntent(question)) {
      try {
        const result = await buildAnswer(deps, {
          chatId,
          question,
          chatKind: isGroup(ctx) ? 'group' : 'dm',
        });
        await sendHtml(ctx, result.html);
      } finally {
        await store.releaseChatLock(chatId);
      }
      return;
    }

    const loading = await ctx.reply('🤔 Thinking…');
    try {
      await ctx.api.sendChatAction(chatId, 'typing').catch(() => undefined);
      const result = await buildAnswer(deps, {
        chatId,
        question,
        chatKind: isGroup(ctx) ? 'group' : 'dm',
        repliedTo,
      });
      await sendHtml(ctx, result.html, loading.message_id);
    } catch (err) {
      logger.error('Viby failed to answer', err);
      try {
        await ctx.api.editMessageText(chatId, loading.message_id, friendlyAiError(err), HTML_OPTS);
      } catch (editErr) {
        logger.error('Failed to edit the Viby placeholder', editErr);
      }
    } finally {
      await store.releaseChatLock(chatId);
    }
  }

  // ---- 7. Centralised error handling --------------------------------------
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
