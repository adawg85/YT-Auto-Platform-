import { generateObject } from "ai";
import {
  applyScriptRepair,
  personaSystemBlock,
  repairedScriptSchema,
  type FactualityMode,
  type PersonaDoc,
  type ScriptOutput,
} from "@ytauto/core";
import { temperatureFor } from "@ytauto/providers";
import { runAgent, repairDoubleEncodedJson, type AgentCtx } from "./run-agent";

/**
 * Surgical factuality repair (scripting-loop incident fix). When the
 * factuality proof flags unsupported claims, the pipeline used to RE-DRAFT the
 * whole script with revision notes — and the fresh draft invented new
 * narrative glue that created NEW unsupported claims (observed 14→10→5
 * whack-a-mole convergence in prod). This agent instead rewrites ONLY the
 * sentences carrying the flagged claims and preserves everything else
 * verbatim, so each proof→repair cycle strictly shrinks the problem.
 *
 * Fail-safe (in `applyScriptRepair`, pure + unit-tested): a beat-count
 * mismatch or a >20% word-count shrink returns the original script unchanged,
 * so the proof loop then holds the production exactly as before.
 */
export async function repairScriptFactuality(
  ctx: AgentCtx,
  input: {
    script: ScriptOutput;
    unsupportedClaims: { claim: string; why: string }[];
    verifiedFacts: { id: string; tier: string; text: string }[];
    conjecture?: { id: string; tier: string; text: string }[];
    factualityMode?: FactualityMode;
    persona?: PersonaDoc;
  },
): Promise<ScriptOutput> {
  const mode: FactualityMode = input.factualityMode ?? "strict";
  const hedgingAllowed = mode === "balanced" || mode === "entertainment";

  const system = [
    "TASK:script-repair — You are a surgical fact editor. The script is APPROVED except for the",
    "listed unsupported claims. Rewrite ONLY the sentences containing those claims — for each:",
    "either ground it in a VERIFIED FACT," +
      (hedgingAllowed
        ? " hedge it honestly ('as far as either of them knew', 'the records suggest', 'the story goes') — this channel's factuality mode allows honest hedging,"
        : "") +
      " or remove it and smooth the join.",
    "Every other sentence must be preserved VERBATIM — same voice, same order, same beat count.",
    "Do not add new facts, names, numbers, dates or events.",
    input.persona ? "\n" + personaSystemBlock(input.persona) : "",
  ]
    .filter(Boolean)
    .join("\n");

  const prompt = [
    `FACTUALITY MODE: ${mode}`,
    `UNSUPPORTED CLAIMS (rewrite ONLY the sentences containing these):\n${input.unsupportedClaims
      .map((c) => `- ${c.claim} (${c.why})`)
      .join("\n")}`,
    `VERIFIED FACTS (the only facts you may ground a claim in):\n${input.verifiedFacts
      .map((f) => `- [${f.tier}] ${f.text}`)
      .join("\n")}`,
    input.conjecture?.length
      ? `CONJECTURE (tellable ONLY with hedged framing):\n${input.conjecture
          .map((c) => `- ${c.text}`)
          .join("\n")}`
      : "",
    [
      `HOOK: ${input.script.hookText}`,
      "BEATS:",
      ...input.script.beats.map((b, i) => `${i + 1}. [${b.type}] ${b.text}`),
    ].join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");

  const out = await runAgent(
    "script_repair",
    "agentic",
    ctx,
    `surgical factuality repair: ${input.unsupportedClaims.length} unsupported claim(s) over ${input.script.beats.length}-beat script`,
    async (model) => {
      const res = await generateObject({
        model,
        schema: repairedScriptSchema,
        experimental_repairText: repairDoubleEncodedJson,
        temperature: temperatureFor(ctx.llm.modelId("agentic"), "judge"),
        system,
        prompt,
      });
      return { object: res.object, usage: res.usage };
    },
  );

  return applyScriptRepair(input.script, out);
}
