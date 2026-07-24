import { describe, it, expect } from "vitest";
import {
  castCharacterForShot,
  CHARACTER_CAST_MODES,
  targetPctForCast,
  selectForcedCharacterShots,
  assignForcedCharacterShots,
  DEFAULT_CAST_TARGET,
  type CastShotSignal,
  type ForcedCastCharacter,
} from "../src/character-cast";

const countOver = (mode: string, n: number) =>
  Array.from({ length: n }, (_, i) => castCharacterForShot(mode, i)).filter(Boolean).length;

describe("castCharacterForShot (legacy index helper)", () => {
  it("spreads to the right proportion over 12 shots", () => {
    expect(countOver("always", 12)).toBe(12);
    expect(countOver("75", 12)).toBe(9);
    expect(countOver("50", 12)).toBe(6);
    expect(countOver("25", 12)).toBe(3);
    expect(countOver("auto", 12)).toBe(0);
    expect(countOver("off", 12)).toBe(0);
    expect(countOver("smart", 12)).toBe(0); // smart forces via the whole-list planner, not by index
  });

  it("casts the first shot under every fixed percentage (character-forward opener)", () => {
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
    expect(CHARACTER_CAST_MODES).toEqual(["off", "auto", "smart", "25", "50", "75", "always"]);
  });
});

describe("targetPctForCast", () => {
  it("maps modes to a target share, or null for no forcing", () => {
    expect(targetPctForCast("always")).toBe(100);
    expect(targetPctForCast("75")).toBe(75);
    expect(targetPctForCast("50")).toBe(50);
    expect(targetPctForCast("25")).toBe(25);
    expect(targetPctForCast("off")).toBeNull();
    expect(targetPctForCast("auto")).toBeNull();
    expect(targetPctForCast("bogus")).toBeNull();
  });

  it("smart reads castTarget, defaulting + clamping", () => {
    expect(targetPctForCast("smart", 60)).toBe(60);
    expect(targetPctForCast("smart", null)).toBe(DEFAULT_CAST_TARGET);
    expect(targetPctForCast("smart", 140)).toBe(100);
    expect(targetPctForCast("smart", -10)).toBe(0);
  });
});

describe("selectForcedCharacterShots", () => {
  const plain = (n: number): CastShotSignal[] =>
    Array.from({ length: n }, () => ({ text: "a neutral scene", prompt: "a neutral scene" }));

  it("hits roughly the target share", () => {
    expect(selectForcedCharacterShots(plain(10), "Dr Atom", 50).size).toBe(5);
    expect(selectForcedCharacterShots(plain(10), "Dr Atom", 55).size).toBe(6); // round(5.5)
    expect(selectForcedCharacterShots(plain(12), "Dr Atom", 25).size).toBe(3);
  });

  it("100% casts every shot; 0% casts none", () => {
    expect(selectForcedCharacterShots(plain(8), "Dr Atom", 100).size).toBe(8);
    expect(selectForcedCharacterShots(plain(8), "Dr Atom", 0).size).toBe(0);
  });

  it("prefers hero + named shots over diagram/text filler", () => {
    const shots: CastShotSignal[] = [
      { prompt: "a periodic table diagram", text: "here are the elements" }, // filler (-)
      { prompt: "Dr Atom grins at the camera", text: "Dr Atom is thrilled", heroShot: true }, // strong (+)
      { prompt: "a schematic of an atom", text: "electrons orbit" }, // filler (-)
      { prompt: "a busy lab bench", text: "the experiment begins" }, // neutral
    ];
    // budget of 1 → must be the hero/named shot, never a diagram
    const one = selectForcedCharacterShots(shots, "Dr Atom", 25);
    expect(one.has(1)).toBe(true);
    expect(one.size).toBe(1);
    // budget of 2 → hero first, then the neutral lab bench, still not a diagram
    const two = selectForcedCharacterShots(shots, "Dr Atom", 50);
    expect(two.has(1)).toBe(true);
    expect(two.has(3)).toBe(true);
    expect(two.has(0)).toBe(false);
    expect(two.has(2)).toBe(false);
  });

  it("counts builder-cast mascot shots toward the target and never removes them", () => {
    const shots: CastShotSignal[] = plain(10).map((s, i) =>
      i < 4 ? { ...s, builderCharacter: "Dr Atom" } : s,
    );
    const set = selectForcedCharacterShots(shots, "Dr Atom", 50);
    for (const i of [0, 1, 2, 3]) expect(set.has(i)).toBe(true);
    expect(set.size).toBe(5); // 4 builder + 1 top-up
  });

  it("does not steal a shot the builder gave a different character", () => {
    const shots: CastShotSignal[] = plain(6).map((s, i) =>
      i === 2 ? { ...s, builderCharacter: "Zappy" } : s,
    );
    const set = selectForcedCharacterShots(shots, "Dr Atom", 100);
    expect(set.has(2)).toBe(false);
    expect(set.size).toBe(5);
  });

  it("is deterministic", () => {
    const shots = plain(15);
    const a = [...selectForcedCharacterShots(shots, "Dr Atom", 40)].sort((x, y) => x - y);
    const b = [...selectForcedCharacterShots(shots, "Dr Atom", 40)].sort((x, y) => x - y);
    expect(a).toEqual(b);
  });
});

