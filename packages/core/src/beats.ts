import { z } from "zod";

export const beatType = z.enum(["hook", "stat", "insight", "cta"]);
export type BeatType = z.infer<typeof beatType>;

// ── Visual Director (#37, 2026-07-16) ──────────────────────────────────────
/** The medium a shot uses — the director picks ONLY within the channel's
 * allowed palette (still-only / all-video / mixed, AI vs real footage). */
export const shotMedium = z.enum(["still", "motion", "real_footage"]);
export type ShotMedium = z.infer<typeof shotMedium>;
export const shotScale = z.enum(["wide", "medium", "close", "insert"]);
export type ShotScale = z.infer<typeof shotScale>;

/** One shot in the director's visual sequence: what it shows, how it's framed,
 * which medium, and the narration it covers. Spans within a beat must tile it. */
export const directedShotSchema = z.object({
  beatIndex: z.number().int().describe("0-based index of the beat this shot belongs to"),
  narrationSpan: z
    .string()
    .describe(
      "the exact CONTIGUOUS slice of THIS beat's narration this shot covers; within a beat the spans must tile it in order — no gaps, no overlaps, every word covered",
    ),
  subject: z.string().describe("the concrete thing shown, subject-first"),
  shotScale: shotScale,
  angle: z.string().nullable().optional().describe("camera angle e.g. low / high / over-shoulder / profile / aerial"),
  medium: shotMedium.describe("still image, animated clip, or real archival footage — only from the allowed palette"),
  character: z.string().nullable().optional().describe("recurring character present in this shot, by name, or null"),
  hero: z.boolean().describe("true ONLY for the genuine pivotal frames"),
  motif: z.string().nullable().optional().describe("recurring-motif tag for deliberate callbacks — render from a NEW angle each time"),
  continuity: z.string().nullable().optional().describe("how this shot relates to the previous one"),
  intent: z.string().describe("one line of directorial intent — what this shot conveys / should feel like"),
});
export type DirectedShot = z.infer<typeof directedShotSchema>;

export const visualSequenceSchema = z.object({
  shots: z.array(directedShotSchema).min(1).describe("the whole video's shots, in order"),
});
export type VisualSequence = z.infer<typeof visualSequenceSchema>;

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
        referenceEntity: z
          .string()
          .nullable()
          .optional()
          .describe(
            "If this beat depicts a SPECIFIC real-world subject (a named aircraft, person, place, or event, e.g. 'Supermarine Spitfire'), its canonical name so a real photo can be sourced. null/omit for abstract or conceptual beats.",
          ),
        visualBrief: z
          .string()
          .max(400)
          .nullable()
          .optional()
          .describe(
            "The visual ASK for this section (2026-07-12): one concrete, self-contained scene an image model can execute — subject first, era-correct setting, composition, mood. NEVER quote or echo the narration and never carry its metaphors or idioms (figurative language gets drawn literally). Think like a documentary picture editor briefing an archive researcher.",
          ),
        heroShot: z
          .boolean()
          .optional()
          .describe("true on the story's 2-4 pivotal beats ONLY — they get the premium image model."),
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

/**
 * The humanize/editor pass output (BACKLOG #21 / audit §4.2): the same script,
 * rewritten to sound like one real person talking. Beat COUNT and order are
 * preserved (enforced in code — a mismatch falls back to the original draft);
 * imagePrompts/referenceEntities are untouched by this pass.
 */
export const humanizedScriptSchema = z.object({
  hookText: z.string().describe("the rewritten first 1-2 seconds, spoken verbatim"),
  beats: z
    .array(
      z.object({
        text: z.string().describe("the rewritten spoken narration for this beat, same order as given"),
      }),
    )
    .min(1)
    .describe("one entry per input beat, SAME count and order"),
  editNotes: z
    .string()
    .describe("2-3 lines: the constructed phrasing and AI tells you removed"),
});
export type HumanizedScript = z.infer<typeof humanizedScriptSchema>;

/**
 * Surgical factuality repair output (scripting-loop incident fix): the same
 * script with ONLY the sentences carrying unsupported claims rewritten
 * (grounded, hedged, or removed). Same-count contract as the humanize pass:
 * beat COUNT and order are preserved — enforced in code via
 * `applyScriptRepair`, which falls back to the original script on a mismatch.
 */
export const repairedScriptSchema = z.object({
  hookText: z
    .string()
    .describe("the hook line — VERBATIM unless it contained a listed unsupported claim"),
  beats: z
    .array(
      z.object({
        text: z
          .string()
          .describe(
            "this beat's narration — VERBATIM unless it contained a listed unsupported claim",
          ),
      }),
    )
    .min(1)
    .describe("one entry per input beat, SAME count and order"),
});
export type RepairedScript = z.infer<typeof repairedScriptSchema>;

/**
 * Merge a surgical repair back onto the original script, fail-safe (pure —
 * unit-tested): a beat-count mismatch OR a total word count shrunk by more
 * than 20% returns the ORIGINAL script unchanged, so the caller's proof loop
 * holds the production exactly as it would without the repair. Beat metadata
 * (type, imagePrompt, referenceEntity, estSec) is preserved; only text moves.
 */
export function applyScriptRepair(script: ScriptOutput, repaired: RepairedScript): ScriptOutput {
  if (repaired.beats.length !== script.beats.length) return script;
  const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
  const beats = script.beats.map((b, i) => ({ ...b, text: repaired.beats[i]!.text }));
  const fullText = beats.map((b) => b.text).join(" ");
  if (words(fullText) < words(script.fullText) * 0.8) return script;
  return { ...script, hookText: repaired.hookText, beats, fullText };
}

