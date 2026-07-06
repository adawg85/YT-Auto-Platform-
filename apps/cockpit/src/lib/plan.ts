import { asc, eq, inArray } from "drizzle-orm";
import { channelCharters, claims, episodes, series, type Db } from "@ytauto/db";

export type EpisodeWithClaims = typeof episodes.$inferSelect & {
  verifiedClaims: number;
  attributedClaims: number;
  cutClaims: number;
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

  return {
    charter: charter ?? null,
    series: seriesRows.map((s) => ({
      ...s,
      episodes: episodeRows
        .filter((e) => e.seriesId === s.id)
        .map((e) => {
          const c = counts.get(e.id) ?? { verified: 0, attributed: 0, cut: 0 };
          return {
            ...e,
            verifiedClaims: c.verified,
            attributedClaims: c.attributed,
            cutClaims: c.cut,
          };
        }),
    })),
  };
}
