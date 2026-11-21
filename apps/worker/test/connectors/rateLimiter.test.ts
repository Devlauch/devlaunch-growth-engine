import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SlidingWindowRateLimiter } from "../../src/connectors/rateLimiter.js";

describe("SlidingWindowRateLimiter", () => {
  it("allows calls up to the limit without waiting", async () => {
    const limiter = new SlidingWindowRateLimiter(3, 60_000);
    let now = 1_000_000;
    const clock = () => now;

    await limiter.acquire(clock);
    await limiter.acquire(clock);
    await limiter.acquire(clock);

    expect(limiter.currentCount).toBe(3);
  });

  it("rejects a non-positive rate limit", () => {
    expect(() => new SlidingWindowRateLimiter(0)).toThrow();
    expect(() => new SlidingWindowRateLimiter(-5)).toThrow();
  });

  it("currentCount only counts calls within the active window", async () => {
    const limiter = new SlidingWindowRateLimiter(5, 1000);
    let now = 0;
    const clock = () => now;

    await limiter.acquire(clock);
    now = 2000; // window has fully elapsed
    expect(limiter.currentCount).toBe(0);
  });

  describe("throttling behavior (fake timers)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("blocks a call beyond the limit until the window rolls over, then lets it through", async () => {
      const limiter = new SlidingWindowRateLimiter(2, 1000);

      // Fill the window using the real wall clock (Date.now, driven by fake timers).
      await limiter.acquire();
      await limiter.acquire();
      expect(limiter.currentCount).toBe(2);

      let thirdResolved = false;
      const third = limiter.acquire().then(() => {
        thirdResolved = true;
      });

      // Not enough time has passed yet — the third call must still be pending.
      await vi.advanceTimersByTimeAsync(100);
      expect(thirdResolved).toBe(false);

      // Advance past the 1000ms window so the oldest call ages out.
      await vi.advanceTimersByTimeAsync(1000);
      await third;
      expect(thirdResolved).toBe(true);
    });

    it("self-throttles a burst of calls to the configured rate", async () => {
      const limiter = new SlidingWindowRateLimiter(1, 1000);

      await limiter.acquire();
      let secondResolved = false;
      const second = limiter.acquire().then(() => {
        secondResolved = true;
      });

      await vi.advanceTimersByTimeAsync(500);
      expect(secondResolved).toBe(false);

      await vi.advanceTimersByTimeAsync(600);
      await second;
      expect(secondResolved).toBe(true);
    });
  });
});
