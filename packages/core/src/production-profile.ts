import { z } from "zod";
import type { ProductionProfile } from "@ytauto/db";

/**
 * Production Profile (BACKLOG #18) — the per-channel control plane. This module
 * is the single source of truth for its shape, defaults and validation, so the
 * cockpit (persist), the wizard (create) and the pipeline (read) all agree.
 *
 * Every axis is a scaffold seam: the profile records operator intent now, and
 * each production step honours its axis as that feature ships. Defaults are
 * behaviour-preserving — a channel with no stored profile produces exactly what
 * it does today (mixed real/generated stills, static, no music).
 */

export const VISUAL_MODES = ["simple", "real_footage", "ai_images", "ai_video", "mixed"] as const;
export const MOTION_MODES = ["static", "partial", "ai_video"] as const;
export const RHYTHM_MODES = ["sentence", "section", "pause"] as const;
/** Finer image-frequency dial on top of rhythm (2026-07-16 operator: "turn the
 * frequency down a notch"): relaxed holds each still longer (fewer images),
 * busy cuts more often. standard = the previous behaviour, unchanged. */
export const IMAGE_DENSITIES = ["relaxed", "standard", "busy"] as const;
export const MUSIC_MODES = ["off", "subtle", "standard"] as const;
export const DELIVERY_MODES = ["measured", "warm", "energetic", "dramatic"] as const;
export const ARCHIVAL_STRENGTHS = ["off", "light", "balanced", "strong", "max"] as const;
/** Vendor-DIRECT image engines (fal fully removed 2026-07-16): "qwen"
 * (DashScope bulk), "seedream" (ByteDance ModelArk bulk), "nano-banana"
 * (Gemini, hero/character). Legacy stored "fal"/"mixed" values fail validation
 * and resolve to the "qwen" default. */
export const IMAGE_ENGINES = ["qwen", "seedream", "nano-banana"] as const;
export const VIDEO_ENGINES = ["wan", "minimax", "seedance", "kling"] as const;

/** Max length for the free-text art-direction / notes fields (keeps prompts sane). */
export const PROFILE_NOTE_MAX = 800;

export const productionProfileSchema = z.object({
  visualMode: z.enum(VISUAL_MODES),
  motion: z.enum(MOTION_MODES),
  rhythm: z.enum(RHYTHM_MODES),
  imageDensity: z.enum(IMAGE_DENSITIES).optional(),
  /** Visual Director (#37): a director agent cuts the shots on meaning + picks
   * each shot's medium, instead of the mechanical rhythm cut. Opt-in. */
  visualDirector: z.boolean().optional(),
  captions: z.boolean(),
  music: z.enum(MUSIC_MODES),
  delivery: z.enum(DELIVERY_MODES),
  archivalStrength: z.enum(ARCHIVAL_STRENGTHS).optional(),
  imageEngine: z.enum(IMAGE_ENGINES).optional(),
  // per-role image engines (2026-07-16): split which model each KIND of shot
  // uses instead of one bulk choice + hardcoded Nano. Unset = the role default
  // (bulk→imageEngine/qwen, the rest→nano-banana), which preserves prior behaviour.
  heroImageEngine: z.enum(IMAGE_ENGINES).optional(),
  characterImageEngine: z.enum(IMAGE_ENGINES).optional(),
  thumbnailImageEngine: z.enum(IMAGE_ENGINES).optional(),
  videoEngine: z.enum(VIDEO_ENGINES).optional(),
  /** engine for clips whose shot has the recurring character (2026-07-16): when
   * set, character clips animate here (e.g. Seedance for identity) while filler
   * clips stay on videoEngine; unset = every clip uses videoEngine */
  characterVideoEngine: z.enum(VIDEO_ENGINES).optional(),
  /** engine for clips on HERO shots (2026-07-16): e.g. Kling for showcase
   * beats; character clips still win over hero when both apply. Unset = filler. */
  heroVideoEngine: z.enum(VIDEO_ENGINES).optional(),
  /** per-video cap on AI beat clips (the video cost knob, 2026-07-16); unset
   * falls back to the VIDEO_MAX_AI_CLIPS env default */
  maxAiClips: z.number().int().min(0).max(20).optional(),
  artDirection: z.string().max(PROFILE_NOTE_MAX).optional(),
  notes: z.string().max(PROFILE_NOTE_MAX).optional(),
});
export type ProductionProfileInput = z.infer<typeof productionProfileSchema>;

/**
 * Resolve the effective profile for a channel: the stored profile merged over
 * behaviour-preserving defaults. All defaults are format-agnostic; captions
 * default ON for every format (operator ask, BACKLOG #26 — was Shorts-only),
 * with the stored per-channel toggle still able to switch them off.
 * `contentFormat` is accepted for call-site compatibility (and any future
 * format-sensitive default).
 */
