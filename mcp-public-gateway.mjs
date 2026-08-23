import http from "node:http";
import https from "node:https";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  CHATGPT_PUBLIC_TOOL_NAME_SET,
  CHATGPT_PUBLIC_TOOL_DESCRIPTIONS,
  PUBLIC_GATEWAY_TOOLS,
  filterChatGptPublicTools,
} from "./scripts/mcp-public-tool-catalog.mjs";
import {
  enforceWriteGuard,
  SKILL_REGISTRY,
} from "./scripts/paperclip-skill-contract.mjs";
import { RefreshTokenStore } from "./mcp-public-gateway/refresh-token-store.mjs";
import { createSkillOperationRouter } from "./mcp-public-gateway/skill-operation-router.mjs";
import {
  AuthorizationCodeStore,
  OAUTH_SCOPES,
  authorizationServerMetadata,
  normalizeScope,
  protectedResourceMetadata,
} from "./mcp-public-gateway/oauth-flow.mjs";
import { createHttpTransport, readBody, sendHtml, sendJson } from "./mcp-public-gateway/http-transport.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3103);
const ISSUER = (process.env.MCP_PUBLIC_ISSUER || "https://mcp.kompaszbiorek.pl").replace(/\/+$/, "");
const KEY_FILE = process.env.MCP_PUBLIC_KEY_FILE || join(__dirname, "secrets", "mcp-public.key");
const CLIENTS_FILE = join(__dirname, "data", "mcp-public-clients.json");
const REFRESH_TOKENS_FILE = process.env.MCP_PUBLIC_REFRESH_TOKENS_FILE || join(__dirname, "data", "mcp-public-refresh-tokens.json");
const AUDIT_FILE = process.env.MCP_PUBLIC_AUDIT_FILE || join(__dirname, "data", "mcp-public-audit.jsonl");
const USER = process.env.MCP_PUBLIC_USER || "milos";
const PASS = process.env.MCP_PUBLIC_PASS || "";
const TARGETS_JSON = process.env.MCP_PUBLIC_TARGETS || "{}";
const ACCESS_TOKEN_TTL_MS = Number(process.env.MCP_PUBLIC_ACCESS_TTL_MS || 315360000000);
const REFRESH_TOKEN_TTL_MS = Number(process.env.MCP_PUBLIC_REFRESH_TTL_MS || 315360000000);
const CODE_TTL_MS = 10 * 60 * 1000;

const TARGETS = JSON.parse(TARGETS_JSON);
const DEFAULT_APP = process.env.MCP_PUBLIC_DEFAULT_APP || "paperclip";
const SKILLS_ROOT = join(__dirname, "skills");
const OPERATOR_SKILL_NAMES = [
  "paperclip-debug-run",
  "paperclip-napraw-tools",
  "paperclip-opencode-health",
  "paperclip-deleguj-coo",
  "paperclip-wdroz-runtime",
  "wiki-query",
  "wiki-propose-change",
  "wiki-apply-change",
];
const CTB_RUN_REGISTRY_FILE = process.env.OPENCODE_CTB_RUN_REGISTRY_FILE || "C:\\Kompas Zbiórek\\opencode-mcp\\.runtime\\ctb-runs.json";
const WIKI_PROPOSALS = new Map();
const PUBLIC_GATEWAY_TOOL_NAMES = new Set([
  ...PUBLIC_GATEWAY_TOOLS.map((tool) => tool.name),
  "paperclipListDocuments",
  "paperclipGetDocument",
]);

