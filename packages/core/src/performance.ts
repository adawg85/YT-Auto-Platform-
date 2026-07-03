import { desc, eq, inArray } from "drizzle-orm";
import {
  analyticsSnapshots,
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
