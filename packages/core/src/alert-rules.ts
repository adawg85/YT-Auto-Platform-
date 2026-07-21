/**
 * Alerting rail rules (spec §5.4), pure functions over snapshot data so they
 * work identically on mock and real analytics. Demonetisation / copyright /
 * comment-sentiment kinds exist in the schema; their detectors arrive when
 * the relevant API surfaces are wired.
 */

export type SnapshotStats = {
  views: number;
  /** average % of the video watched, 0-100 */
  avgViewPct: number | null;
  ageHours: number;
};

export type ChannelBaseline = {
  /** median of latest views across the channel's published videos */
  medianViews: number;
  publishedCount: number;
};

export type AlertDraft = {
  kind: "underperformance" | "low_retention";
  severity: "warning" | "critical";
  message: string;
};

export const LOW_RETENTION_PCT = 40;
export const MIN_VIEWS_FOR_RETENTION_ALERT = 100;
export const UNDERPERFORMANCE_RATIO = 0.25;
export const UNDERPERFORMANCE_CRITICAL_RATIO = 0.1;
export const MIN_AGE_HOURS = 24;

/**
 * Small-sample gate for the underperformance alert (ticket 01KY1SX2…): a
 * "% of the channel median" is only meaningful once the channel has enough
 * history AND enough absolute views that the median isn't noise. On a brand-new
 * channel the median is single digits (a video's own creator views), so every
 * upload reads as ~0% and trips a CRITICAL alert — pure alert fatigue.
 *
 *  - `MIN_PUBLISHED_FOR_UNDERPERFORMANCE = 10`: below ~10 videos a single dud or
 *    breakout dominates the median; 10 is the smallest sample where a median is
 *    not swung by one outlier.
 *  - `MIN_MEDIAN_VIEWS_FOR_UNDERPERFORMANCE = 50`: under ~50 views the count is
 *    dominated by noise (own views, embeds, a few subscribers), so a ratio to it
 *    carries no signal. 50 is a defensible floor where the ratio starts to mean
 *    something for these channels; raise it as the channels mature.
 *  - `MIN_AGE_HOURS = 24` still applies (early views are lumpy).
 * These are starting points tuned for two very new channels — revisit once
 * either channel has real distribution.
 */
export const MIN_PUBLISHED_FOR_UNDERPERFORMANCE = 10;
export const MIN_MEDIAN_VIEWS_FOR_UNDERPERFORMANCE = 50;
/** Back-compat alias (was the old 3-video baseline gate). */
export const MIN_PUBLISHED_FOR_BASELINE = MIN_PUBLISHED_FOR_UNDERPERFORMANCE;

/**
 * True only when the channel has enough history + absolute views for an
 * underperformance ratio to be meaningful. Exposed so the ingest path can
 * self-heal: a channel that no longer clears this gate must not carry a stale
 * open underperformance alert.
 */
export function meetsUnderperformanceSampleGate(baseline: ChannelBaseline): boolean {
  return (
    baseline.publishedCount >= MIN_PUBLISHED_FOR_UNDERPERFORMANCE &&
    baseline.medianViews >= MIN_MEDIAN_VIEWS_FOR_UNDERPERFORMANCE
  );
}

export function evaluateAlertRules(snap: SnapshotStats, baseline: ChannelBaseline): AlertDraft[] {
  const alerts: AlertDraft[] = [];

  if (
    snap.avgViewPct !== null &&
    snap.avgViewPct < LOW_RETENTION_PCT &&
    snap.views >= MIN_VIEWS_FOR_RETENTION_ALERT
  ) {
    alerts.push({
      kind: "low_retention",
      severity: "warning",
      message: `Retention ${snap.avgViewPct.toFixed(0)}% is below ${LOW_RETENTION_PCT}% (${snap.views} views) — hook or pacing problem.`,
    });
  }

  // Underperformance only fires above the small-sample gate; below it the
  // ratio is noise and a CRITICAL alert is fatigue, so we suppress entirely.
  if (meetsUnderperformanceSampleGate(baseline) && snap.ageHours >= MIN_AGE_HOURS) {
    const ratio = snap.views / baseline.medianViews;
    if (ratio < UNDERPERFORMANCE_CRITICAL_RATIO) {
      alerts.push({
        kind: "underperformance",
        severity: "critical",
        message: `${snap.views} views is ${(ratio * 100).toFixed(0)}% of the channel median (${baseline.medianViews}) after ${Math.round(snap.ageHours)}h.`,
      });
    } else if (ratio < UNDERPERFORMANCE_RATIO) {
      alerts.push({
        kind: "underperformance",
        severity: "warning",
        message: `${snap.views} views is ${(ratio * 100).toFixed(0)}% of the channel median (${baseline.medianViews}) after ${Math.round(snap.ageHours)}h.`,
      });
    }
  }

  return alerts;
}
