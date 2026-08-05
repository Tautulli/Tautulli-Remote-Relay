import { SELF, env, fetchMock } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { resetTokenCacheForTests } from '../src/fcm';
import { TEST_DATA, TEST_TOKEN } from './fixtures';
import { JSON_HEADERS, captureFcm, lastCaptured, mockFcm, mockOauth, notify, quota, validate } from './helpers';

/** Mirrors the NOTIFY_BURST limiter in wrangler.toml. */
const NOTIFY_BURST_LIMIT = 30;

// This project runs in monitor mode (DAILY_LIMIT = "0" from wrangler.toml).
// Enforced-cap behavior is covered by test/enforced.spec.ts, which runs the
// same worker with DAILY_LIMIT = "2".

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

beforeEach(() => {
  // Each test authenticates against the mocked OAuth endpoint from scratch.
  resetTokenCacheForTests();
});

afterEach(() => {
  fetchMock.assertNoPendingInterceptors();
});

describe('/v1/health', () => {
  it('reports monitor mode and limiter configuration', async () => {
    const response = await SELF.fetch('https://relay.test/v1/health');
    expect(response.status).toBe(200);
    // limitersConfigured reflects the bindings wrangler.toml actually attaches,
    // so a deployment that forgot them is externally detectable.
    expect(await response.json()).toEqual({
      status: 'ok',
      rateLimits: { enforced: false, maximum: null },
      limitersConfigured: true,
    });
  });

  it('answers HEAD probes with 200 and the same headers as the GET', async () => {
    const response = await SELF.fetch('https://relay.test/v1/health', { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    // HEAD used to hand-roll a header subset and drop this one.
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('sets no-store and nosniff on JSON responses', async () => {
    const response = await SELF.fetch('https://relay.test/v1/health');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });
});

describe('POST /v1/notify — validation', () => {
  it('rejects a non-JSON body', async () => {
    const response = await SELF.fetch('https://relay.test/v1/notify', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: 'not json',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ status: 'error', code: 'BAD_REQUEST' });
  });

  it('rejects CORS-simple content types so cross-origin POSTs need a preflight', async () => {
    for (const contentType of [
      'text/plain;charset=UTF-8',
      'application/x-www-form-urlencoded',
      'multipart/form-data',
      // Essence is CORS-safelisted, so these need no preflight; a substring
      // search for the JSON type lets them straight through.
      'multipart/form-data; boundary=application/json',
      'text/plain; charset=application/json',
    ]) {
      const response = await SELF.fetch('https://relay.test/v1/notify', {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body: JSON.stringify({ token: TEST_TOKEN, platform: 'android', data: TEST_DATA }),
      });
      expect(response.status).toBe(400);
    }
  });

  it('rejects an oversized body from its Content-Length before parsing', async () => {
    const response = await SELF.fetch('https://relay.test/v1/notify', {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'Content-Length': String(64 * 1024) },
      body: JSON.stringify({ token: TEST_TOKEN, platform: 'android', data: { blob: 'x'.repeat(64 * 1024) } }),
    });
    expect(response.status).toBe(413);
  });

  it('rejects a streamed body, which declares no Content-Length at all', async () => {
    // The size guard can only be trusted if an undeclared body is refused: a
    // chunked/streamed request is exactly how a caller avoids declaring one.
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(JSON.stringify({ token: TEST_TOKEN, platform: 'android', data: TEST_DATA })),
        );
        controller.close();
      },
    });
    const response = await SELF.fetch('https://relay.test/v1/notify', {
      method: 'POST',
      headers: JSON_HEADERS,
      body,
      duplex: 'half',
    } as RequestInit);
    expect(response.status).toBe(413);
  });

  it('accepts every shape of client address the limiter key has to handle', async () => {
    // Full IPv6, an elided run, IPv4-mapped and plain IPv4. All are under the
    // limit, so this asserts only that the key is built without error for each
    // shape, not that the /64 truncation produces the right value.
    mockOauth();
    mockFcm(200, { name: 'projects/relay-test-project/messages/1' }, 4);
    const send = (ip: string) =>
      SELF.fetch('https://relay.test/v1/notify', {
        method: 'POST',
        headers: { ...JSON_HEADERS, 'CF-Connecting-IP': ip },
        body: JSON.stringify({ token: TEST_TOKEN, platform: 'android', data: TEST_DATA }),
      });
    expect((await send('2001:db8:1:2:3:4:5:6')).status).toBe(200);
    expect((await send('2001:db8::1')).status).toBe(200);
    expect((await send('::ffff:203.0.113.7')).status).toBe(200);
    expect((await send('203.0.113.7')).status).toBe(200);
  });

  it('still reports success when the quota write fails after delivery', async () => {
    mockOauth();
    mockFcm(200, { name: 'projects/relay-test-project/messages/1' });

    // FCM already has the message, so a Durable Object failure must not turn a
    // delivered notification into a 500 the sender records as a failure.
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

    const before = (await (await quota()).json()) as { rateLimits: { used: number } };

    // Calling the handler directly rather than through SELF, so the env can carry
    // a failing QUOTA binding. Content-Length has to be set by hand: the runtime
    // adds it when a request is actually sent, and readJsonBody requires it.
    const payload = JSON.stringify({ token: TEST_TOKEN, platform: 'android', data: TEST_DATA });
    const response = await worker.fetch(
      new Request('https://relay.test/v1/notify', {
        method: 'POST',
        headers: {
          ...JSON_HEADERS,
          'CF-Connecting-IP': '203.0.113.44',
          'Content-Length': String(new TextEncoder().encode(payload).length),
        },
        body: payload,
      }),
      broken,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; rateLimits: { used: number } };
    expect(body.status).toBe('ok');
    // Reported as counted, from the pre-send check.
    expect(body.rateLimits.used).toBe(before.rateLimits.used + 1);

    // ...but the write really did fail, so the stored count is unchanged.
    const after = (await (await quota()).json()) as { rateLimits: { used: number } };
    expect(after.rateLimits.used).toBe(before.rateLimits.used);
  });

  it('gives each source its own burst budget for the same token', async () => {
    // A third party holding the token must not be able to spend the budget the
    // paired Tautulli draws from. NOTIFY_BURST is 30/60s (wrangler.toml), and a
    // refusal happens before FCM is called, so exactly 31 sends reach FCM: 30
    // from the first address plus one from the second.
    mockOauth();
    mockFcm(200, { name: 'projects/relay-test-project/messages/1' }, NOTIFY_BURST_LIMIT + 1);
    const send = (ip: string) =>
      SELF.fetch('https://relay.test/v1/notify', {
        method: 'POST',
        headers: { ...JSON_HEADERS, 'CF-Connecting-IP': ip },
        body: JSON.stringify({ token: TEST_TOKEN, platform: 'android', data: TEST_DATA }),
      });

    const other = '198.51.100.9';
    for (let i = 0; i < NOTIFY_BURST_LIMIT; i++) {
      expect((await send(other)).status).toBe(200);
    }
    expect((await send(other)).status).toBe(429);

    // The paired server, on its own address, still has its full budget.
    expect((await send('203.0.113.7')).status).toBe(200);
  });

  it('rejects a missing or short token', async () => {
    expect((await notify({ token: undefined })).status).toBe(400);
    expect((await notify({ token: 'too-short' })).status).toBe(400);
  });

  it('rejects a token containing characters no FCM token uses', async () => {
    expect((await notify({ token: `${'a'.repeat(120)}"quote` })).status).toBe(400);
    expect((await notify({ token: `${'a'.repeat(120)}\n` })).status).toBe(400);
  });

  it('rejects an unknown platform', async () => {
    const response = await notify({ platform: 'windows' });
    expect(response.status).toBe(400);
  });

  it('rejects a non-object data field', async () => {
    expect((await notify({ data: 'string' })).status).toBe(400);
    expect((await notify({ data: [1, 2] })).status).toBe(400);
  });

  it('rejects data over the serialized size cap with 413', async () => {
    const response = await notify({ data: { cipher_text: 'x'.repeat(4000) } });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });
});

