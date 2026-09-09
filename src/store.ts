import { logger } from './logger';

/**
 * Upstash Redis (REST) — the bot's only persistent state.
 *
 * Vercel functions are stateless, so per-chat settings, Viby's memory, the
 * rolling chat history, usage counters, webhook de-duplication and the GitHub
 * tree cache all live here.
 *
 * Every method degrades gracefully: if Redis is unreachable the bot keeps
 * answering with defaults rather than failing the whole update.
 */

const REQUEST_TIMEOUT_MS = 8_000;

/** How much Viby remembers per chat. */
const MEMORY_MAX_ITEMS = 40;
export const MEMORY_MAX_LENGTH = 200;

/** Rolling chat context. */
const HISTORY_MAX_ITEMS = 30;
const HISTORY_TTL_SECONDS = 24 * 60 * 60;

export type Effort = 'low' | 'medium' | 'high';

export interface ChatSettings {
  model: string;
  effort: Effort;
}

export interface UsageTotals {
  calls: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export type StoreErrorKind = 'unauthorized' | 'network' | 'http';

export class StoreError extends Error {
  constructor(
    readonly kind: StoreErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'StoreError';
  }
}

function dayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10).replace(/-/g, '');
}

/** Upstash returns hashes as a flat [field, value, field, value] array. */
function toRecord(flat: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(flat)) return out;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    out[String(flat[i])] = String(flat[i + 1]);
  }
  return out;
}

export class Store {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  // ---- transport ----------------------------------------------------------

