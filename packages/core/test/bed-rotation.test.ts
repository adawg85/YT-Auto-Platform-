import { describe, expect, it } from "vitest";
import { bedRotationCompare } from "../src/channel-music";

// #119: the bed rotation was inert (lastUsedAt never written by selection
// paths). These pin the ORDER the rotation promises: never-used before any
// repeat, least-recently-used first, usedCount then insertion order then id as
// deterministic tie-breaks — so a fresh bed distributes instead of repeatedly
// selecting the first row.

const t = (
  id: string,
  lastUsedAt: Date | null,
  usedCount = 0,
  createdAt = new Date("2026-08-01T00:00:00Z"),
) => ({ id, lastUsedAt, usedCount, createdAt });

const order = (tracks: ReturnType<typeof t>[]) => [...tracks].sort(bedRotationCompare).map((x) => x.id);

describe("bedRotationCompare", () => {
  it("never-used tracks come before any used track", () => {
    expect(
      order([t("used", new Date("2026-08-05T00:00:00Z"), 1), t("fresh", null)]),
    ).toEqual(["fresh", "used"]);
  });

  it("least-recently-used first among used tracks", () => {
    expect(
      order([
        t("recent", new Date("2026-08-09T00:00:00Z"), 1),
        t("old", new Date("2026-08-01T00:00:00Z"), 1),
        t("middle", new Date("2026-08-05T00:00:00Z"), 1),
      ]),
    ).toEqual(["old", "middle", "recent"]);
  });

  it("equal timestamps tie-break by usedCount, then insertion order, then id", () => {
    const when = new Date("2026-08-05T00:00:00Z");
    expect(
      order([
        t("thrice", when, 3),
        t("once", when, 1),
        t("once-but-older", when, 1, new Date("2026-07-01T00:00:00Z")),
      ]),
    ).toEqual(["once-but-older", "once", "thrice"]);
    // full tie → id, so a genuinely fresh bed still has ONE deterministic order
    expect(order([t("b", null), t("a", null)])).toEqual(["a", "b"]);
  });

  it("a 4-track bed cycles through all four before any repeat", () => {
    // simulate: pick head, stamp it, re-sort — five consecutive productions
    const bed = [t("a", null), t("b", null), t("c", null), t("d", null)];
    const picks: string[] = [];
    let clock = Date.parse("2026-08-10T00:00:00Z");
    for (let i = 0; i < 5; i++) {
      const [next] = [...bed].sort(bedRotationCompare);
      picks.push(next!.id);
      next!.lastUsedAt = new Date((clock += 60_000));
      next!.usedCount += 1;
    }
    expect(picks.slice(0, 4).toSorted()).toEqual(["a", "b", "c", "d"]); // all four before…
    expect(picks[4]).toBe(picks[0]); // …the LRU repeat
  });
});