describe('POST /v1/notify — delivery', () => {
  it('forwards an Android notification as a data-only high-priority message', async () => {
    mockOauth();
    const captured: string[] = [];
    captureFcm(200, { name: 'projects/relay-test-project/messages/1' }, captured);

    const response = await notify();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; rateLimits: Record<string, unknown> };
    expect(body.status).toBe('ok');
    expect(body.rateLimits).toMatchObject({ enforced: false, maximum: null, used: 1, remaining: null });

    const request = lastCaptured(captured);
    expect(request.message.token).toBe(TEST_TOKEN);
    expect(request.message.android).toEqual({ priority: 'HIGH', ttl: '259200s' });
    expect(request.message.apns).toBeUndefined();
    expect(request.message.notification).toBeUndefined();
    expect(JSON.parse(request.message.data.payload)).toEqual(TEST_DATA);
  });

  it('forwards an iOS notification as an alert push with mutable-content', async () => {
    mockOauth();
    const captured: string[] = [];
    captureFcm(200, { name: 'projects/relay-test-project/messages/2' }, captured);

    const response = await notify({ platform: 'ios' });
    expect(response.status).toBe(200);

    const request = lastCaptured(captured);
    expect(request.message.apns.headers).toMatchObject({ 'apns-priority': '10', 'apns-push-type': 'alert' });
    // The expiration keeps stale notifications from flooding a device that was
    // off for days: roughly now + 3 days, expressed in epoch seconds.
    const expiration = Number(request.message.apns.headers['apns-expiration']);
    const expected = Date.now() / 1000 + 259200;
    expect(Math.abs(expiration - expected)).toBeLessThan(120);
    expect(request.message.apns.payload.aps).toEqual({
      alert: { body: 'Tautulli Notification' },
      sound: 'default',
      'mutable-content': 1,
    });
    expect(JSON.parse(request.message.data.payload)).toEqual(TEST_DATA);
  });

  it('counts sends across requests', async () => {
    mockOauth();
    mockFcm(200, { name: 'ok' }, 2);
    await notify();
    const second = await notify();
    const body = (await second.json()) as { rateLimits: { used: number } };
    expect(body.rateLimits.used).toBe(2);
  });

  it('maps an unregistered FCM token to 410 UNREGISTERED', async () => {
    mockOauth();
    mockFcm(404, {
      error: { code: 404, status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] },
    });
    const response = await notify();
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ status: 'error', code: 'UNREGISTERED' });
  });

  it('maps a cross-project token (SENDER_ID_MISMATCH) to 410 — it can never be delivered', async () => {
    mockOauth();
    mockFcm(403, {
      error: { code: 403, status: 'PERMISSION_DENIED', details: [{ errorCode: 'SENDER_ID_MISMATCH' }] },
    });
    const response = await notify();
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ code: 'UNREGISTERED' });
  });

  it('does NOT treat a bare 404 without an FCM error code as a dead token', async () => {
    mockOauth();
    mockFcm(404, '<html>Not Found</html>');
    const response = await notify();
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: 'FCM_ERROR' });
  });

  it('maps other FCM failures to 502 FCM_ERROR', async () => {
    mockOauth();
    mockFcm(500, { error: { code: 500, status: 'INTERNAL' } });
    const response = await notify();
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ status: 'error', code: 'FCM_ERROR' });
  });

  it('reports an OAuth failure as a retryable 502, not an opaque 500', async () => {
    fetchMock
      .get('https://oauth2.googleapis.com')
      .intercept({ method: 'POST', path: '/token' })
      .reply(400, { error: 'invalid_grant' });
    const response = await notify();
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: 'FCM_ERROR' });
  });

  it('mints a fresh token and retries once when FCM rejects the cached one with 401', async () => {
    mockOauth();
    mockFcm(401, { error: { code: 401, status: 'UNAUTHENTICATED' } });
    mockOauth();
    mockFcm(200, { name: 'ok' });

    const response = await notify();
    expect(response.status).toBe(200);
  });

  it('does not consume quota when the delivery fails', async () => {
    mockOauth();
    mockFcm(500, { error: { code: 500, status: 'INTERNAL' } });
    expect((await notify()).status).toBe(502);

    const state = (await (await quota()).json()) as { rateLimits: { used: number } };
    expect(state.rateLimits.used).toBe(0);
  });
});

