import { describe, expect, it } from "vitest";
import {
  HALT_KINDS,
  haltPolicy,
  haltIsAutoRetryable,
  productionBlock,
  resolveAuthoringIntents,
  describeThumbnailApplyError,
} from "../src/halt";
import { gateRequired } from "../src/production-profile";

const NOW = new Date("2026-08-04T12:00:00Z");
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

describe("halt taxonomy (P1) — 19 free-text exits become 5 typed classes", () => {
  it("every kind carries a summary and a recovery verb", () => {
    for (const kind of HALT_KINDS) {
      const p = haltPolicy(kind);
      expect(p.kind).toBe(kind);
      expect(p.summary.length).toBeGreaterThan(20);
      expect(p.recommendedAction.length).toBeGreaterThan(20);
    }
  });

  it("ONLY the external/transient class may be retried by a machine", () => {
    expect(haltIsAutoRetryable("external_retryable")).toBe(true);
    for (const kind of HALT_KINDS.filter((k) => k !== "external_retryable")) {
      expect(haltIsAutoRetryable(kind)).toBe(false);
    }
  });

  it("an unknown or legacy null kind degrades to the conservative class", () => {
    // rows halted before the taxonomy shipped must never look auto-retryable
    for (const bad of [null, undefined, "", "nonsense"]) {
      expect(haltPolicy(bad).kind).toBe("precondition");
      expect(haltIsAutoRetryable(bad)).toBe(false);
    }
  });

  it("the compliance verb warns that force_forward WAIVES the control", () => {
    expect(haltPolicy("compliance_block").recommendedAction).toMatch(/waive/i);
  });
});

describe("productionBlock (P5) — one health object", () => {
  it("returns null for a healthy production, at every live status", () => {
    for (const status of ["greenlit", "producing_assets", "visuals_review", "ready", "published"]) {
      expect(productionBlock({ status }, NOW)).toBeNull();
    }
  });

  it("names the class, the action and the age for a halted production", () => {
    const b = productionBlock(
      {
        status: "on_hold",
        haltKind: "external_retryable",
        failureReason: "YouTube quota exhausted across multiple windows",
        updatedAt: minsAgo(90),
      },
      NOW,
    );
    expect(b).toMatchObject({ kind: "external_retryable", canAutoRetry: true, stuckForMinutes: 90 });
    expect(b!.reason).toContain("quota");
  });

  it("a human rejection and a quota exhaustion are no longer the same thing", () => {
    // the whole point: both were `on_hold` + prose before this
    const human = productionBlock(
      { status: "on_hold", haltKind: "human_decision", failureReason: "visuals rejected at review" },
      NOW,
    );
    const quota = productionBlock(
      { status: "on_hold", haltKind: "external_retryable", failureReason: "quota exhausted" },
      NOW,
    );
    expect(human!.kind).not.toBe(quota!.kind);
    expect(human!.canAutoRetry).toBe(false);
    expect(quota!.canAutoRetry).toBe(true);
    expect(human!.recommendedAction).not.toBe(quota!.recommendedAction);
  });

  it("maps the two statuses that carry no haltKind of their own", () => {
    // `rejected` is a human's final no; `failed` is retries-exhausted
    expect(productionBlock({ status: "rejected" }, NOW)!.kind).toBe("human_decision");
    expect(productionBlock({ status: "failed" }, NOW)!.kind).toBe("external_retryable");
  });

  it("a pre-taxonomy row (null kind) still produces a usable, safe object", () => {
    const b = productionBlock({ status: "on_hold", haltKind: null, failureReason: "something old" }, NOW);
    expect(b!.kind).toBe("precondition");
    expect(b!.canAutoRetry).toBe(false);
  });
});

