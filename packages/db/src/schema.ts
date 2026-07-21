/**
 * Canonical data model: Channel → Idea → (Score) → Production → Assets →
 * Publication → Analytics, with review gates as logged state transitions.
 *
 * Variation-check note: v1 stores a substanceFingerprint per production and
 * compares with Jaccard shingles in app code. If that proves too coarse,
 * migrate to pgvector: `ALTER TABLE productions ADD COLUMN embedding vector(1536)`.
 */
import { sql as drizzleSql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  vector,
} from "drizzle-orm/pg-core";

// ── Enums ────────────────────────────────────────────────────────────────

export const channelStatus = pgEnum("channel_status", ["active", "paused", "archived"]);

export const ideaStatus = pgEnum("idea_status", [
  "inbox",
  "scored",
  "greenlit",
  "rejected",
  "archived",
]);

export const ideaSource = pgEnum("idea_source", ["agent", "manual", "research", "editorial"]);

export const productionStatus = pgEnum("production_status", [
  "proposed",
  "scored",
  "greenlit",
  "scripting",
  "script_review",
  "profile_review",
  // #27: waiting on the operator to record per-beat voiceover takes
  "voiceover_recording",
  "producing_assets",
  "visuals_review",
  "assembling",
  "thumbnail_review",
  "ready",
  "scheduled",
  "published",
  "analysing",
  // off-ramps
  "rejected",
  "failed",
  "on_hold",
  // operator pulled it back to the idea pool; kept as a resumable draft
  "halted",
  // replaced by a corrected re-upload (a "Make a corrected copy" of a published
  // video) — terminal; the original's live upload may have been deleted
  "superseded",
  // operator archived it from the Videos list (Retire, or Delete which also
  // removes the live YouTube upload) — terminal; kept for the audit trail
  "retired",
]);

export const gateKind = pgEnum("gate_kind", [
  "script_review",
  "profile_review",
  // #27: the per-beat recording booth — approve when takes are done (TTS
  // fills any beat left unrecorded); reject falls back to full TTS
  "voiceover_recording",
  "visuals_review",
  "thumbnail_review",
]);

export const gateStatus = pgEnum("gate_status", ["pending", "decided", "expired"]);

export const gateDecision = pgEnum("gate_decision", ["approved", "rejected", "revise"]);

export const assetKind = pgEnum("asset_kind", [
  "voiceover",
  // #27: one operator-recorded take per beat (idx = beat index). PERMANENT —
  // human recordings are irreplaceable (voice-clone source material); any
  // future asset pruning must exclude this kind.
  "voiceover_take",
  "image",
  "render",
  "caption_track",
  "thumbnail",
  // BACKLOG #26: real archival footage for a hero beat (idx-aligned with the
  // beat's image; the render prefers the clip when present)
  "video_clip",
]);

export const costCategory = pgEnum("cost_category", [
  "llm",
  "voice",
  "media",
  "research",
  "publish",
  "render",
]);

// ── Shared column helpers ────────────────────────────────────────────────

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

// ── Tables ───────────────────────────────────────────────────────────────

export const channels = pgTable("channels", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  handle: text("handle").notNull(),
  niche: text("niche").notNull(),
  status: channelStatus("status").notNull().default("active"),
  /** primary content format: "short" | "long" | "both" (pipeline honors long-form later) */
  contentFormat: text("content_format").notNull().default("short"),
  /** 0=manual, 1=assisted, 2=supervised, 3=exception-only */
  autonomyTier: integer("autonomy_tier").notNull().default(0),
  youtubeChannelId: text("youtube_channel_id"),
  /** reference into the secrets store / env, never the token itself */
  oauthTokenRef: text("oauth_token_ref"),
  /** BACKLOG #6/#17: a Shorts channel derived from this long-form channel's
   * content (linked companion). Soft ref (no FK) to avoid self-delete-order
   * issues; the long→shorts cutting pipeline is the §6 follow-up. */
  derivedFromChannelId: text("derived_from_channel_id"),
  /** BACKLOG #23.3: how often the market-scan cron scouts this channel's
   * niche — "daily" | "weekly" (Mondays UTC) | "off". Explicit "Scan now"
   * requests always bypass the cadence. */
  intelCadence: text("intel_cadence").notNull().default("daily"),
  /** #21.6: operator override of the computed maturity phase —
   * "warming" | "establishing" | "established" | null (= computed) */
  maturityOverride: text("maturity_override"),
  /** channel logo/avatar: ObjectStore key (served via /api/media/<key>),
   * set from the wizard-generated avatar at creation or uploaded/generated
   * later on the Settings tab. Null → the card renders a placeholder. */
  avatarKey: text("avatar_key"),
  /** channel banner art: ObjectStore key (served via /api/media/<key>),
   * generated on the Settings tab or carried over from the wizard. YouTube's
   * API can't set banners — the operator downloads and uploads by hand. */
  bannerKey: text("banner_key"),
  ...timestamps,
});

export type ThumbnailSpec = {
  /** structural grammar for the niche's thumbnails */
  focalObject: string;
  textStyle: string;
  maxWords: number;
  colorContrast: string;
  negativeSpace: string;
};

/** Operator release plan (BACKLOG #17): warm-up ramp → first-month → steady. */
export type ReleasePlan = {
  /** weeks of throttled warm-up before full cadence */
  warmupWeeks: number;
  /** total videos to publish during the warm-up */
  warmupVideos: number;
  /** target videos published in the first month */
  firstMonthTarget: number;
  /** steady-state videos per month after warm-up (adjusts as data comes in) */
  monthlySteady: number;
};

/**
 * Production Profile (BACKLOG #18): the per-channel control plane — toggles
 * that decide which production tools run. Each axis is a scaffold seam; the
 * pipeline reads the resolved profile and honours a feature as it ships.
 * Nullable jsonb → a channel with no profile falls back to
 * `resolveProductionProfile` defaults (behaviour-preserving).
 */
export type ProductionProfile = {
  /** where each beat's visual comes from */
  visualMode: "simple" | "real_footage" | "ai_images" | "ai_video" | "mixed";
  /** whether/how the frame moves */
  motion: "static" | "partial" | "ai_video";
  /** how often the visual cuts, keyed to the voiceover word timings */
  rhythm: "sentence" | "section" | "pause";
  /** finer image-frequency dial on top of rhythm (2026-07-16): relaxed = fewer
   * (longer-held) images, busy = more; standard = unchanged. */
  imageDensity?: "relaxed" | "standard" | "busy";
  /** Visual Director (#37): the director agent cuts shots on meaning + picks
   * each shot's medium instead of the mechanical rhythm cut. Opt-in. */
  visualDirector?: boolean;
  /** burned-in word-by-word captions */
  captions: boolean;
  /** optional ducked music bed */
  music: "off" | "subtle" | "standard";
  /** default music mood/brief for generated beds (2026-07-17); per-video override
   * lives on the production. Free text, e.g. "tense cinematic". */
  musicMood?: string;
  /** how the voice performs (voice id itself is `voiceId`) */
  delivery: "measured" | "warm" | "energetic" | "dramatic";
  /**
   * How hard the pipeline pushes for REAL sourced imagery over AI generation
   * (2026-07-12 operator ask: historical channels got 8 real / 74 AI when the
   * archives are full of usable material). Scales candidates fetched per shot
   * and the vision fit-score bar; "off" never sources, "max" tries hardest.
   */
  archivalStrength?: "off" | "light" | "balanced" | "strong" | "max";
  /** free-text art direction for the image model / reference-photo selection */
  artDirection?: string;
  /** general standing notes injected into the pipeline prompts */
  notes?: string;
  /**
   * Which engine renders this channel's AI images (2026-07-14 operator ask):
   * "qwen" (default since fal's 2026-07-14 retirement: DashScope-direct
   * Qwen-Image bulk shots, hero pinned to Google-direct Nano Banana),
   * "seedream" (ByteDance Seedream bulk, DIRECT via BytePlus ModelArk, hero
   * still Nano Banana), or "nano-banana" (everything on Nano Banana). Legacy
   * stored "fal"/"mixed" values resolve to the qwen default (fal removed
   * 2026-07-16 — all engines are vendor-direct).
   */
  imageEngine?: "nano-banana" | "qwen" | "seedream";
  /** per-role image engines (2026-07-16): split which model draws each KIND of
   * shot. `imageEngine` above is the bulk/filler engine; these override hero,
   * character and thumbnail shots (each defaults to nano-banana). */
  heroImageEngine?: "nano-banana" | "qwen" | "seedream";
  characterImageEngine?: "nano-banana" | "qwen" | "seedream";
  thumbnailImageEngine?: "nano-banana" | "qwen" | "seedream";
  /** which AI video engine animates beat clips (2026-07-14 faceless tier):
   * "wan" (Alibaba via DashScope, default), "minimax" (Hailuo), "seedance"
   * (ByteDance, DIRECT via BytePlus ModelArk — best keyframe identity), or
   * "kling" (Kuaishou, DIRECT — premium cinematic). */
  videoEngine?: "wan" | "minimax" | "seedance" | "seedance-pro" | "kling";
  /** engine for clips whose shot casts the recurring character (2026-07-16):
   * when set, character clips animate here (e.g. Seedance for identity) while
   * filler clips stay on videoEngine; unset = every clip uses videoEngine. */
  characterVideoEngine?: "wan" | "minimax" | "seedance" | "seedance-pro" | "kling";
  /** engine for HERO-shot clips (2026-07-16): e.g. Kling for showcase beats;
   * character clips win over hero when both apply. Unset = the filler engine. */
  heroVideoEngine?: "wan" | "minimax" | "seedance" | "seedance-pro" | "kling";
  /** per-video cap on AI beat clips — the video cost knob (2026-07-16); unset
   * falls back to the VIDEO_MAX_AI_CLIPS env default (12). */
  maxAiClips?: number;
  /** BACKLOG #36: auto-approve the visuals_review gate even on gated channels —
   * "check the visuals at first, auto-run once the look is dialled in". Default off. */
  autoApproveVisuals?: boolean;
  /** BACKLOG #36: auto-approve the final (thumbnail_review) publish gate. Default off. */
  autoApproveFinal?: boolean;
  /** Remediation §3.5: a per-channel thumbnail template/brief injected into
   * thumbnail prompt building so a series keeps a consistent frame (e.g. "fixed
   * composition, only the element name/symbol/atomic number change"). Free text. */
  thumbnailTemplate?: string;
};

