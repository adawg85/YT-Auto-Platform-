import { describe, expect, it } from "vitest";
import { buildShortProps } from "../src/props";
import type { Shot } from "@ytauto/core";
import type { WordTimestamp } from "@ytauto/db";

const shots: Shot[] = [
  { beatIndex: 0, type: "hook", text: "one two three", imagePrompt: "A", referenceEntity: null, visualBrief: null, heroShot: false, startSec: 0, endSec: 1.5 },
  { beatIndex: 0, type: "hook", text: "four five", imagePrompt: "A2", referenceEntity: null, visualBrief: null, heroShot: false, startSec: 1.5, endSec: 3 },
  { beatIndex: 1, type: "cta", text: "six", imagePrompt: "B", referenceEntity: null, visualBrief: null, heroShot: false, startSec: 3, endSec: 4 },
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

  it("omits the music bed by default and when volume is zero/absent", () => {
    expect(buildShortProps(base).musicSrc).toBeUndefined();
    // a src with no (or zero) volume is not a bed
    expect(buildShortProps({ ...base, musicSrc: "music" }).musicSrc).toBeUndefined();
    expect(buildShortProps({ ...base, musicSrc: "music", musicVolume: 0 }).musicSrc).toBeUndefined();
  });

  it("carries the ducked music bed through when a src + volume are set", () => {
    const props = buildShortProps({ ...base, musicSrc: "music", musicVolume: 0.12 });
    expect(props.musicSrc).toBe("music");
    expect(props.musicVolume).toBe(0.12);
  });

  it("gates captions on the profile flag (Production Profile #18)", () => {
    expect(buildShortProps(base).captions).toHaveLength(6); // default on
    expect(buildShortProps({ ...base, captions: true }).captions).toHaveLength(6);
    const off = buildShortProps({ ...base, captions: false });
    expect(off.captions).toHaveLength(0);
    expect(off.beats).toHaveLength(3); // beats/timing untouched
  });

  describe("per-beat Ken Burns (#114)", () => {
    const motion = { kind: "alternate" as const, amount: 0.12, transition: "cut" as const, transitionMs: 0 };

    it("omits per-beat stillMotion entirely when the axis is unset", () => {
      const props = buildShortProps(base);
      expect(props.stillMotion).toBeUndefined();
      for (const b of props.beats) expect(b.stillMotion).toBeUndefined();
    });

    it("resolves 'alternate' to push/pull by shot parity, per beat", () => {
      const props = buildShortProps({ ...base, stillMotion: motion });
      expect(props.beats.map((b) => b.stillMotion?.kind)).toEqual(["slow_push", "slow_pull", "slow_push"]);
      // the global echo (for old bundles) carries a CONCRETE kind, never "alternate"
      expect(props.stillMotion?.kind).toBe("slow_push");
    });

    it("scales each beat's amount to its own hold length when the rate is set", () => {
      const props = buildShortProps({ ...base, stillMotion: motion, stillMotionRatePctPerSec: 2 });
      // 2%/sec × 1.5s = 0.03, floored at the 0.04 minimum visible travel
      expect(props.beats[0]!.stillMotion?.amount).toBeCloseTo(0.04);
      // 2%/sec × 1s = 0.02 → floor again; a longer hold scales up
      const long = buildShortProps({
        ...base,
        durationSec: 30,
        shots: [{ ...shots[0]!, startSec: 0, endSec: 28 }],
        imageSrcs: ["img0"],
        stillMotion: motion,
        stillMotionRatePctPerSec: 1.2,
      });
      expect(long.beats[0]!.stillMotion?.amount).toBeCloseTo(0.336);
    });

    it("keeps the legacy fixed amount on every beat when no rate is set", () => {
      const props = buildShortProps({ ...base, stillMotion: { ...motion, kind: "drift" } });
      for (const b of props.beats) {
        expect(b.stillMotion?.kind).toBe("drift");
        expect(b.stillMotion?.amount).toBeCloseTo(0.12);
      }
    });
  });
});
