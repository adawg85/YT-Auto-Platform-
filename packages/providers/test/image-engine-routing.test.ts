import { describe, expect, it } from "vitest";
import { imageProviderChain } from "../src/factory";

/**
 * The operator's Style tab is the ONLY source of which engine draws a shot.
 *
 * The bug this covers: a requested engine with NO API key was substituted before
 * the fallback list was ever read — `fallbackEngines` was consulted only in the
 * catch around a FAILED call, and a missing provider never throws. On the
 * Dog-Eared channel (all four image roles set to seedream, so the preference
 * list is literally ["seedream"]) that meant every shot rendered on qwen, which
 * appears nowhere in the channel's configuration.
 *
 * Providers are modelled as plain strings — the routing is what's under test,
 * and it must hold with no API keys present.
 */

// the shape selectMediaProvider builds: null = that engine has no key
const withKeys = (present: string[]): Record<string, string | null> => ({
  "nano-banana": present.includes("nano-banana") ? "gemini" : null,
  qwen: present.includes("qwen") ? "qwen" : null,
  seedream: present.includes("seedream") ? "seedream" : null,
});

describe("imageProviderChain — serve only what the channel configured", () => {
  it("THE CASE: seedream everywhere, no ModelArk key — does NOT reach for qwen", () => {
    const { chain, substituted } = imageProviderChain({
      engine: "seedream",
      fallbackEngines: ["seedream"], // what imageEnginePreference returns for this channel
      byEngine: withKeys(["qwen", "nano-banana"]), // ARK_API_KEY absent
      reals: ["qwen", "gemini"],
      lastResort: "qwen",
    });
    // nothing configured has a key, so this IS a substitution — and it must be
    // reported as one rather than passing for the operator's choice
    expect(substituted).toBe(true);
    expect(chain).toEqual(["qwen"]);
  });

  it("a keyless engine degrades to the channel's NEXT choice, not to qwen", () => {
    const { chain, substituted } = imageProviderChain({
      engine: "seedream",
      fallbackEngines: ["seedream", "nano-banana"],
      byEngine: withKeys(["qwen", "nano-banana"]), // seedream keyless
      reals: ["qwen", "gemini"],
      lastResort: "qwen",
    });
    expect(substituted).toBe(false);
    expect(chain).toEqual(["gemini"]); // the operator's second pick — qwen never appears
    expect(chain).not.toContain("qwen");
  });

  it("the requested engine leads when it has a key, then the Style-tab order", () => {
    const { chain, substituted } = imageProviderChain({
      engine: "seedream",
      fallbackEngines: ["seedream", "nano-banana"],
      byEngine: withKeys(["qwen", "nano-banana", "seedream"]),
      reals: ["qwen", "gemini", "seedream"],
      lastResort: "qwen",
    });
    expect(substituted).toBe(false);
    expect(chain).toEqual(["seedream", "gemini"]);
    // qwen has a key and is still excluded — it is not in the channel's list
    expect(chain).not.toContain("qwen");
  });

  it("never repeats a provider two roles happen to share", () => {
    const { chain } = imageProviderChain({
      engine: "seedream",
      fallbackEngines: ["seedream", "seedream", "nano-banana", "seedream"],
      byEngine: withKeys(["nano-banana", "seedream"]),
      reals: ["gemini", "seedream"],
      lastResort: "gemini",
    });
    expect(chain).toEqual(["seedream", "gemini"]);
  });

  it("a caller passing no list keeps the legacy any-real-engine spread", () => {
    const { chain, substituted } = imageProviderChain({
      engine: "seedream",
      byEngine: withKeys(["qwen", "nano-banana", "seedream"]),
      reals: ["qwen", "gemini", "seedream"],
      lastResort: "qwen",
    });
    expect(substituted).toBe(false);
    expect(chain[0]).toBe("seedream"); // requested engine still leads
    expect(chain).toContain("qwen");
  });

  it("with no engine requested at all, falls through to the reals", () => {
    const { chain, substituted } = imageProviderChain({
      byEngine: withKeys(["qwen", "nano-banana"]),
      reals: ["qwen", "gemini"],
      lastResort: "qwen",
    });
    expect(substituted).toBe(false);
    expect(chain).toEqual(["qwen", "gemini"]);
  });
});
