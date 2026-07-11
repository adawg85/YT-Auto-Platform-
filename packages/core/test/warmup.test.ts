import { describe, expect, it } from "vitest";
import {
  isWarmingUp,
  nextDaypartSlot,
  planWarmupRelease,
  projectTentativeSlots,
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

/** slot count per ramp week, for week-by-week cadence assertions */
function countByWeek(launchedAt: Date, slots: Date[]): Map<number, number> {
  const perWeek = new Map<number, number>();
  for (const s of slots) {
    const w = warmupWeekIndex(launchedAt, s);
    perWeek.set(w, (perWeek.get(w) ?? 0) + 1);
  }
  return perWeek;
}

describe("projectTentativeSlots (BACKLOG #23.1)", () => {
  it("returns count strictly-increasing future daypart-hour slots, none earlier than tomorrow", () => {
    const now = new Date(LAUNCH.getTime() + 1 * DAY);
    const slots = projectTentativeSlots({ format: "shorts", launchedAt: LAUNCH, now, count: 12 });
    expect(slots).toHaveLength(12);
    const tomorrow = new Date("2026-06-03T00:00:00Z");
    for (let i = 0; i < slots.length; i++) {
      expect(slots[i]!.getTime()).toBeGreaterThan((slots[i - 1] ?? now).getTime());
      expect(slots[i]!.getUTCHours()).toBe(18);
      expect(slots[i]!.getTime()).toBeGreaterThanOrEqual(tomorrow.getTime());
    }
  });

  it("respects the built-in warm-up ramp's weekly caps when the channel has no release plan", () => {
    const now = new Date(LAUNCH.getTime()); // week 1 of the Shorts ramp (cap 3)
    const slots = projectTentativeSlots({ format: "shorts", launchedAt: LAUNCH, now, count: 10 });
    for (const [w, n] of countByWeek(LAUNCH, slots)) {
      expect(n).toBeLessThanOrEqual(weeklyCap("shorts", w));
    }
  });

  it("counts already-released uploads against the current week's cap", () => {
    const now = new Date(LAUNCH.getTime() + 1 * DAY); // week 1, cap 3
    const [first] = projectTentativeSlots({
      format: "shorts",
      launchedAt: LAUNCH,
      now,
      count: 1,
      releasedThisWeek: 3, // week 1 is full → first slot must land in week 2+
    });
    expect(warmupWeekIndex(LAUNCH, first!)).toBeGreaterThanOrEqual(2);
  });

  it("holds steady cadencePerWeek once graduated", () => {
    const now = new Date(LAUNCH.getTime() + 60 * DAY); // graduated
    const slots = projectTentativeSlots({
      format: "long",
      launchedAt: LAUNCH,
      now,
      count: 6,
      cadencePerWeek: 1,
    });
    expect(slots).toHaveLength(6);
    const weeks = slots.map((s) => warmupWeekIndex(LAUNCH, s));
    expect(new Set(weeks).size).toBe(6); // 1/week → 6 distinct week buckets
  });

  // 2026-07-11 incident: a long-form plan implying ~3/wk projected ~1/wk
  // because the built-in conservative RAMP (long weeks 1–2 = 1/wk) was applied
  // over the channel's own release plan.
  it("follows the channel's release plan: warmupWeeks 2 / warmupVideos 4 / monthlySteady 13 → 2,2,3,3,3 per week", () => {
    const slots = projectTentativeSlots({
      format: "long",
      launchedAt: LAUNCH,
      now: LAUNCH,
      count: 13,
      cadencePerWeek: 3,
      releasePlan: { warmupWeeks: 2, warmupVideos: 4, monthlySteady: 13 },
    });
    expect(slots).toHaveLength(13);
    const perWeek = countByWeek(LAUNCH, slots);
    expect(perWeek.get(1)).toBe(2); // warm-up: 4 videos over 2 weeks
    expect(perWeek.get(2)).toBe(2);
    expect(perWeek.get(3)).toBe(3); // steady: 13/mo ≈ 3/wk
    expect(perWeek.get(4)).toBe(3);
    expect(perWeek.get(5)).toBe(3);
    // never below the plan's own weekly target once ramped
    for (const [w, n] of perWeek) if (w >= 3) expect(n).toBe(3);
  });

  it("spreads 3/wk across the week (~Mon/Wed/Fri, one per day max) at the daypart hour", () => {
    const slots = projectTentativeSlots({
      format: "long",
      launchedAt: LAUNCH, // 2026-06-01 is a Monday
      now: LAUNCH,
      count: 13,
      cadencePerWeek: 3,
      releasePlan: { warmupWeeks: 2, warmupVideos: 4, monthlySteady: 13 },
    });
    // one per day max
    const dayKeys = slots.map((s) => s.toISOString().slice(0, 10));
    expect(new Set(dayKeys).size).toBe(slots.length);
    for (const s of slots) expect(s.getUTCHours()).toBe(8);
    // steady week 3 lands Mon/Wed/Fri (bucket anchored on the Monday launch)
    const week3 = slots.filter((s) => warmupWeekIndex(LAUNCH, s) === 3);
    expect(week3.map((s) => s.getUTCDay())).toEqual([1, 3, 5]);
  });

  it("derives the steady cadence from monthlySteady when cadencePerWeek is absent", () => {
    const now = new Date(LAUNCH.getTime() + 63 * DAY); // week-10 bucket start, past any warm-up
    const slots = projectTentativeSlots({
      format: "long",
      launchedAt: LAUNCH,
      now,
      count: 6,
      releasePlan: { warmupWeeks: 2, warmupVideos: 4, monthlySteady: 13 }, // 13/4.3 ≈ 3
    });
    for (const [, n] of countByWeek(LAUNCH, slots)) expect(n).toBeLessThanOrEqual(3);
    expect(slots).toHaveLength(6);
    expect(new Set(slots.map((s) => warmupWeekIndex(LAUNCH, s))).size).toBe(2); // 3+3 over 2 weeks
  });

  it("excludes nothing below the ramp target: a mid-week start still fills the remaining days", () => {
    // now = Thursday of week 1 (launch Monday): 3 remaining day slots exist
    const now = new Date(LAUNCH.getTime() + 3 * DAY);
    const slots = projectTentativeSlots({
      format: "long",
      launchedAt: LAUNCH,
      now,
      count: 3,
      cadencePerWeek: 3,
      releasePlan: { warmupWeeks: 0, warmupVideos: 0, monthlySteady: 13 },
    });
    const perWeek = countByWeek(LAUNCH, slots);
    expect(perWeek.get(1)).toBe(3); // Fri/Sat/Sun of week 1 — not deferred wholesale
  });

  it("returns an empty array for count <= 0", () => {
    expect(projectTentativeSlots({ format: "shorts", launchedAt: LAUNCH, now: LAUNCH, count: 0 })).toEqual([]);
  });
});
