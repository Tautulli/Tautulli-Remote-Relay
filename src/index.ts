import { buildMessage, sendFcmMessage } from './fcm';
import {
  MAX_BODY_BYTES,
  PayloadTooLargeError,
  SchemaError,
  parseNotifyRequest,
  parseQuotaRequest,
  parseValidateRequest,
} from './schema';
import { QuotaCounter, USAGE_ID_PREFIX_LENGTH, parseDailyLimit } from './quota';
import type { QuotaDecision } from './quota';
import type { Env, RateLimits, RateLimiter } from './types';

export { QuotaCounter };

/**
 * Stateless push relay for Tautulli Remote.
 *
 * A Tautulli server POSTs {token, platform, data} and the relay forwards it to
 * the device via FCM HTTP v1 (iOS delivery goes through FCM's APNs interface).
 * The `data` dict is opaque — it carries Tautulli's end-to-end AES-256-GCM
 * envelope, so the relay never sees notification content and stores nothing
 * about it. The FCM token is the bearer credential: it is unguessable and only
 * lets the holder notify that one device, matching the OneSignal model this
 * relay replaces. Logs carry status codes and hashed token prefixes only.
 */

const BURST_RETRY_AFTER_SECONDS = 60;

function json(status: number, body: Record<string, unknown>, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // A JSON API response is never script or a document; keep it from being
      // sniffed or cached by intermediaries (bodies carry per-device state).
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}