export const channelDna = pgTable(
  "channel_dna",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    tone: text("tone").notNull(),
    audiencePersona: text("audience_persona").notNull(),
    /** e.g. ["curiosity_gap", "stakes_first", "contrarian"] */
    hookStyles: jsonb("hook_styles").$type<string[]>().notNull().default([]),
    forbiddenTopics: jsonb("forbidden_topics").$type<string[]>().notNull().default([]),
    visualStyle: jsonb("visual_style")
      // tagline: optional brand-art typography line (2026-07-15) — lives here
      // so the logo/banner dialog can prefill it without a migration
      .$type<{ primaryColor: string; font: string; imageStyle: string; tagline?: string }>()
      .notNull(),
    /** per-niche thumbnail grammar (spec §5.5); null → derive on first use */
    thumbnailSpec: jsonb("thumbnail_spec").$type<ThumbnailSpec>(),
    voiceId: text("voice_id").notNull(),
    ctaTemplate: text("cta_template").notNull(),
    targetLengthSec: integer("target_length_sec").notNull().default(45),
    cadencePerWeek: integer("cadence_per_week").notNull().default(3),
    /** BACKLOG #17: structured warm-up → first-month → steady release plan */
    releasePlan: jsonb("release_plan").$type<ReleasePlan>(),
    /** BACKLOG #18: per-channel production control plane; null → resolved defaults */
    productionProfile: jsonb("production_profile").$type<ProductionProfile>(),
    /** ticket 01KY2BJ9…: named title families so title-format drift is detectable
     * (review_slate). null → no declared families; the slate reviewer skips the
     * conformance check. Each: a name, a format description, an optional example. */
    titleTemplates: jsonb("title_templates").$type<{ name: string; pattern: string; example?: string }[]>(),
    /** BACKLOG #21.1: the ACTIVE writing-persona version (soft ref → personas.id) */
    activePersonaId: text("active_persona_id"),
    /** #35.1: the ACTIVE visual-style version (soft ref → visual_styles.id) */
    activeStyleId: text("active_style_id"),
    ...timestamps,
  },
  (t) => [uniqueIndex("channel_dna_channel_id_uq").on(t.channelId)],
);

// ── Writing personas (BACKLOG #21.1) ──────────────────────────────────────

export const personaStatus = pgEnum("persona_status", ["draft", "active", "testing", "retired"]);
export const personaCreator = pgEnum("persona_creator", ["operator", "agent"]);

/** The persona DOCUMENT — the writer's voice (see @ytauto/core personaDocSchema). */
export type PersonaDoc = {
  /** who is speaking: background, POV, attitude (2-4 sentences, second person) */
  identity: string;
  /** concrete rules for how this person talks */
  voiceRules: string[];
  lexicon: { favor: string[]; avoid: string[] };
  /** 1-3 short passages in EXACTLY this voice (few-shot anchors) */
  exemplars: string[];
  /** default vocal delivery (drives TTS settings) */
  deliveryDefault: "measured" | "warm" | "energetic" | "dramatic";
  /** narration pace (BACKLOG #26): TTS speed multiplier; omitted = natural */
  pace?: "slow" | "natural" | "brisk";
  /** how this person asks viewers to stick around */
  ctaStyle: string;
};

/**
 * Versioned writing personas. A channel's episodes are all written by the same
 * "person"; every change is a NEW version (never mutate in place) so agents
 * can only propose tweaked versions — tested via the experiment machinery —
 * and provenance stays queryable (productions.personaId/personaVersion).
 */
export const personas = pgTable(
  "personas",
  {
    id: text("id").primaryKey(),
    /** null = library archetype (not channel-bound) */
    channelId: text("channel_id").references(() => channels.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    archetype: text("archetype").notNull(),
    version: integer("version").notNull().default(1),
    /** lineage: the version this one was tweaked from */
    parentId: text("parent_id"),
    status: personaStatus("status").notNull().default("draft"),
    createdBy: personaCreator("created_by").notNull().default("operator"),
    doc: jsonb("doc").$type<PersonaDoc>().notNull(),
    /** one line: why this persona/tweak (wizard rationale or experiment hypothesis) */
    rationale: text("rationale"),
    ...timestamps,
  },
  (t) => [index("personas_channel_id_idx").on(t.channelId)],
);

// ── Visual style DNA (BACKLOG #35.1) ───────────────────────────────────────

export const visualStyleStatus = pgEnum("visual_style_status", [
  "draft",
  "active",
  "testing",
  "retired",
]);

/** The distilled style DOCUMENT (see @ytauto/core visualStyleDistillSchema). */
export type VisualStyleDoc = {
  palette: string;
  lighting: string;
  composition: string;
  subjectTreatment: string;
  /** grain / film stock / render finish */
  texture: string;
  /** thumbnail overlay text treatment seen in the examples, or "none" */
  typography: string;
  /** mood/intensity */
  energy: string;
  /** distilled "Style: … Mood: …" clause appended to every generation prompt */
  promptSuffix: string;
  /** snapshot: the visual_style_refs ids this version was distilled from */
  refIds: string[];
  /** image-to-image conditioning config (versions with the doc) */
  conditioning?: {
    scope: "off" | "thumbnails" | "thumbs_hero" | "all_generated";
    /** flux image-to-image strength 0-1 (style transfer default 0.45) */
    strength: number;
  };
};

/**
 * Versioned channel visual styles (#35.1) — the visual analogue of personas:
 * distilled from ACTUAL example images, every change is a NEW version,
 * activation is explicit (channel_dna.active_style_id) and provenance stays
 * queryable (productions.styleId/styleVersion).
 */
export const visualStyles = pgTable(
  "visual_styles",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id").references(() => channels.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    version: integer("version").notNull().default(1),
    /** lineage: the version this one was distilled/edited from */
    parentId: text("parent_id"),
    status: visualStyleStatus("status").notNull().default("draft"),
    createdBy: personaCreator("created_by").notNull().default("operator"),
    doc: jsonb("doc").$type<VisualStyleDoc>().notNull(),
    rationale: text("rationale"),
    ...timestamps,
  },
  (t) => [index("visual_styles_channel_id_idx").on(t.channelId)],
);

/**
 * The channel's example-image pool (#35.1): uploads, other videos' thumbnails
 * (i.ytimg.com), or promoted own assets. Channel-scoped and LIVE — style
 * versions snapshot the ref ids they were distilled from (doc.refIds).
 */
export const visualStyleRefs = pgTable(
  "visual_style_refs",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    /** channels/<id>/style/ref-<ulid>.<ext> in the ObjectStore */
    storageKey: text("storage_key").notNull(),
    mimeType: text("mime_type").notNull(),
    /** provenance: where this example came from */
    source: jsonb("source")
      .$type<{
        type: "upload" | "youtube" | "asset" | "generated";
        url?: string;
        videoId?: string;
        assetId?: string;
        /** type "generated": the style test scene this ref was promoted from */
        sceneId?: string;
      }>()
      .notNull(),
    enabled: boolean("enabled").notNull().default(true),
    ...timestamps,
  },
  (t) => [index("visual_style_refs_channel_id_idx").on(t.channelId)],
);

/**
 * Recurring channel characters (2026-07-14 operator ask): a named character —
 * e.g. the teacher of an educational channel — with a canonical appearance
 * description and a Nano Banana reference sheet image. The image-prompt agent
 * injects the description (and the pipeline conditions on the reference image)
 * for shots whose scene calls for the character, keeping them consistent
 * across every video.
 */
