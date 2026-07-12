import { generateObject } from "ai";
import { clampScore, scriptJudgeSchema, type ScriptJudgeScores, type ScriptOutput } from "@ytauto/core";
import { temperatureFor } from "@ytauto/providers";
import { runAgent, repairDoubleEncodedJson, type AgentCtx } from "../run-agent";
import type { GoldenFixture } from "./golden-set";

/**
 * Eval judge (#21.2.5): scores one produced script against the rubric — fact
 * compliance, hook strength, voice naturalness, overall. This is a FIXED
 * measurement instrument: it always runs on the base router's agentic tier
 * (never the candidate model), so scores are comparable across candidates.
 * Judge temperature (0.2) per the temperature policy.
 */
export async function judgeScriptQuality(
  ctx: AgentCtx,
  input: { fixture: GoldenFixture; script: ScriptOutput; modelRef: string },
): Promise<ScriptJudgeScores> {
  const { fixture, script } = input;
  const system =
    "TASK:script-judge — You are a ruthless script quality judge for faceless YouTube narration. " +
    "Score the SCRIPT on the rubric, 0-10 each. You are grading craft, not topic choice. " +
    "factCompliance: every specific factual claim must be supported by the VERIFIED FACTS " +
    "(or properly hedged per the rigor mode); unsupported assertions cost points fast. " +
    "hookStrength: would the first two seconds stop a scroller — specificity, tension, open loop. " +
    "voiceNaturalness: read it aloud in your head — one real person talking scores high; " +
    "AI-flavored filler ('isn't just', 'delve', symmetric sentence rhythm) scores low. " +
    "overall: publishable quality as a whole. Be calibrated: 5 is mediocre-but-usable, " +
    "8+ means you would struggle to improve it, 3 or less means you would not publish it.";

  const prompt = [
    `FORMAT: ${fixture.contentFormat === "long" ? "long-form video" : "YouTube Short"} (~${fixture.targetLengthSec}s target)`,
    `RIGOR MODE: ${fixture.factualityMode}`,
    `IDEA: ${fixture.title} — ${fixture.angle}`,
    fixture.verifiedFacts.length
      ? `VERIFIED FACTS:\n${fixture.verifiedFacts.map((f) => `- ${f.text}`).join("\n")}`
      : "",
    fixture.conjecture.length
      ? `CONJECTURE (tellable only with hedged framing):\n${fixture.conjecture.map((f) => `- ${f.text}`).join("\n")}`
      : "",
    `HOOK: ${script.hookText}`,
    `SCRIPT:\n${script.fullText}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const raw = await runAgent(
    "eval_judge",
    "agentic",
    ctx,
    `judge ${input.modelRef} on ${fixture.id}`,
    async (model) => {
      const res = await generateObject({
        model,
        schema: scriptJudgeSchema,
        experimental_repairText: repairDoubleEncodedJson,
        temperature: temperatureFor(ctx.llm.modelId("agentic"), "judge"),
        system,
        prompt,
      });
      return { object: res.object, usage: res.usage };
    },
  );

  return {
    factCompliance: clampScore(raw.factCompliance),
    hookStrength: clampScore(raw.hookStrength),
    voiceNaturalness: clampScore(raw.voiceNaturalness),
    overall: clampScore(raw.overall),
    rationale: raw.rationale,
  };
}
