import type { Platform } from './schema';
import type { Env } from './types';

/**
 * Minimal FCM HTTP v1 client: WebCrypto-signed service-account JWT exchanged
 * for an OAuth access token (cached in memory and optionally in KV), then
 * POSTs to the messages:send endpoint. No third-party dependencies.
 */

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
/** Refresh the cached access token this many seconds before it actually expires. */
const TOKEN_EXPIRY_MARGIN_SECONDS = 300;
/** KV rejects an expirationTtl below 60 seconds. */
const KV_MIN_TTL_SECONDS = 60;
const KV_TOKEN_KEY = 'fcm-oauth-token';

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri: string;
}

export type FcmSendResult =
  | { ok: true }
  | { ok: false; kind: 'unregistered' }
  | { ok: false; kind: 'invalid_argument'; detail: string }
  | { ok: false; kind: 'error'; detail: string };

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

/** In-isolate cache; isolates are recycled, so KV (when bound) backstops this. */
let memoryToken: CachedToken | null = null;
/**
 * Single-flight: without it, every concurrent request on a cold isolate mints
 * its own token — an RSA-2048 sign plus a Google token exchange each, which
 * turns a traffic burst into a matching burst of OAuth calls.
 */
let inFlightMint: Promise<string> | null = null;

function parseServiceAccount(env: Env): ServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(env.FCM_SERVICE_ACCOUNT);
  } catch {
    throw new Error('FCM_SERVICE_ACCOUNT secret is not valid JSON');
  }
  const account = parsed as Partial<ServiceAccount>;
  if (!account.project_id || !account.client_email || !account.private_key || !account.token_uri) {
    throw new Error('FCM_SERVICE_ACCOUNT secret is missing required service-account fields');
  }
  return account as ServiceAccount;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function base64UrlEncodeJson(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

/**
 * Accepts the private key both as stored by `wrangler secret put` (JSON.parse
 * has already turned the \n escapes into real newlines) and as it arrives from
 * a secret that was JSON-encoded twice — a common way to break this, and one
 * that otherwise surfaces only as an opaque 500 on every send.
 */
function pemToPkcs8(pem: string): ArrayBuffer {
  if (pem.includes('BEGIN RSA PRIVATE KEY')) {
    throw new Error(
      'FCM_SERVICE_ACCOUNT private_key is in PKCS#1 format; WebCrypto needs the PKCS#8 form ' +
        '("BEGIN PRIVATE KEY") that Google issues for service accounts',
    );
  }
  const base64 = pem
    .replace(/\\n/g, '\n')
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '');
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new Error('FCM_SERVICE_ACCOUNT private_key is not valid base64 PEM content');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function signJwt(account: ServiceAccount): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = base64UrlEncodeJson({ alg: 'RS256', typ: 'JWT' });
  const claims = base64UrlEncodeJson({
    iss: account.client_email,
    scope: FCM_SCOPE,
    aud: account.token_uri,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  });
  const signingInput = `${header}.${claims}`;
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      'pkcs8',
      pemToPkcs8(account.private_key),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
  } catch (error) {
    throw new Error(
      `FCM_SERVICE_ACCOUNT private_key could not be imported: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function fetchAccessToken(account: ServiceAccount): Promise<{ accessToken: string; expiresInSeconds: number }> {
  const assertion = await signJwt(account);
  const response = await fetch(account.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!response.ok) {
    throw new Error(`OAuth token exchange failed with status ${response.status}`);
  }
  let body: { access_token?: string; expires_in?: number };
  try {
    body = (await response.json()) as { access_token?: string; expires_in?: number };
  } catch {
    throw new Error('OAuth token exchange returned a non-JSON body');
  }
  if (!body.access_token) {
    throw new Error('OAuth token exchange returned no access token');
  }
  return { accessToken: body.access_token, expiresInSeconds: body.expires_in ?? 3600 };
}

async function mintToken(env: Env, account: ServiceAccount): Promise<string> {
  const fresh = await fetchAccessToken(account);
  const lifetimeSeconds = Math.max(KV_MIN_TTL_SECONDS, fresh.expiresInSeconds - TOKEN_EXPIRY_MARGIN_SECONDS);
  memoryToken = { accessToken: fresh.accessToken, expiresAtMs: Date.now() + lifetimeSeconds * 1000 };
  if (env.OAUTH_CACHE) {
    // A cache write must never fail a delivery: the token is already in hand,
    // and KV throws on transient errors and on writes past 1/second per key.
    try {
      await env.OAUTH_CACHE.put(KV_TOKEN_KEY, JSON.stringify(memoryToken), { expirationTtl: lifetimeSeconds });
    } catch (error) {
      console.error(`oauth cache write failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }
  return fresh.accessToken;
}

