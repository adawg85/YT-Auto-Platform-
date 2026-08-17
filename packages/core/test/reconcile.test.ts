import { describe, expect, it } from "vitest";
import {
  classifyPublication,
  isConfirmedPhantom,
  isReconcileMismatch,
  publishedAtDrift,
  PUBLISHED_AT_DRIFT_TOLERANCE_MS,
  UPLOAD_EXPECTED_STATUSES,
  detectUnrecordedPublish,
  earlyReleaseAlarm,
  platformBelievesLive,
  scheduledSweepInScope,
  type LiveVideoStatus,
} from "../src/reconcile";

describe("UPLOAD_EXPECTED_STATUSES (#87: a stuck 'scheduled' upload must be detectable)", () => {
  it("includes scheduled (upload runs before scheduling now) and published", () => {
    // #87: a production at status 'scheduled' with no providerVideoId is a stuck/failed
    // upload — the smell test must cover it, not just 'published'.
    expect(UPLOAD_EXPECTED_STATUSES).toContain("scheduled");
    expect(UPLOAD_EXPECTED_STATUSES).toContain("published");
  });
  it("classifies a no-video-id record as an upload that never completed", () => {
    // the exact reconcile verdict get_diagnostics/reconcile surface for #87's rows
    const r = classifyPublication({ providerVideoId: null, believedLive: false, live: { state: "unknown" } });
    expect(r.verdict).toBe("no_video_id");
  });
});
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

// ── #126: the drift class the sweep could not see ────────────────────────────
//
// A Short went PUBLIC four days before its 21 Aug slot; the record stayed
// 'scheduled' and a full-platform reconcile_publications reported driftCount 0,
// because the date check only compares records already believed live (published
// + a stored publishedAt) — a 'scheduled' row has publishedAt NULL, so there was
// nothing to compare and the sweep read as an all-clear.

const publicVideo = (publishedAt: string | null): LiveVideoStatus => ({
  state: "found",
  privacyStatus: "public",
  publishAt: null,
  publishedAt,
  durationSec: 41,
  uploadStatus: "processed",
  processingStatus: "succeeded",
});

describe("detectUnrecordedPublish (#126)", () => {
  const now = new Date("2026-08-17T18:00:00Z");

  it("flags a 'scheduled' record whose video YouTube reports PUBLIC, with the day-count gap", () => {
    const found = detectUnrecordedPublish({
      productionStatus: "scheduled",
      scheduledFor: "2026-08-21T04:00:00Z",
      live: publicVideo("2026-08-17T14:22:29Z"),
      now,
    });
    expect(found).not.toBeNull();
    expect(found?.realPublishedAt).toBe("2026-08-17T14:22:29.000Z");
    expect(found?.earlyByDays).toBe(3.6); // ~4 days early — the reported incident
    expect(found?.autoFixable).toBe(true);
  });

  it("records YouTube's REAL publishedAt, never the future slot", () => {
    const found = detectUnrecordedPublish({
      productionStatus: "scheduled",
      scheduledFor: "2026-08-21T04:00:00Z",
      live: publicVideo("2026-08-17T14:22:29Z"),
      now,
    });
    // stamping the slot is what stranded analytics ingest on an empty window
    expect(new Date(found!.realPublishedAt).getTime()).toBeLessThan(
      new Date("2026-08-21T04:00:00Z").getTime(),
    );
  });

  it("stays quiet on a scheduled video that is still PRIVATE (the normal pending state)", () => {
    const found = detectUnrecordedPublish({
      productionStatus: "scheduled",
      scheduledFor: "2026-08-21T04:00:00Z",
      live: {
        state: "found",
        privacyStatus: "private",
        publishAt: "2026-08-21T04:00:00Z",
        publishedAt: null,
        durationSec: 41,
        uploadStatus: "processed",
        processingStatus: "succeeded",
      },
      now,
    });
    expect(found).toBeNull();
  });

  it("stays quiet on a record the platform already believes is live", () => {
    for (const status of ["published", "published_unverified", "analysing"]) {
      expect(
        detectUnrecordedPublish({
          productionStatus: status,
          scheduledFor: null,
          live: publicVideo("2026-08-17T14:22:29Z"),
          now,
        }),
      ).toBeNull();
      expect(platformBelievesLive(status)).toBe(true);
    }
  });

  it("stays quiet when the provider can't answer (mock mode / read error)", () => {
    expect(
      detectUnrecordedPublish({ productionStatus: "scheduled", scheduledFor: null, live: { state: "unknown" }, now }),
    ).toBeNull();
    expect(
      detectUnrecordedPublish({ productionStatus: "scheduled", scheduledFor: null, live: { state: "missing" }, now }),
    ).toBeNull();
  });

  it("flags a public video on a parked row but refuses to auto-publish it", () => {
    for (const status of ["on_hold", "failed", "retired", "superseded"]) {
      const found = detectUnrecordedPublish({
        productionStatus: status,
        scheduledFor: null,
        live: publicVideo("2026-08-17T14:22:29Z"),
        now,
      });
      expect(found?.autoFixable).toBe(false);
      expect(found?.note).toContain("sync_publication_from_youtube");
    }
  });

  it("reports no 'early' gap when the slot has already passed — that is a normal go-live never recorded", () => {
    const found = detectUnrecordedPublish({
      productionStatus: "scheduled",
      scheduledFor: "2026-08-16T04:00:00Z",
      live: publicVideo("2026-08-17T14:22:29Z"),
      now,
    });
    expect(found?.earlyByDays).toBeNull();
    expect(found?.autoFixable).toBe(true);
  });
});

