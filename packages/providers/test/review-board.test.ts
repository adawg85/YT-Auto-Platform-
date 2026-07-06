/**
 * Build #5.2 mock-LLM routes: the four review-board checkers, the briefing
 * composer, and the experiment narrator — deterministic and keyless so the
 * pre-publish board + check-in loop run in CI with zero keys.
 */
import { describe, expect, it } from "vitest";
import { generateObject } from "ai";
import {
  boardCheckSchema,
  boardQualitySchema,
  briefingComposeSchema,
  experimentConcludeSchema,
} from "@ytauto/core";
import { createMockLLMProvider } from "../src/mock/llm";

const llm = createMockLLMProvider();

const SCRIPT_BLOCK = (script: string) =>
  [
    "IDEA TITLE: The Concorde story",
    "IDEA ANGLE: How it entered service and why it mattered.",
    "HOOK: Everything you've heard about this is backwards.",
    `SCRIPT: ${script}`,
  ].join("\n");

describe("review board checkers (mock)", () => {
  it("compliance passes a clean script and fails a forbidden topic", async () => {
    const clean = await generateObject({
      model: llm.model("agentic"),
      schema: boardCheckSchema,
      system: "TASK:board-compliance",
      prompt: [
        SCRIPT_BLOCK("The Concorde entered service in 1976 and crossed the Atlantic in 3.5 hours."),
        "FORBIDDEN TOPICS: health advice; financial advice; current politics",
        "VERIFIED FACTS:\n- [established] The Concorde entered service in 1976.",
      ].join("\n\n"),
    });
    expect(clean.object.pass).toBe(true);

    const dirty = await generateObject({
      model: llm.model("agentic"),
      schema: boardCheckSchema,
      system: "TASK:board-compliance",
      prompt: [
        SCRIPT_BLOCK("Forget planes — here is some financial advice: buy airline stocks."),
        "FORBIDDEN TOPICS: health advice; financial advice; current politics",
      ].join("\n\n"),
    });
    expect(dirty.object.pass).toBe(false);
    expect(dirty.object.issues.join(" ")).toContain("financial advice");
  });

  it("alignment passes normal scripts and fails planted off-brand content", async () => {
    const ok = await generateObject({
      model: llm.model("agentic"),
      schema: boardCheckSchema,
      system: "TASK:board-alignment",
      prompt: [SCRIPT_BLOCK("A tight retelling of the Concorde's service years."), "MISSION: aviation history"].join("\n\n"),
    });
    expect(ok.object.pass).toBe(true);

    const bad = await generateObject({
      model: llm.model("agentic"),
      schema: boardCheckSchema,
      system: "TASK:board-alignment",
      prompt: [SCRIPT_BLOCK("And now a sponsored segment about kitchen knives."), "MISSION: aviation history"].join("\n\n"),
    });
    expect(bad.object.pass).toBe(false);
  });

  it("safety fails policy-risk content and passes normal scripts", async () => {
    const bad = await generateObject({
      model: llm.model("agentic"),
      schema: boardCheckSchema,
      system: "TASK:board-safety",
      prompt: SCRIPT_BLOCK("The crash scene was pure gore, shown frame by frame."),
    });
    expect(bad.object.pass).toBe(false);
    expect(bad.object.issues.length).toBeGreaterThan(0);

    const ok = await generateObject({
      model: llm.model("agentic"),
      schema: boardCheckSchema,
      system: "TASK:board-safety",
      prompt: SCRIPT_BLOCK("The Concorde's final flight drew crowds across London."),
    });
    expect(ok.object.pass).toBe(true);
  });

  it("quality predicts retention deterministically", async () => {
    const run = () =>
      generateObject({
        model: llm.model("agentic"),
        schema: boardQualitySchema,
        system: "TASK:board-quality",
        prompt: [
          SCRIPT_BLOCK("The Concorde entered service in 1976."),
          "PATTERNS (what's working in this niche now):\n- [external] contrarian-claim (score 80, seen in 4)",
        ].join("\n\n"),
      });
    const a = await run();
    const b = await run();
    expect(a.object.predictedRetention).toBe(b.object.predictedRetention);
    expect(a.object.predictedRetention).toBeGreaterThanOrEqual(45);
    expect(a.object.predictedRetention).toBeLessThanOrEqual(90);
  });
});

describe("briefing composer (mock)", () => {
  const FACTS = (activeExperiment: string) =>
    [
      "CHANNEL: The Aviation Files (niche: aviation history, cadence: weekly)",
      "PERIOD: 2026-06-29 → 2026-07-06",
      "PUBLISHED: 4 videos, 12000 views, avg 58% viewed",
      "OPEN: 1 review gates, 0 alerts",
      "SPEND: $3.20 this period",
      'ACTIVE SERIES: "Machines and Milestones" (5 episodes remaining)',
      `ACTIVE EXPERIMENT: ${activeExperiment}`,
    ].join("\n");

  it("proposes at most one experiment, and only when none is active", async () => {
    const idle = await generateObject({
      model: llm.model("agentic"),
      schema: briefingComposeSchema,
      system: "TASK:briefing",
      prompt: FACTS("none"),
    });
    const experiments = idle.object.suggestions.filter((s) => s.kind === "experiment");
    expect(experiments).toHaveLength(1);
    expect(experiments[0]!.experiment?.variable).toBeTruthy();
    expect(experiments[0]!.experiment?.directive).toBeTruthy();

    const busy = await generateObject({
      model: llm.model("agentic"),
      schema: briefingComposeSchema,
      system: "TASK:briefing",
      prompt: FACTS("hook_style → contrarian (n=1 so far)"),
    });
    expect(busy.object.suggestions.filter((s) => s.kind === "experiment")).toHaveLength(0);
    expect(busy.object.question.length).toBeGreaterThan(10);
  });

  it("routes TASK:briefing ahead of the TASK:brief substring", async () => {
    // "TASK:briefing".includes("TASK:brief") — ordering must not misroute to episodeBrief
    const res = await generateObject({
      model: llm.model("agentic"),
      schema: briefingComposeSchema,
      system: "TASK:briefing — compose the operator check-in",
      prompt: FACTS("none"),
    });
    expect(res.object.whatHappened.length).toBeGreaterThan(10);
  });
});

describe("experiment narrator (mock)", () => {
  it("narrates without contradicting the computed verdict", async () => {
    const res = await generateObject({
      model: llm.model("agentic"),
      schema: experimentConcludeSchema,
      system: "TASK:experiment-conclude",
      prompt: [
        "VARIABLE: hook_style",
        "HYPOTHESIS: Contrarian openers lift retention.",
        "BASELINE: mixed hook styles",
        "VARIANT: contrarian-first",
        "VERDICT: win",
        "READOUT: avgPctViewed moved +16.0% vs baseline (58.0 vs 50.0, n=3)",
      ].join("\n"),
    });
    expect(res.object.outcome).toContain("win");
    expect(res.object.outcome).toContain("hook_style");
  });
});
