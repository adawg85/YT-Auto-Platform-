/**
 * YouTube Data API quota accounting (spec §5.3). Default project quota is
 * 10,000 units/day; an upload costs ~1,600 (~6 uploads/day). Usage is read
 * from cost_records (publish adapters record quotaUnits), so it survives
 * restarts. The daily reset is midnight Pacific; we approximate with 08:00
 * UTC (PST) which is at most an hour late during PDT — conservative.
 */

export const YOUTUBE_UPLOAD_QUOTA_UNITS = 1600;

export function youtubeDailyQuota(env = process.env): number {
  return Number(env.YOUTUBE_DAILY_QUOTA ?? "10000");
}

const RESET_HOUR_UTC = 8;

/** Start of the current quota window. */
export function quotaWindowStart(now = new Date()): Date {
  const start = new Date(now);
  start.setUTCHours(RESET_HOUR_UTC, 0, 0, 0);
  if (start > now) start.setUTCDate(start.getUTCDate() - 1);
  return start;
}

/** Next quota reset after `now`. */
export function nextQuotaReset(now = new Date()): Date {
  const reset = quotaWindowStart(now);
  reset.setUTCDate(reset.getUTCDate() + 1);
  return reset;
}
