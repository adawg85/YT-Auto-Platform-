import { describe, expect, it } from "vitest";
import {
  forceForwardStatus,
  stuckProductions,
  TERMINAL_PRODUCTION_STATUSES,
} from "../src/gate-lifecycle";

const NOW = new Date("2026-08-04T12:00:00Z");
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

const row = (over: Partial<Parameters<typeof stuckProductions>[0][number]> = {}) => ({
  id: "01KZ4VQ949DTDYY7HPR49WDH14",
  channelId: "01KY291HX68DFJYH6QBCG9Y3FC",
  status: "greenlit",
  updatedAt: minsAgo(240),
  pendingGates: 0,
  ...over,
});

describe("forceForwardStatus (#98 — never present built work as un-started)", () => {
  it("a fully-rendered production resumes as assembling, not greenlit", () => {
    expect(forceForwardStatus({ render: true, images: true, voiceover: true, script: true })).toBe(
      "assembling",
    );
  });

  it("102 images and no render resumes as producing_assets — NOT back at the start", () => {
    // the reported case: all shots built + a human-approved visuals gate, shown
    // to the operator as `greenlit`, which reads as "kicked back to scripting"
    expect(forceForwardStatus({ images: true, voiceover: true, script: true })).toBe("producing_assets");
  });

  it("a script-only production resumes at producing_assets (the next real work)", () => {
    expect(forceForwardStatus({ script: true })).toBe("producing_assets");
  });

  it("only a production with nothing built lands at greenlit", () => {
    expect(forceForwardStatus({})).toBe("greenlit");
  });
});

describe("stuckProductions (#98 — the detector must not only watch *_review)", () => {
  it("THE BUG: a production stranded at greenlit is reported", () => {
    // #94's detector watched *_review only, so this exact row — force-forwarded,
    // no run advancing it, $6.95 of work — was invisible to it.
    const [hit] = stuckProductions([row()], NOW);
    expect(hit).toMatchObject({ status: "greenlit", stuckSinceMinutes: 240 });
    expect(hit!.reason).toContain("no pipeline activity");
    expect(hit!.reason).toContain("force_forward");
  });

  it("still reports the #94 case: a review status with NO pending gate", () => {
    const [hit] = stuckProductions([row({ status: "profile_review" })], NOW);
    expect(hit!.reason).toContain("NO pending gate");
  });

  it("does NOT report a review status that HAS a live gate — that's waiting on the human", () => {
    expect(stuckProductions([row({ status: "visuals_review", pendingGates: 1 })], NOW)).toEqual([]);
  });

  it("reports mid-pipeline statuses that stall", () => {
    for (const status of ["scripting", "producing_assets", "assembling"]) {
      expect(stuckProductions([row({ status })], NOW)).toHaveLength(1);
    }
  });

  it("never reports a terminal or operator-owned status", () => {
    const rows = TERMINAL_PRODUCTION_STATUSES.map((status) => row({ status }));
    expect(stuckProductions(rows, NOW)).toEqual([]);
  });

  it("respects the threshold — a run that just started is not stuck", () => {
    expect(stuckProductions([row({ updatedAt: minsAgo(5) })], NOW)).toEqual([]);
    expect(stuckProductions([row({ updatedAt: minsAgo(45) })], NOW)).toHaveLength(1);
  });

  it("sorts oldest first so the worst offender leads", () => {
    const out = stuckProductions(
      [row({ id: "new", updatedAt: minsAgo(40) }), row({ id: "old", updatedAt: minsAgo(900) })],
      NOW,
    );
    expect(out.map((o) => o.productionId)).toEqual(["old", "new"]);
  });
});
