import { generateObject } from "ai";
import {
  thumbnailDeconstructSchema,
  thumbnailScoreSchema,
  type ThumbnailDeconstruct,
  type ThumbnailScore,
} from "@ytauto/core";
import { runAgent, type AgentCtx, repairDoubleEncodedJson } from "./run-agent";

/**
 * Predicted-CTR scoring for thumbnail candidates (spec §5.5), v2: VISION.
 * The model sees the actual generated pixels (same messages pattern as
 * image-score.ts) and judges the thumbnail at feed size — where the click
 * decision really happens. Cheap (vision-capable) tier. Callers keep
 * scoreThumbnailFromPrompt as the fallback when the bytes can't be read.
 */
export async function scoreThumbnailCandidate(
  ctx: AgentCtx,
  input: { image: Uint8Array | Buffer; mimeType: string; title: string },
): Promise<ThumbnailScore> {
  return runAgent(
    "thumbnail_scorer",
    "cheap",
    ctx,
    `score thumbnail: ${input.title.slice(0, 60)}`,
    async (model) => {
      const res = await generateObject({
        model,
        schema: thumbnailScoreSchema,
        experimental_repairText: repairDoubleEncodedJson,
        system:
          "TASK:thumbnail-score — You judge YouTube thumbnails AT FEED SIZE (~120px tall), where the click " +
          "decision happens. Score: focal clarity at 120px (is there ONE instantly readable subject?), " +
          "contrast (does the subject pop from the background?), curiosity/emotion (does it create tension " +
          "or a question?), and text legibility (3 words max — more, or small text, is a penalty; none is fine). " +
          "predictedCtr is a percent 0–20; critique in one or two sentences. Be a harsh grader.",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `CANDIDATE: ${input.title}\nJudge the attached thumbnail as it would appear in the feed.`,
              },
              { type: "image", image: input.image, mediaType: input.mimeType },
            ],
          },
        ],
      });
      return { object: res.object, usage: res.usage };
    },
  );
}

/**
 * Text-only fallback (the v1 path): score from the candidate's prompt/spec
 * description when the image bytes can't be fetched or vision scoring fails.
 */
export async function scoreThumbnailFromPrompt(
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

/**
 * #35.3: deconstruct a WINNING thumbnail (a niche outlier's, fetched free
 * from i.ytimg.com) into its transferable click mechanics — composition,
 * subject treatment, text, palette, emotion. Pattern learning, not copying:
 * only the SHAPE is stored (pattern store kind "thumbnail"); our generations
 * model the shape onto OUR subject.
 */
export async function deconstructThumbnail(
  ctx: AgentCtx,
  input: {
    image: Uint8Array | Buffer;
    mimeType: string;
    title: string;
    /** performance context so the analysis anchors on WHY it won */
    stats: string;
  },
): Promise<ThumbnailDeconstruct> {
  return runAgent(
    "thumbnail_deconstructor",
    "cheap",
    ctx,
    `deconstruct winner thumbnail: ${input.title.slice(0, 60)}`,
    async (model) => {
      const res = await generateObject({
        model,
        schema: thumbnailDeconstructSchema,
        experimental_repairText: repairDoubleEncodedJson,
        system:
          "TASK:thumb-deconstruct — You reverse-engineer WINNING YouTube thumbnails. The attached " +
          "thumbnail belongs to a video that is dramatically over-performing its niche. Extract the " +
          "TRANSFERABLE pattern — composition formula, subject treatment, text treatment, palette, " +
          "emotion — the way a picture editor would brief a designer to make a NEW thumbnail in the " +
          "same style for a different subject. Never describe the literal subject as the pattern; " +
          "describe the mechanics that make it clickable at feed size (~120px).",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `WINNER: "${input.title}" — ${input.stats}\nDeconstruct the attached thumbnail.`,
              },
              { type: "image", image: input.image, mediaType: input.mimeType },
            ],
          },
        ],
      });
      return { object: res.object, usage: res.usage };
    },
  );
}
