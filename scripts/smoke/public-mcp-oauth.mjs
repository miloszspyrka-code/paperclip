import { createHash, randomBytes } from "node:crypto";

const base = (process.env.MCP_PUBLIC_ISSUER || "https://mcp.kompaszbiorek.pl").replace(/\/+$/, "");
const username = process.env.MCP_PUBLIC_USER;
const password = process.env.MCP_PUBLIC_PASS;
if (!username || !password) throw new Error("MCP_PUBLIC_USER and MCP_PUBLIC_PASS are required");

const redirectUri = "http://127.0.0.1:8765/callback";
const scopes = "mcp:read mcp:write paperclip:documents:read paperclip:documents:write paperclip:wiki:read paperclip:wiki:write";

async function json(response) {
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${body.error || body.message || "request failed"}`);
  return body;
}

async function authenticate(scope = scopes) {
  const registered = await json(await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Paperclip public smoke", redirect_uris: [redirectUri], scope }),
  }));
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = new URL(`${base}/oauth/authorize`);
  authorize.search = new URLSearchParams({
    client_id: registered.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    scope,
    resource: `${base}/mcp`,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  const login = await fetch(authorize, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username, password }),
  });
  if (login.status !== 302) throw new Error(`OAuth login failed: ${login.status}`);
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("OAuth login did not create a session");
  const consent = await fetch(authorize, { redirect: "manual", headers: { cookie } });
  if (consent.status !== 302) throw new Error(`OAuth consent failed: ${consent.status}`);
  const code = new URL(consent.headers.get("location")).searchParams.get("code");
  if (!code) throw new Error("OAuth consent did not return a code");
  return json(await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: registered.client_id,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: `${base}/mcp`,
    }),
  }));
}

async function rpc(token, id, method, params, session) {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token.access_token}`,
      "content-type": "application/json",
      ...(session ? { "mcp-session-id": session } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return { status: response.status, body: await response.json(), session: response.headers.get("mcp-session-id") || session };
}

function toolText(response) {
  const text = response.body.result?.content?.find((entry) => entry.type === "text")?.text;
  return text ? JSON.parse(text) : null;
}

const full = await authenticate();
const initialized = await rpc(full, 1, "initialize", { protocolVersion: "2025-03-26", capabilities: {} });
if (initialized.status !== 200) throw new Error(`initialize failed: ${initialized.status}`);
const tools = await rpc(full, 2, "tools/list", {}, initialized.session);
const me = await rpc(full, 3, "tools/call", { name: "paperclipMe", arguments: {} }, initialized.session);
const resources = await rpc(full, 4, "resources/list", {}, initialized.session);
const skills = await rpc(full, 5, "skills/list", {}, initialized.session);
const wiki = await rpc(full, 6, "tools/call", { name: "paperclipWikiList", arguments: {} }, initialized.session);
const wikiPages = toolText(wiki)?.pages || [];
const firstWikiPage = wikiPages[0]?._meta?.page || null;
const wikiRead = firstWikiPage
  ? await rpc(full, 7, "tools/call", { name: "paperclipWikiGetPage", arguments: { page: firstWikiPage } }, initialized.session)
  : { status: 404, body: {} };
const wikiPage = toolText(wikiRead);
const proposal = wikiPage?.hash
  ? await rpc(full, 8, "tools/call", {
    name: "paperclipWikiProposeChange",
    arguments: { page: firstWikiPage, expectedHash: wikiPage.hash, content: wikiPage.content },
  }, initialized.session)
  : { status: 404, body: {} };
const proposalData = toolText(proposal);
const staleApply = proposalData?.proposalId
  ? await rpc(full, 9, "tools/call", {
    name: "paperclipWikiApplyChange",
    arguments: { proposalId: proposalData.proposalId, expectedHash: "intentionally-stale-hash" },
  }, initialized.session)
  : { status: 404, body: {} };
const firstResource = resources.body.result?.resources?.[0];
const resourceRead = firstResource
  ? await rpc(full, 10, "resources/read", { uri: firstResource.uri }, initialized.session)
  : { status: 404, body: {} };
const readOnly = await authenticate("mcp:read paperclip:wiki:read");
const denied = await rpc(readOnly, 11, "tools/call", {
  name: "paperclipWikiProposeChange",
  arguments: { page: "wiki/does-not-matter.md", expectedHash: "stale", content: "no write" },
});

const names = new Set((tools.body.result?.tools || []).map((tool) => tool.name));
const actor = toolText(me);
const report = {
  initialize: initialized.status,
  toolsList: tools.status,
  resourcesList: resources.status,
  resourcesRead: resourceRead.status,
  skillsList: skills.status,
  wikiList: wiki.status,
  wikiRead: wikiRead.status,
  wikiPropose: proposal.status,
  wikiStaleApplyConflict: staleApply.status === 400 && staleApply.body.error?.data?.code === "WIKI_HASH_CONFLICT",
  executionActor: actor?.name || null,
  executionActorId: actor?.id || null,
  companyId: actor?.companyId || null,
  documentTools: ["paperclipListDocuments", "paperclipGetDocumentHistory", "paperclipUpdateDocument"].every((name) => names.has(name)),
  wikiTools: ["paperclipWikiList", "paperclipWikiSearch", "paperclipWikiGetPage", "paperclipWikiProposeChange", "paperclipWikiApplyChange"].every((name) => names.has(name)),
  apiEscapeHatchPresent: names.has("paperclipApiRequest"),
  resourceCount: (resources.body.result?.resources || []).length,
  editingSkills: (skills.body.result?.skills || []).filter((skill) => skill.name?.startsWith("wiki-")).map((skill) => ({ name: skill.name, mode: skill.mode })),
  readScopeWriteDenied: denied.status === 403 && denied.body.error?.data?.code === "INSUFFICIENT_SCOPE",
};

if (report.executionActorId !== "da8d1a1d-dd22-4716-a142-0420b0147672") throw new Error("Public MCP is not using Kompas COO");
if (report.companyId !== "9894e3c2-3317-46ca-8c72-7a442a76a78e") throw new Error("Public MCP uses the wrong company");
if (!report.documentTools || !report.wikiTools || report.apiEscapeHatchPresent || !report.readScopeWriteDenied || !report.wikiStaleApplyConflict) throw new Error("Public MCP security surface is incomplete");
console.log(JSON.stringify(report));
