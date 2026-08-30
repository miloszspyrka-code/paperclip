import { describe, expect, it, vi } from "vitest";
import { githubPullRequestService } from "../services/github-pull-requests.js";

describe("githubPullRequestService", () => {
  it("creates a pull request with an in-memory credential and returns only safe fields", async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ authorization: "Bearer test-secret-token" });
      expect(JSON.parse(String(init?.body))).toEqual({ title: "Deliver issue", head: "feature/delivery", base: "main" });
      return new Response(JSON.stringify({
        number: 42,
        html_url: "https://github.com/paperclipai/paperclip/pull/42",
        title: "Deliver issue",
        state: "open",
        head: { ref: "feature/delivery", sha: "head-sha" },
        base: { ref: "main" },
      }), { status: 201 });
    });
    const svc = githubPullRequestService({} as never, {
      fetch,
      resolveCredential: async () => ({ token: "test-secret-token", source: "company_secret", secretName: "GITHUB_TOKEN" }),
    });

    const result = await svc.create({
      companyId: "company-1",
      issueId: "issue-1",
      repoUrl: "https://github.com/paperclipai/paperclip.git",
      head: "feature/delivery",
      base: "main",
      title: "Deliver issue",
      body: null,
    });

    expect(result).toEqual({
      number: 42,
      url: "https://github.com/paperclipai/paperclip/pull/42",
      title: "Deliver issue",
      state: "open",
      headRef: "feature/delivery",
      headSha: "head-sha",
      baseRef: "main",
      mergeCommitSha: null,
    });
    expect(JSON.stringify(result)).not.toContain("test-secret-token");
  });

  it("sends the prepared SHA when merging and fails closed when GitHub declines", async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(String(init?.body))).toEqual({ sha: "prepared-sha", merge_method: "squash" });
      return new Response(JSON.stringify({ merged: false }), { status: 409 });
    });
    const svc = githubPullRequestService({} as never, {
      fetch,
      resolveCredential: async () => ({ token: "test-secret-token", source: "company_secret", secretName: "GITHUB_TOKEN" }),
    });

    await expect(svc.merge({
      companyId: "company-1",
      issueId: "issue-1",
      repoUrl: "https://github.com/paperclipai/paperclip.git",
      number: 42,
      expectedHeadSha: "prepared-sha",
      method: "squash",
    })).rejects.toMatchObject({ status: 409 });
  });
});
