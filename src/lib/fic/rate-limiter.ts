/**
 * Per-company request limiter for the Fatture in Cloud API (in memory, per process).
 *
 * FiC allows about 300 requests every 5 minutes per company (third-party source, not
 * official documentation). This limiter is a prudential guard with a margin: by default
 * 280 requests in any sliding window of 5 minutes. FiC's own 429 stays the source of
 * truth (the client honours `Retry-After`). A limit shared between several instances
 * (Redis) is out of scope until there is more than one instance.
 */

/** Limit reported for FiC: 300 requests every 5 minutes per company. */
export const FIC_DOCUMENTED_MAX_REQUESTS = 300;
/** Default limit actually applied: the documented one minus a safety margin. */
export const FIC_DEFAULT_MAX_REQUESTS = 280;
/** Default window: 5 minutes. */
export const FIC_DEFAULT_WINDOW_MS = 5 * 60 * 1000;

export type Sleep = (ms: number) => Promise<void>;
export type Clock = () => number;

/** Monotonic milliseconds (never go backwards), unlike `Date.now`. */
export const monotonicNow: Clock = () => performance.now();

export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface RateLimiterOptions {
  /** Max requests per key in any window. Default {@link FIC_DEFAULT_MAX_REQUESTS}. */
  maxRequests?: number;
  /** Window length in milliseconds. Default {@link FIC_DEFAULT_WINDOW_MS}. */
  windowMs?: number;
  /**
   * Current time in ms (injectable for tests). Default {@link monotonicNow}: a wall clock
   * moved backwards (NTP, manual change) must not stall a company for the jump.
   */
  now?: Clock;
  /** Waits the given ms (injectable for tests). Default `setTimeout`. */
  sleep?: Sleep;
}

interface Bucket {
  /** Start instants of the requests in the current window, oldest first. */
  timestamps: number[];
  /** End of the FIFO queue: every `acquire` waits for the previous one of the same key. */
  tail: Promise<void>;
  /** Callers queued or waiting on this key. */
  pending: number;
}

/**
 * Sliding window log: a request may start when fewer than `maxRequests` requests of the
 * same key started in the last `windowMs`. Waiters of a key are served in arrival order
 * (FIFO promise chain), so no request is lost or overtaken; other keys never wait.
 */
export class SlidingWindowRateLimiter {
  readonly maxRequests: number;
  readonly windowMs: number;
  private readonly now: Clock;
  private readonly sleep: Sleep;
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep: number;

  constructor(options: RateLimiterOptions = {}) {
    const maxRequests = options.maxRequests ?? FIC_DEFAULT_MAX_REQUESTS;
    const windowMs = options.windowMs ?? FIC_DEFAULT_WINDOW_MS;
    if (!Number.isSafeInteger(maxRequests) || maxRequests < 1) {
      throw new RangeError("maxRequests must be a positive integer");
    }
    if (!Number.isSafeInteger(windowMs) || windowMs < 1) {
      throw new RangeError("windowMs must be a positive integer of milliseconds");
    }
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.now = options.now ?? monotonicNow;
    this.sleep = options.sleep ?? realSleep;
    this.lastSweep = this.now();
  }

  /** Resolves when a request for `key` may start (and counts it in the window). */
  acquire(key: string): Promise<void> {
    if (typeof key !== "string" || key === "") {
      return Promise.reject(new TypeError("rate limiter key must be a non-empty string"));
    }
    this.sweepIdleBuckets();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { timestamps: [], tail: Promise.resolve(), pending: 0 };
      this.buckets.set(key, bucket);
    }
    const current = bucket;
    current.pending++;
    const turn = current.tail.then(() => this.waitForSlot(current));
    // A failed turn (e.g. sleep rejected) must not block the callers queued after it.
    current.tail = turn.catch(() => undefined);
    return turn.finally(() => {
      current.pending--;
    });
  }

  /** Number of keys currently tracked (for tests and diagnostics). */
  get trackedKeys(): number {
    return this.buckets.size;
  }

  private async waitForSlot(bucket: Bucket): Promise<void> {
    for (;;) {
      const now = this.now();
      this.prune(bucket, now);
      if (bucket.timestamps.length < this.maxRequests) {
        bucket.timestamps.push(now);
        return;
      }
      // After prune the oldest started less than windowMs ago: the wait is > 0.
      await this.sleep(bucket.timestamps[0] + this.windowMs - now);
    }
  }

  private prune(bucket: Bucket, now: number): void {
    let expired = 0;
    while (expired < bucket.timestamps.length && bucket.timestamps[expired] + this.windowMs <= now) expired++;
    if (expired > 0) bucket.timestamps.splice(0, expired);
  }

  /** At most once per window, forgets keys with no waiter and no request in the window. */
  private sweepIdleBuckets(): void {
    const now = this.now();
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    for (const [key, bucket] of this.buckets) {
      if (bucket.pending > 0) continue;
      this.prune(bucket, now);
      if (bucket.timestamps.length === 0) this.buckets.delete(key);
    }
  }
}
