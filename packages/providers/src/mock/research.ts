import type { CostSink } from "@ytauto/core";
import type {
  OutlierVideo,
  KeywordStat,
  BreakoutChannel,
  TrendingVideo,
  ResearchProvider,
} from "../types";
import { detPick, detRand, fnv1a } from "./hash";

/** Stable synthetic id for a scouted video/channel, seeded from its identity. */
function extId(prefix: string, seed: string): string {
  return `${prefix}-${(fnv1a(seed) % 9_000_000) + 1_000_000}`;
}

/** ISO timestamp N hours before a fixed epoch — deterministic, no Date.now(). */
const EPOCH = Date.parse("2026-07-01T00:00:00Z");
function agoHours(h: number): string {
  return new Date(EPOCH - h * 3_600_000).toISOString();
}

/**
 * A deterministic, hook-first transcript for a scouted video. Shaped so the
 * meta-analysis agents can extract a recognizable opener + beat structure with
 * zero API keys — the same role the mock LLM plays for our own pipeline.
 */
function mockTranscript(title: string, externalId: string): string {
  const topic = title.replace(/[?.!]/g, "").toLowerCase();
  const opener = detPick(
    [
      `Nobody tells you this about ${topic}, but it changes everything.`,
      `Stop scrolling — ${topic} is not what you were taught.`,
      `Here's why ${topic} is secretly costing you every single day.`,
      `Ninety percent of people get ${topic} completely wrong.`,
    ],
    externalId,
    topic,
  );
  return [
    opener,
    `First, the setup: most explanations of ${topic} skip the one detail that matters.`,
    `Here's the proof — in a recent study, the numbers on ${topic} flipped the usual story.`,
    `The mechanism is simple once you see it, and it shows up far beyond ${topic}.`,
    `So next time you notice ${topic}, you'll know what's really going on. Follow for more.`,
  ].join(" ");
}

/** Deterministic research fixtures shaped like a VidIQ-style feed. */
export function createMockResearchProvider(costSink: CostSink): ResearchProvider {
  void costSink;
  return {
    name: "mock-research",
    async outliers(niche): Promise<OutlierVideo[]> {
      const out: OutlierVideo[] = [];
      for (let i = 0; i < 5; i++) {
        const title = `${niche} — outlier format #${i + 1}`;
        const views = Math.round(50_000 + detRand(niche, `views${i}`) * 4_000_000);
        const ageH = 24 + Math.round(detRand(niche, `age${i}`) * 600);
        out.push({
          externalId: extId("out", niche + i),
          title,
          channelName: `channel-${(fnv1a(niche + i) % 900) + 100}`,
          views,
          viewsPerHour: Math.round(views / ageH),
          publishedAt: agoHours(ageH),
          outlierFactor: Math.round((2 + detRand(niche, `of${i}`) * 30) * 10) / 10,
          url: `https://youtube.com/watch?v=${extId("out", niche + i)}`,
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
    async breakoutChannels(niche): Promise<BreakoutChannel[]> {
      const out: BreakoutChannel[] = [];
      for (let i = 0; i < 3; i++) {
        const seed = `${niche}-breakout-${i}`;
        const views = Math.round(80_000 + detRand(seed, "tv") * 3_000_000);
        const ageH = 12 + Math.round(detRand(seed, "tvage") * 300);
        out.push({
          externalId: extId("chan", seed),
          channelName: `rising-${niche.split(" ")[0]}-${(fnv1a(seed) % 90) + 10}`,
          niche,
          subscribers: Math.round(2_000 + detRand(seed, "subs") * 400_000),
          growthRate: Math.round((15 + detRand(seed, "grow") * 240) * 10) / 10,
          publishedPerWeek: 2 + (fnv1a(seed) % 6),
          topVideo: {
            externalId: extId("bvid", seed),
            title: `${niche}: the ${detPick(["hidden", "banned", "reverse", "one-minute"], seed, "tv")} method going viral`,
            views,
            viewsPerHour: Math.round(views / ageH),
            publishedAt: agoHours(ageH),
          },
        });
      }
      return out;
    },
    async trendingVideos(niche): Promise<TrendingVideo[]> {
      const out: TrendingVideo[] = [];
      for (let i = 0; i < 5; i++) {
        const seed = `${niche}-trend-${i}`;
        const views = Math.round(30_000 + detRand(seed, "v") * 2_500_000);
        const ageH = 4 + Math.round(detRand(seed, "age") * 120);
        out.push({
          externalId: extId("trend", seed),
          title: `${niche}: ${detPick(["why", "how", "the truth about", "what nobody says about"], seed, "t")} ${detPick(["this", "it", "the trend"], seed, "t2")} is blowing up`,
          channelName: `channel-${(fnv1a(seed) % 900) + 100}`,
          views,
          viewsPerHour: Math.round(views / ageH),
          engagementRate: Math.round((2 + detRand(seed, "eng") * 12) * 10) / 10,
          publishedAt: agoHours(ageH),
          format: "shorts",
        });
      }
      return out;
    },
    async transcript(externalId): Promise<string | null> {
      // We only have transcripts for scouted content; a readable topic phrase is
      // derived from the id seed so the same id always yields the same transcript.
      const topic = detPick(
        ["this everyday habit", "that common mistake", "the hidden mechanism", "this simple trick", "the overlooked detail"],
        externalId,
        "topic",
      );
      return mockTranscript(topic, externalId);
    },
  };
}
