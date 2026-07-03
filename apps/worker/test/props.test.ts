import { describe, expect, it } from "vitest";
import { buildShortProps } from "../src/props";
import type { ScriptBeat, WordTimestamp } from "@ytauto/db";

function wordsFor(text: string, startAt: number): WordTimestamp[] {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((word, i) => ({
      word,
      startSec: startAt + i * 0.4,
      endSec: startAt + i * 0.4 + 0.3,
    }));
}

describe("buildShortProps", () => {
  const beats: ScriptBeat[] = [
    { type: "hook", text: "one two three", imagePrompt: "a" },
    { type: "insight", text: "four five", imagePrompt: "b" },
    { type: "cta", text: "six", imagePrompt: "c" },
  ];
  const words = [
    ...wordsFor("one two three", 0),
    ...wordsFor("four five", 1.5),
    ...wordsFor("six", 2.5),
  ];

  it("maps beat boundaries onto the word timestamp stream", () => {
    const props = buildShortProps({
      beats,
      words,
      imageSrcs: ["img0", "img1", "img2"],
      audioSrc: "audio",
      durationSec: 4,
      brand: { primaryColor: "#fff", font: "Inter" },
    });

    expect(props.beats).toHaveLength(3);
    expect(props.beats[0]!.startSec).toBe(0);
    // beats tile the timeline with no gaps
    expect(props.beats[1]!.startSec).toBe(props.beats[0]!.endSec);
    expect(props.beats[2]!.startSec).toBe(props.beats[1]!.endSec);
    // last beat runs to the end of the audio
    expect(props.beats[2]!.endSec).toBe(4);
    // beat 0 ends just after its last word ("three" ends at 1.1)
    expect(props.beats[0]!.endSec).toBeCloseTo(1.15, 5);
    expect(props.beats.map((b) => b.imageSrc)).toEqual(["img0", "img1", "img2"]);
    expect(props.captions).toHaveLength(6);
  });

  it("stays within duration even if word counts mismatch", () => {
    const props = buildShortProps({
      beats,
      words: words.slice(0, 3), // TTS returned fewer words than the script
      imageSrcs: ["img0", "img1", "img2"],
      audioSrc: "audio",
      durationSec: 3,
      brand: { primaryColor: "#fff", font: "Inter" },
    });
    for (const b of props.beats) {
      expect(b.endSec).toBeLessThanOrEqual(3);
      expect(b.endSec).toBeGreaterThanOrEqual(b.startSec);
    }
  });
});
