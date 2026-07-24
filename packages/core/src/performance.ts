import { and, desc, eq, inArray } from "drizzle-orm";
import {
  analyticsSnapshots,
  assets,
  channelDna,
  channels,
  ideas,
  productions,
  publications,
  type Db,
} from "@ytauto/db";
import type { LengthPolicy } from "@ytauto/db";
import { resolveLengthPolicy } from "./length-policy";

/**
 * Evidence bar for suggestedLengthSec (ticket 01KY99AE…). Below this the retention
 * averages are cold-start noise, not a length signal — suppress the suggestion so it
 * isn't read as a finding. Kept in step with the playbook, which also declines to
 * assert on a thin/immature sample (learning.ts MIN_ADOPTION_EVIDENCE + maturity).
 */
export const SUGGESTED_LENGTH_MIN_SAMPLE = 8;
export const SUGGESTED_LENGTH_MIN_MEDIAN_VIEWS = 50;

/**
 * Pure length-suggestion (ticket 01KY99AE…): derive a target length from retention,
 * CLAMP it to the channel's lengthPolicy [floorSec, ceilingSec], and SUPPRESS it
 * (null) below the evidence bar. Extracted so the clamp + gate are unit-testable
 * without a DB.
 */
export function suggestLengthFromRetention(
  policy: LengthPolicy,
  input: { avgViewPct: number | null; avgViewDurationSec: number | null; sampleSize: number; medianViews: number },
): { suggestedLengthSec: number | null; sufficientEvidence: boolean } {
  const sufficientEvidence =
    input.sampleSize >= SUGGESTED_LENGTH_MIN_SAMPLE && input.medianViews >= SUGGESTED_LENGTH_MIN_MEDIAN_VIEWS;
  let s: number | null = null;
  if (sufficientEvidence && input.avgViewPct !== null && input.avgViewDurationSec !== null) {
    if (input.avgViewPct < 45) s = Math.round(input.avgViewDurationSec * 1.6);
    else if (input.avgViewPct > 70) s = Math.round((input.avgViewDurationSec / (input.avgViewPct / 100)) * 1.15);
    if (s !== null) s = Math.min(Math.max(s, policy.floorSec), policy.ceilingSec);
  }
  return { suggestedLengthSec: s, sufficientEvidence };
}

export type SuggestedLengthBasis = {
  /** videos with an analytics snapshot the suggestion was derived from */
  sampleSize: number;
  medianViews: number;
  avgViewDurationSec: number | null;
  avgViewPct: number | null;
  /** the lengthPolicy bounds the suggestion is clamped to */
  floorSec: number;
  ceilingSec: number;
  /** false → evidence too thin; suggestedLengthSec is suppressed (null) */
  sufficientEvidence: boolean;
};

export type ChannelPerformance = {
  publishedCount: number;
  medianViews: number;
  /** mean views across videos that have an analytics snapshot */
  meanViews: number;
  /** how many published videos actually have an analytics snapshot */
  withAnalytics: number;
  avgViewPct: number | null;
  avgViewDurationSec: number | null;
  best?: { title: string; views: number };
  worst?: { title: string; views: number };
  /**
   * Heuristic target-length suggestion from retention, CLAMPED to the channel's
   * lengthPolicy [floorSec, ceilingSec] and SUPPRESSED (null) below the evidence
   * bar (ticket 01KY99AE…). Display/advisory only — nothing in the pipeline
   * consumes it. Read `suggestedLengthBasis` to see the inputs.
   */
  suggestedLengthSec: number | null;
  /** the inputs behind suggestedLengthSec so a reader can judge its weight */
  suggestedLengthBasis: SuggestedLengthBasis;
  /** compact text for agent prompts */
  summaryText: string;
};

/**
 * Latest-snapshot-per-publication rollup: feeds the scorer/ideation prompts
 * (the analytics → strategy feedback loop) and the channel page.
 */
