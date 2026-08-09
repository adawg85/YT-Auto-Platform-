/**
 * DNA consistency heuristics surfaced on get_channel_config's consistencyWarnings
 * (tickets 01KY6D8F… / 01KY6FGE…). Pure + testable so the checks that flag a
 * corrupted config can't drift from what the tool actually reports.
 */

import type { LengthPolicy } from "@ytauto/db";

/** Audience language that implies an under-13 (COPPA) audience. */
const KID_AUDIENCE = /\b(kids?|children|under[- ]?13|ages?\s*\d{1,2}\s*[-–]\s*1[0-2]\b|8\s*[-–]\s*14|toddlers?|preschool|elementary)\b/i;
/** Features YouTube DISABLES on Made-for-Kids content (so a charter can't rely on them). */
const MFK_DISABLED_FEATURE = /\b(end[- ]?cards?|end[- ]?screens?|cards?|notification bell|comments?|save[- ]to[- ]playlist)\b/i;

/**
 * #53 (ticket 01KY9EDC…): surface Made-for-Kids (COPPA) inconsistencies. Two cases:
 * (1) an under-13 audience with madeForKids still UNDECLARED (a compliance gap —
 * YouTube's classifier may set it and silently disable features), and (2) a channel
 * that is (or looks) MFK but whose charter objectives depend on a feature MFK
 * disables — end-cards/cards, the notification bell, comments, save-to-playlist.
 * The Atom & Friends case: an objective commits to "end-cards for chained viewing"
 * that the designation removes.
 */
export function madeForKidsWarnings(input: {
  madeForKids: boolean | null;
  audiencePersona?: string | null;
  objectives?: string[];
}): string[] {
  const warnings: string[] = [];
  const audienceIsKids = KID_AUDIENCE.test(input.audiencePersona ?? "");
  const objText = (input.objectives ?? []).join(" ");
  const isMfk = input.madeForKids === true;
  const undeclaredKids = input.madeForKids == null && audienceIsKids;
  if (undeclaredKids) {
    warnings.push(
      "audiencePersona describes an under-13 audience but madeForKids is UNDECLARED (null) — YouTube's Made-for-Kids/COPPA designation isn't set. Declare it (set_channel_config madeForKids: true/false); left undeclared, YouTube's classifier may set it for you, silently disabling comments, end-cards, the notification bell and personalised ads.",
    );
  }
  if ((isMfk || undeclaredKids) && MFK_DISABLED_FEATURE.test(objText)) {
    warnings.push(
      `${isMfk ? "This channel is Made for Kids" : "This channel looks Made for Kids (under-13 audience, designation undeclared)"}, but a charter objective commits to a feature YouTube DISABLES on MFK content (end-cards / cards / the notification bell / comments / save-to-playlist). Carry chained viewing verbally and via playlists + description instead of end-cards, and don't write comment CTAs — the script author reads madeForKids for exactly this.`,
    );
  }
  return warnings;
}

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

// #109: temporal words with no defined boundary. "recent-era losses" read a 1988
// incident as recent on one evaluation and would read it as historical on another
// — an unbounded qualifier in forbiddenTopics is a non-deterministic filter.
// Kept to genuinely boundary-less words; "since 2000" / "within the last 25
// years" / "post-1980" style bounds suppress the warning.
const UNBOUNDED_TEMPORAL = /\b(recent(?:[-\s]era)?|modern(?:[-\s]day)?|current|contemporary|nowadays|these days|lately)\b/i;
const TEMPORAL_BOUND = /\b(?:19|20)\d{2}\b|\blast\s+\d+\s+(?:years?|decades?)\b|\bpost[-\s]?(?:19|20)\d{2}\b/i;

/**
 * #109: flag forbiddenTopics entries whose temporal qualifier has no boundary.
 * The Wings & Stories case: "recent-era losses with living relatives" silently
 * excluded a 1988 incident — the niche's highest-performing subject — because
 * "recent-era" is whatever the evaluating model decides that day. Advisory,
 * surfaced at write time (set_channel_config) and on read (consistencyWarnings).
 */
export function unboundedTemporalWarnings(forbiddenTopics: string[]): string[] {
  const warnings: string[] = [];
  for (const raw of forbiddenTopics ?? []) {
    const entry = typeof raw === "string" ? raw.trim() : "";
    if (!entry) continue;
    const m = entry.match(UNBOUNDED_TEMPORAL);
    if (m && !TEMPORAL_BOUND.test(entry)) {
      warnings.push(
        `forbiddenTopics entry "${entry}" uses "${m[0]}" with no defined boundary — the evaluating model applies it inconsistently (a 1988 incident was read as "recent-era" in practice, #109). Add a year or span ("after 1980", "within the last 25 years") so the filter is deterministic.`,
      );
    }
  }
  return warnings;
}

/** #109: the persisted write-time titleTemplates-vs-forbiddenTopics verdict.
 * #113: findings carry the faithful instance that proves the contradiction. */
export type DnaConsistencyFindings = {
  checkedAt: string;
  findings: { templateName: string; forbiddenTopic: string; evidence: string; faithfulInstance?: string }[];
};

/**
 * #109: replay the stored write-time contradiction verdict as warning strings on
 * get_channel_config — pure, so the read path stays LLM-free and un-billed.
 */
export function storedConsistencyWarnings(stored: DnaConsistencyFindings | null | undefined): string[] {
  if (!stored?.findings?.length) return [];
  return stored.findings.map(
    (f) =>
      `titleTemplates family "${f.templateName}" CONTRADICTS forbiddenTopics entry "${f.forbiddenTopic}" — ${f.evidence}${f.faithfulInstance ? ` (a faithful instance that violates: "${f.faithfulInstance}")` : ""} (flagged at write time; review_slate will block faithful instances of this family). Reword one side, or accept a specific block with accept_slate_finding instead of weakening the standing rule.`,
  );
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
