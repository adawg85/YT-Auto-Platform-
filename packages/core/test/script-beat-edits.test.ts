/**
 * #88 — the operator-authoring path that does not depend on author_script.
 *
 * These are the rules the ticket's two blockers turn on, so they're asserted
 * rather than eyeballed: sparse edits must not need to match the platform's beat
 * count, an unlisted beat must survive untouched, and a visuals-only edit must
 * NOT set narrationChanged (the caller tears down the voiceover on that flag —
 * so a false positive would silently recut the audio and re-bill the operator
 * for authoring visual direction).
 */
import { describe, expect, it } from "vitest";
import type { ScriptBeat } from "@ytauto/db";
import { applyScriptBeatEdits, estimateBeatSeconds } from "../src/script-beat-edits";

function beat(over: Partial<ScriptBeat> = {}): ScriptBeat {
  return { type: "insight", text: "original narration here", imagePrompt: "original prompt", ...over };
}

const draft: ScriptBeat[] = [
  beat({ type: "hook", text: "the hook line" }),
  beat({ text: "beat one" }),
  beat({ text: "beat two", referenceEntity: "B-47 Stratojet" }),
];

describe("applyScriptBeatEdits", () => {
  it("edits one beat of many without matching the beat count (#88 blocker a)", () => {
    const res = applyScriptBeatEdits(draft, [{ index: 1, text: "rewritten beat one" }]);
    if (!res.ok) throw new Error(res.error);
    expect(res.beats).toHaveLength(3);
    expect(res.beats[1]!.text).toBe("rewritten beat one");
    expect(res.editedBeats).toEqual([1]);
  });

  it("leaves unlisted beats byte-identical", () => {
    const res = applyScriptBeatEdits(draft, [{ index: 1, text: "rewritten" }]);
    if (!res.ok) throw new Error(res.error);
    // same reference, not merely a deep-equal copy — nothing was perturbed
    expect(res.beats[0]).toBe(draft[0]);
    expect(res.beats[2]).toBe(draft[2]);
  });

  it("never mutates the input beats", () => {
    const before = JSON.parse(JSON.stringify(draft));
    applyScriptBeatEdits(draft, [{ index: 0, text: "changed", imagePrompt: "changed too" }]);
    expect(draft).toEqual(before);
  });

  it("carries the visual direction a narration-only edit could not (#88 blocker b)", () => {
    const res = applyScriptBeatEdits(draft, [
      {
        index: 0,
        imagePrompt: "a B-47 on a wet 1950s ramp, low three-quarter view",
        imagePrompts: ["shot a", "shot b", null],
        referenceEntity: "Boeing B-47 Stratojet",
        visualBrief: "era-correct SAC ramp, overcast",
        motionPrompt: "slow push in",
        animates: true,
      },
    ]);
    if (!res.ok) throw new Error(res.error);
    const b = res.beats[0]!;
    expect(b.imagePrompt).toBe("a B-47 on a wet 1950s ramp, low three-quarter view");
    expect(b.imagePrompts).toEqual(["shot a", "shot b", null]);
    expect(b.referenceEntity).toBe("Boeing B-47 Stratojet");
    expect(b.visualBrief).toBe("era-correct SAC ramp, overcast");
    expect(b.motionPrompt).toBe("slow push in");
    expect(b.animates).toBe(true);
  });

  it("a visuals-only edit does NOT flag narrationChanged (so the voiceover is not recut)", () => {
    const res = applyScriptBeatEdits(draft, [{ index: 2, imagePrompt: "new prompt", referenceEntity: "XB-70" }]);
    if (!res.ok) throw new Error(res.error);
    expect(res.narrationChanged).toBe(false);
    expect(res.visualsChanged).toBe(true);
  });

  it("re-sending identical narration is not a narration change", () => {
    const res = applyScriptBeatEdits(draft, [{ index: 1, text: "  beat one  " }]);
    if (!res.ok) throw new Error(res.error);
    expect(res.narrationChanged).toBe(false);
  });

  it("a real reword flags narrationChanged and re-estimates the beat length", () => {
    const res = applyScriptBeatEdits(draft, [{ index: 1, text: "one two three four five" }]);
    if (!res.ok) throw new Error(res.error);
    expect(res.narrationChanged).toBe(true);
    expect(res.visualsChanged).toBe(false);
    expect(res.beats[1]!.estSec).toBe(estimateBeatSeconds("one two three four five"));
  });

  it("an empty-string referenceEntity clears it rather than storing ''", () => {
    const res = applyScriptBeatEdits(draft, [{ index: 2, referenceEntity: "" }]);
    if (!res.ok) throw new Error(res.error);
    expect(res.beats[2]!.referenceEntity).toBeNull();
  });

  it("names the real beat count on an out-of-range index", () => {
    const res = applyScriptBeatEdits(draft, [{ index: 7, text: "nope" }]);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected an out-of-range rejection");
    expect(res.error).toContain("3 beats");
    expect(res.error).toContain("0-2");
  });

  it("rejects an edit that would leave a beat with no spoken text", () => {
    const res = applyScriptBeatEdits(draft, [{ index: 0, text: "   " }]);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected an empty-text rejection");
    expect(res.error).toContain("every beat needs spoken text");
  });

  it("rejects an empty edit list", () => {
    expect(applyScriptBeatEdits(draft, []).ok).toBe(false);
  });

  it("merges repeated edits to the same index instead of conflicting", () => {
    const res = applyScriptBeatEdits(draft, [
      { index: 1, text: "first pass" },
      { index: 1, imagePrompt: "second pass prompt" },
    ]);
    if (!res.ok) throw new Error(res.error);
    expect(res.beats[1]!.text).toBe("first pass");
    expect(res.beats[1]!.imagePrompt).toBe("second pass prompt");
    expect(res.editedBeats).toEqual([1]);
  });

  it("reports edited indices ascending regardless of input order", () => {
    const res = applyScriptBeatEdits(draft, [
      { index: 2, imagePrompt: "c" },
      { index: 0, imagePrompt: "a" },
    ]);
    if (!res.ok) throw new Error(res.error);
    expect(res.editedBeats).toEqual([0, 2]);
  });
});
