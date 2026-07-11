import type { Readable } from "node:stream";
import type { LanguageModel } from "ai";

export type LLMTier = "cheap" | "agentic" | "frontier";

/**
 * Tiered LLM routing (spec §7): bulk drafting → cheap, agentic work → mid,
 * high-leverage editorial → frontier. Cost is computed by the agent runner
 * from usage × pricing, so every call lands in cost_records.
 */
export interface LLMProvider {
  readonly name: string;
  model(tier: LLMTier): LanguageModel;
  modelId(tier: LLMTier): string;
  /** USD per million tokens for the routed model */
  price(tier: LLMTier): { inputPerMTok: number; outputPerMTok: number };
}

export type WordTimestamp = { word: string; startSec: number; endSec: number };

/** A selectable voice from the TTS provider's library. */
export type VoiceOption = {
  id: string;
  name: string;
  description?: string;
  /** short audio sample the UI can play */
  previewUrl?: string;
  /** provider labels, e.g. { gender, accent, age, use_case } */
  labels?: Record<string, string>;
};

export interface VoiceProvider {
  readonly name: string;
  synthesize(req: {
    text: string;
    voiceId: string;
    channelId: string;
    productionId: string;
    /**
     * Optional TTS voice settings (Production Profile "delivery" axis). Shape
     * matches ElevenLabs' voice_settings; providers that don't support it (e.g.
     * the mock) ignore it. 0–1 ranges.
     */
    voiceSettings?: {
      stability: number;
      similarityBoost: number;
      style: number;
      useSpeakerBoost: boolean;
      /**
       * Narration pace multiplier (BACKLOG #26). ElevenLabs supports 0.7–1.2
       * (1.0 = the voice's natural pace). Omitted → provider default.
       */
      speed?: number;
    };
  }): Promise<{
    storageKey: string;
    mimeType: string;
    durationSec: number;
    words: WordTimestamp[];
  }>;
  /** The provider's voice library, for per-channel/per-video voice selection. */
  listVoices(): Promise<VoiceOption[]>;
}

export interface MediaProvider {
  readonly name: string;
  generateImage(req: {
    prompt: string;
    aspect: "9:16" | "16:9" | "1:1";
    channelId: string;
    productionId?: string;
    idx?: number;
    /**
     * Override the default `productions/<id>/beat-<idx>` storage path (e.g. a
     * channel avatar). The provider appends the correct extension and returns
     * the full storageKey. When omitted, productionId + idx are required.
     */
    storageKeyBase?: string;
  }): Promise<{ storageKey: string; mimeType: string }>;
}

/**
 * Subject-accurate imagery (BACKLOG #7/#16): fetch a REAL picture of a specific
 * named entity (an aircraft, person, place, event) from an authoritative source
 * — e.g. Wikimedia — so history/factual channels show the actual subject, not a
 * plausible-looking generated image. Returns null when no suitably-licensed
 * image is found, so the caller falls back to generative imagery.
 */
export interface ReferenceImageProvider {
  readonly name: string;
  findEntityImage(req: {
    entity: string;
    channelId: string;
    productionId: string;
    idx: number;
  }): Promise<{
    storageKey: string;
    mimeType: string;
    /** page the image/subject came from, for the reviewer */
    sourceUrl: string;
    /** e.g. "CC BY-SA 4.0", "Public domain" */
    license: string;
    /** author/credit text to display for CC-BY */
    attribution: string;
  } | null>;
  /**
   * Topic-keyword archival fallback (BACKLOG #24): when a shot has NO named
   * entity, search the archive by the shot's own words (Commons relevance
   * ranking does the matching) before falling back to AI generation. Same
   * licence rules and return shape as findEntityImage. Optional — providers
   * without a keyword-search surface (e.g. the mock) omit it.
   */
  findTopicImage?(req: {
    keywords: string;
    channelId: string;
    productionId: string;
    idx: number;
  }): Promise<{
    storageKey: string;
    mimeType: string;
    sourceUrl: string;
    license: string;
    attribution: string;
  } | null>;
}

export type OutlierVideo = {
  /** provider-side video id — dedupe anchor for external-video ingestion */
  externalId: string;
  title: string;
  channelName: string;
  views: number;
  /** velocity: views per hour since publish */
  viewsPerHour?: number;
  publishedAt: string;
  outlierFactor: number;
  url?: string;
};
export type KeywordStat = { keyword: string; monthlyVolume: number; competition: number };

