import { describe, expect, it } from "vitest";
import {
  activeGatesOnly,
  GATE_DEAD_PRODUCTION_STATUSES,
  productionIsGateDead,
  productionStatusPatch,
} from "../src/gate-lifecycle";

// Every review-gate kind (mirrors the gate_kind enum in the schema).
const GATE_KINDS = [
  "script_review",
  "profile_review",
  "voiceover_recording",
  "visuals_review",
  "thumbnail_review",
] as const;

const DEAD = ["rejected", "failed", "halted", "superseded", "retired"] as const;
const ALIVE = ["script_review", "producing_assets", "thumbnail_review", "scheduled", "published"] as const;

describe("gate lifecycle — no gate outlives its production", () => {
  it("marks every terminal production status as gate-dead", () => {
    for (const s of DEAD) expect(productionIsGateDead(s)).toBe(true);
    for (const s of ALIVE) expect(productionIsGateDead(s)).toBe(false);
  });

  it("the dead-status set matches the ticket (retired is included)", () => {
    expect([...GATE_DEAD_PRODUCTION_STATUSES].sort()).toEqual([...DEAD].sort());
  });

  // The core of the ticket: a pending gate of ANY kind on a dead production is
  // filtered out of the review queue; the same gate on a live one is kept.
  it("filters a pending gate of each kind when its production is dead", () => {
    for (const kind of GATE_KINDS) {
      for (const deadStatus of DEAD) {
        const rows = [
          { gateId: `g-${kind}-dead`, kind, productionStatus: deadStatus },
          { gateId: `g-${kind}-live`, kind, productionStatus: "producing_assets" },
        ];
        const kept = activeGatesOnly(rows);
        expect(kept.map((r) => r.gateId)).toEqual([`g-${kind}-live`]);
      }
    }
  });

  it("keeps every gate when all productions are active", () => {
    const rows = GATE_KINDS.map((kind) => ({ gateId: kind, kind, productionStatus: "producing_assets" }));
    expect(activeGatesOnly(rows)).toHaveLength(GATE_KINDS.length);
  });

  it("the exact reported orphan (retired production, thumbnail gate) is filtered", () => {
    const rows = [{ gateId: "01KXWVF4DSA1AM2NGMTXBNA6EJ", kind: "thumbnail_review", productionStatus: "retired" }];
    expect(activeGatesOnly(rows)).toEqual([]);
  });
});

describe("productionStatusPatch (#81: failureReason follows status)", () => {
  it("a forward/success transition with no reason CLEARS a stale failureReason", () => {
    // the exact regression: on_hold + "gate timed out" → publish must not carry it
    expect(productionStatusPatch("published")).toEqual({ status: "published", failureReason: null });
    expect(productionStatusPatch("scheduled")).toEqual({ status: "scheduled", failureReason: null });
    expect(productionStatusPatch("producing_assets")).toEqual({
      status: "producing_assets",
      failureReason: null,
    });
  });

  it("an off-ramp transition carries the supplied reason", () => {
    expect(productionStatusPatch("on_hold", "visuals_review gate timed out")).toEqual({
      status: "on_hold",
      failureReason: "visuals_review gate timed out",
    });
  });

  it("an explicit null/empty reason clears it too", () => {
    expect(productionStatusPatch("published", null).failureReason).toBeNull();
    expect(productionStatusPatch("published", undefined).failureReason).toBeNull();
    // empty string is falsy → cleared, so no zero-length reason ever persists
    expect(productionStatusPatch("published", "").failureReason).toBeNull();
  });

  it("preserves the literal status type it was given", () => {
    const patch = productionStatusPatch("published");
    // compile-time: patch.status is "published"; runtime check mirrors it
    expect(patch.status).toBe("published");
  });
});
