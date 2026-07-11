/**
 * Channel warm-up scheduling (backlog build #3). New channels get throttled if
 * they post like an established one, so a new channel ramps posting cadence over
 * ~6 weeks before running at full volume. Shorts and long-form warm up
 * differently and on different dayparts, so the policy is per-format.
 *
 * Pure + deterministic (all times UTC, `now` injected) so it's unit-tested and
 * behaves identically under mock and real providers. The publishing rail calls
 * planWarmupRelease() to pick a release time; the cockpit calls the same
 * functions to show the ramp.
 *
 * v1 is Shorts-only, so the Shorts ramp is what actually runs today; the
 * long-form ramp is encoded and ships live when the long-form capability lands.
 */

export type WarmupFormat = "shorts" | "long";

const WEEK_MS = 7 * 86_400_000;

/**
 * Uploads-per-week cap by ramp week (1-based). The last entry is the graduated
 * full cadence and applies to every week at or beyond ramp length.
 *   Shorts:    ~3/wk → 4 → 5 → 5 → 7 → 7 (full, up to ~1/day)
 *   Long-form: ~1/wk → 1 → 2 → 2 → 3 → 3 (full)
 */
const RAMP: Record<WarmupFormat, number[]> = {
  shorts: [3, 4, 5, 5, 7, 7],
  long: [1, 1, 2, 2, 3, 3],
};

/** Preferred publishing daypart per format (spec §3): window + best weekdays. */
const DAYPART: Record<WarmupFormat, { hour: number; days: number[] }> = {
  // evenings ~6–9pm; Thu/Fri/Sat (getUTCDay: Thu=4, Fri=5, Sat=6)
  shorts: { hour: 18, days: [4, 5, 6] },
  // mornings ~8–11am; Sun/Mon/Tue (Sun=0, Mon=1, Tue=2)
  long: { hour: 8, days: [0, 1, 2] },
};

/** How many ramp weeks before a channel is "graduated" to full cadence. */
export function rampLengthWeeks(format: WarmupFormat): number {
  return RAMP[format].length;
}

/** 1-based ramp week for a channel launched at `launchedAt`, as of `now`. */
export function warmupWeekIndex(launchedAt: Date, now: Date): number {
  const elapsed = now.getTime() - launchedAt.getTime();
  if (elapsed < 0) return 1;
  return Math.floor(elapsed / WEEK_MS) + 1;
}

/** Uploads-per-week cap for a format at a given (1-based) ramp week. */
export function weeklyCap(format: WarmupFormat, week: number): number {
  const ramp = RAMP[format];
  if (week < 1) return ramp[0]!;
  return ramp[Math.min(week, ramp.length) - 1]!;
}

/** True while the channel is still ramping (before full cadence). */
export function isWarmingUp(format: WarmupFormat, week: number): boolean {
  return week < rampLengthWeeks(format);
}

/** Start of the (1-based) ramp-week bucket for a channel. */
export function weekBucketStart(launchedAt: Date, week: number): Date {
  return new Date(launchedAt.getTime() + (week - 1) * WEEK_MS);
}

/**
 * The next preferred-daypart slot strictly after `after`: the first upcoming
 * day in the format's preferred weekdays, at the window's start hour (UTC).
 */
export function nextDaypartSlot(format: WarmupFormat, after: Date): Date {
  const { hour, days } = DAYPART[format];
  for (let i = 0; i <= 21; i++) {
    const d = new Date(after);
    d.setUTCDate(d.getUTCDate() + i);
    d.setUTCHours(hour, 0, 0, 0);
    if (days.includes(d.getUTCDay()) && d.getTime() > after.getTime()) return d;
  }
  // fallback (unreachable in practice): next day at the window hour
  const f = new Date(after.getTime() + 86_400_000);
  f.setUTCHours(hour, 0, 0, 0);
  return f;
}

export type WarmupPlan = {
  /** when to release this upload */
  scheduledFor: Date;
  /** the ramp week the release lands in */
  week: number;
  /** the weekly cap that applied */
  cap: number;
  /** true if the channel has graduated to full cadence */
  graduated: boolean;
  /** true if this release was deferred to next week because the cap was hit */
  deferred: boolean;
};

/**
 * Decide when the next upload should be released for a warming-up channel.
 * If this ramp-week's cap is already met, the release is deferred to the next
 * week's first daypart slot; otherwise it takes the next daypart slot from now.
 * A graduated channel still gets the next daypart slot (steady full cadence),
 * never deferred.
 */
