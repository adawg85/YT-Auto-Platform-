import type { CostSink } from "@ytauto/core";
import type { SearchProvider, SourceItem } from "../types";

/** Tavily advanced search ≈ 2 credits ≈ $0.016; basic ≈ 1. Rough, for cost logs. */
const TAVILY_COST_PER_SEARCH = 0.016;

type TavilyResult = {
  title: string;
  url: string;
  content: string;
  raw_content?: string | null;
  score?: number;
  published_date?: string | null;
};

/**
 * Tavily-backed web search for episode research (BACKLOG: research quality).
 * One call returns several relevant documents from independent domains with
 * clean extracted text — so the corroboration model finally has real, distinct
 * sources to count, instead of a single scraped NTRS page or a 404.
 */
export function createTavilySearchProvider(apiKey: string, costSink: CostSink): SearchProvider {
  return {
    name: "tavily",
    async search(query, opts = {}) {
      // Remediation §4.2: a bare fetch with no timeout was the research stall —
      // a hung Tavily connection blocked the step for hours until the daily
      // watchdog swept it (duplicated spend on re-fire). Bound every call.
      const timeoutMs = Number(process.env.RESEARCH_SEARCH_TIMEOUT_MS ?? "30000");
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          query,
          search_depth: "advanced",
          max_results: Math.min(Math.max(opts.maxResults ?? 8, 3), 20),
          include_raw_content: true,
          include_answer: false,
          exclude_domains: opts.excludeDomains ?? [],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        throw new Error(`Tavily search failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
      }
      const json = (await res.json()) as { results?: TavilyResult[] };
      const results = json.results ?? [];

      await costSink.record({
        category: "research",
        provider: "tavily",
        model: "search-advanced",
        units: { searches: 1, results: results.length },
        costUsd: TAVILY_COST_PER_SEARCH,
        channelId: opts.channelId ?? "",
      });

      return results
        .map((r): SourceItem | null => {
          // prefer full page text; fall back to Tavily's relevance snippet
          const content = (r.raw_content?.trim() || r.content?.trim() || "").slice(0, 60_000);
          if (!r.url || !content) return null;
          return {
            externalId: r.url,
            url: r.url,
            title: r.title || r.url,
            content,
            publishedAt: r.published_date ?? undefined,
          };
        })
        .filter((x): x is SourceItem => x !== null);
    },
  };
}
