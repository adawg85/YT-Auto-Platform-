/**
 * Canonical data model: Channel → Idea → (Score) → Production → Assets →
 * Publication → Analytics, with review gates as logged state transitions.
 *
 * Variation-check note: v1 stores a substanceFingerprint per production and
 * compares with Jaccard shingles in app code. If that proves too coarse,
 * migrate to pgvector: `ALTER TABLE productions ADD COLUMN embedding vector(1536)`.
 */
import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
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

export const ideaSource = pgEnum("idea_source", ["agent", "manual", "research"]);

export const productionStatus = pgEnum("production_status", [
  "proposed",
  "scored",
  "greenlit",
  "scripting",
  "script_review",
  "producing_assets",
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
]);

export const gateKind = pgEnum("gate_kind", ["script_review", "thumbnail_review"]);

export const gateStatus = pgEnum("gate_status", ["pending", "decided", "expired"]);

export const gateDecision = pgEnum("gate_decision", ["approved", "rejected", "revise"]);

export const assetKind = pgEnum("asset_kind", [
  "voiceover",
  "image",
  "render",
  "caption_track",
  "thumbnail",
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
  /** 0=manual, 1=assisted, 2=supervised, 3=exception-only */
  autonomyTier: integer("autonomy_tier").notNull().default(0),
  youtubeChannelId: text("youtube_channel_id"),
  /** reference into the secrets store / env, never the token itself */
  oauthTokenRef: text("oauth_token_ref"),
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
      .$type<{ primaryColor: string; font: string; imageStyle: string }>()
      .notNull(),
    /** per-niche thumbnail grammar (spec §5.5); null → derive on first use */
    thumbnailSpec: jsonb("thumbnail_spec").$type<ThumbnailSpec>(),
    voiceId: text("voice_id").notNull(),
    ctaTemplate: text("cta_template").notNull(),
    targetLengthSec: integer("target_length_sec").notNull().default(45),
    cadencePerWeek: integer("cadence_per_week").notNull().default(3),
    ...timestamps,
  },
  (t) => [uniqueIndex("channel_dna_channel_id_uq").on(t.channelId)],
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
});

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
});

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
  ...timestamps,
});

export type ScriptBeat = {
  type: "hook" | "stat" | "insight" | "cta";
  text: string;
  imagePrompt: string;
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
  ...timestamps,
});

export const publications = pgTable("publications", {
  id: text("id").primaryKey(),
  productionId: text("production_id")
    .notNull()
    .references(() => productions.id),
  provider: text("provider").notNull().default("youtube"),
  providerVideoId: text("provider_video_id").notNull(),
  url: text("url").notNull(),
  privacyStatus: text("privacy_status").notNull().default("private"),
  /** synthetic-media disclosure — compliance requirement, defaults ON */
  aiDisclosure: boolean("ai_disclosure").notNull().default(true),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  /** Phase 3: scheduled publishing against YouTube quota */
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
  ...timestamps,
});

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
});

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
  raw: jsonb("raw").$type<Record<string, unknown>>(),
  ...timestamps,
});

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
  type: "hook" | "stat" | "insight" | "cta";
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
]);

/** own = learned from our published videos; external = scouted (build #4). */
export const patternSource = pgEnum("pattern_source", ["own", "external"]);

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

export const alertKind = pgEnum("alert_kind", [
  "underperformance",
  "low_retention",
  "demonetisation",
  "copyright_claim",
  "comment_sentiment",
]);

export const alertSeverity = pgEnum("alert_severity", ["info", "warning", "critical"]);

export const alertStatus = pgEnum("alert_status", ["open", "acked"]);

/** The alerting rail (spec §5.4): one open alert per (publication, kind). */
export const alerts = pgTable("alerts", {
  id: text("id").primaryKey(),
  channelId: text("channel_id")
    .notNull()
    .references(() => channels.id, { onDelete: "cascade" }),
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
