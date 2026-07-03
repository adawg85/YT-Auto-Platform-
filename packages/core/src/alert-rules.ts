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
export const MIN_PUBLISHED_FOR_BASELINE = 3;

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

  if (
    baseline.publishedCount >= MIN_PUBLISHED_FOR_BASELINE &&
    snap.ageHours >= MIN_AGE_HOURS &&
    baseline.medianViews > 0
  ) {
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
