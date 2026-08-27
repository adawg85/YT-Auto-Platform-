/**
 * #132: the Shorts Content-ID trap — why a track that is fine on long-form kills
 * a Short, and what the platform is allowed to do about it.
 *
 * YouTube's rule, verbatim: "Shorts longer than one minute that have an active
 * Content ID claim, REGARDLESS OF THE POLICY, will be blocked on YouTube." So on
 * a Short over 60s the claim's own terms are irrelevant — its mere existence is
 * the block, the video is dead globally on upload, and the credit in the
 * description cannot release it, because a credit answers attribution, not
 * duration.
 *
 * What this cost, and why the flag is per TRACK rather than per catalogue: two
 * Scott Buckley tracks were capped by their claimant within three days (Phoenix
 * 2026-08-25, Aphelion 2026-08-27), each taking a finished ~150s Short down with
 * it. The rest of the same catalogue kept publishing fine over the same window —
 * Reverie went live the day AFTER the Phoenix cap with 127 views, which is the
 * control that rules out a catalogue-wide change. Blanket-refusing every
 * Content-ID-registered track would therefore have thrown away a music library
 * that mostly works.
 *
 * The honest limit: Content ID membership and per-track policies are NOT publicly
 * queryable — the rights holder's own "affected tracks" page listed neither
 * Phoenix nor Aphelion. Nothing here predicts a cap. `shortsBlocked` records one
 * that was OBSERVED, so the same block is never bought twice; the `warn` level
 * says only that the ingredients are present.
 */

/** YouTube's threshold: at or under this, a claim does not auto-block a Short. */
export const SHORTS_CLAIM_BLOCK_THRESHOLD_SEC = 60;

export type ShortsClaimTrack = {
  name?: string | null;
  /** the claimant's catalogue is in Content ID → a claim fires on upload */
  contentIdRegistered?: boolean | null;
  /** OBSERVED to have blocked a Short (a duration cap), not merely claimed */
  shortsBlocked?: boolean | null;
  shortsBlockedNote?: string | null;
};

export type ShortsClaimRisk = {
  /** block: refuse — this exact track already killed a Short.
   *  warn: the ingredients are present; only an upload can tell. */
  level: "block" | "warn";
  reason: string;
} | null;

/** Does this channel publish Shorts? `both` can, so it counts. */
export function publishesShorts(contentFormat: string | null | undefined): boolean {
  return contentFormat === "short" || contentFormat === "both";
}

/**
 * Judge one track against one destination.
 *
 * `durationSec` is the video's projected runtime; pass null when it is not known
 * yet (attaching to a channel bed, where the length varies per video). A null
 * duration on a Shorts channel still WARNS, because the channel's videos are
 * routinely over the threshold — it just cannot be specific about which.
 */
export function shortsClaimRisk(opts: {
  contentFormat: string | null | undefined;
  durationSec?: number | null;
  track: ShortsClaimTrack;
}): ShortsClaimRisk {
  const { contentFormat, durationSec, track } = opts;
  // Long-form is untouched by this rule: there a claim monetises, it does not
  // block. Refusing a track there would be pure loss.
  if (!publishesShorts(contentFormat)) return null;

  const name = track.name ? `"${track.name}"` : "this track";
  if (track.shortsBlocked) {
    return {
      level: "block",
      reason:
        `${name} has already had a Short BLOCKED by its Content ID claim — a claimant duration cap, which no credit wording releases. ` +
        (track.shortsBlockedNote?.trim()
          ? `Recorded reason: ${track.shortsBlockedNote.trim().split("\n")[0]} `
          : "") +
        `Pick a different track; it remains usable on long-form, where a claim monetises instead of blocking.`,
    };
  }
  if (!track.contentIdRegistered) return null;

  // Known to be at or under the threshold → a claim will not auto-block.
  if (typeof durationSec === "number" && durationSec <= SHORTS_CLAIM_BLOCK_THRESHOLD_SEC) return null;

  const length =
    typeof durationSec === "number"
      ? `This video runs ~${Math.round(durationSec)}s`
      : `This channel's Shorts routinely run over ${SHORTS_CLAIM_BLOCK_THRESHOLD_SEC}s`;
  return {
    level: "warn",
    reason:
      `${name} is from a Content-ID-registered catalogue, so a claim fires on upload. ${length}, and YouTube blocks any Short over ` +
      `${SHORTS_CLAIM_BLOCK_THRESHOLD_SEC}s that carries an active claim regardless of the claim's policy — the credit does not release that. ` +
      `It only actually blocks if the claimant has capped this track's duration, which is not knowable before upload. If the Short is blocked, ` +
      `flag the asset shortsBlocked so nothing picks it again.`,
  };
}
