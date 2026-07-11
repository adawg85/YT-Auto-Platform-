import { describe, expect, it } from "vitest";
import {
  PERSONA_ARCHETYPES,
  PERSONA_ARCHETYPE_LIBRARY,
  defaultPersonaDoc,
  paceToSpeed,
  personaDocSchema,
  personaSystemBlock,
} from "../src/persona";

describe("persona archetype library (BACKLOG #21.1)", () => {
  it("every archetype seed validates against personaDocSchema", () => {
    for (const a of PERSONA_ARCHETYPES) {
      const doc = defaultPersonaDoc(a, "aviation history");
      expect(() => personaDocSchema.parse(doc)).not.toThrow();
      expect(doc.exemplars.length).toBeGreaterThanOrEqual(1);
      expect(PERSONA_ARCHETYPE_LIBRARY[a].leansTo.length).toBeGreaterThan(0);
    }
  });

  it("seeds specialise to the niche", () => {
    const doc = defaultPersonaDoc("enthusiast_expert", "deep sea exploration");
    expect(doc.identity).toContain("deep sea exploration");
  });

  it("personaSystemBlock renders identity, rules, and exemplars in order", () => {
    const doc = defaultPersonaDoc("documentary_narrator", "aviation history");
    const block = personaSystemBlock(doc);
    const idIdx = block.indexOf(doc.identity.slice(0, 30));
    const rulesIdx = block.indexOf("HOW YOU TALK:");
    const exemplarIdx = block.indexOf("PASSAGES IN YOUR VOICE");
    expect(idIdx).toBeGreaterThanOrEqual(0);
    expect(rulesIdx).toBeGreaterThan(idIdx);
    expect(exemplarIdx).toBeGreaterThan(rulesIdx);
    expect(block).toContain("You never say:");
  });

  it("pace is optional on the doc and maps to a TTS speed (#26)", () => {
    const doc = defaultPersonaDoc("documentary_narrator", "aviation history");
    // legacy docs (no pace) still validate; pace values validate too
    expect(() => personaDocSchema.parse(doc)).not.toThrow();
    expect(() => personaDocSchema.parse({ ...doc, pace: "brisk" })).not.toThrow();
    expect(() => personaDocSchema.parse({ ...doc, pace: "sprint" })).toThrow();
    expect(paceToSpeed("slow")).toBe(0.95);
    expect(paceToSpeed("natural")).toBe(1.0);
    expect(paceToSpeed("brisk")).toBe(1.08);
    // undefined/unknown → natural (legacy-safe)
    expect(paceToSpeed(undefined)).toBe(1.0);
    expect(paceToSpeed("whatever")).toBe(1.0);
  });
});
