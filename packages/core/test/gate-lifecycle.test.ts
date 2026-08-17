import { describe, expect, it } from "vitest";
import {
  activeGatesOnly,
  dedupePendingGates,
  gateTimeoutApplies,
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

// ── #127: exactly ONE pending gate per production ────────────────────────────
//
// Two reopen_stage calls on the same stage, 21s apart (the second being the
// remedy #125's assemblyWarning recommends for the first), left TWO pending
// voiceover_recording gates on one production and the booth rendered the video
// twice with its own Approve/Revise/Reject on each. Expiring gates at reopen
// time cannot fix it: the first reopen's run had not created its gate yet.

describe("dedupePendingGates (#127 read path)", () => {
  const gate = (gateId: string, productionId: string, kind: string) => ({ gateId, productionId, kind });

  it("keeps only the FIRST (newest — rows arrive newest-first) gate per production+kind", () => {
    // the reported pair: same production, same kind, 19 seconds apart
    const rows = [
      gate("01M0814459WSMRRMTX8X38GM60", "01KZZPGB80J21ZMBFPWDBE4BT9", "voiceover_recording"),
      gate("01M0813HWMRRDCJ073BGTSFRPM", "01KZZPGB80J21ZMBFPWDBE4BT9", "voiceover_recording"),
    ];
    expect(dedupePendingGates(rows).map((r) => r.gateId)).toEqual(["01M0814459WSMRRMTX8X38GM60"]);
  });

  it("never merges different productions or different kinds", () => {
    const rows = [
      gate("g1", "p1", "voiceover_recording"),
      gate("g2", "p2", "voiceover_recording"),
      gate("g3", "p1", "visuals_review"),
    ];
    expect(dedupePendingGates(rows)).toHaveLength(3);
  });

  it("is a no-op on an already-clean queue", () => {
    const rows = GATE_KINDS.map((k, i) => gate(`g${i}`, `p${i}`, k));
    expect(dedupePendingGates(rows)).toEqual(rows);
  });
});

describe("gateTimeoutApplies (#127 — a superseded run must not clobber the production)", () => {
  it("applies when the production is still parked at this gate", () => {
    expect(
      gateTimeoutApplies({
        productionStatus: "voiceover_recording",
        stillAt: "voiceover_recording",
        currentGateId: "gateA",
        gateId: "gateA",
      }),
    ).toBe(true);
  });

  it("does NOT apply when this gate was superseded by a newer one", () => {
    // run A parks on gateA; a second reopen mints gateB and supersedes gateA.
    // Seven days later run A's wait times out — it must not drag a production
    // that has moved on under gateB to on_hold (the migration-0080 class of bug).
    expect(
      gateTimeoutApplies({
        productionStatus: "voiceover_recording",
        stillAt: "voiceover_recording",
        currentGateId: "gateB",
        gateId: "gateA",
      }),
    ).toBe(false);
  });

  it("does NOT apply once the production has moved on (the pre-existing guard)", () => {
    expect(
      gateTimeoutApplies({
        productionStatus: "published",
        stillAt: "thumbnail_review",
        currentGateId: null,
        gateId: "gateA",
      }),
    ).toBe(false);
    expect(
      gateTimeoutApplies({ productionStatus: undefined, stillAt: "script_review", currentGateId: null, gateId: "g" }),
    ).toBe(false);
  });

  it("falls back to the status-only rule when either gate id is unknown", () => {
    expect(
      gateTimeoutApplies({ productionStatus: "script_review", stillAt: "script_review", currentGateId: null, gateId: "gateA" }),
    ).toBe(true);
    expect(
      gateTimeoutApplies({ productionStatus: "script_review", stillAt: "script_review", currentGateId: "gateA" }),
    ).toBe(true);
  });
});