describe("resolveAuthoringIntents (P6) — one flag became three intentions", () => {
  it("a legacy row inherits all three from externalScript, unchanged", () => {
    expect(resolveAuthoringIntents({ externalScript: true })).toEqual({
      scriptAuthored: true,
      promptsAuthored: true,
      motionAuthored: true,
    });
    expect(resolveAuthoringIntents({ externalScript: false })).toEqual({
      scriptAuthored: false,
      promptsAuthored: false,
      motionAuthored: false,
    });
  });

  it("a PARTIAL authoring pass is now expressible — your script, the platform's prompts", () => {
    expect(
      resolveAuthoringIntents({
        externalScript: true,
        promptsAuthored: false,
        motionAuthored: false,
      }),
    ).toEqual({ scriptAuthored: true, promptsAuthored: false, motionAuthored: false });
  });

  it("an explicit intent overrides the legacy flag in both directions", () => {
    expect(resolveAuthoringIntents({ externalScript: false, promptsAuthored: true }).promptsAuthored).toBe(true);
    expect(resolveAuthoringIntents({ externalScript: true, scriptAuthored: false }).scriptAuthored).toBe(false);
  });

  it("#94's failure mode: dropping the flag can no longer half-un-author a row", () => {
    // the copy boundary now carries a struct; every field is explicit
    const carried = resolveAuthoringIntents({ externalScript: true });
    const copied = resolveAuthoringIntents({ externalScript: false, ...carried });
    expect(copied).toEqual(carried);
  });
});

describe("describeThumbnailApplyError (#100) — don't blame YouTube for our own crash", () => {
  it("classifies sharp's native-binary failure as LOCAL, before upload", () => {
    // the exact shape the operator saw in the cockpit panel
    const msg = describeThumbnailApplyError(
      new Error("Could not load sharp using the linux-x64 runtime. Possible solutions: ..."),
    );
    expect(msg).toMatch(/BEFORE upload/);
    expect(msg).toMatch(/YouTube was never called/);
    // and it must NOT send the operator hunting through image dimensions
    expect(msg).not.toMatch(/YouTube rejected/);
    expect(msg).toMatch(/deploy\/runtime problem/);
  });

  it("catches the other native-module shapes too", () => {
    for (const m of [
      "Cannot find module 'sharp'",
      "MODULE_NOT_FOUND",
      "dlopen failed: sharp-linux-x64.node",
      "libvips missing",
    ]) {
      expect(describeThumbnailApplyError(new Error(m))).toMatch(/BEFORE upload/);
    }
  });

  it("still reports a genuine YouTube rejection as one, with the scope hint", () => {
    const msg = describeThumbnailApplyError(new Error("403 Forbidden: insufficient permissions"));
    expect(msg).toMatch(/YouTube rejected the thumbnail/);
    expect(msg).toMatch(/thumbnails\.set/);
    expect(msg).not.toMatch(/BEFORE upload/);
  });

  it("handles a non-Error throw without losing the reason", () => {
    expect(describeThumbnailApplyError("plain string failure")).toContain("plain string failure");
  });
});

describe("gateRequired (#102) — gate placement is separate from who authored it", () => {
  it("THE CASE: an authored script still stops when the channel names script_review", () => {
    // scriptAuthored used to mean "no human reviews it" — the conflation
    expect(
      gateRequired({
        gate: "script_review",
        impliedByDefault: false, // author_script would have skipped it
        declared: ["script_review"],
      }),
    ).toBe(true);
  });

  it("declaring gates can only ADD — it never removes one the tier implies", () => {
    // a T0/T1 channel declaring only script_review must still get its visuals gate
    expect(
      gateRequired({ gate: "visuals_review", impliedByDefault: true, declared: ["script_review"] }),
    ).toBe(true);
  });

  it("removal stays with the audited waiver, not with this axis", () => {
    expect(
      gateRequired({
        gate: "visuals_review",
        impliedByDefault: true,
        declared: ["visuals_review"],
        waived: true, // autoApproveVisuals / force_forward
      }),
    ).toBe(false);
  });

  it("omitting the field preserves today's behaviour exactly", () => {
    for (const implied of [true, false]) {
      expect(gateRequired({ gate: "thumbnail_review", impliedByDefault: implied })).toBe(implied);
      expect(
        gateRequired({ gate: "thumbnail_review", impliedByDefault: implied, declared: null }),
      ).toBe(implied);
    }
  });

  it("an unrelated declared gate doesn't add this one", () => {
    expect(
      gateRequired({ gate: "profile_review", impliedByDefault: false, declared: ["script_review"] }),
    ).toBe(false);
  });
});
