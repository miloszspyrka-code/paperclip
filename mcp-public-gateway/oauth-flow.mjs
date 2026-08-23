export const OAUTH_SCOPES = [
  "mcp:read",
  "mcp:write",
  "paperclip:documents:read",
  "paperclip:documents:write",
  "paperclip:wiki:read",
  "paperclip:wiki:write",
  "offline_access",
];

export function normalizeScope(scope) {
  const requested = String(scope || "mcp:read mcp:write").split(/\s+/).filter(Boolean);
  const accepted = requested.filter((entry) => OAUTH_SCOPES.includes(entry));
  return accepted.length > 0 ? accepted.join(" ") : "mcp:read mcp:write";
}

export function authorizationServerMetadata(issuer) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint: `${issuer}/oauth/revoke`,
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
    scopes_supported: OAUTH_SCOPES,
    request_parameter_supported: false,
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["HS256"],
  };
}

export function protectedResourceMetadata({ issuer, app, resourceUrl }) {
  return {
    resource: resourceUrl(app),
    authorization_servers: [issuer],
    scopes_supported: OAUTH_SCOPES,
    resource_documentation: `${issuer}/health`,
  };
}

export class AuthorizationCodeStore {
  constructor({ ttlMs, now = () => Date.now() }) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.codes = new Map();
  }

  issue(code, record) {
    this.codes.set(code, { ...record, createdAt: this.now(), used: false });
    setTimeout(() => this.codes.delete(code), this.ttlMs + 1000).unref();
  }

  get(code) {
    const record = this.codes.get(code);
    if (!record || record.createdAt + this.ttlMs <= this.now()) {
      this.codes.delete(code);
      return null;
    }
    return record;
  }

  consume(code) {
    const record = this.get(code);
    if (!record || record.used) return null;
    record.used = true;
    this.codes.delete(code);
    return record;
  }
}