describe("assignForcedCharacterShots (multi-character)", () => {
  const plain = (n: number): CastShotSignal[] =>
    Array.from({ length: n }, () => ({ text: "a neutral scene", prompt: "a neutral scene" }));
  const char = (name: string, castMode: string, extra: Partial<ForcedCastCharacter> = {}): ForcedCastCharacter => ({
    name,
    castMode,
    ...extra,
  });

  it("gives each forcing character ~its own share, with no overlap", () => {
    const map = assignForcedCharacterShots(plain(10), [char("Ana", "50"), char("Ben", "25")]);
    const names = [...map.values()];
    expect(names.filter((x) => x === "Ana").length).toBe(5);
    expect(names.filter((x) => x === "Ben").length).toBe(3); // round(2.5)
    // no shot assigned twice — Map keys are unique by construction; total = 8
    expect(map.size).toBe(8);
  });

  it("matches the single-character planner when only one character forces", () => {
    const shots = plain(10);
    const single = selectForcedCharacterShots(shots, "Ana", 50);
    const multi = assignForcedCharacterShots(shots, [char("Ana", "50")]);
    expect([...multi.keys()].sort((a, b) => a - b)).toEqual([...single].sort((a, b) => a - b));
    for (const v of multi.values()) expect(v).toBe("Ana");
  });

  it("does not double-book a shot between two 'always' mascots — first by priority wins", () => {
    const map = assignForcedCharacterShots(plain(4), [
      char("Solo", "always", { role: "main" }),
      char("Extra", "always"),
    ]);
    // one 'always' cannot literally take every shot when another also wants all;
    // the higher-priority ('main') claims the remaining unowned shots.
    expect([...map.values()].every((v) => v === "Solo")).toBe(true);
    expect(map.size).toBe(4);
  });

  it("counts a builder cast toward that character's target and never reassigns it", () => {
    const shots: CastShotSignal[] = plain(10).map((s, i) =>
      i < 3 ? { ...s, builderCharacter: "Ana" } : s,
    );
    const map = assignForcedCharacterShots(shots, [char("Ana", "50"), char("Ben", "50")]);
    // Ana already has 3 builder shots → only 2 forced top-ups (total 5 presence)
    expect([...map.values()].filter((x) => x === "Ana").length).toBe(2);
    // builder shots are honoured by the pipeline, not echoed here
    for (const i of [0, 1, 2]) expect(map.has(i)).toBe(false);
    // Ben never lands on Ana's builder shots
    for (const i of [0, 1, 2]) expect(map.get(i)).not.toBe("Ben");
  });

  it("skips off/auto characters (no forcing)", () => {
    const map = assignForcedCharacterShots(plain(8), [char("Ana", "off"), char("Ben", "auto")]);
    expect(map.size).toBe(0);
  });

  it("is deterministic", () => {
    const shots = plain(12);
    const chars = [char("Ana", "50"), char("Ben", "25")];
    const a = [...assignForcedCharacterShots(shots, chars).entries()].sort((x, y) => x[0] - y[0]);
    const b = [...assignForcedCharacterShots(shots, chars).entries()].sort((x, y) => x[0] - y[0]);
    expect(a).toEqual(b);
  });
});
