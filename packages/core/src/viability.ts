/**
 * Channel viability guardrail (operator policy, 2026-07-07): a channel that
 * cannot reach 100k impressions in 28 days after being given a fair chance is
 * a candidate for shutdown — the spend belongs on channels the algorithm is
 * feeding. Timeline per channel:
 *
 *   launch ──(warm-up ramp, #3)──▶ graduated ──(3-month grace)──▶ monthly
 *   review: impressions over the trailing 28 days vs the bar → below = FLAG
 *   for potential shutdown (alert + briefing line). Shutdown itself stays a
 *   human decision — the operator pauses/archives; nothing automatic.
 */
import { and, desc, eq, lte } from "drizzle-orm";
import { analyticsSnapshots, productions, publications, type Db } from "@ytauto/db";
import { rampLengthWeeks, type WarmupFormat } from "./warmup";

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/** the bar: impressions over the trailing window a viable channel must clear */
export const VIABILITY_IMPRESSIONS_BAR = 100_000;
export const VIABILITY_WINDOW_DAYS = 28;
/** post-graduation grace before reviews start — channels need time to compound */
export const VIABILITY_GRACE_DAYS = 90;

export type ViabilityStatus =
  /** still inside the warm-up ramp — no judgement */
  | "warming"
  /** graduated, inside the 3-month grace window — watched, not judged */
  | "grace"
  /** under review and clearing the bar */
  | "healthy"
  /** under review and below the bar — candidate for shutdown */
  | "flagged"
  /** under review but impressions are not measurable (no data from provider) */
  | "unknown";

export type ViabilityAssessment = {
  status: ViabilityStatus;
  /** when monthly reviews begin (graduation + grace) */
  reviewStartsAt: Date;
  impressions28d: number | null;
  bar: number;
  reason: string;
};

/**
 * Pure policy: where a channel stands against the viability bar.
 * `launchedAt` is the warm-up anchor (channel createdAt in v1).
 */
export function assessChannelViability(input: {
  launchedAt: Date;
  impressions28d: number | null;
  format?: WarmupFormat;
  now?: Date;
}): ViabilityAssessment {
  const { launchedAt, impressions28d } = input;
  const format = input.format ?? "shorts";
  const now = input.now ?? new Date();

  const graduatedAt = new Date(launchedAt.getTime() + rampLengthWeeks(format) * WEEK_MS);
  const reviewStartsAt = new Date(graduatedAt.getTime() + VIABILITY_GRACE_DAYS * DAY_MS);
  const base = { reviewStartsAt, impressions28d, bar: VIABILITY_IMPRESSIONS_BAR };

  if (now < graduatedAt) {
    return { ...base, status: "warming", reason: "still inside the warm-up ramp" };
  }
  if (now < reviewStartsAt) {
    return {
      ...base,
      status: "grace",
      reason: `graduated; viability reviews start ${reviewStartsAt.toISOString().slice(0, 10)}`,
    };
  }
  if (impressions28d == null) {
    return {
      ...base,
      status: "unknown",
      reason: "under review, but the analytics provider reports no impressions data",
    };
  }
  if (impressions28d >= VIABILITY_IMPRESSIONS_BAR) {
    return {
      ...base,
      status: "healthy",
      reason: `${impressions28d.toLocaleString()} impressions in ${VIABILITY_WINDOW_DAYS}d clears the ${VIABILITY_IMPRESSIONS_BAR.toLocaleString()} bar`,
    };
  }
  return {
    ...base,
    status: "flagged",
    reason: `${impressions28d.toLocaleString()} impressions in ${VIABILITY_WINDOW_DAYS}d is below the ${VIABILITY_IMPRESSIONS_BAR.toLocaleString()} bar — candidate for shutdown`,
  };
}

/**
 * Channel impressions over the trailing window, from snapshot history.
 * Snapshots store CUMULATIVE per-video impressions, so the windowed figure is
 * Σ per publication of (latest cumulative − cumulative as of window start).
 * Returns null when no snapshot on the channel carries impressions at all
 * (provider doesn't report them) — the policy treats that as "unknown".
 */
export async function channelImpressions28d(
  db: Db,
  channelId: string,
  now: Date = new Date(),
): Promise<number | null> {
  const windowStart = new Date(now.getTime() - VIABILITY_WINDOW_DAYS * DAY_MS);

  const rows = await db
    .select({
      publicationId: analyticsSnapshots.publicationId,
      impressions: analyticsSnapshots.impressions,
      capturedAt: analyticsSnapshots.capturedAt,
    })
    .from(analyticsSnapshots)
    .innerJoin(publications, eq(analyticsSnapshots.publicationId, publications.id))
    .innerJoin(productions, eq(publications.productionId, productions.id))
    .where(and(eq(productions.channelId, channelId), lte(analyticsSnapshots.capturedAt, now)))
    .orderBy(desc(analyticsSnapshots.capturedAt));

  let sawImpressions = false;
  const latest = new Map<string, number>();
  const atWindowStart = new Map<string, number>();
  for (const r of rows) {
    if (r.impressions == null) continue;
    sawImpressions = true;
    if (!latest.has(r.publicationId)) latest.set(r.publicationId, r.impressions);
    // rows are newest-first: keep overwriting so the LAST write is the oldest
    // snapshot inside the window... we want the newest snapshot BEFORE the
    // window start — capture the first row seen at or before windowStart.
    if (r.capturedAt <= windowStart && !atWindowStart.has(r.publicationId)) {
      atWindowStart.set(r.publicationId, r.impressions);
    }
  }
  if (!sawImpressions) return null;

  let total = 0;
  for (const [pubId, cum] of latest) {
    const prev = atWindowStart.get(pubId) ?? 0;
    total += Math.max(0, cum - prev);
  }
  return total;
}
