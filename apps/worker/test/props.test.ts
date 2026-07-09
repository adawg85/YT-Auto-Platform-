import { describe, expect, it } from "vitest";
import { buildShortProps } from "../src/props";
import type { Shot } from "@ytauto/core";
import type { WordTimestamp } from "@ytauto/db";

const shots: Shot[] = [
  { beatIndex: 0, type: "hook", text: "one two three", imagePrompt: "A", referenceEntity: null, startSec: 0, endSec: 1.5 },
  { beatIndex: 0, type: "hook", text: "four five", imagePrompt: "A2", referenceEntity: null, startSec: 1.5, endSec: 3 },
  { beatIndex: 1, type: "cta", text: "six", imagePrompt: "B", referenceEntity: null, startSec: 3, endSec: 4 },
];
const words: WordTimestamp[] = "one two three four five six".split(" ").map((word, i) => ({
  word,
  startSec: i * 0.4,
  endSec: i * 0.4 + 0.3,
}));

describe("buildShortProps", () => {
  const base = {
    shots,
    imageSrcs: ["img0", "img1", "img2"],
    words,
    audioSrc: "audio",
    durationSec: 4,
    orientation: "portrait" as const,
    brand: { primaryColor: "#fff", font: "Inter" },
  };

  it("emits one props beat per shot, carrying its image and timing", () => {
    const props = buildShortProps(base);
    expect(props.beats).toHaveLength(3);
    expect(props.beats.map((b) => b.imageSrc)).toEqual(["img0", "img1", "img2"]);
    expect(props.beats[0]!.startSec).toBe(0);
    // shots tile without gaps
    expect(props.beats[1]!.startSec).toBe(props.beats[0]!.endSec);
    expect(props.beats[2]!.startSec).toBe(props.beats[1]!.endSec);
  });

  it("clamps a shot end to the audio duration", () => {
    const props = buildShortProps({ ...base, durationSec: 3.5 });
    expect(props.beats[2]!.endSec).toBeLessThanOrEqual(3.5);
  });

  it("carries orientation through", () => {
    expect(buildShortProps({ ...base, orientation: "landscape" }).orientation).toBe("landscape");
  });

  it("gates captions on the profile flag (Production Profile #18)", () => {
    expect(buildShortProps(base).captions).toHaveLength(6); // default on
    expect(buildShortProps({ ...base, captions: true }).captions).toHaveLength(6);
    const off = buildShortProps({ ...base, captions: false });
    expect(off.captions).toHaveLength(0);
    expect(off.beats).toHaveLength(3); // beats/timing untouched
  });
});
