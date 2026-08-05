import { z } from "zod";
import type { ProductionProfile } from "@ytauto/db";
import {
  CAPTION_POSITIONS,
  CAPTION_CASINGS,
  CAPTION_TYPEFACES,
  CAPTION_WEIGHT_MIN,
  CAPTION_WEIGHT_MAX,
  CAPTION_OUTLINE_WIDTH_MAX,
  type CaptionStyle,
} from "./caption-style";

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
/**
 * #73: a NUMERIC hold-duration floor (seconds a single still is held before the
 * frame cuts), overriding the imageDensity-derived floor. imageDensity's named
 * tiers top out at ~11s on `relaxed` (7 × 1.6), but a contemplative still-image
 * channel wants ~20-25s holds — a continuous quantity the tiers don't span. When
 * set (and > 0) this REPLACES the density floor: fewer, longer shots for the same
 * runtime (which also halves the shot count / generation bill and dissolves the
 * #69 beat-vs-shot supply gap). Bounded to keep the render sane. Unset = the
 * density-derived floor (behaviour-preserving). Still clamped under the i2v clip
 * cap when the video animates, so an animating shot can always fit a clip.
 */
export const MIN_SECONDS_PER_SHOT_MIN = 2;
export const MIN_SECONDS_PER_SHOT_MAX = 60;
export const MUSIC_MODES = ["off", "subtle", "standard"] as const;
export type MusicMode = (typeof MUSIC_MODES)[number];
/**
 * #73: still-image motion at RENDER time — a free Ken-Burns transform on each
 * held still (distinct from `motion`, which generates expensive i2v CLIPS). The
 * renderer already applied a hardcoded slow zoom-in (1.0→1.12); this exposes it.
 * `slow_push` zooms in, `slow_pull` out, `drift` is a gentle diagonal pan, `none`
 * holds the frame still. Default (unset) reproduces the prior slow_push@0.12.
 */
export const STILL_MOTIONS = ["none", "slow_push", "slow_pull", "drift"] as const;
export type StillMotion = (typeof STILL_MOTIONS)[number];
/** #73: transition between stills — a hard `cut` (prior behaviour) or a `dissolve`
 * crossfade over `transitionMs`. */
export const SHOT_TRANSITIONS = ["cut", "dissolve"] as const;
export type ShotTransition = (typeof SHOT_TRANSITIONS)[number];
/** Prior renderer defaults, so an unset profile renders byte-identically. */
export const DEFAULT_STILL_MOTION: StillMotion = "slow_push";
export const DEFAULT_STILL_MOTION_AMOUNT = 0.12;
export const STILL_MOTION_AMOUNT_MAX = 0.15;
export const SHOT_TRANSITION_MS_MAX = 2000;

/**
 * The Ken-Burns transform for a still at progress `frac` (0..1 through its hold).
 * Pure + unit-tested so the renderer, the estimate and any preview agree. The
 * default (slow_push @ 0.12) yields scale 1→1.12, matching the prior hardcoded
 * zoom exactly. `amount` is clamped to [0, 0.15]; `drift` also pans diagonally.
 */
export function stillMotionTransform(
  kind: StillMotion,
  amount: number,
  frac: number,
): { scale: number; translateXPct: number; translateYPct: number } {
  const a = Math.max(0, Math.min(STILL_MOTION_AMOUNT_MAX, Number.isFinite(amount) ? amount : 0));
  const f = Math.max(0, Math.min(1, Number.isFinite(frac) ? frac : 0));
  switch (kind) {
    case "none":
      return { scale: 1, translateXPct: 0, translateYPct: 0 };
    case "slow_pull":
      return { scale: 1 + a * (1 - f), translateXPct: 0, translateYPct: 0 };
    case "drift": {
      // a slight fixed zoom so the panned edges never reveal the backing colour
      const scale = 1 + Math.max(a, 0.06);
      const span = a * 100; // percent of frame travelled over the hold
      return { scale, translateXPct: (f - 0.5) * span, translateYPct: (f - 0.5) * span * 0.5 };
    }
    case "slow_push":
    default:
      return { scale: 1 + a * f, translateXPct: 0, translateYPct: 0 };
  }
}
/**
 * Ducked bed level per music mode — the LINEAR volume the background track plays
 * at UNDER the full-volume (1.0) narration in the Remotion render. AI-generated
 * tracks are usually mastered loud, so these are deliberately low so the voice
 * always sits clearly on top (2026-07-17 operator: don't let it get too loud).
 * subtle ≈ -30dB, standard ≈ -22dB. "off" = no bed. Override the exact numbers
 * here if a channel wants it hotter/quieter.
 */
