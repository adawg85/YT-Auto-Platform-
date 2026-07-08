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
        /** Estimated spoken seconds — computed in code from word count, not the model.
         * Render uses real voiceover word-timestamps; this is a review-time estimate. */
        estSec: z.number().optional(),
      }),
    )
    .min(1)
    .describe("script beats in order (aim 4–8 for shorts, more for long-form to fill the target duration)"),
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
  /** canvas orientation — portrait 1080×1920 (shorts) or landscape 1920×1080 (long-form) */
  orientation: z.enum(["portrait", "landscape"]).default("portrait"),
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

// No hard 0–10 bound: real models occasionally return an out-of-range score,
// which would make generateObject reject the whole rubric ("No object
// generated") and crash the Score action. The scoring agent clamps to 0–10.
const axis = z.object({
  score: z.number().describe("0–10"),
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
  predictedCtr: z.number().describe("predicted CTR percent (0–20)"),
  critique: z.string(),
});
export type ThumbnailScore = z.infer<typeof thumbnailScoreSchema>;

export const hookArchetypeEnum = z.enum([
  "curiosity_gap",
  "pattern_interrupt",
  "stakes_first",
  "contrarian",
]);

/**
 * Per-video hook analysis (build #3.2). The agent classifies the opening line
 * and produces qualitative tags + narrative; the numeric hold metrics come from
 * the retention curve in code, not the model.
 */
export const hookAnalysisSchema = z.object({
  archetype: hookArchetypeEnum.describe("the hook's structural archetype"),
  tags: z
    .array(z.string())
    .min(1)
    .max(5)
    .describe("short tags, e.g. strong-3s-hold, open-loop, contrarian-claim, cold-open"),
  assessment: z
    .string()
    .describe("2-3 sentences on how the hook held through the 3s cliff vs the channel average and why"),
});
export type HookAnalysis = z.infer<typeof hookAnalysisSchema>;

/**
 * Per-video script analysis (build #3.2): beat-by-beat structure with a
 * working/not flag, overall strengths, a concrete trim tied to the retention
 * dip, and the dip timestamp.
 */
// ── Meta-analysis engine (build #4): external content → shared pattern store ──

/**
 * Hook extraction from a scouted competitor transcript. Classifies the opening
 * pattern into an archetype + short label so it can fold into the pattern store
 * (source="external"). Structure/shape only — no verbatim substance is stored.
 */
export const metaHookSchema = z.object({
  archetype: hookArchetypeEnum,
  /** the pattern's identity within its niche, e.g. "open-loop", "cold-open" */
  label: z.string().describe("short kebab-case pattern label, e.g. open-loop"),
  /** abstracted opener shape — NOT the verbatim line */
  opener: z.string().describe("the opening technique in the abstract, content-free"),
  tags: z.array(z.string()).min(1).max(5),
});
export type MetaHook = z.infer<typeof metaHookSchema>;

/** Script-structure extraction from a scouted transcript. */
export const metaScriptStructureSchema = z.object({
  beatSequence: z
    .array(beatType)
    .min(2)
    .max(10)
    .describe("the beat structure the transcript follows, e.g. hook,stat,insight,cta"),
  label: z.string().describe("the structure's identity, e.g. hook→stat→insight→cta"),
  notes: z.string().describe("what makes this structure over-perform in the niche"),
});
export type MetaScriptStructure = z.infer<typeof metaScriptStructureSchema>;

/**
 * Topic/niche clustering over a batch of outliers/trending videos: what angles
 * are heating up right now. Momentum 0-100 scales the pattern's initial score.
 */
export const topicClusterSchema = z.object({
  signals: z
    .array(
      z.object({
        label: z.string().describe("the rising angle/topic, terse"),
        angle: z.string().describe("one-sentence description of why it's rising"),
        momentum: z.number().min(0).max(100).describe("how hot right now, 0-100"),
      }),
    )
    .min(1)
    .max(6),
});
export type TopicCluster = z.infer<typeof topicClusterSchema>;

export const scriptAnalysisSchema = z.object({
  beats: z
    .array(
      z.object({
        type: beatType,
        summary: z.string().describe("one-line description of what this beat does"),
        working: z.boolean().describe("is this beat holding retention?"),
      }),
    )
    .min(2)
    .max(10),
  strengths: z.string().describe("what the script structure does well"),
  trimSuggestion: z
    .string()
    .describe("a concrete trim/tighten suggestion tied to where retention dips"),
  dipBeatIndex: z
    .number()
    .int()
    .nullable()
    .describe("index into beats of the biggest retention drop, or null if steady"),
});
export type ScriptAnalysis = z.infer<typeof scriptAnalysisSchema>;
