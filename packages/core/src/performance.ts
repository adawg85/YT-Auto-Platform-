import { and, desc, eq, inArray } from "drizzle-orm";
import {
  analyticsSnapshots,
  assets,
  channels,
  ideas,
  productions,
  publications,
  type Db,
} from "@ytauto/db";

export type ChannelPerformance = {
  publishedCount: number;
  medianViews: number;
  avgViewPct: number | null;
  avgViewDurationSec: number | null;
  best?: { title: string; views: number };
  worst?: { title: string; views: number };
  /** heuristic target-length suggestion from retention (spec: length is instrumented) */
  suggestedLengthSec: number | null;
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

  if (pubs.length === 0) {
    return {
      publishedCount: 0,
      medianViews: 0,
      avgViewPct: null,
      avgViewDurationSec: null,
      suggestedLengthSec: null,
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
      avgViewPct: null,
      avgViewDurationSec: null,
      suggestedLengthSec: null,
      summaryText: `${pubs.length} published; analytics not ingested yet.`,
    };
  }

  const views = rows.map((r) => r.snap.views).sort((a, b) => a - b);
  const medianViews = views[Math.floor(views.length / 2)] ?? 0;
  const pcts = rows.map((r) => r.snap.avgViewPct).filter((v): v is number => v !== null);
  const avgViewPct = pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : null;
  const durs = rows
    .map((r) => r.snap.avgViewDurationSec)
    .filter((v): v is number => v !== null);
  const avgViewDurationSec = durs.length ? durs.reduce((a, b) => a + b, 0) / durs.length : null;

  const sortedByViews = [...rows].sort((a, b) => b.snap.views - a.snap.views);
  const best = sortedByViews[0];
  const worst = sortedByViews[sortedByViews.length - 1];

  // Length heuristic: low retention → viewers bail; aim near what they
  // actually watch. High retention → room to go longer.
  let suggestedLengthSec: number | null = null;
  if (avgViewPct !== null && avgViewDurationSec !== null) {
    if (avgViewPct < 45) suggestedLengthSec = Math.round(avgViewDurationSec * 1.6);
    else if (avgViewPct > 70) suggestedLengthSec = Math.round((avgViewDurationSec / (avgViewPct / 100)) * 1.15);
    if (suggestedLengthSec !== null) suggestedLengthSec = Math.min(Math.max(suggestedLengthSec, 20), 60);
  }

  const summaryText = [
    `${rows.length} published videos with analytics.`,
    `Median views ${medianViews}; average retention ${avgViewPct?.toFixed(0) ?? "?"}%.`,
    best ? `Best performer: "${best.title}" (${best.snap.views} views).` : "",
    worst && worst !== best ? `Worst: "${worst.title}" (${worst.snap.views} views).` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    publishedCount: pubs.length,
    medianViews,
    avgViewPct,
    avgViewDurationSec,
    best: best ? { title: best.title, views: best.snap.views } : undefined,
    worst: worst ? { title: worst.title, views: worst.snap.views } : undefined,
    suggestedLengthSec,
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
  /** whether analytics have been ingested for this video yet */
  hasAnalytics: boolean;
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
    hasAnalytics: Boolean(snap),
  };
}
