import { describe, it, expect } from "vitest";
import {
  isReusableLicence,
  nasaToCandidate,
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
  it("accepts public domain, CC0, CC-BY and (2026-07-12) CC-BY-SA", () => {
    // share-alike unlocked per operator decision — every licensed image is
    // credited with its licence name + source in the video description
    for (const l of [
      "Public domain",
      "PD-US",
      "CC0",
      "CC BY 2.0",
      "CC-BY-4.0",
      "CC BY 3.0",
      "CC BY-SA 2.0",
      "CC BY-SA 4.0",
      "Public domain (NASA)",
    ]) {
      expect(isReusableLicence(l)).toBe(true);
    }
  });

  it("still rejects non-commercial and no-derivatives", () => {
    for (const l of ["CC BY-NC 2.0", "CC BY-NC-SA 3.0", "CC BY-ND 4.0", "CC BY-NC-ND 4.0"]) {
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
      cand({ license: "CC BY-NC 2.0" }), // non-commercial → skip
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

describe("nasaToCandidate (#31.b multi-archive)", () => {
  it("maps a NASA search item to a PD candidate, upgrading to the ~large rendition", () => {
    const c = nasaToCandidate({
      data: [{ nasa_id: "GRC-1946-C-14617", photographer: "GRC" }],
      links: [{ href: "https://images-assets.nasa.gov/image/GRC-1946-C-14617/GRC-1946-C-14617~medium.jpg" }],
    });
    expect(c).not.toBeNull();
    expect(c!.downloadUrl.endsWith("~large.jpg")).toBe(true);
    expect(c!.pageUrl).toContain("images.nasa.gov/details/");
    expect(isReusableLicence(c!.license)).toBe(true);
    expect(c!.attribution).toBe("GRC");
  });

  it("returns null for items without an id or link", () => {
    expect(nasaToCandidate({ data: [{}], links: [] })).toBeNull();
    expect(nasaToCandidate({})).toBeNull();
  });
});
