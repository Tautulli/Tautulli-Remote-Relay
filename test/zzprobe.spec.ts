import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { QuotaCounter } from '../src/quota';
import { TEST_DATA, TEST_TOKEN } from './fixtures';
import { JSON_HEADERS, mockFcm, mockOauth } from './helpers';

function stubFor(name: string): DurableObjectStub<QuotaCounter> {
  return env.QUOTA.get(env.QUOTA.idFromName(name)) as DurableObjectStub<QuotaCounter>;
}

const PREFIX = 'aaaaaaaaaaaaaaaa';

describe('probes', () => {
  it('P5: is ctx.id.name visible inside the DO?', async () => {
    const stub = stubFor('name-visibility-probe');
    const out = await runInDurableObject(stub, async (instance, state) => {
      const ctxId = (instance as unknown as { ctx: DurableObjectState }).ctx.id;
      return {
        stateIdName: state.id.name,
        ctxIdName: ctxId.name,
        ctxIdString: ctxId.toString(),
        outsideName: env.QUOTA.idFromName('name-visibility-probe').name,
      };
    });
    console.log('P5:', JSON.stringify(out));
  });

  it('P6: does mutating instance.env in one test leak into the shared env?', async () => {
    const stub = stubFor('leak-probe');
    await runInDurableObject(stub, async (instance) => {
      (instance as unknown as { env: { USAGE: unknown } }).env.USAGE = { writeDataPoint: () => {} };
    });
    console.log('P6 shared env.USAGE is the mock?', String((env.USAGE as any)?.writeDataPoint?.toString()));
    console.log('P6 env.USAGE ctor:', env.USAGE?.constructor?.name);
    // Does a DIFFERENT DO instance see the mutation?
    const other = await runInDurableObject(stubFor('leak-probe-other'), async (instance) => {
      const e = (instance as unknown as { env: { USAGE: any } }).env;
      return { usageIsMock: e.USAGE?.constructor?.name };
    });
    console.log('P6 other DO env.USAGE ctor:', JSON.stringify(other));
  });

  it('P7: real end-to-end notify — what prefix ends up in storage?', async () => {
    mockOauth();
    mockFcm(200, { name: 'projects/p/messages/1' });
    const res = await SELF.fetch('https://relay.test/v1/notify', {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'CF-Connecting-IP': '203.0.113.9' },
      body: JSON.stringify({ token: TEST_TOKEN, platform: 'android', data: TEST_DATA }),
    });
    expect(res.status).toBe(200);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(TEST_TOKEN));
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const stored = await runInDurableObject(
      env.QUOTA.get(env.QUOTA.idFromName(hash)) as DurableObjectStub<QuotaCounter>,
      async (_i, state) => ({
        keys: [...(await state.storage.list()).keys()],
        idPrefix: await state.storage.get('idPrefix'),
        derived16: state.id.toString().slice(0, 16),
      }),
    );
    console.log('P7 tokenHash16:', hash.slice(0, 16));
    console.log('P7 stored:', JSON.stringify(stored));
  });

  it('P8: alarm() with count 0 and a stale day — does it clear idPrefix or leave orphan state?', async () => {
    const stub = stubFor('probe-p8');
    const out = await runInDurableObject(stub, async (instance, state) => {
      await state.storage.put({ day: '2020-01-01', count: 0, platform: 'android', idPrefix: PREFIX });
      await (instance as unknown as { alarm(): Promise<void> }).alarm();
      return {
        keys: [...(await state.storage.list()).keys()],
        alarm: await state.storage.getAlarm(),
        day: await state.storage.get('day'),
        idPrefix: await state.storage.get('idPrefix'),
      };
    });
    console.log('P8:', JSON.stringify(out));
  });
});
