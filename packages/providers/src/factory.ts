import type { CostSink } from "@ytauto/core";
import type { MediaProvider, ObjectStore, Providers, VideoProvider } from "./types";
import { createFsObjectStore } from "./store/fs";
import { createS3ObjectStore } from "./store/s3";
import { createMockLLMProvider } from "./mock/llm";
import { createMockVoiceProvider } from "./mock/voice";
import { createMockMusicProvider } from "./mock/music";
import { createElevenLabsMusicProvider } from "./real/music";
import { createOpenverseMusicProvider } from "./real/music-openverse";
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
import { createGeminiMediaProvider } from "./real/media-gemini";
import { createQwenMediaProvider } from "./real/media-qwen";
import { createSeedreamMediaProvider } from "./real/media-seedream";
import { createMockVideoProvider } from "./mock/video";
import { createWanVideoProvider } from "./real/video-wan";
import { createSeedanceVideoProvider } from "./real/video-seedance";
import { VIDEO_PRICE_SEEDANCE_MINI_PER_SEC, VIDEO_PRICE_SEEDANCE_PER_SEC } from "./pricing";
import { createKlingVideoProvider } from "./real/video-kling";
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
import type { StockGate } from "@ytauto/core";

export type ProviderOptions = {
  /** decrypted per-channel YouTube refresh token (from the secrets table) */
  resolveChannelToken?: (channelId: string) => Promise<string | null>;
  /**
   * Global stock-API rate governor + 24h cache (built from `db` in the worker,
   * which providers can't depend on). Routes the reference provider's stock
   * photo lookups through a shared token bucket so every channel collectively
   * stays under each provider's strict free-tier limit.
   */
  stockGate?: StockGate;
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
    // Background-music bed (Production Profile "music" axis). ElevenLabs Music
    // when its key is present (degrades to the mock bed on any failure), else
    // the deterministic mock so a zero-key install still lays a real bed.
    music: real(
      env.ELEVENLABS_API_KEY,
      () =>
        createElevenLabsMusicProvider(
          env.ELEVENLABS_API_KEY!,
          store,
          costSink,
          createMockMusicProvider(store, costSink),
        ),
      () => createMockMusicProvider(store, costSink),
    ),
    // Free CC-audio library backing the per-channel music bed (Openverse,
    // keyless). Only absent when providers are forced to mock (offline/CI).
    musicLibrary: forceMock ? undefined : createOpenverseMusicProvider(store),
    media: selectMediaProvider(forceMock, env, store, costSink),
    video: selectVideoProvider(forceMock, env, store, costSink),
    // subject-accurate imagery (#7): keyless Wikimedia lookup; only mocked when
    // providers are forced to mock (offline/CI), else it makes real API calls
    // and degrades to null (→ generative fallback) on any failure.
    reference: forceMock
      ? createMockReferenceProvider()
      : createWikimediaReferenceProvider(
          store,
          {
            // BACKLOG #7/#36: free stock photo libraries top up the archival pool
            pexels: env.PEXELS_API_KEY,
            pixabay: env.PIXABAY_API_KEY,
            unsplash: env.UNSPLASH_ACCESS_KEY,
          },
          opts.stockGate,
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
 * Image engine selection (2026-07-16: fal fully stripped — every engine is
 * vendor-DIRECT). Callers pass engine "nano-banana" (Gemini, hero/character),
 * "qwen" (DashScope bulk) or "seedream" (ByteDance ModelArk bulk). The mock is
 * the only base, used keyless / forced-mock; on a real failure we degrade
 * through the OTHER real engines first and stamp the served engine LOUD so a
 * silent downgrade is never mistaken for a prompt bug.
 */
function selectMediaProvider(
  forceMock: boolean,
  env: NodeJS.ProcessEnv,
  store: ObjectStore,
  costSink: CostSink,
): MediaProvider {
  const mock = createMockMediaProvider(store, costSink);
  if (forceMock) return mock;
  const gemini = env.GEMINI_API_KEY ? createGeminiMediaProvider(env.GEMINI_API_KEY, store, costSink) : null;
  const qwen = env.DASHSCOPE_API_KEY ? createQwenMediaProvider(env.DASHSCOPE_API_KEY, store, costSink) : null;
  // Seedream is DIRECT on BytePlus ModelArk — a nicer bulk alternative to Qwen,
  // picked per channel. Prefers its dedicated key (Seedream and Seedance are
  // separate ModelArk keys, each with its own model activation) and falls back
  // to the shared ARK_API_KEY.
  const seedreamKey = env.SEEDREAM_API_KEY ?? env.ARK_API_KEY;
  const seedream = seedreamKey ? createSeedreamMediaProvider(seedreamKey, store, costSink) : null;
  const reals = [gemini, qwen, seedream].filter((p): p is MediaProvider => !!p);
  if (reals.length === 0) return mock; // no keys → full mock mode
  const byEngine: Record<string, MediaProvider | null> = { "nano-banana": gemini, qwen, seedream };
  // last resort when a request has no engine or its engine is keyless: a REAL
  // engine if any, only then mock — never a silent drop to placeholder art.
  const lastResort = qwen ?? gemini ?? seedream ?? mock;
  return {
    name: lastResort.name,
    generateImage: async (req) => {
      const routed = req.engine ? byEngine[req.engine] : null;
      if (req.engine && req.engine in byEngine && !routed) {
        console.warn(
          `[media] ⚠ requested engine "${req.engine}" has NO provider (missing API key) — using ${lastResort.name}`,
        );
      }
      const primary = routed ?? lastResort;
      if (primary === mock) return { ...(await mock.generateImage(req)), engine: mock.name };
      // degrade through the OTHER real engines, then mock as the final backstop.
      // The served engine is stamped on the result (and logged LOUD) so a silent
      // degrade — e.g. Gemini out of prepaid credits (429) quietly served by
      // qwen — is visible, not a phantom "model/prompt" bug (2026-07-15).
      // When the caller passes `fallbackEngines` (the channel's Style-tab order),
      // degrade down THAT list only — never an engine the operator didn't pick
      // (2026-07-16: "fallback should follow exactly what is in the Style tab").
      let fallbacks: MediaProvider[];
      if (req.fallbackEngines) {
        const seen = new Set<MediaProvider>([primary]);
        fallbacks = [];
        for (const e of req.fallbackEngines) {
          const p = byEngine[e];
          if (p && !seen.has(p)) {
            seen.add(p);
            fallbacks.push(p);
          }
        }
      } else {
        fallbacks = reals.filter((p) => p !== primary);
      }
      try {
        return { ...(await primary.generateImage(req)), engine: primary.name };
      } catch (err) {
        console.error(`[media] ⚠ requested engine "${req.engine}" (${primary.name}) FAILED — degrading:`, err);
        for (const fb of fallbacks) {
          try {
            const res = await fb.generateImage({ ...req, engine: undefined });
            console.warn(`[media] ⚠ served by FALLBACK ${fb.name} instead of ${primary.name} — check ${primary.name} billing/quota`);
            return { ...res, engine: fb.name };
          } catch (err2) {
            console.error(`[media] ${fb.name} fallback also failed:`, err2);
          }
        }
        console.warn(`[media] ⚠ every real engine failed — served by LAST-RESORT mock`);
        return { ...(await mock.generateImage({ ...req, engine: undefined })), engine: mock.name };
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
  // Seedance is DIRECT on BytePlus ModelArk — the character-clip identity
  // engine. Prefers its dedicated key (separate from Seedream's; each has its
  // own model activation) and falls back to the shared ARK_API_KEY.
  const seedanceKey = env.SEEDANCE_API_KEY ?? env.ARK_API_KEY;
  // Two Seedance tiers on the same key (2026-07-17 operator): the plain
  // "seedance" engine is the cheap MINI model (default for cartoon channels);
  // "seedance-pro" is the pricey cinematic Pro model, opt-in per channel.
  const seedance = seedanceKey
    ? createSeedanceVideoProvider(seedanceKey, store, costSink, {
        name: "seedance",
        model: env.SEEDANCE_VIDEO_MODEL ?? "dreamina-seedance-2-0-mini-260615",
        pricePerSec: VIDEO_PRICE_SEEDANCE_MINI_PER_SEC,
        // §4.1: per-model allowed discrete durations (Mini vs Pro differ)
        allowedDurations: env.SEEDANCE_ALLOWED_DURATIONS,
      })
    : null;
  const seedancePro = seedanceKey
    ? createSeedanceVideoProvider(seedanceKey, store, costSink, {
        name: "seedance-pro",
        model: env.SEEDANCE_PRO_VIDEO_MODEL ?? "dreamina-seedance-2-0-260128",
        pricePerSec: VIDEO_PRICE_SEEDANCE_PER_SEC,
        allowedDurations: env.SEEDANCE_PRO_ALLOWED_DURATIONS ?? env.SEEDANCE_ALLOWED_DURATIONS,
      })
    : null;
  // Kling is DIRECT on the Kling Open Platform (AK/SK → per-request JWT) — the
  // premium cinematic tier.
  const kling =
    env.KLING_ACCESS_KEY && env.KLING_SECRET_KEY
      ? createKlingVideoProvider(env.KLING_ACCESS_KEY, env.KLING_SECRET_KEY, store, costSink)
      : null;
  const base = wan ?? minimax ?? seedance ?? createMockVideoProvider(store, costSink);
  if (!wan && !minimax && !seedance && !kling) return base;
  const byEngine: Record<string, VideoProvider | null> = { wan, minimax, seedance, "seedance-pro": seedancePro, kling };
  return {
    name: base.name,
    generateClip: (req) => {
      if (req.engine && req.engine in byEngine && !byEngine[req.engine]) {
        console.warn(
          `[video] ⚠ requested engine "${req.engine}" has NO provider (missing API key) — serving with ${base.name}`,
        );
      }
      return ((req.engine && byEngine[req.engine]) || base).generateClip(req);
    },
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
