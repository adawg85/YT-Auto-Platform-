import { describe, expect, it } from "vitest";
import { createProviders } from "../src/factory";
import type { CostSink } from "@ytauto/core";

const sink: CostSink = { record: async () => {} };

const env = (extra: Record<string, string>) =>
  ({ STORE_DIR: `./data/test-store-video`, ...extra }) as NodeJS.ProcessEnv;

describe("video provider selection", () => {
  it("forced mock → mock-video", () => {
    const p = createProviders(sink, env({ PROVIDERS_FORCE_MOCK: "1", DASHSCOPE_API_KEY: "x" }));
    expect(p.video.name).toBe("mock-video");
  });

  it("keyless → mock-video", () => {
    const p = createProviders(sink, env({}));
    expect(p.video.name).toBe("mock-video");
  });

  it("DASHSCOPE_API_KEY → wan base; MINIMAX_API_KEY alone → minimax base", () => {
    expect(createProviders(sink, env({ DASHSCOPE_API_KEY: "x" })).video.name).toBe("wan");
    expect(createProviders(sink, env({ MINIMAX_API_KEY: "y" })).video.name).toBe("minimax");
    // both keys → wan preferred as base (engine field dispatches per call)
    expect(createProviders(sink, env({ DASHSCOPE_API_KEY: "x", MINIMAX_API_KEY: "y" })).video.name).toBe("wan");
  });

  it("mock emits a real mp4 (ftyp header) sized for the trim path", async () => {
    const p = createProviders(sink, env({ PROVIDERS_FORCE_MOCK: "1" }));
    const res = await p.video.generateClip({
      prompt: "test motion",
      durationSec: 5,
      aspect: "9:16",
      channelId: "ch",
      productionId: "prod",
      idx: 0,
    });
    expect(res.mimeType).toBe("video/mp4");
    expect(res.durationSec).toBeGreaterThanOrEqual(10); // fixture covers max beat length
    const buf = await p.store.getBuffer(res.storageKey);
    // ISO BMFF: bytes 4-8 spell "ftyp"
    expect(buf.subarray(4, 8).toString("ascii")).toBe("ftyp");
    expect(buf.length).toBeGreaterThan(5_000);
  });
});
