# Tautulli Remote Relay

A stateless push notification relay for [Tautulli Remote](https://github.com/Tautulli/Tautulli-Remote), running on Cloudflare Workers. It replaces OneSignal: a [Tautulli](https://github.com/Tautulli/Tautulli) server POSTs a notification addressed to a device's FCM token, and the relay forwards it to that device through Firebase Cloud Messaging (iOS delivery goes through FCM's APNs interface).

The official instance runs at `https://relay.tautulliremote.com`.

## Design

- **Stateless.** The relay stores no device registry, no tokens, and no notification content. The only persistent state is a per-device daily send counter (keyed by a SHA-256 hash of the token) and a cached Google OAuth token.
- **End-to-end encrypted payloads.** Tautulli encrypts notification content with AES-256-GCM using a key derived from the per-device token that only the user's Tautulli server and their device know. The relay forwards the opaque envelope untouched and cannot read it.
- **No API key.** The FCM registration token is the credential: it is unguessable, scoped to this app's Firebase project, and possessing one only lets you send notifications to that one device. This matches the model used by OneSignal previously (and by Home Assistant's push relay).
- **Fair-use limits.** A per-device daily counter runs on every accepted send. `DAILY_LIMIT=0` is monitor mode — nothing is refused while real-world usage data (hashed device prefix + daily count, via Workers Analytics Engine) establishes what a fair cap is. Setting `DAILY_LIMIT` to a positive integer enforces the cap immediately. Per-IP and per-token rate limits (Workers rate-limiting bindings) are always active.

## API

All request and response bodies are JSON.

### `POST /v1/notify`

```json
{ "token": "<FCM registration token>", "platform": "android" | "ios", "data": { ... } }
```

`data` is the opaque Tautulli notification envelope (max 3800 bytes serialized). Android devices receive it as a data-only high-priority message; iOS devices receive an alert push with `mutable-content: 1` so the app's Notification Service Extension can decrypt and rewrite it.

Requests must carry `Content-Type: application/json` and stay under 16 KB.

| Status | Meaning |
|---|---|
| `200` | Forwarded to FCM. Body includes `rateLimits: {enforced, maximum, used, remaining, resetsAt}` (`maximum`/`remaining` are `null` in monitor mode). |
| `400` | Schema violation, or FCM rejected the message as invalid (`code: "INVALID_ARGUMENT"`). |
| `410` | `code: "UNREGISTERED"` — the token can never be delivered to again: it is dead (app uninstalled, token rotated) or belongs to a different Firebase project (`SENDER_ID_MISMATCH`). The caller should stop using it and ask the user to reopen the app. |
| `413` | Request body or `data` exceeds the size cap. |
| `429` | `code: "RATE_LIMITED"` — per-IP, burst, or daily limit; retry after `Retry-After` seconds. Daily-limit responses include `rateLimits`. |
| `502` | `code: "FCM_ERROR"` — FCM refused, errored, or was unreachable, or the relay could not authenticate to it; `detail` carries the reason. **Transient — the caller should keep the token.** |

Only a `410` means "discard this token". Every other error is retryable, including a bare `404` from FCM without a `UNREGISTERED` error code (a Google-side or misconfiguration fault, not a dead token).

Quota is consumed only when FCM accepts a message: failed deliveries never burn a device's daily allowance, and an unknown token leaves no state behind.

### `POST /v1/validate`

`{ "token": "...", "platform": "android" | "ios" }` (platform optional) → FCM dry run (`validate_only`). Returns `200 {valid: true}` or `410 {valid: false}`. Used by Tautulli to mark a registered device as reachable. Can also return `400` (schema), `429` (per-IP limit), or `502` (`FCM_ERROR`) — **treat anything other than 200/410 as "unknown", not as invalid**, or a transient FCM outage will clear the flag for every device.

> Caveat: FCM documents `validate_only` as testing the request without delivering it; that dry runs currently also reject unregistered tokens, but the behavior is not contractually guaranteed. If it ever stops rejecting them this endpoint fails open (reports valid), which is safe — `/v1/notify` remains the authority on a dead token via `410`.

### `GET /v1/health`

Returns `200 {status: "ok", rateLimits: {enforced, maximum}, limitersConfigured}`. Used by the app for reachability checks and to discover the current fair-use limit state. `HEAD` is also accepted for cheap reachability probes. `limitersConfigured` is false when a deployment is missing its rate-limit bindings.

### `POST /v1/quota`

`{ "token": "..." }` → the device's current counter without incrementing it: `200 {rateLimits: {...}}`. The token travels in the POST body, never in a URL.

## Deploying

Requires a Cloudflare account (the free plan works: the quota counters are SQLite-backed Durable Objects, which — like Analytics Engine — are included on Workers Free; the $5/month paid plan lifts the 100k/day request and write caps), wrangler >= 4.36 (the `[[ratelimits]]` config key), and a Firebase project with the app configured (for iOS, the APNs auth key uploaded under Cloud Messaging settings).

```bash
npm install

# One-time, per environment: the Firebase service-account JSON
# (IAM role: Firebase Cloud Messaging API Sender).
wrangler secret put FCM_SERVICE_ACCOUNT                   # staging
wrangler secret put FCM_SERVICE_ACCOUNT --env production  # production

npm run deploy:staging     # workers.dev
npm run deploy:production  # relay.tautulliremote.com
```

Optional: create a KV namespace and uncomment the `OAUTH_CACHE` binding in `wrangler.toml` to share the Google OAuth token across isolates.

**Changing the daily limit:** edit `DAILY_LIMIT` in `wrangler.toml` (or the dashboard) and deploy. The change applies immediately — counters are compared against the limit at request time.

**Usage data:** query the `tautulli_relay_usage` Analytics Engine dataset (SQL API) for the per-device daily-count distribution. Each row is `{day, platform, hashed device prefix, count}` — no tokens, payloads, or IPs are ever recorded.

## Self-hosting

Forks of Tautulli Remote with their own Firebase project can run their own relay: deploy this Worker with your project's service account, then point your Tautulli server at it by setting `remote_app_push_url` in Tautulli's `config.ini`. Note that a relay only reaches devices of the app built against the same Firebase project — the official store app's tokens will not validate against a fork's relay.

## Development

```bash
npm run dev        # wrangler dev
npm test           # vitest (Workers pool; FCM and OAuth are mocked)
npm run typecheck
```
