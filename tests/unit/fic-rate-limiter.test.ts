import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FIC_DEFAULT_MAX_REQUESTS,
  FIC_DEFAULT_WINDOW_MS,
  FIC_DOCUMENTED_MAX_REQUESTS,
  SlidingWindowRateLimiter,
} from "@/lib/fic/rate-limiter";

import { FakeClock, flush } from "../helpers/fake-clock";

function limiter(clock: FakeClock, maxRequests?: number, windowMs?: number) {
  return new SlidingWindowRateLimiter({ maxRequests, windowMs, now: clock.now, sleep: clock.sleep });
}

/** Starts `count` acquires and records the order in which they are granted. */
function acquireMany(rl: SlidingWindowRateLimiter, key: string, count: number, granted: string[], label = key) {
  return Array.from({ length: count }, (_, i) => rl.acquire(key).then(() => granted.push(`${label}#${i}`)));
}

describe("SlidingWindowRateLimiter", () => {
  it("defaults to 280 requests every 5 minutes, a margin under the 300 reported for FiC", () => {
    const rl = new SlidingWindowRateLimiter();
    expect(FIC_DOCUMENTED_MAX_REQUESTS).toBe(300);
    expect(FIC_DEFAULT_MAX_REQUESTS).toBe(280);
    expect(FIC_DEFAULT_WINDOW_MS).toBe(300_000);
    expect(rl.maxRequests).toBe(280);
    expect(rl.windowMs).toBe(300_000);
  });

  it("lets requests under the limit through without waiting", async () => {
    const clock = new FakeClock();
    const rl = limiter(clock, 3, 1000);
    for (let i = 0; i < 3; i++) await rl.acquire("1");
    expect(clock.sleeps).toEqual([]);
  });

  it("holds the 301st request of a company that made 300 in the window until the oldest leaves it", async () => {
    const clock = new FakeClock(1_000_000);
    const rl = limiter(clock, 300, FIC_DEFAULT_WINDOW_MS);
    for (let i = 0; i < 300; i++) {
      await rl.acquire("42");
      await clock.advance(500); // 300 requests spread over 150 s
    }
    let started = false;
    const next = rl.acquire("42").then(() => (started = true));
    await flush();
    expect(started).toBe(false);
    // The oldest started at 1_000_000; now is 1_150_000: wait until 1_300_000.
    expect(clock.sleeps).toEqual([150_000]);
    await clock.advance(149_999);
    expect(started).toBe(false);
    await clock.advance(1);
    await next;
    expect(started).toBe(true);
  });

  it("applies the default limit of 280: the 281st request waits", async () => {
    const clock = new FakeClock();
    const rl = new SlidingWindowRateLimiter({ now: clock.now, sleep: clock.sleep });
    for (let i = 0; i < 280; i++) await rl.acquire("7");
    let started = false;
    void rl.acquire("7").then(() => (started = true));
    await flush();
    expect(started).toBe(false);
    expect(clock.sleeps).toEqual([300_000]);
    await clock.advance(300_000);
    expect(started).toBe(true);
  });

  it("does not slow down another company while one is at the limit", async () => {
    const clock = new FakeClock();
    const rl = limiter(clock, 2, 1000);
    const granted: string[] = [];
    acquireMany(rl, "1", 4, granted);
    await flush();
    expect(granted).toEqual(["1#0", "1#1"]);
    await rl.acquire("2");
    await rl.acquire("2");
    expect(granted).toEqual(["1#0", "1#1"]);
    expect(clock.sleeps).toEqual([1000]); // only the head waiter of company 1 sleeps
  });

  it("serves concurrent requests over the limit in arrival order, losing none", async () => {
    const clock = new FakeClock();
    const rl = limiter(clock, 3, 1000);
    const granted: string[] = [];
    const all = Promise.all(acquireMany(rl, "9", 10, granted));
    await flush();
    expect(granted).toEqual(["9#0", "9#1", "9#2"]);
    await clock.advance(1000);
    expect(granted).toHaveLength(6);
    await clock.advance(1000);
    expect(granted).toHaveLength(9);
    await clock.advance(1000);
    await all;
    expect(granted).toEqual(Array.from({ length: 10 }, (_, i) => `9#${i}`));
  });

  it("uses a sliding window, not a fixed one", async () => {
    const clock = new FakeClock();
    const rl = limiter(clock, 2, 1000);
    await rl.acquire("1"); // t=0
    await clock.advance(600);
    await rl.acquire("1"); // t=600
    await clock.advance(500); // t=1100: the first left the window, the second has not
    await rl.acquire("1");
    expect(clock.sleeps).toEqual([]);
    let started = false;
    void rl.acquire("1").then(() => (started = true));
    await flush();
    expect(started).toBe(false);
    expect(clock.sleeps).toEqual([500]); // until t=1600, when the request of t=600 leaves
    await clock.advance(500);
    expect(started).toBe(true);
  });

  it("keeps serving the queue when a sleep fails", async () => {
    const clock = new FakeClock();
    let failNext = true;
    const rl = new SlidingWindowRateLimiter({
      maxRequests: 1,
      windowMs: 1000,
      now: clock.now,
      sleep: (ms) => {
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error("sleep failed"));
        }
        return clock.sleep(ms);
      },
    });
    await rl.acquire("1");
    const failing = rl.acquire("1");
    const following = rl.acquire("1");
    await expect(failing).rejects.toThrow("sleep failed");
    let started = false;
    void following.then(() => (started = true));
    await clock.advance(1000);
    expect(started).toBe(true);
  });

  it("forgets idle companies once their requests leave the window", async () => {
    const clock = new FakeClock();
    const rl = limiter(clock, 5, 1000);
    await rl.acquire("1");
    await rl.acquire("2");
    expect(rl.trackedKeys).toBe(2);
    await clock.advance(1000);
    await rl.acquire("3");
    expect(rl.trackedKeys).toBe(1);
  });

  it("refuses invalid limits and keys", async () => {
    expect(() => new SlidingWindowRateLimiter({ maxRequests: 0 })).toThrow(RangeError);
    expect(() => new SlidingWindowRateLimiter({ maxRequests: 1.5 })).toThrow(RangeError);
    expect(() => new SlidingWindowRateLimiter({ windowMs: -1 })).toThrow(RangeError);
    expect(() => new SlidingWindowRateLimiter({ windowMs: Number.POSITIVE_INFINITY })).toThrow(RangeError);
    await expect(new SlidingWindowRateLimiter().acquire("")).rejects.toThrow(TypeError);
  });
});

describe("SlidingWindowRateLimiter default clock", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is not stalled by the wall clock moving backwards", async () => {
    const rl = new SlidingWindowRateLimiter({ maxRequests: 1, windowMs: 50 });
    await rl.acquire("1");
    // The system clock jumps back one hour (NTP, manual change).
    vi.spyOn(Date, "now").mockReturnValue(Date.now() - 3_600_000);
    const outcome = await Promise.race([
      rl.acquire("1").then(() => "granted"),
      new Promise((resolve) => setTimeout(() => resolve("stalled"), 2000)),
    ]);
    expect(outcome).toBe("granted");
  });
});
