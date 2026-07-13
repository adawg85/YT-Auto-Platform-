import { z } from "zod";

/**
 * Visual style DNA (#35.1): a channel's look, distilled by a vision agent
 * from ACTUAL example images and versioned like personas. The doc flows into
 * every image + thumbnail prompt; the example images themselves drive
 * image-to-image conditioning (scope/strength dialed per doc version).
 */

/** What the style_distiller vision agent produces (describe-hints, no hard
 * bounds — real models overshoot zod .min/.max; promptSuffix capped because
 * it is appended verbatim to every generation prompt). */
export const visualStyleDistillSchema = z.object({
  palette: z
    .string()
    .describe("dominant colors + the accent trick, as a prompt-ready clause"),
  lighting: z.string().describe("the lighting language shared across the examples"),
  composition: z
    .string()
    .describe("layout habits: subject size/placement, negative space, depth, focal flow"),
  subjectTreatment: z
    .string()
    .describe("how subjects are treated: crop, angle, scale, finish"),
  texture: z.string().describe("grain, film stock, render finish"),
  typography: z
    .string()
    .describe("overlay text treatment seen in the examples, or 'none'"),
  energy: z.string().describe("mood/intensity in a few words"),
  promptSuffix: z
    .string()
    .max(400)
    .describe(
      "ONE reusable 'Style: … Mood: …' sentence distilled from all of the above — appended verbatim to every generation prompt; positive-only phrasing",
    ),
  rationale: z.string().describe("one line: what makes this example set cohere"),
});
export type VisualStyleDistill = z.infer<typeof visualStyleDistillSchema>;

export type ConditioningScope = "off" | "thumbnails" | "thumbs_hero" | "all_generated";

export type StyleConditioning = { scope: ConditioningScope; strength: number };

const CONDITIONING_SCOPES: ConditioningScope[] = ["off", "thumbnails", "thumbs_hero", "all_generated"];

/** Conditioning config with safe defaults (style transfer wants a LIGHTER
 * flux strength than the swap dialog's 0.8 rework). */
export function resolveConditioning(
  doc: { conditioning?: { scope?: string; strength?: number } | null } | null | undefined,
): StyleConditioning {
  const raw = doc?.conditioning;
  const scope = CONDITIONING_SCOPES.includes(raw?.scope as ConditioningScope)
    ? (raw!.scope as ConditioningScope)
    : "thumbs_hero";
  const strength = Math.min(0.9, Math.max(0.1, raw?.strength ?? 0.45));
  return { scope, strength };
}

/** Deterministic ref rotation (the #31 duplicate-reals lesson: precompute,
 * never share state across parallel steps; consecutive shots vary refs). */
export function styleRefKeyForIndex(refKeys: string[], i: number): string | undefined {
  if (refKeys.length === 0) return undefined;
  return refKeys[((i % refKeys.length) + refKeys.length) % refKeys.length];
}

/** The CHANNEL VISUAL STYLE block for the image-prompt builder's user prompt. */
export function styleBlockForImagePrompts(doc: {
  palette: string;
  lighting: string;
  composition: string;
  subjectTreatment: string;
  texture: string;
  energy: string;
  promptSuffix: string;
}): string {
  return [
    "CHANNEL VISUAL STYLE (distilled from the channel's own reference images — this look is bedded down):",
    `- palette: ${doc.palette}`,
    `- lighting: ${doc.lighting}`,
    `- composition: ${doc.composition}`,
    `- subject treatment: ${doc.subjectTreatment}`,
    `- texture: ${doc.texture}`,
    `- energy: ${doc.energy}`,
    `- style suffix (include VERBATIM in the shared Style/Mood suffix): ${doc.promptSuffix}`,
  ].join("\n");
}