export async function channelPerformanceSummary(
  db: Db,
  channelId: string,
): Promise<ChannelPerformance> {
  const pubs = await db
    .select({
      publicationId: publications.id,
      title: ideas.title,
    })
    .from(publications)
    .innerJoin(productions, eq(publications.productionId, productions.id))
    .innerJoin(ideas, eq(productions.ideaId, ideas.id))
    .where(eq(productions.channelId, channelId));

  const [dna] = await db
    .select({ lengthPolicy: channelDna.lengthPolicy })
    .from(channelDna)
    .where(eq(channelDna.channelId, channelId));
  const policy = resolveLengthPolicy(dna?.lengthPolicy ?? null);
  const emptyBasis = (sampleSize: number, medianViews: number): SuggestedLengthBasis => ({
    sampleSize,
    medianViews,
    avgViewDurationSec: null,
    avgViewPct: null,
    floorSec: policy.floorSec,
    ceilingSec: policy.ceilingSec,
    sufficientEvidence: false,
  });

  if (pubs.length === 0) {
    return {
      publishedCount: 0,
      medianViews: 0,
      meanViews: 0,
      withAnalytics: 0,
      avgViewPct: null,
      avgViewDurationSec: null,
      suggestedLengthSec: null,
      suggestedLengthBasis: emptyBasis(0, 0),
      summaryText: "No published videos yet — no performance data.",
    };
  }

  const snaps = await db
    .select()
    .from(analyticsSnapshots)
    .where(inArray(analyticsSnapshots.publicationId, pubs.map((p) => p.publicationId)))
    .orderBy(desc(analyticsSnapshots.capturedAt));

  // latest snapshot per publication
  const latest = new Map<string, (typeof snaps)[number]>();
  for (const s of snaps) if (!latest.has(s.publicationId)) latest.set(s.publicationId, s);

  const rows = pubs
    .map((p) => ({ title: p.title, snap: latest.get(p.publicationId) }))
    .filter((r): r is { title: string; snap: (typeof snaps)[number] } => Boolean(r.snap));

  if (rows.length === 0) {
    return {
      publishedCount: pubs.length,
      medianViews: 0,
      meanViews: 0,
      withAnalytics: 0,
      avgViewPct: null,
      avgViewDurationSec: null,
      suggestedLengthSec: null,
      suggestedLengthBasis: emptyBasis(0, 0),
      summaryText: `${pubs.length} published; analytics not ingested yet.`,
    };
  }

  const views = rows.map((r) => r.snap.views).sort((a, b) => a - b);
  const medianViews = views[Math.floor(views.length / 2)] ?? 0;
  const meanViews = views.length ? Math.round(views.reduce((a, b) => a + b, 0) / views.length) : 0;
  const pcts = rows.map((r) => r.snap.avgViewPct).filter((v): v is number => v !== null);
  const avgViewPct = pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : null;
  const durs = rows
    .map((r) => r.snap.avgViewDurationSec)
    .filter((v): v is number => v !== null);
  const avgViewDurationSec = durs.length ? durs.reduce((a, b) => a + b, 0) / durs.length : null;

  const sortedByViews = [...rows].sort((a, b) => b.snap.views - a.snap.views);
  const best = sortedByViews[0];
  const worst = sortedByViews[sortedByViews.length - 1];

  // Length heuristic: low retention → viewers bail; aim near what they actually
  // watch. High retention → room to go longer. CLAMPED to the channel's
  // lengthPolicy [floorSec, ceilingSec] — the old hardcoded [20,60] Shorts clamp
  // emitted 60 on a long-form channel with a 480s mid-roll floor (ticket 01KY99AE…).
  // SUPPRESSED below the evidence bar so a cold-start sample isn't read as a finding.
  const { suggestedLengthSec, sufficientEvidence } = suggestLengthFromRetention(policy, {
    avgViewPct,
    avgViewDurationSec,
    sampleSize: rows.length,
    medianViews,
  });
  const suggestedLengthBasis: SuggestedLengthBasis = {
    sampleSize: rows.length,
    medianViews,
    avgViewDurationSec,
    avgViewPct,
    floorSec: policy.floorSec,
    ceilingSec: policy.ceilingSec,
    sufficientEvidence,
  };

  const summaryText = [
    `${rows.length} published videos with analytics.`,
    `Median views ${medianViews}; average retention ${avgViewPct?.toFixed(0) ?? "?"}%.`,
    best ? `Best performer: "${best.title}" (${best.snap.views} views).` : "",
    worst && worst !== best ? `Worst: "${worst.title}" (${worst.snap.views} views).` : "",
    sufficientEvidence
      ? ""
      : `Length suggestion suppressed — evidence too thin (needs ≥${SUGGESTED_LENGTH_MIN_SAMPLE} analysed videos at ≥${SUGGESTED_LENGTH_MIN_MEDIAN_VIEWS} median views).`,
  ]
    .filter(Boolean)
    .join(" ");

  return {
    publishedCount: pubs.length,
    medianViews,
    meanViews,
    withAnalytics: rows.length,
    avgViewPct,
    avgViewDurationSec,
    best: best ? { title: best.title, views: best.snap.views } : undefined,
    worst: worst ? { title: worst.title, views: worst.snap.views } : undefined,
    suggestedLengthSec,
    suggestedLengthBasis,
    summaryText,
  };
}

