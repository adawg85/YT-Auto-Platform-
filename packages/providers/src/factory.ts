import type { CostSink } from "@ytauto/core";
import type { Providers } from "./types";
import { createFsObjectStore } from "./store/fs";
import { createS3ObjectStore } from "./store/s3";
import { createMockLLMProvider } from "./mock/llm";
import { createMockVoiceProvider } from "./mock/voice";
import { createMockMediaProvider } from "./mock/media";
import { createMockResearchProvider } from "./mock/research";
import { createMockPublishProvider } from "./mock/publish";
import { createOpenRouterProvider } from "./real/llm";
import { createElevenLabsProvider } from "./real/voice";
import { createFalMediaProvider } from "./real/media";
import { createYouTubePublishProvider } from "./real/publish";

/**
 * Per-provider real-vs-mock selection by env-var presence (spec: real + mock
 * adapters). PROVIDERS_FORCE_MOCK=1 forces mocks even when keys exist.
 * With zero keys the platform runs fully mocked, end to end.
 */
export function createProviders(costSink: CostSink, env = process.env): Providers {
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

  const youtubeConfigured =
    env.YOUTUBE_CLIENT_ID && env.YOUTUBE_CLIENT_SECRET && env.YOUTUBE_REFRESH_TOKEN;

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
    // Research: mock fixtures in v1; a VidIQ-style real adapter slots in here
    // behind the same interface when API access is arranged.
    research: createMockResearchProvider(costSink),
    publish: real(
      youtubeConfigured ? "yes" : undefined,
      () =>
        createYouTubePublishProvider(
          {
            clientId: env.YOUTUBE_CLIENT_ID!,
            clientSecret: env.YOUTUBE_CLIENT_SECRET!,
            refreshToken: env.YOUTUBE_REFRESH_TOKEN!,
          },
          store,
          costSink,
        ),
      () => createMockPublishProvider(store, costSink),
    ),
  };
}
