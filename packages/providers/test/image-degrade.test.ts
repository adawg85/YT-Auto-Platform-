import { describe, expect, it, vi } from "vitest";
import { serveImageThroughChain, PRIMARY_IMAGE_ATTEMPTS } from "../src/factory";
import type { MediaProvider } from "../src/types";

/**
 * #122 item 4: a fully-prompted hero shot was served by mock-media while 22
 * other shots of the same production served seedream normally — a transient
 * engine failure quietly absorbed into a placeholder SVG. The requested engine
 * must be RETRIED before any degrade, and a placeholder that is genuinely
 * unavoidable must come back declared (placeholder + engineErrors) rather than
 * looking like a normal image.
 */

const req = {
  prompt: "a real prompt",
  aspect: "9:16" as const,
  channelId: "c",
  productionId: "p",
  idx: 0,
};

const ok = (name: string, calls: { n: number }): MediaProvider => ({
  name,
  generateImage: async () => {
    calls.n++;
    return { storageKey: `productions/p/beat-0.png`, mimeType: "image/png" };
  },
});

const failing = (name: string, calls: { n: number }, message = "429 rate limited"): MediaProvider => ({
  name,
  generateImage: async () => {
    calls.n++;
    throw new Error(message);
  },
});

/** fails the first N calls, then succeeds — a transient blip */
const flaky = (name: string, failFirst: number, calls: { n: number }): MediaProvider => ({
  name,
  generateImage: async () => {
    calls.n++;
    if (calls.n <= failFirst) throw new Error("transient 503");
    return { storageKey: `productions/p/beat-0.png`, mimeType: "image/png" };
  },
});

const mockProvider = (calls: { n: number }): MediaProvider => ({
  name: "mock-media",
  generateImage: async () => {
    calls.n++;
    return { storageKey: "productions/p/beat-0.svg", mimeType: "image/svg+xml", placeholder: true };
  },
});

describe("#122 image degrade — retry before placeholder", () => {
  it("retries the REQUESTED engine once before degrading — a blip no longer costs the shot", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const primary = { n: 0 };
    const fb = { n: 0 };
    const mock = { n: 0 };
    const res = await serveImageThroughChain({
      chain: [flaky("seedream", 1, primary), ok("gemini", fb)],
      mock: mockProvider(mock),
      req,
      retryDelayMs: 0,
    });
    expect(res.engine).toBe("seedream"); // the operator's engine, second attempt
    expect(primary.n).toBe(2);
    expect(fb.n).toBe(0); // never degraded
    expect(mock.n).toBe(0);
    expect(res.placeholder).toBeUndefined();
  });

  it("degrades to the channel's next engine only after the retry is spent", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const primary = { n: 0 };
    const fb = { n: 0 };
    const mock = { n: 0 };
    const res = await serveImageThroughChain({
      chain: [failing("seedream", primary), ok("gemini", fb)],
      mock: mockProvider(mock),
      req,
      retryDelayMs: 0,
    });
    expect(primary.n).toBe(PRIMARY_IMAGE_ATTEMPTS);
    expect(res.engine).toBe("gemini");
    expect(mock.n).toBe(0);
    // the primary's failures ride out even on a successful fallback
    expect(res.engineErrors?.length).toBe(PRIMARY_IMAGE_ATTEMPTS);
  });

  it("an unavoidable placeholder comes back DECLARED, with every engine's reason", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const primary = { n: 0 };
    const fb = { n: 0 };
    const mock = { n: 0 };
    const res = await serveImageThroughChain({
      chain: [failing("seedream", primary, "429 rate limited"), failing("gemini", fb, "no credits")],
      mock: mockProvider(mock),
      req,
      retryDelayMs: 0,
    });
    expect(res.engine).toBe("mock-media");
    expect(res.placeholder).toBe(true);
    expect(mock.n).toBe(1);
    expect(res.engineErrors).toEqual([
      "seedream: 429 rate limited",
      "seedream: 429 rate limited",
      "gemini: no credits",
    ]);
  });

  it("full mock mode (no real engines) still serves, and still says it is a placeholder", async () => {
    const mock = { n: 0 };
    const res = await serveImageThroughChain({ chain: [], mock: mockProvider(mock), req, retryDelayMs: 0 });
    expect(res.engine).toBe("mock-media");
    expect(res.placeholder).toBe(true);
  });

  it("a healthy engine is called exactly once", async () => {
    const primary = { n: 0 };
    const mock = { n: 0 };
    const res = await serveImageThroughChain({
      chain: [ok("seedream", primary)],
      mock: mockProvider(mock),
      req,
      retryDelayMs: 0,
    });
    expect(primary.n).toBe(1);
    expect(res.engine).toBe("seedream");
    expect(res.engineErrors).toBeUndefined();
  });
});
