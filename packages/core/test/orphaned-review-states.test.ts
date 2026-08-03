import { describe, expect, it } from "vitest";
import { isReviewStatus, orphanedReviewStates } from "../src/gate-lifecycle";

const NOW = new Date("2026-08-03T12:00:00Z");
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

const row = (over: Partial<Parameters<typeof orphanedReviewStates>[0][number]> = {}) => ({
  id: "01KZ3P2512Y5M3DKCPB81XQVPN",
  channelId: "01KY291HX68DFJYH6QBCG9Y3FC",
  status: "profile_review",
  updatedAt: minsAgo(120),
  pendingGates: 0,
  ...over,
});

describe("orphanedReviewStates (#94 — parked in a review status with no gate)", () => {
  it("flags the reported case: profile_review, no pending gate row", () => {
    const [hit, ...rest] = orphanedReviewStates([row()], NOW);
    expect(rest).toHaveLength(0);
    expect(hit).toMatchObject({
      productionId: "01KZ3P2512Y5M3DKCPB81XQVPN",
      status: "profile_review",
      stuckSinceMinutes: 120,
    });
    // the operator needs to know it is unapprovable AND how to get out
    expect(hit!.reason).toContain("NO pending gate");
    expect(hit!.reason).toContain("force_forward");
  });

  it("does NOT flag a review status that HAS a pending gate — that's a normal wait", () => {
    expect(orphanedReviewStates([row({ pendingGates: 1 })], NOW)).toEqual([]);
  });

  it("does NOT flag the transition window right after a gate decision", () => {
    expect(orphanedReviewStates([row({ updatedAt: minsAgo(2) })], NOW)).toEqual([]);
    // …but does once it has persisted past the threshold
    expect(orphanedReviewStates([row({ updatedAt: minsAgo(30) })], NOW)).toHaveLength(1);
  });

  it("ignores non-review statuses entirely (producing/ready/published/halted)", () => {
    const others = ["greenlit", "producing_assets", "assembling", "ready", "published", "halted", "failed"];
    expect(orphanedReviewStates(others.map((status) => row({ status })), NOW)).toEqual([]);
  });

  it("covers every human-review status, not just profile_review", () => {
    const kinds = ["script_review", "profile_review", "voiceover_recording", "visuals_review", "thumbnail_review"];
    for (const k of kinds) expect(isReviewStatus(k)).toBe(true);
    expect(orphanedReviewStates(kinds.map((status, i) => row({ id: `p${i}`, status })), NOW)).toHaveLength(
      kinds.length,
    );
  });

  it("reports an unknown age rather than hiding it, and sorts oldest first", () => {
    const out = orphanedReviewStates(
      [
        row({ id: "young", updatedAt: minsAgo(20) }),
        row({ id: "old", updatedAt: minsAgo(600) }),
        row({ id: "unknown", updatedAt: null }),
      ],
      NOW,
    );
    expect(out.map((o) => o.productionId)).toEqual(["old", "young", "unknown"]);
    expect(out.find((o) => o.productionId === "unknown")!.stuckSinceMinutes).toBeNull();
  });

  it("accepts an ISO string updatedAt (what the JSON read paths carry)", () => {
    expect(orphanedReviewStates([row({ updatedAt: minsAgo(90).toISOString() })], NOW)[0]!.stuckSinceMinutes).toBe(90);
  });
});
