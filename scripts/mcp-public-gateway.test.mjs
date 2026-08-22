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

async function startGateway({ storage, upstreamPort, refreshTtlMs = "10000" }) {
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
    const result = message.method === "tools/list" ? { tools: [] } : { protocolVersion: "2025-03-26", capabilities: {} };
    res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "upstream-session" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  const upstreamPort = await listen(upstream);
  let gateway = await startGateway({ storage, upstreamPort });
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
