import { describe, expect, it } from "vitest";
import { buildSeoTags } from "../src/seo-tags";

describe("buildSeoTags (ticket 01KY1TQTWZ…)", () => {
  it("strips punctuation — no colon-bearing tokens", () => {
    const tags = buildSeoTags("Breaking the Sound Barrier: The Bell X-1 and Chuck Yeager");
    expect(tags.some((t) => t.includes(":"))).toBe(false);
    expect(tags.some((t) => t === "barrier:")).toBe(false);
  });

  it("produces multi-word phrases, not just single words", () => {
    const tags = buildSeoTags("Breaking the Sound Barrier: The Bell X-1 and Chuck Yeager");
    expect(tags).toContain("sound barrier");
    expect(tags.some((t) => t.includes(" "))).toBe(true);
  });

  it("keeps hyphenated model names", () => {
    const tags = buildSeoTags("The Bell X-1 and Chuck Yeager");
    expect(tags.some((t) => t.includes("x-1"))).toBe(true);
  });

  it("adds the channel niche as a tag", () => {
    const tags = buildSeoTags("The Secret Race for the Jet Engine: Whittle vs. von Ohain", {
      niche: "aviation history",
    });
    expect(tags).toContain("aviation history");
    expect(tags.some((t) => t === "engine:")).toBe(false);
  });

  it("respects YouTube's 500-char total tag budget", () => {
    const long = "Supermarine Spitfire Hawker Hurricane Messerschmitt Focke Wulf Mustang Thunderbolt Lightning Corsair Hellcat Zero";
    const tags = buildSeoTags(long, { niche: "military aviation history documentary" });
    const total = tags.join(",").length;
    expect(total).toBeLessThanOrEqual(500);
    expect(tags.length).toBeLessThanOrEqual(15);
  });

  it("dedupes and lowercases", () => {
    const tags = buildSeoTags("Jet Engine JET engine");
    const lc = new Set(tags);
    expect(lc.size).toBe(tags.length);
    expect(tags.every((t) => t === t.toLowerCase())).toBe(true);
  });
});
