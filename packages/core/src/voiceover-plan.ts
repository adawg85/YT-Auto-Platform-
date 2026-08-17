/**
 * Voiceover assembly integrity (#123).
 *
 * #103 fixed the per-piece file collision and added a 1:1 assertion — but that
 * assertion only checks that the pieces map to DISTINCT files. It cannot see the
 * failure this module exists for: the assembly plan being built from a DIFFERENT
 * script than the one the operator recorded against.
 *
 * The reported shape: `edit_script_beats` (#117) is allowed at the
 * `voiceover_recording` gate, and it rewrites the draft IN PLACE. The pipeline
 * run is parked in `waitForEvent` at that gate holding an in-memory copy of the
 * pre-edit script, so on approval it planned pieces from the SUPERSEDED beats —
 * 94 pieces against 106 recorded takes on one production (12 takes silently
 * unused, ~50s of narration missing), 26 against 25 on another (a piece from a
 * deleted sentence, in a voice the operator never recorded). Both then cut their
 * shot plan from that stale audio and advanced to `visuals_review`.
 *
 * Everything here is pure so the guards can be unit-tested with no DB, no ffmpeg
 * and no stored takes — none of which the sandbox has.
 */
import { FULL_NARRATION_TAKE_IDX, narrationSegments } from "./narration-segments";

/** A per-piece provenance record as stamped on the voiceover asset's meta. */
export type AssemblySource = {
  beatIdx?: number;
  segIdx?: number | null;
  source?: string;
  aligned?: string;
  durationSec?: number;
};

/**
 * How many pieces the CURRENT script + take set imply.
 *
 * Mirrors the pipeline's own plan, which is why the three legitimate shapes
 * survive the guard rather than tripping it:
 *  - a whole-script take (one DAW export) is ONE piece covering everything;
 *  - a LEGACY per-beat take (recorded before #101's segments) is one piece for
 *    that whole beat, not one per segment;
 *  - every other beat contributes one piece per narration segment, recorded or
 *    TTS-filled.
 */
export function expectedAssemblyPieces(beats: { text: string }[], takeIdxs: number[]): number {
  const takes = new Set(takeIdxs);
  if (takes.has(FULL_NARRATION_TAKE_IDX)) return 1;
  return beats.reduce((n, b, beatIdx) => {
    if (takes.has(beatIdx)) return n + 1; // legacy whole-beat take
    return n + Math.max(1, narrationSegments([{ text: b.text }]).length);
  }, 0);
}

export type PlanCheck =
  | { ok: true; expected: number; actual: number }
  | { ok: false; expected: number; actual: number; reason: string };

/**
 * The fail-closed 1:1 check #103 documented and did not enforce: the assembled
 * track must contain exactly the pieces the LIVE script implies.
 *
 * Called with beats re-read from the database at assembly time, so it catches
 * the stale-snapshot cause AND any future way the plan could drift — it compares
 * the assembled result against the current truth, not against the same in-memory
 * copy the plan was built from.
 */
export function checkAssemblyPlan(input: {
  /** pieces the assembler actually produced (sources.length) */
  assembledPieces: number;
  /** the LIVE script's beats, re-read at assembly time */
  beats: { text: string }[];
  /** every voiceover_take idx currently stored for the production */
  takeIdxs: number[];
}): PlanCheck {
  const expected = expectedAssemblyPieces(input.beats, input.takeIdxs);
  const actual = input.assembledPieces;
  if (expected === actual) return { ok: true, expected, actual };
  const drift = actual < expected ? "FEWER" : "MORE";
  return {
    ok: false,
    expected,
    actual,
    reason:
      `Voiceover assembly does not match the current script: the track was built from ${actual} piece(s) but this script's narration implies ${expected} ` +
      `(${drift} than it should have). That means the assembly ran against a different version of the script than the one stored now — the audio would be missing ` +
      `or duplicating narration, and every shot cut from it would carry superseded text. Nothing was published: the recorded takes are intact (each is stored under ` +
      `its own key), the run is held here instead of generating images. Re-assemble with reopen_stage('voiceover') — it re-reads the live script — then re-check ` +
      `get_production().voiceover: assembledPieces should equal segmentCount.`,
  };
}

/**
 * A stable fingerprint of the narration text the voiceover was cut from.
 *
 * Stamped on the voiceover asset at assembly and re-checked before the shot plan
 * is cut, so a track built from a superseded script can never silently become
 * the timing source for the shots (`edit_script_beats` returns
 * `visualsChanged: true`, which reads as though the plan follows; it does not).
 * Whitespace-insensitive so a re-join of the same beats compares equal.
 */
export function narrationFingerprint(text: string): string {
  const norm = (text ?? "").replace(/\s+/g, " ").trim();
  // FNV-1a, 32-bit — enough to detect an edit, cheap, and dependency-free
  let h = 0x811c9dc5;
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${norm.length.toString(36)}-${h.toString(36)}`;
}

/**
 * The alignment breakdown, reconciled (#123 item 4).
 *
 * The old report counted `whisper` and OPERATOR-`estimated` pieces only, so a
 * TTS-filled piece was in `pieces` but in neither bucket: the operator read
 * "whisper 91, estimated 0, pieces 94" and three pieces were unaccounted for in
 * the very field that exists to say whether captions track real delivery.
 * `whisper + estimated + tts` now always equals `pieces`; `unaccounted` is
 * non-zero only if a piece carries an alignment value this doesn't know about,
 * which is itself worth seeing.
 */
export function alignmentBreakdown(sources: AssemblySource[]): {
  whisper: number;
  estimated: number;
  tts: number;
  pieces: number;
  unaccounted: number;
  /** estimated pieces that are the OPERATOR's audio — the ones whose captions drift */
  estimatedOperator: number;
} {
  const whisper = sources.filter((s) => s.aligned === "whisper").length;
  const estimated = sources.filter((s) => s.aligned === "estimated").length;
  const tts = sources.filter((s) => s.aligned === "tts").length;
  return {
    whisper,
    estimated,
    tts,
    pieces: sources.length,
    unaccounted: sources.length - whisper - estimated - tts,
    estimatedOperator: sources.filter((s) => s.aligned === "estimated" && s.source === "operator").length,
  };
}

/** Normalize narration for comparison: whitespace, quote glyphs, case. */
function normalizeNarration(text: string): string {
  return (text ?? "")
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Shots whose stored narration is NOT found in the current script (#123).
 *
 * A shot's text is a contiguous run of SCRIPT words within one beat (the
 * aligner supplies timings, the script supplies the words), so on a healthy
 * production every shot's narration is a substring of the script. One that is
 * not was cut from a superseded version — the operator's tell was having to
 * eyeball `get_production_shots` against `get_script` line by line.
 *
 * Advisory, deliberately: on a pure-TTS production the words come from the
 * voice provider's own tokenization, which can legitimately differ. The
 * fail-closed guard is the fingerprint check before the shots are cut.
 */
export function narrationDriftShots(
  shots: { idx: number; narration?: string | null }[],
  scriptText: string,
): number[] {
  const hay = normalizeNarration(scriptText);
  if (!hay) return [];
  return shots
    .filter((s) => {
      const needle = normalizeNarration(s.narration ?? "");
      if (needle.length < 12) return false; // too short to judge
      return !hay.includes(needle);
    })
    .map((s) => s.idx);
}