/**
 * A built per-shot image prompt (BACKLOG #21 / audit §4.4), following the
 * verified FLUX guidance: subject first, explicit lighting, film-stock/era
 * descriptors for archival realism, positive-only exclusions (FLUX has no
 * negative prompts), and a repeated Style/Mood suffix for set consistency.
 */
export const builtImagePromptSchema = z.object({
  prompts: z
    .array(
      z.object({
        prompt: z
          .string()
          .describe(
            "the full generation prompt: subject-first natural-language prose with an explicit lighting clause, ending with the shared 'Style: … Mood: …' suffix",
          ),
        /** 2026-07-14 recurring characters: set when this shot depicts one */
        character: z
          .string()
          .nullable()
          .optional()
          .describe(
            "EXACT name of the recurring channel character depicted in this shot, or null when no character appears",
          ),
      }),
    )
    .min(1)
    .describe("one entry per input shot, SAME count and order"),
  styleSuffix: z
    .string()
    .describe("the shared 'Style: … Mood: …' tail appended to every prompt (consistency anchor)"),
});
export type BuiltImagePrompts = z.infer<typeof builtImagePromptSchema>;

/**
 * Character sheet (2026-07-14): the canonical appearance paragraph for a
 * recurring channel character — injected verbatim into image prompts so the
 * character renders consistently across every video.
 */
export const characterSheetSchema = z.object({
  description: z
    .string()
    .min(20)
    .describe(
      "one compact canonical-appearance paragraph: age range, build, hair, skin tone, facial " +
        "features, signature clothing and accessories, colour palette — concrete and repeatable, " +
        "no name, no backstory, no scene",
    ),
});
export type CharacterSheet = z.infer<typeof characterSheetSchema>;

/** Input props for the Remotion `Short` composition (shared contract). */
export const shortPropsSchema = z.object({
  beats: z.array(
    z.object({
      type: beatType,
      text: z.string(),
      imageSrc: z.string(),
      /** BACKLOG #26: real archival footage for this beat — when present the
       * beat renders the (muted) video instead of the still image. */
      videoSrc: z.string().optional(),
      startSec: z.number(),
      endSec: z.number(),
    }),
  ),
  captions: z.array(
    z.object({ word: z.string(), startSec: z.number(), endSec: z.number() }),
  ),
  audioSrc: z.string(),
  /** Optional background-music bed (Production Profile "music" axis). Played
   * under the voiceover at `musicVolume`, looped + faded to fill the render. */
  musicSrc: z.string().optional(),
  /** Ducked linear volume for `musicSrc` (0–1). Absent/0 → no music bed. */
  musicVolume: z.number().min(0).max(1).optional(),
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

/**
 * #35.3: vision deconstruction of a WINNING thumbnail (a niche outlier's) —
 * the transferable SHAPE of why it pulls clicks, never its literal content.
 * Written to the pattern store as kind "thumbnail" and grounded into
 * buildThumbnailPrompts' pattern-led candidate.
 */
export const thumbnailDeconstructSchema = z.object({
  label: z
    .string()
    .describe("short reusable pattern name, e.g. 'giant subject + red arrow + 2-word shout'"),
  composition: z
    .string()
    .describe("layout as a formula: subject size/placement, negative space, depth, focal flow"),
  subjectTreatment: z
    .string()
    .describe("how the subject is treated: crop, angle, lighting, scale exaggeration"),
  textTreatment: z
    .string()
    .describe("overlay text: word count, casing, color, placement — or 'no text'"),
  palette: z.string().describe("dominant colors + the contrast trick, one line"),
  emotion: z.string().describe("the feeling it fires at feed size: threat, awe, curiosity…"),
  whyItWorks: z.string().describe("one sentence: the click mechanism"),
});
export type ThumbnailDeconstruct = z.infer<typeof thumbnailDeconstructSchema>;

/**
 * Vision relevance score for a sourced reference image (BACKLOG #18 #4 cut 2).
 * Does the real photo we found actually depict the shot's subject and work as
 * its on-screen visual? A low score → discard it and generate instead.
 */
export const imageFitSchema = z.object({
  fits: z.boolean().describe("does the image clearly depict the shot's subject and work as its visual?"),
  score: z.number().describe("0–10: relevance + clarity of the image for this shot"),
  reason: z.string().describe("one line: what the image shows and why it fits or doesn't"),
});
export type ImageFit = z.infer<typeof imageFitSchema>;

/**
 * Text-junk check for a GENERATED image (BACKLOG #24). FLUX renders garbled
 * nonsense text when a prompt implies printed/readable surfaces; a vision pass
 * on the generated pixels catches it so the pipeline can regenerate once with
 * a strengthened text-free clause.
 */
export const generatedImageCheckSchema = z.object({
  hasTextJunk: z
    .boolean()
    .describe("does the image contain garbled/nonsense rendered text or watermark-like artifacts?"),
  reason: z.string().describe("one line: what text/artifact was seen, or why the image is clean"),
});
export type GeneratedImageCheck = z.infer<typeof generatedImageCheckSchema>;

/**
 * Motion prompt for image→video (2026-07-15). A vision agent looks at the actual
 * still being animated + the shot's narration and writes ONE vendor-ready i2v
 * prompt: what should move in THIS frame (subject action + secondary motion) and
 * a subtle camera move, believable and gentle, no on-screen text.
 */
export const motionPromptSchema = z.object({
  prompt: z
    .string()
    .describe(
      "one vendor-ready image-to-video motion prompt describing the believable motion for THIS frame — subject action, secondary motion (smoke/sparks/hair/cloth/light), and a subtle camera move; positive phrasing, no on-screen text",
    ),
});
export type MotionPrompt = z.infer<typeof motionPromptSchema>;

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
