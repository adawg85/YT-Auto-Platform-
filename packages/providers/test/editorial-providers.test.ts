/**
 * Build #5 provider tests: deterministic mock embeddings (real cosine
 * behavior) and mock source connectors (cross-domain corroboration invariant
 * the tiered-accuracy verifier depends on).
 */
import { describe, expect, it } from "vitest";
import { createMockEmbeddingProvider, mockEmbed, EMBEDDING_DIMENSIONS } from "../src/mock/embedding";
import {
  createMockSourceConnectors,
  mockSharedFacts,
  mockSingleDomainFact,
  MOCK_SOURCE_DOMAINS,
} from "../src/mock/sources";

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot; // vectors are L2-normalized
}

describe("mock EmbeddingProvider", () => {
  it("is deterministic with the right dimensions and unit norm", async () => {
    const provider = createMockEmbeddingProvider();
    expect(provider.dimensions).toBe(EMBEDDING_DIMENSIONS);
    const [a] = await provider.embed(["The Concorde entered service in 1976."]);
    const [b] = await provider.embed(["The Concorde entered service in 1976."]);
    expect(a).toEqual(b);
    expect(a!.length).toBe(EMBEDDING_DIMENSIONS);
    const norm = Math.sqrt(a!.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it("puts shared-vocabulary texts cosine-closer than unrelated ones", () => {
    const query = mockEmbed("when did the concorde enter service");
    const related = mockEmbed("The concorde entered service in 1976 after testing.");
    const unrelated = mockEmbed("Recipes for sourdough bread require patient fermentation.");
    expect(cosine(query, related)).toBeGreaterThan(cosine(query, unrelated));
  });

  it("handles empty/degenerate input without NaN", () => {
    const v = mockEmbed("");
    expect(v.length).toBe(EMBEDDING_DIMENSIONS);
    expect(v.every((x) => Number.isFinite(x))).toBe(true);
  });
});

describe("mock SourceConnectors", () => {
  const sources = createMockSourceConnectors();

  it("is deterministic for the same config", async () => {
    const a = await sources.web.fetchItems({ url: `https://${MOCK_SOURCE_DOMAINS[0]}/concorde` });
    const b = await sources.web.fetchItems({ url: `https://${MOCK_SOURCE_DOMAINS[0]}/concorde` });
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it("corroborates the shared facts across BOTH mock domains (the >=2-source path)", async () => {
    const [first] = await sources.web.fetchItems({
      url: `https://${MOCK_SOURCE_DOMAINS[0]}/concorde`,
    });
    const [second] = await sources.web.fetchItems({
      url: `https://${MOCK_SOURCE_DOMAINS[1]}/concorde`,
    });
    for (const fact of mockSharedFacts("concorde")) {
      expect(first!.content).toContain(fact);
      expect(second!.content).toContain(fact);
    }
  });

  it("keeps the single-domain fact on only the first domain (the cut path)", async () => {
    const [first] = await sources.web.fetchItems({
      url: `https://${MOCK_SOURCE_DOMAINS[0]}/concorde`,
    });
    const [second] = await sources.web.fetchItems({
      url: `https://${MOCK_SOURCE_DOMAINS[1]}/concorde`,
    });
    const lonely = mockSingleDomainFact("concorde");
    expect(first!.content).toContain(lonely);
    expect(second!.content).not.toContain(lonely);
  });

  it("throws on a 'broken' URL so the engine's error tracking is exercisable", async () => {
    await expect(
      sources.web.fetchItems({ url: "https://mock-archive.example/broken-page" }),
    ).rejects.toThrow(/mock web fetch failed/);
  });

  it("rss returns multiple entries; youtube answers a query", async () => {
    const rss = await sources.rss.fetchItems({ url: `https://${MOCK_SOURCE_DOMAINS[0]}/concorde` });
    expect(rss.length).toBe(2);
    const yt = await sources.youtube.fetchItems({}, { query: "aviation history" });
    expect(yt.length).toBeGreaterThan(0);
    expect(yt[0]!.url).toContain("youtube.com");
  });
});
