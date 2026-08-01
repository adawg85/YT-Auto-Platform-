/**
 * Terminal YouTube upload errors — the channel's OWN account limits, not a
 * transient failure. Retrying these only burns more of the daily allowance
 * (every upload attempt counts against the cap even though nothing publishes),
 * so the pipeline must HALT on them instead of letting Inngest retry.
 *
 * `uploadLimitExceeded` ("The user has exceeded the number of videos they may
 * upload") is YouTube's per-account daily upload-COUNT cap. It slips past the
 * platform's own quota gate because that gate accounts for API quota units,
 * while this limit is enforced by YouTube at upload time per channel. It resets
 * at midnight US Pacific.
 */
export function isTerminalUploadLimit(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("uploadlimitexceeded") ||
    m.includes("number of videos they may upload") ||
    m.includes("exceeded the number of videos")
  );
}

/** Operator-facing explanation for a halted upload-limit production. */
export const UPLOAD_LIMIT_HALT_MESSAGE =
  "YouTube upload limit reached (uploadLimitExceeded) — the channel's daily upload " +
  "allowance is used up. It resets at midnight US Pacific (~5pm AEST). Do NOT retry " +
  "until then: every attempt counts against the cap even though nothing publishes. " +
  "The render is kept — use Publish what's built once the limit resets.";
