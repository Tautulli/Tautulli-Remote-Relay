import { SELF, fetchMock } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetTokenCacheForTests } from '../src/fcm';
import { TEST_DATA, TEST_TOKEN } from './fixtures';
import { JSON_HEADERS, captureFcm, lastCaptured, mockFcm, mockOauth, notify, quota, validate } from './helpers';

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

  it('answers HEAD probes with 200 (the reachability idiom the app uses)', async () => {
    const response = await SELF.fetch('https://relay.test/v1/health', { method: 'HEAD' });
    expect(response.status).toBe(200);
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
    for (const contentType of ['text/plain;charset=UTF-8', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
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
    const raw = captured[captured.length - 1]!;
    expect(JSON.parse(raw)).toMatchObject({ validate_only: true });
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
