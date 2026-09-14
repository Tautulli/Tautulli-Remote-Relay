import { SELF, env, fetchMock } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { resetTokenCacheForTests } from '../src/fcm';
import { TEST_DATA, TEST_TOKEN } from './fixtures';
import { JSON_HEADERS, mockFcm, mockOauth, notify, quota } from './helpers';

// This project runs the same worker with DAILY_LIMIT = "2" (see
// vitest.enforced.config.ts) to exercise the enforced-cap path.

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

beforeEach(() => {
  resetTokenCacheForTests();
});

afterEach(() => {
  fetchMock.assertNoPendingInterceptors();
});

describe('with DAILY_LIMIT=2', () => {
  it('health reports the enforced cap', async () => {
    const response = await SELF.fetch('https://relay.test/v1/health');
    expect(await response.json()).toMatchObject({
      status: 'ok',
      rateLimits: { enforced: true, maximum: 2 },
    });
  });

  it('allows sends up to the cap, then refuses with 429 and Retry-After', async () => {
    mockOauth();
    mockFcm(200, { name: 'ok' }, 2);

    const first = (await (await notify()).json()) as { rateLimits: Record<string, unknown> };
    expect(first.rateLimits).toMatchObject({ enforced: true, maximum: 2, used: 1, remaining: 1 });
    expect((await notify()).status).toBe(200);

    const third = await notify();
    expect(third.status).toBe(429);
    expect(third.headers.get('Retry-After')).toMatch(/^\d+$/);
    const body = (await third.json()) as { code: string; rateLimits: Record<string, unknown> };
    expect(body.code).toBe('RATE_LIMITED');
    expect(body.rateLimits).toMatchObject({ enforced: true, maximum: 2, used: 2, remaining: 0 });
  });

  it('does not count refused sends', async () => {
    mockOauth();
    mockFcm(200, { name: 'ok' }, 2);
    await notify();
    await notify();
    expect((await notify()).status).toBe(429);
    expect((await notify()).status).toBe(429);

    const state = (await (await quota()).json()) as { rateLimits: { used: number; remaining: number } };
    expect(state.rateLimits.used).toBe(2);
    expect(state.rateLimits.remaining).toBe(0);
  });

  it('does not let failed deliveries burn the cap', async () => {
    mockOauth();
    // Two FCM outages followed by a success: the failures must not consume the
    // device's allowance, so the genuine notification still gets through.
    mockFcm(500, { error: { code: 500, status: 'INTERNAL' } }, 2);
    expect((await notify()).status).toBe(502);
    expect((await notify()).status).toBe(502);

    mockFcm(200, { name: 'ok' });
    const recovered = await notify();
    expect(recovered.status).toBe(200);
    const body = (await recovered.json()) as { rateLimits: { used: number } };
    expect(body.rateLimits.used).toBe(1);
  });

  it('reports the pre-send count when the quota write fails after delivery', async () => {
    mockOauth();
    mockFcm(200, { name: 'ok' }, 2);
    await notify();

    const broken = {
      ...env,
      QUOTA: {
        idFromName: (name: string) => env.QUOTA.idFromName(name),
        get: (id: never) => ({
          check: () => env.QUOTA.get(id).check(),
          record: () => Promise.reject(new Error('durable object unavailable')),
        }),
      },
    } as unknown as Parameters<typeof worker.fetch>[1];

    // Called directly so the env can carry a failing QUOTA binding; see the
    // monitor-mode version in relay.spec.ts for why Content-Length is set by hand.
    const payload = JSON.stringify({ token: TEST_TOKEN, platform: 'android', data: TEST_DATA });
    const response = await worker.fetch(
      new Request('https://relay.test/v1/notify', {
        method: 'POST',
        headers: {
          ...JSON_HEADERS,
          'CF-Connecting-IP': '203.0.113.45',
          'Content-Length': String(new TextEncoder().encode(payload).length),
        },
        body: payload,
      }),
      broken,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { rateLimits: Record<string, unknown> };
    // Enforced mode read the counter before sending, so it can report this send.
    expect(body.rateLimits).toMatchObject({ enforced: true, maximum: 2, used: 2, remaining: 0 });
    const stored = (await (await quota()).json()) as { rateLimits: { used: number } };
    expect(stored.rateLimits.used).toBe(1);
  });
});