describe('POST /v1/validate', () => {
  it('returns valid for a token FCM accepts', async () => {
    mockOauth();
    const captured: string[] = [];
    captureFcm(200, { name: 'ok' }, captured);

    const response = await validate({ token: TEST_TOKEN, platform: 'android' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', valid: true });
    expect(lastCaptured(captured)).toMatchObject({ validate_only: true });
  });

  it('returns 410 invalid for an unregistered token', async () => {
    mockOauth();
    mockFcm(404, { error: { code: 404, status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } });
    const response = await validate({ token: TEST_TOKEN });
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ status: 'error', valid: false });
  });

  it('rejects a missing token', async () => {
    const response = await validate({});
    expect(response.status).toBe(400);
  });
});

describe('POST /v1/quota', () => {
  it('reads the counter without incrementing it', async () => {
    mockOauth();
    mockFcm(200, { name: 'ok' });
    await notify();

    const first = (await (await quota()).json()) as { rateLimits: { used: number } };
    const second = (await (await quota()).json()) as { rateLimits: { used: number } };
    expect(first.rateLimits.used).toBe(1);
    expect(second.rateLimits.used).toBe(1);
  });
});

describe('routing', () => {
  it('returns 404 for unknown paths', async () => {
    const response = await SELF.fetch('https://relay.test/v2/other', { method: 'POST' });
    expect(response.status).toBe(404);
  });
});