function toRateLimits(decision: QuotaDecision): RateLimits {
  const { allowed: _allowed, ...rateLimits } = decision;
  return rateLimits;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Require the request to declare JSON, which forces a CORS preflight for
 * cross-origin callers so a page cannot launder no-preflight POSTs through a
 * visitor's IP.
 *
 * Compares the MIME *essence* rather than searching the header. A substring
 * test accepts `multipart/form-data; boundary=application/json`, whose essence
 * is CORS-safelisted, and so admits exactly the requests this is meant to keep
 * out. Callers run this before touching a rate limiter, so a rejected
 * cross-origin POST costs the visitor's IP budget nothing.
 */
function assertJsonRequest(request: Request): void {
  const essence = (request.headers.get('Content-Type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (essence !== 'application/json') {
    throw new SchemaError('Content-Type must be application/json');
  }
}

/**
 * Read and parse the JSON body, refusing one larger than the cap so an
 * unauthenticated caller cannot make the Worker buffer and parse multi-megabyte
 * bodies.
 *
 * A missing or unparsable Content-Length is treated as over the cap rather than
 * waved through: `Number('')` is 0 and `Number.isFinite(NaN)` is false, so
 * trusting the header only rejects a caller honest enough to declare the size.
 */
async function readJsonBody(request: Request): Promise<unknown> {
  const declared = request.headers.get('Content-Length')?.trim();
  const contentLength = declared ? Number(declared) : NaN;
  if (!Number.isInteger(contentLength) || contentLength < 0 || contentLength > MAX_BODY_BYTES) {
    throw new PayloadTooLargeError(`request body exceeds ${MAX_BODY_BYTES} bytes`);
  }
  try {
    return await request.json();
  } catch {
    throw new SchemaError('request body must be valid JSON');
  }
}

async function checkLimiter(limiter: RateLimiter | undefined, key: string): Promise<boolean> {
  if (!limiter) {
    return true;
  }
  const { success } = await limiter.limit({ key });
  return success;
}

/**
 * The rate-limit key for a request.
 *
 * IPv6 is truncated to its /64. A single routed prefix is the normal unit of
 * allocation from any VPS host, so keying on the full address hands one
 * attacker 2^64 independent budgets and makes the per-IP ceiling — the only
 * control that bounds an unauthenticated caller — mean nothing.
 */
function clientIp(request: Request): string {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  // A dot means IPv4, plain or IPv4-mapped; truncating those would put every
  // IPv4 client in one bucket, which is the opposite of the fix.
  if (!ip.includes(':') || ip.includes('.')) {
    return ip;
  }
  // Expand an elided run so the first four groups are the real /64.
  const [head, tail = ''] = ip.split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail ? tail.split(':') : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  const groups = ip.includes('::')
    ? [...headGroups, ...Array<string>(Math.max(missing, 0)).fill('0'), ...tailGroups]
    : ip.split(':');
  return groups.slice(0, 4).join(':') + '::/64';
}

function secondsUntil(isoTimestamp: string): number {
  return Math.max(1, Math.ceil((Date.parse(isoTimestamp) - Date.now()) / 1000));
}

function rateLimited(detail: string, retryAfter: number, extra: Record<string, unknown> = {}): Response {
  return json(
    429,
    { status: 'error', code: 'RATE_LIMITED', detail, ...extra },
    { 'Retry-After': String(retryAfter) },
  );
}

function quotaStub(env: Env, tokenHash: string): DurableObjectStub<QuotaCounter> {
  return env.QUOTA.get(env.QUOTA.idFromName(tokenHash));
}

async function handleNotify(request: Request, env: Env): Promise<Response> {
  assertJsonRequest(request);
  // Per-IP limit FIRST: the token-keyed burst guard alone bounds nothing
  // against junk tokens (each fresh token gets a fresh budget), so an IP limit
  // is what caps flooding of an endpoint that calls FCM.
  if (!(await checkLimiter(env.NOTIFY_IP_LIMIT, clientIp(request)))) {
    return rateLimited('per-IP request limit exceeded', BURST_RETRY_AFTER_SECONDS);
  }

  const { token, platform, data } = parseNotifyRequest(await readJsonBody(request));
  const tokenHash = await sha256Hex(token);
  // Sixteen to match the usage dataset and the id the app shows a user, so a
  // support report, a log line and a usage row all name the device identically.
  const hashPrefix = tokenHash.slice(0, USAGE_ID_PREFIX_LENGTH);

  // Keyed on token AND source: on the token alone, anyone holding it drains the
  // same bucket the paired Tautulli draws from, and the server's notifications
  // are refused. Sending to a device is what the token grants; stopping the
  // paired server from sending is not. Volume stays bounded by the per-IP limit
  // above, which is what that limit is for.
  if (!(await checkLimiter(env.NOTIFY_BURST, `${tokenHash}:${clientIp(request)}`))) {
    console.warn(`notify burst ${hashPrefix}`);
    return rateLimited('burst limit exceeded', BURST_RETRY_AFTER_SECONDS);
  }

  // check() is read-only: an unknown/junk token that FCM will reject leaves no
  // durable state behind, and a device over its enforced cap is refused with no
  // FCM call. The counter is incremented (record) only after FCM accepts, so
  // failed deliveries never burn a device's daily allowance.
  const stub = quotaStub(env, tokenHash);
  const decision = await stub.check();
  if (!decision.allowed) {
    console.warn(`notify over-limit ${hashPrefix} used=${decision.used}`);
    return rateLimited('daily notification limit reached', secondsUntil(decision.resetsAt), {
      rateLimits: toRateLimits(decision),
    });
  }

  const result = await sendFcmMessage(env, buildMessage(token, platform, data), false);
  if (result.ok) {
    const recorded = await stub.record(platform, hashPrefix);
    console.log(`notify ok ${hashPrefix}`);
    return json(200, { status: 'ok', rateLimits: toRateLimits(recorded) });
  }
  switch (result.kind) {
    case 'unregistered':
      console.warn(`notify unregistered ${hashPrefix}`);
      return json(410, { status: 'error', code: 'UNREGISTERED' });
    case 'invalid_argument':
      console.error(`notify invalid ${hashPrefix}: ${result.detail}`);
      return json(400, { status: 'error', code: 'INVALID_ARGUMENT', detail: result.detail });
    default:
      console.error(`notify fcm-error ${hashPrefix}: ${result.detail}`);
      return json(502, { status: 'error', code: 'FCM_ERROR', detail: result.detail });
  }
}

async function handleValidate(request: Request, env: Env): Promise<Response> {
  assertJsonRequest(request);
  if (!(await checkLimiter(env.LOOKUP_LIMIT, clientIp(request)))) {
    return rateLimited('per-IP request limit exceeded', BURST_RETRY_AFTER_SECONDS);
  }
  const { token, platform } = parseValidateRequest(await readJsonBody(request));
  const hashPrefix = (await sha256Hex(token)).slice(0, USAGE_ID_PREFIX_LENGTH);
  const result = await sendFcmMessage(env, buildMessage(token, platform, {}), true);
  if (result.ok) {
    console.log(`validate ok ${hashPrefix}`);
    return json(200, { status: 'ok', valid: true });
  }
  if (result.kind === 'unregistered' || result.kind === 'invalid_argument') {
    // A Tautulli acts on this by dropping the device out of its notifier list,
    // so it is the outcome most worth having a record of.
    console.warn(`validate unregistered ${hashPrefix}`);
    return json(410, { status: 'error', valid: false });
  }
  console.error(`validate fcm-error ${hashPrefix}: ${result.detail}`);
  return json(502, { status: 'error', code: 'FCM_ERROR', detail: result.detail });
}

async function handleQuota(request: Request, env: Env): Promise<Response> {
  assertJsonRequest(request);
  if (!(await checkLimiter(env.LOOKUP_LIMIT, clientIp(request)))) {
    return rateLimited('per-IP request limit exceeded', BURST_RETRY_AFTER_SECONDS);
  }
  const { token } = parseQuotaRequest(await readJsonBody(request));
  const tokenHash = await sha256Hex(token);
  const decision = await quotaStub(env, tokenHash).peek();
  console.log(`quota ${tokenHash.slice(0, USAGE_ID_PREFIX_LENGTH)} used=${decision.used}`);
  return json(200, { status: 'ok', rateLimits: toRateLimits(decision) });
}

function handleHealth(env: Env, includeBody: boolean): Response {
  const limit = parseDailyLimit(env.DAILY_LIMIT);
  const body = {
    status: 'ok',
    rateLimits: { enforced: limit !== null, maximum: limit },
    // Lets a self-hosted deployment detect that it forgot to wire the rate-limit
    // bindings (they are optional, and checkLimiter fails open without them).
    limitersConfigured: Boolean(env.NOTIFY_IP_LIMIT && env.NOTIFY_BURST && env.LOOKUP_LIMIT),
  };
  // A HEAD probe wants the status line, not a body.
  if (!includeBody) {
    return new Response(null, {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }
  return json(200, body);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    try {
      if (pathname === '/v1/health' && (request.method === 'GET' || request.method === 'HEAD')) {
        return handleHealth(env, request.method === 'GET');
      }
      if (request.method === 'POST' && pathname === '/v1/notify') {
        return await handleNotify(request, env);
      }
      if (request.method === 'POST' && pathname === '/v1/validate') {
        return await handleValidate(request, env);
      }
      if (request.method === 'POST' && pathname === '/v1/quota') {
        return await handleQuota(request, env);
      }
      return json(404, { status: 'error', code: 'NOT_FOUND' });
    } catch (error) {
      if (error instanceof SchemaError) {
        return json(400, { status: 'error', code: 'BAD_REQUEST', detail: error.message });
      }
      if (error instanceof PayloadTooLargeError) {
        return json(413, { status: 'error', code: 'PAYLOAD_TOO_LARGE', detail: error.message });
      }
      console.error(`unhandled error ${request.method} ${pathname}: ${error instanceof Error ? error.message : 'unknown'}`);
      return json(500, { status: 'error', code: 'INTERNAL' });
    }
  },
} satisfies ExportedHandler<Env>;
