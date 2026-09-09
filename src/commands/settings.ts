import { InlineKeyboard } from 'grammy';
import { escapeHtml } from '../format';
import type { ChatSettings, Effort, UsageTotals } from '../store';
import { EFFORTS, modelById, modelLabel, MODELS } from '../ai/models';

/**
 * /model and /effort pickers.
 *
 * `callback_data` stays short (`vm:haiku`, `ve:low`) — Telegram caps it at 64
 * bytes, and keeping the key self-describing means no Redis lookup is needed to
 * interpret a tap.
 */

const MODEL_PREFIX = 'vm:';
const EFFORT_PREFIX = 've:';

export interface KeyboardMessage {
  text: string;
  keyboard: InlineKeyboard;
}

function price(input: number, output: number): string {
  return `$${input}/$${output} per Mtok`;
}

export function buildModelKeyboard(currentModelId: string): KeyboardMessage {
  const keyboard = new InlineKeyboard();
  for (const model of MODELS) {
    const active = model.id === currentModelId;
    keyboard
      .text(`${active ? '✅ ' : ''}${model.label}`, `${MODEL_PREFIX}${model.key}`)
      .row();
  }

  const lines = [
    '<b>Model</b>',
    '',
    ...MODELS.map((m) => {
      const mark = m.id === currentModelId ? '✅' : '·';
      return `${mark} <b>${escapeHtml(m.label)}</b> — ${escapeHtml(price(m.inputUsdPerMTok, m.outputUsdPerMTok))}`;
    }),
    '',
    '<i>Cheaper models answer faster; the expensive ones dig deeper. Haiku is the default for a reason.</i>',
  ];
  return { text: lines.join('\n'), keyboard };
}

export function buildEffortKeyboard(current: Effort): KeyboardMessage {
  const keyboard = new InlineKeyboard();
  for (const effort of ['low', 'medium', 'high'] as Effort[]) {
    keyboard.text(`${effort === current ? '✅ ' : ''}${effort}`, `${EFFORT_PREFIX}${effort}`);
  }

  const lines = [
    '<b>Effort</b>',
    '',
    ...(['low', 'medium', 'high'] as Effort[]).map((key) => {
      const profile = EFFORTS[key];
      const mark = key === current ? '✅' : '·';
      return `${mark} <b>${escapeHtml(profile.label)}</b> — up to ${profile.maxIterations} tool rounds`;
    }),
    '',
    '<i>Effort controls both how hard the model thinks and how many files it may read.</i>',
  ];
  return { text: lines.join('\n'), keyboard };
}

export type SettingsCallback =
  | { kind: 'model'; key: string }
  | { kind: 'effort'; key: Effort };

export function parseSettingsCallback(data: string): SettingsCallback | null {
  if (data.startsWith(MODEL_PREFIX)) {
    return { kind: 'model', key: data.slice(MODEL_PREFIX.length) };
  }
  if (data.startsWith(EFFORT_PREFIX)) {
    const key = data.slice(EFFORT_PREFIX.length);
    if (key === 'low' || key === 'medium' || key === 'high') return { kind: 'effort', key };
  }
  return null;
}

export function buildUsageReport(
  usage: UsageTotals,
  settings: ChatSettings,
  dailyLimit: number,
): string {
  const tokens = usage.tokensIn + usage.tokensOut;
  return [
    '📊 <b>Usage today</b> <i>(UTC day)</i>',
    '',
    `Answers: <b>${usage.calls}</b> / ${dailyLimit}`,
    `Tokens: <b>${(tokens / 1000).toFixed(1)}k</b> (${usage.tokensIn} in / ${usage.tokensOut} out)`,
    `Cost: <b>$${usage.costUsd.toFixed(4)}</b>`,
    '',
    `Model: <b>${escapeHtml(modelLabel(settings.model))}</b>`,
    `Effort: <b>${escapeHtml(settings.effort)}</b>`,
    '',
    '<i>Change them with /model and /effort.</i>',
  ].join('\n');
}

/** Human label for the model currently selected in a chat. */
export function currentModelLabel(modelId: string): string {
  return modelById(modelId)?.label ?? modelId;
}
