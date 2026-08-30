import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaperclipApiClient } from "./client.js";
import { createToolDefinitions } from "./tools.js";

function makeClient() {
  return new PaperclipApiClient({
    apiUrl: "http://localhost:3100/api",
    apiKey: "test-token",
    companyId: "11111111-1111-1111-1111-111111111111",
    agentId: "22222222-2222-2222-2222-222222222222",
    runId: "33333333-3333-3333-3333-333333333333",
  });
}

function response(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function tool(name: string) {
  const found = createToolDefinitions(makeClient()).find((definition) => definition.name === name);
  if (!found) throw new Error(`Missing tool: ${name}`);
  return found;
}

describe("public catalog compatibility", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("keeps governance and compatibility tools in the full internal registry", () => {
    const names = new Set(createToolDefinitions(makeClient()).map((definition) => definition.name));
    expect(names).toContain("paperclipApprovalDecision");
    expect(names).toContain("paperclipListIssueInteractions");
    expect(names).toContain("paperclipResolveIssueInteraction");
    expect(names).toContain("paperclipCancelHeartbeatRun");
    expect(names).toContain("paperclipGetDocument");
    expect(names).toContain("paperclipCheckoutIssue");
  });

  it("dispatches create, update, and comment writes through the unchanged backend tools", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ id: "issue-1" }))
      .mockResolvedValueOnce(response({ id: "issue-1", status: "in_progress" }))
      .mockResolvedValueOnce(response({ id: "comment-1" }));
    vi.stubGlobal("fetch", fetchMock);

    await tool("paperclipCreateIssue").execute({ title: "Fixture task" });
    await tool("paperclipUpdateIssue").execute({ issueId: "issue-1", status: "in_progress" });
    await tool("paperclipAddComment").execute({ issueId: "issue-1", body: "Fixture comment" });

    expect(fetchMock.mock.calls.map((call) => [String(call[0]), call[1]?.method])).toEqual([
      ["http://localhost:3100/api/companies/11111111-1111-1111-1111-111111111111/issues", "POST"],
      ["http://localhost:3100/api/issues/issue-1", "PATCH"],
      ["http://localhost:3100/api/issues/issue-1/comments", "POST"],
    ]);
  });
});