export function planWarmupRelease(input: {
  format: WarmupFormat;
  launchedAt: Date;
  now: Date;
  /** uploads already released (published or scheduled) in the current week bucket */
  releasedThisWeek: number;
}): WarmupPlan {
  const { format, launchedAt, now, releasedThisWeek } = input;
  const week = warmupWeekIndex(launchedAt, now);
  const cap = weeklyCap(format, week);
  const graduated = !isWarmingUp(format, week);

  // Only a still-ramping channel defers on the weekly cap; a graduated channel
  // posts at full cadence (next daypart slot, never deferred).
  if (!graduated && releasedThisWeek >= cap) {
    const nextBucket = weekBucketStart(launchedAt, week + 1);
    const after = nextBucket.getTime() > now.getTime() ? nextBucket : now;
    return { scheduledFor: nextDaypartSlot(format, after), week, cap, graduated, deferred: true };
  }
  return { scheduledFor: nextDaypartSlot(format, now), week, cap, graduated, deferred: false };
}

/** The slice of the operator ReleasePlan (BACKLOG #17) that slot projection needs. */
export type SlotReleasePlan = {
  warmupWeeks?: number;
  warmupVideos?: number;
  monthlySteady?: number;
};

/**
 * Evenly-spread publish times for one week bucket: `k` slots across the days
 * of [windowStart, windowEnd) at the format's daypart hour — 3/wk lands
 * ~Mon/Wed/Fri, 2/wk ~Mon/Thu, one per day max unless k exceeds the number of
 * available days (cadence > 7), in which case extra slots stack onto the same
 * days at later hours. Days already past (windowStart mid-week) are skipped.
 */
