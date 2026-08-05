import type { QuotaCounter } from './quota';

/**
 * The Workers Rate Limiting binding. Declared locally so the relay does not
 * depend on the binding being present (dev/test) or on upstream type updates.
 */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  /** Secret: full Firebase service-account JSON (never committed, set via `wrangler secret put`). */
  FCM_SERVICE_ACCOUNT: string;
  /** "0"/unset = monitor mode (count, never refuse); positive integer = enforced daily cap. */
  DAILY_LIMIT?: string;
  /** Per-token daily quota counters. */
  QUOTA: DurableObjectNamespace<QuotaCounter>;
  /** Usage-distribution collection (hashed token prefix + daily count). Optional. */
  USAGE?: AnalyticsEngineDataset;
  /** Optional cross-isolate OAuth token cache. */
  OAUTH_CACHE?: KVNamespace;
  /** Per-IP limit for /v1/notify — the one that bounds junk-token flooding. Optional (absent in tests). */
  NOTIFY_IP_LIMIT?: RateLimiter;
  /** Burst guard for /v1/notify, keyed by token hash and source. Optional (absent in tests). */
  NOTIFY_BURST?: RateLimiter;
  /** Per-IP limit for /v1/validate and /v1/quota. Optional (absent in tests). */
  LOOKUP_LIMIT?: RateLimiter;
}

/** Quota state reported on every response that touches the counter. */
export interface RateLimits {
  enforced: boolean;
  maximum: number | null;
  used: number;
  remaining: number | null;
  resetsAt: string;
}
