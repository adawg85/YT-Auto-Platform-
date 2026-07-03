import { generateObject } from "ai";
import { similarityVerdictSchema, type SimilarityVerdict } from "@ytauto/core";
import { runAgent, type AgentCtx } from "./run-agent";

/**
 * LLM escalation for borderline variation-check results (cheap tier).
 * The Jaccard score is included so the mock can mirror it deterministically.
 */
export async function judgeSimilarity(
  ctx: AgentCtx,
  candidate: string,
  closestPrior: string,
  jaccardScore: number,
): Promise<SimilarityVerdict> {
  return runAgent(
    "variation_judge",
    "cheap",
    ctx,
    `judge similarity (jaccard=${jaccardScore.toFixed(3)})`,
    async (model) => {
      const res = await generateObject({
        model,
        schema: similarityVerdictSchema,
        system:
          "TASK:similarity — Decide whether two Shorts substance fingerprints describe materially the same video substance (same facts/claims/mechanism), not merely the same format or topic area. Consistent format is fine; near-duplicate substance is not.",
        prompt: [
          `CANDIDATE FINGERPRINT: ${candidate}`,
          `CLOSEST PRIOR FINGERPRINT: ${closestPrior}`,
          `JACCARD SIMILARITY: ${jaccardScore.toFixed(3)}`,
        ].join("\n"),
      });
      return { object: res.object, usage: res.usage };
    },
  );
}