export type VideoPerformance = {
  publicationId: string;
  productionId: string;
  channelId: string;
  niche: string;
  title: string;
  status: string;
  url: string;
  publishedAt: Date | null;
  views: number;
  avgViewPct: number | null;
  avgViewDurationSec: number | null;
  ctr: number | null;
  swipeAwayPct: number | null;
  returningViewerPct: number | null;
  subsGained: number | null;
  retentionCurve: number[] | null;
  /** % still watching at the 3s mark, read off the retention curve */
  threeSecondHoldPct: number | null;
  /** duration used to locate the 3s bucket on the curve */
  durationSec: number | null;
  /** channel-wide average % viewed, for comparison */
  channelAvgViewPct: number | null;
  /** this video's avg % viewed minus the channel average, in points */
  vsChannelAvgPct: number | null;
  /** estimated minutes watched, and the same ÷60 as watch hours (ticket 01KY1VEZ…) */
  estimatedMinutesWatched: number | null;
  watchHours: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  /** view breakdown by YouTube traffic-source type, descending */
  trafficSources: { source: string; views: number }[] | null;
  /** whether ANY analytics snapshot exists yet (unchanged; see dataState/coverage) */
  hasAnalytics: boolean;
  /**
   * Honest per-metric availability (ticket 01KY1VEZ…): a bare `hasAnalytics`
   * couldn't tell "not fetched yet" from "performing badly". `dataState`:
   * none = no snapshot; pending = snapshot exists but watch data hasn't
   * processed (the API's 24-72h lag); partial = watch data but no curve;
   * full = watch data + retention curve. `coverage` flags each metric group.
   */
  dataState: "none" | "pending" | "partial" | "full";
  coverage: {
    views: boolean;
    watchPct: boolean;
    retentionCurve: boolean;
    watchTime: boolean;
    engagement: boolean;
    subs: boolean;
    trafficSources: boolean;
    /** always false — Studio-only, not exposed by the Analytics API (see ticket) */
    impressionsCtr: boolean;
  };
};

/** Read a retention percentage off an even-sampled curve at `t` seconds. */
export function retentionAtSec(
  curve: number[] | null | undefined,
  atSec: number,
  durationSec: number | null | undefined,
): number | null {
  if (!curve || curve.length === 0 || !durationSec || durationSec <= 0) return null;
  const frac = Math.min(1, Math.max(0, atSec / durationSec));
  const idx = Math.round(frac * (curve.length - 1));
  return curve[idx] ?? null;
}

