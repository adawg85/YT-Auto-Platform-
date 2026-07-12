import {
  aiTellMetrics,
  type EvalMetrics,
  type ScriptJudgeScores,
  type ScriptOutput,
} from "@ytauto/core";
import { draftScript } from "../scriptwriter";
import { humanizeScript } from "../humanize";
import { proveScriptFactuality } from "../factuality-proof";
import type { AgentCtx } from "../run-agent";
import { judgeScriptQuality } from "./judge";
import type { GoldenFixture } from "./golden-set";

/**
 * Eval harness chain (#21.2.5). Two halves with different LLM contexts:
 *
 * - runEvalChain: draft → humanize on the CANDIDATE model (ctx.llm is a
 *   createEvalLLM router whose frontier+agentic tiers route to the candidate).
 *   First-pass quality only — no proof→repair loop, so a weak model can't
 *   burn rewrites into a passing-but-expensive script.
 * - measureScript: factuality proof + judge on the BASE router (fixed
 *   instruments) + deterministic metrics — comparable across candidates.
 */
export async function runEvalChain(ctx: AgentCtx, fixture: GoldenFixture): Promise<ScriptOutput> {
  const draft = await draftScript(
    ctx,
    { id: fixture.id, channelId: ctx.channelId, title: fixture.title, angle: fixture.angle },
    {
      tone: fixture.tone,
      audiencePersona: fixture.audiencePersona,
      hookStyles: fixture.hookStyles,
      // fixed neutral values — the eval grades narration, not visuals
      visualStyle: { primaryColor: "#1f2937", font: "Inter", imageStyle: "archival documentary photography" },
      voiceId: "default",
      ctaTemplate: "Follow for more.",
      targetLengthSec: fixture.targetLengthSec,
    },
    {
      targetLengthSec: fixture.targetLengthSec,
      verifiedFacts: fixture.verifiedFacts.length ? fixture.verifiedFacts : undefined,
      conjecture: fixture.conjecture.length ? fixture.conjecture : undefined,
      factualityMode: fixture.factualityMode,
      persona: fixture.persona,
      evalMeta: { niche: fixture.niche, contentFormat: fixture.contentFormat },
    },
  );
  return humanizeScript(ctx, {
    script: draft,
    persona: fixture.persona,
    factualityMode: fixture.factualityMode,
    kind: fixture.contentFormat === "long" ? "long-form video" : "Short",
  });
}

const SPEAKING_WPS = 2.5;

export async function measureScript(
  ctx: AgentCtx,
  input: {
    fixture: GoldenFixture;
    script: ScriptOutput;
    modelRef: string;
    /** candidate-chain spend/latency, captured by the caller around runEvalChain */
    costUsd: number;
    durationMs: number;
  },
): Promise<{ judge: ScriptJudgeScores; metrics: EvalMetrics }> {
  const { fixture, script } = input;

  // Fixed factuality instrument — entertainment fixtures skip it (facts are
  // inspiration there, not constraints; the proof itself is mode-aware but a
  // zero keeps the metric meaningful across the set).
  let unsupportedClaims = 0;
  if (fixture.verifiedFacts.length && fixture.factualityMode !== "entertainment") {
    const proof = await proveScriptFactuality(ctx, {
      hookText: script.hookText,
      fullText: script.fullText,
      verifiedFacts: fixture.verifiedFacts,
      conjecture: fixture.conjecture,
      factualityMode: fixture.factualityMode,
    });
    unsupportedClaims = proof.pass ? 0 : proof.unsupportedClaims.length;
  }

  const judge = await judgeScriptQuality(ctx, { fixture, script, modelRef: input.modelRef });

  const tells = aiTellMetrics(script.fullText);
  const wordBudget = fixture.targetLengthSec * SPEAKING_WPS;
  const metrics: EvalMetrics = {
    ...tells,
    targetAdherencePct: wordBudget
      ? Math.round((tells.words / wordBudget) * 1000) / 10
      : 0,
    unsupportedClaims,
    beatCount: script.beats.length,
    costUsd: Math.round(input.costUsd * 1e6) / 1e6,
    durationMs: input.durationMs,
  };

  return { judge, metrics };
}
