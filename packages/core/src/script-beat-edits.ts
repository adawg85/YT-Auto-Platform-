/**
 * #88 — pure beat-edit application, split out of the cockpit action so the rule
 * set is unit-testable without a database.
 *
 * Ticket 01KYVE4AAY… reported that with `author_script` unreachable there was no
 * way to inject operator-authored content: `edit_script_beats` took a POSITIONAL
 * array of narration strings whose length had to equal the platform-generated
 * beat count (which the operator does not control), and it replaced narration
 * ONLY — so all shot direction reverted to platform generation, which on a
 * Made-for-Kids channel is the exact surface #65 is about.
 *
 * This applies SPARSE edits addressed by index, carrying both the words and the
 * visual direction. Two properties matter enough to be tested rather than
 * assumed:
 *
 *  - an unlisted beat comes through byte-identical (editing beat 3 of 16 must not
 *    perturb the other 15);
 *  - `narrationChanged` is true only when spoken text actually DIFFERS. The
 *    caller tears down the voiceover/render on that flag, so a visuals-only edit
 *    must leave it false — otherwise authoring visual direction silently recuts
 *    the audio, which is both slow and a cost the operator didn't ask for.
 */
import type { ScriptBeat } from "@ytauto/db";

/** One operator-authored edit to a single beat, addressed by index. */
export type ScriptBeatEdit = {
  /** 0-based index into the draft's current beats */
  index: number;
  text?: string;
  imagePrompt?: string;
  /** #69: ordered per-shot prompts for the shots this beat fans into */
  imagePrompts?: (string | null)[];
  /** empty string / null clears it */
  referenceEntity?: string | null;
  visualBrief?: string | null;
  motionPrompt?: string | null;
  animates?: boolean;
};

/** Discriminated on `ok` so a caller cannot read the beats without checking. */
export type ScriptBeatEditResult =
  | { ok: false; error: string }
  | {
      ok: true;
      beats: ScriptBeat[];
      /** indices actually addressed, ascending */
      editedBeats: number[];
      /** spoken text differs from before — the caller must recut the voiceover */
      narrationChanged: boolean;
      /** #117: the SUBSET of editedBeats whose spoken text actually changed —
       * the per-beat scope for invalidating recorded voiceover takes (a
       * visuals-only edit to a beat must not touch its takes). Ascending. */
      narrationEditedBeats: number[];
      /** visual direction changed — free; nothing needs re-rendering yet */
      visualsChanged: boolean;
    };

/** Words-per-second used to re-estimate a beat's spoken length after a reword. */
const SPEAKING_WPS = 2.5;

/** Trim to a value, mapping empty to null — how a "clear it" edit is expressed. */
function trimOrNull(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
}

export function estimateBeatSeconds(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round((words / SPEAKING_WPS) * 10) / 10);
}

/**
 * Apply sparse per-index edits to a draft's beats. Never mutates its input.
 *
 * Errors (rather than silently skipping) on an out-of-range index and names the
 * real beat count — an MCP caller can't "reload and try again" the way the
 * cockpit editor can, so the message has to carry the remedy.
 */
export function applyScriptBeatEdits(beats: ScriptBeat[], edits: ScriptBeatEdit[]): ScriptBeatEditResult {
  if (!edits.length) return { ok: false, error: "Pass at least one beat edit." };

  const bad = edits.filter((e) => !Number.isInteger(e.index) || e.index < 0 || e.index >= beats.length);
  if (bad.length) {
    return {
      ok: false,
      error:
        `Beat index out of range: ${bad.map((b) => b.index).join(", ")}. ` +
        `This draft has ${beats.length} beats, so valid indices are 0-${beats.length - 1}. ` +
        `Read the current beats with get_production first and edit by index.`,
    };
  }

  // Later edits to the same index merge over earlier ones, so a caller repeating
  // an index refines rather than conflicts.
  const byIndex = new Map<number, ScriptBeatEdit>();
  for (const e of edits) byIndex.set(e.index, { ...(byIndex.get(e.index) ?? {}), ...e });

  let narrationChanged = false;
  let visualsChanged = false;
  const narrationEditedBeats: number[] = [];
  const next = beats.map((b, i) => {
    const e = byIndex.get(i);
    if (!e) return b; // untouched beats pass through by reference
    const beat: ScriptBeat = { ...b };
    if (typeof e.text === "string") {
      const text = e.text.trim();
      if (text !== b.text) {
        narrationChanged = true;
        narrationEditedBeats.push(i);
      }
      beat.text = text;
      beat.estSec = estimateBeatSeconds(text);
    }
    if (typeof e.imagePrompt === "string") {
      beat.imagePrompt = e.imagePrompt.trim();
      visualsChanged = true;
    }
    if (Array.isArray(e.imagePrompts)) {
      beat.imagePrompts = e.imagePrompts.map((p) => (typeof p === "string" ? p.trim() : null));
      visualsChanged = true;
    }
    if (e.referenceEntity !== undefined) {
      beat.referenceEntity = trimOrNull(e.referenceEntity);
      visualsChanged = true;
    }
    if (e.visualBrief !== undefined) {
      beat.visualBrief = trimOrNull(e.visualBrief);
      visualsChanged = true;
    }
    if (e.motionPrompt !== undefined) {
      beat.motionPrompt = trimOrNull(e.motionPrompt);
      visualsChanged = true;
    }
    if (typeof e.animates === "boolean") {
      beat.animates = e.animates;
      visualsChanged = true;
    }
    return beat;
  });

  if (next.some((b) => !b.text)) return { ok: false, error: "A beat is empty — every beat needs spoken text." };

  return {
    ok: true,
    beats: next,
    editedBeats: [...byIndex.keys()].sort((a, b) => a - b),
    narrationChanged,
    narrationEditedBeats,
    visualsChanged,
  };
}
