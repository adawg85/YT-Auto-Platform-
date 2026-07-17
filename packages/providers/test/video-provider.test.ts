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

  it("image last-resort is a REAL engine when a key exists, else mock (fal removed)", () => {
    // DashScope key → qwen is the real last-resort (name reflects it, not mock)
    const withKey = createProviders(sink, env({ DASHSCOPE_API_KEY: "x" }));
    expect(withKey.media.name).toBe("qwen-image");
    // no media keys at all → full mock mode
    const withoutKey = createProviders(sink, env({}));
    expect(withoutKey.media.name).toBe("mock-media");
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

import { seedanceDuration } from "../src/real/video-seedance";

describe("seedanceDuration (snap UP to cover the beat; 5/10 only)", () => {
  // wantSec is the caller's beatLen + ~0.4 buffer
  it("a ~5s beat uses a 5s clip (≤0.2s hold, invisible)", () => {
    expect(seedanceDuration(5.4, "5,10")).toBe(5); // beat ~5.0
    expect(seedanceDuration(5.6, "5,10")).toBe(5); // beat ~5.2
  });
  it("a beat clearly over 5s snaps up to a covering 10s clip — no freeze", () => {
    expect(seedanceDuration(5.8, "5,10")).toBe(10); // beat ~5.4
    expect(seedanceDuration(6.4, "5,10")).toBe(10); // beat ~6.0
    expect(seedanceDuration(7.4, "5,10")).toBe(10); // beat ~7.0
  });
  it("never returns a disallowed value like 6 or 7", () => {
    for (let w = 3; w <= 11; w += 0.25) {
      expect([5, 10]).toContain(seedanceDuration(w, "5,10"));
    }
  });
  it("beats beyond the longest clip fall back to the longest", () => {
    expect(seedanceDuration(12, "5,10")).toBe(10);
  });
  it("honours a widened allowed set", () => {
    expect(seedanceDuration(6.4, "4,5,6,8,10,12,15")).toBe(6); // beat ~6.0 → exact 6s
    expect(seedanceDuration(7.4, "4,5,6,8,10,12,15")).toBe(8); // beat ~7.0 → 8s covers
  });
});