async function getAccessToken(env: Env, account: ServiceAccount): Promise<string> {
  const now = Date.now();
  if (memoryToken && memoryToken.expiresAtMs > now) {
    return memoryToken.accessToken;
  }
  if (env.OAUTH_CACHE) {
    try {
      const cached = await env.OAUTH_CACHE.get<CachedToken>(KV_TOKEN_KEY, 'json');
      if (cached && cached.expiresAtMs > now) {
        memoryToken = cached;
        return cached.accessToken;
      }
    } catch (error) {
      console.error(`oauth cache read failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }
  if (!inFlightMint) {
    inFlightMint = mintToken(env, account).finally(() => {
      inFlightMint = null;
    });
  }
  return inFlightMint;
}

/**
 * Drop a cached token that FCM has rejected. Without this a token invalidated
 * early (service-account key rotated or revoked) would keep failing every send
 * until its computed expiry, up to ~55 minutes, across every isolate sharing KV.
 */
async function invalidateAccessToken(env: Env): Promise<void> {
  memoryToken = null;
  if (env.OAUTH_CACHE) {
    try {
      await env.OAUTH_CACHE.delete(KV_TOKEN_KEY);
    } catch (error) {
      console.error(`oauth cache delete failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }
}

/**
 * How long an undelivered notification stays queued for an offline device.
 * Matches the OneSignal default the app migrated from; FCM's own default is
 * 28 days, which would greet a device that was off for a week with a flood of
 * stale playback notifications.
 */
const MESSAGE_LIFETIME_SECONDS = 3 * 24 * 60 * 60;

/**
 * Build the FCM v1 message. The Tautulli `data` dict rides as a single JSON
 * string under the `payload` key: FCM coerces data-map values to strings, and
 * one blob keeps the typed fields (`encrypted`, `version`) intact for the
 * native handlers with a single parse point.
 *
 * Android is data-only (the app's FirebaseMessagingService builds the
 * notification after decrypting). iOS is an alert push with mutable-content
 * so the Notification Service Extension can rewrite it — the same mechanism
 * OneSignal used, keeping on-device behavior identical.
 */
export function buildMessage(token: string, platform: Platform, data: Record<string, unknown>): Record<string, unknown> {
  const payload = JSON.stringify(data);
  if (platform === 'ios') {
    const expiration = Math.floor(Date.now() / 1000) + MESSAGE_LIFETIME_SECONDS;
    return {
      token,
      data: { payload },
      apns: {
        headers: {
          'apns-priority': '10',
          'apns-push-type': 'alert',
          'apns-expiration': String(expiration),
        },
        payload: {
          aps: {
            alert: { body: 'Tautulli Notification' },
            sound: 'default',
            'mutable-content': 1,
          },
        },
      },
    };
  }
  return {
    token,
    data: { payload },
    android: { priority: 'HIGH', ttl: `${MESSAGE_LIFETIME_SECONDS}s` },
  };
}

interface FcmErrorBody {
  error?: {
    status?: string;
    message?: string;
    details?: Array<{ ['@type']?: string; errorCode?: string }>;
  };
}

async function postToFcm(
  env: Env,
  account: ServiceAccount,
  message: Record<string, unknown>,
  validateOnly: boolean,
): Promise<Response> {
  const accessToken = await getAccessToken(env, account);
  return fetch(`https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(validateOnly ? { validate_only: true, message } : { message }),
  });
}

export async function sendFcmMessage(
  env: Env,
  message: Record<string, unknown>,
  validateOnly: boolean,
): Promise<FcmSendResult> {
  let response: Response;
  try {
    const account = parseServiceAccount(env);
    response = await postToFcm(env, account, message, validateOnly);
    if (response.status === 401) {
      // The cached OAuth token was rejected — drop it and mint a fresh one
      // once. Only 401 (UNAUTHENTICATED) means a stale token; 403 is a
      // different, terminal condition handled below and must not retry.
      await invalidateAccessToken(env);
      response = await postToFcm(env, account, message, validateOnly);
    }
  } catch (error) {
    // A thrown error here is the relay's own machinery failing — a bad
    // service-account secret, an OAuth-exchange failure (revoked key), or a
    // network fault reaching Google. All are transient or operator-side from
    // the caller's view, so surface a retryable FCM_ERROR, never an opaque 500.
    // Not logged here: both callers report this detail with the device attached,
    // and a bad service-account secret fails every request, so logging twice
    // would double the volume exactly when the log matters.
    const detail = error instanceof Error ? error.message : 'unknown FCM transport error';
    return { ok: false, kind: 'error', detail };
  }

  if (response.ok) {
    return { ok: true };
  }

  let errorBody: FcmErrorBody = {};
  try {
    errorBody = (await response.json()) as FcmErrorBody;
  } catch {
    // Non-JSON error body; fall through with what we have.
  }
  const status = errorBody.error?.status ?? '';
  const fcmErrorCode = errorBody.error?.details?.find((d) => d.errorCode)?.errorCode ?? '';
  const detail = `FCM responded ${response.status} ${status || 'UNKNOWN'}${fcmErrorCode ? ` (${fcmErrorCode})` : ''}`;

  // Terminal, token-specific conditions map to "unregistered" — callers treat
  // that as permanent and stop using the token. Match on the FCM errorCode, not
  // the bare HTTP status: UNREGISTERED = the token is dead; SENDER_ID_MISMATCH =
  // the token belongs to a different Firebase project (a Tautulli server pointed
  // at the wrong relay, or a fork's relay reached by the official app), which is
  // equally permanent for this relay. A bare 404/403 without one of these codes
  // is a transient/operator fault and stays on the retryable error path.
  if (fcmErrorCode === 'UNREGISTERED' || fcmErrorCode === 'SENDER_ID_MISMATCH') {
    return { ok: false, kind: 'unregistered' };
  }
  if (response.status === 400 || status === 'INVALID_ARGUMENT') {
    return { ok: false, kind: 'invalid_argument', detail };
  }
  return { ok: false, kind: 'error', detail };
}

/** Test hook: clear the in-isolate OAuth cache. */
export function resetTokenCacheForTests(): void {
  memoryToken = null;
  inFlightMint = null;
}
