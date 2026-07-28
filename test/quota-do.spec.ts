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
    await stub.record('android');

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

    const decision = await stub.record('android');
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

  it('re-arms the alarm when record() already rolled the day over', async () => {
    const stub = stubFor('probe-alarm-rearm');
    // record() arms the alarm; firing it now reproduces the production case
    // where a post-midnight send performed the rollover before the alarm ran.
    await stub.record('android');
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
