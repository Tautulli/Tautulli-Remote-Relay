import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { QuotaCounter } from '../src/quota';

/**
 * Direct Durable Object tests for the stateful parts the HTTP tests cannot
 * reach: day rollover, the Analytics Engine flush, and alarm re-arming.
 */

function stubFor(name: string): DurableObjectStub<QuotaCounter> {
  return env.QUOTA.get(env.QUOTA.idFromName(name)) as DurableObjectStub<QuotaCounter>;
}

/** Stands in for SHA-256(token).slice(0, USAGE_ID_PREFIX_LENGTH). */
const TEST_ID_PREFIX = '1514eb454a58f37f';

describe('QuotaCounter storage lifecycle', () => {
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

  it('clears the day key when the alarm flushes a completed day', async () => {
    const stub = stubFor('probe-alarm-flush');
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put({ day: '2020-01-01', count: 7, platform: 'android' });
      await state.storage.setAlarm(Date.now() + 1000);
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const stored = await runInDurableObject(stub, async (_instance, state) => ({
      day: await state.storage.get('day'),
      count: await state.storage.get('count'),
    }));
    // `put({day: undefined})` would silently skip the key; it must be deleted.
    expect(stored.day).toBeUndefined();
    expect(stored.count).toBe(0);
  });

  it('reports the hashed-token prefix to Analytics Engine, not the derived id', async () => {
    const stub = stubFor('probe-usage-id');
    const rows: { blobs?: unknown[]; indexes?: unknown[] }[] = [];

    const derivedId = await runInDurableObject(stub, async (instance, state) => {
      // env is protected on DurableObject, so the capture reaches past it.
      (instance as unknown as { env: { USAGE: unknown } }).env.USAGE = {
        writeDataPoint: (point: { blobs?: unknown[]; indexes?: unknown[] }) => rows.push(point),
      };
      // A completed day carrying the prefix record() persisted for it.
      await state.storage.put({
        day: '2020-01-01',
        count: 3,
        platform: 'android',
        idPrefix: TEST_ID_PREFIX,
      });
      // Rolling onto today flushes 2020-01-01.
      await instance.record('android', TEST_ID_PREFIX);
      return state.id.toString();
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.blobs).toEqual(['2020-01-01', 'android', TEST_ID_PREFIX]);
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

    const stored = await runInDurableObject(stub, async (_instance, state) => ({
      count: await state.storage.get('count'),
      alarm: await state.storage.getAlarm(),
    }));
    expect(stored.count).toBe(1);
    // Without re-arming, this device's final day would never be flushed.
    expect(stored.alarm).not.toBeNull();
  });
});
