/**
 * BACKLOG #36 / ticket task-zero: mirror MCP-filed tickets to GitHub issues so
 * the developer can read and answer them directly (the two-Claude bridge).
 * Never throws — ticket creation must not depend on GitHub — but returns a
 * DISCRIMINATED result so the caller can tell the operator exactly what to fix
 * (missing token vs a real API error) instead of a vague "not configured".
 */
import { GITHUB_ISSUE_REPO_ENV, GITHUB_ISSUE_TOKEN_ENV, githubIssueRepo, missingGithubSyncEnv } from "@ytauto/core";

export type GithubIssueResult =
  | { ok: true; number: number; url: string }
  /** no token configured — mirroring is off. `missing` names the env to set. */
  | { ok: false; reason: "unconfigured"; missing: string }
  /** configured, but GitHub rejected/failed the call. `detail` is operator-facing. */
  | { ok: false; reason: "error"; detail: string };

export async function createGithubIssue(
  env: Record<string, string | undefined>,
  input: { title: string; body: string; labels?: string[] },
): Promise<GithubIssueResult> {
  const missing = missingGithubSyncEnv(env);
  if (missing) {
    return { ok: false, reason: "unconfigured", missing };
  }
  const token = env[GITHUB_ISSUE_TOKEN_ENV]!.trim();
  const repo = githubIssueRepo(env);
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "YTAutoPlatform-Tickets",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({
        title: input.title.slice(0, 250),
        body: input.body,
        ...(input.labels?.length ? { labels: input.labels } : {}),
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 300);
      console.error(`[tickets] GitHub issue create failed: ${res.status} ${text}`);
      // Turn the common failures into a specific, actionable hint.
      const hint =
        res.status === 401
          ? `${GITHUB_ISSUE_TOKEN_ENV} is invalid or expired`
          : res.status === 403
            ? `${GITHUB_ISSUE_TOKEN_ENV} lacks the Issues (write) permission`
            : res.status === 404
              ? `repo "${repo}" not found for this token — check ${GITHUB_ISSUE_REPO_ENV} and the token's repo access`
              : `GitHub returned ${res.status}`;
      return { ok: false, reason: "error", detail: hint };
    }
    const json = (await res.json()) as { number?: number; html_url?: string };
    if (!json.html_url || json.number == null) {
      return { ok: false, reason: "error", detail: "GitHub returned an unexpected response shape" };
    }
    return { ok: true, number: json.number, url: json.html_url };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error("[tickets] GitHub issue create error:", detail);
    return { ok: false, reason: "error", detail: `network error contacting GitHub (${detail})` };
  }
}
