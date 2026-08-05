import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { QuotaCounter } from '../src/quota';

describe('lens probe', () => {
  it('reports whether ctx.id.name survives into the Durable Object', async () => {
    const tokenHash = 'a'.repeat(64);
    const stub = env.QUOTA.get(env.QUOTA.idFromName(tokenHash)) as DurableObjectStub<QuotaCounter>;
    const outside = env.QUOTA.idFromName(tokenHash).name;
    const info = await runInDurableObject(stub, async (_i, state) => ({
      insideName: state.id.name ?? null,
      insideId: state.id.toString(),
    }));
    console.log(`PROBE outsideName=${String(outside)} insideName=${String(info.insideName)} insideId=${info.insideId}`);
    expect(true).toBe(true);
  });
});
