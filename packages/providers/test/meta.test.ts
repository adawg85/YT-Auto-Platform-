/**
 * Meta-analysis engine (build #4): the mock research feeds + the mock-LLM meta
 * routes. Deterministic and keyless, so the whole market-scan loop is
 * exercisable in CI without a DB or API keys.
 */
import { describe, expect, it } from "vitest";
import { generateObject } from "ai";
import {
  createMemoryCostSink,
  metaHookSchema,
  metaScriptStructureSchema,
  topicClusterSchema,
} from "@ytauto/core";
import { createMockLLMProvider } from "../src/mock/llm";
import { createMockResearchProvider } from "../src/mock/research";

const costs = createMemoryCostSink();

describe("mock research feeds", () => {
  const research = createMockResearchProvider(costs);

  it("outliers carry a stable externalId and velocity", async () => {
    const a = await research.outliers("physics");
    const b = await research.outliers("physics");
    expect(a).toEqual(b);
    expect(a).toHaveLength(5);
    for (const o of a) {
      expect(o.externalId).toMatch(/^out-/);
      expect(o.viewsPerHour).toBeGreaterThan(0);
    }
  });

  it("breakout channels are deterministic with a top video", async () => {
    const a = await research.breakoutChannels("physics");
    const b = await research.breakoutChannels("physics");
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
    expect(a[0]!.topVideo.externalId).toMatch(/^bvid-/);
    expect(a[0]!.growthRate).toBeGreaterThan(0);
  });

  it("trending videos are deterministic and shorts-format", async () => {
    const a = await research.trendingVideos("physics");
    expect(a).toEqual(await research.trendingVideos("physics"));
    expect(a[0]!.format).toBe("shorts");
    expect(a[0]!.engagementRate).toBeGreaterThan(0);
  });

  it("transcripts are stable per id and hook-first", async () => {
    const t1 = await research.transcript("out-1234567");
    const t2 = await research.transcript("out-1234567");
    expect(t1).toBe(t2);
    expect(t1!.length).toBeGreaterThan(40);
    // ends on a CTA-style close
    expect(t1!.toLowerCase()).toContain("follow for more");
  });
});

describe("mock LLM meta-analysis routes", () => {
  const llm = createMockLLMProvider();
  const transcriptPrompt = [
    "NICHE: everyday science",
    "TITLE: Why the sky is blue",
    "TRANSCRIPT: Nobody tells you this about the sky, but it changes everything. First, the setup. Here's the proof. The mechanism is simple. Follow for more.",
  ].join("\n");

  it("routes TASK:meta-hook to a schema-valid classified hook", async () => {
    const res = await generateObject({
      model: llm.model("cheap"),
      schema: metaHookSchema,
      system: "TASK:meta-hook — classify the scouted hook",
      prompt: transcriptPrompt,
    });
    expect(["curiosity_gap", "pattern_interrupt", "stakes_first", "contrarian"]).toContain(
      res.object.archetype,
    );
    expect(res.object.tags).toContain("external-scout");
    expect(res.object.label.length).toBeGreaterThan(0);
  });

  it("routes TASK:meta-script to a beat sequence + label (not misrouted to TASK:script)", async () => {
    const res = await generateObject({
      model: llm.model("cheap"),
      schema: metaScriptStructureSchema,
      system: "TASK:meta-script — segment the structure",
      prompt: transcriptPrompt,
    });
    expect(res.object.beatSequence.length).toBeGreaterThanOrEqual(2);
    expect(res.object.beatSequence[0]).toBe("hook");
    expect(res.object.label).toContain("→");
  });

  it("routes TASK:topic-cluster over rising titles", async () => {
    const res = await generateObject({
      model: llm.model("cheap"),
      schema: topicClusterSchema,
      system: "TASK:topic-cluster — cluster rising angles",
      prompt: ["NICHE: everyday science", "RISING TITLES:", "- why magnets are cold", "- the truth about friction"].join("\n"),
    });
    expect(res.object.signals.length).toBeGreaterThanOrEqual(1);
    for (const s of res.object.signals) {
      expect(s.momentum).toBeGreaterThanOrEqual(0);
      expect(s.momentum).toBeLessThanOrEqual(100);
    }
  });
});
