import type { ResearchProvider, SourceConnector, SourceItem } from "../types";

/**
 * YouTube-as-a-source: thin delegation to the existing ResearchProvider
 * (build #4). External transcripts are blocked upstream (BACKLOG #4), so the
 * content is title + channel metadata — useful as topic/coverage signal, weak
 * as verification evidence (the verifier's distinct-domain rule treats all of
 * it as one domain, youtube.com).
 */
export function createYouTubeSourceConnector(research: ResearchProvider): SourceConnector {
  return {
    kind: "youtube",
    async fetchItems(config, opts): Promise<SourceItem[]> {
      const query = opts?.query ?? (typeof config.query === "string" ? config.query : "");
      if (!query) throw new Error("youtube connector: a query is required");
      const limit = opts?.limit ?? 8;
      const [outliers, trending] = await Promise.all([
        research.outliers(query),
        research.trendingVideos(query),
      ]);
      const items: SourceItem[] = [
        ...outliers.map((v) => ({
          externalId: v.externalId,
          url: v.url ?? `https://youtube.com/watch?v=${v.externalId}`,
          title: v.title,
          content: `${v.title} — by ${v.channelName}. ${v.views.toLocaleString()} views.`,
          publishedAt: v.publishedAt,
          author: v.channelName,
        })),
        ...trending.map((v) => ({
          externalId: v.externalId,
          url: `https://youtube.com/watch?v=${v.externalId}`,
          title: v.title,
          content: `${v.title} — by ${v.channelName}. ${v.views.toLocaleString()} views.`,
          publishedAt: v.publishedAt,
          author: v.channelName,
        })),
      ];
      // dedupe by externalId, keep first
      const seen = new Set<string>();
      return items.filter((i) => !seen.has(i.externalId) && seen.add(i.externalId)).slice(0, limit);
    },
  };
}
