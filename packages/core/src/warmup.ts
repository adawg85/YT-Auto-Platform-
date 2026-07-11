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

/**
 * Project tentative publish slots for a whole approved series (BACKLOG #23.1):
 * `count` future daypart slots starting after `now`, respecting the warm-up
 * ramp's weekly caps while the channel is still ramping and the steady
 * `cadencePerWeek` (default: the format's graduated full cadence) afterwards.
 * Pure + deterministic — mirrors planWarmupRelease's slotting so a tentative
 * date is exactly where the publish rail would have put the video anyway.
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
}): Date[] {
  const { format, launchedAt, now, count } = input;
  const slots: Date[] = [];
  if (count <= 0) return slots;
  const usedByWeek = new Map<number, number>();
  if (input.releasedThisWeek) {
    usedByWeek.set(warmupWeekIndex(launchedAt, now), input.releasedThisWeek);
  }
  let cursor = now;
  // safety bound: each iteration either emits a slot or jumps a whole week
  for (let guard = 0; guard < count * 60 && slots.length < count; guard++) {
    const slot = nextDaypartSlot(format, cursor);
    const week = warmupWeekIndex(launchedAt, slot);
    const cap = isWarmingUp(format, week)
      ? weeklyCap(format, week)
      : Math.max(1, input.cadencePerWeek ?? weeklyCap(format, week));
    const used = usedByWeek.get(week) ?? 0;
    if (used >= cap) {
      // this ramp week is full — jump to the start of the next week bucket
      cursor = weekBucketStart(launchedAt, week + 1);
      continue;
    }
    usedByWeek.set(week, used + 1);
    slots.push(slot);
    cursor = slot;
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
