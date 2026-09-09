import type { Effort } from '../store';

/**
 * Model catalog and effort profiles.
 *
 * Effort is a two-sided lever: it sets the provider's reasoning budget AND our
 * own retrieval budget (how many tool rounds, how many lines per read, how much
 * tool output in total). The second half is where most of the saving comes from.
 */

export interface ModelOption {
  /** Short id used in callback_data — Telegram caps that at 64 bytes. */
  key: string;
  /** OpenRouter model id. */
  id: string;
  label: string;
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  supportsReasoning: boolean;
}

export const MODELS: ModelOption[] = [
  {
    key: 'haiku',
    id: 'anthropic/claude-haiku-4.5',
    label: 'Haiku 4.5 · fast, strong at code',
    inputUsdPerMTok: 1,
    outputUsdPerMTok: 5,
    supportsReasoning: true,
  },
  {
    key: 'sonnet',
    id: 'anthropic/claude-sonnet-5',
    label: 'Sonnet 5 · balanced',
    inputUsdPerMTok: 2,
    outputUsdPerMTok: 10,
    supportsReasoning: true,
  },
  {
    key: 'opus',
    id: 'anthropic/claude-opus-5',
    label: 'Opus 5 · deepest',
    inputUsdPerMTok: 5,
    outputUsdPerMTok: 25,
    supportsReasoning: true,
  },
  {
    key: 'deepseek',
    id: 'deepseek/deepseek-v4-flash',
    label: 'DeepSeek V4 · budget',
    inputUsdPerMTok: 0.089,
    outputUsdPerMTok: 0.177,
    supportsReasoning: true,
  },
];

export interface EffortProfile {
  key: Effort;
  label: string;
  /** Undefined = spend no reasoning tokens at all. */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** Hard cap on tool rounds; the loop stops and answers with what it has. */
  maxIterations: number;
  defaultReadLines: number;
  maxReadLines: number;
  /** Running total of tool-result characters allowed for one question. */
  toolCharBudget: number;
  maxAnswerTokens: number;
}

export const EFFORTS: Record<Effort, EffortProfile> = {
  low: {
    key: 'low',
    label: 'Low · quick answers, cheapest',
    maxIterations: 2,
    defaultReadLines: 120,
    maxReadLines: 200,
    toolCharBudget: 24_000,
    maxAnswerTokens: 800,
  },
  medium: {
    key: 'medium',
    label: 'Medium · default',
    reasoningEffort: 'low',
    // 4 rounds keeps a typical answer near $0.02-0.03. Every extra round
    // re-sends the whole conversation, so rounds cost far more than they look.
    maxIterations: 4,
    defaultReadLines: 180,
    maxReadLines: 300,
    toolCharBudget: 40_000,
    maxAnswerTokens: 1_300,
  },
  high: {
    key: 'high',
    label: 'High · digs through more files',
    reasoningEffort: 'high',
    maxIterations: 9,
    defaultReadLines: 300,
    maxReadLines: 600,
    toolCharBudget: 120_000,
    maxAnswerTokens: 2_000,
  },
};

export const DEFAULT_EFFORT: Effort = 'medium';

export function modelByKey(key: string): ModelOption | undefined {
  return MODELS.find((m) => m.key === key);
}

export function modelById(id: string): ModelOption | undefined {
  return MODELS.find((m) => m.id === id);
}

/** Label for a model id, falling back to the raw id for anything custom. */
export function modelLabel(id: string): string {
  return modelById(id)?.label ?? id;
}