/**
 * Single-video rollup for the drill-down page + the analysis agents: the latest
 * analytics snapshot joined to its production/idea/channel, plus curve-derived
 * metrics (3s hold, vs-channel-average). Returns null if the publication is
 * unknown.
 */
export async function videoPerformance(
  db: Db,
  publicationId: string,
): Promise<VideoPerformance | null> {
  const [row] = await db
    .select({
      publicationId: publications.id,
      productionId: productions.id,
      channelId: productions.channelId,
      status: productions.status,
      url: publications.url,
      publishedAt: publications.publishedAt,
      title: ideas.title,
      niche: channels.niche,
    })
    .from(publications)
    .innerJoin(productions, eq(publications.productionId, productions.id))
    .innerJoin(ideas, eq(productions.ideaId, ideas.id))
    .innerJoin(channels, eq(productions.channelId, channels.id))
    .where(eq(publications.id, publicationId));
  if (!row) return null;

  const perf = await channelPerformanceSummary(db, row.channelId);

  const [snap] = await db
    .select()
    .from(analyticsSnapshots)
    .where(eq(analyticsSnapshots.publicationId, publicationId))
    .orderBy(desc(analyticsSnapshots.capturedAt))
    .limit(1);

  const [render] = await db
    .select({ durationSec: assets.durationSec })
    .from(assets)
    .where(and(eq(assets.productionId, row.productionId), eq(assets.kind, "render")));
  const durationSec = render?.durationSec ?? snap?.avgViewDurationSec ?? null;

  const retentionCurve = snap?.retentionCurve ?? null;
  const threeSecondHoldPct = retentionAtSec(retentionCurve, 3, durationSec);
  const vsChannelAvgPct =
    snap?.avgViewPct != null && perf.avgViewPct != null
      ? Math.round((snap.avgViewPct - perf.avgViewPct) * 10) / 10
      : null;

  return {
    publicationId: row.publicationId,
    productionId: row.productionId,
    channelId: row.channelId,
    niche: row.niche,
    title: row.title,
    status: row.status,
    url: row.url ?? "", // scheduled-but-unpublished rows have no url yet
    publishedAt: row.publishedAt,
    views: snap?.views ?? 0,
    avgViewPct: snap?.avgViewPct ?? null,
    avgViewDurationSec: snap?.avgViewDurationSec ?? null,
    ctr: snap?.ctr ?? null,
    swipeAwayPct: snap?.swipeAwayPct ?? null,
    returningViewerPct: snap?.returningViewerPct ?? null,
    subsGained: snap?.subsGained ?? null,
    retentionCurve,
    threeSecondHoldPct,
    durationSec,
    channelAvgViewPct: perf.avgViewPct,
    vsChannelAvgPct,
    estimatedMinutesWatched: snap?.estimatedMinutesWatched ?? null,
    watchHours: snap?.estimatedMinutesWatched != null ? Math.round((snap.estimatedMinutesWatched / 60) * 10) / 10 : null,
    likes: snap?.likes ?? null,
    comments: snap?.comments ?? null,
    shares: snap?.shares ?? null,
    trafficSources: snap?.trafficSources ?? null,
    hasAnalytics: Boolean(snap),
    dataState: !snap
      ? "none"
      : snap.avgViewPct == null
        ? "pending"
        : retentionCurve
          ? "full"
          : "partial",
    coverage: {
      views: Boolean(snap),
      watchPct: snap?.avgViewPct != null,
      retentionCurve: Boolean(retentionCurve),
      watchTime: snap?.estimatedMinutesWatched != null,
      engagement: snap?.likes != null || snap?.comments != null || snap?.shares != null,
      subs: snap?.subsGained != null,
      trafficSources: Boolean(snap?.trafficSources),
      impressionsCtr: false,
    },
  };
}
