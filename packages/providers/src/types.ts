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

export interface VoiceProvider {
  readonly name: string;
  synthesize(req: {
    text: string;
    voiceId: string;
    channelId: string;
    productionId: string;
  }): Promise<{
    storageKey: string;
    mimeType: string;
    durationSec: number;
    words: WordTimestamp[];
  }>;
}

export interface MediaProvider {
  readonly name: string;
  generateImage(req: {
    prompt: string;
    aspect: "9:16" | "1:1";
    channelId: string;
    productionId: string;
    idx: number;
  }): Promise<{ storageKey: string; mimeType: string }>;
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
export interface ResearchProvider {
  readonly name: string;
  outliers(niche: string): Promise<OutlierVideo[]>;
  keywords(seed: string): Promise<KeywordStat[]>;
  breakoutChannels(niche: string): Promise<BreakoutChannel[]>;
  trendingVideos(niche: string): Promise<TrendingVideo[]>;
  /** the video's transcript, when the provider can supply one (null if not) */
  transcript(externalId: string): Promise<string | null>;
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
    /** synthetic-media disclosure — always true for generated content */
    selfDeclaredAiContent: true;
    madeForKids: false;
  }): Promise<{ providerVideoId: string; url: string }>;
  /** Flip an uploaded (private) video to public — the T2 "release" click. */
  release(req: { channelId: string; providerVideoId: string }): Promise<void>;
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
 * through its own /api/media route; the worker downloads to tmp for renders —
 * so no presigning is needed in v1.
 */
export interface ObjectStore {
  put(key: string, body: Buffer, mimeType: string): Promise<void>;
  getBuffer(key: string): Promise<Buffer>;
  getStream(key: string): Promise<{ stream: Readable; mimeType?: string }>;
  exists(key: string): Promise<boolean>;
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
  research: ResearchProvider;
  publish: PublishProvider;
  analytics: AnalyticsProvider;
  store: ObjectStore;
  sources: Record<SourceItemKind, SourceConnector>;
  embeddings: EmbeddingProvider;
}
