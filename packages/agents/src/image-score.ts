import { generateObject } from "ai";
import { imageFitSchema, type ImageFit } from "@ytauto/core";
import { runAgent, type AgentCtx, repairDoubleEncodedJson } from "./run-agent";

/**
 * Minimum fit score to KEEP a sourced reference image. Below this (or `fits`
 * false) the pipeline discards the real photo and generates a fitting image
 * instead. 5/10 = "roughly on-subject"; stricter than that rejects too much.
 */
export const IMAGE_FIT_MIN = 5;

/**
 * Vision relevance check (BACKLOG #18 #4 cut 2). Wikimedia returns *an* image
 * for an entity, but it may be a diagram, a map, a logo, a portrait when we
 * want the object, a bad crop, or simply the wrong thing. A multimodal model
 * looks at the actual pixels and rates whether the photo fits this shot; a poor
 * score sends the pipeline to generation instead. Uses the cheap (vision-
 * capable) tier; callers treat a thrown error as "keep the image" (fail-safe).
 */
export async function scoreImageFit(
  ctx: AgentCtx,
  input: {
    image: Uint8Array | Buffer;
    mimeType: string;
    shotText: string;
    imagePrompt: string;
    entity: string;
  },
): Promise<ImageFit> {
  return runAgent(
    "image_fit_scorer",
    "cheap",
    ctx,
    `score image fit: ${input.entity}`,
    async (model) => {
      const res = await generateObject({
        model,
        schema: imageFitSchema,
        experimental_repairText: repairDoubleEncodedJson,
        system:
          "TASK:image-fit — You are a photo editor for a factual video, deciding whether the SOURCED IMAGE can serve as the on-screen visual for this shot. KEEP it if it plausibly depicts the claimed subject (or something clearly appropriate for the narration). REJECT only CLEAR mismatches: a different object or subject entirely, an unrelated scene, a diagram / map / chart / graph, a logo or coat-of-arms, a screenshot of text, or a watermarked / very low-quality image. Do NOT reject over fine details — the exact model/variant/sub-type, camera angle, era, colour scheme, or minor uncertainty. If it is plausibly the right subject, keep it. Score 0–10 (10 = clearly the subject and a good visual; 5 = plausibly right; 0 = clearly wrong) and set fits (true unless it's a clear mismatch).",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `SHOT NARRATION: "${input.shotText}"\nINTENDED VISUAL: ${input.imagePrompt}\nCLAIMED SUBJECT: ${input.entity}\n\nDoes the attached image clearly show this subject and make sense as this shot's visual?`,
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
