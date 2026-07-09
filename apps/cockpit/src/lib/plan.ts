import { asc, desc, eq, inArray } from "drizzle-orm";
import { channelCharters, claims, episodes, ideas, productions, scores, series, type Db } from "@ytauto/db";

export type EpisodeWithClaims = typeof episodes.$inferSelect & {
  verifiedClaims: number;
  attributedClaims: number;
  cutClaims: number;
  /** the episode's idea, once handed off (#19: act on it inline in the Plan tab) */
  ideaStatus: string | null;
  /** the idea's rubric score, once scored (null until scored) */
  score: number | null;
  /** the production spawned from the idea, once greenlit */
  productionId: string | null;
  productionStatus: string | null;
};

export type SeriesWithEpisodes = typeof series.$inferSelect & {
  episodes: EpisodeWithClaims[];
};

export type ChannelPlan = {
  charter: typeof channelCharters.$inferSelect | null;
  series: SeriesWithEpisodes[];
};

/** The per-channel Plan tab data: charter + series arcs + per-episode claim counts. */
export async function loadChannelPlan(db: Db, channelId: string): Promise<ChannelPlan> {
  const [charter] = await db
    .select()
    .from(channelCharters)
    .where(eq(channelCharters.channelId, channelId));

  const seriesRows = await db
    .select()
    .from(series)
    .where(eq(series.channelId, channelId))
    .orderBy(asc(series.position));

  const episodeRows = seriesRows.length
    ? await db
        .select()
        .from(episodes)
        .where(inArray(episodes.seriesId, seriesRows.map((s) => s.id)))
        .orderBy(asc(episodes.position))
    : [];

  const claimRows = episodeRows.length
    ? await db
        .select({ episodeId: claims.episodeId, status: claims.status })
        .from(claims)
        .where(inArray(claims.episodeId, episodeRows.map((e) => e.id)))
    : [];

  const counts = new Map<string, { verified: number; attributed: number; cut: number }>();
  for (const c of claimRows) {
    const entry = counts.get(c.episodeId) ?? { verified: 0, attributed: 0, cut: 0 };
    if (c.status === "verified") entry.verified++;
    else if (c.status === "attributed") entry.attributed++;
    else if (c.status === "cut") entry.cut++;
    counts.set(c.episodeId, entry);
  }

  // #19: resolve each episode's idea → score → production so the operator can
  // score/greenlight and watch a video move through the pipeline inline.
  const ideaIds = episodeRows.map((e) => e.ideaId).filter((x): x is string => !!x);
  const ideaRows = ideaIds.length
    ? await db.select({ id: ideas.id, status: ideas.status }).from(ideas).where(inArray(ideas.id, ideaIds))
    : [];
  const ideaStatusById = new Map(ideaRows.map((i) => [i.id, i.status as string]));
  const scoreRows = ideaIds.length
    ? await db
        .select({ ideaId: scores.ideaId, weightedTotal: scores.weightedTotal })
        .from(scores)
        .where(inArray(scores.ideaId, ideaIds))
        .orderBy(desc(scores.createdAt))
    : [];
  const scoreByIdea = new Map<string, number>();
  for (const s of scoreRows) if (!scoreByIdea.has(s.ideaId)) scoreByIdea.set(s.ideaId, s.weightedTotal);
  const prodRows = ideaIds.length
    ? await db
        .select({ id: productions.id, ideaId: productions.ideaId, status: productions.status })
        .from(productions)
        .where(inArray(productions.ideaId, ideaIds))
        .orderBy(desc(productions.createdAt))
    : [];
  const prodByIdea = new Map<string, { id: string; status: string }>();
  for (const p of prodRows) if (!prodByIdea.has(p.ideaId)) prodByIdea.set(p.ideaId, { id: p.id, status: p.status });

  return {
    charter: charter ?? null,
    series: seriesRows.map((s) => ({
      ...s,
      episodes: episodeRows
        .filter((e) => e.seriesId === s.id)
        .map((e) => {
          const c = counts.get(e.id) ?? { verified: 0, attributed: 0, cut: 0 };
          const prod = e.ideaId ? prodByIdea.get(e.ideaId) : undefined;
          return {
            ...e,
            verifiedClaims: c.verified,
            attributedClaims: c.attributed,
            cutClaims: c.cut,
            ideaStatus: e.ideaId ? ideaStatusById.get(e.ideaId) ?? null : null,
            score: e.ideaId ? scoreByIdea.get(e.ideaId) ?? null : null,
            productionId: prod?.id ?? null,
            productionStatus: prod?.status ?? null,
          };
        }),
    })),
  };
}
