import { SELF, fetchMock } from 'cloudflare:test';
import { TEST_DATA, TEST_TOKEN } from './fixtures';

export const FCM_PATH = '/v1/projects/relay-test-project/messages:send';

export function mockOauth(): void {
  fetchMock
    .get('https://oauth2.googleapis.com')
    .intercept({ method: 'POST', path: '/token' })
    .reply(200, { access_token: 'test-access-token', expires_in: 3600 });
}

export function mockFcm(status: number, body: unknown, times = 1): void {
  fetchMock
    .get('https://fcm.googleapis.com')
    .intercept({ method: 'POST', path: FCM_PATH })
    .reply(status, body as never)
    .times(times);
}

/**
 * Like mockFcm, but records the outgoing request body. undici may invoke the
 * body matcher more than once per request, so read the LAST element rather
 * than asserting on length.
 */
export function captureFcm(status: number, body: unknown, captured: string[]): void {
  fetchMock
    .get('https://fcm.googleapis.com')
    .intercept({
      method: 'POST',
      path: FCM_PATH,
      body: (raw: string) => {
        captured.push(raw);
        return true;
      },
    })
    .reply(status, body as never);
}

export function lastCaptured(captured: string[]): { message: Record<string, any> } {
  const raw = captured[captured.length - 1];
  if (raw === undefined) {
    throw new Error('no FCM request was captured');
  }
  return JSON.parse(raw) as { message: Record<string, any> };
}

export const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function notify(overrides: Record<string, unknown> = {}): Promise<Response> {
  return SELF.fetch('https://relay.test/v1/notify', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ token: TEST_TOKEN, platform: 'android', data: TEST_DATA, ...overrides }),
  });
}

export function quota(): Promise<Response> {
  return SELF.fetch('https://relay.test/v1/quota', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ token: TEST_TOKEN }),
  });
}

export function validate(body: Record<string, unknown>): Promise<Response> {
  return SELF.fetch('https://relay.test/v1/validate', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}
