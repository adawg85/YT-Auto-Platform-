import { generateObject } from "ai";
import { factualityProofSchema, type FactualityMode, type FactualityProof } from "@ytauto/core";
import { temperatureFor } from "@ytauto/providers";
import { runAgent, repairDoubleEncodedJson, type AgentCtx } from "./run-agent";

/** Mode-specific auditor briefs (BACKLOG #21.3). */
function proofSystem(mode: FactualityMode): string {
  const shared =
    "Framing, transitions, opinions, rhetorical questions and vivid non-factual description are " +
    "NOT claims — do not flag them. pass=true only when nothing violates the rules above.";
  if (mode === "entertainment") {
    return (
      "TASK:factuality-proof — You are the harm auditor for a fun, entertainment-first script. " +
      "This channel does NOT assert rigor, so do not police unsupported claims in general. Flag " +
      "ONLY a checkable real-world claim that is stated as fact, is likely FALSE or misleading, " +
      "and a reasonable viewer would take literally (safety, health, history, science, money). " +
      "Jokes, exaggeration for effect, obvious fiction, and framed speculation all pass. " +
      shared
    );
  }
  if (mode === "balanced") {
    return (
      "TASK:factuality-proof — You are a FRAMING auditor. This channel may tell uncorroborated " +
      "material as long as it is framed honestly. Flag a claim only when it is asserted AS " +
      "ESTABLISHED FACT and is neither supported by the VERIFIED FACTS list nor hedged. " +
      "Anything framed as reported/legend/debate/unknown ('the story goes', 'according to " +
      "legend', 'historians still argue', 'no one knows') passes, including items from the " +
      "CONJECTURE list — those must appear ONLY with such framing; flag any CONJECTURE item " +
      "stated flatly as fact. Paraphrase and elaboration of a verified fact are supported. " +
      shared
    );
  }
  return (
    "TASK:factuality-proof — You are a factuality auditor. List every SPECIFIC factual claim " +
    "in the SCRIPT (a statistic, date, name, event, measurement, or causal assertion) that is " +
    "not supported by the VERIFIED FACTS list. Paraphrase and elaboration of a verified fact " +
    "are supported; claims tagged [emerging]/[contested] count as supported only when the " +
    "script frames them as reported/claimed rather than asserting them. " +
    shared
  );
}

/**
 * Scripting-stage factuality proof (BACKLOG #20, mode-aware since #21.3).
 * Audits a draft against the episode's VERIFIED FACTS *before* any asset
 * spend: the pipeline runs this inside the scripting stage with a bounded
 * proof → rewrite loop, so a script with unsupported claims is rewritten (or
 * held) at the cost of an LLM call — not caught at assembly after the
 * voiceover + images were already paid for. The review board's compliance
 * checker stays as the pre-render backstop. What "unsupported" means depends
 * on the channel's factuality mode: strict audits support, balanced audits
 * FRAMING, entertainment audits only real-world harm.
 */
export async function proveScriptFactuality(
  ctx: AgentCtx,
  input: {
    hookText: string;
    fullText: string;
    verifiedFacts: { id: string; tier: string; text: string }[];
    conjecture?: { id: string; text: string }[];
    factualityMode?: FactualityMode;
  },
): Promise<FactualityProof> {
  const mode: FactualityMode = input.factualityMode ?? "strict";
  return runAgent(
    "factuality_proof",
    "agentic",
    ctx,
    `factuality proof (${mode}) over script draft (${input.verifiedFacts.length} verified facts)`,
    async (model, modelId) => {
      const res = await generateObject({
        model,
        schema: factualityProofSchema,
        experimental_repairText: repairDoubleEncodedJson,
        temperature: temperatureFor(modelId, "judge"),
        system: proofSystem(mode),
        prompt: [
          `HOOK: ${input.hookText}`,
          `SCRIPT: ${input.fullText}`,
          `VERIFIED FACTS:\n${input.verifiedFacts.map((f) => `- [${f.tier}] ${f.text}`).join("\n")}`,
          input.conjecture?.length
            ? `CONJECTURE (allowed ONLY with hedged framing):\n${input.conjecture.map((c) => `- ${c.text}`).join("\n")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
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
