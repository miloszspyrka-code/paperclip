import crypto from "node:crypto";
import {
  CHATGPT_PUBLIC_TOOL_DESCRIPTIONS,
  CHATGPT_PUBLIC_TOOL_NAMES,
} from "../mcp-public-tool-catalog.mjs";

const base = process.env.PAPERCLIP_PUBLIC_MCP_URL || "https://mcp.kompaszbiorek.pl/mcp";
const origin = new URL(base).origin;
const redirectUri = "http://127.0.0.1:8765/callback";

async function authenticate() {
  const registration = await fetch(`${origin}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Paperclip public catalog smoke", redirect_uris: [redirectUri] }),
  });
  const client = await registration.json();
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const query = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "mcp:read mcp:write",
    resource: base,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const authorizationUrl = `${origin}/oauth/authorize?${query}`;
  const login = await fetch(authorizationUrl, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      username: process.env.MCP_PUBLIC_USER || "",
      password: process.env.MCP_PUBLIC_PASS || "",
    }),
  });
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  if (login.status !== 302 || !cookie) throw new Error("OAuth login did not establish a session");
  const consent = await fetch(authorizationUrl, { redirect: "manual", headers: { cookie } });
  const code = new URL(consent.headers.get("location") || "").searchParams.get("code");
  if (consent.status !== 302 || !code) throw new Error("OAuth consent did not return a code");
  const response = await fetch(`${origin}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: base,
    }),
  });
  const token = await response.json();
  if (!token.access_token) throw new Error("OAuth token was not issued");
  return token.access_token;
}

