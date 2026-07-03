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
  raw: jsonb("raw").$type<Record<string, unknown>>(),
  ...timestamps,
});

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
