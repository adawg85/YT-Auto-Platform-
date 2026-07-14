import { describe, expect, it } from "vitest";
import { imageEngineFor } from "../src/production-profile";

describe("imageEngineFor", () => {
  it("default/fal → fal for every tier", () => {
    expect(imageEngineFor({}, "standard")).toBe("fal");
    expect(imageEngineFor({ imageEngine: "fal" }, "hero")).toBe("fal");
  });

  it("nano-banana → everything Google-direct", () => {
    expect(imageEngineFor({ imageEngine: "nano-banana" }, "standard")).toBe("nano-banana");
    expect(imageEngineFor({ imageEngine: "nano-banana" }, "hero")).toBe("nano-banana");
  });

  it("mixed → Flux bulk, nano hero", () => {
    expect(imageEngineFor({ imageEngine: "mixed" }, "standard")).toBe("fal");
    expect(imageEngineFor({ imageEngine: "mixed" }, "hero")).toBe("nano-banana");
  });

  it("qwen (fal-free tier) → Qwen bulk, hero stays pinned to nano", () => {
    expect(imageEngineFor({ imageEngine: "qwen" }, "standard")).toBe("qwen");
    expect(imageEngineFor({ imageEngine: "qwen" })).toBe("qwen");
    expect(imageEngineFor({ imageEngine: "qwen" }, "hero")).toBe("nano-banana");
  });
});