function configuredPrincipals() {
  try {
    const parsed = JSON.parse(process.env.MCP_PUBLIC_PRINCIPALS || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
const PRINCIPALS = configuredPrincipals();

function principalForLogin(login) {
  const configured = PRINCIPALS[login];
  if (!configured || typeof configured !== "object") {
    // Existing installations keep their legacy operator tools, but no document
    // or Wiki company scope is granted until an explicit identity mapping exists.
    return { sub: `external:${login}`, companyIds: [] };
  }
  return {
    sub: typeof configured.sub === "string" && configured.sub.trim() ? configured.sub.trim() : `external:${login}`,
    companyIds: Array.isArray(configured.companyIds) ? configured.companyIds.filter((id) => typeof id === "string") : [],
  };
}

function scopes(payload) {
  return new Set(String(payload?.scope || "").split(/\s+/).filter(Boolean));
}

function hasScope(payload, scope) {
  return scopes(payload).has(scope);
}

function requiredScopeForTool(name) {
  if (["paperclipListDocuments", "paperclipGetDocument", "paperclipGetDocumentHistory", "paperclipGetDocumentRevision"].includes(name)) return "paperclip:documents:read";
  if (name === "paperclipUpdateDocument") return "paperclip:documents:write";
  if (["paperclipWikiList", "paperclipWikiSearch", "paperclipWikiGetPage", "paperclipWikiGetMetadata"].includes(name)) return "paperclip:wiki:read";
  if (["paperclipWikiProposeChange", "paperclipWikiApplyChange"].includes(name)) return "paperclip:wiki:write";
  if (PUBLIC_WRITE_TOOL_NAMES.has(name)) return "mcp:write";
  return "mcp:read";
}

function selectCompany(payload, requested) {
  const companyIds = Array.isArray(payload?.company_ids) ? payload.company_ids : [];
  const companyId = typeof requested === "string" && requested.trim() ? requested.trim() : companyIds.length === 1 ? companyIds[0] : null;
  if (!companyId || !companyIds.includes(companyId)) {
    const error = new Error("The authenticated principal is not granted access to this company");
    error.code = "COMPANY_ACCESS_DENIED";
    throw error;
  }
  return companyId;
}

function rpcToolResult(data) {
  return { result: { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data } };
}

function rpcError(code, message, data = {}) {
  return { error: { code, message, data } };
}

function ctbRuns() {
  try {
    const parsed = JSON.parse(readFileSync(CTB_RUN_REGISTRY_FILE, "utf8"));
    const records = parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.runs && typeof parsed.runs === "object" ? parsed.runs : parsed;
    return Object.values(records && typeof records === "object" ? records : {}).filter((run) => run && typeof run === "object" && typeof run.runId === "string");
  } catch {
    return [];
  }
}

function ctbRunMetrics(run) {
  const events = Array.isArray(run.events) ? run.events : [];
  const toolEvents = events.filter((event) => ["tool", "mcp", "search", "file", "command", "test", "git"].includes(event.kind));
  const fingerprints = new Set();
  let duplicateCalls = 0;
  for (const event of toolEvents) {
    const fingerprint = `${event.kind}|${event.tool || event.action || ""}|${event.status || ""}`;
    if (fingerprints.has(fingerprint)) duplicateCalls += 1;
    else fingerprints.add(fingerprint);
  }
  const startedAt = Date.parse(run.createdAt || "") || 0;
  const elapsed = (event) => { const timestamp = Date.parse(event.timestamp || "") || 0; return startedAt && timestamp ? Math.max(0, timestamp - startedAt) : null; };
  const firstWrite = events.find((event) => event.kind === "file" && event.operation === "write");
  const firstTest = events.find((event) => event.kind === "test");
  const finishedAt = Date.parse(run.finishedAt || "") || startedAt;
  return {
    toolCalls: toolEvents.length,
    failedToolCalls: toolEvents.filter((event) => event.status === "error").length,
    retryCount: events.reduce((total, event) => total + (Number(event.retry) || 0), 0),
    duplicateCalls,
    searchCalls: events.filter((event) => event.kind === "search").length,
    fileReads: events.filter((event) => event.kind === "file" && event.operation === "read").length,
    fileWrites: events.filter((event) => event.kind === "file" && event.operation === "write").length,
    testCalls: events.filter((event) => event.kind === "test").length,
    mcpCalls: events.filter((event) => event.kind === "mcp").length,
    timeToFirstWriteMs: firstWrite ? elapsed(firstWrite) : null,
    timeToFirstTestMs: firstTest ? elapsed(firstTest) : null,
    durationMs: startedAt ? Math.max(0, finishedAt - startedAt) : 0,
  };
}

function auditWrite(input) {
  const entry = { timestamp: new Date().toISOString(), ...input };
  try {
    mkdirSync(dirname(AUDIT_FILE), { recursive: true, mode: 0o700 });
    appendFileSync(AUDIT_FILE, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    log("audit write failed", { error: String(error?.message || error) });
  }
}

function decodePath(value) {
  let decoded = String(value || "").trim();
  for (let index = 0; index < 3; index += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      throw new Error("Invalid encoded Wiki page path");
    }
  }
  return decoded;
}

function assertPublicWikiPage(value) {
  const page = decodePath(value).replaceAll("\\", "/").replace(/^\/+/, "");
  const segments = page.split("/");
  if (!page || !page.endsWith(".md") || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("WIKI_PATH_FORBIDDEN");
  }
  const lower = page.toLowerCase();
  if (!lower.startsWith("wiki/") || lower.startsWith("raw/") || lower.includes("/.git/") || lower.startsWith(".git/") || lower.includes(".env") || /(^|\/)(agents\.md|templates?)(\/|$)/i.test(page)) {
    throw new Error("WIKI_PATH_FORBIDDEN");
  }
  return page;
}

function hash(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function metadataFromMarkdown(path, text, fallback = {}) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)?.[1] || "";
  const field = (name) => new RegExp(`^${name}:\\s*[\\"']?(.+?)[\\"']?\\s*$`, "mi").exec(frontmatter)?.[1]?.trim() || null;
  const heading = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() || null;
  const lead = text.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith("#") && !line.startsWith("---") && !/^(title|description|tags):/i.test(line)) || null;
  const title = field("title") || fallback.title || heading || path.split("/").pop().replace(/\.md$/i, "").replace(/[-_]+/g, " ");
  const description = field("description") || fallback.description || lead || `Wiki page: ${title}.`;
  const tags = [...frontmatter.matchAll(/^\s*-\s*([^\r\n]+)\s*$/gm)].map((match) => match[1].trim());
  return { title, description, tags };
}

function loadOrCreateKey() {
  if (existsSync(KEY_FILE)) return readFileSync(KEY_FILE, "utf8").trim();
  mkdirSync(dirname(KEY_FILE), { recursive: true });
  const key = randomBytes(48).toString("hex");
  writeFileSync(KEY_FILE, key, { mode: 0o600 });
  return key;
}
const HMAC_KEY = loadOrCreateKey();

function loadClients() {
  if (!existsSync(CLIENTS_FILE)) return {};
  try { return JSON.parse(readFileSync(CLIENTS_FILE, "utf8")); } catch { return {}; }
}
function saveClients() {
  try {
    mkdirSync(dirname(CLIENTS_FILE), { recursive: true });
    writeFileSync(CLIENTS_FILE, JSON.stringify(CLIENTS, null, 2));
  } catch {}
}
const CLIENTS = loadClients();

const codes = new AuthorizationCodeStore({ ttlMs: CODE_TTL_MS });
const refreshTokens = new RefreshTokenStore({ file: REFRESH_TOKENS_FILE, ttlMs: REFRESH_TOKEN_TTL_MS });
const sessions = new Map();
const failedLogins = new Map();

function log(...args) { console.log(`[mcp-public ${new Date().toISOString()}]`, ...args); }

function base64url(buf) { return Buffer.from(buf).toString("base64url"); }
function randToken(bytes = 32) { return base64url(randomBytes(bytes)); }
function sign(payload) {
  const enc = base64url(JSON.stringify(payload));
  const sig = createHmac("sha256", HMAC_KEY).update(enc).digest("base64url");
  return `${enc}.${sig}`;
}
function verifyToken(jwt) {
  try {
    const [enc, sig] = jwt.split(".");
    if (!enc || !sig) return null;
    const expect = createHmac("sha256", HMAC_KEY).update(enc).digest("base64url");
    const a = Buffer.from(sig); const b = Buffer.from(expect);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return JSON.parse(Buffer.from(enc, "base64url").toString("utf8"));
  } catch { return null; }
}
function nowMs() { return Date.now(); }

function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function constantTimeEq(a, b) {
  const ba = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function extractToken(req) {
  const authz = (req.headers.authorization || "").toString();
  let token = null;
  if (/^Bearer\s+/i.test(authz)) token = authz.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    const q = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    token = q.searchParams.get("access_token") || q.searchParams.get("token") || "";
  }
  return { token, headerAuth: !!authz };
}

function validFor(payload, app) {
  const resource = resourceUrlFor(app);
  return !!payload && payload.iss === ISSUER && payload.aud === resource && payload.exp * 1000 > nowMs();
}

async function authFailedRawBody(req) {
  try { return await readBody(req); } catch { return ""; }
}

function sendMcp401(res, app, method, headerAuth) {
  const code = "PAPERCLIP_AUTH_TOKEN_REQUIRED";
  log("401", { app, hasToken: false, method, headerAuth, code });
  res.writeHead(401, {
    "Content-Type": "application/json",
    "WWW-Authenticate": `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource", scope="mcp:read mcp:write", error="invalid_token", error_description="Access token required (${code})"`,
  });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized", data: { code, hint: "Reconnect with OAuth for https://mcp.kompaszbiorek.pl/mcp" } }, id: null }));
}

function clientIp(req) {
  const cf = (req.headers["cf-connecting-ip"] || "").toString().trim();
  if (cf) return cf.split(",")[0].trim();
  const xff = (req.headers["x-forwarded-for"] || "").toString().trim();
  if (xff) return xff.split(",")[0].trim();
  return (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
}

function parseSkillFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return {};
  const frontmatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) frontmatter[key] = value;
  }
  return frontmatter;
}

function skillResourceUri(skillName, relativePath) {
  return `skill://paperclip/${skillName}/${relativePath.replaceAll("\\", "/")}`;
}

function loadOperatorSkills() {
  return OPERATOR_SKILL_NAMES.flatMap((skillName) => {
    const skillDir = join(SKILLS_ROOT, skillName);
    const skillPath = join(skillDir, "SKILL.md");
    if (!existsSync(skillPath)) return [];
    const resources = [];
    const pending = [""];
    while (pending.length > 0) {
      const relativeDir = pending.pop();
      const absoluteDir = join(skillDir, relativeDir);
      for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
        const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          pending.push(relativePath);
          continue;
        }
        const content = readFileSync(join(skillDir, relativePath));
        resources.push({
          uri: skillResourceUri(skillName, relativePath),
          digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
        });
      }
    }
    const markdown = readFileSync(skillPath, "utf8");
    return [{
      name: skillName,
      uri: skillResourceUri(skillName, "SKILL.md"),
      frontmatter: parseSkillFrontmatter(markdown),
      resources,
    }];
  });
}

const OPERATOR_SKILLS = loadOperatorSkills();

function publicSkillMetadata(skill) {
  const registry = SKILL_REGISTRY[skill.name];
  const mode = skill.frontmatter.mode || (registry?.modes?.length === 1 ? registry.modes[0] : registry?.modes?.includes("PLAN") ? "PLAN" : "DIAGNOSE");
  const writeScope = skill.frontmatter.writeScope || (skill.name.startsWith("wiki-") ? "wiki-pages" : null);
  return {
    uri: skill.uri,
    name: skill.name,
    version: skill.frontmatter.version || registry?.version || "1.0.0",
    description: skill.frontmatter.description || "",
    mode,
    readOnly: mode !== "EXECUTE",
    requiredTools: skill.frontmatter.requiredTools ? skill.frontmatter.requiredTools.split(",").map((entry) => entry.trim()).filter(Boolean) : [],
    capabilities: skill.frontmatter.capabilities ? skill.frontmatter.capabilities.split(",").map((entry) => entry.trim()).filter(Boolean) : [],
    ...(writeScope ? { writeScope } : {}),
    ...(skill.frontmatter.requiresExpectedHash === "true" ? { requiresExpectedHash: true } : {}),
    frontmatter: skill.frontmatter,
    resources: skill.resources,
  };
}

