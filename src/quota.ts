import { DurableObject } from 'cloudflare:workers';
import type { Env, RateLimits } from './types';

/**
 * Per-device daily notification counter.
 *
 * One Durable Object per SHA-256(token). The counter always runs; whether it
 * ever refuses depends on DAILY_LIMIT ("0"/unset = monitor mode). The limit is
 * read at request time, so changing the env var flips behavior immediately for
 * every device with no stored-state migration.
 *
 * Deliveries are counted in two steps: `check()` (read-only) decides whether a
 * send may proceed, and `record()` runs only after FCM accepts it. That keeps
 * failed sends from burning a device's daily allowance, and keeps a junk token
 * from leaving any persistent state behind — nothing is written until FCM has
 * confirmed the token is real. The trade-off is that concurrent sends can
 * overshoot the cap slightly (each checks before either records); for a
 * fair-use limit that is preferable to charging devices for failures.
 *
 * Completed days are flushed to Analytics Engine as {day, platform, hashed id
 * prefix, count} — the distribution used to choose the enforced cap later. No
 * tokens, payloads, or IPs are ever stored.
 */

interface QuotaState {
  day: string | undefined;
  count: number;
  platform: string | undefined;
  /**
   * SHA-256(token) prefix, persisted by record() so an alarm-driven flush has it
   * too. It cannot be read off ctx.id: the name passed to idFromName is not
   * propagated into the object, and id.toString() is a different, derived value.
   */
  idPrefix: string | undefined;
}

export interface QuotaDecision extends RateLimits {
  allowed: boolean;
}

/** Length of the hashed-token prefix reported to Analytics Engine. */
export const USAGE_ID_PREFIX_LENGTH = 16;
/** Spread post-midnight flush alarms over this window to avoid a thundering herd. */
const ALARM_JITTER_WINDOW_MS = 10 * 60 * 1000;

export function parseDailyLimit(raw: string | undefined): number | null {
  if (raw === undefined) {
    return null;
  }
  const limit = Number.parseInt(raw, 10);
  return Number.isFinite(limit) && limit > 0 ? limit : null;
}

export function utcDayKey(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

export function nextUtcMidnightMs(timestampMs: number): number {
  const date = new Date(timestampMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

export function buildDecision(
  used: number,
  limit: number | null,
  allowed: boolean,
  nowMs: number,
): QuotaDecision {
  return {
    allowed,
    enforced: limit !== null,
    maximum: limit,
    used,
    remaining: limit === null ? null : Math.max(0, limit - used),
    resetsAt: new Date(nextUtcMidnightMs(nowMs)).toISOString(),
  };
}

export class QuotaCounter extends DurableObject<Env> {
  /**
   * Read-only pre-send check. Writes nothing, so an unknown or junk token
   * leaves no durable state behind when the send that follows fails.
   */
  async check(): Promise<QuotaDecision> {
    const now = Date.now();
    const state = await this.loadState();
    const used = state.day === utcDayKey(now) ? state.count : 0;
    const limit = parseDailyLimit(this.env.DAILY_LIMIT);
    return buildDecision(used, limit, limit === null || used < limit, now);
  }

  /** Count one accepted delivery. Called only after FCM accepts the message. */
  async record(platform: string, idPrefix: string): Promise<QuotaDecision> {
    const now = Date.now();
    const today = utcDayKey(now);
    const state = await this.loadState();

    let completedDay: QuotaState | null = null;
    if (state.day !== today) {
      // Capture the completed day, but persist the new day's state BEFORE
      // flushing it. writeDataPoint is fire-and-forget and not transactional
      // with storage; flushing first and then failing the put would leave the
      // old day on record and let the next request (or an alarm retry) flush it
      // a second time, duplicating the row in the usage dataset.
      completedDay = { ...state };
      state.day = today;
      state.count = 0;
    }

    state.count += 1;
    state.platform = platform;
    state.idPrefix = idPrefix;
    await this.ctx.storage.put({
      day: state.day,
      count: state.count,
      platform: state.platform,
      idPrefix: state.idPrefix,
    });
    if (completedDay) {
      await this.flushCompletedDay(completedDay);
    }
    await this.ensureFlushAlarm(now);
    return buildDecision(state.count, parseDailyLimit(this.env.DAILY_LIMIT), true, now);
  }

  /** Read the current day's state without counting anything. */
  async peek(): Promise<QuotaDecision> {
    return this.check();
  }

  /**
   * Post-midnight flush so a device that stops sending still reports its final
   * day. record() also flushes lazily on the first request of a new day, so a
   * missed alarm only delays the data point.
   */
  override async alarm(): Promise<void> {
    const now = Date.now();
    const state = await this.loadState();
    if (state.day !== undefined && state.day !== utcDayKey(now)) {
      const completedDay = { ...state };
      // Clear the completed-day marker BEFORE the fire-and-forget flush, so an
      // auto-retried alarm (workerd re-runs the handler on throw) cannot flush
      // the same day twice. `put` silently skips undefined values, so the key
      // must be deleted explicitly rather than set to undefined.
      await this.ctx.storage.delete('day');
      await this.ctx.storage.put({ count: 0, platform: state.platform ?? 'unknown' });
      await this.flushCompletedDay(completedDay);
      return;
    }
    // record() already rolled the day over before this alarm fired, so the day
    // now in storage is still in progress. Re-arm: without this the one-shot
    // alarm is consumed and a device whose last-ever send happened in that
    // window would never flush its final day.
    if (state.day !== undefined && state.count > 0) {
      await this.ctx.storage.setAlarm(nextUtcMidnightMs(now) + this.deterministicJitterMs());
    }
  }

  private async loadState(): Promise<QuotaState> {
    const entries = await this.ctx.storage.get(['day', 'count', 'platform', 'idPrefix']);
    return {
      day: entries.get('day') as string | undefined,
      count: (entries.get('count') as number | undefined) ?? 0,
      platform: entries.get('platform') as string | undefined,
      idPrefix: entries.get('idPrefix') as string | undefined,
    };
  }

  private async flushCompletedDay(state: QuotaState): Promise<void> {
    if (state.day === undefined || state.count === 0 || this.env.USAGE === undefined) {
      return;
    }
    // A device that last sent before idPrefix was persisted has none stored. The
    // derived id keeps the count in the dataset; only the correlation is lost.
    const idPrefix = state.idPrefix ?? this.ctx.id.toString().slice(0, USAGE_ID_PREFIX_LENGTH);
    try {
      this.env.USAGE.writeDataPoint({
        blobs: [state.day, state.platform ?? 'unknown', idPrefix],
        doubles: [state.count],
        indexes: [idPrefix],
      });
    } catch (error) {
      // Usage collection must never break delivery.
      console.error(`quota flush failed ${idPrefix}: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  private async ensureFlushAlarm(nowMs: number): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing !== null) {
      return;
    }
    await this.ctx.storage.setAlarm(nextUtcMidnightMs(nowMs) + this.deterministicJitterMs());
  }

  private deterministicJitterMs(): number {
    const id = this.ctx.id.toString();
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
      hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
    }
    return hash % ALARM_JITTER_WINDOW_MS;
  }
}
