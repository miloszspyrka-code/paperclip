import crypto from "node:crypto";

const base = "https://mcp.kompaszbiorek.pl";
const mcp = `${base}/mcp`;
const redirectUri = "http://127.0.0.1:8765/callback";

async function main() {
  const registration = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "OpenCode operator smoke", redirect_uris: [redirectUri] }),
  });
  const client = await registration.json();
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const query = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "mcp:read mcp:write",
    resource: mcp,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const authorizationUrl = `${base}/oauth/authorize?${query}`;
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
  const location = consent.headers.get("location") || "";
  const code = new URL(location).searchParams.get("code");
  if (consent.status !== 302 || !code) throw new Error("OAuth consent did not return a code");

  const tokenResponse = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: mcp,
    }),
  });
  const token = await tokenResponse.json();
  if (!token.access_token) throw new Error("OAuth token was not issued");

  async function rpc(id, method, params, session) {
    const response = await fetch(mcp, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.access_token}`,
        "content-type": "application/json",
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    return {
      status: response.status,
      session: response.headers.get("mcp-session-id") || session,
      json: await response.json(),
    };
  }

  const initialize = await rpc(1, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "operator-smoke", version: "1.0.0" },
  });
  const session = initialize.session;
  const list = await rpc(2, "skills/list", {}, session);
  const skills = list.json.result?.skills || [];
  const debug = skills.find((skill) => skill.frontmatter?.name === "paperclip-debug-run");
  const coo = skills.find((skill) => skill.frontmatter?.name === "paperclip-deleguj-coo");
  if (!debug || !coo) throw new Error("Expected operator skills were not listed");
  const detail = await rpc(3, "skills/get", { uri: debug.uri }, session);
  const resource = await rpc(4, "resources/read", { uri: debug.uri }, session);
  const debugContentLoaded = resource.json.result?.contents?.[0]?.text?.includes("FAILURE_LAYER") === true;
  console.log(JSON.stringify({
    initialize: initialize.status,
    skillsList: list.status,
    skillCount: skills.length,
    debugFound: true,
    cooFound: true,
    debugGet: detail.status,
    debugContentLoaded,
    obsoleteFound: skills.some((skill) => skill.frontmatter?.name === "chatgpt-cli-handoff"),
  }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
