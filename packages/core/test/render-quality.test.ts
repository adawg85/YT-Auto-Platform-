/**
 * Render CRF resolution (2026-08-05).
 *
 * A bad value here is expensive in both directions: too low and masters go back
 * to 2GB+ and OOM the worker on upload; too high and every future episode ships
 * with visible artefacts that cannot be undone without a re-render. So the
 * contract is that garbage input falls back to the known-good default rather
 * than being coerced into something surprising.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_RENDER_CRF, REMOTION_DEFAULT_CRF, resolveRenderCrf } from "../src/render-quality";

describe("resolveRenderCrf", () => {
  it("defaults to a real size cut below Remotion's near-lossless default", () => {
    expect(resolveRenderCrf({})).toBe(DEFAULT_RENDER_CRF);
    expect(DEFAULT_RENDER_CRF).toBeGreaterThan(REMOTION_DEFAULT_CRF);
  });

  it("honours a valid override", () => {
    expect(resolveRenderCrf({ REMOTION_CRF: "20" })).toBe(20);
    expect(resolveRenderCrf({ REMOTION_CRF: " 26 " })).toBe(26);
    // the escape hatch back to the old behaviour
    expect(resolveRenderCrf({ REMOTION_CRF: "18" })).toBe(18);
  });

  it("accepts the range boundaries", () => {
    expect(resolveRenderCrf({ REMOTION_CRF: "1" })).toBe(1);
    expect(resolveRenderCrf({ REMOTION_CRF: "51" })).toBe(51);
  });

  it("falls back rather than throwing or clamping on nonsense", () => {
    for (const bad of ["", "   ", "abc", "23.5", "-4", "0", "52", "999", "NaN", "1e2"]) {
      expect(resolveRenderCrf({ REMOTION_CRF: bad }), bad).toBe(DEFAULT_RENDER_CRF);
    }
    expect(resolveRenderCrf({ REMOTION_CRF: undefined })).toBe(DEFAULT_RENDER_CRF);
  });

  it("never returns a value outside h264's valid range", () => {
    for (const v of ["-1", "0", "52", "100", "abc", "30"]) {
      const crf = resolveRenderCrf({ REMOTION_CRF: v });
      expect(crf).toBeGreaterThanOrEqual(1);
      expect(crf).toBeLessThanOrEqual(51);
    }
  });
});
