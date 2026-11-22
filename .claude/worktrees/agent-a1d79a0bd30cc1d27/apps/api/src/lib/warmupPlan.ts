/**
 * Real, pure math for roadmap item 14 ("Sending setup per tenant"):
 * warm-up ramp limits that start small and increase slowly, plus
 * bounce/complaint-rate based pause logic. No real sending exists yet
 * (see integrations.ts / campaigns.ts's "sending integration not yet
 * connected"), so nothing here actually throttles a live send pipeline —
 * but the numbers it computes are genuinely correct and ready for when
 * one exists.
 */

export interface WarmupConfigInput {
  dailyLimit: number;
  targetDailyLimit: number;
  rampIncrement: number;
  rampIntervalDays: number;
  /** ISO string or Date — when warm-up started. */
  startedAt: string | Date;
}

/**
 * Computes today's warm-up daily sending limit: the configured starting
 * `dailyLimit`, increased by `rampIncrement` for every full
 * `rampIntervalDays` period that has elapsed since `startedAt`, capped at
 * `targetDailyLimit`.
 *
 * Partial elapsed intervals don't count — the ramp only steps up once a
 * full interval has passed, never early.
 */
export function currentWarmupLimit(config: WarmupConfigInput, now: Date = new Date()): number {
  const startedAt = typeof config.startedAt === "string" ? new Date(config.startedAt) : config.startedAt;

  const elapsedMs = now.getTime() - startedAt.getTime();
  const elapsedDays = elapsedMs <= 0 ? 0 : elapsedMs / (1000 * 60 * 60 * 24);
  const elapsedIntervals = Math.floor(elapsedDays / config.rampIntervalDays);

  const rampedLimit = config.dailyLimit + elapsedIntervals * config.rampIncrement;
  return Math.min(config.targetDailyLimit, rampedLimit);
}

export interface SendHealthStatsInput {
  sentCount: number;
  bouncedCount: number;
  complainedCount: number;
}

export interface PauseThresholds {
  /** Fraction (0-1), default 0.05 (5%). */
  maxBounceRate?: number;
  /** Fraction (0-1), default 0.001 (0.1%). */
  maxComplaintRate?: number;
}

export interface PauseDecision {
  pause: boolean;
  reason?: string;
}

const DEFAULT_MAX_BOUNCE_RATE = 0.05;
const DEFAULT_MAX_COMPLAINT_RATE = 0.001;

/**
 * Decides whether sending should pause based on a day's bounce/complaint
 * rates. Rates are only evaluated when `sentCount > 0` — on a day with
 * zero sends there is no rate to speak of, and dividing by zero (or
 * treating 0/0 as "100% bounced") would falsely trigger a pause on an
 * idle day, which is exactly the kind of false positive this guard exists
 * to avoid.
 */
export function shouldPauseForHealth(
  stats: SendHealthStatsInput,
  thresholds: PauseThresholds = {},
): PauseDecision {
  const { sentCount, bouncedCount, complainedCount } = stats;

  if (sentCount <= 0) {
    return { pause: false };
  }

  const maxBounceRate = thresholds.maxBounceRate ?? DEFAULT_MAX_BOUNCE_RATE;
  const maxComplaintRate = thresholds.maxComplaintRate ?? DEFAULT_MAX_COMPLAINT_RATE;

  const bounceRate = bouncedCount / sentCount;
  const complaintRate = complainedCount / sentCount;

  if (bounceRate > maxBounceRate) {
    return {
      pause: true,
      reason: `Bounce rate ${(bounceRate * 100).toFixed(2)}% exceeds threshold ${(maxBounceRate * 100).toFixed(2)}% (${bouncedCount}/${sentCount} sent)`,
    };
  }

  if (complaintRate > maxComplaintRate) {
    return {
      pause: true,
      reason: `Complaint rate ${(complaintRate * 100).toFixed(3)}% exceeds threshold ${(maxComplaintRate * 100).toFixed(3)}% (${complainedCount}/${sentCount} sent)`,
    };
  }

  return { pause: false };
}
