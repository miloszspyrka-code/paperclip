import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";

const root = new URL("..", import.meta.url).pathname.replace(/^\//, "").replaceAll("/", "\\");
const redirectUri = "http://127.0.0.1:8765/callback";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function close(server) {
  server.close();
  await once(server, "close");
}

async function waitFor(url, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Gateway exited with ${child.exitCode}`);
    try {
      if ((await fetch(`${url}/health`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Gateway did not start");
}

async function startGateway({ storage, upstreamPort, refreshTtlMs = "10000", principals = {} }) {
  const portServer = http.createServer();
  const port = await listen(portServer);
  await close(portServer);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(globalThis.process.execPath, [join(root, "mcp-public-gateway.mjs")], {
    cwd: root,
    env: {
      ...globalThis.process.env,
      PORT: String(port),
      MCP_PUBLIC_ISSUER: base,
      MCP_PUBLIC_USER: "gateway-test-user",
      MCP_PUBLIC_PASS: "gateway-test-pass",
      MCP_PUBLIC_KEY_FILE: join(storage, "signing.key"),
      MCP_PUBLIC_REFRESH_TOKENS_FILE: join(storage, "refresh-tokens.json"),
      MCP_PUBLIC_AUDIT_FILE: join(storage, "audit.jsonl"),
      MCP_PUBLIC_PRINCIPALS: JSON.stringify(Object.fromEntries(Object.entries(principals).map(([login, principal]) => [
        login,
        {
          ...principal,
          upstreamTokens: principal.upstreamTokens || { paperclip: "test-board-api-key" },
        },
      ]))),
      MCP_PUBLIC_REFRESH_TTL_MS: refreshTtlMs,
      MCP_PUBLIC_TARGETS: JSON.stringify({ paperclip: { url: `http://127.0.0.1:${upstreamPort}/mcp` } }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.resume();
  child.stderr.resume();
  await waitFor(base, child);
  return { base, process: child };
}

test("public gateway forwards only the OAuth principal's configured Board credential", async (t) => {
  const storage = mkdtempSync(join(root, ".tmp-mcp-public-gateway-"));
  const receivedAuthorizations = [];
  const upstream = http.createServer(async (req, res) => {
    receivedAuthorizations.push(req.headers.authorization || null);
    let body = "";
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body || "{}");
    const result = message.method === "tools/list" ? { tools: [] } : { protocolVersion: "2025-03-26", capabilities: {} };
    res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "upstream-session" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  const upstreamPort = await listen(upstream);
  const gateway = await startGateway({
    storage,
    upstreamPort,
    principals: {
      "gateway-test-user": {
        sub: "board-user",
        companyIds: ["11111111-1111-1111-1111-111111111111"],
        upstreamTokens: { paperclip: "board-principal-api-key" },
      },
    },
  });
  t.after(async () => {
    await stopGateway(gateway.process);
    await close(upstream);
    rmSync(storage, { recursive: true, force: true });
  });

  const { token } = await authenticate(gateway.base);
  const initialized = await rpc(gateway.base, token.access_token, 1, "initialize", { protocolVersion: "2025-03-26", capabilities: {} });
  const listed = await rpc(gateway.base, token.access_token, 2, "tools/list", {}, initialized.session);

  assert.equal(listed.status, 200);
  assert.ok(receivedAuthorizations.every((value) => value === "Bearer board-principal-api-key"));
});

test("public gateway refuses OAuth principals without an upstream Board credential", async (t) => {
  const storage = mkdtempSync(join(root, ".tmp-mcp-public-gateway-"));
  const upstream = http.createServer((req, res) => res.end());
  const upstreamPort = await listen(upstream);
  const gateway = await startGateway({ storage, upstreamPort });
  t.after(async () => {
    await stopGateway(gateway.process);
    await close(upstream);
    rmSync(storage, { recursive: true, force: true });
  });

  const { token } = await authenticate(gateway.base);
  const initialized = await rpc(gateway.base, token.access_token, 1, "initialize", { protocolVersion: "2025-03-26", capabilities: {} });

  assert.equal(initialized.status, 403);
  assert.equal(initialized.json.error.message, "UPSTREAM_PRINCIPAL_UNCONFIGURED");
});

async function stopGateway(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await once(child, "exit");
}

async function authenticate(base, scope = "mcp:read mcp:write") {
  const registered = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "MCP gateway regression", redirect_uris: [redirectUri], scope }),
  });
  assert.equal(registered.status, 201);
  const client = await registered.json();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorizationUrl = new URL(`${base}/oauth/authorize`);
  authorizationUrl.search = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    scope,
    resource: `${base}/mcp`,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  const login = await fetch(authorizationUrl, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "gateway-test-user", password: "gateway-test-pass" }),
  });
  assert.equal(login.status, 302);
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const consent = await fetch(authorizationUrl, { redirect: "manual", headers: { cookie } });
  assert.equal(consent.status, 302);
  const code = new URL(consent.headers.get("location")).searchParams.get("code");
  const issued = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: redirectUri, code_verifier: verifier, resource: `${base}/mcp` }),
  });
  assert.equal(issued.status, 200);
  const token = await issued.json();
  assert.ok(token.access_token);
  assert.ok(token.refresh_token);
  return { client, token };
}

