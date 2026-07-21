/**
 * BACKLOG #36: mirror MCP-filed tickets to GitHub issues so the developer can
 * read and answer them directly (the two-Claude bridge). Best-effort — returns
 * null when unconfigured or on any failure, so ticket creation never depends on it.
 */
const DEFAULT_REPO = "adawg85/YT-Auto-Platform-";

export async function createGithubIssue(
  env: Record<string, string | undefined>,
  input: { title: string; body: string; labels?: string[] },
): Promise<{ number: number; url: string } | null> {
  const token = env.GITHUB_ISSUE_TOKEN?.trim();
  if (!token) return null;
  const repo = (env.GITHUB_ISSUE_REPO?.trim() || DEFAULT_REPO)
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .trim();
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
      console.error(`[tickets] GitHub issue create failed: ${res.status} ${await res.text().catch(() => "")}`);
      return null;
    }
    const json = (await res.json()) as { number?: number; html_url?: string };
    if (!json.html_url || json.number == null) return null;
    return { number: json.number, url: json.html_url };
  } catch (e) {
    console.error("[tickets] GitHub issue create error:", e);
    return null;
  }
}
