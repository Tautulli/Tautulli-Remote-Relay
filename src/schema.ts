/**
 * Request validation. Deliberately dependency-free: the API surface is three
 * small POST bodies, and every rejected field is a 4xx the Tautulli server logs.
 */

/** FCM registration tokens are ~140-200 chars today; bounds are generous but hard. */
const TOKEN_MIN_LENGTH = 100;
const TOKEN_MAX_LENGTH = 512;

/**
 * FCM limits the total message to 4096 bytes; the envelope built around `data`
 * (token, android/apns blocks, JSON syntax) needs headroom, so the serialized
 * `data` object is capped below that.
 */
export const MAX_DATA_BYTES = 3800;

/**
 * Hard cap on the request body itself, checked against Content-Length before
 * anything is buffered or parsed. Generous next to MAX_DATA_BYTES so a
 * legitimate oversized payload still gets the precise 413 from the data check.
 */
export const MAX_BODY_BYTES = 16 * 1024;

export const PLATFORMS = ['android', 'ios'] as const;
export type Platform = (typeof PLATFORMS)[number];

export class SchemaError extends Error {}
export class PayloadTooLargeError extends Error {}

export interface NotifyRequest {
  token: string;
  platform: Platform;
  data: Record<string, unknown>;
}

export interface ValidateRequest {
  token: string;
  platform: Platform;
}

export interface QuotaRequest {
  token: string;
}

/**
 * FCM registration tokens are URL-safe base64-ish: alphanumerics plus `-`, `_`,
 * `:` and `.`. Pinning the charset keeps control characters and whitespace out
 * of the value that becomes both the FCM target and a Durable Object name.
 */
const TOKEN_PATTERN = /^[A-Za-z0-9._:-]+$/;

function requireToken(body: Record<string, unknown>): string {
  const token = body['token'];
  if (typeof token !== 'string' || token.length < TOKEN_MIN_LENGTH || token.length > TOKEN_MAX_LENGTH) {
    throw new SchemaError(`"token" must be a string of ${TOKEN_MIN_LENGTH}-${TOKEN_MAX_LENGTH} characters`);
  }
  if (!TOKEN_PATTERN.test(token)) {
    throw new SchemaError('"token" contains characters that are not valid in an FCM registration token');
  }
  return token;
}

function requirePlatform(body: Record<string, unknown>, optional = false): Platform {
  const platform = body['platform'];
  if (optional && platform === undefined) {
    return 'android';
  }
  if (platform !== 'android' && platform !== 'ios') {
    throw new SchemaError('"platform" must be "android" or "ios"');
  }
  return platform;
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SchemaError(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

export function parseNotifyRequest(body: unknown): NotifyRequest {
  const obj = asObject(body, 'request body');
  const token = requireToken(obj);
  const platform = requirePlatform(obj);
  const data = asObject(obj['data'], '"data"');
  const serialized = JSON.stringify(data);
  // UTF-8 length is never below UTF-16 code-unit length, so the cheap check
  // rejects oversized payloads without allocating an encoded copy of them.
  if (serialized.length > MAX_DATA_BYTES || byteLength(serialized) > MAX_DATA_BYTES) {
    throw new PayloadTooLargeError(`"data" exceeds ${MAX_DATA_BYTES} bytes serialized`);
  }
  return { token, platform, data };
}

export function parseValidateRequest(body: unknown): ValidateRequest {
  const obj = asObject(body, 'request body');
  // Platform is optional here: the message shape does not affect token validation,
  // and legacy Tautulli device rows may have no platform recorded.
  return { token: requireToken(obj), platform: requirePlatform(obj, true) };
}

export function parseQuotaRequest(body: unknown): QuotaRequest {
  return { token: requireToken(asObject(body, 'request body')) };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}