async function refresh(base, clientId, refreshToken) {
  const response = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken, resource: `${base}/mcp` }),
  });
  return { status: response.status, json: await response.json() };
}

async function rpc(base, token, id, method, params, session) {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(session ? { "mcp-session-id": session } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return { status: response.status, json: await response.json(), session: response.headers.get("mcp-session-id") || session };
}

test("public gateway routes skill modes through JSON-RPC and persists rotated refresh tokens", async (t) => {
  const storage = mkdtempSync(join(root, ".tmp-mcp-public-gateway-"));
  const upstream = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body || "{}");
    if (message.method === "tools/call" && message.params?.name === "paperclipMe") {
      res.writeHead(503, { "content-type": "application/json" });
      return res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "Upstream unavailable" } }));
    }
    let result;
    if (message.method === "tools/list") result = { tools: [] };
    else if (message.params?.name === "paperclipGetIssue") result = { structuredContent: { id: message.params.arguments.issueId, companyId: "11111111-1111-1111-1111-111111111111" } };
    else if (message.params?.name === "paperclipListHeartbeatRunsForIssue") result = { structuredContent: [
      { runId: "33333333-3333-3333-3333-333333333333", contextSnapshot: { issueId: "issue-1" }, adapterType: "opencode_local", status: "completed", startedAt: "2026-08-23T10:00:00.000Z", finishedAt: "2026-08-23T10:00:03.000Z", usageJson: { inputTokens: 1200, cachedInputTokens: 300, outputTokens: 450, billingType: "workspace", costUsd: 0.012 } },
      { runId: "44444444-4444-4444-4444-444444444444", contextSnapshot: { issueId: "issue-1" }, adapterType: "opencode_local", status: "completed", startedAt: "2026-08-23T09:00:00.000Z", finishedAt: "2026-08-23T09:00:02.000Z", usageJson: { inputTokens: 100, outputTokens: 50 } },
      { runId: "55555555-5555-5555-5555-555555555555", contextSnapshot: { issueId: "issue-1" }, adapterType: "opencode_local", status: "failed", startedAt: "2026-08-23T08:00:00.000Z", finishedAt: "2026-08-23T08:00:01.000Z" },
    ] };
    else if (message.params?.name === "paperclipGetHeartbeatRun") {
      const heartbeatRunId = message.params.arguments.runId;
      const baseRun = { id: heartbeatRunId, companyId: "11111111-1111-1111-1111-111111111111", adapterType: "opencode_local", status: "completed" };
      if (heartbeatRunId === "33333333-3333-3333-3333-333333333333") {
        result = { structuredContent: { ...baseRun, startedAt: "2026-08-23T10:00:00.000Z", finishedAt: "2026-08-23T10:00:03.000Z", usageJson: { inputTokens: 1200, cachedInputTokens: 300, outputTokens: 450, provider: "opencode-go", model: "ox-alpha-free", biller: "workspace", costUsd: 0.012 }, resultJson: { stdout: "", stderr: "", usageMeasurement: "exact" } } };
      } else if (heartbeatRunId === "44444444-4444-4444-4444-444444444444") {
        result = { structuredContent: { ...baseRun, startedAt: "2026-08-23T09:00:00.000Z", finishedAt: "2026-08-23T09:00:02.000Z", usageJson: { inputTokens: 100, outputTokens: 50 } } };
      } else {
        result = { structuredContent: { ...baseRun, status: "failed", startedAt: "2026-08-23T08:00:00.000Z", finishedAt: "2026-08-23T08:00:01.000Z" } };
      }
    }
    else if (message.params?.name === "paperclipListHeartbeatRunEvents") result = { structuredContent: ["44444444-4444-4444-4444-444444444444", "55555555-5555-5555-5555-555555555555"].includes(message.params.arguments.runId)
      ? [{ seq: 1, eventType: "lifecycle", message: "run started", payload: null, createdAt: "2026-08-23T09:00:00.500Z" }]
      : [{ seq: 1, eventType: "tool", message: "persisted", payload: { toolName: "read", status: "success", durationMs: 12 }, createdAt: "2026-08-23T10:00:01.000Z" }, { seq: 2, eventType: "tool", message: "persisted", payload: { toolName: "test", status: "success" }, createdAt: "2026-08-23T10:00:02.000Z" }] };
    else result = { protocolVersion: "2025-03-26", capabilities: {} };
    res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "upstream-session" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  const upstreamPort = await listen(upstream);
  let gateway = await startGateway({ storage, upstreamPort, principals: { "gateway-test-user": { sub: "test-user", companyIds: ["11111111-1111-1111-1111-111111111111"] } } });
  t.after(async () => {
    await stopGateway(gateway.process);
    await close(upstream);
    rmSync(storage, { recursive: true, force: true });
  });

  const metadata = await (await fetch(`${gateway.base}/.well-known/oauth-authorization-server`)).json();
  assert.deepEqual(metadata.grant_types_supported, ["authorization_code", "refresh_token"]);
  assert.ok(metadata.scopes_supported.includes("offline_access"));
  const { client, token } = await authenticate(gateway.base, "mcp:read mcp:write offline_access");
  assert.match(token.scope, /offline_access/);
  const missingToken = await fetch(`${gateway.base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }),
  });
  assert.equal(missingToken.status, 401);
  assert.match(missingToken.headers.get("www-authenticate"), /^Bearer /);
  let initialize = await rpc(gateway.base, token.access_token, 1, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(initialize.status, 200);
  const session = initialize.session;
  const listed = await rpc(gateway.base, token.access_token, 2, "tools/list", {}, session);
  assert.equal(listed.status, 200);
  assert.ok(listed.json.result.tools.some((tool) => tool.name === "paperclipUseSkill"));
  const skills = await rpc(gateway.base, token.access_token, 23, "tools/call", { name: "paperclipListSkills", arguments: {} }, session);
  assert.equal(skills.status, 200);
  assert.ok(Array.isArray(skills.json.result.structuredContent.skills));
  assert.equal(skills.json.result.content[0].type, "text");
  const runs = await rpc(gateway.base, token.access_token, 24, "tools/call", { name: "paperclipListIssueRuns", arguments: { issueId: "issue-1" } }, session);
  assert.equal(runs.status, 200);
  const runSummaries = runs.json.result.structuredContent.runs.filter((run) => run.runKind === "heartbeat");
  const telemetryRun = runSummaries.find((run) => run.runId === "33333333-3333-3333-3333-333333333333");
  const lifecycleOnlyRun = runSummaries.find((run) => run.runId === "44444444-4444-4444-4444-444444444444");
  const usagelessRun = runSummaries.find((run) => run.runId === "55555555-5555-5555-5555-555555555555");
  assert.equal(telemetryRun.supportedObservability, true);
  assert.equal(lifecycleOnlyRun.supportedObservability, false);
  assert.match(lifecycleOnlyRun.reason, /no structured tool telemetry/);
  assert.deepEqual(telemetryRun.usage, { inputTokens: 1200, cachedInputTokens: 300, outputTokens: 450, totalTokens: 1950 });
  assert.deepEqual(lifecycleOnlyRun.usage, { inputTokens: 100, cachedInputTokens: null, outputTokens: 50, totalTokens: 150 });
  assert.equal(usagelessRun.usage, null);
  assert.equal(telemetryRun.provider, null);
  assert.equal(telemetryRun.model, null);
  const metrics = await rpc(gateway.base, token.access_token, 26, "tools/call", { name: "paperclipGetRunMetrics", arguments: { runId: "33333333-3333-3333-3333-333333333333" } }, session);
  assert.equal(metrics.json.result.structuredContent.toolCalls, 2);
  assert.equal(metrics.json.result.structuredContent.testCalls, 1);
  assert.equal(metrics.json.result.structuredContent.supportedObservability, telemetryRun.supportedObservability);
  assert.equal(metrics.json.result.structuredContent.inputTokens, 1200);
  assert.equal(metrics.json.result.structuredContent.cachedInputTokens, 300);
  assert.equal(metrics.json.result.structuredContent.outputTokens, 450);
  assert.equal(metrics.json.result.structuredContent.reasoningTokens, null);
  assert.equal(metrics.json.result.structuredContent.totalTokens, 1950);
  assert.equal(metrics.json.result.structuredContent.provider, "opencode-go");
  assert.equal(metrics.json.result.structuredContent.model, "ox-alpha-free");
  assert.equal(metrics.json.result.structuredContent.usageMeasurement, "exact");
  const events = await rpc(gateway.base, token.access_token, 25, "tools/call", { name: "paperclipGetRunEvents", arguments: { runId: "33333333-3333-3333-3333-333333333333" } }, session);
  assert.deepEqual(events.json.result.structuredContent.events.map((event) => event.seq), [1, 2]);
  assert.equal(events.json.result.structuredContent.supportedObservability, telemetryRun.supportedObservability);
  const lifecycleEvents = await rpc(gateway.base, token.access_token, 27, "tools/call", { name: "paperclipGetRunEvents", arguments: { runId: "44444444-4444-4444-4444-444444444444" } }, session);
  assert.equal(lifecycleEvents.status, 200);
  assert.equal(lifecycleEvents.json.result.structuredContent.supportedObservability, false);
  const lifecycleMetrics = await rpc(gateway.base, token.access_token, 28, "tools/call", { name: "paperclipGetRunMetrics", arguments: { runId: "44444444-4444-4444-4444-444444444444" } }, session);
  assert.equal(lifecycleMetrics.json.result.structuredContent.supportedObservability, false);
  assert.equal(lifecycleMetrics.json.result.structuredContent.toolCalls, null);
  assert.equal(lifecycleMetrics.json.result.structuredContent.inputTokens, 100);
  assert.equal(lifecycleMetrics.json.result.structuredContent.cachedInputTokens, null);
  assert.equal(lifecycleMetrics.json.result.structuredContent.outputTokens, 50);
  assert.equal(lifecycleMetrics.json.result.structuredContent.reasoningTokens, null);
  assert.equal(lifecycleMetrics.json.result.structuredContent.totalTokens, 150);
  assert.equal(lifecycleMetrics.json.result.structuredContent.provider, null);
  assert.equal(lifecycleMetrics.json.result.structuredContent.model, null);
  assert.equal(lifecycleMetrics.json.result.structuredContent.usageMeasurement, null);
  const usagelessMetrics = await rpc(gateway.base, token.access_token, 29, "tools/call", { name: "paperclipGetRunMetrics", arguments: { runId: "55555555-5555-5555-5555-555555555555" } }, session);
  assert.equal(usagelessMetrics.status, 200);
  for (const field of ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens", "totalTokens", "provider", "model", "usageMeasurement"]) {
    assert.equal(usagelessMetrics.json.result.structuredContent[field], null, `${field} must stay null without persisted usage`);
  }
  const upstreamFailure = await rpc(gateway.base, token.access_token, 22, "tools/call", { name: "paperclipMe", arguments: {} }, session);
  assert.equal(upstreamFailure.status, 503);

  const cases = [
    [{ mode: "EXECUTE", request: "sprawdź stan", context: "issue:in-scope" }, "EXECUTE", true],
    [{ request: "MODE=EXECUTE napraw integrację" }, "EXECUTE", true],
    [{ request: "napraw integrację i wykonaj zmiany" }, "EXECUTE", true],
    [{ request: "sprawdź integrację" }, "DIAGNOSE", false],
  ];
  let callId = 3;
  for (const [input, expectedMode, writable] of cases) {
    const response = await rpc(gateway.base, token.access_token, callId++, "tools/call", { name: "paperclipUseSkill", arguments: { skill: "paperclip-napraw-tools", ...input } }, session);
    assert.equal(response.status, 200);
    assert.equal(response.json.result.structuredContent.mode, expectedMode);
    assert.equal(response.json.result.structuredContent.allowedWrites > 0, writable);
    if (input.context) {
      const outOfScope = await rpc(gateway.base, token.access_token, callId++, "tools/call", { name: "paperclipAddComment", arguments: { issueId: "out-of-scope", body: "must not reach upstream" } }, session);
      assert.equal(outOfScope.status, 403);
      assert.equal(outOfScope.json.error.data.code, "SKILL_WRITE_GUARD_DENIED");
    }
  }
  const coo = await rpc(gateway.base, token.access_token, callId, "tools/call", { name: "paperclipUseSkill", arguments: { skill: "paperclip-deleguj-coo", request: "MODE=EXECUTE wykonaj zmiany" } }, session);
  assert.equal(coo.status, 400);
  assert.equal(coo.json.error.data.code, "MODE_NOT_ALLOWED");
  assert.match(coo.json.error.message, /Mode EXECUTE is not allowed/);
  const ctb = await rpc(gateway.base, token.access_token, callId + 1, "tools/call", { name: "paperclipUseSkill", arguments: { skill: "paperclip-napraw-tools", request: "Przebuduj architekturę OpenCode/Paperclip execution engine." } }, session);
  assert.equal(ctb.status, 200);
  assert.deepEqual(ctb.json.result.structuredContent, { CHANGE_CLASS: "CTB", HANDOFF_TO: "OpenCode CTB", RESULT: "HANDOFF", selectedSkill: "paperclip-napraw-tools" });

  await stopGateway(gateway.process);
  gateway = await startGateway({ storage, upstreamPort });
  const rotated = await refresh(gateway.base, client.client_id, token.refresh_token);
  assert.equal(rotated.status, 200);
  assert.ok(rotated.json.access_token);
  assert.ok(rotated.json.refresh_token);
  assert.notEqual(rotated.json.refresh_token, token.refresh_token);
  const old = await refresh(gateway.base, client.client_id, token.refresh_token);
  assert.equal(old.status, 400);
  assert.equal(old.json.error, "invalid_grant");
  const revoked = await fetch(`${gateway.base}/oauth/revoke`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: rotated.json.refresh_token }),
  });
  assert.equal(revoked.status, 200);
  const revokedRefresh = await refresh(gateway.base, client.client_id, rotated.json.refresh_token);
  assert.equal(revokedRefresh.status, 400);
  assert.equal(revokedRefresh.json.error, "invalid_grant");
  const expiring = await authenticate(gateway.base);
  await stopGateway(gateway.process);
  gateway = await startGateway({ storage, upstreamPort, refreshTtlMs: "1" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const expired = await refresh(gateway.base, expiring.client.client_id, expiring.token.refresh_token);
  assert.equal(expired.status, 400);
  assert.equal(expired.json.error, "invalid_grant");
});

test("public document and Wiki surface enforces scopes, grants, proposals, and resource descriptions", async (t) => {
  const storage = mkdtempSync(join(root, ".tmp-mcp-public-surface-"));
  const companyId = "11111111-1111-1111-1111-111111111111";
  let page = "---\ntitle: Sprawności API\ndescription: Reguły pobierania i interpretacji danych API sprawności.\ntags:\n  - api\n---\n\n# Sprawności API\n\nInitial rule.\n";
  let documentBody = "Initial document.";
  let documentRevision = "rev-1";
  const pageHash = () => createHash("sha256").update(page).digest("hex");
  const upstream = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body || "{}");
    const name = message.params?.name;
    const args = message.params?.arguments || {};
    let result;
    if (message.method === "initialize") result = { protocolVersion: "2025-03-26", capabilities: {} };
    else if (message.method === "tools/list") result = { tools: ["paperclipListDocuments", "paperclipGetDocument"].map((tool) => ({ name: tool, description: tool, inputSchema: { type: "object" } })) };
    else if (name === "paperclipApiRequest") {
      const apiBody = args.jsonBody ? JSON.parse(args.jsonBody) : {};
      if (args.path.startsWith("/plugins/paperclipai.plugin-llm-wiki/api/mcp-pages")) {
        result = { structuredContent: { pages: [{ path: "wiki/sprawnosci-api.md", title: "Sprawności API", description: "Reguły pobierania i interpretacji danych API sprawności.", tags: ["api"], contentHash: pageHash(), updatedAt: "2026-08-23T00:00:00.000Z" }] } };
      } else if (args.path.startsWith("/plugins/paperclipai.plugin-llm-wiki/api/mcp-page") && args.method === "GET") {
        result = { structuredContent: { contents: page, hash: pageHash() } };
      } else if (args.path === "/plugins/paperclipai.plugin-llm-wiki/api/mcp-page") {
        if (apiBody.expectedHash !== pageHash()) return res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "Refusing to overwrite stale page: expected hash" } }));
        page = apiBody.contents;
        result = { structuredContent: { hash: pageHash() } };
      } else result = { structuredContent: {} };
    } else if (name === "paperclipGetIssue") result = { structuredContent: { id: args.issueId, companyId } };
    else if (name === "paperclipListDocuments") result = { structuredContent: { documents: [{ id: "doc-1", key: "plan", title: "Plan", latestRevisionId: documentRevision, updatedAt: "2026-08-23T00:00:00.000Z" }] } };
    else if (name === "paperclipGetDocument") result = { structuredContent: { id: "doc-1", key: "plan", body: documentBody, latestRevisionId: documentRevision, companyId } };
    else if (name === "paperclipListDocumentRevisions") result = { structuredContent: { revisions: [{ id: "rev-1", body: "Initial document." }, { id: documentRevision, body: documentBody }] } };
    else if (name === "paperclipUpsertIssueDocument") {
      if (args.baseRevisionId !== documentRevision) return res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "Document was updated by someone else: currentRevisionId" } }));
      documentBody = args.body;
      documentRevision = "rev-2";
      result = { structuredContent: { id: "doc-1", key: "plan", body: documentBody, latestRevisionId: documentRevision, companyId } };
    } else if (name === "paperclipListIssues") result = { structuredContent: { issues: [] } };
    else result = { structuredContent: {} };
    res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "surface-upstream" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  const upstreamPort = await listen(upstream);
  const gateway = await startGateway({ storage, upstreamPort, principals: { "gateway-test-user": { sub: "paperclip-user", companyIds: [companyId] } } });
  t.after(async () => {
    await stopGateway(gateway.process);
    await close(upstream);
    rmSync(storage, { recursive: true, force: true });
  });

  const readAuth = await authenticate(gateway.base, "mcp:read paperclip:documents:read paperclip:wiki:read");
  const initialized = await rpc(gateway.base, readAuth.token.access_token, 1, "initialize", { protocolVersion: "2025-03-26", capabilities: {} });
  const session = initialized.session;
  const tools = await rpc(gateway.base, readAuth.token.access_token, 2, "tools/list", {}, session);
  assert.ok(tools.json.result.tools.some((tool) => tool.name === "paperclipWikiApplyChange"));
  assert.ok(!tools.json.result.tools.some((tool) => tool.name === "paperclipApiRequest"));
  const resources = await rpc(gateway.base, readAuth.token.access_token, 3, "resources/list", {}, session);
  assert.equal(resources.status, 200);
  assert.equal(resources.json.result.resources[0].name, "Sprawności API");
  assert.equal(resources.json.result.resources[0].description, "Reguły pobierania i interpretacji danych API sprawności.");
  const resourceRead = await rpc(gateway.base, readAuth.token.access_token, 31, "resources/read", { uri: resources.json.result.resources[0].uri }, session);
  assert.match(resourceRead.json.result.contents[0].text, /Initial rule/);
  const skills = await rpc(gateway.base, readAuth.token.access_token, 4, "skills/list", {}, session);
  assert.equal(skills.json.result.skills.find((skill) => skill.name === "wiki-propose-change").mode, "PLAN");
  assert.equal(skills.json.result.skills.find((skill) => skill.name === "wiki-apply-change").requiresExpectedHash, true);
  const read = await rpc(gateway.base, readAuth.token.access_token, 5, "tools/call", { name: "paperclipWikiGetPage", arguments: { page: "wiki/sprawnosci-api.md" } }, session);
  assert.match(read.json.result.structuredContent.content, /Initial rule/);
  const deniedWrite = await rpc(gateway.base, readAuth.token.access_token, 6, "tools/call", { name: "paperclipWikiProposeChange", arguments: { page: "wiki/sprawnosci-api.md", expectedHash: pageHash(), content: page } }, session);
  assert.equal(deniedWrite.status, 403);
  assert.equal(deniedWrite.json.error.data.code, "INSUFFICIENT_SCOPE");
  const deniedBoardWrite = await rpc(gateway.base, readAuth.token.access_token, 61, "tools/call", { name: "paperclipCancelHeartbeatRun", arguments: { runId: "33333333-3333-3333-3333-333333333333" } }, session);
  assert.equal(deniedBoardWrite.status, 403);
  assert.equal(deniedBoardWrite.json.error.data.requiredScope, "mcp:write");
  const forbidden = await rpc(gateway.base, readAuth.token.access_token, 7, "tools/call", { name: "paperclipWikiGetPage", arguments: { page: "%2e%2e/raw/secret.md" } }, session);
  assert.equal(forbidden.json.error.data.code, "WIKI_PATH_FORBIDDEN");
  const wrongCompany = await rpc(gateway.base, readAuth.token.access_token, 8, "tools/call", { name: "paperclipWikiGetPage", arguments: { companyId: "22222222-2222-2222-2222-222222222222", page: "wiki/sprawnosci-api.md" } }, session);
  assert.equal(wrongCompany.json.error.data.code, "COMPANY_ACCESS_DENIED");
  const documents = await rpc(gateway.base, readAuth.token.access_token, 81, "tools/call", { name: "paperclipListDocuments", arguments: { issueId: "issue-1" } }, session);
  assert.equal(documents.json.result.structuredContent.documents[0].latestRevisionId, "rev-1");
  const documentHistory = await rpc(gateway.base, readAuth.token.access_token, 82, "tools/call", { name: "paperclipGetDocumentHistory", arguments: { issueId: "issue-1", key: "plan" } }, session);
  assert.equal(documentHistory.json.result.structuredContent.revisions[0].id, "rev-1");
  const documentWriteDenied = await rpc(gateway.base, readAuth.token.access_token, 83, "tools/call", { name: "paperclipUpdateDocument", arguments: { issueId: "issue-1", key: "plan", baseRevisionId: "rev-1", content: "No permission." } }, session);
  assert.equal(documentWriteDenied.status, 403);

  const writeAuth = await authenticate(gateway.base, "mcp:read mcp:write paperclip:wiki:read paperclip:wiki:write");
  const writeInit = await rpc(gateway.base, writeAuth.token.access_token, 9, "initialize", { protocolVersion: "2025-03-26", capabilities: {} });
  const writeSession = writeInit.session;
  const oldHash = pageHash();
  const proposal = await rpc(gateway.base, writeAuth.token.access_token, 10, "tools/call", { name: "paperclipWikiProposeChange", arguments: { page: "wiki/sprawnosci-api.md", expectedHash: oldHash, content: page.replace("Initial", "Updated") } }, writeSession);
  assert.equal(proposal.json.result.structuredContent.baseHash, oldHash);
  assert.equal(pageHash(), oldHash);
  const applied = await rpc(gateway.base, writeAuth.token.access_token, 11, "tools/call", { name: "paperclipWikiApplyChange", arguments: { proposalId: proposal.json.result.structuredContent.proposalId, expectedHash: oldHash } }, writeSession);
  assert.equal(applied.json.result.structuredContent.previousHash, oldHash);
  assert.notEqual(applied.json.result.structuredContent.newHash, oldHash);
  const replay = await rpc(gateway.base, writeAuth.token.access_token, 12, "tools/call", { name: "paperclipWikiApplyChange", arguments: { proposalId: proposal.json.result.structuredContent.proposalId, expectedHash: oldHash } }, writeSession);
  assert.deepEqual(replay.json.result.structuredContent, applied.json.result.structuredContent);
  const staleBase = pageHash();
  const staleProposal = await rpc(gateway.base, writeAuth.token.access_token, 13, "tools/call", { name: "paperclipWikiProposeChange", arguments: { page: "wiki/sprawnosci-api.md", expectedHash: staleBase, content: `${page}\nSecond update.\n` } }, writeSession);
  page = `${page}\nConcurrent update.\n`;
  const staleApply = await rpc(gateway.base, writeAuth.token.access_token, 14, "tools/call", { name: "paperclipWikiApplyChange", arguments: { proposalId: staleProposal.json.result.structuredContent.proposalId, expectedHash: staleBase } }, writeSession);
  assert.equal(staleApply.json.error.data.code, "WIKI_HASH_CONFLICT");
  assert.match(page, /Concurrent update/);

  const documentAuth = await authenticate(gateway.base, "mcp:read paperclip:documents:read paperclip:documents:write");
  const documentInit = await rpc(gateway.base, documentAuth.token.access_token, 15, "initialize", { protocolVersion: "2025-03-26", capabilities: {} });
  const documentSession = documentInit.session;
  const documentUpdate = await rpc(gateway.base, documentAuth.token.access_token, 16, "tools/call", { name: "paperclipUpdateDocument", arguments: { issueId: "issue-1", key: "plan", baseRevisionId: "rev-1", content: "Updated document." } }, documentSession);
  assert.equal(documentUpdate.json.result.structuredContent.latestRevisionId, "rev-2");
  const staleDocument = await rpc(gateway.base, documentAuth.token.access_token, 17, "tools/call", { name: "paperclipUpdateDocument", arguments: { issueId: "issue-1", key: "plan", baseRevisionId: "rev-1", content: "Must not overwrite." } }, documentSession);
  assert.equal(staleDocument.json.error.data.code, "DOCUMENT_REVISION_CONFLICT");
});
