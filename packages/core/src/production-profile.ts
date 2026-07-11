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

/** Max length for the free-text art-direction / notes fields (keeps prompts sane). */
export const PROFILE_NOTE_MAX = 800;

export const productionProfileSchema = z.object({
  visualMode: z.enum(VISUAL_MODES),
  motion: z.enum(MOTION_MODES),
  rhythm: z.enum(RHYTHM_MODES),
  captions: z.boolean(),
  music: z.enum(MUSIC_MODES),
  delivery: z.enum(DELIVERY_MODES),
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
    artDirection: trim(s.artDirection),
    notes: trim(s.notes),
  };
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
