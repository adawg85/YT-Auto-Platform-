import { generateObject } from "ai";
import { thumbnailScoreSchema, type ThumbnailScore } from "@ytauto/core";
import { runAgent, type AgentCtx, repairDoubleEncodedJson } from "./run-agent";

/**
 * Predicted-CTR scoring for thumbnail candidates (spec §5.5). v1 scores from
 * the candidate's textual description (prompt + spec); a vision model over
 * the actual image is the upgrade path.
 */
export async function scoreThumbnailCandidate(
  ctx: AgentCtx,
  candidateDescription: string,
): Promise<ThumbnailScore> {
  return runAgent(
    "thumbnail_scorer",
    "cheap",
    ctx,
    `score thumbnail: ${candidateDescription.slice(0, 60)}`,
    async (model) => {
      const res = await generateObject({
        model,
        schema: thumbnailScoreSchema,
        experimental_repairText: repairDoubleEncodedJson,
        system:
          "TASK:thumbnail-score — Predict click-through rate (percent) for this Shorts thumbnail based on focal clarity, contrast, text economy, and curiosity. Be a harsh grader.",
        prompt: `CANDIDATE: ${candidateDescription}`,
      });
      return { object: res.object, usage: res.usage };
    },
  );
}
