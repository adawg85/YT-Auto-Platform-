import { describe, expect, it } from "vitest";
import { checkExternalSimilarity, checkVariation, jaccard, shingles } from "../src/similarity";

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

describe("external anti-clone check (build #4)", () => {
  const externals = [
    {
      externalId: "ext-1",
      title: "Why the sky is blue",
      transcript:
        "Nobody tells you this about the sky, but Rayleigh scattering bends short blue wavelengths across the whole atmosphere every single day.",
    },
    { externalId: "ext-2", title: "Untranscribed", transcript: null },
  ];

  it("flags a near-verbatim clone of a scouted transcript as fail", () => {
    const clone =
      "Nobody tells you this about the sky, but Rayleigh scattering bends short blue wavelengths across the whole atmosphere every single day.";
    const res = checkExternalSimilarity(clone, externals);
    expect(res.verdict).toBe("fail");
    expect(res.closest?.externalId).toBe("ext-1");
  });

  it("passes original substance that merely shares the niche", () => {
    const original =
      "Here is the odd part about sunsets: dust near the horizon scatters the remaining long red light into your eyes.";
    const res = checkExternalSimilarity(original, externals);
    expect(res.verdict).toBe("pass");
  });

  it("ignores externals with no transcript and passes on an empty corpus", () => {
    expect(checkExternalSimilarity("anything", []).maxSimilarity).toBe(0);
    expect(checkExternalSimilarity("anything", [externals[1]!]).maxSimilarity).toBe(0);
  });
});
