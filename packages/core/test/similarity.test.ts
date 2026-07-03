import { describe, expect, it } from "vitest";
import { checkVariation, jaccard, shingles } from "../src/similarity";

describe("variation check", () => {
  it("identical fingerprints hard-fail", () => {
    const fp = "airplane windows | square windows tore planes apart | comet crashes 1954";
    const res = checkVariation(fp, [{ productionId: "p1", fingerprint: fp }]);
    expect(res.verdict).toBe("fail");
    expect(res.maxSimilarity).toBe(1);
    expect(res.closest?.productionId).toBe("p1");
  });

  it("unrelated fingerprints pass", () => {
    const res = checkVariation(
      "mpemba effect | hot water freezes faster | evaporation convection supercooling",
      [
        {
          productionId: "p1",
          fingerprint: "shower curtain | pressure vortex pulls curtain inward | bernoulli effect bathroom",
        },
      ],
    );
    expect(res.verdict).toBe("pass");
  });

  it("no priors passes with similarity 0", () => {
    const res = checkVariation("anything at all here", []);
    expect(res.verdict).toBe("pass");
    expect(res.maxSimilarity).toBe(0);
  });

  it("jaccard/shingles are normalization-insensitive", () => {
    const a = shingles("The Quick, Brown Fox! jumps");
    const b = shingles("the quick brown fox jumps");
    expect(jaccard(a, b)).toBe(1);
  });
});
