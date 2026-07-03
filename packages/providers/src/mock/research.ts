import type { CostSink } from "@ytauto/core";
import type { OutlierVideo, KeywordStat, ResearchProvider } from "../types";
import { detRand, fnv1a } from "./hash";

/** Deterministic research fixtures shaped like a VidIQ-style feed. */
export function createMockResearchProvider(costSink: CostSink): ResearchProvider {
  return {
    name: "mock-research",
    async outliers(niche): Promise<OutlierVideo[]> {
      const out: OutlierVideo[] = [];
      for (let i = 0; i < 5; i++) {
        out.push({
          title: `${niche} — outlier format #${i + 1}`,
          channelName: `channel-${(fnv1a(niche + i) % 900) + 100}`,
          views: Math.round(50_000 + detRand(niche, `views${i}`) * 4_000_000),
          publishedAt: "2026-06-01",
          outlierFactor: Math.round((2 + detRand(niche, `of${i}`) * 30) * 10) / 10,
        });
      }
      return out;
    },
    async keywords(seed): Promise<KeywordStat[]> {
      const mods = ["explained", "in 60 seconds", "you didn't know", "mistake", "actually works"];
      return mods.map((m, i) => ({
        keyword: `${seed} ${m}`,
        monthlyVolume: Math.round(1_000 + detRand(seed, `vol${i}`) * 200_000),
        competition: Math.round(detRand(seed, `comp${i}`) * 100) / 100,
      }));
    },
  };
}
