import type { Db } from "@paperclipai/db";
import { conflict, unprocessable } from "../errors.js";
import { resolveGitHubApiCredential } from "./git-credentials.js";
import { ghFetch, gitHubApiBase, isGitHubDotCom } from "./github-fetch.js";

export type GitHubPullRequest = {
  number: number;
  url: string;
  title: string;
  state: "open" | "closed" | "merged";
  headRef: string | null;
  headSha: string | null;
  baseRef: string | null;
  mergeCommitSha: string | null;
};

type GitHubPullRequestServiceOptions = {
  fetch?: typeof ghFetch;
  resolveCredential?: typeof resolveGitHubApiCredential;
};

function parseGitHubRepositoryUrl(repoUrl: string | null) {
  if (!repoUrl) return null;
  const match = /^(?:https?:\/\/(?:www\.)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(repoUrl.trim());
  if (!match) return null;
  return { host: "github.com", owner: match[1]!, repo: match[2]! };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function toPullRequest(value: unknown): GitHubPullRequest | null {
  const body = readRecord(value);
  const number = typeof body?.number === "number" && Number.isSafeInteger(body.number) ? body.number : null;
  const url = readString(body?.html_url);
  if (!body || !number || !url) return null;
  const head = readRecord(body.head);
  const base = readRecord(body.base);
  const merged = body.merged === true;
  const state = merged ? "merged" : body.state === "closed" ? "closed" : "open";
  return {
    number,
    url,
    title: readString(body.title) ?? `Pull request #${number}`,
    state,
    headRef: readString(head?.ref),
    headSha: readString(head?.sha),
    baseRef: readString(base?.ref),
    mergeCommitSha: readString(body.merge_commit_sha) ?? readString(body.sha),
  };
}

async function readJson(response: Response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Board delivery actions for GitHub.com. The token is held only in a request header and
 * deliberately never included in errors, activity metadata, or returned objects.
 */
export function githubPullRequestService(db: Db, opts: GitHubPullRequestServiceOptions = {}) {
  const fetchImpl = opts.fetch ?? ghFetch;
  const credentialResolver = opts.resolveCredential ?? resolveGitHubApiCredential;

  async function request(input: {
    companyId: string;
    issueId: string | null;
    repoUrl: string | null;
    path: string;
    method: "GET" | "POST" | "PUT";
    body?: Record<string, unknown>;
  }) {
    const repository = parseGitHubRepositoryUrl(input.repoUrl);
    if (!repository || !isGitHubDotCom(repository.host)) {
      throw unprocessable("Delivery actions require a GitHub.com repository URL.");
    }
    const credential = await credentialResolver(db, input.companyId, { issueId: input.issueId });
    if (!credential) {
      throw unprocessable("No supported GitHub credential is configured for delivery actions.");
    }
    const url = `${gitHubApiBase(repository.host)}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}${input.path}`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: input.method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${credential.token}`,
          "content-type": "application/json",
          "user-agent": "paperclip-delivery",
          "x-github-api-version": "2022-11-28",
        },
        ...(input.body ? { body: JSON.stringify(input.body) } : {}),
      });
    } catch {
      throw unprocessable("GitHub could not be reached for the delivery action.");
    }
    const body = await readJson(response);
    if (!response.ok) {
      if (response.status === 409 || response.status === 422) {
        throw conflict("GitHub rejected the delivery action because the pull request state changed or cannot be merged.");
      }
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        throw unprocessable("The configured GitHub credential cannot access this delivery repository.");
      }
      throw unprocessable(`GitHub returned HTTP ${response.status} for the delivery action.`);
    }
    return body;
  }

  return {
    create: async (input: {
      companyId: string;
      issueId: string | null;
      repoUrl: string | null;
      head: string;
      base: string;
      title: string;
      body: string | null;
    }) => {
      const response = await request({
        ...input,
        path: "/pulls",
        method: "POST",
        body: { title: input.title, head: input.head, base: input.base, ...(input.body ? { body: input.body } : {}) },
      });
      const pullRequest = toPullRequest(response);
      if (!pullRequest) throw unprocessable("GitHub returned an invalid pull request response.");
      return pullRequest;
    },

    merge: async (input: {
      companyId: string;
      issueId: string | null;
      repoUrl: string | null;
      number: number;
      expectedHeadSha: string;
      method: "merge" | "squash" | "rebase";
    }) => {
      const response = await request({
        ...input,
        path: `/pulls/${input.number}/merge`,
        method: "PUT",
        body: { sha: input.expectedHeadSha, merge_method: input.method },
      });
      const body = readRecord(response);
      if (body?.merged !== true) {
        throw conflict("GitHub did not confirm that the pull request was merged.");
      }
      return {
        merged: true as const,
        mergeCommitSha: readString(body.sha),
        message: readString(body.message) ?? "GitHub confirmed the pull request merge.",
      };
    },
  };
}
