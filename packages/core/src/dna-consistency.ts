/**
 * DNA consistency heuristics surfaced on get_channel_config's consistencyWarnings
 * (tickets 01KY6D8F… / 01KY6FGE…). Pure + testable so the checks that flag a
 * corrupted config can't drift from what the tool actually reports.
 */

import type { LengthPolicy } from "@ytauto/db";

/**
 * #48 (ticket 01KY9E15…): flag a stored soft anchor (targetLengthSec) that sits
 * BELOW the channel's own HARD lengthPolicy.floorSec, or outside every declared
 * band. #46 clamped the DERIVED suggestion; this catches the AUTHORED value on the
 * other side of the same policy — a legacy targetLengthSec under a later-declared
 * floor forfeits YouTube mid-rolls, and nothing flagged it on read or write. Pure +
 * unit-tested so the threshold logic can be verified without writing a sub-floor
 * value to a live channel (the reason the live check is awkward — the operator would
 * have to regress a real config to reproduce it). Pass the RESOLVED policy.
 */
export function lengthPolicyFloorWarnings(targetLengthSec: number, policy: LengthPolicy): string[] {
  const warnings: string[] = [];
  if (!(targetLengthSec > 0)) return warnings;
  if (policy.floorSec > 0 && targetLengthSec < policy.floorSec) {
    warnings.push(
      `DNA targetLengthSec is ${targetLengthSec}s but lengthPolicy.floorSec (the HARD floor) is ${policy.floorSec}s — the soft anchor sits ${policy.floorSec - targetLengthSec}s below the channel's own hard floor, so an author writing to it forfeits YouTube mid-roll eligibility. Raise targetLengthSec to ≥ ${policy.floorSec}s (or lower floorSec if the floor itself is wrong).`,
    );
    return warnings;
  }
  const bands = Array.isArray(policy.bands) ? policy.bands : [];
  if (bands.length > 0 && !bands.some((b) => targetLengthSec >= b.minSec && targetLengthSec <= b.maxSec)) {
    const ranges = bands.map((b) => `${b.name} ${b.minSec}-${b.maxSec}s`).join(", ");
    warnings.push(
      `DNA targetLengthSec is ${targetLengthSec}s but falls outside every declared lengthPolicy band (${ranges}) — the soft anchor doesn't match any runtime target the beat map picks from.`,
    );
  }
  return warnings;
}

// A hook-style entry that BEGINS with a lowercase continuation word (a clause
// tail) is the signature of the old comma-split bug — e.g. "then rewind to…",
// "or a quotation…", "the flight that changed everything". Case-sensitive on
// purpose: a deliberate entry is Capitalised ("The reveal", "Open on…") or a
// snake_case token ("curiosity_gap"); only a shredded tail starts lowercase
// with one of these joiner words. Kept narrow to avoid false positives.
const LEADING_CONTINUATION = /^(then|or|and|but|nor|so|yet|the|a|an)\s+/;

/**
 * Flag hookStyles entries that look like comma-split fragments rather than hook
 * styles (ticket 01KY6FGE…): a clause-tail beginning with a lowercase joiner, or
 * an entry carrying an unbalanced close-paren (e.g. "1947)"). High-precision so
 * the warning doesn't cry wolf on legitimate snake_case or Capitalised styles.
 * A single flagged entry means the whole list was shredded — the operator should
 * rewrite hookStyles as whole entries.
 */
export function fragmentedHookStyleWarnings(hookStyles: string[]): string[] {
  const entries = (hookStyles ?? []).map((h) => (typeof h === "string" ? h.trim() : "")).filter(Boolean);
  if (entries.length < 2) return [];
  const suspects = entries.filter(
    (e) => LEADING_CONTINUATION.test(e) || (e.includes(")") && !e.includes("(")),
  );
  if (suspects.length === 0) return [];
  return [
    `hookStyles has ${suspects.length} entr${suspects.length === 1 ? "y" : "ies"} that look like comma-split fragments, not hook styles: ${suspects
      .map((s) => `"${s}"`)
      .join(", ")}. This is the signature of the pre-fix comma-split bug (tickets 01KY6D8F…/01KY6FGE…) — entries were shredded on their commas at provisioning. Rewrite hookStyles as whole entries (one per line in the cockpit Persona/Settings tab, or the full array via set_channel_config); commas inside an entry are now stored verbatim.`,
  ];
}
