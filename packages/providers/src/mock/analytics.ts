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
      return {
        views,
        avgViewDurationSec: Math.round(dur * (avgViewPct / 100) * 10) / 10,
        avgViewPct,
        ctr: Math.round((1.5 + detRand(providerVideoId, "ctr") * 8) * 100) / 100,
        raw: { mock: true, seed: h, ageHours: Math.round(ageHours * 10) / 10 },
      };
    },
  };
}