/** A fast-rising channel in a niche (VidIQ breakout_channels-style). */
export type BreakoutChannel = {
  externalId: string;
  channelName: string;
  niche: string;
  subscribers: number;
  /** subscriber growth over the trailing 30 days, as a percentage */
  growthRate: number;
  publishedPerWeek: number;
  /** the channel's current top performer, seeds external-video ingestion */
  topVideo: {
    externalId: string;
    title: string;
    views: number;
    viewsPerHour: number;
    publishedAt: string;
  };
};

/** A currently-trending video in a niche (VidIQ trending_videos-style). */
export type TrendingVideo = {
  externalId: string;
  title: string;
  channelName: string;
  views: number;
  viewsPerHour: number;
  engagementRate: number;
  publishedAt: string;
  format: "shorts" | "long";
};

/**
 * Research / competitive-intelligence feeds. v1 ships a deterministic mock; a
 * VidIQ-backed real adapter slots in behind the same interface (outliers,
 * breakout_channels, trending_videos, video_transcript) when API access is
 * arranged. The meta-analysis engine (build #4) is the primary consumer of the
 * breakout/trending/transcript methods.
 */
/** A trending content category, niche-agnostic (BACKLOG #22 cross-niche discovery). */
export type TrendCategory = {
  category: string;
  /** relative heat, 0-100 when the provider supplies one */
  momentum?: number;
  sampleTitles?: string[];
};

export interface ResearchProvider {
  readonly name: string;
  outliers(niche: string): Promise<OutlierVideo[]>;
  keywords(seed: string): Promise<KeywordStat[]>;
  breakoutChannels(niche: string): Promise<BreakoutChannel[]>;
  trendingVideos(niche: string): Promise<TrendingVideo[]>;
  /** the video's transcript, when the provider can supply one (null if not) */
  transcript(externalId: string): Promise<string | null>;
  /** BACKLOG #22: trending categories with NO niche input — new-niche discovery.
   * Optional: only providers with a global trends surface implement it. */
  trendCategories?(): Promise<TrendCategory[]>;
  /** BACKLOG #22: fast-rising channels across the whole platform (no niche seed). */
  globalBreakoutChannels?(): Promise<BreakoutChannel[]>;
}

export interface PublishProvider {
  readonly name: string;
  upload(req: {
    channelId: string;
    productionId: string;
    videoStorageKey: string;
    title: string;
    description: string;
    tags: string[];
    privacy: "private";
    /**
     * YouTube-native scheduled release (BACKLOG #20): ISO timestamp. When set,
     * the video uploads private with `status.publishAt` and YouTube flips it
     * public at that time itself — no sleeping pipeline run holds the video.
     */
    publishAt?: string;
    /** synthetic-media disclosure — always true for generated content */
    selfDeclaredAiContent: true;
    madeForKids: false;
  }): Promise<{ providerVideoId: string; url: string }>;
  /**
   * Duplicate-upload guard (2026-07-11 incident: a ~10-min upload succeeded
   * but the pipeline step timed out before the video id was recorded —
   * Inngest's retries then uploaded the same video three more times). Look
   * for a video ALREADY on the channel with this exact title, uploaded within
   * the window; a retry ADOPTS that orphan's id instead of uploading again.
   * Optional: the mock has no provider-side state and returns null (callers
   * fall through to a fresh upload).
   */
  findRecentUpload?(opts: {
    channelId: string;
    title: string;
    withinMinutes: number;
  }): Promise<string | null>;
  /** Flip an uploaded (private or scheduled) video to public NOW — the
   * "release" / publish-now click. Overrides any pending publishAt. */
  release(req: { channelId: string; providerVideoId: string }): Promise<void>;
  /** Move a scheduled video's native release time (one videos.update call).
   * `publishAt: null` CANCELS the scheduled release — the video stays
   * uploaded + private until an explicit release. */
  schedule(req: { channelId: string; providerVideoId: string; publishAt: string | null }): Promise<void>;
  /**
   * Read the video's live status from the provider (reconciliation: the
   * platform calendar is the source of truth, but Studio-side edits must flow
   * back rather than silently diverge). "unknown" = the provider can't answer
   * (mock, or a read error) — callers fall back to time-based bookkeeping.
   */
  videoStatus(req: { channelId: string; providerVideoId: string }): Promise<
    | { state: "unknown" }
    | { state: "missing" }
    | {
        state: "found";
        privacyStatus: "private" | "public" | "unlisted";
        publishAt: string | null;
        /**
         * Shell-video guard (2026-07-12 incident: a video record existed on
         * YouTube with metadata but no media — "Processing will begin
         * shortly" forever, so the scheduled release silently never fired).
         * null durationSec = the provider has no processed media for this id;
         * callers must not treat such a record as a completed upload.
         */
        durationSec: number | null;
        uploadStatus: string | null;
        processingStatus: string | null;
      }
  >;
  /** Set the video's custom thumbnail from a stored image. */
  setThumbnail(req: {
    channelId: string;
    productionId?: string;
    providerVideoId: string;
    imageStorageKey: string;
  }): Promise<void>;
}