function spreadWeekSlots(
  format: WarmupFormat,
  windowStart: Date,
  windowEnd: Date,
  k: number,
  /** true when the WEEKLY cadence itself exceeds one-per-day (cadence > 7):
   * extras stack onto the same days at later hours. False (cadence ≤ 7) means
   * a partially-elapsed week clamps to its remaining days instead — never two
   * uploads on one day just because the week started mid-way. */
  stackBeyondDays: boolean,
): Date[] {
  if (k <= 0) return [];
  const hour = DAYPART[format].hour;
  // every remaining day boundary in the window, at the daypart hour
  const days: Date[] = [];
  const d = new Date(windowStart);
  d.setUTCHours(hour, 0, 0, 0);
  if (d.getTime() < windowStart.getTime()) d.setUTCDate(d.getUTCDate() + 1);
  while (d.getTime() < windowEnd.getTime()) {
    days.push(new Date(d));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  if (days.length === 0) return [];
  if (!stackBeyondDays) k = Math.min(k, days.length);
  if (k <= days.length) {
    // spread k slots evenly over the available days (0, 2, 4 for 3-of-7 …)
    return Array.from({ length: k }, (_, i) => new Date(days[Math.floor((i * days.length) / k)]!));
  }
  // cadence > one-per-day: fill every day first, extras stack at +4h passes
  const out: Date[] = [];
  for (let i = 0; i < k; i++) {
    const base = days[i % days.length]!;
    const pass = Math.floor(i / days.length);
    out.push(new Date(base.getTime() + Math.min(pass * 4, 23 - hour) * 3_600_000));
  }
  return out.sort((a, b) => a.getTime() - b.getTime());
}

/**
 * Project tentative publish slots for a whole approved series (BACKLOG #23.1):
 * `count` future slots starting no earlier than TOMORROW, at the channel's
 * own release cadence.
 *
 * Weekly targets (2026-07-11 incident fix): the channel's operator
 * ReleasePlan, when present, IS the ramp — `warmupVideos / warmupWeeks` per
 * week while warming up, then the steady cadence (`cadencePerWeek`, falling
 * back to `monthlySteady / 4.3`). The old code always applied the built-in
 * conservative RAMP (long-form week 1–2 = 1/wk), so a plan implying ~3/wk
 * projected ~1/wk and stretched a series months out. The built-in RAMP now
 * only applies when the channel has NO release plan.
 *
 * Slots within a week are spread evenly across the whole week (3/wk →
 * ~Mon/Wed/Fri at the format's daypart hour), one per day max unless the
 * cadence exceeds 7/wk. Pure + deterministic.
 */
export function projectTentativeSlots(input: {
  format: WarmupFormat;
  launchedAt: Date;
  now: Date;
  count: number;
  /** uploads already released (published or scheduled) in the current ramp-week bucket */
  releasedThisWeek?: number;
  /** steady uploads/week once graduated (channel DNA cadence); defaults to the ramp's full cadence */
  cadencePerWeek?: number;
  /** the channel's operator release plan — when present its warm-up ramp
   * REPLACES the built-in conservative RAMP (that was the ~1/wk bug) */
  releasePlan?: SlotReleasePlan | null;
}): Date[] {
  const { format, launchedAt, now, count } = input;
  const slots: Date[] = [];
  if (count <= 0) return slots;
  const plan = input.releasePlan ?? null;

  const steady = Math.max(
    1,
    Math.round(
      input.cadencePerWeek ??
        (plan?.monthlySteady ? plan.monthlySteady / 4.3 : weeklyCap(format, rampLengthWeeks(format))),
    ),
  );
  const weeklyTarget = (week: number): number => {
    const wuWeeks = plan?.warmupWeeks ?? 0;
    if (plan && wuWeeks > 0 && week <= wuWeeks) {
      // the plan's own ramp: total warm-up videos spread over the warm-up weeks
      return Math.max(1, Math.round((plan.warmupVideos ?? steady * wuWeeks) / wuWeeks));
    }
    if (!plan && isWarmingUp(format, week)) return weeklyCap(format, week);
    return steady;
  };

  // first slot no earlier than tomorrow (UTC midnight after `now`)
  const minTime = new Date(now);
  minTime.setUTCHours(0, 0, 0, 0);
  minTime.setUTCDate(minTime.getUTCDate() + 1);

  let week = warmupWeekIndex(launchedAt, now);
  let used = input.releasedThisWeek ?? 0; // only the CURRENT week starts non-empty
  // safety bound: 10 years of week buckets
  for (let guard = 0; guard < 520 && slots.length < count; guard++, week++, used = 0) {
    const target = weeklyTarget(week);
    const remaining = target - used;
    if (remaining <= 0) continue;
    const bucketStart = weekBucketStart(launchedAt, week);
    const bucketEnd = weekBucketStart(launchedAt, week + 1);
    const windowStart = bucketStart.getTime() < minTime.getTime() ? minTime : bucketStart;
    if (windowStart.getTime() >= bucketEnd.getTime()) continue; // week fully in the past
    for (const t of spreadWeekSlots(format, windowStart, bucketEnd, remaining, target > 7)) {
      if (slots.length >= count) break;
      slots.push(t);
    }
  }
  return slots;
}

// ── DB-backed read helper (cockpit Schedule tab + publishing rail) ─────────

import { eq } from "drizzle-orm";
import { channels, productions, publications, type Db } from "@ytauto/db";

export type WarmupRampRow = { week: number; cap: number; current: boolean };
export type ChannelWarmupState = {
  format: WarmupFormat;
  /** launch date the ramp is measured from (the channel's createdAt in v1) */
  launchedAt: Date;
  week: number;
  cap: number;
  graduated: boolean;
  /** releases (published or scheduled) that land in the current ramp week */
  releasedThisWeek: number;
  bucketStart: Date;
  bucketEnd: Date;
  ramp: WarmupRampRow[];
  upcoming: { productionId: string; scheduledFor: Date }[];
};

/**
 * Live warm-up state for a channel: which ramp week it's in, this week's cap and
 * how much of it is used, and the upcoming scheduled releases. Effective release
 * time is `scheduledFor ?? publishedAt` so both queued and already-published
 * uploads count against the weekly cap. v1 measures the ramp from the channel's
 * createdAt and is Shorts-only.
 */
export async function channelWarmupState(
  db: Db,
  channelId: string,
  now: Date = new Date(),
  format: WarmupFormat = "shorts",
): Promise<ChannelWarmupState | null> {
  const [ch] = await db.select().from(channels).where(eq(channels.id, channelId));
  if (!ch) return null;
  const launchedAt = ch.createdAt;
  const week = warmupWeekIndex(launchedAt, now);
  const cap = weeklyCap(format, week);
  const graduated = !isWarmingUp(format, week);
  const bucketStart = weekBucketStart(launchedAt, week);
  const bucketEnd = weekBucketStart(launchedAt, week + 1);

  const pubs = await db
    .select({
      productionId: publications.productionId,
      publishedAt: publications.publishedAt,
      scheduledFor: publications.scheduledFor,
    })
    .from(publications)
    .innerJoin(productions, eq(publications.productionId, productions.id))
    .where(eq(productions.channelId, channelId));

  const effective = (p: { publishedAt: Date | null; scheduledFor: Date | null }) =>
    p.scheduledFor ?? p.publishedAt;

  const releasedThisWeek = pubs.filter((p) => {
    const t = effective(p);
    if (!t) return false;
    const ms = new Date(t).getTime();
    return ms >= bucketStart.getTime() && ms < bucketEnd.getTime();
  }).length;

  const upcoming = pubs
    .filter((p) => p.scheduledFor && new Date(p.scheduledFor).getTime() > now.getTime())
    .map((p) => ({ productionId: p.productionId, scheduledFor: new Date(p.scheduledFor!) }))
    .sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime());

  const len = rampLengthWeeks(format);
  const ramp: WarmupRampRow[] = Array.from({ length: len }, (_, i) => ({
    week: i + 1,
    cap: weeklyCap(format, i + 1),
    current: !graduated && i + 1 === week,
  }));

  return {
    format,
    launchedAt,
    week,
    cap,
    graduated,
    releasedThisWeek,
    bucketStart,
    bucketEnd,
    ramp,
    upcoming,
  };
}
