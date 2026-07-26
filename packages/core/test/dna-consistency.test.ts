import { describe, expect, it } from "vitest";
import { fragmentedHookStyleWarnings, lengthPolicyFloorWarnings, madeForKidsWarnings } from "../src/dna-consistency";
import type { LengthPolicy } from "@ytauto/db";

describe("fragmentedHookStyleWarnings (tickets 01KY6D8F… / 01KY6FGE…)", () => {
  it("flags the Lost Books comma-shredded list", () => {
    const stored = [
      "Claim-plus-withheld-payoff: state what the text says",
      "then withhold the where/who/why",
      "Named-anchor cold open: drop straight into a specific place",
      "scribe",
      "or date (Cave 4",
      "Qumran",
      "1947)",
      "'Did you know' correction: overturn an assumed belief",
      "a translation",
      "or a quotation that shouldn't exist",
    ];
    const w = fragmentedHookStyleWarnings(stored);
    expect(w).toHaveLength(1);
    // catches the lowercase clause-tails and the unbalanced ")"
    expect(w[0]).toContain('"then withhold the where/who/why"');
    expect(w[0]).toContain('"or date (Cave 4"');
    expect(w[0]).toContain('"1947)"');
    expect(w[0]).toContain('"a translation"');
  });

  it("flags the Wings & Stories list (lowercase 'then' and 'the' tails)", () => {
    const stored = [
      "Open on a single dramatic moment or decision",
      "then rewind to explain how it came to be",
      "Pose a provocative question about why an aircraft or design succeeded or failed",
      "Contrast expectation vs. reality — the plane that shouldn't have worked",
      "the flight that changed everything",
    ];
    const w = fragmentedHookStyleWarnings(stored);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('"then rewind to explain how it came to be"');
    expect(w[0]).toContain('"the flight that changed everything"');
  });

  it("does NOT flag clean lists (snake_case tokens or Capitalised phrases)", () => {
    expect(fragmentedHookStyleWarnings(["curiosity_gap", "stakes_first", "contrarian"])).toEqual([]);
    expect(
      fragmentedHookStyleWarnings([
        "Open on a single dramatic moment — then rewind to explain how it came to be",
        "Pose a provocative question about why an aircraft succeeded or failed",
        "The reveal that overturns an assumption",
      ]),
    ).toEqual([]);
  });

  it("does not flag Capitalised leading words (The/And) — only lowercase tails", () => {
    expect(fragmentedHookStyleWarnings(["The bold claim", "And the twist"])).toEqual([]);
  });

  it("returns nothing for a single-entry or empty list", () => {
    expect(fragmentedHookStyleWarnings(["then a lone fragment"])).toEqual([]);
    expect(fragmentedHookStyleWarnings([])).toEqual([]);
  });
});

describe("lengthPolicyFloorWarnings (#48, ticket 01KY9E15…)", () => {
  const policy = (over: Partial<LengthPolicy> = {}): LengthPolicy => ({
    floorSec: 480,
    ceilingSec: 2400,
    bands: [{ name: "standard", minSec: 720, maxSec: 1500 }],
    principle: "content-driven",
    ...over,
  });

  it("flags the exact Atom & Friends case: 330s anchor below a 480s hard floor", () => {
    const w = lengthPolicyFloorWarnings(330, policy());
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("330s");
    expect(w[0]).toContain("480s");
    expect(w[0]).toContain("150s below"); // 480 - 330
    expect(w[0]).toMatch(/mid-roll/);
  });

  it("does NOT flag an anchor at or above the floor (the later 900s value is silent-and-correct)", () => {
    expect(lengthPolicyFloorWarnings(900, policy())).toEqual([]); // 900 is inside band 720-1500
    // exactly on the floor doesn't trip the floor warning (isolate it with no bands)
    expect(lengthPolicyFloorWarnings(480, policy({ bands: [] }))).toEqual([]);
  });

  it("flags an anchor that clears the floor but sits outside every declared band", () => {
    // 600 > floor 480, but outside the only band (720-1500)
    const w = lengthPolicyFloorWarnings(600, policy());
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("outside every declared lengthPolicy band");
    expect(w[0]).toContain("standard 720-1500s");
  });

  it("the floor breach takes precedence over the band check (one warning, not two)", () => {
    const w = lengthPolicyFloorWarnings(330, policy());
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("hard floor");
  });

  it("is silent when the anchor sits inside a band, and when unset", () => {
    expect(lengthPolicyFloorWarnings(1000, policy())).toEqual([]); // inside 720-1500
    expect(lengthPolicyFloorWarnings(0, policy())).toEqual([]); // unset anchor
    expect(lengthPolicyFloorWarnings(900, policy({ bands: [] }))).toEqual([]); // no bands → no band check
  });
});

describe("madeForKidsWarnings (#53, ticket 01KY9EDC…)", () => {
  const kids = "curious kids roughly 8-14 who love science";
  const adults = "reflective adults 30-60 in the US and UK";
  const endCardObjective = ["Design series arcs and end-cards for chained viewing to lift session watch time"];

  it("the Atom & Friends case: MFK channel whose charter commits to end-cards", () => {
    const w = madeForKidsWarnings({ madeForKids: true, audiencePersona: kids, objectives: endCardObjective });
    expect(w.some((s) => /Made for Kids/i.test(s) && /end-card/i.test(s))).toBe(true);
  });

  it("flags an undeclared designation on an under-13 channel", () => {
    const w = madeForKidsWarnings({ madeForKids: null, audiencePersona: kids, objectives: [] });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/UNDECLARED/);
  });

  it("undeclared + kids + end-card objective → both the undeclared and the conflict warning", () => {
    const w = madeForKidsWarnings({ madeForKids: null, audiencePersona: kids, objectives: endCardObjective });
    expect(w).toHaveLength(2);
  });

  it("is silent when explicitly NOT made for kids, or on an adult audience", () => {
    expect(madeForKidsWarnings({ madeForKids: false, audiencePersona: kids, objectives: endCardObjective })).toEqual([]);
    expect(madeForKidsWarnings({ madeForKids: null, audiencePersona: adults, objectives: endCardObjective })).toEqual([]);
  });

  it("MFK with no feature-dependent objective raises no conflict warning", () => {
    expect(madeForKidsWarnings({ madeForKids: true, audiencePersona: kids, objectives: ["Teach one element per episode"] })).toEqual([]);
  });
});
