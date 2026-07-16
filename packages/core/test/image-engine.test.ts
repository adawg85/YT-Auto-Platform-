import { describe, expect, it } from "vitest";
import { imageEngineFor } from "../src/production-profile";

describe("imageEngineFor (fal retired 2026-07-14)", () => {
  it("never returns fal — default is Qwen bulk with hero pinned to nano", () => {
    expect(imageEngineFor({}, "standard")).toBe("qwen");
    expect(imageEngineFor({})).toBe("qwen");
    expect(imageEngineFor({}, "hero")).toBe("nano-banana");
  });

  it("legacy stored fal/mixed values (from DB jsonb) resolve to the qwen default", () => {
    // fal removed 2026-07-16 — old rows may still hold "fal"/"mixed" strings
    const legacy = (v: string) => ({ imageEngine: v }) as unknown as Parameters<typeof imageEngineFor>[0];
    expect(imageEngineFor(legacy("fal"), "standard")).toBe("qwen");
    expect(imageEngineFor(legacy("fal"), "hero")).toBe("nano-banana");
    expect(imageEngineFor(legacy("mixed"), "standard")).toBe("qwen");
    expect(imageEngineFor(legacy("mixed"), "hero")).toBe("nano-banana");
  });

  it("nano-banana → everything Google-direct", () => {
    expect(imageEngineFor({ imageEngine: "nano-banana" }, "standard")).toBe("nano-banana");
    expect(imageEngineFor({ imageEngine: "nano-banana" }, "hero")).toBe("nano-banana");
  });

  it("qwen → Qwen bulk, hero stays pinned to nano", () => {
    expect(imageEngineFor({ imageEngine: "qwen" }, "standard")).toBe("qwen");
    expect(imageEngineFor({ imageEngine: "qwen" }, "hero")).toBe("nano-banana");
  });

  it("seedream → Seedream bulk, hero stays pinned to nano", () => {
    expect(imageEngineFor({ imageEngine: "seedream" }, "standard")).toBe("seedream");
    expect(imageEngineFor({ imageEngine: "seedream" })).toBe("seedream");
    expect(imageEngineFor({ imageEngine: "seedream" }, "hero")).toBe("nano-banana");
  });
});