describe("scheduledSweepInScope (#126 — why the record stayed 'scheduled' forever)", () => {
  it("includes a row the pipeline left privacyStatus 'private' while the production is scheduled", () => {
    // the run died between mark-scheduled (writes 'private') and
    // finalize-publication (writes 'scheduled') — the old sweep never saw it again
    expect(
      scheduledSweepInScope({
        productionStatus: "scheduled",
        privacyStatus: "private",
        providerVideoId: "5q8BkuIXOsA",
        publishedAt: null,
      }),
    ).toBe(true);
  });

  it("still includes the ordinary natively-scheduled row", () => {
    expect(
      scheduledSweepInScope({
        productionStatus: "scheduled",
        privacyStatus: "scheduled",
        providerVideoId: "5q8BkuIXOsA",
        publishedAt: null,
      }),
    ).toBe(true);
  });

  it("excludes a row with nothing to ask YouTube about, and one already recorded live", () => {
    expect(
      scheduledSweepInScope({ productionStatus: "scheduled", privacyStatus: "scheduled", providerVideoId: null, publishedAt: null }),
    ).toBe(false);
    expect(
      scheduledSweepInScope({
        productionStatus: "published",
        privacyStatus: "public",
        providerVideoId: "5q8BkuIXOsA",
        publishedAt: new Date("2026-08-17T14:22:29Z"),
      }),
    ).toBe(false);
  });
});

describe("earlyReleaseAlarm (#126 — an early release must not pass silently)", () => {
  it("alarms on a release days before its slot", () => {
    const a = earlyReleaseAlarm({
      scheduledFor: "2026-08-21T04:00:00Z",
      publishedAt: new Date("2026-08-17T14:22:29Z"),
    });
    expect(a.early).toBe(true);
    expect(a.daysEarly).toBe(3.6);
  });

  it("does not alarm on the ordinary on-slot flip (sub-hour slop)", () => {
    const a = earlyReleaseAlarm({
      scheduledFor: "2026-08-21T04:00:00Z",
      publishedAt: new Date("2026-08-21T04:00:11Z"),
    });
    expect(a.early).toBe(false);
  });

  it("does not alarm without a slot to be early against", () => {
    expect(earlyReleaseAlarm({ scheduledFor: null, publishedAt: new Date() }).early).toBe(false);
  });
});