export function resolveProductionProfile(
  stored: Partial<ProductionProfile> | null | undefined,
  _opts: { contentFormat?: string } = {},
): ProductionProfile {
  const s = stored ?? {};
  const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
    typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  const trim = (v: unknown): string | undefined => {
    const t = typeof v === "string" ? v.trim() : "";
    return t ? t.slice(0, PROFILE_NOTE_MAX) : undefined;
  };
  return {
    visualMode: pick(s.visualMode, VISUAL_MODES, "mixed"),
    motion: pick(s.motion, MOTION_MODES, "static"),
    rhythm: pick(s.rhythm, RHYTHM_MODES, "sentence"),
    imageDensity: pick(s.imageDensity, IMAGE_DENSITIES, "standard"),
    visualDirector: typeof s.visualDirector === "boolean" ? s.visualDirector : false,
    captions: typeof s.captions === "boolean" ? s.captions : true,
    music: pick(s.music, MUSIC_MODES, "off"),
    delivery: pick(s.delivery, DELIVERY_MODES, "measured"),
    archivalStrength: pick(s.archivalStrength, ARCHIVAL_STRENGTHS, "balanced"),
    imageEngine: pick(s.imageEngine, IMAGE_ENGINES, "qwen"),
    // per-role engines default to Nano Banana (the quality tier) for
    // hero/character/thumbnail; bulk follows imageEngine above
    heroImageEngine: pick(s.heroImageEngine, IMAGE_ENGINES, "nano-banana"),
    characterImageEngine: pick(s.characterImageEngine, IMAGE_ENGINES, "nano-banana"),
    thumbnailImageEngine: pick(s.thumbnailImageEngine, IMAGE_ENGINES, "nano-banana"),
    videoEngine: pick(s.videoEngine, VIDEO_ENGINES, "wan"),
    // optional: only carried through when a valid engine is stored (unset =
    // character clips use videoEngine like everything else)
    characterVideoEngine:
      typeof s.characterVideoEngine === "string" &&
      (VIDEO_ENGINES as readonly string[]).includes(s.characterVideoEngine)
        ? (s.characterVideoEngine as (typeof VIDEO_ENGINES)[number])
        : undefined,
    heroVideoEngine:
      typeof s.heroVideoEngine === "string" &&
      (VIDEO_ENGINES as readonly string[]).includes(s.heroVideoEngine)
        ? (s.heroVideoEngine as (typeof VIDEO_ENGINES)[number])
        : undefined,
    maxAiClips:
      typeof s.maxAiClips === "number" && Number.isFinite(s.maxAiClips)
        ? Math.max(0, Math.min(20, Math.round(s.maxAiClips)))
        : undefined,
    artDirection: trim(s.artDirection),
    notes: trim(s.notes),
  };
}

/** AI beat-clip engine for a channel — Wan (default) / Minimax Hailuo /
 * Seedance. `character` picks the character-clip engine when one is set. */
export function videoEngineFor(
  profile: Pick<ProductionProfile, "videoEngine" | "characterVideoEngine" | "heroVideoEngine">,
  opts?: { character?: boolean; hero?: boolean },
): "wan" | "minimax" | "seedance" | "kling" {
  const norm = (v: string | undefined): "wan" | "minimax" | "seedance" | "kling" =>
    v === "minimax" ? "minimax" : v === "seedance" ? "seedance" : v === "kling" ? "kling" : "wan";
  // precedence mirrors images: character clips win over hero when both apply
  if (opts?.character && profile.characterVideoEngine) return norm(profile.characterVideoEngine);
  if (opts?.hero && profile.heroVideoEngine) return norm(profile.heroVideoEngine);
  return norm(profile.videoEngine);
}

/**
 * Resolve the generation engine for one image from the channel's profile
 * (all vendor-DIRECT; fal removed 2026-07-16). "nano-banana" puts everything on
 * the Google-direct provider; "seedream" renders bulk on ByteDance ModelArk;
 * everything else — the "qwen" default AND legacy stored "fal"/"mixed" values —
 * renders bulk on DashScope-direct Qwen-Image. Hero (thumbnails + hero beat
 * shots) always pins to Nano Banana.
 */
/** Provider `name` values an engine request is EXPECTED to be served by. A
 * served name outside this set means the factory silently degraded (the engine
 * failed or was keyless) — surfaced to the operator so an off-model image isn't
 * mistaken for a prompt bug (2026-07-16). */
const ACCEPTABLE_SERVED: Record<string, string[]> = {
  "nano-banana": ["gemini"],
  qwen: ["qwen-image"],
  seedream: ["seedream"],
};

/** True when `served` (a provider name stamped on the result) is NOT what
 * `requested` should have produced — i.e. a real fallback happened. Unknown /
 * mock served names return false (no keys = dev/mock, not a prod downgrade). */
