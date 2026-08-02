# Tautulli Remote Relay

A push notification relay for [Tautulli Remote](https://github.com/Tautulli/Tautulli-Remote) running on Cloudflare Workers. A [Tautulli](https://github.com/Tautulli/Tautulli) server posts a notification addressed to a device's FCM token and the relay forwards it through Firebase Cloud Messaging. iOS delivery goes through FCM's APNs interface.

The official instance runs at `https://relay.tautulliremote.com`.

## How it works

- The relay stores no device registry, no tokens, and no notification content. The only persistent state is a per-device daily send counter, keyed by a SHA-256 hash of the token.
- Notification content is encrypted by the user's Tautulli server with a key that only it and the device know. The relay forwards the envelope without being able to read it.
- There is no API key. The FCM token is the credential: it is unguessable, scoped to this app's Firebase project, and only lets you send notifications to that one device.
- Each accepted send counts against a per-device daily limit. The relay currently runs in monitor mode (`DAILY_LIMIT=0`) and refuses nothing while usage data establishes a fair cap. Per-IP and per-token rate limits are always active.

## API

All request and response bodies are JSON. Requests must have `Content-Type: application/json` and stay under 16 KB.

### `POST /v1/notify`

```json
{ "token": "<FCM registration token>", "platform": "android", "data": { } }
```

`platform` is `android` or `ios`. `data` is the Tautulli notification envelope, max 3800 bytes serialized. Android receives it as a data-only high priority message. iOS receives an alert push with `mutable-content: 1` so the app's Notification Service Extension can decrypt and rewrite it.

| Status | Meaning |
|---|---|
| `200` | Forwarded to FCM. Body includes `rateLimits: {enforced, maximum, used, remaining, resetsAt}`. `maximum` and `remaining` are `null` in monitor mode. |
| `400` | Schema violation, or FCM rejected the message as invalid (`code: "INVALID_ARGUMENT"`). |
| `410` | `code: "UNREGISTERED"`. The token is dead (app uninstalled, token rotated) or belongs to a different Firebase project. Stop using it. |
| `413` | Request body or `data` over the size cap. |
| `429` | `code: "RATE_LIMITED"`. Per-IP, burst, or daily limit. Retry after `Retry-After` seconds. |
| `502` | `code: "FCM_ERROR"`. FCM errored or was unreachable. Transient, keep the token. |

Only a `410` means the token should be discarded. Every other error is retryable, including a bare `404` from FCM without an `UNREGISTERED` code.

Quota is only consumed when FCM accepts a message. Failed deliveries never count against a device, and an unknown token leaves no state behind.

### `POST /v1/validate`

`{ "token": "...", "platform": "..." }` with `platform` optional. Runs an FCM dry run and returns `200 {valid: true}` or `410 {valid: false}`. Tautulli uses this to mark a registered device as reachable. Treat any other status (`400`, `429`, `502`) as unknown rather than invalid, otherwise a transient FCM outage clears the flag for every device.

FCM does not contractually guarantee that dry runs reject unregistered tokens. If that behavior ever changes this endpoint fails open and reports valid, which is safe: `/v1/notify` remains the authority on a dead token via `410`.

### `GET /v1/health`

Returns `200 {status: "ok", rateLimits: {enforced, maximum}, limitersConfigured}`. Used by the app for reachability checks and to read the current fair use limit. `HEAD` is also accepted. `limitersConfigured` is `false` when a deployment is missing its rate limit bindings.

### `POST /v1/quota`

`{ "token": "..." }` returns the device's current counter without incrementing it: `200 {rateLimits: {...}}`. The token travels in the POST body, never in a URL.

## Deploying

Requires:

- A Cloudflare account. The free plan works; the paid plan lifts the daily request caps.
- wrangler >= 4.36
- A Firebase project with the app configured. For iOS the APNs auth key must be uploaded under Cloud Messaging settings.

```bash
npm install

# One-time, per environment: the Firebase service-account JSON
# (IAM role: Firebase Cloud Messaging API Sender).
wrangler secret put FCM_SERVICE_ACCOUNT                   # staging
wrangler secret put FCM_SERVICE_ACCOUNT --env production  # production

npm run deploy:staging     # workers.dev
npm run deploy:production  # relay.tautulliremote.com
```

To change the daily limit, edit `DAILY_LIMIT` in `wrangler.toml` and deploy. The change applies immediately.

Usage data is written to the `tautulli_relay_usage` Analytics Engine dataset. Each row is a day, platform, hashed device prefix, and count. No tokens, payloads, or IPs are recorded.

## Self-hosting

Forks of Tautulli Remote with their own Firebase project can run their own relay. Deploy this Worker with your project's service account, then point your Tautulli server at it by setting `remote_app_push_url` in Tautulli's `config.ini`. A relay only reaches devices of the app built against the same Firebase project, so the official store app's tokens will not work with a fork's relay.

## Development

```bash
npm run dev        # wrangler dev
npm test           # vitest (FCM and OAuth are mocked)
npm run typecheck
```

## License

[![License](https://img.shields.io/github/license/Tautulli/Tautulli-Remote-Relay?style=flat-square)](https://github.com/Tautulli/Tautulli-Remote-Relay/blob/main/LICENSE)

This is free software under the GPL v3 open source license. Feel free to do with it what you wish,
but any modification must be open sourced. A copy of the license is included.
