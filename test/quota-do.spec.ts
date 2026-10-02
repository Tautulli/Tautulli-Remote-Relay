import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { nextUtcMidnightMs, utcDayKey } from '../src/quota';
import type { DeviceQuota } from '../src/quota';

/**
 * Direct Durable Object tests for the stateful parts the HTTP tests cannot
 * reach: day rollover, the Analytics Engine flush, alarm re-arming, and the
 * idle purge.
 */

function stubFor(name: string): DurableObjectStub<DeviceQuota> {
  return env.QUOTA.get(env.QUOTA.idFromName(name)) as DurableObjectStub<DeviceQuota>;
}

/** Stands in for SHA-256(token).slice(0, USAGE_ID_PREFIX_LENGTH). */
const TEST_ID_PREFIX = '1514eb454a58f37f';
/** The retention the README promises; deliberately not read from the source. */
const IDLE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const FLUSH_JITTER_WINDOW_MS = 10 * 60 * 1000;

/** Everything the object holds: its stored keys and any pending alarm. */
function storedState(stub: DurableObjectStub<DeviceQuota>) {
  return runInDurableObject(stub, async (_instance, state) => ({
    entries: Object.fromEntries(await state.storage.list()),
    alarm: await state.storage.getAlarm(),
  }));
}

function expectMidnightFlush(alarm: number | null): void {
  const midnight = nextUtcMidnightMs(Date.now());
  expect(alarm).toBeGreaterThanOrEqual(midnight);
  expect(alarm).toBeLessThan(midnight + FLUSH_JITTER_WINDOW_MS);
}

/**
 * Takes a device into its idle window the way production does: record()
 * writes what a real device has, the day is aged, and the midnight alarm
 * flushes it, leaving only the idle purge pending.
 */
async function flushToIdle(stub: DurableObjectStub<DeviceQuota>): Promise<void> {
  await stub.record('android', TEST_ID_PREFIX);
  await runInDurableObject(stub, (_instance, state) => state.storage.put('day', '2020-01-01'));
  expect(await runDurableObjectAlarm(stub)).toBe(true);
}

