import type { AnalyticsProvider } from "../types";
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
        retentionCurve,
        swipeAwayPct: Math.round(swipeAwayPct),
        returningViewerPct: Math.round(8 + detRand(providerVideoId, "ret2") * 34),
        subsGained: Math.round(views * (0.002 + detRand(providerVideoId, "sub") * 0.013)),
        raw: { mock: true, seed: h, ageHours: Math.round(ageHours * 10) / 10 },
      };
    },
  };
}
