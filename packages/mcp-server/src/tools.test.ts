import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaperclipApiClient } from "./client.js";
import { createToolDefinitions } from "./tools.js";

function makeClient() {
  return new PaperclipApiClient({
    apiUrl: "http://localhost:3100/api",
    apiKey: "token-123",
    companyId: "11111111-1111-1111-1111-111111111111",
    agentId: "22222222-2222-2222-2222-222222222222",
    runId: "33333333-3333-3333-3333-333333333333",
  });
}

function getTool(name: string) {
  const tool = createToolDefinitions(makeClient()).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool;
}

function mockJsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("paperclip MCP tools", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("identifies the authenticated agent principal", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ id: "agent-1", role: "coo" }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await getTool("paperclipMe").execute({});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://localhost:3100/api/agents/me");
    expect(response.content[0]?.text).toContain('"actorType": "agent"');
  });

  it("identifies a Board principal through the Board auth endpoint", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockJsonResponse({ error: "Agent authentication required" }, 401))
      .mockResolvedValueOnce(mockJsonResponse({ userId: "user-1", companyIds: ["company-1"] }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await getTool("paperclipMe").execute({});

    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      "http://localhost:3100/api/agents/me",
      "http://localhost:3100/api/cli-auth/me",
    ]);
    expect(response.content[0]?.text).toContain('"actorType": "board"');
  });

  it("adds auth headers and run id to mutating requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ ok: true }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipUpdateIssue");
    await tool.execute({
      issueId: "PAP-1135",
      status: "done",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("http://localhost:3100/api/issues/PAP-1135");
    expect(init.method).toBe("PATCH");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer token-123");
    expect((init.headers as Record<string, string>)["X-Paperclip-Run-Id"]).toBe(
      "33333333-3333-3333-3333-333333333333",
    );
  });

  it("uses default company id for company-scoped list tools", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse([{ id: "issue-1" }]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipListIssues");
    const response = await tool.execute({});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(String(url)).toBe(
      "http://localhost:3100/api/companies/11111111-1111-1111-1111-111111111111/issues",
    );
    expect(response.content[0]?.text).toContain("issue-1");
  });

  it("reads agent app assignments through the read-only REST projection", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ apps: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await getTool("paperclipGetAgentApps").execute({
      agentId: "22222222-2222-2222-2222-222222222222",
      companyId: "11111111-1111-1111-1111-111111111111",
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "http://localhost:3100/api/agents/22222222-2222-2222-2222-222222222222/tool-apps?companyId=11111111-1111-1111-1111-111111111111",
    );
  });

  it("lists app bindings with optional company, agent, and app filters", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ bindings: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await getTool("paperclipListAgentAppBindings").execute({
      companyId: "11111111-1111-1111-1111-111111111111",
      agentId: "22222222-2222-2222-2222-222222222222",
      appId: "44444444-4444-4444-4444-444444444444",
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "http://localhost:3100/api/tool-app-bindings?companyId=11111111-1111-1111-1111-111111111111&agentId=22222222-2222-2222-2222-222222222222&appId=44444444-4444-4444-4444-444444444444",
    );
  });

  it("uses explicit read-only endpoints for heartbeat run observability", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    await getTool("paperclipListHeartbeatRunsForIssue").execute({ issueId: "PAP-1135" });
    await getTool("paperclipGetHeartbeatRun").execute({ runId: "33333333-3333-3333-3333-333333333333" });
    await getTool("paperclipRunRuntimeState").execute({ runId: "33333333-3333-3333-3333-333333333333" });
    await getTool("paperclipListHeartbeatRunEvents").execute({ runId: "33333333-3333-3333-3333-333333333333", afterSeq: 4, limit: 20 });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://localhost:3100/api/issues/PAP-1135/runs");
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("http://localhost:3100/api/heartbeat-runs/33333333-3333-3333-3333-333333333333");
    expect(String(fetchMock.mock.calls[2]?.[0])).toBe("http://localhost:3100/api/heartbeat-runs/33333333-3333-3333-3333-333333333333/runtime-state");
    expect(String(fetchMock.mock.calls[3]?.[0])).toBe("http://localhost:3100/api/heartbeat-runs/33333333-3333-3333-3333-333333333333/events?afterSeq=4&limit=20");
  });

  it("reconciles only through a run-bound mutating request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ outcome: "NO_ACTION" }));
    vi.stubGlobal("fetch", fetchMock);

    await getTool("paperclipRunReconcile").execute({ runId: "33333333-3333-3333-3333-333333333333" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("http://localhost:3100/api/heartbeat-runs/33333333-3333-3333-3333-333333333333/reconcile");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-Paperclip-Run-Id"]).toBe("33333333-3333-3333-3333-333333333333");
  });

  it("cancels heartbeat runs through the audited Board endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ status: "cancelled" }));
    vi.stubGlobal("fetch", fetchMock);

    await getTool("paperclipCancelHeartbeatRun").execute({
      runId: "33333333-3333-3333-3333-333333333333",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("http://localhost:3100/api/heartbeat-runs/33333333-3333-3333-3333-333333333333/cancel");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({});
  });

  it("marks Board authorization failures as MCP errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ error: "Board access required" }, 403),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await getTool("paperclipCancelHeartbeatRun").execute({
      runId: "33333333-3333-3333-3333-333333333333",
    });

    expect(response.isError).toBe(true);
    expect(response.content[0]?.text).toContain('"status": 403');
    expect(response.content[0]?.text).toContain("Paperclip API request failed");
  });

  it("uses default agent id for checkout requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ id: "PAP-1135", status: "in_progress" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipCheckoutIssue");
    await tool.execute({
      issueId: "PAP-1135",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      agentId: "22222222-2222-2222-2222-222222222222",
      expectedStatuses: ["todo", "backlog", "blocked"],
    });
  });

  it("allows create issue requests to omit status so the API applies assignee defaults", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ id: "issue-1", status: "todo" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipCreateIssue");
    await tool.execute({
      title: "Assigned follow-up",
      assigneeAgentId: "22222222-2222-2222-2222-222222222222",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(
      "http://localhost:3100/api/companies/11111111-1111-1111-1111-111111111111/issues",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      title: "Assigned follow-up",
      workMode: "standard",
      priority: "medium",
      assigneeAgentId: "22222222-2222-2222-2222-222222222222",
      requestDepth: 0,
      allowDuplicate: false,
    });
  });

  it("defaults issue document format to markdown", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ key: "plan", latestRevisionNumber: 2 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipUpsertIssueDocument");
    await tool.execute({
      issueId: "PAP-1135",
      key: "plan",
      body: "# Updated",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      format: "markdown",
      body: "# Updated",
    });
  });

  it("controls issue workspace services through the current execution workspace", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockJsonResponse({
        currentExecutionWorkspace: {
          id: "44444444-4444-4444-8444-444444444444",
          runtimeServices: [],
        },
      }))
      .mockResolvedValueOnce(mockJsonResponse({
        operation: { id: "operation-1" },
        workspace: {
          id: "44444444-4444-4444-8444-444444444444",
          runtimeServices: [
            {
              id: "55555555-5555-4555-8555-555555555555",
              serviceName: "web",
              status: "running",
              url: "http://127.0.0.1:5173",
            },
          ],
        },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipControlIssueWorkspaceServices");
    await tool.execute({
      issueId: "PAP-1135",
      action: "restart",
      workspaceCommandId: "web",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [lookupUrl, lookupInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(lookupUrl)).toBe("http://localhost:3100/api/issues/PAP-1135/heartbeat-context");
    expect(lookupInit.method).toBe("GET");

    const [controlUrl, controlInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(String(controlUrl)).toBe(
      "http://localhost:3100/api/execution-workspaces/44444444-4444-4444-8444-444444444444/runtime-services/restart",
    );
    expect(controlInit.method).toBe("POST");
    expect(JSON.parse(String(controlInit.body))).toEqual({
      workspaceCommandId: "web",
    });
  });

  it("waits for an issue workspace runtime service URL", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockJsonResponse({
        currentExecutionWorkspace: {
          id: "44444444-4444-4444-8444-444444444444",
          runtimeServices: [
            {
              id: "55555555-5555-4555-8555-555555555555",
              serviceName: "web",
              status: "running",
              healthStatus: "healthy",
              url: "http://127.0.0.1:5173",
            },
          ],
        },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipWaitForIssueWorkspaceService");
    const response = await tool.execute({
      issueId: "PAP-1135",
      serviceName: "web",
      timeoutSeconds: 1,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.content[0]?.text).toContain("http://127.0.0.1:5173");
  });

  it("creates suggest_tasks interactions with the expected issue-scoped payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ id: "interaction-1", kind: "suggest_tasks" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipSuggestTasks");
    await tool.execute({
      issueId: "PAP-1135",
      idempotencyKey: "run-1:suggest",
      payload: {
        version: 1,
        tasks: [{ clientKey: "task-1", title: "One" }],
      },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("http://localhost:3100/api/issues/PAP-1135/interactions");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      kind: "suggest_tasks",
      continuationPolicy: "wake_assignee",
      idempotencyKey: "run-1:suggest",
      payload: {
        version: 1,
        tasks: [{ clientKey: "task-1", title: "One" }],
      },
    });
  });

  it("creates request_confirmation interactions with plan target payloads", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ id: "interaction-1", kind: "request_confirmation" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipRequestConfirmation");
    await tool.execute({
      issueId: "PAP-1135",
      idempotencyKey: "confirmation:PAP-1135:plan:33333333-3333-4333-8333-333333333333",
      title: "Plan approval",
      payload: {
        version: 1,
        prompt: "Accept this plan?",
        acceptLabel: "Accept plan",
        allowDeclineReason: true,
        rejectLabel: "Request changes",
        rejectRequiresReason: true,
        supersedeOnUserComment: true,
        target: {
          type: "issue_document",
          key: "plan",
          revisionId: "33333333-3333-4333-8333-333333333333",
          revisionNumber: 3,
        },
      },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("http://localhost:3100/api/issues/PAP-1135/interactions");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      kind: "request_confirmation",
      continuationPolicy: "none",
      idempotencyKey: "confirmation:PAP-1135:plan:33333333-3333-4333-8333-333333333333",
      title: "Plan approval",
      payload: {
        version: 1,
        prompt: "Accept this plan?",
        acceptLabel: "Accept plan",
        allowDeclineReason: true,
        rejectLabel: "Request changes",
        rejectRequiresReason: true,
        supersedeOnUserComment: true,
        target: {
          type: "issue_document",
          key: "plan",
          revisionId: "33333333-3333-4333-8333-333333333333",
          revisionNumber: 3,
        },
      },
    });
  });

  it("creates request_checkbox_confirmation interactions with checkbox payloads", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ id: "interaction-1", kind: "request_checkbox_confirmation" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipRequestCheckboxConfirmation");
    await tool.execute({
      issueId: "PAP-1135",
      idempotencyKey: "confirmation:PAP-1135:files",
      title: "Choose files",
      payload: {
        version: 1,
        prompt: "Which files should be included?",
        detailsMarkdown: "Pick the files to attach.",
        options: [
          { id: "file-a", label: "File A", description: "Primary draft" },
          { id: "file-b", label: "File B" },
        ],
        defaultSelectedOptionIds: ["file-a"],
        minSelected: 1,
        maxSelected: 2,
        acceptLabel: "Use selected files",
        rejectLabel: "Do not attach files",
        rejectRequiresReason: true,
        allowDeclineReason: false,
      },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("http://localhost:3100/api/issues/PAP-1135/interactions");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      kind: "request_checkbox_confirmation",
      continuationPolicy: "wake_assignee",
      idempotencyKey: "confirmation:PAP-1135:files",
      title: "Choose files",
      payload: {
        version: 1,
        prompt: "Which files should be included?",
        detailsMarkdown: "Pick the files to attach.",
        options: [
          { id: "file-a", label: "File A", description: "Primary draft" },
          { id: "file-b", label: "File B" },
        ],
        defaultSelectedOptionIds: ["file-a"],
        minSelected: 1,
        maxSelected: 2,
        acceptLabel: "Use selected files",
        rejectLabel: "Do not attach files",
        rejectRequiresReason: true,
        allowDeclineReason: false,
      },
    });
  });

  it("lists and resolves issue interactions through explicit endpoints", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const interactionId = "44444444-4444-4444-8444-444444444444";

    await getTool("paperclipListIssueInteractions").execute({ issueId: "PAP-1135" });
    await getTool("paperclipResolveIssueInteraction").execute({
      issueId: "PAP-1135",
      interactionId,
      action: "accept",
      selectedOptionIds: ["file-a"],
    });
    await getTool("paperclipResolveIssueInteraction").execute({
      issueId: "PAP-1135",
      interactionId,
      action: "reject",
      reason: "Needs revision",
    });
    await getTool("paperclipResolveIssueInteraction").execute({
      issueId: "PAP-1135",
      interactionId,
      action: "respond",
      answers: [{ questionId: "scope", optionIds: ["yes"] }],
      summaryMarkdown: "Approved scope",
    });
    await getTool("paperclipResolveIssueInteraction").execute({
      issueId: "PAP-1135",
      interactionId,
      action: "cancel",
      reason: "Superseded",
    });

    const calls = fetchMock.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: (init as RequestInit).method,
      body: (init as RequestInit).body === undefined ? undefined : JSON.parse(String((init as RequestInit).body)),
    }));
    expect(calls).toEqual([
      { url: "http://localhost:3100/api/issues/PAP-1135/interactions", method: "GET", body: undefined },
      { url: `http://localhost:3100/api/issues/PAP-1135/interactions/${interactionId}/accept`, method: "POST", body: { selectedOptionIds: ["file-a"] } },
      { url: `http://localhost:3100/api/issues/PAP-1135/interactions/${interactionId}/reject`, method: "POST", body: { reason: "Needs revision" } },
      { url: `http://localhost:3100/api/issues/PAP-1135/interactions/${interactionId}/respond`, method: "POST", body: { answers: [{ questionId: "scope", optionIds: ["yes"] }], summaryMarkdown: "Approved scope" } },
      { url: `http://localhost:3100/api/issues/PAP-1135/interactions/${interactionId}/cancel`, method: "POST", body: { reason: "Superseded" } },
    ]);
  });

  it("dispatches formal approval actions to their explicit endpoints", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ status: "approved" }));
    vi.stubGlobal("fetch", fetchMock);
    const approvalId = "55555555-5555-4555-8555-555555555555";

    await getTool("paperclipApprovalDecision").execute({
      approvalId,
      action: "approve",
      decisionNote: "Activation approved",
    });
    await getTool("paperclipApprovalDecision").execute({
      approvalId,
      action: "resubmit",
      payloadJson: '{"branch":"KOMAA-RTB-live-activation"}',
    });

    const calls = fetchMock.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: (init as RequestInit).method,
      body: JSON.parse(String((init as RequestInit).body)),
    }));
    expect(calls).toEqual([
      {
        url: `http://localhost:3100/api/approvals/${approvalId}/approve`,
        method: "POST",
        body: { decisionNote: "Activation approved" },
      },
      {
        url: `http://localhost:3100/api/approvals/${approvalId}/resubmit`,
        method: "POST",
        body: { payload: { branch: "KOMAA-RTB-live-activation" } },
      },
    ]);
  });

  it("creates approvals with the expected company-scoped payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ id: "approval-1" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipCreateApproval");
    await tool.execute({
      type: "hire_agent",
      payload: { branch: "pap-1167" },
      issueIds: ["44444444-4444-4444-4444-444444444444"],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(
      "http://localhost:3100/api/companies/11111111-1111-1111-1111-111111111111/approvals",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      type: "hire_agent",
      payload: { branch: "pap-1167" },
      issueIds: ["44444444-4444-4444-4444-444444444444"],
    });
  });

  it("maps operator tools to their explicit Board API endpoints", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const secretId = "44444444-4444-4444-8444-444444444444";
    const connectionId = "55555555-5555-4555-8555-555555555555";
    const profileId = "66666666-6666-4666-8666-666666666666";
    const workspaceId = "77777777-7777-4777-8777-777777777777";

    await getTool("paperclipCreateSecret").execute({ name: "GitHub token", key: "github_token", value: "plaintext-never-returned" });
    await getTool("paperclipTestToolConnection").execute({ connectionId });
    await getTool("paperclipRefreshToolConnectionCatalog").execute({ connectionId });
    await getTool("paperclipGetToolProfile").execute({ profileId });
    await getTool("paperclipSetAgentAppPermission").execute({ connectionId, mode: "specific_agents", agentIds: ["22222222-2222-2222-2222-222222222222"] });
    await getTool("paperclipSetAgentAppInstallPolicy").execute({ connectionId, mode: "all_agents" });
    await getTool("paperclipUpdateToolGateway").execute({ gatewayId: secretId, companyId: "11111111-1111-1111-1111-111111111111", name: "Board gateway" });
    await getTool("paperclipGetExecutionWorkspaceDelivery").execute({ executionWorkspaceId: workspaceId });
    await getTool("paperclipPrepareIssueDelivery").execute({ executionWorkspaceId: workspaceId });
    await getTool("paperclipCreateIssuePullRequest").execute({ executionWorkspaceId: workspaceId, title: "Deliver workspace" });
    await getTool("paperclipMergeIssuePullRequest").execute({ executionWorkspaceId: workspaceId, pullRequestNumber: 42, method: "squash" });

    const calls = fetchMock.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: (init as RequestInit).method,
      body: (init as RequestInit).body === undefined ? undefined : JSON.parse(String((init as RequestInit).body)),
    }));
    expect(calls).toEqual([
      {
        url: "http://localhost:3100/api/companies/11111111-1111-1111-1111-111111111111/secrets",
        method: "POST",
        body: { name: "GitHub token", key: "github_token", value: "plaintext-never-returned" },
      },
      { url: `http://localhost:3100/api/tool-connections/${connectionId}/health-check`, method: "POST", body: {} },
      { url: `http://localhost:3100/api/tool-connections/${connectionId}/catalog/refresh`, method: "POST", body: {} },
      { url: `http://localhost:3100/api/tool-profiles/${profileId}`, method: "GET", body: undefined },
      {
        url: `http://localhost:3100/api/tool-connections/${connectionId}/agent-permission`,
        method: "PUT",
        body: { mode: "specific_agents", agentIds: ["22222222-2222-2222-2222-222222222222"] },
      },
      {
        url: `http://localhost:3100/api/tool-connections/${connectionId}/installs`,
        method: "PUT",
        body: { installs: [{ targetType: "company", targetId: "11111111-1111-1111-1111-111111111111" }] },
      },
      {
        url: `http://localhost:3100/api/tool-gateway/gateways/${secretId}`,
        method: "PATCH",
        body: { companyId: "11111111-1111-1111-1111-111111111111", name: "Board gateway" },
      },
      { url: `http://localhost:3100/api/execution-workspaces/${workspaceId}/delivery`, method: "GET", body: undefined },
      { url: `http://localhost:3100/api/execution-workspaces/${workspaceId}/prepare-delivery`, method: "POST", body: undefined },
      {
        url: `http://localhost:3100/api/execution-workspaces/${workspaceId}/pull-request`,
        method: "POST",
        body: { title: "Deliver workspace" },
      },
      {
        url: `http://localhost:3100/api/execution-workspaces/${workspaceId}/pull-request/merge`,
        method: "POST",
        body: { pullRequestNumber: 42, method: "squash" },
      },
    ]);
  });

  it("redacts secret values from successful MCP output and API failures", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockJsonResponse({ value: "never-show", nested: { githubToken: "also-hidden" } }))
      .mockResolvedValueOnce(mockJsonResponse({ error: "value never-show" }, 422));
    vi.stubGlobal("fetch", fetchMock);

    const success = await getTool("paperclipCreateSecret").execute({ name: "Secret", key: "secret_key", value: "never-show" });
    const failure = await getTool("paperclipRotateSecret").execute({ secretId: "44444444-4444-4444-8444-444444444444", value: "never-show" });

    expect(success.content[0]?.text).toContain("[REDACTED]");
    expect(success.content[0]?.text).not.toContain("never-show");
    expect(success.content[0]?.text).not.toContain("also-hidden");
    expect(failure.content[0]?.text).not.toContain("never-show");
    expect(failure.content[0]?.text).not.toContain("value never-show");
  });

  it("rejects invalid generic request paths", async () => {
    vi.stubGlobal("fetch", vi.fn());

    const tool = getTool("paperclipApiRequest");
    const response = await tool.execute({
      method: "GET",
      path: "issues",
    });

    expect(response.content[0]?.text).toContain("Tool input or execution failed");
  });

  it("rejects generic request paths that escape /api", async () => {
    vi.stubGlobal("fetch", vi.fn());

    const tool = getTool("paperclipApiRequest");
    const response = await tool.execute({
      method: "GET",
      path: "/../../secret",
    });

    expect(response.content[0]?.text).toContain("Tool input or execution failed");
  });
});