/** Per-channel OAuth resolution for YouTube (v1: channel token from the
 * encrypted secrets table, falling back to a global env token). */
export type YouTubeAuthResolver = (channelId: string) => Promise<{
  clientId: string;
  clientSecret: string;
  refreshToken: string;
} | null>;

export type VideoStats = {
  views: number;
  avgViewDurationSec: number | null;
  /** average % of the video watched, 0-100 */
  avgViewPct: number | null;
  ctr: number | null;
  /** cumulative thumbnail/feed impressions (null when the API doesn't report them) */
  impressions?: number | null;
  /** relative-retention curve (0-100), even-sampled across runtime, [0]=100 */
  retentionCurve?: number[] | null;
  /** % who swiped away in the first 3 seconds */
  swipeAwayPct?: number | null;
  /** % of views from returning viewers */
  returningViewerPct?: number | null;
  /** subscribers gained attributable to this video */
  subsGained?: number | null;
  raw: Record<string, unknown>;
};

export interface AnalyticsProvider {
  readonly name: string;
  fetchVideoStats(req: {
    channelId: string;
    providerVideoId: string;
    publishedAt: string; // ISO
    durationSec: number | null;
  }): Promise<VideoStats>;
}

/**
 * S3-compatible or local-filesystem blob store. Cockpit previews stream
 * through its own /api/media route. `presignGet` (S3-backed stores only) hands
 * Remotion Lambda renderers direct, expiring HTTPS access to private assets —
 * the fs store leaves it undefined and the Lambda path guards on that.
 */
export interface ObjectStore {
  put(key: string, body: Buffer, mimeType: string): Promise<void>;
  getBuffer(key: string): Promise<Buffer>;
  getStream(key: string): Promise<{ stream: Readable; mimeType?: string; contentLength?: number }>;
  exists(key: string): Promise<boolean>;
  presignGet?(key: string, ttlSec: number): Promise<string>;
}

// ── Editorial engine (build #5): source connectors + embeddings ──────────

export type SourceItemKind = "rss" | "web" | "youtube";

/** One fetched document/article/video-listing from a channel truth source. */
export type SourceItem = {
  /** stable id within the source (guid, URL, or video id) — dedupe anchor */
  externalId: string;
  url: string;
  title: string;
  /** extracted text content (article body, feed entry, or title+description) */
  content: string;
  publishedAt?: string;
  author?: string;
};

/**
 * A truth-source connector (build #5). One connector per kind; the per-channel
 * `channel_sources` rows carry the config ({url} for rss/web, {query} for
 * youtube). Connectors THROW on fetch failure — the editorial engine records
 * the error on the source row (scrapers are brittle; errors are tracked, not
 * fatal).
 */
export interface SourceConnector {
  readonly kind: SourceItemKind;
  fetchItems(
    config: Record<string, unknown>,
    opts?: { since?: string; limit?: number; query?: string },
  ): Promise<SourceItem[]>;
}

/**
 * Web search provider for episode research (Tavily/Exa/Sonar). Given a topic
 * query, returns several clean, relevant documents from INDEPENDENT domains —
 * replacing the old "LLM guesses URLs → scrape one page" path that returned
 * broken pages / a single weak domain. Feeds straight into the existing
 * extract → verify → corroborate flow (the results ARE the evidence).
 */
export interface SearchProvider {
  readonly name: string;
  search(
    query: string,
    opts?: { maxResults?: number; excludeDomains?: string[]; channelId?: string },
  ): Promise<SourceItem[]>;
}

/**
 * Text-embedding provider backing the pgvector semantic memory. The mock is
 * deterministic bag-of-words hashing (real cosine behavior for overlapping
 * vocabulary), so retrieval is meaningfully testable with zero keys.
 */
export interface EmbeddingProvider {
  readonly name: string;
  /** must match memory_chunks.embedding vector(N) */
  readonly dimensions: number;
  embed(texts: string[], ctx?: { channelId?: string }): Promise<number[][]>;
}

export interface Providers {
  llm: LLMProvider;
  voice: VoiceProvider;
  media: MediaProvider;
  reference: ReferenceImageProvider;
  research: ResearchProvider;
  publish: PublishProvider;
  analytics: AnalyticsProvider;
  store: ObjectStore;
  sources: Record<SourceItemKind, SourceConnector>;
  /** optional real web-search backend (Tavily); undefined → legacy scrape path */
  search?: SearchProvider;
  embeddings: EmbeddingProvider;
}