async function main() {
  const token = await authenticate();
  let session;
  async function rpc(id, method, params) {
    const response = await fetch(base, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    session = response.headers.get("mcp-session-id") || session;
    return { status: response.status, body: await response.json() };
  }

  const initialize = await rpc(1, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "paperclip-catalog-smoke", version: "1.0.0" },
  });
  const toolsList = await rpc(2, "tools/list", {});
  const tools = toolsList.body.result?.tools || [];
  if (tools.length !== CHATGPT_PUBLIC_TOOL_NAMES.length) {
    throw new Error(`Expected ${CHATGPT_PUBLIC_TOOL_NAMES.length} public tools, received ${tools.length}`);
  }
  if (JSON.stringify(tools.map((tool) => tool.name)) !== JSON.stringify(CHATGPT_PUBLIC_TOOL_NAMES)) {
    throw new Error("Public tool names do not match the server-controlled allowlist");
  }
  for (const tool of tools) {
    if (tool.description !== CHATGPT_PUBLIC_TOOL_DESCRIPTIONS[tool.name]) {
      throw new Error(`Unexpected public description for ${tool.name}`);
    }
  }
  const listPayload = JSON.stringify(toolsList.body.result || {});
  const descriptionBytes = Buffer.byteLength(tools.map((tool) => tool.description || "").join(""));
  const inputSchemaBytes = Buffer.byteLength(tools.map((tool) => JSON.stringify(tool.inputSchema || {})).join(""));
  const output = {
    initialize: initialize.status,
    toolsList: toolsList.status,
    toolCount: tools.length,
    toolsListBytes: Buffer.byteLength(listPayload),
    descriptionBytes,
    inputSchemaBytes,
    estimatedTokens: Math.ceil(Buffer.byteLength(listPayload) / 4),
    tools: tools.map((tool) => ({ name: tool.name, description: tool.description || "" })),
  };

  if (process.env.PAPERCLIP_PUBLIC_MCP_READ_SMOKE === "1") {
    const issueId = "c293e25d-6f8c-4636-a238-fb692afee9ef";
    const projectId = "291fecff-2f36-44bc-ba39-cae853f6e90c";
    const agentId = "7cbc484a-bd04-4a7b-bc16-cbd643acf519";
    const calls = [
      ["paperclipMe", {}],
      ["paperclipListAgents", {}],
      ["paperclipGetAgent", { agentId }],
      ["paperclipListIssues", { q: "KOMAA-105" }],
      ["paperclipGetIssue", { issueId }],
      ["paperclipGetHeartbeatContext", { issueId }],
      ["paperclipListComments", { issueId, limit: 1 }],
      ["paperclipListProjects", {}],
      ["paperclipGetProject", { projectId }],
      ["paperclipListGoals", {}],
      ["paperclipGetIssueWorkspaceRuntime", { issueId }],
      ["paperclipApiRequest", { method: "GET", path: "/agents/me", jsonBody: "" }],
    ];
    const results = {};
    let nextId = 3;
    for (const [name, argumentsValue] of calls) {
      const response = await rpc(nextId++, "tools/call", { name, arguments: argumentsValue });
      const text = response.body.result?.content?.map((item) => item.text || "").join("\n") || "";
      results[name] = response.status === 200 && !/"error"\s*:/.test(text);
    }
    const hidden = await rpc(nextId, "tools/call", {
      name: "paperclipCreateApproval",
      arguments: {},
    });
    const boardOnly = await rpc(nextId + 1, "tools/call", {
      name: "paperclipApiRequest",
      arguments: {
        method: "GET",
        path: "/tool-gateway/runtime-slots?companyId=9894e3c2-3317-46ca-8c72-7a442a76a78e",
        jsonBody: "",
      },
    });
    const boardOnlyText = boardOnly.body.result?.content?.map((item) => item.text || "").join("\n") || "";
    output.readSmoke = results;
    output.hiddenToolRejected = hidden.body.error?.code === -32601;
    output.boardOnlyDenied = /Board access required/.test(boardOnlyText);
    output.boardOnlyResponse = boardOnlyText.slice(0, 240);
  }

  if (process.env.PAPERCLIP_CTB_ISSUE_ID && process.env.PAPERCLIP_CTB_RUN_ID) {
    const issueId = process.env.PAPERCLIP_CTB_ISSUE_ID;
    const runId = process.env.PAPERCLIP_CTB_RUN_ID;
    const runs = await rpc(20, "tools/call", { name: "paperclipListIssueRuns", arguments: { issueId } });
    const events = await rpc(21, "tools/call", { name: "paperclipGetRunEvents", arguments: { runId } });
    const metrics = await rpc(22, "tools/call", { name: "paperclipGetRunMetrics", arguments: { runId } });
    const runData = runs.body.result?.structuredContent;
    const eventData = events.body.result?.structuredContent;
    const metricData = metrics.body.result?.structuredContent;
    output.ctbObservability = {
      statuses: { runs: runs.status, events: events.status, metrics: metrics.status },
      errors: { runs: runs.body.error?.message || null, events: events.body.error?.message || null, metrics: metrics.body.error?.message || null },
      runs: runs.status === 200 && Array.isArray(runData?.runs) && runData.runs.some((run) => run.runId === runId),
      events: events.status === 200 && Array.isArray(eventData?.events) && eventData.events.some((event) => event.kind === "file" && event.operation === "write") && eventData.events.some((event) => event.kind === "test"),
      metrics: metrics.status === 200 && metricData?.fileWrites > 0 && metricData?.testCalls > 0 && typeof metricData?.durationMs === "number",
    };
    if (!output.ctbObservability.runs || !output.ctbObservability.events || !output.ctbObservability.metrics) {
      throw new Error(`CTB observability tools did not return the correlated tool-by-tool execution: ${JSON.stringify(output.ctbObservability)}`);
    }
  }

  if (process.env.PAPERCLIP_PUBLIC_RUN_SMOKE === "1") {
    // This existing read-only issue is used only to validate persisted Paperclip
    // runs. The test never creates, wakes, or mutates an issue.
    const issueId = process.env.PAPERCLIP_PUBLIC_RUN_ISSUE_ID || "c293e25d-6f8c-4636-a238-fb692afee9ef";
    const runs = await rpc(30, "tools/call", { name: "paperclipListIssueRuns", arguments: { issueId } });
    const runData = runs.body.result?.structuredContent;
    const run = Array.isArray(runData?.runs) ? runData.runs.find((entry) => entry?.runKind === "heartbeat") : null;
    if (runs.status !== 200 || !run?.runId) {
      throw new Error(`Persisted Paperclip run correlation failed: ${JSON.stringify({ status: runs.status, data: runData, error: runs.body.error })}`);
    }
    const events = await rpc(31, "tools/call", { name: "paperclipGetRunEvents", arguments: { runId: run.runId } });
    const metrics = await rpc(32, "tools/call", { name: "paperclipGetRunMetrics", arguments: { runId: run.runId } });
    const eventData = events.body.result?.structuredContent;
    const metricData = metrics.body.result?.structuredContent;
    if (events.status !== 200 || metrics.status !== 200 || !Array.isArray(eventData?.events) || typeof metricData?.supportedObservability !== "boolean") {
      throw new Error(`Persisted Paperclip observability failed: ${JSON.stringify({ events: events.body, metrics: metrics.body })}`);
    }
    if (run.supportedObservability !== null && run.supportedObservability !== metricData.supportedObservability) {
      throw new Error(`supportedObservability is inconsistent between endpoints for the same run: list=${run.supportedObservability} metrics=${metricData.supportedObservability}`);
    }
    output.paperclipRunObservability = {
      issueId,
      runId: run.runId,
      runKind: run.runKind,
      eventCount: eventData.events.length,
      supportedObservability: metricData.supportedObservability,
      reason: metricData.reason || null,
    };
  }

  if (process.env.PAPERCLIP_PUBLIC_SKILL_SMOKE === "1") {
    const listedSkills = await rpc(40, "tools/call", { name: "paperclipListSkills", arguments: {} });
    const skillData = listedSkills.body.result?.structuredContent;
    const skill = Array.isArray(skillData?.skills) ? skillData.skills[0] : null;
    const fetched = await rpc(41, "tools/call", { name: "paperclipGetSkill", arguments: { name: skill?.name } });
    const used = await rpc(42, "tools/call", { name: "paperclipUseSkill", arguments: { skill: skill?.name, request: "sprawdź bieżący stan" } });
    const ctb = await rpc(43, "tools/call", { name: "paperclipUseSkill", arguments: { skill: skill?.name, request: "Przebuduj architekturę OpenCode/Paperclip execution engine." } });
    if (!skill?.name || listedSkills.status !== 200 || fetched.status !== 200 || used.status !== 200 || ctb.body.result?.structuredContent?.HANDOFF_TO !== "OpenCode CTB") {
      throw new Error(`Public skill contract failed: ${JSON.stringify({ listed: listedSkills.body, fetched: fetched.body, used: used.body, ctb: ctb.body })}`);
    }
    output.skills = { list: "PASS", get: "PASS", use: "PASS", ctb: ctb.body.result.structuredContent };
  }

  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
