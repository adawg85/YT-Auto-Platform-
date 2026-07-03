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
  title: string;
  channelName: string;
  views: number;
  publishedAt: string;
  outlierFactor: number;
};
export type KeywordStat = { keyword: string; monthlyVolume: number; competition: number };

export interface ResearchProvider {
  readonly name: string;
  outliers(niche: string): Promise<OutlierVideo[]>;
  keywords(seed: string): Promise<KeywordStat[]>;
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

export interface Providers {
  llm: LLMProvider;
  voice: VoiceProvider;
  media: MediaProvider;
  research: ResearchProvider;
  publish: PublishProvider;
  analytics: AnalyticsProvider;
  store: ObjectStore;
}
