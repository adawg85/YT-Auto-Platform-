import type { AnalyticsProvider, ChannelStats } from "../types";
import { detRand, fnv1a } from "./hash";

/**
 * Deterministic mock analytics: each video gets a stable "personality" from
 * its id hash (base audience, retention, CTR) and views grow with age on a
 * sqrt curve — so repeated ingests move the numbers realistically, alerts
 * fire for the weak performers, and everything is reproducible per video.
 */
export function createMockAnalyticsProvider(): AnalyticsProvider {
  return {
    name: "mock-analytics",
    async fetchVideoStats({ providerVideoId, publishedAt, durationSec }) {
      const ageHours = Math.max(
        0.5,
        (Date.now() - new Date(publishedAt).getTime()) / 3_600_000,
      );
      const h = fnv1a(providerVideoId);
      // per-video audience size varies over ~2 orders of magnitude
      const audience = 50 * Math.pow(10, detRand(providerVideoId, "aud") * 2.3);
      const views = Math.round(audience * Math.sqrt(ageHours));
      const avgViewPct = Math.round(30 + detRand(providerVideoId, "ret") * 55); // 30-85%
      const dur = durationSec ?? 35;

      // Deterministic retention curve: starts at 100, decays so the area under
      // it tracks avgViewPct, with a steeper first-3s cliff (the hook drop) and
      // small per-bucket jitter seeded from the video id.
      const n = 21;
      const clamp = (lo: number, hi: number, v: number) => Math.min(hi, Math.max(lo, v));
      const end = clamp(18, 92, avgViewPct * 0.7);
      const retentionCurve = Array.from({ length: n }, (_, i) => {
        const t = i / (n - 1);
        const cliff = t < 0.15 ? (0.15 - t) * 40 : 0; // extra drop in the hook zone
        const base = 100 - (100 - end) * Math.pow(t, 0.6) - cliff;
        const jitter = (detRand(providerVideoId, `c${i}`) - 0.5) * 4;
        return clamp(5, 100, Math.round(base + jitter));
      });
      retentionCurve[0] = 100;

      const idx3s = Math.round(Math.min(1, 3 / dur) * (n - 1));
      const swipeAwayPct = clamp(0, 95, 100 - (retentionCurve[idx3s] ?? 100));

      return {
        views,
        avgViewDurationSec: Math.round(dur * (avgViewPct / 100) * 10) / 10,
        avgViewPct,
        ctr: Math.round((1.5 + detRand(providerVideoId, "ctr") * 8) * 100) / 100,
        // impressions ≈ views / CTR: deterministic 12–28× views (viability bar)
        impressions: Math.round(views * (12 + detRand(providerVideoId, "imp") * 16)),
        retentionCurve,
        swipeAwayPct: Math.round(swipeAwayPct),
        returningViewerPct: Math.round(8 + detRand(providerVideoId, "ret2") * 34),
        subsGained: Math.round(views * (0.002 + detRand(providerVideoId, "sub") * 0.013)),
        raw: { mock: true, seed: h, ageHours: Math.round(ageHours * 10) / 10 },
      };
    },

    async fetchChannelStats({ channelId, sinceDays }): Promise<ChannelStats> {
      // Deterministic per-channel "personality": a daily-views base that drifts
      // over the window, so repeated loads are stable and channels differ.
      const base = 40 + Math.round(detRand(channelId, "cbase") * 900);
      const today = new Date();
      const dailyViews: { day: string; views: number }[] = [];
      let views = 0;
      for (let i = sinceDays - 1; i >= 0; i--) {
        const d = new Date(today.getTime() - i * 86_400_000);
        const day = d.toISOString().slice(0, 10);
        const wobble = 0.55 + detRand(channelId, `d${day}`) * 0.9; // 0.55–1.45×
        const v = Math.round(base * wobble);
        dailyViews.push({ day, views: v });
        views += v;
      }
      const avgViewPct = Math.round(32 + detRand(channelId, "cret") * 50); // 32–82%
      return {
        views,
        subsGained: Math.round(views * (0.002 + detRand(channelId, "csub") * 0.01)),
        avgViewPct,
        // ~avgViewPct of a ~6-min video, across all views → rough watch minutes
        estimatedMinutesWatched: Math.round(views * (avgViewPct / 100) * 6),
        subscriberCount: 100 + Math.round(detRand(channelId, "csubcount") * 5000),
        dailyViews,
        raw: { mock: true, channelId, sinceDays },
      };
    },
  };
}
