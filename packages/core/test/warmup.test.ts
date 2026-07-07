import { describe, expect, it } from "vitest";
import {
  isWarmingUp,
  nextDaypartSlot,
  planWarmupRelease,
  rampLengthWeeks,
  warmupWeekIndex,
  weeklyCap,
} from "../src/warmup";

const LAUNCH = new Date("2026-06-01T00:00:00Z");
const DAY = 86_400_000;

describe("warmupWeekIndex", () => {
  it("is 1-based from the launch date, in 7-day buckets", () => {
    expect(warmupWeekIndex(LAUNCH, new Date(LAUNCH.getTime() + 1 * DAY))).toBe(1);
    expect(warmupWeekIndex(LAUNCH, new Date(LAUNCH.getTime() + 7 * DAY))).toBe(2);
    expect(warmupWeekIndex(LAUNCH, new Date(LAUNCH.getTime() + 14 * DAY))).toBe(3);
    expect(warmupWeekIndex(LAUNCH, new Date(LAUNCH.getTime() + 40 * DAY))).toBe(6);
  });
  it("clamps a launch date in the future to week 1", () => {
    expect(warmupWeekIndex(LAUNCH, new Date(LAUNCH.getTime() - DAY))).toBe(1);
  });
});

describe("weeklyCap + ramp shape", () => {
  it("ramps Shorts 3→4→5→5→7→7 then holds full", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map((w) => weeklyCap("shorts", w))).toEqual([
      3, 4, 5, 5, 7, 7, 7, 7,
    ]);
  });
  it("ramps long-form 1→1→2→2→3→3 then holds full", () => {
    expect([1, 2, 3, 4, 5, 6, 99].map((w) => weeklyCap("long", w))).toEqual([1, 1, 2, 2, 3, 3, 3]);
  });
  it("is warming up until the graduated week", () => {
    expect(rampLengthWeeks("shorts")).toBe(6);
    expect(isWarmingUp("shorts", 5)).toBe(true);
    expect(isWarmingUp("shorts", 6)).toBe(false); // graduated → full cadence
    expect(isWarmingUp("shorts", 12)).toBe(false);
  });
});

describe("nextDaypartSlot", () => {
  it("returns the next Shorts evening slot (Thu/Fri/Sat 18:00 UTC) strictly after", () => {
    const after = new Date("2026-06-03T12:00:00Z"); // a Wednesday
    const slot = nextDaypartSlot("shorts", after);
    expect(slot.getTime()).toBeGreaterThan(after.getTime());
    expect(slot.getUTCHours()).toBe(18);
    expect([4, 5, 6]).toContain(slot.getUTCDay());
  });
  it("returns a long-form morning slot (Sun/Mon/Tue 08:00 UTC)", () => {
    const slot = nextDaypartSlot("long", new Date("2026-06-03T12:00:00Z"));
    expect(slot.getUTCHours()).toBe(8);
    expect([0, 1, 2]).toContain(slot.getUTCDay());
  });
});

describe("planWarmupRelease", () => {
  it("schedules the next daypart slot when under this week's cap", () => {
    const now = new Date(LAUNCH.getTime() + 1 * DAY); // week 1, cap 3
    const plan = planWarmupRelease({ format: "shorts", launchedAt: LAUNCH, now, releasedThisWeek: 0 });
    expect(plan.week).toBe(1);
    expect(plan.cap).toBe(3);
    expect(plan.graduated).toBe(false);
    expect(plan.deferred).toBe(false);
    expect(plan.scheduledFor.getTime()).toBeGreaterThan(now.getTime());
    expect(plan.scheduledFor.getUTCHours()).toBe(18);
  });

  it("defers into next week's bucket once the weekly cap is hit", () => {
    const now = new Date(LAUNCH.getTime() + 1 * DAY); // week 1, cap 3
    const plan = planWarmupRelease({ format: "shorts", launchedAt: LAUNCH, now, releasedThisWeek: 3 });
    expect(plan.deferred).toBe(true);
    // week-2 bucket starts at LAUNCH + 7d
    expect(plan.scheduledFor.getTime()).toBeGreaterThanOrEqual(LAUNCH.getTime() + 7 * DAY);
    expect([4, 5, 6]).toContain(plan.scheduledFor.getUTCDay());
  });

  it("marks a graduated channel and never defers it", () => {
    const now = new Date(LAUNCH.getTime() + 50 * DAY); // week 8 → graduated
    const plan = planWarmupRelease({ format: "shorts", launchedAt: LAUNCH, now, releasedThisWeek: 99 });
    expect(plan.graduated).toBe(true);
    expect(plan.deferred).toBe(false);
    expect(plan.scheduledFor.getUTCHours()).toBe(18);
  });
});
