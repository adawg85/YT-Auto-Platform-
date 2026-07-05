/**
 * Per-video analysis (build #3.2): the mock analytics retention curve and the
 * two mock-LLM analysis generators. Deterministic and keyless, so the drill-down
 * flow is exercisable in CI without a DB or API keys.
 */
import { describe, expect, it } from "vitest";
import { generateObject } from "ai";
import { hookAnalysisSchema, scriptAnalysisSchema } from "@ytauto/core";
import { createMockLLMProvider } from "../src/mock/llm";
import { createMockAnalyticsProvider } from "../src/mock/analytics";

describe("mock analytics retention curve", () => {
  const analytics = createMockAnalyticsProvider();
  const req = {
    channelId: "c1",
    providerVideoId: "vid-abc",
    publishedAt: new Date(Date.now() - 100 * 3_600_000).toISOString(),
    durationSec: 35,
  };

  it("emits a 21-point curve starting at 100 and decaying", async () => {
    const s = await analytics.fetchVideoStats(req);
    expect(s.retentionCurve).toHaveLength(21);
    expect(s.retentionCurve![0]).toBe(100);
    expect(s.retentionCurve!.at(-1)!).toBeLessThan(s.retentionCurve![0]!);
    for (const v of s.retentionCurve!) {
      expect(v).toBeGreaterThanOrEqual(5);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it("derives swipe-away, returning viewers and subs, deterministically", async () => {
    const a = await analytics.fetchVideoStats(req);
    const b = await analytics.fetchVideoStats(req);
    // curve + derived signals are time-independent (seeded from the video id)
    expect(a.retentionCurve).toEqual(b.retentionCurve);
    expect(a.swipeAwayPct).toBe(b.swipeAwayPct);
    expect(a.swipeAwayPct!).toBeGreaterThanOrEqual(0);
    expect(a.swipeAwayPct!).toBeLessThanOrEqual(95);
    expect(a.returningViewerPct!).toBeGreaterThan(0);
    expect(a.subsGained!).toBeGreaterThanOrEqual(0);
  });
});

describe("mock LLM analysis generators", () => {
  const llm = createMockLLMProvider();

  it("routes TASK:hook-analysis to schema-valid output with hold-based tags", async () => {
    const res = await generateObject({
      model: llm.model("agentic"),
      schema: hookAnalysisSchema,
      system: "TASK:hook-analysis — classify and assess this hook",
      prompt: [
        "HOOK LINE: Ever wondered why the sky is blue? The real answer is stranger.",
        "NICHE: everyday science",
        "3-SECOND HOLD: 82%",
        "CHANNEL AVG % VIEWED: 60%",
        "THIS VIDEO % VIEWED: 70%",
        "SWIPE-AWAY (0-3s): 18%",
        "RETENTION CURVE (%): 100, 92, 85, 80",
      ].join("\n"),
    });
    expect(["curiosity_gap", "pattern_interrupt", "stakes_first", "contrarian"]).toContain(
      res.object.archetype,
    );
    // 82% >= 70 → strong hold tag; beats the 60% channel avg
    expect(res.object.tags).toContain("strong-3s-hold");
    expect(res.object.tags).toContain("above-channel-avg");
    expect(res.object.assessment.length).toBeGreaterThan(20);
  });

  it("routes TASK:script-analysis, flagging beats and locating the retention dip", async () => {
    const res = await generateObject({
      model: llm.model("agentic"),
      schema: scriptAnalysisSchema,
      system: "TASK:script-analysis — assess beat by beat",
      prompt: [
        "NICHE: everyday science",
        "DURATION: 35s",
        "AVG % VIEWED: 60%",
        "BEATS (type @ start-end, retention% at start):",
        "  0. hook @ 0-3s (ret 100%): opening hook line",
        "  1. stat @ 3-12s (ret 78%): the surprising statistic",
        "  2. insight @ 12-25s (ret 55%): the mechanism",
        "  3. cta @ 25-35s (ret 40%): follow for more",
      ].join("\n"),
    });
    expect(res.object.beats).toHaveLength(4);
    // ret 100 holds, ret 40 leaks
    expect(res.object.beats[0]!.working).toBe(true);
    expect(res.object.beats[3]!.working).toBe(false);
    // biggest consecutive drop is 78→55 (23 pts) at index 2
    expect(res.object.dipBeatIndex).toBe(2);
    expect(res.object.trimSuggestion.length).toBeGreaterThan(10);
  });

  it("prefers script-analysis over the script route (substring guard)", async () => {
    // "TASK:script-analysis".includes("TASK:script") — ordering must not misroute
    const res = await generateObject({
      model: llm.model("agentic"),
      schema: scriptAnalysisSchema,
      system: "TASK:script-analysis",
      prompt: [
        "BEATS (type @ start-end, retention% at start):",
        "  0. hook @ 0-3s (ret 90%): x",
        "  1. cta @ 3-10s (ret 60%): y",
      ].join("\n"),
    });
    expect(res.object.beats.length).toBeGreaterThanOrEqual(2);
  });
});
