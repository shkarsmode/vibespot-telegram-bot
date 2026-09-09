import { escapeHtml } from '../format';

/**
 * /whoami — the bootstrap escape hatch for the allowlist.
 *
 * Telegram never shows numeric ids in its UI, so there is no way to fill
 * ALLOWED_USER_IDS or VIBY_ALLOWED_CHAT_IDS without asking the bot. It is the
 * one command that runs *before* the access gate: it reveals only the caller's
 * own ids back to the caller, which gives away nothing about Vibespot, and
 * without it a locked-down bot could never be handed a new group.
 */

export interface WhoAmIInput {
  userId?: number;
  chatId: number;
  chatType: string;
  displayName: string;
  isMaintainer: boolean;
  chatAllowed: boolean;
}

export function buildWhoAmI(input: WhoAmIInput): string {
  const isGroup = input.chatType === 'group' || input.chatType === 'supergroup';
  const lines = [
    '<b>Your Telegram ids</b>',
    '',
    `• You — <code>${input.userId ?? 'unknown'}</code> (${escapeHtml(input.displayName)})`,
    `• This chat — <code>${input.chatId}</code> (${escapeHtml(input.chatType)})`,
    '',
    input.chatAllowed
      ? '✅ This chat is on the allowlist.'
      : '⛔ This chat is <b>not</b> on the allowlist — I stay quiet here.',
  ];

  if (input.isMaintainer) {
    lines.push(
      '',
      '<b>To grant access</b>',
      isGroup
        ? `Add <code>${input.chatId}</code> to <code>VIBY_ALLOWED_CHAT_IDS</code>.`
        : `Add <code>${input.userId ?? '…'}</code> to <code>ALLOWED_USER_IDS</code>.`,
      '<i>Both are comma-separated. Group ids are negative — keep the minus sign.</i>',
    );
  }

  return lines.join('\n');
}
