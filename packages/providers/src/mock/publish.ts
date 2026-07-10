import { ulid } from "ulid";
import type { CostSink } from "@ytauto/core";
import type { ObjectStore, PublishProvider } from "../types";

/** Mock YouTube publish: verifies the render exists, returns a fake video id. */
export function createMockPublishProvider(store: ObjectStore, costSink: CostSink): PublishProvider {
  return {
    name: "mock-publish",
    async upload(req) {
      if (!(await store.exists(req.videoStorageKey))) {
        throw new Error(`Video not found in store: ${req.videoStorageKey}`);
      }
      const providerVideoId = `mock-${ulid()}`;
      await costSink.record({
        category: "publish",
        provider: "mock-publish",
        units: { quotaUnits: 1600 }, // YouTube upload quota cost, tracked from day one
        costUsd: 0,
        channelId: req.channelId,
        productionId: req.productionId,
        meta: {
          privacy: req.privacy,
          aiDisclosure: req.selfDeclaredAiContent,
          ...(req.publishAt ? { publishAt: req.publishAt } : {}),
        },
      });
      return {
        providerVideoId,
        url: `https://youtube.example/watch?v=${providerVideoId}`,
      };
    },
    async release({ channelId, providerVideoId }) {
      await costSink.record({
        category: "publish",
        provider: "mock-publish",
        units: { quotaUnits: 50 },
        costUsd: 0,
        channelId,
        meta: { action: "release", videoId: providerVideoId },
      });
    },
    async schedule({ channelId, providerVideoId, publishAt }) {
      await costSink.record({
        category: "publish",
        provider: "mock-publish",
        units: { quotaUnits: 50 },
        costUsd: 0,
        channelId,
        meta: {
          action: publishAt ? "reschedule" : "unschedule",
          videoId: providerVideoId,
          ...(publishAt ? { publishAt } : {}),
        },
      });
    },
    async videoStatus() {
      // The mock has no provider-side state to reconcile against; "unknown"
      // makes the finalize cron fall back to time-based bookkeeping.
      return { state: "unknown" as const };
    },
    async setThumbnail({ channelId, productionId, providerVideoId, imageStorageKey }) {
      if (!(await store.exists(imageStorageKey))) {
        throw new Error(`Thumbnail not found in store: ${imageStorageKey}`);
      }
      await costSink.record({
        category: "publish",
        provider: "mock-publish",
        units: { quotaUnits: 50 },
        costUsd: 0,
        channelId,
        productionId,
        meta: { action: "set_thumbnail", videoId: providerVideoId, imageStorageKey },
      });
    },
  };
}
