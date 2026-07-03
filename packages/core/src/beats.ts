import { z } from "zod";

export const beatType = z.enum(["hook", "stat", "insight", "cta"]);
export type BeatType = z.infer<typeof beatType>;

/** What the scriptwriter agent produces (structure is templated, substance is not). */
export const scriptOutputSchema = z.object({
  hookText: z.string().describe("The first 1-2 seconds, spoken verbatim"),
  beats: z
    .array(
      z.object({
        type: beatType,
        text: z.string().describe("Spoken narration for this beat"),
        imagePrompt: z
          .string()
          .describe("Image-generation prompt for this beat's visual, matching the channel visual style"),
      }),
    )
    .min(4)
    .max(8),
  fullText: z.string().describe("Complete narration, all beats joined"),
  substanceFingerprint: z
    .string()
    .describe(
      "Normalized 'topic | hook claim | key fact 1 | ... | key fact 5' string used to detect near-duplicate substance",
    ),
});
export type ScriptOutput = z.infer<typeof scriptOutputSchema>;

/** Input props for the Remotion `Short` composition (shared contract). */
export const shortPropsSchema = z.object({
  beats: z.array(
    z.object({
      type: beatType,
      text: z.string(),
      imageSrc: z.string(),
      startSec: z.number(),
      endSec: z.number(),
    }),
  ),
  captions: z.array(
    z.object({ word: z.string(), startSec: z.number(), endSec: z.number() }),
  ),
  audioSrc: z.string(),
  durationSec: z.number(),
  brand: z.object({ primaryColor: z.string(), font: z.string() }),
});
export type ShortProps = z.infer<typeof shortPropsSchema>;

export const ideationOutputSchema = z.object({
  ideas: z
    .array(
      z.object({
        title: z.string(),
        angle: z.string().describe("One-sentence editorial angle"),
      }),
    )
    .min(3)
    .max(10),
});
export type IdeationOutput = z.infer<typeof ideationOutputSchema>;

const axis = z.object({
  score: z.number().min(0).max(10),
  rationale: z.string(),
});

export const rubricSchema = z.object({
  demand: axis,
  saturation: axis.describe("higher score = LESS saturated (better)"),
  ghostNiche: axis,
  rpmPotential: axis,
  feasibilityCost: axis.describe("higher score = cheaper/easier to produce"),
  complianceRisk: axis.describe("higher score = LOWER risk (safer)"),
  dnaFit: axis,
});
export type RubricOutput = z.infer<typeof rubricSchema>;

export const similarityVerdictSchema = z.object({
  similar: z.boolean(),
  reason: z.string(),
});
export type SimilarityVerdict = z.infer<typeof similarityVerdictSchema>;

/** Hook-template pick for an idea (cheap tier). */
export const hookPickSchema = z.object({
  templateId: z.string().describe("id of the best-fitting hook template"),
  reason: z.string(),
});
export type HookPick = z.infer<typeof hookPickSchema>;

/** Structure abstraction from a high-performing video (spec §5.5). */
export const hookIngestSchema = z.object({
  templates: z
    .array(
      z.object({
        name: z.string(),
        archetype: z.enum(["curiosity_gap", "pattern_interrupt", "stakes_first", "contrarian"]),
        first2s: z.string().describe("the first-1-2-seconds pattern, abstracted"),
        beatPlan: z.array(z.string()).describe("retention beat structure, content-free"),
        payoffPlacement: z.string(),
        loopOrCta: z.string(),
        sourceRef: z.string(),
      }),
    )
    .min(1)
    .max(5),
});
export type HookIngest = z.infer<typeof hookIngestSchema>;

/** Trend fast-lane suggestions matched against ChannelDNA. */
export const trendSuggestionsSchema = z.object({
  suggestions: z
    .array(
      z.object({
        title: z.string(),
        angle: z.string(),
        trendRef: z.string().describe("which rising format/topic this replicates"),
        fitReason: z.string(),
      }),
    )
    .max(3),
});
export type TrendSuggestions = z.infer<typeof trendSuggestionsSchema>;

/** Predicted-CTR score for a thumbnail candidate. */
export const thumbnailScoreSchema = z.object({
  predictedCtr: z.number().min(0).max(20).describe("predicted CTR percent"),
  critique: z.string(),
});
export type ThumbnailScore = z.infer<typeof thumbnailScoreSchema>;
