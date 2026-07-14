import type { CostSink } from "@ytauto/core";
import type { MediaProvider, ObjectStore, Providers, VideoProvider } from "./types";
import { createFsObjectStore } from "./store/fs";
import { createS3ObjectStore } from "./store/s3";
import { createMockLLMProvider } from "./mock/llm";
import { createMockVoiceProvider } from "./mock/voice";
import { createMockReferenceProvider } from "./mock/reference-images";
import { createWikimediaReferenceProvider } from "./real/reference-images";
import { createMockMediaProvider } from "./mock/media";
import { createMockResearchProvider } from "./mock/research";
import { createMockPublishProvider } from "./mock/publish";
import { createMockAnalyticsProvider } from "./mock/analytics";
import { createVidIQResearchProvider } from "./real/research";
import { createVidiqMcpCaller } from "./real/vidiq-mcp";
import { createYouTubeResearchProvider } from "./real/youtube-research";
import { createLLMRouter, VENDOR_KEY_VARS } from "./real/llm";
import { createElevenLabsProvider } from "./real/voice";
import { createFalMediaProvider } from "./real/media";
import { createGeminiMediaProvider } from "./real/media-gemini";
import { createQwenMediaProvider } from "./real/media-qwen";
import { createMockVideoProvider } from "./mock/video";
import { createWanVideoProvider } from "./real/video-wan";
import { createMinimaxVideoProvider } from "./real/video-minimax";
import { createYouTubePublishProvider } from "./real/publish";
import { createYouTubeAnalyticsProvider } from "./real/analytics";
import { createMockEmbeddingProvider } from "./mock/embedding";
import { createMockSourceConnectors } from "./mock/sources";
import { createOpenAIEmbeddingProvider } from "./real/embedding";
import { createRssSourceConnector } from "./real/sources-rss";
import { createWebSourceConnector } from "./real/sources-web";
import { createYouTubeSourceConnector } from "./real/sources-youtube";
import { createTavilySearchProvider } from "./real/search-tavily";

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
    llm:
      !forceMock && Object.values(VENDOR_KEY_VARS).some((k) => env[k])
        ? createLLMRouter(env)
        : createMockLLMProvider(),
    voice: real(
      env.ELEVENLABS_API_KEY,
      () => createElevenLabsProvider(env.ELEVENLABS_API_KEY!, store, costSink),
      () => createMockVoiceProvider(store, costSink),
    ),
    media: selectMediaProvider(forceMock, env, store, costSink),
    video: selectVideoProvider(forceMock, env, store, costSink),
    // subject-accurate imagery (#7): keyless Wikimedia lookup; only mocked when
    // providers are forced to mock (offline/CI), else it makes real API calls
    // and degrades to null (→ generative fallback) on any failure.
    reference: forceMock
      ? createMockReferenceProvider()
      : createWikimediaReferenceProvider(store),
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
    // Real web-search research backend (Tavily). Key-presence selection; when
    // absent, research falls back to the legacy discover-URLs + scrape path.
    search:
      !forceMock && env.TAVILY_API_KEY
        ? createTavilySearchProvider(env.TAVILY_API_KEY, costSink)
        : undefined,
    // Embeddings for the pgvector semantic memory (key-presence selection).
    embeddings: real(
      env.OPENAI_API_KEY,
      () => createOpenAIEmbeddingProvider(env.OPENAI_API_KEY!, costSink),
      createMockEmbeddingProvider,
    ),
  };
}

/**
 * #21.2.5 eval harness: an LLMProvider whose frontier + agentic tiers route to
 * ONE candidate model ref, so the golden-set script chain (draft → humanize)
 * runs entirely on the model under test. Reuses the router's full resolution
 * (vendor keys, OpenRouter fallback). Mock mode (forced or keyless) returns
 * the mock provider so evals stay runnable offline.
 */
export function createEvalLLM(
  env: NodeJS.ProcessEnv,
  candidateRef: string,
): Providers["llm"] {
  const hasKey = Object.values(VENDOR_KEY_VARS).some((k) => env[k]);
  if (env.PROVIDERS_FORCE_MOCK === "1" || !hasKey) return createMockLLMProvider();
  return createLLMRouter({
    ...env,
    LLM_MODEL_FRONTIER: candidateRef,
    LLM_MODEL_AGENTIC: candidateRef,
    LLM_MODEL_ESCALATION: undefined,
  });
}

/**
 * Image engine selection. fal is RETIRED as a routed choice (2026-07-14):
 * every caller passes engine "qwen" (DashScope-direct bulk) or "nano-banana"
 * (Google-direct); the fal provider survives ONLY as the base fallback that
 * serves a routed request when its vendor key is missing (and the mock when
 * keyless / forced).
 */
function selectMediaProvider(
  forceMock: boolean,
  env: NodeJS.ProcessEnv,
  store: ObjectStore,
  costSink: CostSink,
): MediaProvider {
  if (forceMock) return createMockMediaProvider(store, costSink);
  const base = env.FAL_KEY
    ? createFalMediaProvider(env.FAL_KEY, store, costSink)
    : createMockMediaProvider(store, costSink);
  const gemini = env.GEMINI_API_KEY ? createGeminiMediaProvider(env.GEMINI_API_KEY, store, costSink) : null;
  const qwen = env.DASHSCOPE_API_KEY ? createQwenMediaProvider(env.DASHSCOPE_API_KEY, store, costSink) : null;
  if (!gemini && !qwen) return base;
  return {
    name: base.name,
    generateImage: async (req) => {
      const routed =
        req.engine === "nano-banana" && gemini ? gemini : req.engine === "qwen" && qwen ? qwen : base;
      if (routed === base) return base.generateImage(req);
      try {
        return await routed.generateImage(req);
      } catch (err) {
        // 2026-07-14 prod incident: a vendor-direct engine failing on every
        // shot killed whole productions. A broken engine degrades to the base
        // provider instead — the cost ledger shows which engine actually
        // served, so a silently-degraded run is still diagnosable.
        console.error(`[media] ${routed.name} engine failed — falling back to ${base.name}:`, err);
        return base.generateImage({ ...req, engine: undefined });
      }
    },
  };
}

/**
 * Beat-clip engine selection (2026-07-14, faceless tier — DIRECT vendor APIs,
 * no fal). Base engine by key presence — Wan (DASHSCOPE_API_KEY) preferred,
 * Minimax (MINIMAX_API_KEY) second, mock keyless — and the per-channel
 * profile's videoEngine dispatches per call, mirroring the image engines.
 */
function selectVideoProvider(
  forceMock: boolean,
  env: NodeJS.ProcessEnv,
  store: ObjectStore,
  costSink: CostSink,
): VideoProvider {
  if (forceMock) return createMockVideoProvider(store, costSink);
  const wan = env.DASHSCOPE_API_KEY ? createWanVideoProvider(env.DASHSCOPE_API_KEY, store, costSink) : null;
  const minimax = env.MINIMAX_API_KEY ? createMinimaxVideoProvider(env.MINIMAX_API_KEY, store, costSink) : null;
  const base = wan ?? minimax ?? createMockVideoProvider(store, costSink);
  if (!wan && !minimax) return base;
  return {
    name: base.name,
    generateClip: (req) =>
      (req.engine === "minimax" && minimax ? minimax : req.engine === "wan" && wan ? wan : base).generateClip(req),
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