describe('DeviceQuota storage lifecycle', () => {
  it('check() writes nothing, so an unknown token leaves no durable state', async () => {
    const stub = stubFor('probe-check-only');
    const decision = await stub.check();
    expect(decision.allowed).toBe(true);
    expect(decision.used).toBe(0);

    const stored = await runInDurableObject(stub, async (_instance, state) => {
      const entries = await state.storage.list();
      return { size: entries.size, alarm: await state.storage.getAlarm() };
    });
    expect(stored.size).toBe(0);
    expect(stored.alarm).toBeNull();
  });

  it('record() persists the count and arms a flush alarm', async () => {
    const stub = stubFor('probe-record');
    await stub.record('android', TEST_ID_PREFIX);

    const stored = await runInDurableObject(stub, async (_instance, state) => ({
      day: await state.storage.get('day'),
      count: await state.storage.get('count'),
      alarm: await state.storage.getAlarm(),
    }));
    expect(stored.count).toBe(1);
    expect(stored.day).toBe(new Date().toISOString().slice(0, 10));
    expect(stored.alarm).not.toBeNull();
  });

  it('rolls a prior day over on the next record and starts the new day at 1', async () => {
    const stub = stubFor('probe-rollover');
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put({ day: '2020-01-01', count: 42, platform: 'android' });
    });

    const decision = await stub.record('android', TEST_ID_PREFIX);
    expect(decision.used).toBe(1);

    const stored = await runInDurableObject(stub, async (_instance, state) => ({
      day: await state.storage.get('day'),
      count: await state.storage.get('count'),
    }));
    expect(stored.day).toBe(new Date().toISOString().slice(0, 10));
    expect(stored.count).toBe(1);
  });

  it('clears only the day key and arms the idle purge when the alarm flushes a completed day', async () => {
    const stub = stubFor('probe-alarm-flush');
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put({ day: '2020-01-01', count: 7, platform: 'android', idPrefix: TEST_ID_PREFIX });
      await state.storage.setAlarm(Date.now() + 1000);
    });

    const before = Date.now();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const after = Date.now();

    const stored = await storedState(stub);
    // `put({day: undefined})` would silently skip the key; it must be deleted.
    // The rest stays through the idle window, so a returning device rewrites
    // only its count and day.
    expect(stored.entries).toEqual({ count: 7, platform: 'android', idPrefix: TEST_ID_PREFIX });
    // The idle purge, not another midnight flush.
    expect(stored.alarm).toBeGreaterThanOrEqual(before + IDLE_RETENTION_MS);
    expect(stored.alarm).toBeLessThanOrEqual(after + IDLE_RETENTION_MS);
    // The old count stays in storage, but without a day it no longer counts.
    expect((await stub.check()).used).toBe(0);
    expect((await stub.record('android', TEST_ID_PREFIX)).used).toBe(1);
  });

  it('flushes a completed day from the alarm and re-arms it 30 days out', async () => {
    const stub = stubFor('probe-alarm-usage');
    const rows: { blobs?: unknown[]; doubles?: unknown[] }[] = [];

    const before = Date.now();
    const alarm = await runInDurableObject(stub, async (instance, state) => {
      // env is protected on DurableObject, so the capture reaches past it.
      (instance as unknown as { env: { USAGE: unknown } }).env.USAGE = {
        writeDataPoint: (point: { blobs?: unknown[]; doubles?: unknown[] }) => rows.push(point),
      };
      await state.storage.put({ day: '2020-01-01', count: 7, platform: 'android', idPrefix: TEST_ID_PREFIX });
      await instance.alarm();
      return state.storage.getAlarm();
    });
    const after = Date.now();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.blobs).toEqual(['2020-01-01', 'android', TEST_ID_PREFIX]);
    expect(rows[0]?.doubles).toEqual([7]);
    expect(alarm).toBeGreaterThanOrEqual(before + IDLE_RETENTION_MS);
    expect(alarm).toBeLessThanOrEqual(after + IDLE_RETENTION_MS);
  });

  it('writes only the keys that changed, since each one is a billed row write', async () => {
    const stub = stubFor('probe-changed-keys');
    const writes = await runInDurableObject(stub, async (instance, state) => {
      const keys: string[][] = [];
      const put = state.storage.put.bind(state.storage);
      state.storage.put = ((entries: Record<string, unknown>) => {
        keys.push(Object.keys(entries).sort());
        return put(entries);
      }) as typeof state.storage.put;

      await instance.record('android', TEST_ID_PREFIX);
      await instance.record('android', TEST_ID_PREFIX);
      await instance.record('ios', TEST_ID_PREFIX);
      await state.storage.delete('day');
      await instance.record('ios', TEST_ID_PREFIX);
      return keys;
    });

    expect(writes).toEqual([
      // First send: nothing stored yet.
      ['count', 'day', 'idPrefix', 'platform'],
      // Same day, same device: the count is all that moved.
      ['count'],
      ['count', 'platform'],
      // A new day rewrites the day, not the unchanged platform or prefix.
      ['count', 'day'],
    ]);
    expect((await stub.check()).used).toBe(1);
  });

  it('keeps the pending flush alarm on same-day sends, since setAlarm is a billed row write too', async () => {
    const stub = stubFor('probe-alarm-writes');
    const calls = await runInDurableObject(stub, async (instance, state) => {
      let count = 0;
      const setAlarm = state.storage.setAlarm.bind(state.storage);
      state.storage.setAlarm = ((...args: Parameters<typeof setAlarm>) => {
        count += 1;
        return setAlarm(...args);
      }) as typeof state.storage.setAlarm;

      await instance.record('android', TEST_ID_PREFIX);
      await instance.record('android', TEST_ID_PREFIX);
      await instance.record('android', TEST_ID_PREFIX);
      return count;
    });

    // Only the first send arms the flush; the rest find it already pending at
    // exactly the same time, because the jitter is derived from the object id.
    expect(calls).toBe(1);
    expectMidnightFlush((await storedState(stub)).alarm);
  });

  it('reports the hashed-token prefix to Analytics Engine, not the derived id', async () => {
    const stub = stubFor('probe-usage-id');
    const rows: { blobs?: unknown[]; indexes?: unknown[] }[] = [];

    const derivedId = await runInDurableObject(stub, async (instance, state) => {
      // env is protected on DurableObject, so the capture reaches past it.
      (instance as unknown as { env: { USAGE: unknown } }).env.USAGE = {
        writeDataPoint: (point: { blobs?: unknown[]; indexes?: unknown[] }) => rows.push(point),
      };
      // record() is the only thing that writes platform and idPrefix, so let it
      // write them rather than seeding storage: a seeded prefix would be flushed
      // even if record() stopped persisting one.
      await instance.record('ios', TEST_ID_PREFIX);
      // Age the day it just wrote, leaving what it persisted alongside.
      await state.storage.put({ day: '2020-01-01', count: 3 });
      // Rolling onto today flushes 2020-01-01 from stored state.
      await instance.record('ios', TEST_ID_PREFIX);
      return state.id.toString();
    });

    expect(rows).toHaveLength(1);
    // Both the platform and the prefix here came from record(), not the test.
    expect(rows[0]?.blobs).toEqual(['2020-01-01', 'ios', TEST_ID_PREFIX]);
    expect(rows[0]?.indexes).toEqual([TEST_ID_PREFIX]);
    // The id cannot be read off ctx.id, so a row built from it is unusable for
    // correlation. Guards against reintroducing that.
    expect(derivedId.slice(0, TEST_ID_PREFIX.length)).not.toBe(TEST_ID_PREFIX);
  });

  it('re-arms the alarm when record() already rolled the day over', async () => {
    const stub = stubFor('probe-alarm-rearm');
    // record() arms the alarm; firing it now reproduces the production case
    // where a post-midnight send performed the rollover before the alarm ran.
    await stub.record('android', TEST_ID_PREFIX);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const stored = await storedState(stub);
    // A day in progress is not idle, so nothing is purged.
    expect(stored.entries).toEqual({
      day: utcDayKey(Date.now()),
      count: 1,
      platform: 'android',
      idPrefix: TEST_ID_PREFIX,
    });
    // Without re-arming, this device's final day would never be flushed.
    expectMidnightFlush(stored.alarm);
  });

  it('deletes everything when the idle purge fires', async () => {
    const stub = stubFor('probe-idle-purge');
    await flushToIdle(stub);
    // Nothing delivered since the flush, so the pending alarm is the purge.
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect(await storedState(stub)).toEqual({ entries: {}, alarm: null });
  });

  it('pulls the idle purge back to the next midnight when the device sends again', async () => {
    const stub = stubFor('probe-idle-return');
    await flushToIdle(stub);
    expect((await storedState(stub)).alarm).toBeGreaterThan(nextUtcMidnightMs(Date.now()) + FLUSH_JITTER_WINDOW_MS);

    await stub.record('android', TEST_ID_PREFIX);
    // Left 30 days out, the day in progress would miss its midnight flush.
    expectMidnightFlush((await storedState(stub)).alarm);
  });

  it('starts a purged device over as a new one', async () => {
    const stub = stubFor('probe-idle-restart');
    await flushToIdle(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await stub.check()).used).toBe(0);

    expect((await stub.record('ios', TEST_ID_PREFIX)).used).toBe(1);
    const stored = await storedState(stub);
    expect(stored.entries).toEqual({
      day: utcDayKey(Date.now()),
      count: 1,
      platform: 'ios',
      idPrefix: TEST_ID_PREFIX,
    });
    expectMidnightFlush(stored.alarm);
  });
});
