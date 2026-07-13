import { generateObject } from "ai";
import { visualStyleDistillSchema, type VisualStyleDistill } from "@ytauto/core";
import { runAgent, type AgentCtx, repairDoubleEncodedJson } from "./run-agent";

/** Vision request-size guard: examples are capped by the caller too. */
export const MAX_STYLE_REF_IMAGES = 8;

/**
 * Visual style distillation (#35.1): an art director's pass over the
 * channel's example images — uploads, other videos' thumbnails, promoted own
 * assets — extracting the SHARED visual system (what repeats across ALL of
 * them) into a structured doc every image/thumbnail prompt then carries.
 * One multimodal call, one image part per example.
 */
export async function distillVisualStyle(
  ctx: AgentCtx,
  input: {
    images: { bytes: Uint8Array | Buffer; mimeType: string }[];
    niche: string;
    /** the channel's current imageStyle string, as context (may be replaced) */
    imageStyle: string;
    notes?: string;
  },
): Promise<VisualStyleDistill> {
  const images = input.images.slice(0, MAX_STYLE_REF_IMAGES);
  const system =
    "TASK:style-distill — You are an art director reverse-engineering a channel's visual identity " +
    "from its reference images. Extract the SHARED system — what repeats across ALL the images — " +
    "never any single image's subject. Every field must be prompt-ready language an image model " +
    "can execute, phrased positively (FLUX-class models draw named negatives, so 'clean unmarked " +
    "metal' not 'no logos'). promptSuffix is the one sentence that will be appended VERBATIM to " +
    "every future generation prompt for this channel — make it dense and specific, 'Style: … Mood: …'.";

  return runAgent(
    "style_distiller",
    "cheap",
    ctx,
    `distill visual style from ${images.length} example(s) (${input.niche})`,
    async (model) => {
      const res = await generateObject({
        model,
        schema: visualStyleDistillSchema,
        experimental_repairText: repairDoubleEncodedJson,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text" as const,
                text: [
                  `NICHE: ${input.niche}`,
                  `CURRENT STYLE STRING (context, may be superseded): ${input.imageStyle}`,
                  input.notes ? `OPERATOR NOTES: ${input.notes}` : "",
                  `Distill the shared visual system from the ${images.length} attached reference images.`,
                ]
                  .filter(Boolean)
                  .join("\n"),
              },
              ...images.map((img) => ({
                type: "image" as const,
                image: img.bytes,
                mediaType: img.mimeType,
              })),
            ],
          },
        ],
      });
      return { object: res.object, usage: res.usage };
    },
  );
}
