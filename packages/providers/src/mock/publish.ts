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
        meta: { privacy: req.privacy, aiDisclosure: req.selfDeclaredAiContent },
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
  };
}