export const MUSIC_VOLUMES: Record<MusicMode, number> = {
  off: 0,
  subtle: 0.03,
  standard: 0.08,
};
export const DELIVERY_MODES = ["measured", "warm", "energetic", "dramatic"] as const;
export const ARCHIVAL_STRENGTHS = ["off", "light", "balanced", "strong", "max"] as const;
/** Vendor-DIRECT image engines (fal fully removed 2026-07-16): "qwen"
 * (DashScope bulk), "seedream" (ByteDance ModelArk bulk), "nano-banana"
 * (Gemini, hero/character). Legacy stored "fal"/"mixed" values fail validation
 * and resolve to the "qwen" default. */
export const IMAGE_ENGINES = ["qwen", "seedream", "nano-banana"] as const;

/**
 * #102: the gates a channel can ask for by name. Mirrors the pipeline's gate
 * kinds; `voiceover_recording` is included so the whole review topology is
 * described in ONE place rather than spread across a tier, three authoring
 * flags and two autoApprove booleans.
 */
export const REVIEWABLE_GATES = [
  "script_review",
  "profile_review",
  "voiceover_recording",
  "visuals_review",
  "thumbnail_review",
] as const;
export type ReviewableGate = (typeof REVIEWABLE_GATES)[number];

/**
 * #102: is this gate required for a production?
 *
 * `declared` (productionProfile.gates) can only ADD — a gate the tier or the
 * authoring flags would have skipped is presented when the channel names it.
 * Removal is deliberately NOT possible here; that stays with autoApprove*,
 * which is the audited path. Pure so the rule is testable and both surfaces
 * agree on it.
 */
export function gateRequired(input: {
  gate: ReviewableGate;
  /** what the tier + authoring flags imply on their own */
  impliedByDefault: boolean;
  /** productionProfile.gates, when the channel declared one */
  declared?: readonly string[] | null;
  /** the operator's explicit per-video removal (autoApprove* / force-forward) */
  waived?: boolean;
}): boolean {
  if (input.waived) return false;
  const named = Array.isArray(input.declared) && input.declared.includes(input.gate);
  return input.impliedByDefault || named;
}

/** #101: who narrates — synthesised, or the operator's own recorded takes. */
export const VOICE_SOURCES = ["tts", "operator"] as const;
export type VoiceSource = (typeof VOICE_SOURCES)[number];

/**
 * Frame shape for every image, clip and render on the channel (2026-07-25
 * operator: "we should have the option of an aspect ratio here — landscape or
 * portrait"). EXPLICIT beats inferred: "auto" keeps the old derivation (long-form
 * → landscape, Shorts → portrait), but a channel set to contentFormat "both"
 * inferred as SHORT in some places and LONG in others, so regenerated images came
 * back portrait on a 16:9 video. Setting this pins it.
 */
export const VIDEO_ORIENTATIONS = ["auto", "landscape", "portrait"] as const;
export type VideoOrientation = (typeof VIDEO_ORIENTATIONS)[number];
// "seedance" = the cheap MINI model (default for cartoon channels);
// "seedance-pro" = the pricey cinematic Pro model (2026-07-17 operator).
export const VIDEO_ENGINES = ["wan", "minimax", "seedance", "seedance-pro", "kling"] as const;
/** ElevenLabs TTS models. turbo/flash v2.5 = the cheap tier (~$0.05/1k chars);
 * multilingual_v2 + v3 = the expressive tier (~$0.10/1k, ~2x). v3 is the most
 * expressive (alpha) — see providers/real/voice.ts for the id map + alignment
 * fallback. Default turbo_v2_5 preserves current behaviour + cost. */
