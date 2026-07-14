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
export const MUSIC_MODES = ["off", "subtle", "standard"] as const;
export const DELIVERY_MODES = ["measured", "warm", "energetic", "dramatic"] as const;
export const ARCHIVAL_STRENGTHS = ["off", "light", "balanced", "strong", "max"] as const;
export const IMAGE_ENGINES = ["fal", "nano-banana", "mixed"] as const;
export const VIDEO_ENGINES = ["wan", "minimax"] as const;

/** Max length for the free-text art-direction / notes fields (keeps prompts sane). */
export const PROFILE_NOTE_MAX = 800;

export const productionProfileSchema = z.object({
  visualMode: z.enum(VISUAL_MODES),
  motion: z.enum(MOTION_MODES),
  rhythm: z.enum(RHYTHM_MODES),
  captions: z.boolean(),
  music: z.enum(MUSIC_MODES),
  delivery: z.enum(DELIVERY_MODES),
  archivalStrength: z.enum(ARCHIVAL_STRENGTHS).optional(),
  imageEngine: z.enum(IMAGE_ENGINES).optional(),
  videoEngine: z.enum(VIDEO_ENGINES).optional(),
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
    captions: typeof s.captions === "boolean" ? s.captions : true,
    music: pick(s.music, MUSIC_MODES, "off"),
    delivery: pick(s.delivery, DELIVERY_MODES, "measured"),
    archivalStrength: pick(s.archivalStrength, ARCHIVAL_STRENGTHS, "balanced"),
    imageEngine: pick(s.imageEngine, IMAGE_ENGINES, "fal"),
    videoEngine: pick(s.videoEngine, VIDEO_ENGINES, "wan"),
    artDirection: trim(s.artDirection),
    notes: trim(s.notes),
  };
}

/**
 * Resolve the generation engine for one image from the channel's profile:
 * "fal" (default) keeps everything on fal.ai; "nano-banana" puts everything on
 * the Google-direct provider; "mixed" renders bulk shots on Flux and sends the
 * hero tier (pivotal shots + thumbnails) to Google-direct Nano Banana.
 */
/** AI beat-clip engine for a channel — Wan (Alibaba, default) or Minimax Hailuo. */
export function videoEngineFor(profile: Pick<ProductionProfile, "videoEngine">): "wan" | "minimax" {
  return profile.videoEngine === "minimax" ? "minimax" : "wan";
}

export function imageEngineFor(
  profile: Pick<ProductionProfile, "imageEngine">,
  quality?: "standard" | "hero",
): "fal" | "nano-banana" {
  const engine = profile.imageEngine ?? "fal";
  if (engine === "nano-banana") return "nano-banana";
  if (engine === "mixed" && quality === "hero") return "nano-banana";
  return "fal";
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
