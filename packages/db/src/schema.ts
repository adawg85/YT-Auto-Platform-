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
  // operator pulled it back to the idea pool; kept as a resumable draft
  "halted",
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
  /** burned-in word-by-word captions */
  captions: boolean;
  /** optional ducked music bed */
  music: "off" | "subtle" | "standard";
  /** how the voice performs (voice id itself is `voiceId`) */
  delivery: "measured" | "warm" | "energetic" | "dramatic";
  /** free-text art direction for the image model / reference-photo selection */
  artDirection?: string;
  /** general standing notes injected into the pipeline prompts */
  notes?: string;
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
    /** BACKLOG #17: structured warm-up → first-month → steady release plan */
    releasePlan: jsonb("release_plan").$type<ReleasePlan>(),
    /** BACKLOG #18: per-channel production control plane; null → resolved defaults */
    productionProfile: jsonb("production_profile").$type<ProductionProfile>(),
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
  /** build #5.2: produced under this one-variable experiment (nullable) */
  experimentId: text("experiment_id"),
  /** BACKLOG #6: this is a Short derived from that long-form master production
   * (provenance + one-way funnel link). Soft ref. */
  masterProductionId: text("master_production_id"),
  ...timestamps,
}, (t) => [index("productions_channel_id_idx").on(t.channelId), index("productions_idea_id_idx").on(t.ideaId)]);

export type ScriptBeat = {
  type: "hook" | "stat" | "insight" | "cta";
  text: string;
  imagePrompt: string;
  /** specific real subject this beat depicts (for sourcing a real photo), or null */
  referenceEntity?: string | null;
  /** estimated spoken seconds (computed from word count; render uses real audio timings) */
  estSec?: number;
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
  /** build: channel viability — post-warm-up 28-day impressions below the bar */
  "viability",
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
