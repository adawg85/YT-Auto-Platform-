/**
 * Character casting frequency (2026-07-15). A channel character's `cast_mode`
 * controls how often the pipeline FORCES it into a generated shot, on top of
 * whatever the image-prompt builder casts on its own:
 *  - "off"    — never cast
 *  - "auto"   — builder discretion only (no forcing)
 *  - "smart"  — force into ~`cast_target`% of shots, chosen by IMPORTANCE
 *               (hero/named/opener beats first, diagram/text filler last),
 *               so the character lands where it matters and the cheap engine
 *               carries the establishing/diagram filler (2026-07-16 operator)
 *  - "25"/"50"/"75" — force into ~that % of shots (same importance selection)
 *  - "always" — every generated shot (mascot)
 *
 * Selection is DETERMINISTIC (never Math.random) so Inngest resumes/retries and
 * "Regenerate all visuals" reproduce the same casting. The legacy modulo helper
 * `castCharacterForShot` is kept for callers that only know a shot index; the
 * pipeline uses `selectForcedCharacterShots`, which sees the whole shot list and
 * places the character by importance rather than by a blind index stride.
 */
export const CHARACTER_CAST_MODES = ["off", "auto", "smart", "25", "50", "75", "always"] as const;
export type CharacterCastMode = (typeof CHARACTER_CAST_MODES)[number];

/** Default target for a fresh "smart" character (2026-07-16: mascot channels
 * read best around half to two-thirds presence, not every single frame). */
export const DEFAULT_CAST_TARGET = 55;

const clampPct = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

/**
 * The target share of shots a character should be forced into, or `null` when
 * the mode does no forcing ("off"/"auto"/unknown — builder discretion only).
 * "smart" reads the per-character `castTarget`; the fixed buckets ignore it.
 */
export function targetPctForCast(castMode: string, castTarget?: number | null): number | null {
  switch (castMode) {
    case "always":
      return 100;
    case "75":
      return 75;
    case "50":
      return 50;
    case "25":
      return 25;
    case "smart":
      return clampPct(castTarget ?? DEFAULT_CAST_TARGET);
    default:
      return null; // "off" / "auto" / unknown — no forcing
  }
}

/** Should the mascot be forced into the shot at this index? Legacy even-spread
 * helper (deterministic by index); the first shot casts under every percentage
 * (a character-forward opener). Kept for index-only callers + back-compat. */
export function castCharacterForShot(castMode: string, shotIndex: number): boolean {
  switch (castMode) {
    case "always":
      return true;
    case "75":
      return shotIndex % 4 !== 3; // 3 of every 4
    case "50":
      return shotIndex % 2 === 0; // every other
    case "25":
      return shotIndex % 4 === 0; // 1 of every 4
    default:
      return false; // "off" / "auto" / "smart" / unknown — no index-only forcing
  }
}

/** Signals the importance selection reads for each shot. */
export interface CastShotSignal {
  /** first shot of a hero/pivotal beat */
  heroShot?: boolean;
  /** beat type — "hook"/"cta" are presenter-forward, "stat"/"insight" often diagrams */
  type?: string | null;
  /** spoken narration for the shot */
  text?: string | null;
  /** the built (or draft) image prompt — read for diagram/text "filler" cues */
  prompt?: string | null;
  /** a character the prompt-builder already cast into this shot (any name) */
  builderCharacter?: string | null;
}

// Scene ideas that read best WITHOUT the character — diagrams, charts, text
// cards, maps, textures, establishing/abstract inserts. These are exactly the
// establishing/filler frames that should ride the cheap engine, so the
// character is placed elsewhere unless a very high target forces it here.
const FILLER_RE =
  /\b(diagram|schematic|chart|graph|infographic|timeline|flowchart|map|blueprint|cross[- ]?section|cutaway|periodic table|equation|formula|text|title card|caption|sign(?:age)?|logo|close[- ]?up of|macro|texture|pattern|wallpaper|abstract|montage|split[- ]?screen|landscape|cityscape|skyline|empty|establishing)\b/i;

