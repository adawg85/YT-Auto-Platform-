import { describe, expect, it } from "vitest";
import {
  activeGatesOnly,
  GATE_DEAD_PRODUCTION_STATUSES,
  productionIsGateDead,
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
