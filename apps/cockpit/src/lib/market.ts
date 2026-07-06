import { desc, inArray } from "drizzle-orm";
import { channels, externalVideos, patterns } from "@ytauto/db";
import { patternRank, rankPatterns, type PatternRow } from "@ytauto/core";
import { getAppContext } from "@/lib/context";

export type NicheIntel = {
  niche: string;
  topics: PatternRow[];
  hooks: PatternRow[];
  structures: PatternRow[];
  externalCount: number;
  analysedCount: number;
  lastCaptured: Date | null;
  topExternal: {
    id: string;
    title: string;
    channelName: string;
    source: string;
    views: number;
    url: string | null;
  }[];
};

export type MarketIntel = {
  niches: NicheIntel[];
  totals: { patterns: number; external: number; niches: number };
};

/**
 * Portfolio-level market intelligence (build #4): the shared pattern store's
 * external + own view, grouped by the niches the operator actually runs, plus
 * the scouted external videos behind them. Freshness-ranked so the hottest,
 * most recent signals surface first.
 */
export async function loadMarketIntel(): Promise<MarketIntel> {
  const { db } = await getAppContext();
  const now = new Date();

  const chans = await db.select({ niche: channels.niche }).from(channels);
  const niches = [...new Set(chans.map((c) => c.niche))];
  if (niches.length === 0) {
    return { niches: [], totals: { patterns: 0, external: 0, niches: 0 } };
  }

  const allPatterns = await db
    .select()
    .from(patterns)
    .where(inArray(patterns.niche, niches));
  const allExternal = await db
    .select()
    .from(externalVideos)
    .where(inArray(externalVideos.niche, niches))
    .orderBy(desc(externalVideos.views));

  const byNiche: NicheIntel[] = niches.map((niche) => {
    const pats = rankPatterns(
      allPatterns.filter((p) => p.niche === niche),
      now,
    );
    const ext = allExternal.filter((e) => e.niche === niche);
    const captured = ext
      .map((e) => (e.capturedAt ? new Date(e.capturedAt).getTime() : 0))
      .filter(Boolean);
    return {
      niche,
      topics: pats.filter((p) => p.kind === "topic_signal").slice(0, 6),
      hooks: pats.filter((p) => p.kind === "hook").slice(0, 6),
      structures: pats.filter((p) => p.kind === "script_structure").slice(0, 5),
      externalCount: ext.length,
      analysedCount: ext.filter((e) => e.analyzedAt).length,
      lastCaptured: captured.length ? new Date(Math.max(...captured)) : null,
      topExternal: ext.slice(0, 6).map((e) => ({
        id: e.id,
        title: e.title,
        channelName: e.channelName,
        source: e.source,
        views: e.views,
        url: e.url,
      })),
    };
  });

  // niches with the most signal first
  byNiche.sort((a, b) => b.hooks.length + b.topics.length - (a.hooks.length + a.topics.length));

  return {
    niches: byNiche,
    totals: {
      patterns: allPatterns.length,
      external: allExternal.length,
      niches: niches.length,
    },
  };
}

/** Freshness-weighted score for display (0-100-ish). */
export function displayScore(p: PatternRow, now = new Date()): number {
  return Math.round(patternRank(p, now));
}
