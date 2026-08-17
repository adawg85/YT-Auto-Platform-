import { describe, it, expect } from "vitest";
import {
  alignmentBreakdown,
  checkAssemblyPlan,
  expectedAssemblyPieces,
  narrationDriftShots,
  narrationFingerprint,
} from "../src/voiceover-plan";
import { FULL_NARRATION_TAKE_IDX, narrationSegments, segmentTakeIdx } from "../src/narration-segments";

/**
 * #123: two operator-narrated productions assembled a track whose piece count
 * disagreed with the script's segment count — in OPPOSITE directions (94 pieces
 * from 106 recorded takes; 26 from 25) — and both advanced to visuals anyway.
 * The cause was the pipeline planning the assembly from a pre-edit, in-memory
 * copy of the script across the voiceover gate.
 */

// Segments group sentences up to ~25 words, so each sentence here is long
// enough to stand as its own take — the shape a real long-form beat has.
const S = (n: number) =>
  `Sentence number ${n} runs long enough on its own that the segmenter gives it a card of its very own here.`;
const beats = [
  { text: `${S(1)} ${S(2)}` },
  { text: S(3) },
  { text: `${S(4)} ${S(5)}` },
];
const segmentsOf = (bs: { text: string }[]) => narrationSegments(bs).length;

describe("#123 expected assembly pieces", () => {
  it("is one piece per narration segment when every beat is segment-recorded", () => {
    expect(expectedAssemblyPieces(beats, [])).toBe(segmentsOf(beats));
  });

  it("a whole-script take is ONE piece, not one per segment", () => {
    expect(expectedAssemblyPieces(beats, [FULL_NARRATION_TAKE_IDX])).toBe(1);
  });

  it("a LEGACY whole-beat take contributes one piece for that beat", () => {
    // beat 2 has 2 segments; a legacy take collapses them to one piece
    const withLegacy = expectedAssemblyPieces(beats, [2]);
    expect(withLegacy).toBe(segmentsOf(beats) - (segmentsOf([beats[2]!]) - 1));
  });

  it("segment takes do not change the count — they fill pieces that already exist", () => {
    const takes = narrationSegments(beats).map((s) => s.takeIdx);
    expect(expectedAssemblyPieces(beats, takes)).toBe(segmentsOf(beats));
  });
});

describe("#123 the 1:1 guard is fail-closed", () => {
  it("passes when the assembly matches the live script", () => {
    const check = checkAssemblyPlan({
      assembledPieces: segmentsOf(beats),
      beats,
      takeIdxs: narrationSegments(beats).map((s) => s.takeIdx),
    });
    expect(check.ok).toBe(true);
  });

  it("FAILS when the track has fewer pieces than the script implies (the 94-vs-106 case)", () => {
    const check = checkAssemblyPlan({
      assembledPieces: segmentsOf(beats) - 2,
      beats,
      takeIdxs: [],
    });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.expected).toBe(segmentsOf(beats));
    expect(check.reason).toContain("FEWER");
    expect(check.reason).toContain("reopen_stage('voiceover')");
  });

  it("FAILS when the track has a phantom extra piece (the 26-vs-25 case)", () => {
    const check = checkAssemblyPlan({ assembledPieces: segmentsOf(beats) + 1, beats, takeIdxs: [] });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.reason).toContain("MORE");
  });

  it("does NOT fire on the legitimate whole-script take (1 piece, many segments)", () => {
    const check = checkAssemblyPlan({
      assembledPieces: 1,
      beats,
      takeIdxs: [FULL_NARRATION_TAKE_IDX],
    });
    expect(check.ok).toBe(true);
  });

  it("does NOT fire when a legacy whole-beat take collapses that beat's segments", () => {
    const expected = expectedAssemblyPieces(beats, [0]);
    expect(checkAssemblyPlan({ assembledPieces: expected, beats, takeIdxs: [0] }).ok).toBe(true);
    // and the un-collapsed count is now the WRONG one, which is the point
    expect(checkAssemblyPlan({ assembledPieces: segmentsOf(beats), beats, takeIdxs: [0] }).ok).toBe(false);
  });

  it("the reported repro: an edit shrinks the script, the stale plan keeps the old piece", () => {
    const before = [{ text: `${S(1)} ${S(2)}` }];
    const after = [{ text: S(1) }]; // the second sentence was removed by edit_script_beats
    const stalePieces = expectedAssemblyPieces(before, []);
    expect(checkAssemblyPlan({ assembledPieces: stalePieces, beats: after, takeIdxs: [] }).ok).toBe(false);
    // and the freshly-planned assembly passes
    expect(
      checkAssemblyPlan({ assembledPieces: expectedAssemblyPieces(after, []), beats: after, takeIdxs: [] }).ok,
    ).toBe(true);
  });
});

