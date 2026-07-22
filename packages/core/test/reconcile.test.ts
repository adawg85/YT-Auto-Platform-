import { describe, expect, it } from "vitest";
import { classifyPublication, isConfirmedPhantom, isReconcileMismatch } from "../src/reconcile";
import { publicationBlocksRepublish } from "../src/publish";

describe("classifyPublication (ticket 01KY1VFP…)", () => {
  it("no video id → record for an upload that never completed", () => {
    const r = classifyPublication({ providerVideoId: null, believedLive: true, live: { state: "unknown" } });
    expect(r.verdict).toBe("no_video_id");
    expect(isReconcileMismatch(r.verdict)).toBe(true);
  });

  it("id set but YouTube has no such video → missing (deleted duplicate)", () => {
    const r = classifyPublication({ providerVideoId: "abc", believedLive: true, live: { state: "missing" } });
    expect(r.verdict).toBe("missing_on_youtube");
    expect(isReconcileMismatch(r.verdict)).toBe(true);
  });

  it("found + processed + public → ok", () => {
    const r = classifyPublication({
      providerVideoId: "abc",
      believedLive: true,
      live: { state: "found", privacyStatus: "public", publishAt: null, durationSec: 300, uploadStatus: "processed", processingStatus: "succeeded" },
    });
    expect(r.verdict).toBe("ok");
    expect(isReconcileMismatch(r.verdict)).toBe(false);
  });

  it("found but no processed media → shell", () => {
    const r = classifyPublication({
      providerVideoId: "abc",
      believedLive: true,
      live: { state: "found", privacyStatus: "public", publishAt: null, durationSec: null, uploadStatus: "uploaded", processingStatus: "processing" },
    });
    expect(r.verdict).toBe("shell");
    expect(isReconcileMismatch(r.verdict)).toBe(true);
  });

  it("platform thinks live but YouTube has it private → private_on_youtube", () => {
    const r = classifyPublication({
      providerVideoId: "abc",
      believedLive: true,
      live: { state: "found", privacyStatus: "private", publishAt: null, durationSec: 300, uploadStatus: "processed", processingStatus: "succeeded" },
    });
    expect(r.verdict).toBe("private_on_youtube");
    expect(isReconcileMismatch(r.verdict)).toBe(true);
  });

  it("provider unknown → not counted as a mismatch (can't confirm)", () => {
    const r = classifyPublication({ providerVideoId: "abc", believedLive: true, live: { state: "unknown" } });
    expect(r.verdict).toBe("unknown");
    expect(isReconcileMismatch(r.verdict)).toBe(false);
  });
});

describe("phantom cleanup + guard (ticket 01KY4VVP… / #37)", () => {
  it("isConfirmedPhantom: only positive-evidence verdicts, never unknown/private/ok", () => {
    expect(isConfirmedPhantom("no_video_id")).toBe(true);
    expect(isConfirmedPhantom("missing_on_youtube")).toBe(true); // the Bell X-1 case
    expect(isConfirmedPhantom("shell")).toBe(true);
    // NOT phantoms — must never be auto-cleaned:
    expect(isConfirmedPhantom("unknown")).toBe(false); // mock always returns this
    expect(isConfirmedPhantom("private_on_youtube")).toBe(false); // a real, live video
    expect(isConfirmedPhantom("ok")).toBe(false);
  });

  it("duplicate-publish guard ignores a phantom (published_unverified) but honours a live one", () => {
    // the two Bell X-1 phantoms once cleaned → published_unverified → must NOT block
    expect(publicationBlocksRepublish("published_unverified", "jreAKQCsl68")).toBe(false);
    // a genuine live published video still blocks a second upload for the idea
    expect(publicationBlocksRepublish("published", "realVid123")).toBe(true);
    // no id → nothing to block on
    expect(publicationBlocksRepublish("published", null)).toBe(false);
  });
});
