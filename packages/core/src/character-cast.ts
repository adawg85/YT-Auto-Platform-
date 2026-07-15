/**
 * Character casting frequency (2026-07-15). A channel character's `cast_mode`
 * controls how often the pipeline FORCES it into a generated shot, on top of
 * whatever the image-prompt builder casts on its own:
 *  - "off"    — never cast
 *  - "auto"   — builder discretion only (no forcing)
 *  - "25"/"50"/"75" — force into ~that % of shots, spread evenly by index
 *  - "always" — every generated shot (mascot)
 *
 * Selection is DETERMINISTIC by shot index (never Math.random) so Inngest
 * resumes/retries and "Regenerate all visuals" reproduce the same casting.
 */
export const CHARACTER_CAST_MODES = ["off", "auto", "25", "50", "75", "always"] as const;
export type CharacterCastMode = (typeof CHARACTER_CAST_MODES)[number];

/** Should the mascot be forced into the shot at this index? Even spread; the
 * first shot casts under every percentage (a character-forward opener). */
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
      return false; // "off" / "auto" / unknown — no forcing
  }
}