describe("#123 narration fingerprint", () => {
  it("is stable across whitespace re-joins of the same text", () => {
    expect(narrationFingerprint("one two\n\nthree")).toBe(narrationFingerprint("one two three"));
    expect(narrationFingerprint("  one two three  ")).toBe(narrationFingerprint("one two three"));
  });

  it("changes when a single word changes — a one-sentence edit is detectable", () => {
    expect(narrationFingerprint("That one's from Robert Greene.")).not.toBe(
      narrationFingerprint("That is from Robert Greene."),
    );
  });

  it("changes when a sentence is deleted", () => {
    const before = "A sentence. It genuinely is the thing that lets us keep making them.";
    expect(narrationFingerprint(before)).not.toBe(narrationFingerprint("A sentence."));
  });
});

describe("#123 alignment breakdown reconciles", () => {
  it("whisper + estimated + tts always equals pieces (the 91 + 0 vs 94 case)", () => {
    const sources = [
      ...Array.from({ length: 91 }, () => ({ source: "operator", aligned: "whisper" })),
      ...Array.from({ length: 3 }, () => ({ source: "tts", aligned: "tts" })),
    ];
    const a = alignmentBreakdown(sources);
    expect(a).toMatchObject({ whisper: 91, estimated: 0, tts: 3, pieces: 94, unaccounted: 0 });
    expect(a.whisper + a.estimated + a.tts).toBe(a.pieces);
  });

  it("separates operator-estimated (captions drift) from any other estimated piece", () => {
    const a = alignmentBreakdown([
      { source: "operator", aligned: "estimated" },
      { source: "tts", aligned: "estimated" },
      { source: "operator", aligned: "whisper" },
    ]);
    expect(a.estimated).toBe(2);
    expect(a.estimatedOperator).toBe(1);
    expect(a.unaccounted).toBe(0);
  });

  it("surfaces a piece whose alignment value is unrecognised instead of hiding it", () => {
    const a = alignmentBreakdown([{ source: "operator" }, { source: "operator", aligned: "whisper" }]);
    expect(a.unaccounted).toBe(1);
  });
});

describe("#123 shots cut from a superseded script", () => {
  const script = "That one's from Robert Greene. He wrote it decades ago. The book still sells.";

  it("flags a shot whose narration is not in the current script", () => {
    const drift = narrationDriftShots(
      [
        { idx: 0, narration: "That one's from Robert Greene." },
        { idx: 1, narration: "That is from Robert Greene's" }, // the pre-edit wording
        { idx: 2, narration: "It genuinely is the thing that lets us keep making them." }, // deleted sentence
      ],
      script,
    );
    expect(drift).toEqual([1, 2]);
  });

  it("tolerates smart quotes, dashes and whitespace differences", () => {
    expect(
      narrationDriftShots([{ idx: 0, narration: "That one’s from  Robert\nGreene." }], script),
    ).toEqual([]);
  });

  it("ignores very short fragments and empty narration", () => {
    expect(narrationDriftShots([{ idx: 0, narration: "He wrote" }, { idx: 1, narration: null }], script)).toEqual([]);
  });

  it("returns nothing when there is no script to compare against", () => {
    expect(narrationDriftShots([{ idx: 0, narration: "anything at all here" }], "")).toEqual([]);
  });
});
