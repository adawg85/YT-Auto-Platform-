import type { CostSink } from "@ytauto/core";
import type { Providers } from "./types";
import { createFsObjectStore } from "./store/fs";
import { createS3ObjectStore } from "./store/s3";
import { createMockLLMProvider } from "./mock/llm";
import { createMockVoiceProvider } from "./mock/voice";
import { createMockMediaProvider } from "./mock/media";
import { createMockResearchProvider } from "./mock/research";
import { createMockPublishProvider } from "./mock/publish";
import { createMockAnalyticsProvider } from "./mock/analytics";
import { createVidIQResearchProvider } from "./real/research";
import { createVidiqMcpCaller } from "./real/vidiq-mcp";
import { createYouTubeResearchProvider } from "./real/youtube-research";
import { createOpenRouterProvider } from "./real/llm";
import { createElevenLabsProvider } from "./real/voice";
import { createFalMediaProvider } from "./real/media";
import { createYouTubePublishProvider } from "./real/publish";
import { createYouTubeAnalyticsProvider } from "./real/analytics";
import { createMockEmbeddingProvider } from "./mock/embedding";
import { createMockSourceConnectors } from "./mock/sources";
import { createOpenAIEmbeddingProvider } from "./real/embedding";
import { createRssSourceConnector } from "./real/sources-rss";
import { createWebSourceConnector } from "./real/sources-web";
import { createYouTubeSourceConnector } from "./real/sources-youtube";

export type ProviderOptions = {
  /** decrypted per-channel YouTube refresh token (from the secrets table) */
  resolveChannelToken?: (channelId: string) => Promise<string | null>;
};

/**
 * Per-provider real-vs-mock selection by env-var presence (spec: real + mock
 * adapters). PROVIDERS_FORCE_MOCK=1 forces mocks even when keys exist.
 * With zero keys the platform runs fully mocked, end to end.
 */
export function createProviders(
  costSink: CostSink,
  env = process.env,
  opts: ProviderOptions = {},
): Providers {
  const forceMock = env.PROVIDERS_FORCE_MOCK === "1";
  const real = <T>(key: string | undefined, make: () => T, mock: () => T): T =>
    !forceMock && key ? make() : mock();

  const store =
    !forceMock && env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
      ? createS3ObjectStore({
          endpoint: env.S3_ENDPOINT,
          region: env.S3_REGION ?? "us-east-1",
          bucket: env.S3_BUCKET,
          accessKeyId: env.S3_ACCESS_KEY_ID,
          secretAccessKey: env.S3_SECRET_ACCESS_KEY,
        })
      : createFsObjectStore(env.STORE_DIR ?? "./data/store");

  // client id+secret make YouTube "configured"; the refresh token is resolved
  // per channel at publish time (global env token as fallback)
  const youtubeConfigured = env.YOUTUBE_CLIENT_ID && env.YOUTUBE_CLIENT_SECRET;

  const resolveYouTubeAuth = async (channelId: string) => {
    const refreshToken =
      (await opts.resolveChannelToken?.(channelId)) ?? env.YOUTUBE_REFRESH_TOKEN;
    if (!refreshToken) return null;
    return {
      clientId: env.YOUTUBE_CLIENT_ID!,
      clientSecret: env.YOUTUBE_CLIENT_SECRET!,
      refreshToken,
    };
  };

  return {
    store,
    llm: real(env.OPENROUTER_API_KEY, () => createOpenRouterProvider(env.OPENROUTER_API_KEY!), createMockLLMProvider),
    voice: real(
      env.ELEVENLABS_API_KEY,
      () => createElevenLabsProvider(env.ELEVENLABS_API_KEY!, store, costSink),
      () => createMockVoiceProvider(store, costSink),
    ),
    media: real(
      env.FAL_KEY,
      () => createFalMediaProvider(env.FAL_KEY!, store, costSink),
      () => createMockMediaProvider(store, costSink),
    ),
    // Research backend (build #4). Default is the deterministic mock so a
    // zero-config install stays fully mocked/offline. Opt into a real backend
    // with RESEARCH_PROVIDER: "youtube" (MIT, youtubei.js, free/keyless — the
    // recommended default real backend) or "vidiq" (premium; needs
    // VIDIQ_API_KEY, adds keyword volume + ready-made breakout scoring). Both
    // sit behind the same ResearchProvider interface.
    research: selectResearchProvider(forceMock, env, costSink),
    publish: real(
      youtubeConfigured ? "yes" : undefined,
      () => createYouTubePublishProvider(resolveYouTubeAuth, store, costSink),
      () => createMockPublishProvider(store, costSink),
    ),
    analytics: real(
      youtubeConfigured ? "yes" : undefined,
      () => createYouTubeAnalyticsProvider(resolveYouTubeAuth),
      createMockAnalyticsProvider,
    ),
    // Editorial-engine truth sources (build #5). rss/web are keyless, so
    // key-presence can't select real — SOURCE_CONNECTORS=real is an explicit
    // opt-in and the zero-config install stays mocked/offline.
    sources: selectSourceConnectors(forceMock, env, costSink),
    // Embeddings for the pgvector semantic memory (key-presence selection).
    embeddings: real(
      env.OPENAI_API_KEY,
      () => createOpenAIEmbeddingProvider(env.OPENAI_API_KEY!, costSink),
      createMockEmbeddingProvider,
    ),
  };
}

function selectSourceConnectors(
  forceMock: boolean,
  env: NodeJS.ProcessEnv,
  costSink: CostSink,
) {
  if (forceMock || env.SOURCE_CONNECTORS !== "real") return createMockSourceConnectors();
  return {
    rss: createRssSourceConnector(),
    web: createWebSourceConnector(),
    // delegates to whichever research backend is configured (mock/youtube/vidiq)
    youtube: createYouTubeSourceConnector(selectResearchProvider(forceMock, env, costSink)),
  };
}

/** Default vidIQ MCP endpoint; override with VIDIQ_MCP_URL if it differs. */
const DEFAULT_VIDIQ_MCP_URL = "https://mcp.vidiq.com/mcp";

function selectResearchProvider(
  forceMock: boolean,
  env: NodeJS.ProcessEnv,
  costSink: CostSink,
) {
  if (forceMock) return createMockResearchProvider(costSink);
  const backend = (env.RESEARCH_PROVIDER ?? "").toLowerCase();
  if (backend === "vidiq" && env.VIDIQ_API_KEY) {
    return createVidIQResearchProvider(
      createVidiqMcpCaller({
        url: env.VIDIQ_MCP_URL ?? DEFAULT_VIDIQ_MCP_URL,
        apiKey: env.VIDIQ_API_KEY,
      }),
    );
  }
  if (backend === "youtube") return createYouTubeResearchProvider();
  // default (or vidiq without a key): stay mocked/offline
  return createMockResearchProvider(costSink);
}
