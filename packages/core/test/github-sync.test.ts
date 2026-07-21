import { describe, expect, it } from "vitest";
import {
  DEFAULT_ISSUE_REPO,
  githubIssueRepo,
  githubSyncConfigured,
  missingGithubSyncEnv,
  normalizeRepo,
} from "../src/github-sync";

describe("github ticket sync config", () => {
  it("reports the missing env when no token is set (the reported 'not configured' case)", () => {
    expect(githubSyncConfigured({})).toBe(false);
    expect(missingGithubSyncEnv({})).toBe("GITHUB_ISSUE_TOKEN");
    // blank / whitespace token is still unconfigured
    expect(missingGithubSyncEnv({ GITHUB_ISSUE_TOKEN: "   " })).toBe("GITHUB_ISSUE_TOKEN");
  });

  it("is configured once a token is present", () => {
    const env = { GITHUB_ISSUE_TOKEN: "ghp_x" };
    expect(githubSyncConfigured(env)).toBe(true);
    expect(missingGithubSyncEnv(env)).toBeNull();
  });

  it("defaults the repo and normalizes URL/.git forms", () => {
    expect(githubIssueRepo({ GITHUB_ISSUE_TOKEN: "t" })).toBe(DEFAULT_ISSUE_REPO);
    expect(githubIssueRepo({ GITHUB_ISSUE_TOKEN: "t", GITHUB_ISSUE_REPO: "owner/repo" })).toBe("owner/repo");
    expect(normalizeRepo("https://github.com/owner/repo.git")).toBe("owner/repo");
  });
});