// Mutating public tools subject to the server-side skill write guard.
const PUBLIC_WRITE_TOOL_NAMES = new Set([
  "paperclipCreateIssue",
  "paperclipUpdateIssue",
  "paperclipAddComment",
  "paperclipControlIssueWorkspaceServices",
  "paperclipUpdateDocument",
  "paperclipWikiApplyChange",
]);

// ---------- OAuth model ----------
const SCOPES = OAUTH_SCOPES;

function appForUrl(url) {
  const m = /^\/mcp(?:\/([a-zA-Z0-9_.-]+))?$/.exec(url.pathname);
  if (!m) return null;
  const name = m[1] || DEFAULT_APP;
  return TARGETS[name] ? name : null;
}
function resourceUrlFor(app) {
  const base = `${ISSUER}/mcp`;
  return app === DEFAULT_APP ? base : `${base}/${app}`;
}
function resourceName(resource) {
  const m = /^https?:\/\/[^/]+(\/mcp(?:\/[a-zA-Z0-9_.-]+)?)$/.exec(String(resource || ""));
  if (!m) return null;
  const name = m[1].replace(/^\/mcp/, "") || "";
  const app = name.replace(/^\/+/, "") || DEFAULT_APP;
  return TARGETS[app] ? app : null;
}

function redirectAllowed(redirectUri) {
  let u;
  try { u = new URL(String(redirectUri || "")); } catch { return false; }
  if (!u.protocol) return false;
  if (u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost")) return true;
  if (u.protocol !== "https:" || u.hostname !== "chatgpt.com") return false;
  if (u.pathname === "/connector_platform_oauth_redirect") return true;
  if (/^\/connector\/oauth\/[^/]+$/.test(u.pathname)) return true;
  return false;
}

function issueAccessToken(app, clientId, scope, principal) {
  const resource = resourceUrlFor(app);
  const now = nowMs();
  return sign({
    iss: ISSUER,
    sub: principal.sub,
    company_ids: principal.companyIds,
    aud: resource,
    client_id: clientId,
    scope: scope || "mcp:read mcp:write",
    iat: Math.floor(now / 1000),
    exp: Math.floor((now + ACCESS_TOKEN_TTL_MS) / 1000),
    jti: randToken(12),
  });
}

// ---------- HTTP server ----------
const server = createHttpTransport(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const path = url.pathname;
  try {
    if (path === "/health") return sendJson(res, 200, { ok: true });

    // ---- protected-resource metadata (RFC 9728) ----
    if (path === "/.well-known/oauth-protected-resource") {
      const resource = url.searchParams.get("resource") || `${ISSUER}/mcp`;
      const app = resourceName(resource);
      if (!app) return sendJson(res, 400, { error: "invalid_resource", error_description: "Unknown MCP resource" });
      return sendJson(res, 200, protectedResourceMetadata({ issuer: ISSUER, app, resourceUrl: resourceUrlFor }), { "Cache-Control": "public, max-age=3600", "Access-Control-Allow-Origin": "*" });
    }

    // ---- authorization-server metadata (RFC 8414) ----
    if (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration") {
      return sendJson(res, 200, authorizationServerMetadata(ISSUER), { "Cache-Control": "public, max-age=3600", "Access-Control-Allow-Origin": "*" });
    }

    // ---- dynamic client registration (RFC 7591) ----
    if (path === "/oauth/register" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
      if (!redirectUris.every(redirectAllowed)) {
        return sendJson(res, 400, { error: "invalid_redirect_uri", error_description: "redirect_uri not on the allowlist" });
      }
      const client = {
        client_id: `dcr_${randToken(12)}`,
        client_id_issued_at: Math.floor(nowMs() / 1000),
        client_name: String(body.client_name || "MCP client"),
        redirect_uris: redirectUris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        scope: normalizeScope(body.scope),
        created_at: new Date().toISOString(),
      };
      CLIENTS[client.client_id] = client;
      saveClients();
      log("DCR register", { client_id: client.client_id, name: client.client_name, redirect_uris: client.redirect_uris });
      return sendJson(res, 201, client);
    }

    // ---- authorization endpoint ----
    if (path === "/oauth/authorize") {
      const q = url.searchParams;
      let clientId = q.get("client_id") || "";
      let redirectUri = q.get("redirect_uri") || "";
      const state = q.get("state") || "";
      const scope = normalizeScope(q.get("scope"));
      const resource = q.get("resource") || `${ISSUER}/mcp`;
      const codeChallenge = q.get("code_challenge") || "";
      const codeMethod = q.get("code_challenge_method") || "S256";
const fail = (error, description) => {
    log("authorize fail", { error, reason: description, clientId, redirectUri, scope, hasCookie: !!(req.headers.cookie && req.headers.cookie.includes("session")) });
    const params = new URLSearchParams({ error, error_description: description, iss: ISSUER });
    if (state) params.set("state", state);
    if (redirectAllowed(redirectUri)) {
      res.writeHead(302, { Location: `${redirectUri}?${params}` });
      return res.end();
    }
    return sendJson(res, error === "access_denied" ? 403 : 400, { error, error_description: description, iss: ISSUER, ...(state ? { state } : {}) });
  };

      let client = CLIENTS[clientId];
      if (!client) {
        const candidates = Object.values(CLIENTS)
          .filter((c) => c.client_name === "ChatGPT" || (Array.isArray(c.redirect_uris) && c.redirect_uris.some((r) => /^https:\/\/chatgpt\.com\/connector\/oauth\//.test(r))))
          .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
        client = candidates[0] || null;
      }
      if (!client) return fail("unauthorized_client", "Unknown OAuth client. (PAPERCLIP_OAUTH_UNKNOWN_CLIENT)");
      if (!clientId) clientId = client.client_id;
      if (!redirectUri && client.redirect_uris && client.redirect_uris.length) redirectUri = client.redirect_uris[0];
      if (!redirectAllowed(redirectUri)) return fail("invalid_request", "redirect_uri not allowed. (PAPERCLIP_OAUTH_INVALID_REDIRECT)");
      const app = resourceName(resource);
      if (!app) return fail("invalid_request", "Unknown resource. (PAPERCLIP_OAUTH_UNKNOWN_RESOURCE)");
      if (codeMethod !== "S256" || (codeChallenge && !/^[A-Za-z0-9\-._~]{43,128}$/.test(codeChallenge))) return fail("invalid_request", "code_challenge_method S256 is required. (PAPERCLIP_OAUTH_PKCE_REQUIRED)");

      const cookie = (req.headers.cookie || "").match(/mcp_op_session=([^;]+)/)?.[1] || null;
      if (req.method === "POST") {
        const form = new URLSearchParams(await readBody(req));
        const user = form.get("username") || "";
        const pass = form.get("password") || "";
        if (!constantTimeEq(user, USER) || !constantTimeEq(pass, PASS)) {
          const ip = clientIp(req);
          const attempts = (failedLogins.get(ip) || 0) + 1;
          failedLogins.set(ip, attempts);
          if (attempts > 10) {
            log("authorize fail", { error: "too_many_attempts", ip, attempts });
            return sendJson(res, 429, { error: "too_many_attempts", error_description: "Too many login attempts. Try again later. (PAPERCLIP_AUTH_RATE_LIMITED)", iss: ISSUER });
          }
          log("authorize fail", { error: "access_denied", reason: "Invalid credentials", clientId, ip });
          return sendHtml(res, 401, page(`Niepoprawny login lub hasło. Kod: PAPERCLIP_AUTH_INVALID_CREDENTIALS (401)`, client, scope, redirectUri, state, resource, codeChallenge, codeMethod));
        }
        failedLogins.delete(clientIp(req));
        const sessionId = randToken(16);
        sessions.set(sessionId, { createdAt: nowMs(), principal: principalForLogin(user) });
        const params = new URLSearchParams({ iss: ISSUER });
        if (state) params.set("state", state);
        res.writeHead(302, {
          Location: `${url.pathname}?${new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope, state, resource, code_challenge: codeChallenge, code_challenge_method: codeMethod })}`,
          "Set-Cookie": `mcp_op_session=${sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`,
        });
        return res.end();
      }
      if (!cookie || !sessions.has(cookie)) {
        return sendHtml(res, 200, page(null, client, scope, redirectUri, state, resource, codeChallenge, codeMethod));
      }
      // consent
      const code = randToken(24);
      codes.issue(code, { clientId, redirectUri, state, scope, resource, codeChallenge, app, principal: sessions.get(cookie).principal });
      const params = new URLSearchParams({ code, iss: ISSUER });
      if (state) params.set("state", state);
      log("authorize ok", { client_id: clientId, app, scope });
      res.writeHead(302, { Location: `${redirectUri}?${params}` });
      return res.end();
    }

    // ---- token endpoint ----
    if (path === "/oauth/token" && req.method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      const grant = form.get("grant_type");
      let clientId = form.get("client_id") || "";
      let client = CLIENTS[clientId] || null;
      const tfail = (step, extra) => {
        log("token fail", { step, grant, clientId, resource: form.get("resource") || "", redirectUri: form.get("redirect_uri") || "", ...extra });
      };
      if (grant === "authorization_code") {
        if (!client) {
          const codeObj0 = codes.get(form.get("code") || "");
          if (codeObj0 && CLIENTS[codeObj0.clientId]) {
            clientId = codeObj0.clientId;
            client = CLIENTS[codeObj0.clientId];
            tfail("client_id_fallback_taken");
          }
        }
        if (!client) {
          tfail("unknown_client");
          return sendJson(res, 401, { error: "invalid_client", error_description: "Unknown client" });
        }
        const codeObj = codes.get(form.get("code") || "");
        if (!codeObj || codeObj.clientId !== clientId || codeObj.used) {
          tfail("code", { hasCode: !!form.get("code") });
          return sendJson(res, 400, { error: "invalid_grant", error_description: "Invalid or expired authorization code" });
        }
        const verifier = form.get("code_verifier") || "";
        const expected = verifier ? base64url(createHash("sha256").update(verifier).digest()) : null;
        if (codeObj.codeChallenge && (!expected || !timingSafeEqual(Buffer.from(expected), Buffer.from(codeObj.codeChallenge)))) {
          tfail("pkce");
          return sendJson(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
        }
        const redirectUri = form.get("redirect_uri") || "";
        if (codeObj.redirectUri && redirectUri && redirectUri !== codeObj.redirectUri) {
          const allowedRegistered = (client.redirect_uris || []).includes(redirectUri) || redirectAllowed(redirectUri);
          if (!allowedRegistered) {
            tfail("redirect_uri", { codeUri: codeObj.redirectUri });
            return sendJson(res, 400, { error: "invalid_grant", error_description: "redirect_uri mismatch" });
          }
        }
        codes.consume(form.get("code"));
        const resource = form.get("resource") || codeObj.resource;
        const app = resourceName(resource);
        if (!app || app !== codeObj.app) {
          tfail("resource");
          return sendJson(res, 400, { error: "invalid_grant", error_description: "resource mismatch" });
        }
        const principal = codeObj.principal || principalForLogin(USER);
        const access = issueAccessToken(app, clientId, codeObj.scope, principal);
        const refresh = randToken(40);
        refreshTokens.issue(refresh, { clientId, app, scope: codeObj.scope, principal });
        log("token issued", { client_id: clientId, app, scope: codeObj.scope });
        return sendJson(res, 200, {
          access_token: access,
          token_type: "Bearer",
          expires_in: ACCESS_TOKEN_TTL_MS / 1000,
          refresh_token: refresh,
          scope: codeObj.scope,
        }, { "Cache-Control": "no-store", "Pragma": "no-cache" });
      }
      if (grant === "refresh_token") {
        const refresh = form.get("refresh_token") || "";
        const r = refreshTokens.get(refresh);
        if (!r || r.clientId !== clientId) return sendJson(res, 400, { error: "invalid_grant", error_description: "Invalid refresh token" });
        const resource = form.get("resource") || resourceUrlFor(r.app);
        const app = resourceName(resource);
        if (!app || app !== r.app) return sendJson(res, 400, { error: "invalid_grant", error_description: "resource mismatch" });
        const access = issueAccessToken(app, clientId, r.scope, r.principal || principalForLogin(USER));
        const next = randToken(40);
        refreshTokens.rotate(refresh, next);
        return sendJson(res, 200, {
          access_token: access,
          token_type: "Bearer",
          expires_in: ACCESS_TOKEN_TTL_MS / 1000,
          refresh_token: next,
          scope: r.scope,
        }, { "Cache-Control": "no-store", "Pragma": "no-cache" });
      }
      return sendJson(res, 400, { error: "unsupported_grant_type", error_description: "unsupported grant_type" });
    }

    // ---- revocation (RFC 7009, best-effort) ----
    if (path === "/oauth/revoke" && req.method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      const token = form.get("token") || "";
      refreshTokens.revoke(token);
      return sendJson(res, 200, {});
    }

    // ---- MCP endpoints (protected) ----
    if (req.method === "GET" && path.startsWith("/mcp")) {
      const app = appForUrl(url);
      if (!app) return sendJson(res, 404, { error: "Unknown MCP app" });
      return sendJson(res, 200, protectedResourceMetadata({ issuer: ISSUER, app, resourceUrl: resourceUrlFor }), { "Cache-Control": "public, max-age=3600", "Access-Control-Allow-Origin": "*" });
    }
    if (req.method === "POST" && path.startsWith("/mcp")) {
      if (path === "/mcp") return handleAggregate(req, res);
      const app = appForUrl(url);
      if (!app) return sendJson(res, 404, { error: "Unknown MCP app" });
      const { token, headerAuth } = extractToken(req);
      const payload = token ? verifyToken(token) : null;
      if (!validFor(payload, app)) {
        const raw = await authFailedRawBody(req);
        let method = "";
        try { method = JSON.parse(raw || "{}").method || ""; } catch {}
        return sendMcp401(res, app, method, headerAuth);
      }
      return proxyToApp(req, res, app);
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    log("error", { path, error: String(err?.message || err) });
    sendJson(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
});

function page(errText, client, scope, redirectUri, state, resource, codeChallenge, codeMethod) {
  const fields = [
    ["client_id", client?.client_id ?? ""],
    ["redirect_uri", redirectUri],
    ["response_type", "code"],
    ["scope", scope],
    ["state", state],
    ["resource", resource],
    ["code_challenge", codeChallenge],
    ["code_challenge_method", codeMethod],
  ].map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}" />`).join("\n      ");
  const errBlock = errText ? `<p class="err">${esc(errText)}</p>` : "";
  return `<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Autoryzacja MCP - Kompas Zbiórek</title><style>body{font-family:system-ui,sans-serif;max-width:420px;margin:48px auto;padding:0 16px;color:#111}h1{font-size:20px}label{display:block;margin:12px 0 4px;font-size:13px;color:#444}input{width:100%;box-sizing:border-box;padding:9px;border:1px solid #bbb;border-radius:6px;font-size:15px}button{margin-top:18px;width:100%;padding:11px;background:#114488;color:#fff;border:0;border-radius:6px;font-size:15px;cursor:pointer}.meta{font-size:12px;color:#666;background:#f4f4f4;padding:10px;border-radius:6px;margin-top:14px}.err{color:#b00020;font-size:14px}</style></head><body>
<h1>Logowanie do MCP (Kompas Zbiórek)</h1>
<p>Aplikacja: <strong>${esc(client?.client_name ?? "MCP client")}</strong></p>
<p>Zakresy: <code>${esc(scope)}</code></p>
${errBlock}
<form method="post" action="${esc("/oauth/authorize")}">
  ${fields}
  <label for="username">Login</label><input id="username" name="username" autocomplete="username" required />
  <label for="password">Hasło</label><input id="password" name="password" type="password" autocomplete="current-password" required />
  <button type="submit">Zaloguj i zezwól</button>
</form>
 <div class="meta">Operator: Kompas Zbiórek. Token nie wygasa (odświeżanie bezterminowe). Publiczny katalog operatora jest dostępny w zakresie mcp:read/mcp:write.</div>
</body></html>`;
}

function proxyToApp(req, res, app) {
  const target = TARGETS[app];
  const upstream = new URL(target.url);
  const httpMod = upstream.protocol === "https:" ? https : http;
  const headers = {
    "content-type": req.headers["content-type"] || "application/json",
    accept: req.headers["accept"] || "application/json, text/event-stream",
    ...(req.headers["mcp-session-id"] ? { "mcp-session-id": req.headers["mcp-session-id"] } : {}),
    ...(target.token ? { authorization: `Bearer ${target.token}` } : {}),
  };
  const upstreamReq = httpMod.request({
    hostname: upstream.hostname,
    port: upstream.port || (upstream.protocol === "https:" ? 443 : 80),
    method: "POST",
    path: target.path || "/mcp",
    headers,
  }, (upstreamRes) => {
    const outHeaders = { "content-type": upstreamRes.headers["content-type"] || "application/json" };
    if (upstreamRes.headers["mcp-session-id"]) outHeaders["mcp-session-id"] = upstreamRes.headers["mcp-session-id"];
    res.writeHead(upstreamRes.statusCode || 500, outHeaders);
    upstreamRes.pipe(res);
  });
  upstreamReq.on("error", (err) => {
    log("upstream error", { app, error: String(err?.message || err) });
    if (!res.headersSent) sendJson(res, 502, { jsonrpc: "2.0", error: { code: -32603, message: "Upstream unavailable" }, id: null });
    else res.destroy();
  });
  req.pipe(upstreamReq);
}

// ---------- MCP aggregator (jedno URL = paperclip + opencode + obsidian) ----------
const portalSessions = new Map();
const PREFIXED = Object.keys(TARGETS).filter((a) => a !== DEFAULT_APP);

function upstreamCall(app, upSessionId, payload) {
  const target = TARGETS[app];
  const url = new URL(target.path || "/mcp", target.url).toString();
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(upSessionId ? { "mcp-session-id": upSessionId } : {}),
      ...(target.token ? { authorization: `Bearer ${target.token}` } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  }).then(async (response) => {
    const body = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { parsed = { jsonrpc: "2.0", error: { code: -32603, message: "Upstream invalid response" }, id: null }; }
    return { json: parsed, status: response.status, upSessionId: response.headers.get("mcp-session-id") || upSessionId };
  });
}

const skillOperationRouter = createSkillOperationRouter({
  defaultApp: DEFAULT_APP,
  operatorSkills: OPERATOR_SKILLS,
  readSkill: (skillName) => readFileSync(join(SKILLS_ROOT, skillName, "SKILL.md"), "utf8"),
  ensureUpSession,
  upstreamCall,
});

function toolPrefix(app) { return `${app}__`; }

function toolNameFor(app, raw) { return PREFIXED.includes(app) ? `${toolPrefix(app)}${raw}` : raw; }

function routeToolName(name) {
  const n = String(name || "");
  for (const app of PREFIXED) {
    if (n.startsWith(toolPrefix(app))) return { app, name: n.slice(toolPrefix(app).length) };
  }
  return { app: DEFAULT_APP, name: n };
}

async function ensureUpSession(ps, app) {
  if (ps.apps[app]) return ps.apps[app];
  const init = await upstreamCall(app, null, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "kompas-mcp", version: "1.0.0" } },
  });
  const rec = { upId: init.upSessionId || null, inited: true, tools: null };
  ps.apps[app] = rec;
  if (rec.upId) await upstreamCall(app, rec.upId, { jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => {});
  return rec;
}

function gatewaySkillTools() {
  return skillOperationRouter.skillTools();
}

async function aggregatedTools(ps) {
  const out = [];
  for (const app of Object.keys(TARGETS)) {
    const rec = await ensureUpSession(ps, app);
    try {
      if (!rec.tools) {
        const r = await upstreamCall(app, rec.upId, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
        rec.tools = r.json.result?.tools || [];
      }
      for (const t of rec.tools) out.push({ ...t, name: toolNameFor(app, t.name) });
    } catch (e) {
      log("aggregate tools/list fail", { app, error: String(e?.message || e) });
    }
  }
  for (const tool of PUBLIC_GATEWAY_TOOLS) {
    if (!out.some((entry) => entry.name === tool.name)) out.push(tool);
  }
  for (const tool of gatewaySkillTools()) if (!out.some((entry) => entry.name === tool.name)) out.push(tool);
  return filterChatGptPublicTools(out);
}

async function callUpstreamTool(ps, name, args) {
  const rec = await ensureUpSession(ps, DEFAULT_APP);
  const response = await upstreamCall(DEFAULT_APP, rec.upId, {
    jsonrpc: "2.0",
    id: randToken(8),
    method: "tools/call",
    params: { name, arguments: args },
  });
  if (response.json.error) {
    const error = new Error(response.json.error.message || "Upstream tool failed");
    error.upstream = response.json.error;
    throw error;
  }
  return response.json.result;
}

function toolData(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  if (result?.data && typeof result.data === "object") return result.data;
  const text = Array.isArray(result?.content)
    ? result.content.filter((entry) => entry?.type === "text").map((entry) => entry.text).join("\n")
    : "";
  try { return JSON.parse(text); } catch { return { text }; }
}

function upstreamErrorCode(error) {
  const message = String(error?.message || error);
  if (/expected hash|Refusing to overwrite/i.test(message)) return "WIKI_HASH_CONFLICT";
  if (/currentRevisionId|updated by someone else|baseRevisionId/i.test(message)) return "DOCUMENT_REVISION_CONFLICT";
  return null;
}

function wikiResource(page, companyId, spaceSlug) {
  const path = assertPublicWikiPage(page.path || page);
  const title = page.title || path.split("/").pop().replace(/\.md$/i, "").replace(/[-_]+/g, " ");
  const description = page.description || `Wiki page: ${title}.`;
  const uri = `paperclip://companies/${encodeURIComponent(companyId)}/wiki/pages/${encodeURIComponent(path)}`;
  return {
    uri,
    name: title,
    description,
    mimeType: "text/markdown",
    _meta: {
      resourceType: "wiki-page",
      readOnly: false,
      revision: page.revisionId || null,
      hash: page.hash || page.contentHash || null,
      tags: Array.isArray(page.tags) ? page.tags : [],
      updatedAt: page.updatedAt || null,
      capabilities: ["read", "propose-change", "apply-change"],
      recommendedSkills: { read: "wiki-query", edit: "wiki-propose-change", apply: "wiki-apply-change" },
      companyId,
      spaceSlug,
      page: path,
    },
  };
}

async function callInternalApi(ps, method, path, jsonBody) {
  return toolData(await callUpstreamTool(ps, "paperclipApiRequest", {
    method,
    path,
    ...(jsonBody === undefined ? {} : { jsonBody: JSON.stringify(jsonBody) }),
  }));
}

async function publicWikiCall(ps, payload, name, args, write = false) {
  const companyId = selectCompany(payload, args.companyId);
  const page = args.page ? assertPublicWikiPage(args.page) : null;
  const parameters = {
    companyId,
    wikiId: "default",
    ...(args.spaceSlug ? { spaceSlug: String(args.spaceSlug) } : {}),
    ...(page ? { path: page } : {}),
  };
  const query = new URLSearchParams({ companyId, wikiId: parameters.wikiId });
  if (parameters.spaceSlug) query.set("spaceSlug", parameters.spaceSlug);
  let data;
  if (name === "wiki_list_pages" || name === "wiki_search") {
    data = await callInternalApi(ps, "GET", `/plugins/paperclipai.plugin-llm-wiki/api/mcp-pages?${query}`);
  } else if (name === "wiki_read_page") {
    query.set("path", page);
    data = await callInternalApi(ps, "GET", `/plugins/paperclipai.plugin-llm-wiki/api/mcp-page?${query}`);
  } else if (name === "wiki_write_page") {
    data = await callInternalApi(ps, "POST", "/plugins/paperclipai.plugin-llm-wiki/api/mcp-page", {
      ...parameters,
      contents: String(args.content || ""),
      expectedHash: String(args.expectedHash || ""),
      summary: typeof args.summary === "string" ? args.summary : "Public MCP Wiki update",
    });
  } else {
    throw new Error(`Unsupported public Wiki operation: ${name}`);
  }
  return { companyId, page, spaceSlug: parameters.spaceSlug || "default", data, result: null, write };
}

async function handlePublicGatewayTool({ ps, payload, name, args }) {
  try {
    if (name === "paperclipListIssueRuns") {
      const issue = toolData(await callUpstreamTool(ps, "paperclipGetIssue", { issueId: args.issueId }));
      selectCompany(payload, issue.companyId);
      const runs = ctbRuns().filter((run) => run.paperclipIssueId === issue.id || run.paperclipIssueId === args.issueId).map((run) => ({ runId: run.runId, engine: "opencode", status: run.status || "unknown", startedAt: run.createdAt || null, finishedAt: run.finishedAt || null, durationMs: ctbRunMetrics(run).durationMs }));
      return rpcToolResult({ issueId: issue.id, runs });
    }
    if (name === "paperclipGetRunEvents" || name === "paperclipGetRunMetrics") {
      const run = ctbRuns().find((entry) => entry.runId === args.runId);
      if (!run) return rpcError(-32002, "Run not found", { code: "RUN_NOT_FOUND" });
      const issue = toolData(await callUpstreamTool(ps, "paperclipGetIssue", { issueId: run.paperclipIssueId }));
      selectCompany(payload, issue.companyId);
      if (name === "paperclipGetRunMetrics") return rpcToolResult({ runId: run.runId, ...ctbRunMetrics(run) });
      const all = (Array.isArray(run.events) ? run.events : []).filter((event) => !args.kind || event.kind === args.kind);
      const cursor = Number.isInteger(args.cursor) ? args.cursor : 0;
      const limit = Number.isInteger(args.limit) ? args.limit : 100;
      const events = all.slice(cursor, cursor + limit);
      return rpcToolResult({ runId: run.runId, events, nextCursor: cursor + events.length < all.length ? cursor + events.length : null });
    }
    if (["paperclipListDocuments", "paperclipGetDocument", "paperclipGetDocumentHistory", "paperclipGetDocumentRevision", "paperclipUpdateDocument"].includes(name)) {
      const issue = toolData(await callUpstreamTool(ps, "paperclipGetIssue", { issueId: args.issueId }));
      selectCompany(payload, issue.companyId);
    }
    if (name === "paperclipListDocuments") {
      return rpcToolResult(toolData(await callUpstreamTool(ps, "paperclipListDocuments", { issueId: args.issueId })));
    }
    if (name === "paperclipGetDocument") {
      return rpcToolResult(toolData(await callUpstreamTool(ps, "paperclipGetDocument", { issueId: args.issueId, key: args.key })));
    }
    if (name === "paperclipGetDocumentHistory") {
      const result = await callUpstreamTool(ps, "paperclipListDocumentRevisions", { issueId: args.issueId, key: args.key });
      return rpcToolResult(toolData(result));
    }
    if (name === "paperclipGetDocumentRevision") {
      const history = toolData(await callUpstreamTool(ps, "paperclipListDocumentRevisions", { issueId: args.issueId, key: args.key }));
      const revisions = Array.isArray(history) ? history : history.revisions || [];
      const revision = revisions.find((entry) => entry?.id === args.revisionId) || null;
      return revision ? rpcToolResult(revision) : rpcError(-32002, "Document revision not found");
    }
    if (name === "paperclipUpdateDocument") {
      const result = await callUpstreamTool(ps, "paperclipUpsertIssueDocument", {
        issueId: args.issueId,
        key: args.key,
        body: args.content,
        baseRevisionId: args.baseRevisionId,
        format: "markdown",
        ...(args.title === undefined ? {} : { title: args.title }),
        ...(args.changeSummary === undefined ? {} : { changeSummary: args.changeSummary }),
      });
      const data = toolData(result);
      auditWrite({ principal: payload.sub, companyId: data.companyId || null, operation: "document.update", resource: `${args.issueId}/${args.key}`, beforeRevision: args.baseRevisionId, afterRevision: data.latestRevisionId || null, proposalId: null, result: "success" });
      return rpcToolResult(data);
    }
    if (name === "paperclipWikiList") {
      const call = await publicWikiCall(ps, payload, "wiki_list_pages", args);
      const pages = Array.isArray(call.data.pages) ? call.data.pages : [];
      return rpcToolResult({ pages: pages.filter((page) => {
        try { assertPublicWikiPage(page.path); return true; } catch { return false; }
      }).map((page) => wikiResource(page, call.companyId, call.spaceSlug)) });
    }
    if (name === "paperclipWikiSearch") {
      const call = await publicWikiCall(ps, payload, "wiki_search", args);
      const needle = String(args.query || "").trim().toLowerCase();
      const pages = Array.isArray(call.data.pages) ? call.data.pages : [];
      return rpcToolResult({ results: pages.filter((entry) => {
        const text = `${entry.path || ""}\n${entry.title || ""}\n${entry.description || ""}\n${Array.isArray(entry.tags) ? entry.tags.join(" ") : ""}`.toLowerCase();
        return !needle || text.includes(needle);
      }).map((entry) => {
        const page = assertPublicWikiPage(entry.path);
        return { slug: page.replace(/^wiki\//, "").replace(/\.md$/i, ""), title: entry.title || page, description: entry.description || `Wiki page: ${entry.title || page}.`, score: needle && String(entry.title || "").toLowerCase().includes(needle) ? 1 : 0.8, hash: entry.hash || entry.contentHash || null, tags: entry.tags || [] };
      }) });
    }
    if (name === "paperclipWikiGetPage" || name === "paperclipWikiGetMetadata") {
      const call = await publicWikiCall(ps, payload, "wiki_read_page", args);
      const text = typeof call.data.contents === "string" ? call.data.contents : typeof call.data.text === "string" ? call.data.text : "";
      const meta = metadataFromMarkdown(call.page, text, call.data);
      const resource = wikiResource({ ...call.data, ...meta, path: call.page, hash: call.data.hash || hash(text) }, call.companyId, call.spaceSlug);
      return rpcToolResult(name === "paperclipWikiGetMetadata" ? resource : { ...resource._meta, page: call.page, title: meta.title, description: meta.description, content: text });
    }
    if (name === "paperclipWikiProposeChange") {
      const current = await publicWikiCall(ps, payload, "wiki_read_page", args);
      const text = typeof current.data.contents === "string" ? current.data.contents : typeof current.data.text === "string" ? current.data.text : "";
      const currentHash = current.data.hash || hash(text);
      if (args.expectedHash !== currentHash) {
        return rpcError(-32009, "WIKI_HASH_CONFLICT", { code: "WIKI_HASH_CONFLICT", page: current.page, suppliedHash: args.expectedHash, currentHash });
      }
      const proposalId = `wiki-${randToken(16)}`;
      const proposedHash = hash(String(args.content));
      WIKI_PROPOSALS.set(proposalId, { proposalId, principal: payload.sub, companyId: current.companyId, spaceSlug: current.spaceSlug, page: current.page, baseHash: currentHash, content: String(args.content), predictedHash: proposedHash, summary: args.summary || null, createdAt: nowMs(), applied: null });
      return rpcToolResult({ proposalId, page: current.page, baseHash: currentHash, resultingHash: proposedHash, diff: `--- ${current.page}\n+++ ${current.page}\n@@ full replacement @@\n-${text}\n+${String(args.content)}`, changed: text !== String(args.content), warnings: [] });
    }
    if (name === "paperclipWikiApplyChange") {
      const proposal = WIKI_PROPOSALS.get(String(args.proposalId));
      if (!proposal || proposal.principal !== payload.sub) return rpcError(-32002, "Wiki proposal not found");
      if (proposal.applied) return rpcToolResult(proposal.applied);
      if (args.expectedHash !== proposal.baseHash) return rpcError(-32009, "WIKI_HASH_CONFLICT", { code: "WIKI_HASH_CONFLICT", page: proposal.page, suppliedHash: args.expectedHash, currentHash: proposal.baseHash });
      const current = await publicWikiCall(ps, payload, "wiki_read_page", { companyId: proposal.companyId, spaceSlug: proposal.spaceSlug, page: proposal.page });
      const text = typeof current.data.contents === "string" ? current.data.contents : typeof current.data.text === "string" ? current.data.text : "";
      const currentHash = current.data.hash || hash(text);
      if (currentHash !== proposal.baseHash) return rpcError(-32009, "WIKI_HASH_CONFLICT", { code: "WIKI_HASH_CONFLICT", page: proposal.page, suppliedHash: proposal.baseHash, currentHash });
      const written = await publicWikiCall(ps, payload, "wiki_write_page", { companyId: proposal.companyId, spaceSlug: proposal.spaceSlug, page: proposal.page, expectedHash: proposal.baseHash, content: proposal.content, summary: proposal.summary }, true);
      const output = { previousHash: proposal.baseHash, newHash: written.data.hash || proposal.predictedHash, changed: proposal.content !== text, page: proposal.page };
      proposal.applied = output;
      auditWrite({ principal: payload.sub, companyId: proposal.companyId, operation: "wiki.apply", resource: proposal.page, beforeHash: proposal.baseHash, afterHash: output.newHash, proposalId: proposal.proposalId, result: "success" });
      return rpcToolResult(output);
    }
    return null;
  } catch (error) {
    const code = upstreamErrorCode(error);
    if (code === "WIKI_HASH_CONFLICT") return rpcError(-32009, code, { code });
    if (code === "DOCUMENT_REVISION_CONFLICT") return rpcError(-32010, code, { code, suppliedRevision: args.baseRevisionId, documentId: args.key });
    if (error?.code === "COMPANY_ACCESS_DENIED") return rpcError(-32003, "COMPANY_ACCESS_DENIED", { code: "COMPANY_ACCESS_DENIED" });
    if (String(error?.message || error).includes("WIKI_PATH_FORBIDDEN")) return rpcError(-32602, "WIKI_PATH_FORBIDDEN", { code: "WIKI_PATH_FORBIDDEN" });
    return rpcError(-32603, String(error?.message || error));
  }
}

async function listPublicResources(ps, payload) {
  const resources = [];
  const companyIds = Array.isArray(payload.company_ids) ? payload.company_ids : [];
  if (hasScope(payload, "paperclip:wiki:read")) {
    for (const companyId of companyIds) {
      try {
        const result = (await publicWikiCall(ps, payload, "wiki_list_pages", { companyId })).data;
        for (const page of result.pages || []) {
          try { resources.push(wikiResource(page, companyId, "default")); } catch {}
        }
      } catch (error) {
        log("wiki resource discovery unavailable", { companyId, error: String(error?.message || error) });
      }
    }
  }
  if (hasScope(payload, "paperclip:documents:read")) {
    for (const companyId of companyIds) {
      try {
        const issues = toolData(await callUpstreamTool(ps, "paperclipListIssues", { companyId }));
        // Resource discovery must stay bounded. The dedicated document tool lists
        // an issue exhaustively after the caller has selected its scope.
        for (const issue of (Array.isArray(issues) ? issues : issues.issues || []).slice(0, 5)) {
          const issueId = issue?.id;
          if (!issueId) continue;
          const documents = toolData(await callUpstreamTool(ps, "paperclipListDocuments", { issueId }));
          for (const document of Array.isArray(documents) ? documents : documents.documents || []) {
            const key = document?.key;
            if (!key) continue;
            resources.push({
              uri: `paperclip://companies/${encodeURIComponent(companyId)}/documents/${encodeURIComponent(issueId)}/${encodeURIComponent(key)}`,
              name: document.title || key,
              description: `Issue document ${key}${document.title ? `: ${document.title}` : ""}.`,
              mimeType: "text/markdown",
              _meta: {
                resourceType: "issue-document",
                readOnly: false,
                revision: document.latestRevisionId || null,
                updatedAt: document.updatedAt || null,
                capabilities: ["read", "history", "update"],
                recommendedSkills: { read: "wiki-query", edit: "wiki-propose-change", apply: "wiki-apply-change" },
                companyId,
                issueId,
                key,
              },
            });
          }
        }
      } catch (error) {
        log("document resource discovery unavailable", { companyId, error: String(error?.message || error) });
      }
    }
  }
  return resources;
}

async function readPublicResource(ps, payload, uri) {
  const documentMatch = /^paperclip:\/\/companies\/([^/]+)\/documents\/([^/]+)\/([^/]+)$/.exec(uri);
  if (documentMatch) {
    if (!hasScope(payload, "paperclip:documents:read")) return rpcError(-32003, "INSUFFICIENT_SCOPE", { code: "INSUFFICIENT_SCOPE", requiredScope: "paperclip:documents:read" });
    const companyId = selectCompany(payload, decodeURIComponent(documentMatch[1]));
    const issueId = decodeURIComponent(documentMatch[2]);
    const key = decodeURIComponent(documentMatch[3]);
    const data = toolData(await callUpstreamTool(ps, "paperclipGetDocument", { issueId, key }));
    return { result: { contents: [{ uri, mimeType: "text/markdown", text: data.body || data.content || "", _meta: { companyId, revision: data.latestRevisionId || null } }] } };
  }
  const wikiMatch = /^paperclip:\/\/companies\/([^/]+)\/wiki\/pages\/([^/]+)$/.exec(uri);
  if (wikiMatch) {
    if (!hasScope(payload, "paperclip:wiki:read")) return rpcError(-32003, "INSUFFICIENT_SCOPE", { code: "INSUFFICIENT_SCOPE", requiredScope: "paperclip:wiki:read" });
    const companyId = selectCompany(payload, decodeURIComponent(wikiMatch[1]));
    const page = assertPublicWikiPage(decodeURIComponent(wikiMatch[2]));
    const data = (await publicWikiCall(ps, payload, "wiki_read_page", { companyId, page })).data;
    return { result: { contents: [{ uri, mimeType: "text/markdown", text: data.contents || data.text || "", _meta: { companyId, hash: data.hash || null, page } }] } };
  }
  return null;
}

async function handleAggregate(req, res) {
  const { token, headerAuth } = extractToken(req);
  const payload = token ? verifyToken(token) : null;
  const valid = validFor(payload, DEFAULT_APP);
  if (!valid) {
    const raw = await authFailedRawBody(req);
    let method = "";
    try { method = JSON.parse(raw || "{}").method || ""; } catch {}
    return sendMcp401(res, "aggregate", method, headerAuth);
  }

  let body = "";
  try { body = await readBody(req); } catch { return sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }); }
  let msg = null;
  try { msg = JSON.parse(body); } catch { return sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }); }

  const clientSid = (req.headers["mcp-session-id"] || "").toString();
  let ps = portalSessions.get(clientSid);
  const isNew = !ps;
  if (!ps) {
    ps = { apps: {}, lastUsed: nowMs() };
    const newSid = randToken(16);
    portalSessions.set(newSid, ps);
    ps.sid = newSid;
  }
  ps.lastUsed = nowMs();

  const method = msg.method || "";
  const id = msg.id;

  if (method === "initialize" || method === "tools/list" || method === "tools/call") {
    log("mcp call", { method, clientId: payload.client_id || null, sid: clientSid || null });
  }

  if (method === "initialize") {
    const ver = msg.params?.protocolVersion || "2025-03-26";
    const rsp = {
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: ver,
        capabilities: {
          tools: { listChanged: false },
          resources: { listChanged: false },
          extensions: { "io.modelcontextprotocol/skills": {} },
        },
        serverInfo: { name: "kompas-mcp", version: "1.3.0-skill-hardening" },
      },
    };
    res.writeHead(200, { "Content-Type": "application/json", ...(isNew ? { "mcp-session-id": ps.sid } : {}) });
    return res.end(JSON.stringify(rsp));
  }

  if (method === "notifications/initialized" || method === "notifications/cancelled" || method.startsWith("notifications/")) {
    res.writeHead(202, { "Content-Type": "application/json" });
    return res.end();
  }

  if (method === "ping") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ jsonrpc: "2.0", id, result: {} }));
  }

  if (method === "tools/list") {
    const tools = await aggregatedTools(ps);
    res.writeHead(200, { "Content-Type": "application/json", ...(isNew ? { "mcp-session-id": ps.sid } : {}) });
    return res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { tools } }));
  }

  if (method === "tools/call") {
    const { app, name } = routeToolName(msg.params?.name || "");
    const requiredScope = requiredScopeForTool(name);
    if (!hasScope(payload, requiredScope)) {
      return sendJson(res, 403, { jsonrpc: "2.0", id, error: { code: -32003, message: "INSUFFICIENT_SCOPE", data: { code: "INSUFFICIENT_SCOPE", requiredScope } } });
    }
    const skillResponse = await skillOperationRouter.handle({ app, name, args: msg.params?.arguments, session: ps, payload });
    if (skillResponse) return sendJson(res, skillResponse.error ? 400 : 200, { jsonrpc: "2.0", id, ...skillResponse });
    if (app === DEFAULT_APP && PUBLIC_GATEWAY_TOOL_NAMES.has(name)) {
      if (PUBLIC_WRITE_TOOL_NAMES.has(name) && ps.operation) {
        const verdict = enforceWriteGuard({
          envelope: ps.operation.envelope,
          writesUsed: ps.operation.writesUsed,
          toolName: name,
          arguments: msg.params?.arguments || {},
        });
        if (!verdict.allowed) {
          return sendJson(res, 403, { jsonrpc: "2.0", id, error: { code: -32003, message: verdict.code, data: verdict } });
        }
        ps.operation.writesUsed += 1;
      }
      const response = await handlePublicGatewayTool({ ps, payload, name, args: msg.params?.arguments || {} });
      return sendJson(res, response.error ? 400 : 200, { jsonrpc: "2.0", id, ...response });
    }
    if (app === DEFAULT_APP && !CHATGPT_PUBLIC_TOOL_NAME_SET.has(name)) {
      return sendJson(res, 404, { jsonrpc: "2.0", id, error: { code: -32601, message: "Tool is not available in the public catalog" } });
    }
    // Server-side write guard: when a skill operation envelope is active for
    // this session, mutating calls must pass MODE/budget/scope enforcement.
    if (ps.operation && app === DEFAULT_APP && name !== "paperclipUseSkill") {
      const isWrite =
        PUBLIC_WRITE_TOOL_NAMES.has(name) ||
        (name === "paperclipApiRequest" &&
          String(msg.params?.arguments?.method || "GET").toUpperCase() !== "GET");
      if (isWrite) {
        const verdict = enforceWriteGuard({
          envelope: ps.operation.envelope,
          writesUsed: ps.operation.writesUsed,
          toolName: name,
          arguments: msg.params?.arguments || {},
        });
        if (!verdict.allowed) {
          log("write guard denied", { tool: name, operationId: verdict.operationId, detail: verdict.detail });
          return sendJson(res, 403, {
            jsonrpc: "2.0",
            id,
            error: { code: -32003, message: verdict.code, data: verdict },
          });
        }
        ps.operation.writesUsed += 1;
      }
    }
    try {
      const rec = await ensureUpSession(ps, app);
      const r = await upstreamCall(app, rec.upId, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: msg.params?.arguments || {} } });
      res.writeHead(r.status || 200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(r.json));
    } catch (e) {
      log("aggregate tools/call fail", { app, tool: name, error: String(e?.message || e) });
      return sendJson(res, 502, { jsonrpc: "2.0", id, error: { code: -32603, message: "Upstream unavailable" } });
    }
  }

  if (method === "skills/list") {
    if (!hasScope(payload, "mcp:read")) {
      return sendJson(res, 403, { jsonrpc: "2.0", id, error: { code: -32003, message: "INSUFFICIENT_SCOPE", data: { code: "INSUFFICIENT_SCOPE", requiredScope: "mcp:read" } } });
    }
    const cursor = String(msg.params?.cursor || "");
    const skills = cursor ? [] : OPERATOR_SKILLS.map(publicSkillMetadata);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { skills } }));
  }

  if (method === "skills/get") {
    const skill = OPERATOR_SKILLS.find((entry) => entry.uri === msg.params?.uri);
    if (!skill) {
      return sendJson(res, 400, { jsonrpc: "2.0", id, error: { code: -32002, message: "Skill not found" } });
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      jsonrpc: "2.0",
      id,
        result: { skill: publicSkillMetadata(skill) },
    }));
  }

  if (method === "resources/read") {
    const uri = String(msg.params?.uri || "");
    try {
      const publicResource = await readPublicResource(ps, payload, uri);
      if (publicResource) return sendJson(res, publicResource.error ? 400 : 200, { jsonrpc: "2.0", id, ...publicResource });
    } catch (error) {
      return sendJson(res, 400, { jsonrpc: "2.0", id, ...rpcError(-32602, String(error?.message || error)) });
    }
    const resource = OPERATOR_SKILLS.flatMap((skill) => skill.resources).find((entry) => entry.uri === uri);
    if (!resource) {
      return sendJson(res, 400, { jsonrpc: "2.0", id, error: { code: -32002, message: "Resource not found" } });
    }
    const match = /^skill:\/\/paperclip\/([^/]+)\/(.+)$/.exec(uri);
    if (!match) {
      return sendJson(res, 400, { jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid skill resource URI" } });
    }
    const relativePath = match[2].replaceAll("/", "\\");
    const content = readFileSync(join(SKILLS_ROOT, match[1], relativePath), "utf8");
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: { contents: [{ uri, mimeType: "text/markdown", text: content, digest: resource.digest }] },
    }));
  }

  if (method === "resources/list") {
    const resources = await listPublicResources(ps, payload);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { resources } }));
  }
  if (method === "resources/templates/list") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { resourceTemplates: [] } }));
  }
  if (method === "prompts/list") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { prompts: [] } }));
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  return res.end(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code: -32601, message: `Method not found: ${method}` } }));
}

setInterval(() => {
  const now = nowMs();
  for (const [sid, ps] of portalSessions) {
    if (now - ps.lastUsed > 60 * 60 * 1000) portalSessions.delete(sid);
  }
}, 10 * 60 * 1000).unref();

server.listen(PORT, "127.0.0.1", () => {
  log(`listening on http://127.0.0.1:${PORT}`);
  log(`issuer: ${ISSUER}`);
  log(`apps: ${Object.keys(TARGETS).join(", ")}`);
});
