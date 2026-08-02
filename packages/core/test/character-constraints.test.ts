import { describe, expect, it } from "vitest";
import { constraintClauses, droppedConstraintClauses } from "../src/character-constraints";

// The exact #90 case: the brief's proportional constraint dropped in distillation.
const BRIEF =
  "Built with natural adult human proportions: a full-height figure whose legs are roughly half his total height, normal leg length, standing tall and correctly proportioned rather than squat or dwarfish despite the heavy build.";

describe("character constraint preservation (#90)", () => {
  it("extracts the measurement/negation-bearing clauses from a brief", () => {
    const clauses = constraintClauses(BRIEF);
    expect(clauses.some((c) => /half his total height/i.test(c))).toBe(true);
    expect(clauses.some((c) => /rather than squat or dwarfish/i.test(c))).toBe(true);
  });

  it("flags the dropped proportional clause when the description only keeps adjectives", () => {
    // what the distiller actually returned in the ticket — measurements gone
    const description =
      "A heavy-set adult man, standing four-square and upright with natural adult proportions, not stooped or squat.";
    const dropped = droppedConstraintClauses(BRIEF, description);
    // the "legs roughly half his total height" / "normal leg length" clauses are gone
    expect(dropped.some((c) => /half his total height/i.test(c) || /leg length/i.test(c))).toBe(true);
  });

  it("does NOT flag a constraint that survived verbatim (The Arbiter case)", () => {
    const description =
      "A full-height figure whose legs are roughly half his total height, normal leg length, correctly proportioned adult build.";
    expect(droppedConstraintClauses(BRIEF, description)).toHaveLength(0);
  });

  it("recognises the negation as surviving when the description keeps 'squat'", () => {
    // description keeps 'squat' → that negation clause is NOT reported dropped
    const description = "Heavy adult build, not squat.";
    const dropped = droppedConstraintClauses("not squat or dwarfish.", description);
    expect(dropped).toHaveLength(0);
  });

  it("returns nothing for a brief with no measurements", () => {
    const brief = "A warm, friendly middle-aged teacher with round glasses and a tweed jacket.";
    expect(constraintClauses(brief)).toHaveLength(0);
    expect(droppedConstraintClauses(brief, "A middle-aged teacher.")).toHaveLength(0);
  });

  it("handles 'N heads tall' ratio phrasing", () => {
    const brief = "Correctly proportioned at about 7.5 heads tall.";
    expect(constraintClauses(brief).length).toBeGreaterThan(0);
    // dropped if the description omits the ratio
    expect(droppedConstraintClauses(brief, "Correctly proportioned adult.").length).toBeGreaterThan(0);
    // survives if the ratio is kept
    expect(droppedConstraintClauses(brief, "About 7.5 heads tall.")).toHaveLength(0);
  });
});
