# Public MCP Gateway

`mcp-public-gateway.mjs` exposes the public MCP endpoint and OAuth authorization server without changing the existing `/mcp`, OAuth, or redirect URI contracts.

## Skill Modes

`paperclipUseSkill` resolves modes in this order:

1. Tool argument `mode: "EXECUTE"`.
2. Literal `MODE=EXECUTE` in `request`.
3. Explicit `DIAGNOSE` or `PLAN` tool argument.
4. Unambiguous Polish repair-and-change wording, for example `napraw integrację i wykonaj zmiany`.
5. Existing PLAN intent markers; all other requests remain `DIAGNOSE`.

Natural language only chooses an operation envelope. It never grants write authorization: `SKILL_REGISTRY`, `assertModeAllowed`, write budget, target scope, and `enforceWriteGuard` still apply. `paperclip-deleguj-coo` therefore rejects EXECUTE with `MODE_NOT_ALLOWED`.

Requests are classified before an execution envelope is created: routine work is `RTB`, incremental Paperclip improvements are `ITB`, and architectural execution-engine or run-persistence rebuilds are `CTB`. `CTB` returns `CHANGE_CLASS=CTB` and `HANDOFF_TO=OpenCode CTB` without activating writes.

## Run Observability

`paperclipListIssueRuns` unifies persisted `heartbeat_runs` with the existing OpenCode CTB registry. Every known run returns its identity, kind, adapter/engine, status, timestamps, duration, and observability support. `paperclipGetRunEvents` returns only persisted ordered runtime events. `paperclipGetRunMetrics` derives tool metrics only from structured event payloads; a run without that telemetry returns explicit support status and `null` metric fields instead of invented values.

Workspace validation failures are deterministic preflight blockers. They are not eligible for interaction-continuation recovery retries until state changes.

## OAuth Refresh Tokens

Refresh tokens are stored in `data/mcp-public-refresh-tokens.json` by default. Override the private storage location with `MCP_PUBLIC_REFRESH_TOKENS_FILE`.

- Writes use a temporary file followed by rename and owner-only file permissions.
- Records expire according to `MCP_PUBLIC_REFRESH_TTL_MS`; expired records are removed when the store opens or token is read.
- Revocation removes the record immediately.
- Refresh grant rotation removes the presented token and persists its replacement in one write.
- Token values are never written to gateway logs.
- `offline_access` is advertised and accepted, but is not required to receive a refresh token.

Back up this private file with the gateway's secret material when persistent connector sessions must survive host recovery. Treat its loss as an OAuth reauthorization event.

## Verification

```powershell
node --test scripts/paperclip-skill-fixtures.test.mjs
pnpm test:skill-fixtures
pnpm test:public-tool-catalog
pnpm test:mcp-public-gateway
node --check mcp-public-gateway.mjs
$env:PAPERCLIP_PUBLIC_RUN_SMOKE="1"; node scripts/smoke/paperclip-public-tool-catalog.mjs
$env:PAPERCLIP_PUBLIC_SKILL_SMOKE="1"; node scripts/smoke/paperclip-public-tool-catalog.mjs
```

`test:mcp-public-gateway` runs a local upstream MCP stub and verifies OAuth DCR, PKCE, refresh persistence across gateway process restart, rotation, revocation, expiry, metadata, initialize, tools/list, and JSON-RPC skill mode routing.

## Rollout

1. Run the verification commands above.
2. Check for queued or running heartbeat executions before restarting any production runtime.
3. Deploy the gateway files while preserving `MCP_PUBLIC_KEY_FILE`, `MCP_PUBLIC_REFRESH_TOKENS_FILE`, and the data directory.
4. Restart only the public gateway process after the active-run preflight is clear.
5. Verify `/.well-known/oauth-authorization-server`, `/mcp` initialize, `tools/list`, and one refresh-token grant.