export const channelCharacters = pgTable(
  "channel_characters",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** the operator's creative brief ("a warm 40s physics teacher…") */
    brief: text("brief").notNull(),
    /** canonical appearance paragraph — injected VERBATIM into image prompts */
    description: text("description").notNull(),
    /** channels/<id>/characters/<ulid>.<ext> reference sheet in the ObjectStore */
    imageKey: text("image_key").notNull(),
    mimeType: text("mime_type").notNull().default("image/png"),
    /** "main" = the channel's recurring lead the agent may cast per scene */
    role: text("role").notNull().default("main"),
    /** how often to cast this character (2026-07-15 mascot channels):
     * "auto" = builder discretion (presenter-biased), "always" = every
     * generated non-archival shot, "off" = never, "smart" = ~castTarget%
     * of shots chosen by importance (2026-07-16) */
    castMode: text("cast_mode").notNull().default("auto"),
    /** target share of shots for cast_mode="smart" (2026-07-16): the character
     * lands on ~this % of shots, importance-ranked; the rest ride the cheap
     * bulk engine as establishing/diagram filler */
    castTarget: integer("cast_target").notNull().default(55),
    enabled: boolean("enabled").notNull().default(true),
    ...timestamps,
  },
  (t) => [index("channel_characters_channel_id_idx").on(t.channelId)],
);

/**
 * Style test scenes (2026-07-14 operator ask): iterate a freshly-distilled
 * style on throwaway scenes — optionally casting a character to preview how
 * its reference image behaves as an input — refine with comments (current
 * image as the edit reference), then promote keepers into visualStyleRefs as
 * "generated" examples that feed the next distill/conditioning.
 */
export const styleTestScenes = pgTable(
  "style_test_scenes",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    styleId: text("style_id")
      .notNull()
      .references(() => visualStyles.id, { onDelete: "cascade" }),
    characterId: text("character_id").references(() => channelCharacters.id, {
      onDelete: "set null",
    }),
    /** the operator's scene ask (the base prompt, before style/character) */
    prompt: text("prompt").notNull(),
    /** the most recent refine comments, for display */
    lastComments: text("last_comments"),
    imageKey: text("image_key").notNull(),
    mimeType: text("mime_type").notNull().default("image/png"),
    ...timestamps,
  },
  (t) => [index("style_test_scenes_channel_id_idx").on(t.channelId)],
);

export const ideas = pgTable("ideas", {
  id: text("id").primaryKey(),
  channelId: text("channel_id")
    .notNull()
    .references(() => channels.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  angle: text("angle").notNull(),
  sourceType: ideaSource("source_type").notNull().default("manual"),
  researchRefs: jsonb("research_refs").$type<unknown[]>(),
  status: ideaStatus("status").notNull().default("inbox"),
  /** trend-replication fast lane (spec §5.5): topical window is short */
  fastTrack: boolean("fast_track").notNull().default(false),
  ...timestamps,
}, (t) => [index("ideas_channel_id_idx").on(t.channelId)]);

export const hookArchetype = pgEnum("hook_archetype", [
  "curiosity_gap",
  "pattern_interrupt",
  "stakes_first",
  "contrarian",
]);

/**
 * Hook / script structure library (spec §5.5): reusable structural skeletons
 * abstracted from high-retention videos. The writer drafts ORIGINAL
 * substance onto these skeletons — structure is templated, substance never.
 */
export const hookTemplates = pgTable("hook_templates", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  archetype: hookArchetype("archetype").notNull(),
  /** first-1-2s pattern, retention beats, payoff placement, loop/CTA */
  skeleton: jsonb("skeleton")
    .$type<{
      first2s: string;
      beatPlan: string[];
      payoffPlacement: string;
      loopOrCta: string;
    }>()
    .notNull(),
  /** where this was abstracted from (outlier title/id), if ingested */
  sourceRef: text("source_ref"),
  active: boolean("active").notNull().default(true),
  ...timestamps,
});

export type RubricAxis = { score: number; rationale: string };
export type Rubric = {
  demand: RubricAxis;
  saturation: RubricAxis;
  ghostNiche: RubricAxis;
  rpmPotential: RubricAxis;
  feasibilityCost: RubricAxis;
  complianceRisk: RubricAxis;
  dnaFit: RubricAxis;
};

export const scores = pgTable("scores", {
  id: text("id").primaryKey(),
  ideaId: text("idea_id")
    .notNull()
    .references(() => ideas.id, { onDelete: "cascade" }),
  rubric: jsonb("rubric").$type<Rubric>().notNull(),
  weightedTotal: real("weighted_total").notNull(),
  modelUsed: text("model_used").notNull(),
  agentActionId: text("agent_action_id"),
  ...timestamps,
}, (t) => [index("scores_idea_id_idx").on(t.ideaId)]);

export const productions = pgTable("productions", {
  id: text("id").primaryKey(),
  ideaId: text("idea_id")
    .notNull()
    .references(() => ideas.id),
  channelId: text("channel_id")
    .notNull()
    .references(() => channels.id),
  status: productionStatus("status").notNull().default("greenlit"),
  currentGateId: text("current_gate_id"),
  revisionCount: integer("revision_count").notNull().default(0),
  /** normalized "topic | hook claim | key facts" string used by the variation check */
  substanceFingerprint: text("substance_fingerprint"),
  failureReason: text("failure_reason"),
  inngestRunId: text("inngest_run_id"),
  /** operator force-forward: pass the soft safety gates (variation + review
   * board) instead of blocking to on_hold. Logged as an override decision. */
  bypassChecks: boolean("bypass_checks").notNull().default(false),
  /** #27 voice source: "tts" (persona voice) | "operator" (recorded takes;
   * beats without an accepted take are TTS-filled — hybrid for free) */
  voiceSource: text("voice_source").notNull().default("tts"),
  /** build #5.2: produced under this one-variable experiment (nullable) */
  experimentId: text("experiment_id"),
  /** BACKLOG #21.1 provenance: which persona version wrote this script (soft ref) */
  personaId: text("persona_id"),
  personaVersion: integer("persona_version"),
  /** #35.1 provenance: which visual-style version produced this video (soft ref) */
  styleId: text("style_id"),
  styleVersion: integer("style_version"),
  /** BACKLOG #6: this is a Short derived from that long-form master production
   * (provenance + one-way funnel link). Soft ref. */
  masterProductionId: text("master_production_id"),
  /**
   * "Make a corrected copy" (2026-07-19 operator): this production is a fresh
   * re-cut of that already-published one (YouTube can't replace a live video's
   * file, so a fix ships as a NEW upload). Soft ref to the superseded original.
   */
  supersedesProductionId: text("supersedes_production_id"),
  /** when true, deleting the superseded original's live YouTube video is done
   * automatically once THIS corrected copy goes live (opt-in — default off). */
  supersedeDeleteOld: boolean("supersede_delete_old").notNull().default(false),
  /**
   * Manual audio mix (2026-07-19 operator): per-video overrides for the two
   * render audio layers, 0–1(.5) linear gain. Both NULL → the defaults apply
   * (voice at full 1.0; music at the Production Profile "music" axis level).
   */
  voiceVolume: real("voice_volume"),
  musicVolume: real("music_volume"),
  /**
   * Per-video Production Profile (2026-07-12 operator ask): the channel
   * profile is the default; after script approval an AI pass proposes
   * per-video tweaks (gated on T0/T1 as a profile_review gate) and the
   * chosen profile lands here. Null → channel profile applies unchanged.
   */
  productionProfile: jsonb("production_profile").$type<Partial<ProductionProfile>>(),
  /**
   * BACKLOG #36 (MCP direct authoring): the script was authored externally (by
   * Claude via the MCP connector) and seeded verbatim, so the human
   * script_review gate is skipped (you trust what Claude wrote). The automated
   * safety checks — variation/anti-clone + the review board — STILL run.
   * Distinct from supersedesProductionId (corrected copy), which also skips
   * variation and requires a published source.
   */
  externalScript: boolean("external_script").notNull().default(false),
  /** Remediation §2.1: an explicit operator override to allow this production to
   * publish even though the idea already has a published video (a legitimate
   * re-do). Default off — the duplicate-publish guard blocks otherwise. */
  allowDuplicate: boolean("allow_duplicate").notNull().default(false),
  /** Remediation §3.4/§3.5: operator/Claude-authored packaging. Any field set
   * overrides the pipeline's auto-generated metadata (credits are still appended
   * to an authored description); thumbnailPrompt is used verbatim for the
   * thumbnail, skipping the prompt-builder LLM. Null → auto everything. */
  authoredMetadata: jsonb("authored_metadata").$type<{
    title?: string;
    description?: string;
    tags?: string[];
    thumbnailPrompt?: string;
  }>(),
  ...timestamps,
}, (t) => [index("productions_channel_id_idx").on(t.channelId), index("productions_idea_id_idx").on(t.ideaId)]);

