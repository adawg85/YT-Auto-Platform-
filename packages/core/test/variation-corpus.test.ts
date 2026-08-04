import { describe, expect, it } from "vitest";
import { checkVariation, VARIATION_CORPUS_STATUSES } from "../src/similarity";

/**
 * #97: the corpus rule lives in the pipeline's SQL predicate, so what is unit
 * testable here is (a) the constant that predicate uses, and (b) the fact that
 * an identical fingerprint scores 1.000 — i.e. leaving a same-idea sibling in
 * the corpus mathematically guarantees a hard-fail block.
 */
const FINGERPRINT = "lost books enoch jubilees second temple canon apocrypha dead sea scrolls";

describe("variation corpus (#97 — a production cannot be a duplicate of itself)", () => {
  it("an identical fingerprint scores a perfect 1.000 — the reported block", () => {
    const r = checkVariation(FINGERPRINT, [{ productionId: "sibling", fingerprint: FINGERPRINT }]);
    expect(r.maxSimilarity).toBe(1);
    expect(r.verdict).toBe("fail");
    // so ANY same-idea sibling left in the corpus is an automatic false positive:
    // resume_production / force_forward / corrected copies all reuse the parent's
    // substanceFingerprint verbatim.
  });

  it("names the counterparty so a block can be audited", () => {
    const r = checkVariation(FINGERPRINT, [{ productionId: "01KZ3P2512Y5M3DKCPB81XQVPN", fingerprint: FINGERPRINT }]);
    expect(r.closest?.productionId).toBe("01KZ3P2512Y5M3DKCPB81XQVPN");
  });

  it("the corpus is the CATALOGUE only — no in-flight or abandoned statuses", () => {
    const corpus = new Set<string>(VARIATION_CORPUS_STATUSES);
    // a sibling at visuals_review is what actually tripped the reported block;
    // the old predicate only excluded rejected/halted/failed/on_hold
    for (const inFlight of [
      "greenlit",
      "scripting",
      "script_review",
      "profile_review",
      "producing_assets",
      "visuals_review",
      "assembling",
      "thumbnail_review",
      "ready",
    ]) {
      expect(corpus.has(inFlight)).toBe(false);
    }
    for (const abandoned of ["halted", "retired", "on_hold", "failed", "rejected", "superseded"]) {
      expect(corpus.has(abandoned)).toBe(false);
    }
    // only what a viewer can see
    expect(corpus.has("published")).toBe(true);
    expect(corpus.has("scheduled")).toBe(true);
  });

  it("genuinely different substance still passes", () => {
    const r = checkVariation(FINGERPRINT, [
      { productionId: "other", fingerprint: "roman aqueduct engineering concrete arches water supply" },
    ]);
    expect(r.verdict).toBe("pass");
  });
});
