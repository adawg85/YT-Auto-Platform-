import { describe, it, expect } from "vitest";
import { castCharacterForShot, CHARACTER_CAST_MODES } from "../src/character-cast";

const countOver = (mode: string, n: number) =>
  Array.from({ length: n }, (_, i) => castCharacterForShot(mode, i)).filter(Boolean).length;

describe("castCharacterForShot", () => {
  it("spreads to the right proportion over 12 shots", () => {
    expect(countOver("always", 12)).toBe(12);
    expect(countOver("75", 12)).toBe(9);
    expect(countOver("50", 12)).toBe(6);
    expect(countOver("25", 12)).toBe(3);
    expect(countOver("auto", 12)).toBe(0);
    expect(countOver("off", 12)).toBe(0);
  });

  it("casts the first shot under every percentage (character-forward opener)", () => {
    for (const m of ["25", "50", "75", "always"]) expect(castCharacterForShot(m, 0)).toBe(true);
  });

  it("is deterministic by index — same input, same output", () => {
    for (let i = 0; i < 20; i++) {
      expect(castCharacterForShot("50", i)).toBe(castCharacterForShot("50", i));
    }
  });

  it("unknown modes never force", () => {
    expect(castCharacterForShot("bogus", 0)).toBe(false);
  });

  it("exposes the full mode list", () => {
    expect(CHARACTER_CAST_MODES).toEqual(["off", "auto", "25", "50", "75", "always"]);
  });
});
