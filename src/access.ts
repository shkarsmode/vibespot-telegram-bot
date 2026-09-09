/**
 * Who may use the bot.
 *
 * Two independent lists, because they answer different questions:
 *  - ALLOWED_USER_IDS       — who may talk to Viby in a DM, and who may retune
 *                             it anywhere (the maintainers).
 *  - VIBY_ALLOWED_CHAT_IDS  — which group chats it serves at all. Everyone in
 *                             such a group may ask; only maintainers may change
 *                             the model, the effort or the memory.
 *
 * Both lists empty = fully open. That is the local-development default, and the
 * only state in which an unlisted group is served — so locking down the user
 * list implicitly locks down groups too, which is the safe way round.
 */

export interface AccessLists {
  allowedUserIds: number[];
  allowedChatIds: number[];
  /**
   * The phase gate (VIBY_GROUP_ENABLED). While false the bot is silent in every
   * group, listed or not — commands included. It lives here rather than only in
   * `detectTrigger` because a command like /ask spends money without ever
   * reaching a trigger, so gating triggers alone left the flag half-honest.
   */
  groupEnabled: boolean;
}

export interface ChatIdentity {
  /** Telegram chat type: private | group | supergroup | channel. */
  chatType: string;
  chatId: number;
  userId?: number;
}

/**
 * `allow`  — go ahead.
 * `refuse` — a person in a DM: tell them why nothing happened.
 * `ignore` — an unserved group or channel: stay completely silent, so the bot
 *            never spams a chat it was added to by mistake.
 */
export type AccessDecision = 'allow' | 'refuse' | 'ignore';

export function isGroupChat(chatType: string): boolean {
  return chatType === 'group' || chatType === 'supergroup';
}

/** Maintainers may change settings and memory. Empty list = everyone. */
export function isMaintainer(identity: ChatIdentity, lists: AccessLists): boolean {
  if (lists.allowedUserIds.length === 0) return true;
  return identity.userId !== undefined && lists.allowedUserIds.includes(identity.userId);
}

export function decideAccess(identity: ChatIdentity, lists: AccessLists): AccessDecision {
  // Channels are never in scope — the bot has nobody to answer there.
  if (identity.chatType === 'channel') return 'ignore';

  if (isGroupChat(identity.chatType)) {
    if (!lists.groupEnabled) return 'ignore';
    if (lists.allowedChatIds.includes(identity.chatId)) return 'allow';
    // Unlisted group: open only while nothing at all is locked down.
    const fullyOpen = lists.allowedChatIds.length === 0 && lists.allowedUserIds.length === 0;
    return fullyOpen ? 'allow' : 'ignore';
  }

  return isMaintainer(identity, lists) ? 'allow' : 'refuse';
}