  private async cmd<T>(args: (string | number)[]): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(this.url.replace(/\/$/, ''), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(args),
        signal: controller.signal,
      });
    } catch (err) {
      throw new StoreError(
        'network',
        err instanceof Error && err.name === 'AbortError'
          ? 'Redis request timed out'
          : 'Could not reach Redis',
      );
    } finally {
      clearTimeout(timeout);
    }

    if (res.status === 401 || res.status === 403) {
      throw new StoreError('unauthorized', 'Redis credentials rejected', res.status);
    }
    if (!res.ok) {
      throw new StoreError('http', `Redis error (HTTP ${res.status})`, res.status);
    }
    const body = (await res.json()) as { result?: T };
    return body.result as T;
  }

  /** Run a command, logging and swallowing failures. Used for non-critical writes. */
  private async safe<T>(args: (string | number)[], fallback: T): Promise<T> {
    try {
      return await this.cmd<T>(args);
    } catch (err) {
      logger.warn('Redis command failed; continuing without it', err);
      return fallback;
    }
  }

  // ---- settings -----------------------------------------------------------

  async getSettings(chatId: number, defaults: ChatSettings): Promise<ChatSettings> {
    const flat = await this.safe<unknown>(['HGETALL', `viby:settings:${chatId}`], null);
    const record = toRecord(flat);
    const effort = record.effort;
    return {
      model: record.model || defaults.model,
      effort: effort === 'low' || effort === 'medium' || effort === 'high' ? effort : defaults.effort,
    };
  }

  async setSetting(chatId: number, field: keyof ChatSettings, value: string): Promise<void> {
    await this.safe(['HSET', `viby:settings:${chatId}`, field, value], null);
  }

  // ---- memory -------------------------------------------------------------

  async addMemory(chatId: number, text: string): Promise<void> {
    const key = `viby:memory:${chatId}`;
    await this.safe(['RPUSH', key, text.slice(0, MEMORY_MAX_LENGTH)], null);
    await this.safe(['LTRIM', key, -MEMORY_MAX_ITEMS, -1], null);
  }

  async listMemory(chatId: number): Promise<string[]> {
    const items = await this.safe<unknown>(['LRANGE', `viby:memory:${chatId}`, 0, -1], []);
    return Array.isArray(items) ? items.map(String) : [];
  }

  /** Remove one fact by its 1-based position as shown in /memory. */
  async forgetMemory(chatId: number, position: number): Promise<boolean> {
    const key = `viby:memory:${chatId}`;
    const items = await this.listMemory(chatId);
    if (position < 1 || position > items.length) return false;
    // LSET to a tombstone, then LREM it — the standard "delete by index" dance.
    const tombstone = `__viby_deleted_${Date.now()}__`;
    await this.safe(['LSET', key, position - 1, tombstone], null);
    await this.safe(['LREM', key, 1, tombstone], null);
    return true;
  }

  async clearMemory(chatId: number): Promise<void> {
    await this.safe(['DEL', `viby:memory:${chatId}`], null);
  }

  // ---- rolling chat history ----------------------------------------------

  async pushHistory(chatId: number, line: string): Promise<void> {
    const key = `viby:history:${chatId}`;
    await this.safe(['RPUSH', key, line], null);
    await this.safe(['LTRIM', key, -HISTORY_MAX_ITEMS, -1], null);
    await this.safe(['EXPIRE', key, HISTORY_TTL_SECONDS], null);
  }

  async getHistory(chatId: number, limit: number): Promise<string[]> {
    const items = await this.safe<unknown>(['LRANGE', `viby:history:${chatId}`, -limit, -1], []);
    return Array.isArray(items) ? items.map(String) : [];
  }

  // ---- usage + daily cap --------------------------------------------------

  async recordUsage(
    chatId: number,
    usage: { tokensIn: number; tokensOut: number; costUsd: number },
  ): Promise<void> {
    const key = `viby:usage:${chatId}:${dayKey()}`;
    await this.safe(['HINCRBY', key, 'tokensIn', Math.round(usage.tokensIn)], null);
    await this.safe(['HINCRBY', key, 'tokensOut', Math.round(usage.tokensOut)], null);
    await this.safe(['HINCRBYFLOAT', key, 'costUsd', usage.costUsd.toFixed(6)], null);
    await this.safe(['EXPIRE', key, 8 * 24 * 60 * 60], null);
  }

  async getUsage(chatId: number): Promise<UsageTotals> {
    const flat = await this.safe<unknown>(['HGETALL', `viby:usage:${chatId}:${dayKey()}`], null);
    const record = toRecord(flat);
    return {
      calls: Number(record.calls || 0),
      tokensIn: Number(record.tokensIn || 0),
      tokensOut: Number(record.tokensOut || 0),
      costUsd: Number(record.costUsd || 0),
    };
  }

  /** Increment today's call counter and return the new value (0 if Redis is down). */
  async bumpCallCount(chatId: number): Promise<number> {
    const key = `viby:usage:${chatId}:${dayKey()}`;
    const count = await this.safe<number>(['HINCRBY', key, 'calls', 1], 0);
    await this.safe(['EXPIRE', key, 8 * 24 * 60 * 60], null);
    return Number(count) || 0;
  }

  // ---- webhook de-duplication --------------------------------------------

  /**
   * True when this update has not been handled yet.
   *
   * Deliberately THROWS when Redis is unreachable instead of guessing: the
   * webhook acks before doing the work, so the right failure mode depends on
   * what the update would cost. The caller decides (see `api/bot.ts`).
   */
  async claimUpdate(updateId: number): Promise<boolean> {
    const result = await this.cmd<string | null>([
      'SET',
      `viby:seen:${updateId}`,
      '1',
      'NX',
      'EX',
      900,
    ]);
    return result === 'OK';
  }

  /**
   * Generic "first one wins" claim. Used for one-shot actions such as the
   * group introduction, so a remove/re-add does not repeat it.
   */
  async claimOnce(key: string, ttlSeconds: number): Promise<boolean> {
    try {
      const result = await this.cmd<string | null>(['SET', key, '1', 'NX', 'EX', ttlSeconds]);
      return result === 'OK';
    } catch (err) {
      logger.warn('Redis claim failed; treating as first time', err);
      return true;
    }
  }

  // ---- per-chat lock ------------------------------------------------------

  /**
   * True when no answer was already in flight for this chat. Stops one chat
   * from running several paid agent loops at once.
   */
  async acquireChatLock(chatId: number): Promise<boolean> {
    try {
      const result = await this.cmd<string | null>([
        'SET',
        `viby:lock:${chatId}`,
        '1',
        'NX',
        'EX',
        120,
      ]);
      return result === 'OK';
    } catch (err) {
      logger.warn('Redis lock failed; answering anyway', err);
      return true;
    }
  }

  async releaseChatLock(chatId: number): Promise<void> {
    await this.safe(['DEL', `viby:lock:${chatId}`], null);
  }

  // ---- generic cache (GitHub trees) --------------------------------------

  async getCached(key: string): Promise<string | undefined> {
    const value = await this.safe<string | null>(['GET', key], null);
    return typeof value === 'string' ? value : undefined;
  }

  async setCached(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.safe(['SET', key, value, 'EX', ttlSeconds], null);
  }
}