export function imageEngineFellBack(requested: string | null | undefined, served: string | null | undefined): boolean {
  if (!served || !requested) return false;
  if (served === "mock" || served === "mock-media") return false;
  return !(ACCEPTABLE_SERVED[requested] ?? [requested]).includes(served);
}

export function imageEngineFor(
  profile: Pick<ProductionProfile, "imageEngine">,
  quality?: "standard" | "hero",
): "nano-banana" | "qwen" | "seedream" {
  if (profile.imageEngine === "nano-banana") return "nano-banana";
  // hero (thumbnails + hero beat shots) always pins to nano; the channel's
  // imageEngine only chooses the BULK/filler engine (qwen default, or seedream)
  if (quality === "hero") return "nano-banana";
  return profile.imageEngine === "seedream" ? "seedream" : "qwen";
}

/** The KIND of shot an image serves, each independently routable (2026-07-16). */
export type ImageRole = "bulk" | "hero" | "character" | "thumbnail";

const normImageEngine = (v: string | undefined | null): "nano-banana" | "qwen" | "seedream" | undefined =>
  v === "nano-banana" ? "nano-banana" : v === "seedream" ? "seedream" : v === "qwen" ? "qwen" : undefined;

/**
 * Resolve the image engine for a specific ROLE, so a channel can split which
 * model draws each kind of shot (2026-07-16 operator: "all nano or all
 * seedream isn't enough control"): bulk/filler follows `imageEngine`
 * (qwen default); hero, character and thumbnail each have their own field
 * (Nano Banana default — the quality tier). Unset fields fall back to those
 * defaults, so existing channels keep their current behaviour.
 */
export function imageEngineForRole(
  profile: Pick<
    ProductionProfile,
    "imageEngine" | "heroImageEngine" | "characterImageEngine" | "thumbnailImageEngine"
  >,
  role: ImageRole,
): "nano-banana" | "qwen" | "seedream" {
  switch (role) {
    case "bulk":
      return normImageEngine(profile.imageEngine) ?? "qwen";
    case "hero":
      return normImageEngine(profile.heroImageEngine) ?? "nano-banana";
    case "character":
      return normImageEngine(profile.characterImageEngine) ?? "nano-banana";
    case "thumbnail":
      return normImageEngine(profile.thumbnailImageEngine) ?? "nano-banana";
  }
}

/**
 * The image engines to try for a ROLE, highest-priority first, drawn ONLY from
 * the channel's Style-tab settings — the role's own engine, then the bulk
 * engine, then the other role engines (deduped). When an engine fails/429s the
 * media factory degrades down THIS list, so a failed hero shot lands on an
 * engine the operator actually chose (e.g. their seedream bulk), never a
 * hardcoded qwen the Style tab never selected (2026-07-16 operator ask:
 * "fallback should follow exactly what is in the Style tab").
 */
export function imageEnginePreference(
  profile: Pick<
    ProductionProfile,
    "imageEngine" | "heroImageEngine" | "characterImageEngine" | "thumbnailImageEngine"
  >,
  role: ImageRole,
): ("nano-banana" | "qwen" | "seedream")[] {
  const order = [
    imageEngineForRole(profile, role), // the role's own choice = the primary
    imageEngineForRole(profile, "bulk"), // the general-purpose engine next
    imageEngineForRole(profile, "hero"),
    imageEngineForRole(profile, "character"),
    imageEngineForRole(profile, "thumbnail"),
  ];
  return [...new Set(order)];
}

/** The default profile for a freshly-created channel of the given format. */
export function defaultProductionProfile(contentFormat?: string): ProductionProfile {
  return resolveProductionProfile(null, { contentFormat });
}

// ── Axis → pipeline behaviour (each honoured as its tool exists) ───────────

/**
 * `visualMode` gate for the per-beat image step. When the operator picks an
 * AI-image/AI-video style, skip the Wikimedia real-photo lookup and always
 * generate. `real_footage`/`mixed`/`simple` keep the reference-first behaviour
 * (real licensed photo when the beat names a subject, generated otherwise).
 */
export function preferGeneratedImagery(visualMode: string): boolean {
  return visualMode === "ai_images" || visualMode === "ai_video";
}

/**
 * The image step's real-vs-AI sourcing policy, resolved from `visualMode` +
 * `archivalStrength` (2026-07-12 operator ask: a historical channel got
 * 8 real / 74 AI images because every shot tried at most ONE Commons
 * candidate against a fixed fit bar — the dial scales both).
 *
 * - candidates: real candidates fetched + vision-scored per shot before
 *   falling back to generation (each score ≈ one cheap vision call)
 * - fitMin: the accept bar (agents IMAGE_FIT_MIN is 5 — "balanced" keeps it;
 *   pushing harder accepts imperfect-but-real over generated)
 * - topicFallback: keyword-search the archive for shots with no named entity
 * - topicSecondPass: ALSO topic-search when a named entity found nothing
 */
