import { describe, expect, it } from "vitest";
import {
  THUMBNAIL_BLOCKED_STATUSES,
  canAuthorThumbnail,
  isEarlyThumbnailStatus,
  shouldGeneratePipelineThumbnails,
} from "../src/thumbnail-authoring";

describe("canAuthorThumbnail — any live stage, not just gate-onward", () => {
  it("allows every in-flight stage from greenlight through assembly", () => {
    for (const status of [
      "greenlit",
      "scripting",
      "script_review",
      "profile_review",
      "voiceover_recording",
      "producing_assets",
      "visuals_review",
      "assembling",
    ]) {
      expect(canAuthorThumbnail(status).ok, status).toBe(true);
    }
  });

  it("keeps the previously-allowed gate-and-after statuses allowed", () => {
    for (const status of ["thumbnail_review", "ready", "scheduled", "published", "published_unverified", "analysing"]) {
      expect(canAuthorThumbnail(status).ok, status).toBe(true);
    }
  });

  it("allows recoverable off-ramps — a held/halted/failed production can still be resumed", () => {
    for (const status of ["on_hold", "halted", "failed"]) {
      expect(canAuthorThumbnail(status).ok, status).toBe(true);
    }
  });

  it("refuses terminal productions, with a reason naming the status and the way forward", () => {
    for (const status of ["rejected", "superseded", "retired"]) {
      const res = canAuthorThumbnail(status);
      expect(res.ok, status).toBe(false);
      if (!res.ok) {
        expect(res.reason).toContain(status);
        expect(res.reason).toContain("list_productions");
      }
    }
    expect([...THUMBNAIL_BLOCKED_STATUSES].sort()).toEqual(["rejected", "retired", "superseded"]);
  });
});

describe("isEarlyThumbnailStatus — the meta.early stamp boundary", () => {
  it("everything before the pipeline's thumbnail stage is early", () => {
    for (const status of ["greenlit", "scripting", "producing_assets", "visuals_review", "assembling", "on_hold", "halted", "failed"]) {
      expect(isEarlyThumbnailStatus(status), status).toBe(true);
    }
  });

  it("at/after the gate is NOT early — those candidates behave exactly as before", () => {
    for (const status of ["thumbnail_review", "ready", "scheduled", "published", "published_unverified", "analysing"]) {
      expect(isEarlyThumbnailStatus(status), status).toBe(false);
    }
  });
});

describe("shouldGeneratePipelineThumbnails — the step-7b reuse decision", () => {
  it("first run (no candidates) generates", () => {
    expect(shouldGeneratePipelineThumbnails([])).toBe(true);
  });

  it("only operator-early candidates → still generates and appends (early picks never suppress the spec-grounded set)", () => {
    expect(
      shouldGeneratePipelineThumbnails([
        { meta: { early: "scripting", regenerated: true } },
        { meta: { early: "producing_assets", sourced: true } },
      ]),
    ).toBe(true);
  });

  it("a pipeline candidate exists (resume/replay) → skips, so nothing double-bills", () => {
    expect(
      shouldGeneratePipelineThumbnails([
        { meta: { early: "scripting" } },
        { meta: { pipeline: true, prompt: "p" } },
      ]),
    ).toBe(false);
  });

  it("legacy rows — no early stamp at all — count as pipeline output: a replay of an old production never re-bills", () => {
    expect(shouldGeneratePipelineThumbnails([{ meta: { prompt: "p", regenerated: false } }])).toBe(false);
    expect(shouldGeneratePipelineThumbnails([{ meta: null }])).toBe(false);
    expect(shouldGeneratePipelineThumbnails([{}])).toBe(false);
  });
});
