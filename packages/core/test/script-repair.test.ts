import { describe, expect, it } from "vitest";
import { applyScriptRepair, type RepairedScript, type ScriptOutput } from "../src";

/**
 * Scripting-loop incident FIX 2: the surgical-repair merge is fail-safe — a
 * beat-count mismatch or a gutted rewrite (>20% word shrink) returns the
 * ORIGINAL script unchanged, so the pipeline's proof loop holds the
 * production exactly as it did before the repair agent existed.
 */
const script = (): ScriptOutput => ({
  hookText: "Two pilots, one sky.",
  beats: [
    {
      type: "hook",
      text: "Two pilots, one sky, and a storm nobody saw coming.",
      imagePrompt: "storm front over an airfield",
      referenceEntity: null,
      estSec: 4,
    },
    {
      type: "insight",
      text: "Neither knew the other existed until the radio crackled to life.",
      imagePrompt: "vintage cockpit radio",
      referenceEntity: "Supermarine Spitfire",
      estSec: 5,
    },
    {
      type: "cta",
      text: "Follow for the next episode.",
      imagePrompt: "channel outro card",
      referenceEntity: null,
      estSec: 2,
    },
  ],
  fullText:
    "Two pilots, one sky, and a storm nobody saw coming. Neither knew the other existed until the radio crackled to life. Follow for the next episode.",
  substanceFingerprint: "two pilots | storm | radio",
});

describe("applyScriptRepair", () => {
  it("merges repaired beat texts and preserves beat metadata + fingerprint", () => {
    const original = script();
    const repaired: RepairedScript = {
      hookText: "Two pilots, one sky.",
      beats: [
        { text: "Two pilots, one sky, and a storm nobody saw coming." },
        { text: "As far as either of them knew, they were alone up there — until the radio crackled to life." },
        { text: "Follow for the next episode." },
      ],
    };
    const out = applyScriptRepair(original, repaired);
    expect(out).not.toBe(original);
    expect(out.beats[1]!.text).toContain("As far as either of them knew");
    // untouched beats survive verbatim
    expect(out.beats[0]!.text).toBe(original.beats[0]!.text);
    expect(out.beats[2]!.text).toBe(original.beats[2]!.text);
    // metadata rides along; only text moves
    expect(out.beats[1]!.imagePrompt).toBe("vintage cockpit radio");
    expect(out.beats[1]!.referenceEntity).toBe("Supermarine Spitfire");
    expect(out.beats[1]!.type).toBe("insight");
    expect(out.beats[1]!.estSec).toBe(5);
    expect(out.substanceFingerprint).toBe(original.substanceFingerprint);
    // fullText is rebuilt from the merged beats
    expect(out.fullText).toBe(out.beats.map((b) => b.text).join(" "));
  });

  it("fail-safe: beat-count mismatch returns the original unchanged", () => {
    const original = script();
    const repaired: RepairedScript = {
      hookText: "Two pilots, one sky.",
      beats: [{ text: "a" }, { text: "b" }],
    };
    expect(applyScriptRepair(original, repaired)).toBe(original);
  });

  it("fail-safe: >20% total word shrink returns the original unchanged", () => {
    const original = script();
    const repaired: RepairedScript = {
      hookText: "Two pilots.",
      beats: [{ text: "Storm." }, { text: "Radio." }, { text: "Follow." }],
    };
    expect(applyScriptRepair(original, repaired)).toBe(original);
  });

  it("accepts a small honest shrink (a removed claim, join smoothed)", () => {
    const original = script();
    const repaired: RepairedScript = {
      hookText: "Two pilots, one sky.",
      beats: [
        { text: "Two pilots, one sky, and a storm nobody saw coming." },
        { text: "Then the radio crackled to life between them." },
        { text: "Follow for the next episode." },
      ],
    };
    const out = applyScriptRepair(original, repaired);
    expect(out.beats[1]!.text).toBe("Then the radio crackled to life between them.");
  });
});
