import { describe, expect, it } from "vitest";
import { fragmentedHookStyleWarnings } from "../src/dna-consistency";

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
