/**
 * Simple in-process sliding-window rate limiter.
 *
 * Connectors use this to self-throttle to their configured
 * `rateLimitPerMinute` so a real outbound call (HTTP fetch to a directory,
 * a licensed API, a crawl target, ...) never hammers an external service
 * faster than its terms allow. This is intentionally simple (no Redis, no
 * cross-process coordination) — it bounds concurrency *within a single
 * worker process* for a single connector instance. If multiple worker
 * processes run the same connector concurrently, coordinate the
 * per-tenant ceiling at a higher layer (e.g. BullMQ rate limiting) in
 * addition to this.
 */
export class SlidingWindowRateLimiter {
  private readonly windowMs: number;
  private readonly maxPerWindow: number;
  private timestamps: number[] = [];
  // Tracks whichever clock function was last passed to acquire(), so
  // currentCount (used mainly by tests with a fake clock) stays consistent
  // with the same notion of "now" acquire() itself is using, instead of
  // always falling back to the real wall clock.
  private lastClock: () => number = Date.now;

  constructor(maxPerMinute: number, windowMs = 60_000) {
    if (!Number.isFinite(maxPerMinute) || maxPerMinute <= 0) {
      throw new Error(`rateLimitPerMinute must be a positive number, got ${maxPerMinute}`);
    }
    this.maxPerWindow = maxPerMinute;
    this.windowMs = windowMs;
  }

  /** Number of calls currently counted within the active window. */
  get currentCount(): number {
    const cutoff = this.lastClock() - this.windowMs;
    this.timestamps = this.timestamps.filter((t) => t > cutoff);
    return this.timestamps.length;
  }

  /** Resolves immediately if under the limit; otherwise waits until the
   * oldest call in the current window ages out, then records this call. */
  async acquire(now: () => number = Date.now): Promise<void> {
    this.lastClock = now;
    for (;;) {
      const cutoff = now() - this.windowMs;
      this.timestamps = this.timestamps.filter((t) => t > cutoff);

      if (this.timestamps.length < this.maxPerWindow) {
        this.timestamps.push(now());
        return;
      }

      const oldest = this.timestamps[0];
      const waitMs = Math.max(0, oldest + this.windowMs - now());
      await sleep(waitMs > 0 ? waitMs : 1);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
