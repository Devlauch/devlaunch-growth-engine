import type { Request, Response, NextFunction } from "express";
import { Errors } from "../lib/httpError.js";

interface Bucket {
  count: number;
  windowStartMs: number;
}

/**
 * Minimal in-process fixed-window rate limiter. Good enough for Phase 1 /
 * a single worker process; a multi-instance deployment should swap the
 * `buckets` Map below for a Redis INCR+EXPIRE implementation (the API
 * already depends on ioredis via REDIS_URL, so that's a drop-in later
 * change) without touching call sites.
 */
export function createFixedWindowLimiter(opts: { windowMs: number; max: number }) {
  const buckets = new Map<string, Bucket>();

  return function check(key: string): boolean {
    const now = Date.now();
    const existing = buckets.get(key);
    if (!existing || now - existing.windowStartMs >= opts.windowMs) {
      buckets.set(key, { count: 1, windowStartMs: now });
      return true;
    }
    existing.count += 1;
    return existing.count <= opts.max;
  };
}

/**
 * Express middleware factory: rejects with 429 once `keyFn(req)` has been
 * seen more than `max` times within `windowMs`. Used on the public
 * lead-capture endpoint, keyed once by client IP and once by project
 * public key (see src/routes/publicLeads.ts), so a single abusive IP can't
 * hide behind many keys and a single leaked key can't be hammered from
 * many IPs.
 */
export function rateLimitMiddleware(opts: { windowMs: number; max: number; keyFn: (req: Request) => string; name: string }) {
  const check = createFixedWindowLimiter({ windowMs: opts.windowMs, max: opts.max });
  return (req: Request, _res: Response, next: NextFunction) => {
    const key = `${opts.name}:${opts.keyFn(req)}`;
    if (!check(key)) {
      next(Errors.tooManyRequests(`Rate limit exceeded (${opts.name})`));
      return;
    }
    next();
  };
}
