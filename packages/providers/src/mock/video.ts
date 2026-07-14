import type { CostSink } from "@ytauto/core";
import type { ObjectStore, VideoProvider } from "../types";
import { VIDEO_PRICE_WAN_PER_SEC } from "../pricing";
import { MOCK_MP4_BASE64, MOCK_MP4_DURATION_SEC } from "./video-fixture";

/**
 * Mock beat-clip generation: writes the embedded 12s gradient mp4 (a real,
 * decodable h264 file — OffthreadVideo can't play the SVG trick mock images
 * use) so the whole trim → props → Remotion render path exercises keylessly.
 * Cost rows use the Wan estimate so projected unit economics show up with
 * zero keys, mirroring the mock image provider.
 */
export function createMockVideoProvider(store: ObjectStore, costSink: CostSink): VideoProvider {
  const fixture = Buffer.from(MOCK_MP4_BASE64, "base64");
  return {
    name: "mock-video",
    async generateClip({ prompt, durationSec, channelId, productionId, idx, storageKeyBase }) {
      const storageKey = `${storageKeyBase ?? `productions/${productionId}/genclip-${idx}`}.mp4`;
      await store.put(storageKey, fixture, "video/mp4");
      const billedSec = Math.min(MOCK_MP4_DURATION_SEC, Math.max(1, Math.ceil(durationSec)));
      await costSink.record({
        category: "media",
        provider: "mock-video",
        model: "mock-clip",
        units: { seconds: billedSec, videos: 1 },
        costUsd: billedSec * VIDEO_PRICE_WAN_PER_SEC,
        channelId,
        productionId,
        meta: { prompt: prompt.slice(0, 200), idx },
      });
      return {
        storageKey,
        mimeType: "video/mp4",
        durationSec: MOCK_MP4_DURATION_SEC,
        engine: "mock-video",
        model: "mock-clip",
      };
    },
  };
}
