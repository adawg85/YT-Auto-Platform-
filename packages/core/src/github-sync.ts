/**
 * Pure config helpers for the ticket→GitHub mirror (task zero). Kept in core so
 * the "surface exactly what's missing" behaviour is unit-tested even though the
 * HTTP call itself lives in the cockpit (which has no test harness).
 */
export const GITHUB_ISSUE_TOKEN_ENV = "GITHUB_ISSUE_TOKEN";
export const GITHUB_ISSUE_REPO_ENV = "GITHUB_ISSUE_REPO";
export const GITHUB_WEBHOOK_SECRET_ENV = "GITHUB_WEBHOOK_SECRET";
export const DEFAULT_ISSUE_REPO = "adawg85/YT-Auto-Platform-";

type Env = Record<string, string | undefined>;

/** True when the ticket→GitHub mirror has everything it needs to POST an issue. */
export function githubSyncConfigured(env: Env): boolean {
  return Boolean(env[GITHUB_ISSUE_TOKEN_ENV]?.trim());
}

/**
 * The name of the single env var that must be set for GitHub sync to work, or
 * null when it's already configured. Drives the actionable "set X" operator note.
 */
export function missingGithubSyncEnv(env: Env): string | null {
  return githubSyncConfigured(env) ? null : GITHUB_ISSUE_TOKEN_ENV;
}

/** owner/name for issues, from env or the default, stripped of URL/`.git` noise. */
export function githubIssueRepo(env: Env): string {
  return normalizeRepo(env[GITHUB_ISSUE_REPO_ENV]?.trim() || DEFAULT_ISSUE_REPO);
}

export function normalizeRepo(raw: string): string {
  return raw
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .trim();
}
