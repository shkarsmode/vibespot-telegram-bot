/**
 * "Is this message for Viby?"
 *
 * This is the phase gate: while `groupEnabled` is false, every group message
 * returns null here, so the bot is structurally silent in groups no matter what
 * else is wired up. Turning groups on is a config flip, not a refactor.
 */

export type TriggerKind = 'dm' | 'name' | 'mention' | 'reply';

export interface TriggerMatch {
  kind: TriggerKind;
  /** The question with the trigger prefix removed. */
  question: string;
}

export interface TriggerInput {
  chatType: string;
  chatId: number;
  text: string;
  botUsername: string;
  botId: number;
  replyToUserId?: number;
  groupEnabled: boolean;
  /** Empty = any chat that already passed the user allowlist. */
  allowedChatIds: number[];
}

/** Deliberately not matching a bare "вайб" — it is too common in normal chat. */
const NAME_PREFIX = /^\s*(?:viby|вайби|вайбі)\b[\s,:.!?—-]*/i;

export function detectTrigger(input: TriggerInput): TriggerMatch | null {
  const text = input.text?.trim();
  if (!text) return null;

  // Channels are never in scope.
  if (input.chatType === 'channel') return null;

  if (input.chatType === 'private') {
    // Slash commands have their own handlers; an unknown /foo must not become
    // an expensive AI prompt.
    if (text.startsWith('/')) return null;
    return { kind: 'dm', question: text };
  }

  // ---- group / supergroup: the gate ---------------------------------------
  if (!input.groupEnabled) return null;
  if (input.allowedChatIds.length > 0 && !input.allowedChatIds.includes(input.chatId)) return null;

  const named = text.match(NAME_PREFIX);
  if (named) {
    const question = text.slice(named[0].length).trim();
    if (question) return { kind: 'name', question };
  }

  const mention = `@${input.botUsername}`;
  if (input.botUsername && text.toLowerCase().includes(mention.toLowerCase())) {
    const question = text.replace(new RegExp(mention, 'ig'), '').trim();
    if (question) return { kind: 'mention', question };
  }

  if (input.replyToUserId !== undefined && input.replyToUserId === input.botId) {
    if (!text.startsWith('/')) return { kind: 'reply', question: text };
  }

  return null;
}