export type ArchivalImagePolicy = {
  attemptSourcing: boolean;
  candidates: number;
  fitMin: number;
  topicFallback: boolean;
  topicSecondPass: boolean;
};

export function archivalImagePolicy(profile: {
  visualMode: string;
  archivalStrength?: string;
}): ArchivalImagePolicy {
  const strength = profile.archivalStrength ?? "balanced";
  if (preferGeneratedImagery(profile.visualMode) || strength === "off") {
    return { attemptSourcing: false, candidates: 0, fitMin: Infinity, topicFallback: false, topicSecondPass: false };
  }
  switch (strength) {
    case "light":
      return { attemptSourcing: true, candidates: 1, fitMin: 6, topicFallback: false, topicSecondPass: false };
    case "strong":
      return { attemptSourcing: true, candidates: 3, fitMin: 4, topicFallback: true, topicSecondPass: true };
    case "max":
      return { attemptSourcing: true, candidates: 5, fitMin: 3, topicFallback: true, topicSecondPass: true };
    case "balanced":
    default:
      return { attemptSourcing: true, candidates: 1, fitMin: 5, topicFallback: true, topicSecondPass: false };
  }
}

// ── Per-video profile tweaks (2026-07-12 operator ask) ────────────────────
// The channel profile is the DEFAULT; after script approval an AI pass reads
// the approved script and proposes per-video tweaks BEFORE any voice/visual
// spend. T0/T1 surface it as a profile_review gate; T2/T3 auto-apply.

/**
 * Axes the AI may propose changing. visualMode and motion are deliberately
 * excluded — they carry cost cliffs (AI video, renders) and stay operator-only
 * (the operator can still change ANY axis at the gate).
 */
export const AI_TWEAKABLE_AXES = [
  "rhythm",
  "captions",
  "music",
  "delivery",
  "archivalStrength",
] as const;

export const profileTweaksSchema = z.object({
  /** true = the channel defaults fit this script; changes must be empty */
  accept: z.boolean(),
  changes: z
    .array(
      z.object({
        axis: z.enum(AI_TWEAKABLE_AXES),
        /** the proposed value for the axis (validated against the axis enum on apply) */
        to: z.string(),
        why: z.string().max(240),
      }),
    )
    .max(5),
  rationale: z.string().max(400),
});
export type ProfileTweaks = z.infer<typeof profileTweaksSchema>;

/**
 * Apply AI-proposed tweaks over a base profile. Invalid axis values are
 * dropped silently (the schema constrains the axis but `to` is free text from
 * a model); the result is re-resolved so it is always a complete profile.
 */
export function applyProfileTweaks(
  base: ProductionProfile,
  tweaks: ProfileTweaks,
): ProductionProfile {
  const next: Record<string, unknown> = { ...base };
  for (const c of tweaks.changes) {
    const v = c.to.trim().toLowerCase();
    switch (c.axis) {
      case "rhythm":
        if ((RHYTHM_MODES as readonly string[]).includes(v)) next.rhythm = v;
        break;
      case "captions":
        if (["on", "true", "yes"].includes(v)) next.captions = true;
        else if (["off", "false", "no"].includes(v)) next.captions = false;
        break;
      case "music":
        if ((MUSIC_MODES as readonly string[]).includes(v)) next.music = v;
        break;
      case "delivery":
        if ((DELIVERY_MODES as readonly string[]).includes(v)) next.delivery = v;
        break;
      case "archivalStrength":
        if ((ARCHIVAL_STRENGTHS as readonly string[]).includes(v)) next.archivalStrength = v;
        break;
    }
  }
  return resolveProductionProfile(next as Partial<ProductionProfile>);
}

/** ElevenLabs-style voice settings (also the shape the VoiceProvider accepts). */
export type VoiceSettings = {
  stability: number;
  similarityBoost: number;
  style: number;
  useSpeakerBoost: boolean;
};

/**
 * Map a persona `delivery` to TTS voice settings. Lower stability + higher
 * style = more expressive/varied; higher stability = calm and even. Tuned for
 * ElevenLabs' 0–1 ranges; a generic shape so any TTS provider can consume it.
 */
export function deliveryVoiceSettings(delivery: string): VoiceSettings {
  const base = { similarityBoost: 0.75, useSpeakerBoost: true };
  switch (delivery) {
    case "warm":
      return { ...base, stability: 0.5, style: 0.3 };
    case "energetic":
      return { ...base, stability: 0.35, style: 0.55 };
    case "dramatic":
      return { ...base, stability: 0.3, style: 0.7 };
    case "measured":
    default:
      return { ...base, stability: 0.6, style: 0.15 };
  }
}
