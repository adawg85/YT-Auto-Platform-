import { describe, expect, it } from "vitest";
import { videoEngineFor, resolveProductionProfile, VIDEO_ENGINES } from "../src/production-profile";

describe("videoEngineFor", () => {
  it("defaults to wan; minimax/seedance pass through", () => {
    expect(videoEngineFor({})).toBe("wan");
    expect(videoEngineFor({ videoEngine: "minimax" })).toBe("minimax");
    expect(videoEngineFor({ videoEngine: "seedance" })).toBe("seedance");
  });

  it("routes character clips to characterVideoEngine only when asked", () => {
    const p = { videoEngine: "wan" as const, characterVideoEngine: "seedance" as const };
    expect(videoEngineFor(p, { character: true })).toBe("seedance");
    expect(videoEngineFor(p, { character: false })).toBe("wan");
    expect(videoEngineFor(p)).toBe("wan"); // filler default
  });

  it("falls back to the filler engine when no character engine is set", () => {
    expect(videoEngineFor({ videoEngine: "minimax" }, { character: true })).toBe("minimax");
  });

  it("routes hero clips to heroVideoEngine; character wins when both apply", () => {
    const p = { videoEngine: "wan" as const, heroVideoEngine: "kling" as const, characterVideoEngine: "seedance" as const };
    expect(videoEngineFor(p, { hero: true })).toBe("kling");
    expect(videoEngineFor(p, { character: false, hero: true })).toBe("kling");
    expect(videoEngineFor(p, { character: true, hero: true })).toBe("seedance"); // character precedence
    expect(videoEngineFor(p, {})).toBe("wan"); // filler
    // hero unset → hero shot falls back to filler
    expect(videoEngineFor({ videoEngine: "wan" }, { hero: true })).toBe("wan");
  });

  it("exposes seedance in the engine list", () => {
    expect(VIDEO_ENGINES).toContain("seedance");
  });
});

describe("resolveProductionProfile — video cost fields", () => {
  it("carries a valid character engine + clip budget, drops junk", () => {
    const p = resolveProductionProfile({ characterVideoEngine: "seedance", maxAiClips: 6 });
    expect(p.characterVideoEngine).toBe("seedance");
    expect(p.maxAiClips).toBe(6);
  });

  it("clamps the clip budget and ignores invalid engines", () => {
    expect(resolveProductionProfile({ maxAiClips: 99 }).maxAiClips).toBe(20);
    expect(resolveProductionProfile({ maxAiClips: -5 }).maxAiClips).toBe(0);
    // junk engine from the DB jsonb (untyped) — must resolve to undefined
    expect(
      resolveProductionProfile(
        { characterVideoEngine: "bogus" } as unknown as Parameters<typeof resolveProductionProfile>[0],
      ).characterVideoEngine,
    ).toBeUndefined();
    expect(resolveProductionProfile({}).maxAiClips).toBeUndefined();
    expect(resolveProductionProfile({}).characterVideoEngine).toBeUndefined();
  });
});