/** Visual Director shot (#37) as stored on a script draft. Structural mirror of
 * core's DirectedShot (db can't import core — that would be circular). */
export type DirectedShot = {
  beatIndex: number;
  narrationSpan: string;
  subject: string;
  shotScale: "wide" | "medium" | "close" | "insert";
  angle?: string | null;
  medium: "still" | "motion" | "real_footage";
  character?: string | null;
  hero: boolean;
  motif?: string | null;
  continuity?: string | null;
  intent: string;
};

export type ScriptBeat = {
  // "rehook" (ticket 01KY29ZW…): a mid-video re-hook beat — kept in sync with
  // core's beatType enum so an authored script can carry the structure
  // review_beat_map approved.
  type: "hook" | "stat" | "insight" | "cta" | "rehook";
  text: string;
  imagePrompt: string;
  /** specific real subject this beat depicts (for sourcing a real photo), or null */
  referenceEntity?: string | null;
  /** the writer's concrete visual ASK for this section (2026-07-12): a
   * self-contained scene an image model can execute — subject, era-correct
   * setting, composition, mood. Never echoes the narration. */
  visualBrief?: string | null;
  /** one of the story's 2-4 pivotal moments — generated on the hero model */
  heroShot?: boolean;
  /** estimated spoken seconds (computed from word count; render uses real audio timings) */
  estSec?: number;
  /** BACKLOG #36: an externally-authored (MCP) image-to-video motion prompt for
   * this beat — used verbatim when the beat animates, skipping the writeMotionPrompt
   * vision LLM. Null/omit = the platform writes the motion prompt as before. */
  motionPrompt?: string | null;
};

export const scriptDrafts = pgTable(
  "script_drafts",
  {
    id: text("id").primaryKey(),
    productionId: text("production_id")
      .notNull()
      .references(() => productions.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    /** structure template used (hook_templates.id), if any */
    hookTemplateId: text("hook_template_id"),
    hookText: text("hook_text").notNull(),
    beats: jsonb("beats").$type<ScriptBeat[]>().notNull(),
    fullText: text("full_text").notNull(),
    wordCount: integer("word_count").notNull(),
    /** Visual Director (#37): the director's shot sequence for this draft, so
     * the render, the Animate button and the cockpit estimate all cut the same
     * way. null = mechanical rhythm cut. */
    directedSequence: jsonb("directed_sequence").$type<DirectedShot[]>(),
    ...timestamps,
  },
  (t) => [uniqueIndex("script_drafts_production_version_uq").on(t.productionId, t.version)],
);

export type WordTimestamp = { word: string; startSec: number; endSec: number };

export const assets = pgTable(
  "assets",
  {
    id: text("id").primaryKey(),
    productionId: text("production_id")
      .notNull()
      .references(() => productions.id, { onDelete: "cascade" }),
    kind: assetKind("kind").notNull(),
    idx: integer("idx").notNull().default(0),
    storageKey: text("storage_key").notNull(),
    mimeType: text("mime_type").notNull(),
    durationSec: real("duration_sec"),
    /** voiceover: { words: WordTimestamp[] }; image: { prompt } */
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    ...timestamps,
  },
  // idempotency anchor: pipeline replays upsert on this key
  (t) => [uniqueIndex("assets_production_kind_idx_uq").on(t.productionId, t.kind, t.idx)],
);

export const thumbnails = pgTable("thumbnails", {
  id: text("id").primaryKey(),
  productionId: text("production_id")
    .notNull()
    .references(() => productions.id, { onDelete: "cascade" }),
  storageKey: text("storage_key").notNull(),
  selected: boolean("selected").notNull().default(false),
  predictedCtr: real("predicted_ctr"),
  /** #35.3 provenance: { prompt, patterns: string[], regenerated?: boolean } */
  meta: jsonb("meta").$type<Record<string, unknown>>(),
  ...timestamps,
});

/**
 * Background-music candidates per production (2026-07-17 operator: choose music
 * + listen to options). The operator generates a few instrumental beds, plays
 * them, and marks ONE `selected` — the render lays that under the narration.
 * Serves via /api/media/<storageKey>. Auto-generated at render time when none
 * was picked (that bed is inserted here too, selected, so it's audible/swappable).
 */
export const productionMusic = pgTable(
  "production_music",
  {
    id: text("id").primaryKey(),
    productionId: text("production_id")
      .notNull()
      .references(() => productions.id, { onDelete: "cascade" }),
    storageKey: text("storage_key").notNull(),
    mimeType: text("mime_type").notNull(),
    /** AI-generated short track name for the cross-video library dropdown
     * (2026-07-19), e.g. "Midnight Drift" — null on legacy rows (mood shown) */
    name: text("name"),
    /** track length in seconds (sized to the voiceover) */
    durationSec: real("duration_sec"),
    /** operator/ auto mood label shown on the card, e.g. "tense cinematic" */
    mood: text("mood"),
    /** the full brief sent to the music provider */
    prompt: text("prompt"),
    /** which backend produced it — "elevenlabs-music" | "mock-music" */
    engine: text("engine"),
    /** the one the render uses (at most one true per production) */
    selected: boolean("selected").notNull().default(false),
    ...timestamps,
  },
  (t) => [index("production_music_production_id_idx").on(t.productionId)],
);

/**
 * Per-channel music bed (2026-07-21): a curated pool of ~6-8 reusable tracks so
 * a channel has a consistent sonic identity but ALTERNATES tracks across videos
 * instead of one bed everywhere or a fresh generation each time. The pipeline
 * rotates least-recently-used (`lastUsedAt`); most tracks come free from
 * Openverse (`source` = "openverse"), but a generated/library track can be
 * promoted into the bed too. Tracks are stored in our own object store.
 */
export const channelMusic = pgTable(
  "channel_music",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    storageKey: text("storage_key").notNull(),
    mimeType: text("mime_type").notNull(),
    /** display name (Openverse title / AI name) */
    name: text("name"),
    /** mood/brief label shown on the card */
    mood: text("mood"),
    /** where it came from: "openverse" | "elevenlabs-music" | "mock-music" | "library" */
    source: text("source"),
    /** creator/source credit — appended to the video description for CC tracks */
    attribution: text("attribution"),
    /** licence label, e.g. "CC BY 3.0" / "CC0" (null for generated tracks) */
    license: text("license"),
    durationSec: real("duration_sec"),
    /** rotation cursor: the render stamps now() on the track it uses so the
     * next video picks the least-recently-used one (nulls = never used first) */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex("channel_music_channel_storage_uq").on(t.channelId, t.storageKey)],
);

/**
 * Beat maps submitted to the structural reviewer (ticket 01KY1Y9E…). Stored so
 * the cross-video variation check can compare a new map against the channel's
 * recent structures — the compliance-relevant, highest-value check. Keeps the
 * structural fingerprint + verdict for cheap comparison and audit.
 */
export const beatMaps = pgTable(
  "beat_maps",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    /** optional link to the production this map became */
    productionId: text("production_id"),
    title: text("title").notNull(),
    /** the full submitted beat map */
    map: jsonb("map").notNull(),
    /** structural fingerprint (beat-type sequence + hero markers) */
    fingerprint: text("fingerprint").notNull(),
    /** pass | advise | block */
    verdict: text("verdict").notNull(),
    ...timestamps,
  },
  (t) => [index("beat_maps_channel_id_idx").on(t.channelId)],
);

export const publications = pgTable("publications", {
  id: text("id").primaryKey(),
  productionId: text("production_id")
    .notNull()
    .references(() => productions.id),
  provider: text("provider").notNull().default("youtube"),
  /** null until the video is actually uploaded (a scheduled row exists first) */
  providerVideoId: text("provider_video_id"),
  url: text("url"),
  privacyStatus: text("privacy_status").notNull().default("private"),
  /** synthetic-media disclosure — compliance requirement, defaults ON */
  aiDisclosure: boolean("ai_disclosure").notNull().default(true),
  /** set when the upload actually goes live; null while still scheduled */
  publishedAt: timestamp("published_at", { withTimezone: true }),
  /**
   * The scheduled publish time. Phase 3 / BACKLOG #8: a `publications` row is now
   * created at SCHEDULE time (future scheduledFor, null providerVideoId/url,
   * null publishedAt) so the schedule is queryable + rendered on the calendar,
   * then updated in place when the upload goes live.
   */
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
  ...timestamps,
}, (t) => [index("publications_production_id_idx").on(t.productionId)]);