export const VOICE_MODELS = ["turbo_v2_5", "flash_v2_5", "multilingual_v2", "v3"] as const;

/** Max length for the short free-text fields (mood label, thumbnail template). */
export const PROFILE_NOTE_MAX = 800;
/**
 * Max length for the standing-guidance fields (`notes`, `artDirection`,
 * `thumbnailTemplate`). These are read by an LLM before an authoring pass, not
 * rendered in a fixed UI, and are the durable channel-scoped instruction
 * surface — 800 chars filled up fast (ticket 01KY1Y27…), then 6,000 became the
 * binding constraint on a fully-specified channel brief (ticket 01KYGEW6… / #71:
 * the operator was cutting hard-won operating knowledge to fit, and the evidence
 * that stops a settled decision being relitigated is exactly what costs chars).
 * Raised to 50,000 (~12,500 tokens) so a complete brief fits without pre-truncation.
 *
 * IMPORTANT — this IS a prompt-context surface, not just storage (#71 point 3):
 * `notes` is injected once per authoring pass and `thumbnailTemplate` once per
 * thumbnail build (cheap), but `artDirection` is injected into EVERY per-shot
 * image prompt, so a very large artDirection multiplies token cost across a
 * video's shots. `guidanceBudgetWarnings` surfaces that on write so raising the
 * cap doesn't silently degrade generation — see #71.
 */
export const PROFILE_GUIDANCE_MAX = 50000;

/** Per-shot image-prompt injection makes artDirection the cost-sensitive field:
 * beyond this it's worth splitting per-shot detail into the shot prompt. */
export const ART_DIRECTION_SOFT_ADVISORY = 6000;
/** notes/thumbnailTemplate inject once per pass — advise only well past the old cap. */
export const GUIDANCE_SOFT_ADVISORY = 24000;

/**
 * Non-blocking advisories for large standing-guidance fields (#71). Nothing is
 * rejected — the raised cap is deliberate — but a field big enough to move the
 * prompt-token budget (especially the per-shot `artDirection`) is surfaced so the
 * operator makes an informed call instead of silently degrading generation. Pure
 * function over the field lengths so it's unit-testable without a DB.
 */
export function guidanceBudgetWarnings(
  profile: Partial<Pick<ProductionProfile, "notes" | "artDirection" | "thumbnailTemplate">>,
): string[] {
  const warnings: string[] = [];
  const artLen = profile.artDirection?.length ?? 0;
  if (artLen > ART_DIRECTION_SOFT_ADVISORY) {
    warnings.push(
      `artDirection is ${artLen.toLocaleString()} chars and is injected into EVERY per-shot image prompt — on a video with many shots this multiplies token cost. Keep channel-wide art direction tight; put shot-specific detail in the per-beat imagePrompt instead.`,
    );
  }
  const notesLen = profile.notes?.length ?? 0;
  if (notesLen > GUIDANCE_SOFT_ADVISORY) {
    warnings.push(
      `notes is ${notesLen.toLocaleString()} chars — stored in full and injected once per authoring pass. Fine, but it now dominates the authoring prompt; trim anything not load-bearing for script generation (history/reasoning can live in the channel strategy doc).`,
    );
  }
  const tmplLen = profile.thumbnailTemplate?.length ?? 0;
  if (tmplLen > GUIDANCE_SOFT_ADVISORY) {
    warnings.push(
      `thumbnailTemplate is ${tmplLen.toLocaleString()} chars — injected once per thumbnail build; fine, but only the parts that describe the frame need to be here.`,
    );
  }
  return warnings;
}

