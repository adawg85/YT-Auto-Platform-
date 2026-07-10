import { generateObject } from "ai";
import { factualityProofSchema, type FactualityProof } from "@ytauto/core";
import { runAgent, repairDoubleEncodedJson, type AgentCtx } from "./run-agent";

/**
 * Scripting-stage factuality proof (BACKLOG #20). Audits a draft against the
 * episode's VERIFIED FACTS *before* any asset spend: the pipeline runs this
 * inside the scripting stage with a bounded proof → rewrite loop, so a script
 * with unsupported claims is rewritten (or held) at the cost of an LLM call —
 * not caught at assembly after the voiceover + images were already paid for.
 * The review board's compliance checker stays as the pre-render backstop.
 */
export async function proveScriptFactuality(
  ctx: AgentCtx,
  input: {
    hookText: string;
    fullText: string;
    verifiedFacts: { id: string; tier: string; text: string }[];
  },
): Promise<FactualityProof> {
  return runAgent(
    "factuality_proof",
    "agentic",
    ctx,
    `factuality proof over script draft (${input.verifiedFacts.length} verified facts)`,
    async (model) => {
      const res = await generateObject({
        model,
        schema: factualityProofSchema,
        experimental_repairText: repairDoubleEncodedJson,
        system:
          "TASK:factuality-proof — You are a factuality auditor. List every SPECIFIC factual claim " +
          "in the SCRIPT (a statistic, date, name, event, measurement, or causal assertion) that is " +
          "not supported by the VERIFIED FACTS list. Paraphrase and elaboration of a verified fact " +
          "are supported; claims tagged [emerging]/[contested] count as supported only when the " +
          "script frames them as reported/claimed rather than asserting them. Framing, transitions, " +
          "opinions, rhetorical questions and vivid non-factual description are NOT claims — do not " +
          "flag them. pass=true only when nothing is unsupported.",
        prompt: [
          `HOOK: ${input.hookText}`,
          `SCRIPT: ${input.fullText}`,
          `VERIFIED FACTS:\n${input.verifiedFacts.map((f) => `- [${f.tier}] ${f.text}`).join("\n")}`,
        ].join("\n\n"),
      });
      return { object: res.object, usage: res.usage };
    },
  );
}

/** The rewrite instruction fed back to the scriptwriter when the proof fails. */
export function factualityRewriteNote(proof: FactualityProof): string {
  return [
    "FACTUALITY REWRITE: the previous draft asserted claims the VERIFIED FACTS do not support.",
    "Remove or rewrite each of these so the script asserts ONLY the verified facts (reach length by elaborating them, never by inventing substance):",
    ...proof.unsupportedClaims.map((c) => `- ${c.claim} (${c.why})`),
  ].join("\n");
}
