import { describe, expect, it } from "vitest";
import {
  classifyPublication,
  isConfirmedPhantom,
  isReconcileMismatch,
  publishedAtDrift,
  PUBLISHED_AT_DRIFT_TOLERANCE_MS,
} from "../src/reconcile";
import { publicationBlocksRepublish, resolveGoLivePublishedAt } from "../src/publish";

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
      live: { state: "found", privacyStatus: "public", publishAt: null, publishedAt: "2026-07-01T00:00:00Z", durationSec: 300, uploadStatus: "processed", processingStatus: "succeeded" },
    });
    expect(r.verdict).toBe("ok");
    expect(isReconcileMismatch(r.verdict)).toBe(false);
  });

  it("found but no processed media → shell", () => {
    const r = classifyPublication({
      providerVideoId: "abc",
      believedLive: true,
      live: { state: "found", privacyStatus: "public", publishAt: null, publishedAt: "2026-07-01T00:00:00Z", durationSec: null, uploadStatus: "uploaded", processingStatus: "processing" },
    });
    expect(r.verdict).toBe("shell");
    expect(isReconcileMismatch(r.verdict)).toBe(true);
  });

  it("platform thinks live but YouTube has it private → private_on_youtube", () => {
    const r = classifyPublication({
      providerVideoId: "abc",
      believedLive: true,
      live: { state: "found", privacyStatus: "private", publishAt: null, publishedAt: "2026-07-01T00:00:00Z", durationSec: 300, uploadStatus: "processed", processingStatus: "succeeded" },
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

describe("publishedAtDrift (ticket 01KY9C9R…)", () => {
  it("the incident: stored future slot vs real earlier go-live → drift, correct BACKWARD", () => {
    // scheduled slot stamped as publishedAt; operator actually released 6 days early
    const d = publishedAtDrift({
      storedPublishedAt: "2026-07-30T08:00:00Z",
      remotePublishedAt: "2026-07-24T06:00:00Z",
    });
    expect(d.drifted).toBe(true);
    expect(d.direction).toBe("backward"); // correction pulls the date earlier
    expect(d.deltaMs).toBeGreaterThan(0);
  });

  it("stored earlier than reality → drift, correct FORWARD", () => {
    const d = publishedAtDrift({
      storedPublishedAt: "2026-07-01T00:00:00Z",
      remotePublishedAt: "2026-07-05T00:00:00Z",
    });
    expect(d.drifted).toBe(true);
    expect(d.direction).toBe("forward");
  });

  it("sub-hour clock/format noise is NOT drift", () => {
    const d = publishedAtDrift({
      storedPublishedAt: "2026-07-24T08:00:00Z",
      remotePublishedAt: "2026-07-24T08:00:03Z", // YouTube drops millis / seconds skew
    });
    expect(d.drifted).toBe(false);
    expect(d.direction).toBe("none");
  });

  it("just over the tolerance boundary counts", () => {
    const base = Date.parse("2026-07-24T00:00:00Z");
    const d = publishedAtDrift({
      storedPublishedAt: new Date(base + PUBLISHED_AT_DRIFT_TOLERANCE_MS + 1000).toISOString(),
      remotePublishedAt: new Date(base).toISOString(),
    });
    expect(d.drifted).toBe(true);
    expect(d.direction).toBe("backward");
  });

  it("a missing date on either side → nothing to compare, not drifted", () => {
    expect(publishedAtDrift({ storedPublishedAt: null, remotePublishedAt: "2026-07-24T00:00:00Z" }).drifted).toBe(false);
    expect(publishedAtDrift({ storedPublishedAt: "2026-07-24T00:00:00Z", remotePublishedAt: null }).drifted).toBe(false);
  });
});

describe("resolveGoLivePublishedAt (ticket 01KY9C9R…)", () => {
  const now = new Date("2026-07-24T06:00:00Z");

  it("prefers YouTube's real publishedAt", () => {
    const d = resolveGoLivePublishedAt({
      remotePublishedAt: "2026-07-24T05:30:00Z",
      scheduledFor: "2026-07-30T08:00:00Z", // future slot — must be ignored
      now,
    });
    expect(d.toISOString()).toBe("2026-07-24T05:30:00.000Z");
  });

  it("never stamps a FUTURE slot when the video is already public (the bug)", () => {
    // no real date from the provider (mock), slot still 6 days out → use now, not the slot
    const d = resolveGoLivePublishedAt({ remotePublishedAt: null, scheduledFor: "2026-07-30T08:00:00Z", now });
    expect(d.getTime()).toBe(now.getTime());
  });

  it("uses a slot that has already passed when there's no real date", () => {
    const d = resolveGoLivePublishedAt({ remotePublishedAt: null, scheduledFor: "2026-07-24T05:00:00Z", now });
    expect(d.toISOString()).toBe("2026-07-24T05:00:00.000Z");
  });

  it("falls back to now when nothing else is available", () => {
    const d = resolveGoLivePublishedAt({ remotePublishedAt: null, scheduledFor: null, now });
    expect(d.getTime()).toBe(now.getTime());
  });
});
