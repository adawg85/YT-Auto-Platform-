import { describe, it, expect } from "vitest";
import {
  isReusableLicence,
  pickReusableImage,
  type WikimediaCandidate,
} from "../src/real/reference-images";

const cand = (over: Partial<WikimediaCandidate>): WikimediaCandidate => ({
  downloadUrl: "u",
  pageUrl: "p",
  license: "CC BY 2.0",
  attribution: "x",
  mime: "image/jpeg",
  width: 1600,
  ...over,
});

describe("reference image licence filter", () => {
  it("accepts public domain, CC0 and plain CC-BY", () => {
    for (const l of ["Public domain", "PD-US", "CC0", "CC BY 2.0", "CC-BY-4.0", "CC BY 3.0"]) {
      expect(isReusableLicence(l)).toBe(true);
    }
  });

  it("rejects share-alike, non-commercial and no-derivatives", () => {
    for (const l of ["CC BY-SA 2.0", "CC BY-SA 4.0", "CC BY-NC 2.0", "CC BY-NC-SA 3.0", "CC BY-ND 4.0"]) {
      expect(isReusableLicence(l)).toBe(false);
    }
  });

  it("rejects unknown / all-rights-reserved", () => {
    for (const l of ["", "All rights reserved", "GFDL", "Fair use"]) {
      expect(isReusableLicence(l)).toBe(false);
    }
  });
});

describe("pickReusableImage", () => {
  it("picks the first safe raster photo of adequate size", () => {
    const chosen = pickReusableImage([
      cand({ license: "CC BY-SA 3.0" }), // share-alike → skip
      cand({ mime: "image/svg+xml" }), // diagram → skip
      cand({ width: 120 }), // icon → skip
      cand({ downloadUrl: "good", license: "Public domain" }), // ✓
      cand({ downloadUrl: "later" }),
    ]);
    expect(chosen?.downloadUrl).toBe("good");
  });

  it("returns null when nothing qualifies", () => {
    expect(
      pickReusableImage([cand({ license: "CC BY-NC 2.0" }), cand({ mime: "image/gif" })]),
    ).toBeNull();
  });
});