export const productionProfileSchema = z.object({
  visualMode: z.enum(VISUAL_MODES),
  motion: z.enum(MOTION_MODES),
  rhythm: z.enum(RHYTHM_MODES),
  imageDensity: z.enum(IMAGE_DENSITIES).optional(),
  /** #73: explicit hold-duration floor in seconds, overriding the density tier. */
  minSecondsPerShot: z.number().min(MIN_SECONDS_PER_SHOT_MIN).max(MIN_SECONDS_PER_SHOT_MAX).optional(),
  /** Visual Director (#37): a director agent cuts the shots on meaning + picks
   * each shot's medium, instead of the mechanical rhythm cut. Opt-in. */
  visualDirector: z.boolean().optional(),
  captions: z.boolean(),
  /** #72: burned-in caption STYLE (position/casing/typeface/weight/outline/
   * emphasis). captions (bool) still gates on/off; this styles them. Unset =
   * the prior hardcoded lower-third TikTok look. */
  captionStyle: z
    .object({
      position: z.enum(CAPTION_POSITIONS).optional(),
      casing: z.enum(CAPTION_CASINGS).optional(),
      typeface: z.enum(CAPTION_TYPEFACES).optional(),
      weight: z.number().min(CAPTION_WEIGHT_MIN).max(CAPTION_WEIGHT_MAX).optional(),
      outline: z.boolean().optional(),
      maxLines: z.number().min(1).max(4).optional(),
      emphasisColor: z.string().max(32).optional(),
      emphasisPhrases: z.array(z.string()).max(40).optional(),
      // #79 legibility fields.
      color: z.string().max(32).optional(),
      activeColor: z.string().max(32).optional(),
      outlineColor: z.string().max(32).optional(),
      outlineWidth: z.number().min(0).max(CAPTION_OUTLINE_WIDTH_MAX).optional(),
      shadow: z.boolean().optional(),
      scrim: z.boolean().optional(),
    })
    // #79: reject unknown keys instead of silently dropping them — a config write
    // that "succeeds" while discarding fields (color/outlineColor/…) is worse than
    // a hard error, because the operator stops looking. normaliseProfile names the
    // offending field in the thrown message.
    .strict()
    .optional(),
  /** #73: still-image Ken-Burns axis (render-time transform, not clip generation). */
  stillMotion: z.enum(STILL_MOTIONS).optional(),
  stillMotionAmount: z.number().min(0).max(STILL_MOTION_AMOUNT_MAX).optional(),
  transition: z.enum(SHOT_TRANSITIONS).optional(),
  transitionMs: z.number().min(0).max(SHOT_TRANSITION_MS_MAX).optional(),
  music: z.enum(MUSIC_MODES),
  /** default music mood/brief for this channel (2026-07-17); per-video picks
   * can override it. Free text, e.g. "tense cinematic". */
  musicMood: z.string().max(PROFILE_NOTE_MAX).optional(),
  delivery: z.enum(DELIVERY_MODES),
  /** ElevenLabs TTS model (distinct from the voice id). Unset → turbo_v2_5. */
  voiceModel: z.enum(VOICE_MODELS).optional(),
  archivalStrength: z.enum(ARCHIVAL_STRENGTHS).optional(),
  /**
   * P2 (OPT-IN, default off): run the automated compliance checks — variation,
   * anti-clone and the review board — BEFORE the visuals gate instead of after.
   *
   * Today they fire after a human has approved the visuals, so the operator
   * spends their review attention and only then can an automated check veto it,
   * landing in `on_hold` rather than back at a reviewable state (#97 cost $6.95
   * and a full review pass this way). Running them first means a block lands on
   * work nobody has reviewed yet.
   *
   * Default OFF because it moves what "approved" means in the compliance log —
   * the repo rule is that anything changing live production behaviour ships
   * opt-in and is enabled with the operator present.
   */
  earlyComplianceChecks: z.boolean().optional(),
  /**
   * #101: who narrates, as a CHANNEL default. "tts" (default) synthesises via
   * ElevenLabs; "operator" holds the run at a `voiceover_recording` gate so the
   * operator records each beat in the cockpit recorder — beats left unrecorded
   * are TTS-filled in the channel voice, and recorded takes are force-aligned
   * (Whisper) so captions and shot boundaries still cut from real word timings.
   *
   * The per-production toggle already existed; this makes a human-narrated
   * CHANNEL not need it set on every video.
   */
  voiceSource: z.enum(VOICE_SOURCES).optional(),
  /**
   * #102: which human review gates this channel wants, named explicitly.
   *
   * Gate placement used to be implied by two things that aren't gate controls:
   * `autonomyTier` (a coarse ladder) and `scriptAuthored` (which skips
   * script_review unconditionally). That conflated "who wrote it" with "does a
   * human approve it" — so "I wrote this myself AND I want to approve it before
   * it moves on" was unexpressible, which is precisely the operator-authored
   * case. Same class of conflation P6 already split out of `externalScript`.
   *
   * Declared gates are ADDED to whatever the tier and authoring flags imply —
   * they never remove one. Adding review is always safe; REMOVING it stays with
   * the audited `autoApprove*` flags, so this axis can't become a quiet way to
   * bypass the approval log. Omit the field and behaviour is exactly as before.
   */
  gates: z.array(z.enum(REVIEWABLE_GATES)).optional(),
  imageEngine: z.enum(IMAGE_ENGINES).optional(),
  /** explicit frame shape; "auto" (default) derives it from the content format */
  orientation: z.enum(VIDEO_ORIENTATIONS).optional(),
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
  artDirection: z.string().max(PROFILE_GUIDANCE_MAX).optional(),
  notes: z.string().max(PROFILE_GUIDANCE_MAX).optional(),
  /** BACKLOG #36 gate automation: when true, auto-approve the visuals_review
   * gate (skip the human check) even on gated (T0/T1) channels — "check the
   * visuals at first, auto-run once the look is dialled in". The final
   * (thumbnail_review) gate and the safety checks are unaffected. Default off. */
  autoApproveVisuals: z.boolean().optional(),
  /** Same, for the final (thumbnail_review) publish gate. Default off — keep the
   * human sign-off on what actually goes live unless explicitly turned on. */
  autoApproveFinal: z.boolean().optional(),
  /** Remediation §3.5: per-channel thumbnail template/brief for a consistent
   * series frame — injected into thumbnail prompt building. Standing guidance read
   * by an LLM (not a UI field), so it gets the larger 6000-char cap like
   * notes/artDirection (ticket 01KY6F1X… — 800 was the stale pre-raise notes cap). */
  thumbnailTemplate: z.string().max(PROFILE_GUIDANCE_MAX).optional(),
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
  // Standing-guidance fields get the larger cap (read by an LLM, not a UI).
  const trimLong = (v: unknown): string | undefined => {
    const t = typeof v === "string" ? v.trim() : "";
    return t ? t.slice(0, PROFILE_GUIDANCE_MAX) : undefined;
  };
  return {
    visualMode: pick(s.visualMode, VISUAL_MODES, "mixed"),
    motion: pick(s.motion, MOTION_MODES, "static"),
    rhythm: pick(s.rhythm, RHYTHM_MODES, "sentence"),
    imageDensity: pick(s.imageDensity, IMAGE_DENSITIES, "standard"),
    minSecondsPerShot:
      typeof s.minSecondsPerShot === "number" && Number.isFinite(s.minSecondsPerShot) && s.minSecondsPerShot > 0
        ? Math.max(MIN_SECONDS_PER_SHOT_MIN, Math.min(MIN_SECONDS_PER_SHOT_MAX, s.minSecondsPerShot))
        : undefined,
    visualDirector: typeof s.visualDirector === "boolean" ? s.visualDirector : false,
    captions: typeof s.captions === "boolean" ? s.captions : true,
    // #72: pass through the stored caption style verbatim (resolved to defaults
    // at render via resolveCaptionStyle); undefined when unset so it's omitted.
    captionStyle: s.captionStyle ? (s.captionStyle as CaptionStyle) : undefined,
    stillMotion: pick(s.stillMotion, STILL_MOTIONS, DEFAULT_STILL_MOTION),
    stillMotionAmount:
      typeof s.stillMotionAmount === "number" && Number.isFinite(s.stillMotionAmount) && s.stillMotionAmount >= 0
        ? Math.min(STILL_MOTION_AMOUNT_MAX, s.stillMotionAmount)
        : DEFAULT_STILL_MOTION_AMOUNT,
    transition: pick(s.transition, SHOT_TRANSITIONS, "cut"),
    transitionMs:
      typeof s.transitionMs === "number" && Number.isFinite(s.transitionMs) && s.transitionMs >= 0
        ? Math.min(SHOT_TRANSITION_MS_MAX, Math.round(s.transitionMs))
        : 0,
    music: pick(s.music, MUSIC_MODES, "off"),
    delivery: pick(s.delivery, DELIVERY_MODES, "measured"),
    voiceModel: pick(s.voiceModel, VOICE_MODELS, "turbo_v2_5"),
    archivalStrength: pick(s.archivalStrength, ARCHIVAL_STRENGTHS, "balanced"),
    // P2: opt-in, default off — see the schema note above.
    earlyComplianceChecks: s.earlyComplianceChecks === true,
    voiceSource: pick(s.voiceSource, VOICE_SOURCES, "tts"),
    gates: Array.isArray(s.gates)
      ? (s.gates.filter((g): g is ReviewableGate => (REVIEWABLE_GATES as readonly string[]).includes(g)) ?? [])
      : undefined,
    imageEngine: pick(s.imageEngine, IMAGE_ENGINES, "qwen"),
    orientation: pick(s.orientation, VIDEO_ORIENTATIONS, "auto"),
    // per-role engines default to Nano Banana (the quality tier) for
    // hero/character/thumbnail; bulk follows imageEngine above
    heroImageEngine: pick(s.heroImageEngine, IMAGE_ENGINES, "nano-banana"),
    characterImageEngine: pick(s.characterImageEngine, IMAGE_ENGINES, "nano-banana"),
    thumbnailImageEngine: pick(s.thumbnailImageEngine, IMAGE_ENGINES, "nano-banana"),
    // Seedance is the default beat-clip engine (2026-07-17 operator: it's the
    // only video engine they have an API key for). Override per channel on the
    // Style tab; keyless installs still fall back to the mock in the factory.
    videoEngine: pick(s.videoEngine, VIDEO_ENGINES, "seedance"),
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
    artDirection: trimLong(s.artDirection),
    notes: trimLong(s.notes),
    musicMood: trim(s.musicMood),
    autoApproveVisuals: typeof s.autoApproveVisuals === "boolean" ? s.autoApproveVisuals : false,
    autoApproveFinal: typeof s.autoApproveFinal === "boolean" ? s.autoApproveFinal : false,
    thumbnailTemplate: trimLong(s.thumbnailTemplate),
  };
}

/** The i2v clip cap a moving shot is force-cut to when the caller can't read the
 * env value (VIDEO_MAX_CLIP_SEC). Mirrors shot-projection's DEFAULT_MAX_CLIP_SEC. */
export const DEFAULT_CLIP_CAP_SEC = 10;

/**
 * #69 (append): when motion animates (`motion` != static), the i2v clip cap
 * FORCE-CUTS every moving shot to ~`maxClipSec`, which overrides a higher
 * `minSecondsPerShot` — so raising the hold-duration floor on an animating channel
 * saves no shots and no generation spend, silently and with no warning. Returns a
 * warning string when the floor is set above the clip cap while motion animates,
 * else null. Pure + unit-tested so set_channel_config and the shot projection agree.
 */
export function minSecondsPerShotOverrideWarning(
  profile: Pick<ProductionProfile, "motion" | "minSecondsPerShot">,
  maxClipSec: number = DEFAULT_CLIP_CAP_SEC,
): string | null {
  const floor = profile.minSecondsPerShot;
  if (typeof floor !== "number" || !Number.isFinite(floor) || floor <= 0) return null;
  if (profile.motion === "static") return null;
  if (floor <= maxClipSec) return null;
  return `minSecondsPerShot ${floor}s has NO effect while motion is '${profile.motion}': animating shots are force-cut to the ~${maxClipSec}s i2v clip cap, so the floor is overridden and the shot count / generation bill is not reduced. For fewer, longer shots set motion 'static' (Ken-Burns holds honour the floor), or lower minSecondsPerShot to ≤ ${maxClipSec}s.`;
}

/**
 * #80: merge a per-video PARTIAL override OVER a channel's stored profile, then
 * resolve to a complete profile. A partial override — even a single axis — must
 * NEVER reset the other axes to platform defaults: the stored axes are kept and
 * only the supplied axes win. This mirrors set_channel_config's spread-over-stored
 * partial-write semantics, and is the fix for author_script silently wiping
 * motion / every image engine / voiceModel when a caller sent one unrelated axis.
 *
 * Pure (spread + resolve) so it's unit-testable without a DB. Passing no override
 * reproduces `resolveProductionProfile(stored)` exactly (behaviour-preserving).
 */
export function mergeProductionProfile(
  stored: Partial<ProductionProfile> | null | undefined,
  override: Partial<ProductionProfile> | null | undefined,
  opts: { contentFormat?: string } = {},
): ProductionProfile {
  return resolveProductionProfile({ ...(stored ?? {}), ...(override ?? {}) }, opts);
}

/** A few starter moods so the operator can generate contrasting options fast. */
export const MUSIC_MOOD_PRESETS = [
  "warm cinematic documentary",
  "tense, driving, suspenseful",
  "upbeat, bright, curious",
  "calm, ambient, reflective",
  "epic, orchestral, dramatic",
] as const;

/**
 * Build the brief sent to the music provider for ONE background bed. The mood
 * (operator's per-video pick, else the channel default) leads; the video's
 * subject/tone give it context. Always instrumental, no vocals, consistent —
 * it sits UNDER narration.
 */
export function musicBriefFor(
  mood: string | null | undefined,
  ctx: { title?: string | null; tone?: string | null; niche?: string | null } = {},
): string {
  const m = (mood ?? "").trim();
  const bits = [
    m || "gentle, unobtrusive",
    "instrumental background music for a narrated video",
    ctx.title ? `about "${String(ctx.title).slice(0, 120)}"` : null,
    ctx.tone ? `${String(ctx.tone).slice(0, 60)} tone` : null,
    ctx.niche ? `${String(ctx.niche).slice(0, 60)} channel` : null,
  ].filter(Boolean);
  return `${bits.join(", ")}. No vocals. Consistent, low-key mood that sits under narration.`;
}

/** AI beat-clip engine for a channel — Seedance (default) / Wan / Minimax Hailuo
 * / Kling. `character` picks the character-clip engine when one is set. */
export function videoEngineFor(
  profile: Pick<ProductionProfile, "videoEngine" | "characterVideoEngine" | "heroVideoEngine">,
  opts?: { character?: boolean; hero?: boolean },
): "wan" | "minimax" | "seedance" | "seedance-pro" | "kling" {
  const norm = (v: string | undefined): "wan" | "minimax" | "seedance" | "seedance-pro" | "kling" =>
    v === "minimax" ? "minimax" : v === "wan" ? "wan" : v === "kling" ? "kling" : v === "seedance-pro" ? "seedance-pro" : "seedance";
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

/**
 * @deprecated Use `imageEngineForRole(profile, role)` instead. This two-tier
 * helper PINS nano-banana for anything "hero", which silently overrode the
 * channel's own heroImageEngine/thumbnailImageEngine — the cockpit used it for
 * thumbnails and shot regenerations while the worker used the per-role helper,
 * so the two disagreed and a Style-tab preference of seedream still rendered on
 * nano (2026-07-25 operator). Kept only for the pre-2026-07-16 single-axis
 * behaviour; no production code path should call it.
 */
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
