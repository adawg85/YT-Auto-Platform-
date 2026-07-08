import { describe, it, expect } from "vitest";
import { isReusableLicence } from "../src/real/reference-images";

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
