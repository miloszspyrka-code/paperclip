# Paperclip MCP Server

Model Context Protocol server for Paperclip.

This package is a thin MCP wrapper over the existing Paperclip REST API. It does
not talk to the database directly and it does not reimplement business logic.

## Authentication

The server reads its configuration from environment variables:

- `PAPERCLIP_API_URL` - Paperclip base URL, for example `http://localhost:3100`
- `PAPERCLIP_API_KEY` - bearer token used for `/api` requests
- `PAPERCLIP_COMPANY_ID` - optional default company for company-scoped tools
- `PAPERCLIP_AGENT_ID` - optional default agent for checkout helpers
- `PAPERCLIP_RUN_ID` - optional run id forwarded on mutating requests

Board-only tools remain enforced by the Paperclip API. Configure
`PAPERCLIP_API_KEY` with a valid Board API key to use them; an agent key exposes
the same tool schema but receives `403` instead of gaining Board authority.

Secret values, bearer tokens, and credential-like response fields are redacted
from MCP output. The server never exposes the agent-only secret-value endpoint
or named-gateway token minting endpoints.

## Usage

```sh
npx -y @paperclipai/mcp-server
```

Or locally in this repo:

```sh
pnpm --filter @paperclipai/mcp-server build
node packages/mcp-server/dist/stdio.js
```

## Tool Surface

Read tools:

- `paperclipMe`
- `paperclipInboxLite`
- `paperclipListAgents`
- `paperclipGetAgent`
- `paperclipGetAgentApps`
- `paperclipListAgentAppBindings`
- `paperclipListIssues`
- `paperclipGetIssue`
- `paperclipGetHeartbeatContext`
- `paperclipListHeartbeatRunsForIssue`
- `paperclipGetHeartbeatRun`
- `paperclipRunRuntimeState`
- `paperclipListHeartbeatRunEvents`
- `paperclipListComments`
- `paperclipGetComment`
- `paperclipListIssueApprovals`
- `paperclipListDocuments`
- `paperclipGetDocument`
- `paperclipListDocumentRevisions`
- `paperclipListProjects`
- `paperclipGetProject`
- `paperclipGetIssueWorkspaceRuntime`
- `paperclipWaitForIssueWorkspaceService`
- `paperclipGetExecutionWorkspaceDelivery`
- `paperclipListIssueInteractions`
- `paperclipListGoals`
- `paperclipGetGoal`
- `paperclipListApprovals`
- `paperclipGetApproval`
- `paperclipGetApprovalIssues`
- `paperclipListApprovalComments`
- `paperclipListSecrets` (Board only)
- `paperclipListToolApplications` (Board only)
- `paperclipListToolConnections` (Board only)
- `paperclipGetToolConnection` (Board only)
- `paperclipListToolProfiles` (Board only)
- `paperclipGetToolProfile` (Board only)
- `paperclipListToolGateways` (Board only)

Write tools:

- `paperclipCreateIssue`
- `paperclipUpdateIssue`
- `paperclipCheckoutIssue`
- `paperclipReleaseIssue`
- `paperclipAddComment`
- `paperclipResolveIssueInteraction`
- `paperclipCancelHeartbeatRun`
- `paperclipSuggestTasks`
- `paperclipAskUserQuestions`
- `paperclipRequestConfirmation`
- `paperclipRequestCheckboxConfirmation`
- `paperclipUpsertIssueDocument`
- `paperclipRestoreIssueDocumentRevision`
- `paperclipControlIssueWorkspaceServices`
- `paperclipPrepareIssueDelivery` (Board only; fetches origin without changing branches)
- `paperclipCreateIssuePullRequest` (Board only; configured GitHub secret only)
- `paperclipMergeIssuePullRequest` (Board only; exact prepared SHA only)
- `paperclipCreateApproval`
- `paperclipLinkIssueApproval`
- `paperclipUnlinkIssueApproval`
- `paperclipApprovalDecision`
- `paperclipAddApprovalComment`
- `paperclipUpdateAgent`
- `paperclipRunReconcile`
- `paperclipCreateSecret` (Board only; output redacted)
- `paperclipUpdateSecret` (Board only)
- `paperclipRotateSecret` (Board only; output redacted)
- `paperclipDeleteSecret` (Board only)
- `paperclipCreateToolApplication` (Board only)
- `paperclipUpdateToolApplication` (Board only)
- `paperclipCreateToolConnection` (Board only)
- `paperclipUpdateToolConnection` (Board only)
- `paperclipTestToolConnection` (Board only)
- `paperclipRefreshToolConnectionCatalog` (Board only)
- `paperclipCreateToolProfile` (Board only)
- `paperclipUpdateToolProfile` (Board only)
- `paperclipBindToolProfile` (Board only)
- `paperclipSetAgentAppPermission` (Board only; permitted access)
- `paperclipSetAgentAppInstallPolicy` (Board only; every-run installation)
- `paperclipCreateToolGateway` (Board only)
- `paperclipUpdateToolGateway` (Board only)

Escape hatch:

- `paperclipApiRequest`

`paperclipApiRequest` is limited to paths under `/api` and JSON bodies. It is
meant for endpoints that do not yet have a dedicated MCP tool.

## Deployment

This package exposes an authenticated stdio MCP server. It forwards the caller's
`PAPERCLIP_API_KEY` unchanged to the Paperclip REST API, so the API remains the
single authorization and audit boundary. The public OAuth gateway maps each
OAuth subject to a unique configured `MCP_PUBLIC_PRINCIPALS` entry with an
in-memory `upstreamTokens.paperclip` credential. That credential must be the
corresponding Paperclip Board credential; static `TARGETS.paperclip.token`
credentials are not used. A missing or ambiguous principal mapping fails closed
with `UPSTREAM_PRINCIPAL_UNCONFIGURED`. The API still validates Board access,
company scope, mutation policy, and audit logging for every call.