export const reviewGates = pgTable("review_gates", {
  id: text("id").primaryKey(),
  productionId: text("production_id")
    .notNull()
    .references(() => productions.id, { onDelete: "cascade" }),
  kind: gateKind("kind").notNull(),
  status: gateStatus("status").notNull().default("pending"),
  decision: gateDecision("decision"),
  /** operator's editorial notes — part of the compliance evidence log */
  notes: text("notes"),
  decidedBy: text("decided_by"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  /** snapshot of exactly what was reviewed (script version, render key, …) */
  payloadSnapshot: jsonb("payload_snapshot").$type<Record<string, unknown>>(),
  ...timestamps,
});

export const agentActions = pgTable("agent_actions", {
  id: text("id").primaryKey(),
  agentName: text("agent_name").notNull(),
  tier: text("tier"),
  model: text("model"),
  channelId: text("channel_id"),
  ideaId: text("idea_id"),
  productionId: text("production_id"),
  inputSummary: text("input_summary").notNull(),
  output: jsonb("output").$type<unknown>(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  costUsd: numeric("cost_usd", { precision: 10, scale: 6 }).notNull().default("0"),
  durationMs: integer("duration_ms").notNull().default(0),
  ...timestamps,
});

export const costRecords = pgTable("cost_records", {
  id: text("id").primaryKey(),
  channelId: text("channel_id").notNull(),
  productionId: text("production_id"),
  category: costCategory("category").notNull(),
  provider: text("provider").notNull(),
  model: text("model"),
  /** e.g. {inputTokens, outputTokens} | {chars} | {images} | {renderSec} */
  units: jsonb("units").$type<Record<string, number>>().notNull(),
  costUsd: numeric("cost_usd", { precision: 10, scale: 6 }).notNull(),
  agentActionId: text("agent_action_id"),
  meta: jsonb("meta").$type<Record<string, unknown>>(),
  ...timestamps,
}, (t) => [index("cost_records_channel_id_idx").on(t.channelId), index("cost_records_production_id_idx").on(t.productionId)]);

/**
 * Provider API keys, encrypted at rest with AES-256-GCM under
 * SECRETS_ENCRYPTION_KEY (see @ytauto/core crypto). Values are never stored
 * or returned in plaintext; the cockpit shows only the last 4 characters.
 */
export const secrets = pgTable("secrets", {
  /** env-var-style name, e.g. OPENROUTER_API_KEY */
  name: text("name").primaryKey(),
  /** base64: 12-byte IV ∥ 16-byte auth tag ∥ ciphertext */
  ciphertext: text("ciphertext").notNull(),
  /** last 4 chars of the plaintext, for display only */
  last4: text("last4").notNull(),
  ...timestamps,
});

/**
 * Daily USD→AUD spot rates (2026-07-19 operator: show costs in AUD at that
 * day's rate). Costs stay stored in USD (the providers bill USD); the cockpit
 * converts each cost by the rate for its own date. Cached from a free FX API
 * (ECB reference rates), keyed by ISO date.
 */
export const fxRates = pgTable("fx_rates", {
  /** ISO date YYYY-MM-DD */
  date: text("date").primaryKey(),
  /** 1 USD in AUD on that date */
  usdToAud: real("usd_to_aud").notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Deployed build per service (2026-07-19 operator: "add the deploy version so I
 * can tell"). Each service upserts its git commit + boot time on start; the
 * cockpit shows both so the operator can see when the worker (pipeline) build is
 * actually live, not just the cockpit's.
 */
export const serviceVersions = pgTable("service_versions", {
  /** "cockpit" | "worker" */
  service: text("service").primaryKey(),
  /** short git commit of the running build, or "dev" */
  commit: text("commit").notNull(),
  bootedAt: timestamp("booted_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * BACKLOG #36: a shared issue log ("tickets") — Claude in chat files problems it
 * hits via the MCP (report_issue), the operator reads them on the Tickets page,
 * and the developer picks them up. A lightweight bridge between the two Claudes.
 */
export const ticketStatus = pgEnum("ticket_status", ["open", "acknowledged", "closed"]);
export const ticketSeverity = pgEnum("ticket_severity", ["info", "warn", "error"]);
export const agentTickets = pgTable(
  "agent_tickets",
  {
    id: text("id").primaryKey(),
    /** soft refs (nullable) — the context the issue is about */
    channelId: text("channel_id"),
    productionId: text("production_id"),
    source: text("source").notNull().default("mcp"),
    severity: ticketSeverity("severity").notNull().default("info"),
    title: text("title").notNull(),
    detail: text("detail"),
    status: ticketStatus("status").notNull().default("open"),
    /** BACKLOG #36: the GitHub issue this ticket was mirrored to (auto-sync), so
     * the developer can read/answer it directly. Null if GitHub isn't configured. */
    githubUrl: text("github_url"),
    /** the mirrored issue's number — used to match inbound webhooks (close/reopen)
     * back to this ticket for two-way sync. */
    githubNumber: integer("github_number"),
    /** resolution / developer notes synced FROM the linked GitHub issue (body +
     * comments). Lets Claude Code answer a ticket via GitHub and have that answer
     * show up on the ticket for the operator + the MCP Claude (list_issues). */
    resolution: text("resolution"),
    ...timestamps,
  },
  (t) => [index("agent_tickets_status_idx").on(t.status)],
);

export const analyticsSnapshots = pgTable("analytics_snapshots", {
  id: text("id").primaryKey(),
  publicationId: text("publication_id")
    .notNull()
    .references(() => publications.id, { onDelete: "cascade" }),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
  views: integer("views").notNull().default(0),
  avgViewDurationSec: real("avg_view_duration_sec"),
  /** average percentage of the video watched (0-100) — the retention signal */
  avgViewPct: real("avg_view_pct"),
  ctr: real("ctr"),
  /** cumulative thumbnail/feed impressions — drives the channel viability bar */
  impressions: integer("impressions"),
  /**
   * Per-video audience-retention curve: relative-retention percentages (0-100)
   * sampled at even points across the runtime, curve[0] = 100 at t0. Powers the
   * drill-down retention chart + the 3s-hook-hold metric (build #3.2).
   */
  retentionCurve: jsonb("retention_curve").$type<number[]>(),
  /** % who swiped away in the first 3 seconds (Shorts-native) */
  swipeAwayPct: real("swipe_away_pct"),
  /** % of views from returning viewers */
  returningViewerPct: real("returning_viewer_pct"),
  /** subscribers gained attributable to this video */
  subsGained: integer("subs_gained"),
  /** estimated minutes watched (÷60 = watch hours) — real, from the Analytics API */
  estimatedMinutesWatched: real("estimated_minutes_watched"),
  likes: integer("likes"),
  comments: integer("comments"),
  shares: integer("shares"),
  /** view breakdown by YouTube traffic-source type, descending */
  trafficSources: jsonb("traffic_sources").$type<{ source: string; views: number }[]>(),
  raw: jsonb("raw").$type<Record<string, unknown>>(),
  ...timestamps,
}, (t) => [index("analytics_snapshots_publication_id_idx").on(t.publicationId)]);

// ── Per-video AI analysis + pattern store (build #3.2) ───────────────────

/**
 * Per-video hook analysis: the isolated opening line, its classified archetype,
 * how it held through the 3s cliff (computed from the retention curve, not the
 * model), and qualitative tags/assessment from the analysis agent.
 */
export const hookAnalyses = pgTable(
  "hook_analyses",
  {
    id: text("id").primaryKey(),
    publicationId: text("publication_id")
      .notNull()
      .references(() => publications.id, { onDelete: "cascade" }),
    productionId: text("production_id")
      .notNull()
      .references(() => productions.id, { onDelete: "cascade" }),
    hookText: text("hook_text").notNull(),
    archetype: hookArchetype("archetype").notNull(),
    /** % of viewers still watching at the 3s mark (from the retention curve) */
    threeSecondHoldPct: real("three_second_hold_pct"),
    /** this video's 3s hold minus the channel average, in points */
    vsChannelAvgPct: real("vs_channel_avg_pct"),
    /** e.g. ["strong-3s-hold", "open-loop", "contrarian-claim"] */
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    assessment: text("assessment").notNull(),
    agentActionId: text("agent_action_id"),
    ...timestamps,
  },
  (t) => [uniqueIndex("hook_analyses_publication_uq").on(t.publicationId)],
);

export type ScriptBeatAnalysis = {
  type: "hook" | "stat" | "insight" | "cta" | "rehook";
  summary: string;
  startSec: number;
  endSec: number;
  /** retention % at this beat's start, aligned from the curve */
  retentionAtStartPct: number | null;
  working: boolean;
};

/**
 * Per-video script analysis: beat-by-beat structure with timing aligned to the
 * retention curve, what's working, and a concrete trim/tighten suggestion tied
 * to the biggest retention dip.
 */
export const scriptAnalyses = pgTable(
  "script_analyses",
  {
    id: text("id").primaryKey(),
    publicationId: text("publication_id")
      .notNull()
      .references(() => publications.id, { onDelete: "cascade" }),
    productionId: text("production_id")
      .notNull()
      .references(() => productions.id, { onDelete: "cascade" }),
    structure: jsonb("structure").$type<ScriptBeatAnalysis[]>().notNull(),
    strengths: text("strengths").notNull(),
    trimSuggestion: text("trim_suggestion").notNull(),
    /** timestamp (seconds) of the biggest retention drop, if any */
    dipAtSec: real("dip_at_sec"),
    agentActionId: text("agent_action_id"),
    ...timestamps,
  },
  (t) => [uniqueIndex("script_analyses_publication_uq").on(t.publicationId)],
);

export const patternKind = pgEnum("pattern_kind", [
  "hook",
  "script_structure",
  "topic_signal",
  // #35.3: deconstructed winning-thumbnail patterns (composition/text/emotion)
  "thumbnail",
]);

/** own = learned from our published videos; external = scouted (build #4). */
export const patternSource = pgEnum("pattern_source", ["own", "external"]);

// ── Market opportunities (BACKLOG #22): cross-niche portfolio intel ───────

export const opportunityKind = pgEnum("opportunity_kind", ["niche", "topic", "style"]);
export const opportunityStatus = pgEnum("opportunity_status", [
  "new",
  "shortlisted",
  "dismissed",
  "actioned",
]);

/**
 * Portfolio-level market opportunities (BACKLOG #22): trending NEW niches,
 * cross-market topic waves, and styles/formats working right now — the
 * patterns table can't hold these (niche is part of its identity and it's
 * scoped to existing channels' niches). Written by market-scan's global
 * discovery step; surfaced on the Ideas page with start-a-channel actions.
 * Upsert identity is (kind, label): re-observations bump momentum/lastSeen
 * but never resurrect a dismissed row.
 */
export const marketOpportunities = pgTable(
  "market_opportunities",
  {
    id: text("id").primaryKey(),
    kind: opportunityKind("kind").notNull(),
    /** terse identity, e.g. "abandoned engineering" or "silent POV builds" */
    label: text("label").notNull(),
    /** 1-2 sentences: what's moving and why it matters for the portfolio */
    summary: text("summary").notNull(),
    /** pre-filled wizard inputs for kind=niche (and topic when channel-worthy) */
    suggestedNiche: text("suggested_niche"),
    suggestedIntent: text("suggested_intent"),
    /** 0-100 heat */
    momentum: integer("momentum").notNull().default(50),
    /** raw signals backing it: categories, breakout channels, sample titles */
    evidence: jsonb("evidence").$type<{
      categories?: string[];
      channels?: { name: string; subscribers: number; growthRate: number }[];
      sampleTitles?: string[];
    }>(),
    status: opportunityStatus("status").notNull().default("new"),
    source: text("source").notNull().default("market_scan"),
    observations: integer("observations").notNull().default(1),
    lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [uniqueIndex("market_opportunities_identity_uq").on(t.kind, t.label)],
);

/**
 * Unified pattern store (build #3.2 seeds it from our own videos; build #4's
 * meta-analysis engine writes external observations into the same table). Each
 * row is a niche/format-scoped pattern with a rolling, retention-weighted
 * performanceScore that self-corrects as more videos are observed.
 */
export const patterns = pgTable(
  "patterns",
  {
    id: text("id").primaryKey(),
    kind: patternKind("kind").notNull(),
    /** the pattern's identity within its niche/format, e.g. "open-loop" or "hook→stat→insight→cta" */
    label: text("label").notNull(),
    niche: text("niche").notNull(),
    /** "shorts" | "long" — patterns never cross formats (spec) */
    format: text("format").notNull().default("shorts"),
    source: patternSource("source").notNull().default("own"),
    /** structural descriptor; hook: {archetype, opener}; script: {beatSequence} */
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull(),
    /** publication/video ids this pattern was observed in */
    sampleRefs: jsonb("sample_refs").$type<string[]>().notNull().default([]),
    /** rolling retention-weighted performance (0-100); higher = better */
    performanceScore: real("performance_score").notNull().default(0),
    observations: integer("observations").notNull().default(1),
    lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [uniqueIndex("patterns_identity_uq").on(t.kind, t.niche, t.format, t.label)],
);

/**
 * Where an ingested external video came from (build #4 meta-analysis engine).
 * Mirrors the VidIQ-style research feeds behind the ResearchProvider.
 */
export const researchSource = pgEnum("research_source", ["outlier", "breakout", "trending"]);

/**
 * External-video scouting store (build #4). The meta-analysis engine ingests
 * over-performing competitor content here, then analyses transcripts into the
 * shared `patterns` table (source="external"). Kept separate from our own
 * publications: this is market intelligence, never our catalogue. Also the
 * corpus the variation check compares generated scripts against, so we can't
 * accidentally clone a competitor.
 */
export const externalVideos = pgTable(
  "external_videos",
  {
    id: text("id").primaryKey(),
    source: researchSource("source").notNull(),
    /** provider-side video id (VidIQ/YouTube); dedupe anchor within a niche */
    externalId: text("external_id").notNull(),
    niche: text("niche").notNull(),
    /** "shorts" | "long" — patterns never cross formats (spec) */
    format: text("format").notNull().default("shorts"),
    title: text("title").notNull(),
    channelName: text("channel_name").notNull(),
    url: text("url"),
    views: integer("views").notNull().default(0),
    /** velocity signal: views per hour since publish */
    viewsPerHour: real("views_per_hour"),
    /** how far over the niche baseline this over-performed (outlier multiple) */
    outlierFactor: real("outlier_factor"),
    engagementRate: real("engagement_rate"),
    /** the scouted transcript, when the provider can supply one */
    transcript: text("transcript"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
    /** set once the meta-analysis agents have processed this video */
    analyzedAt: timestamp("analyzed_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex("external_videos_niche_external_uq").on(t.niche, t.externalId)],
);

/**
 * Per-channel tagged competitors (BACKLOG #23.3). The Niche intel tab's
 * persistent competitor list: hand-entered by the operator or tagged straight
 * off a scouted external video ("scan"). Identity is (channelId, name) —
 * external_videos only reliably carries the channel NAME, so that's the
 * dedupe anchor; externalId is filled when the YouTube channel id is known.
 */
export const channelCompetitors = pgTable(
  "channel_competitors",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    /** YouTube channel id when known; empty for name-only tags */
    externalId: text("external_id").notNull().default(""),
    name: text("name").notNull(),
    url: text("url"),
    /** "operator" = hand-added; "scan" = tagged from a scouted video/channel */
    source: text("source").notNull().default("operator"),
    notes: text("notes"),
    ...timestamps,
  },
  (t) => [uniqueIndex("channel_competitors_channel_name_uq").on(t.channelId, t.name)],
);

export const alertKind = pgEnum("alert_kind", [
  "underperformance",
  "low_retention",
  "demonetisation",
  "copyright_claim",
  "comment_sentiment",
  /** build: channel viability — post-warm-up 28-day impressions below the bar */
  "viability",
  /** BACKLOG #21.7: platform capacity — DB storage/RAM headroom warnings */
  "capacity",
]);

export const alertSeverity = pgEnum("alert_severity", ["info", "warning", "critical"]);

export const alertStatus = pgEnum("alert_status", ["open", "acked"]);

/** The alerting rail (spec §5.4): one open alert per (publication, kind).
 * channelId is null for PLATFORM-scoped alerts (#21.7 capacity). */
export const alerts = pgTable("alerts", {
  id: text("id").primaryKey(),
  channelId: text("channel_id").references(() => channels.id, { onDelete: "cascade" }),
  publicationId: text("publication_id").references(() => publications.id, {
    onDelete: "cascade",
  }),
  kind: alertKind("kind").notNull(),
  severity: alertSeverity("severity").notNull().default("warning"),
  message: text("message").notNull(),
  status: alertStatus("status").notNull().default("open"),
  ackedAt: timestamp("acked_at", { withTimezone: true }),
  ...timestamps,
});

// ── Editorial engine (build #5) ──────────────────────────────────────────

export const charterArchetype = pgEnum("charter_archetype", [
  "evergreen_series",
  "monitor_digest",
  "reactive",
]);

export const formatPolicy = pgEnum("format_policy", [
  "shorts_only",
  "long_only",
  "long_plus_shorts",
]);

export type SourceStrategy = {
  /** connector kinds this channel prefers, e.g. ["web", "rss"] */
  preferredKinds: string[];
  /** domains the verifier treats as authoritative for this niche */
  authoritativeDomains: string[];
  avoidDomains: string[];
};

export type VerificationBar = {
  /** established facts need this many independent (distinct-domain) sources or they're cut */
  establishedMinSources: number;
  /** contested history: state mainstream + attribute the alternative, never assert */
  presentDebateMode: boolean;
  /**
   * minimum distinct verified/attributed facts an episode must carry before it
   * may be scripted (build #18 facts-gate — "no full scripts on 1 fact").
   * Optional so pre-existing charter rows keep working; code defaults it.
   */
  minFactsToScript?: number;
  /**
   * BACKLOG #21.3: how hard verification gates for this channel. strict =
   * cut what can't be corroborated; balanced = uncorroborated material becomes
   * framed CONJECTURE; entertainment = facts inspire, gate off. Optional so
   * legacy rows keep working; `resolveFactualityMode` defaults it.
   */
  factualityMode?: "strict" | "balanced" | "entertainment";
};

export type IdentityProposal = {
  name: string;
  handle: string;
  avatarConcept: string;
};

/**
 * Channel charter (build #5): the editorial strategy layer above ChannelDNA.
 * DNA is production styling; the charter is what the channel IS — mission,
 * archetype, where it gets its truth, and how hard claims are verified.
 * A channel WITHOUT a charter row is a legacy/manual channel: the editorial
 * engine and the factuality gate both skip it.
 */
export const channelCharters = pgTable(
  "channel_charters",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    mission: text("mission").notNull(),
    objectives: jsonb("objectives").$type<string[]>().notNull().default([]),
    /** only evergreen_series is acted on in build #5; others are seams */
    archetype: charterArchetype("archetype").notNull().default("evergreen_series"),
    /** per-channel format policy (BACKLOG #6 seam); v1 platform is shorts-only */
    formatPolicy: formatPolicy("format_policy").notNull().default("shorts_only"),
    sourceStrategy: jsonb("source_strategy").$type<SourceStrategy>().notNull(),
    verificationBar: jsonb("verification_bar").$type<VerificationBar>().notNull(),
    /** wizard audit: the AI-proposed identities + which one the operator picked */
    identityProposals: jsonb("identity_proposals").$type<{
      options: IdentityProposal[];
      pickedIndex: number | null;
    }>(),
    /** operator check-in cadence (build #5.2 briefings read this) */
    checkinCadence: text("checkin_cadence").notNull().default("weekly"),
    ...timestamps,
  },
  (t) => [uniqueIndex("channel_charters_channel_id_uq").on(t.channelId)],
);

export const sourceKind = pgEnum("source_kind", ["rss", "web", "youtube"]);

export const sourceStatus = pgEnum("source_status", ["active", "error", "disabled"]);

export const proposedBy = pgEnum("proposed_by", ["agent", "operator"]);

/**
 * Per-channel truth sources (build #5). Scrapers are brittle, so fetch
 * failures are tracked here (lastError/errorCount) rather than crashing runs.
 */
export const channelSources = pgTable("channel_sources", {
  id: text("id").primaryKey(),
  channelId: text("channel_id")
    .notNull()
    .references(() => channels.id, { onDelete: "cascade" }),
  kind: sourceKind("kind").notNull(),
  name: text("name").notNull(),
  /** rss/web: {url}; youtube: {query} — shape depends on kind */
  config: jsonb("config").$type<Record<string, unknown>>().notNull(),
  status: sourceStatus("status").notNull().default("active"),
  lastFetchAt: timestamp("last_fetch_at", { withTimezone: true }),
  lastError: text("last_error"),
  errorCount: integer("error_count").notNull().default(0),
  proposedBy: proposedBy("proposed_by").notNull().default("agent"),
  ...timestamps,
});

export const seriesStatus = pgEnum("series_status", [
  "proposed",
  "active",
  "completed",
  "archived",
]);

/** An ordered content arc (e.g. "Cold War interceptors, 12 episodes"). */
export const series = pgTable("series", {
  id: text("id").primaryKey(),
  channelId: text("channel_id")
    .notNull()
    .references(() => channels.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description").notNull(),
  status: seriesStatus("status").notNull().default("proposed"),
  plannedEpisodeCount: integer("planned_episode_count").notNull().default(0),
  /** deployment order across the channel's series */
  position: integer("position").notNull().default(0),
  ...timestamps,
});

export const episodeStatus = pgEnum("episode_status", [
  "planned",
  "researching",
  "verifying",
  "briefed",
  "queued",
  "produced",
  "published",
  "cut",
]);

/**
 * One planned video within a series. Doubles as the coverage ledger:
 * "have we covered the Concorde?" is an exact SQL lookup over this table,
 * never a similarity search.
 */
export const episodes = pgTable(
  "episodes",
  {
    id: text("id").primaryKey(),
    seriesId: text("series_id")
      .notNull()
      .references(() => series.id, { onDelete: "cascade" }),
    /** denormalized for channel-scoped queries */
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    title: text("title").notNull(),
    angle: text("angle").notNull(),
    status: episodeStatus("status").notNull().default("planned"),
    /** handoff link into the production spine once queued */
    ideaId: text("idea_id"),
    /** BACKLOG #23.1: tentative publish slot projected at series approval —
     * shows on the calendars as a dimmed "tentative" item and becomes the
     * locked schedule slot when the produced video reaches the publish step.
     * Never touches YouTube while tentative. */
    tentativeFor: timestamp("tentative_for", { withTimezone: true }),
    /** the verified episode brief the scriptwriter is grounded in */
    brief: jsonb("brief").$type<Record<string, unknown>>(),
    /** what we said + how it was framed — written post-publish for continuity/dedup */
    coverageSummary: text("coverage_summary"),
    ...timestamps,
  },
  (t) => [uniqueIndex("episodes_series_position_uq").on(t.seriesId, t.position)],
);

export const claimTier = pgEnum("claim_tier", ["established", "emerging", "contested"]);

export const claimStatus = pgEnum("claim_status", [
  "unverified",
  "verified",
  "attributed",
  /** BACKLOG #21.3: plausible but uncorroborated — tellable when FRAMED as
   * legend/debate/unknown (balanced/entertainment factuality modes only) */
  "conjecture",
  "cut",
]);

/**
 * Tiered-accuracy claims (build #5): established facts need ≥N independent
 * sources or they're cut; emerging/contested claims are attributed
 * ("reported/claimed"), never asserted as settled.
 */
export const claims = pgTable("claims", {
  id: text("id").primaryKey(),
  episodeId: text("episode_id")
    .notNull()
    .references(() => episodes.id, { onDelete: "cascade" }),
  channelId: text("channel_id").notNull(),
  text: text("text").notNull(),
  tier: claimTier("tier").notNull().default("established"),
  status: claimStatus("status").notNull().default("unverified"),
  agentActionId: text("agent_action_id"),
  ...timestamps,
}, (t) => [index("claims_channel_id_idx").on(t.channelId), index("claims_episode_id_idx").on(t.episodeId)]);

/** Provenance per claim. Independence = distinct domains across citations. */
export const citations = pgTable("citations", {
  id: text("id").primaryKey(),
  claimId: text("claim_id")
    .notNull()
    .references(() => claims.id, { onDelete: "cascade" }),
  channelSourceId: text("channel_source_id"),
  url: text("url").notNull(),
  title: text("title").notNull(),
  domain: text("domain").notNull(),
  snippet: text("snippet").notNull(),
  retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull().defaultNow(),
  ...timestamps,
});

export const memoryScope = pgEnum("memory_scope", ["episode", "channel"]);

export const memoryKind = pgEnum("memory_kind", [
  "source_doc",
  "transcript",
  "coverage_summary",
  "decision_note",
  "research_note",
]);

/**
 * Semantic per-channel memory (pgvector). Scope tiers prevent cross-video
 * contamination: a raw research dump is episode-scoped (retrieval for episode
 * N = channel carry-over + episode N's own dump, never another episode's);
 * only transcripts, coverage summaries, and explicitly-general research carry
 * over to channel scope. Default is episode — conservative by design.
 */
export const memoryChunks = pgTable(
  "memory_chunks",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    episodeId: text("episode_id").references(() => episodes.id, { onDelete: "cascade" }),
    scope: memoryScope("scope").notNull().default("episode"),
    kind: memoryKind("kind").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    sourceUrl: text("source_url"),
    embedding: vector("embedding", { dimensions: 1536 }).notNull(),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    ...timestamps,
  },
  (t) => [
    index("memory_chunks_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
    index("memory_chunks_channel_scope_idx").on(t.channelId, t.scope),
  ],
);

export const decisionKind = pgEnum("decision_kind", [
  "charter_created",
  "charter_updated",
  "series_planned",
  "episode_cut",
  "operator_steer",
  "gate_summary",
  // build #5.2
  "briefing_response",
  "experiment_started",
  "experiment_concluded",
  // #21.5 learning loop: retro runs log what they saw / decided
  "retro_observation",
  "retro_decision",
]);

export const decisionActor = pgEnum("decision_actor", ["operator", "agent"]);

/**
 * Curated canonical decisions ledger — the distilled "state of the world"
 * injected into planner/writer prompts. agent_actions stays the raw audit log;
 * this table holds only decisions worth remembering.
 */
export const channelDecisions = pgTable("channel_decisions", {
  id: text("id").primaryKey(),
  channelId: text("channel_id")
    .notNull()
    .references(() => channels.id, { onDelete: "cascade" }),
  kind: decisionKind("kind").notNull(),
  summary: text("summary").notNull(),
  detail: jsonb("detail").$type<Record<string, unknown>>(),
  actor: decisionActor("actor").notNull().default("agent"),
  ...timestamps,
});

// ── Build #5.2: operator briefings + controlled experimentation ─────────

export const briefingStatus = pgEnum("briefing_status", ["open", "acknowledged"]);

export type BriefingSuggestion = {
  /** stable within the briefing; the operator response is keyed by this */
  id: string;
  kind: "steer" | "experiment";
  label: string;
  detail: string;
  /** set when kind = "experiment": the proposed experiments row */
  experimentId?: string;
};

export type BriefingBody = {
  whatHappened: string;
  direction: string;
  question: string;
};

/**
 * Scheduled operator check-in (build #5.2): "what happened / direction /
 * suggestions / do you agree?" — generated on the charter's checkinCadence.
 * The operator's response becomes a channel_decisions steer row, so it feeds
 * straight back into planner/writer prompts via channelStateSummary.
 */
export const channelBriefings = pgTable("channel_briefings", {
  id: text("id").primaryKey(),
  channelId: text("channel_id")
    .notNull()
    .references(() => channels.id, { onDelete: "cascade" }),
  periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  body: jsonb("body").$type<BriefingBody>().notNull(),
  suggestions: jsonb("suggestions").$type<BriefingSuggestion[]>().notNull().default([]),
  status: briefingStatus("status").notNull().default("open"),
  /** suggestion id → operator verdict */
  responses: jsonb("responses").$type<Record<string, "agree" | "disagree">>(),
  operatorNote: text("operator_note"),
  respondedAt: timestamp("responded_at", { withTimezone: true }),
  ...timestamps,
});

export const experimentStatus = pgEnum("experiment_status", [
  "proposed",
  "active",
  "concluded",
  "abandoned",
]);

export const experimentResult = pgEnum("experiment_result", ["win", "loss", "inconclusive"]);

/**
 * Controlled one-variable experiment (build #5.2): a single attributable
 * change (hook style, structure, thumbnail style) applied to the next N
 * productions, then concluded against the channel baseline. At most one
 * active experiment per channel — that's what keeps deltas attributable.
 */
export const experiments = pgTable(
  "experiments",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    /** the ONE variable under test, e.g. "hook_style" */
    variable: text("variable").notNull(),
    hypothesis: text("hypothesis").notNull(),
    /** human-readable current setting the variant is measured against */
    baseline: text("baseline").notNull(),
    variant: text("variant").notNull(),
    /** the prompt line injected into production while the experiment runs */
    directive: text("directive").notNull(),
    status: experimentStatus("status").notNull().default("proposed"),
    /** conclude once this many experiment videos have analytics */
    targetSampleSize: integer("target_sample_size").notNull().default(3),
    /** #21.5 experiment queue: order among status='proposed' rows (lower runs
     * first; null = legacy/unqueued). When the active experiment concludes,
     * the next queued one auto-starts on T2/T3. */
    priority: integer("priority"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    concludedAt: timestamp("concluded_at", { withTimezone: true }),
    result: experimentResult("result"),
    /** narrative outcome written at conclusion */
    outcome: text("outcome"),
    /** provenance: proposed in this briefing (nullable — can be operator-created) */
    briefingId: text("briefing_id"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("experiments_one_active_per_channel_uq")
      .on(t.channelId)
      .where(drizzleSql`${t.status} = 'active'`),
  ],
);

// ── Learning loop (#21.5/#21.6): channel playbook + maturity ───────────────

export const playbookScope = pgEnum("playbook_scope", [
  "hook",
  "pacing",
  "structure",
  "visual",
  "topic",
  "title",
]);
export const playbookOrigin = pgEnum("playbook_origin", ["analysis", "experiment", "operator"]);
export const playbookStatus = pgEnum("playbook_status", ["trial", "adopted", "retired"]);

/**
 * Standing directives learned from THIS channel's own evidence (#21.5) —
 * "open cold, no greeting", "keep beats under 12s". Adopted entries (top ~6
 * by confidence) are injected into scriptwriter/ideation prompts as a
 * CHANNEL PLAYBOOK block with the WHY attached. Trial entries await operator
 * approval (T0/T1) or the next retro's evidence; retired entries keep their
 * history so the retro agent can distinguish "worked once" from "works".
 */
export const channelPlaybook = pgTable(
  "channel_playbook",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    directive: text("directive").notNull(),
    scope: playbookScope("scope").notNull(),
    origin: playbookOrigin("origin").notNull(),
    status: playbookStatus("status").notNull().default("trial"),
    /** the evidence-backed reason, injected alongside the directive */
    why: text("why").notNull(),
    /** matured videos + metric deltas backing this entry */
    evidence: jsonb("evidence").$type<{
      videoIds: string[];
      metric?: string;
      delta?: string;
      note?: string;
    }>(),
    confidence: real("confidence").notNull().default(0.5),
    adoptedAt: timestamp("adopted_at", { withTimezone: true }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("channel_playbook_channel_id_idx").on(t.channelId)],
);

// ── Golden-set eval harness (#21.2.5 / PROMPT-AUDIT §6) ────────────────────

export const evalRunStatus = pgEnum("eval_run_status", ["running", "complete", "failed"]);
export const evalResultStatus = pgEnum("eval_result_status", ["ok", "error"]);

/**
 * One evaluation sweep: the golden fixture set run through the script chain
 * once per candidate model. Routing decisions come from this table's results
 * (BACKLOG #21.2.5: "routing by evidence, not vibes") — re-run when a new
 * model drops.
 */
export const evalRuns = pgTable("eval_runs", {
  id: text("id").primaryKey(),
  status: evalRunStatus("status").notNull().default("running"),
  /** vendor-prefixed candidate refs, e.g. ["anthropic:claude-opus-4-8", "qwen:qwen-max"] */
  models: jsonb("models").$type<string[]>().notNull(),
  fixtureCount: integer("fixture_count").notNull().default(0),
  note: text("note"),
  error: text("error"),
  concludedAt: timestamp("concluded_at", { withTimezone: true }),
  ...timestamps,
});

/** One fixture × model result: the produced script + judge scores + metrics. */
export const evalResults = pgTable(
  "eval_results",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => evalRuns.id, { onDelete: "cascade" }),
    fixtureId: text("fixture_id").notNull(),
    modelRef: text("model_ref").notNull(),
    status: evalResultStatus("status").notNull().default("ok"),
    error: text("error"),
    /** the chain's output (hook + full narration) — what the blind A/B shows */
    script: jsonb("script").$type<{ hookText: string; fullText: string }>(),
    /** judge rubric scores (fixed instrument model, clamped 0-10) */
    judge: jsonb("judge").$type<{
      factCompliance: number;
      hookStrength: number;
      voiceNaturalness: number;
      overall: number;
      rationale: string;
    }>(),
    /** deterministic metrics: AI tells, length adherence, cost, latency (EvalMetrics) */
    metrics: jsonb("metrics").$type<Record<string, number>>(),
    ...timestamps,
  },
  (t) => [
    index("eval_results_run_id_idx").on(t.runId),
    uniqueIndex("eval_results_identity_uq").on(t.runId, t.fixtureId, t.modelRef),
  ],
);

/** Blind A/B pairwise pick (operator): winner/loser eval_results of one fixture. */
export const evalVotes = pgTable("eval_votes", {
  id: text("id").primaryKey(),
  runId: text("run_id")
    .notNull()
    .references(() => evalRuns.id, { onDelete: "cascade" }),
  fixtureId: text("fixture_id").notNull(),
  winnerResultId: text("winner_result_id")
    .notNull()
    .references(() => evalResults.id, { onDelete: "cascade" }),
  loserResultId: text("loser_result_id")
    .notNull()
    .references(() => evalResults.id, { onDelete: "cascade" }),
  ...timestamps,
});

/**
 * Global stock-API rate budget (one token-bucket row per provider), shared by
 * every channel and every worker instance so the platform COLLECTIVELY stays
 * under each provider's strict free-tier limit (Unsplash demo = 50 req/hr
 * app-wide, Coverr similar). `tokens` refills continuously from `refillPerSec`
 * up to `capacity`; a request consumes one token via a single atomic UPDATE,
 * and when the bucket is empty the source is skipped (never queued) so sourcing
 * degrades to the next library instead of spiking the API and getting the key
 * flagged/disabled. Config lives in code/env; only the live bucket state here.
 */
export const stockRateBudget = pgTable("stock_rate_budget", {
  provider: text("provider").primaryKey(),
  tokens: real("tokens").notNull(),
  capacity: real("capacity").notNull(),
  refillPerSec: real("refill_per_sec").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * 24-hour stock-search result cache (Pixabay's API terms MANDATE caching for
 * 24h; also collapses repeated-subject volume before it reaches the rate
 * bucket). Keyed by (provider, query); `candidates` is the lightweight
 * candidate list the reference provider scores, not the image bytes.
 */
export const stockSearchCache = pgTable(
  "stock_search_cache",
  {
    provider: text("provider").notNull(),
    query: text("query").notNull(),
    candidates: jsonb("candidates").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("stock_search_cache_pk").on(t.provider, t.query)],
);