/** Whole-name match (case-insensitive substring). Deliberately requires the
 * FULL name — matching a single token would over-fire ("atom" appears in every
 * sentence of an atom-science channel; "Dr Atom is thrilled" should still hit).
 * Also used to compare the builder's cast to the mascot, which is the exact
 * stored name. */
export const mentionsName = (name: string, ...fields: (string | null | undefined)[]) => {
  const nm = name.trim().toLowerCase();
  if (nm.length < 2) return false;
  return fields.some((f) => f?.toLowerCase().includes(nm));
};

/** Importance score for casting the mascot into a candidate shot (higher = more
 * fitting). Diagram/text filler scores negative so it's the last to be cast. */
function importance(shot: CastShotSignal, mascotName: string): number {
  let s = 0;
  if (shot.heroShot) s += 50;
  if (mentionsName(mascotName, shot.text, shot.prompt)) s += 40;
  if (shot.type === "hook" || shot.type === "cta") s += 15;
  if (FILLER_RE.test(`${shot.prompt ?? ""} ${shot.text ?? ""}`)) s -= 40;
  return s;
}

/** Pick `k` evenly-spaced entries from an ordered index list (deterministic),
 * so filler casting spreads across the timeline instead of clustering. */
function evenlySpaced(indices: number[], k: number): number[] {
  if (k <= 0) return [];
  if (k >= indices.length) return indices.slice();
  const out: number[] = [];
  const stride = indices.length / k;
  for (let j = 0; j < k; j++) out.push(indices[Math.floor(j * stride)]!);
  return out;
}

/**
 * Decide which shot indices the mascot is FORCED into, to hit ~`targetPct` of
 * the shots, chosen by importance rather than a blind index stride. Builder
 * picks of the mascot count toward the target (never removed). The remaining
 * budget goes first to importance-positive shots (hero/named/opener), then to
 * neutral shots spread evenly, and only lastly to diagram/text filler — so the
 * cheap engine carries the establishing frames and the character lands where it
 * reads. Returns the full set of forced indices (excludes shots the builder
 * cast a DIFFERENT character into — those are honoured separately).
 *
 * Deterministic: no Math.random; ties break by index.
 */
export function selectForcedCharacterShots(
  shots: CastShotSignal[],
  mascotName: string,
  targetPct: number,
): Set<number> {
  const n = shots.length;
  if (n === 0 || targetPct <= 0) return new Set();

  // shots the builder already cast the mascot into — free, always in
  const forced = new Set<number>();
  for (let i = 0; i < n; i++) {
    if (shots[i]!.builderCharacter && mentionsName(mascotName, shots[i]!.builderCharacter)) forced.add(i);
  }
  if (targetPct >= 100) {
    // mascot: every shot the builder didn't hand to a DIFFERENT character
    for (let i = 0; i < n; i++) {
      const bc = shots[i]!.builderCharacter;
      if (!bc || mentionsName(mascotName, bc)) forced.add(i);
    }
    return forced;
  }

  const want = Math.round((targetPct / 100) * n);
  if (forced.size >= want) return forced; // builder already meets/exceeds the target

  // candidates: shots with NO builder character (don't override another
  // character's scene) and not already forced.
  const candidates = [];
  for (let i = 0; i < n; i++) {
    if (forced.has(i)) continue;
    if (shots[i]!.builderCharacter) continue; // a different character owns this shot
    candidates.push(i);
  }

  const scored = candidates.map((i) => ({ i, score: importance(shots[i]!, mascotName) }));
  const positives = scored.filter((c) => c.score > 0).sort((a, b) => b.score - a.score || a.i - b.i);
  const neutral = scored.filter((c) => c.score === 0).map((c) => c.i);
  const filler = scored.filter((c) => c.score < 0).map((c) => c.i);

  let need = want - forced.size;
  // 1) important shots first (hero / named / opener)
  for (const c of positives) {
    if (need <= 0) break;
    forced.add(c.i);
    need--;
  }
  // 2) neutral filler spread evenly across the timeline
  if (need > 0) {
    for (const i of evenlySpaced(neutral, need)) forced.add(i);
    need = want - forced.size;
  }
  // 3) diagram/text filler only if a high target still demands more
  if (need > 0) {
    for (const i of evenlySpaced(filler, need)) forced.add(i);
  }
  return forced;
}
