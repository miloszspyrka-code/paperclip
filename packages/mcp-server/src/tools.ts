import { z } from "zod";
import {
  addIssueCommentSchema,
  askUserQuestionsPayloadSchema,
  checkoutIssueSchema,
  createApprovalSchema,
  createIssueInputSchema,
  issueThreadInteractionContinuationPolicySchema,
  requestCheckboxConfirmationPayloadSchema,
  requestConfirmationPayloadSchema,
  respondIssueThreadInteractionSchema,
  suggestTasksPayloadSchema,
  updateIssueSchema,
  upsertIssueDocumentSchema,
  linkIssueApprovalSchema,
  updateSecretSchema,
  createToolApplicationSchema,
  createToolConnectionSchema,
  createToolProfileWithEntriesSchema,
  createToolProfileBindingForProfileSchema,
  createToolMcpGatewaySchema,
} from "@paperclipai/shared";
import { PaperclipApiClient, PaperclipApiError } from "./client.js";
import { formatErrorResponse, formatTextResponse } from "./format.js";

export interface ToolDefinition {
  name: string;
  description: string;
  schema: z.AnyZodObject;
  execute: (input: Record<string, unknown>) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  }>;
}

function makeTool<TSchema extends z.ZodRawShape>(
  name: string,
  description: string,
  schema: z.ZodObject<TSchema>,
  execute: (input: z.infer<typeof schema>) => Promise<unknown>,
): ToolDefinition {
  return {
    name,
    description,
    schema,
    execute: async (input) => {
      try {
        const parsed = schema.parse(input);
        return formatTextResponse(await execute(parsed));
      } catch (error) {
        return formatErrorResponse(error);
      }
    },
  };
}

function parseOptionalJson(raw: string | undefined | null): unknown {
  if (!raw || raw.trim().length === 0) return undefined;
  return JSON.parse(raw);
}

const companyIdOptional = z.string().uuid().optional().nullable();
const agentIdOptional = z.string().uuid().optional().nullable();
const issueIdSchema = z.string().min(1);
const projectIdSchema = z.string().min(1);
const goalIdSchema = z.string().uuid();
const approvalIdSchema = z.string().uuid();
const documentKeySchema = z.string().trim().min(1).max(64);
const executionWorkspaceIdSchema = z.string().uuid();

const listIssuesSchema = z.object({
  companyId: companyIdOptional,
  status: z.string().optional(),
  projectId: z.string().uuid().optional(),
  assigneeAgentId: z.string().uuid().optional(),
  participantAgentId: z.string().uuid().optional(),
  assigneeUserId: z.string().optional(),
  touchedByUserId: z.string().optional(),
  inboxArchivedByUserId: z.string().optional(),
  unreadForUserId: z.string().optional(),
  labelId: z.string().uuid().optional(),
  executionWorkspaceId: z.string().uuid().optional(),
  originKind: z.string().optional(),
  originId: z.string().optional(),
  includeRoutineExecutions: z.boolean().optional(),
  includeLiveDescendantSummary: z.boolean().optional(),
  q: z.string().optional(),
});

const listCommentsSchema = z.object({
  issueId: issueIdSchema,
  after: z.string().uuid().optional(),
  order: z.enum(["asc", "desc"]).optional(),
  limit: z.number().int().positive().max(500).optional(),
});

const upsertDocumentToolSchema = z.object({
  issueId: issueIdSchema,
  key: documentKeySchema,
  title: z.string().trim().max(200).nullable().optional(),
  format: z.enum(["markdown"]).default("markdown"),
  body: z.string().max(524288),
  changeSummary: z.string().trim().max(500).nullable().optional(),
  baseRevisionId: z.string().uuid().nullable().optional(),
});

const createIssueToolSchema = z.object({
  companyId: companyIdOptional,
}).merge(createIssueInputSchema);

const updateIssueToolSchema = z.object({
  issueId: issueIdSchema,
}).merge(updateIssueSchema);

const checkoutIssueToolSchema = z.object({
  issueId: issueIdSchema,
  agentId: agentIdOptional,
  expectedStatuses: checkoutIssueSchema.shape.expectedStatuses.optional(),
});

const addCommentToolSchema = z.object({
  issueId: issueIdSchema,
}).merge(addIssueCommentSchema);

const createSuggestTasksToolSchema = z.object({
  issueId: issueIdSchema,
  idempotencyKey: z.string().trim().max(255).nullable().optional(),
  sourceCommentId: z.string().uuid().nullable().optional(),
  sourceRunId: z.string().uuid().nullable().optional(),
  title: z.string().trim().max(240).nullable().optional(),
  summary: z.string().trim().max(1000).nullable().optional(),
  continuationPolicy: issueThreadInteractionContinuationPolicySchema.optional().default("wake_assignee"),
  payload: suggestTasksPayloadSchema,
});

const createAskUserQuestionsToolSchema = z.object({
  issueId: issueIdSchema,
  idempotencyKey: z.string().trim().max(255).nullable().optional(),
  sourceCommentId: z.string().uuid().nullable().optional(),
  sourceRunId: z.string().uuid().nullable().optional(),
  title: z.string().trim().max(240).nullable().optional(),
  summary: z.string().trim().max(1000).nullable().optional(),
  continuationPolicy: issueThreadInteractionContinuationPolicySchema.optional().default("wake_assignee"),
  payload: askUserQuestionsPayloadSchema,
});

const createRequestConfirmationToolSchema = z.object({
  issueId: issueIdSchema,
  idempotencyKey: z.string().trim().max(255).nullable().optional(),
  sourceCommentId: z.string().uuid().nullable().optional(),
  sourceRunId: z.string().uuid().nullable().optional(),
  title: z.string().trim().max(240).nullable().optional(),
  summary: z.string().trim().max(1000).nullable().optional(),
  continuationPolicy: issueThreadInteractionContinuationPolicySchema.optional().default("none"),
  payload: requestConfirmationPayloadSchema,
});

const createRequestCheckboxConfirmationToolSchema = z.object({
  issueId: issueIdSchema,
  idempotencyKey: z.string().trim().max(255).nullable().optional(),
  sourceCommentId: z.string().uuid().nullable().optional(),
  sourceRunId: z.string().uuid().nullable().optional(),
  title: z.string().trim().max(240).nullable().optional(),
  summary: z.string().trim().max(1000).nullable().optional(),
  continuationPolicy: issueThreadInteractionContinuationPolicySchema.optional().default("wake_assignee"),
  payload: requestCheckboxConfirmationPayloadSchema,
});

const approvalDecisionSchema = z.object({
  approvalId: approvalIdSchema,
  action: z.enum(["approve", "reject", "requestRevision", "resubmit"]),
  decisionNote: z.string().optional(),
  payloadJson: z.string().optional(),
});

const resolveIssueInteractionSchema = z.object({
  issueId: issueIdSchema,
  interactionId: z.string().uuid(),
  action: z.enum(["accept", "reject", "respond", "cancel"]),
  selectedClientKeys: z.array(z.string().trim().min(1).max(120)).min(1).max(50).optional(),
  selectedOptionIds: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
  reason: z.string().trim().max(4000).optional(),
  answers: respondIssueThreadInteractionSchema.shape.answers.optional(),
  summaryMarkdown: respondIssueThreadInteractionSchema.shape.summaryMarkdown,
});

const createApprovalToolSchema = z.object({
  companyId: companyIdOptional,
}).merge(createApprovalSchema);

const apiRequestSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().min(1),
  jsonBody: z.string().optional(),
});

const workspaceRuntimeControlTargetSchema = z.object({
  workspaceCommandId: z.string().min(1).optional().nullable(),
  runtimeServiceId: z.string().uuid().optional().nullable(),
  serviceIndex: z.number().int().nonnegative().optional().nullable(),
});

const issueWorkspaceRuntimeControlSchema = z.object({
  issueId: issueIdSchema,
  action: z.enum(["start", "stop", "restart"]),
}).merge(workspaceRuntimeControlTargetSchema);

const waitForIssueWorkspaceServiceSchema = z.object({
  issueId: issueIdSchema,
  runtimeServiceId: z.string().uuid().optional().nullable(),
  serviceName: z.string().min(1).optional().nullable(),
  timeoutSeconds: z.number().int().positive().max(300).optional(),
});

const createSecretToolSchema = z.object({
  companyId: companyIdOptional,
  name: z.string().min(1),
  key: z.string().min(1).max(120).optional(),
  provider: z.string().optional(),
  providerConfigId: z.string().uuid().nullable().optional(),
  managedMode: z.string().optional(),
  value: z.string().min(1).nullable().optional().describe("Secret value. Redacted from all MCP output."),
  description: z.string().nullable().optional(),
  externalRef: z.string().nullable().optional(),
  providerMetadata: z.record(z.unknown()).nullable().optional(),
  providerVersionRef: z.string().nullable().optional(),
});
const updateSecretToolSchema = z.object({ secretId: z.string().uuid() }).merge(updateSecretSchema);
const rotateSecretToolSchema = z.object({
  secretId: z.string().uuid(),
  value: z.string().min(1).nullable().optional().describe("Secret value. Redacted from all MCP output."),
  externalRef: z.string().nullable().optional(),
  providerVersionRef: z.string().nullable().optional(),
  providerConfigId: z.string().uuid().nullable().optional(),
});
const createToolApplicationToolSchema = z.object({ companyId: companyIdOptional }).merge(createToolApplicationSchema);
const updateToolApplicationToolSchema = z.object({
  applicationId: z.string().uuid(),
  applicationKey: z.string().optional(), name: z.string().optional(), description: z.string().nullable().optional(),
  type: z.string().optional(), status: z.string().optional(), pluginId: z.string().uuid().nullable().optional(),
  ownerAgentId: z.string().uuid().nullable().optional(), ownerUserId: z.string().nullable().optional(), metadata: z.record(z.unknown()).nullable().optional(),
});
const createToolConnectionToolSchema = z.object({ companyId: companyIdOptional }).merge(createToolConnectionSchema);
const updateToolConnectionToolSchema = z.object({
  connectionId: z.string().uuid(), name: z.string().optional(), transport: z.string().optional(), authKind: z.string().optional(),
  ownership: z.string().optional(), status: z.string().optional(), connectionKind: z.string().optional(), enabled: z.boolean().optional(),
  config: z.record(z.unknown()).optional(), transportConfig: z.record(z.unknown()).optional(),
  credentialRefs: z.array(z.record(z.unknown())).optional(), credentialSecretRefs: z.array(z.record(z.unknown())).optional(), applicationName: z.string().optional(),
});
const createToolProfileToolSchema = z.object({ companyId: companyIdOptional }).merge(createToolProfileWithEntriesSchema);
const updateToolProfileToolSchema = z.object({
  profileId: z.string().uuid(), profileKey: z.string().optional(), name: z.string().optional(), description: z.string().nullable().optional(),
  status: z.string().optional(), defaultAction: z.string().optional(), metadata: z.record(z.unknown()).nullable().optional(), entries: z.array(z.record(z.unknown())).optional(),
});
const bindToolProfileToolSchema = z.object({
  companyId: companyIdOptional,
  profileId: z.string().uuid(),
}).merge(createToolProfileBindingForProfileSchema);
const setAgentAppInstallPolicySchema = z.object({
  connectionId: z.string().uuid(),
  mode: z.enum(["none", "specific_agents", "all_agents"]),
  agentIds: z.array(z.string().uuid()).max(1000).default([]),
});
const createToolGatewayToolSchema = z.object({ companyId: companyIdOptional }).merge(createToolMcpGatewaySchema);
const updateToolGatewayToolSchema = z.object({
  gatewayId: z.string().uuid(), companyId: z.string().uuid(), name: z.string().optional(), slug: z.string().optional(),
  displaySlug: z.string().optional(), description: z.string().nullable().optional(), profileId: z.string().uuid().optional(),
  defaultProfileMode: z.string().optional(), contextScopeType: z.string().optional(), contextScopeId: z.string().nullable().optional(),
  agentId: z.string().uuid().nullable().optional(), projectId: z.string().uuid().nullable().optional(), issueId: z.string().uuid().nullable().optional(),
  approvalIssueId: z.string().uuid().nullable().optional(), authConfig: z.record(z.unknown()).optional(), headerPolicy: z.record(z.unknown()).optional(),
  metadataPolicy: z.record(z.unknown()).optional(), onDemandToolsConfig: z.record(z.unknown()).optional(), metadata: z.record(z.unknown()).nullable().optional(), status: z.string().optional(),
});

// These are internal read bridges for the public gateway. They expose the
// persisted Paperclip run records without reopening the generic API tool.
const heartbeatRunEventsSchema = z.object({
  runId: z.string().uuid(),
  afterSeq: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(200).optional(),
});

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readCurrentExecutionWorkspace(context: unknown): Record<string, unknown> | null {
  if (!context || typeof context !== "object") return null;
  const workspace = (context as { currentExecutionWorkspace?: unknown }).currentExecutionWorkspace;
  return workspace && typeof workspace === "object" ? workspace as Record<string, unknown> : null;
}

function readWorkspaceRuntimeServices(workspace: Record<string, unknown> | null): Array<Record<string, unknown>> {
  const raw = workspace?.runtimeServices;
  return Array.isArray(raw)
    ? raw.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    : [];
}

function selectRuntimeService(
  services: Array<Record<string, unknown>>,
  input: { runtimeServiceId?: string | null; serviceName?: string | null },
) {
  if (input.runtimeServiceId) {
    return services.find((service) => service.id === input.runtimeServiceId) ?? null;
  }
  if (input.serviceName) {
    return services.find((service) => service.serviceName === input.serviceName) ?? null;
  }
  return services.find((service) => service.status === "running" || service.status === "starting")
    ?? services[0]
    ?? null;
}

async function getIssueWorkspaceRuntime(client: PaperclipApiClient, issueId: string) {
  const context = await client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}/heartbeat-context`);
  const workspace = readCurrentExecutionWorkspace(context);
  return {
    context,
    workspace,
    runtimeServices: readWorkspaceRuntimeServices(workspace),
  };
}

async function getAuthenticatedActor(client: PaperclipApiClient) {
  try {
    const agent = await client.requestJson<Record<string, unknown>>("GET", "/agents/me");
    return { ...agent, actorType: "agent" };
  } catch (error) {
    if (!(error instanceof PaperclipApiError) || error.status !== 401) throw error;
    const board = await client.requestJson<Record<string, unknown>>("GET", "/cli-auth/me");
    return { ...board, actorType: "board" };
  }
}

export function createToolDefinitions(client: PaperclipApiClient): ToolDefinition[] {
  return [
    makeTool(
      "paperclipMe",
      "Get the authenticated Paperclip principal type and its agent or Board access details",
      z.object({}),
      async () => getAuthenticatedActor(client),
    ),
    makeTool(
      "paperclipInboxLite",
      "Get the current authenticated agent inbox-lite assignment list",
      z.object({}),
      async () => client.requestJson("GET", "/agents/me/inbox-lite"),
    ),
    makeTool(
      "paperclipListAgents",
      "List agents in a company",
      z.object({ companyId: companyIdOptional }),
      async ({ companyId }) => client.requestJson("GET", `/companies/${client.resolveCompanyId(companyId)}/agents`),
    ),
    makeTool(
      "paperclipGetAgent",
      "Get a single agent by id",
      z.object({ agentId: z.string().min(1), companyId: companyIdOptional }),
      async ({ agentId, companyId }) => {
        const qs = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
        return client.requestJson("GET", `/agents/${encodeURIComponent(agentId)}${qs}`);
      },
    ),
    makeTool(
      "paperclipGetAgentApps",
      "Get an agent's configured Paperclip App/MCP permissions and every-run installations",
      z.object({ agentId: z.string().uuid(), companyId: companyIdOptional }),
      async ({ agentId, companyId }) => {
        const params = new URLSearchParams();
        if (companyId) params.set("companyId", companyId);
        const query = params.toString();
        return client.requestJson("GET", `/agents/${encodeURIComponent(agentId)}/tool-apps${query ? `?${query}` : ""}`);
      },
    ),
    makeTool(
      "paperclipListAgentAppBindings",
      "List safe, read-only App/MCP permission and every-run installation bindings",
      z.object({ companyId: companyIdOptional, agentId: agentIdOptional, appId: z.string().uuid().optional().nullable() }),
      async ({ companyId, agentId, appId }) => {
        const params = new URLSearchParams();
        if (companyId) params.set("companyId", companyId);
        if (agentId) params.set("agentId", agentId);
        if (appId) params.set("appId", appId);
        const query = params.toString();
        return client.requestJson("GET", `/tool-app-bindings${query ? `?${query}` : ""}`);
      },
    ),
    makeTool(
      "paperclipUpdateAgent",
      "Update agent status, identity, role, or runtime configuration. Agent principals require agents:configure or agents:suggest-changes; the API enforces permission.",
      z.object({
        agentId: z.string().min(1),
        companyId: companyIdOptional,
        status: z.enum(["active", "paused", "idle", "suspended", "error"]).optional(),
        name: z.string().trim().min(1).max(200).optional(),
        title: z.string().trim().max(200).nullable().optional(),
        role: z.string().trim().max(100).optional(),
        runtimeConfig: z.record(z.unknown())
          .describe("Complete runtime configuration, for example maxConcurrentRuns")
          .optional(),
        patch: z.record(z.unknown()).optional(),
      }),
      async ({ agentId, companyId, status, name, title, role, runtimeConfig, patch }) => {
        const body: Record<string, unknown> = { ...(patch ?? {}) };
        if (status !== undefined) body.status = status;
        if (name !== undefined) body.name = name;
        if (title !== undefined) body.title = title;
        if (role !== undefined) body.role = role;
        if (runtimeConfig !== undefined) body.runtimeConfig = runtimeConfig;
        const qs = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
        return client.requestJson("PATCH", `/agents/${encodeURIComponent(agentId)}${qs}`, { body });
      },
    ),
    makeTool(
      "paperclipListIssues",
      "List issues for a company with optional filters",
      listIssuesSchema,
      async (input) => {
        const companyId = client.resolveCompanyId(input.companyId);
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(input)) {
          if (key === "companyId" || value === undefined || value === null) continue;
          params.set(key, String(value));
        }
        const qs = params.toString();
        return client.requestJson("GET", `/companies/${companyId}/issues${qs ? `?${qs}` : ""}`);
      },
    ),
    makeTool(
      "paperclipGetIssue",
      "Get a single issue by UUID or identifier",
      z.object({ issueId: issueIdSchema }),
      async ({ issueId }) => client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}`),
    ),
    makeTool(
      "paperclipGetHeartbeatContext",
      "Get compact heartbeat context for an issue",
      z.object({ issueId: issueIdSchema, wakeCommentId: z.string().uuid().optional() }),
      async ({ issueId, wakeCommentId }) => {
        const qs = wakeCommentId ? `?wakeCommentId=${encodeURIComponent(wakeCommentId)}` : "";
        return client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}/heartbeat-context${qs}`);
      },
    ),
    makeTool(
      "paperclipListHeartbeatRunsForIssue",
      "List persisted heartbeat runs correlated to an issue",
      z.object({ issueId: issueIdSchema }),
      async ({ issueId }) => client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}/runs`),
    ),
    makeTool(
      "paperclipCancelHeartbeatRun",
      "Cancel an active heartbeat run. Board-only: requires Board credentials and is audited by the API.",
      z.object({ runId: z.string().uuid() }),
      async ({ runId }) =>
        client.requestJson("POST", `/heartbeat-runs/${encodeURIComponent(runId)}/cancel`, { body: {} }),
    ),
    makeTool(
      "paperclipGetHeartbeatRun",
      "Get one persisted heartbeat run",
      z.object({ runId: z.string().uuid() }),
      async ({ runId }) => client.requestJson("GET", `/heartbeat-runs/${encodeURIComponent(runId)}`),
    ),
    makeTool(
      "paperclipRunRuntimeState",
      "Get reconciler-safe runtime state for a heartbeat run",
      z.object({ runId: z.string().uuid() }),
      async ({ runId }) => client.requestJson("GET", `/heartbeat-runs/${encodeURIComponent(runId)}/runtime-state`),
    ),
    makeTool(
      "paperclipRunReconcile",
      "Safely reconcile a definitively lost OpenCode heartbeat run; otherwise returns NO_ACTION",
      z.object({ runId: z.string().uuid() }),
      async ({ runId }) => client.requestJson("POST", `/heartbeat-runs/${encodeURIComponent(runId)}/reconcile`, { body: {} }),
    ),
    makeTool(
      "paperclipListHeartbeatRunEvents",
      "List persisted ordered heartbeat run events",
      heartbeatRunEventsSchema,
      async ({ runId, afterSeq, limit }) => {
        const params = new URLSearchParams();
        if (afterSeq) params.set("afterSeq", String(afterSeq));
        if (limit) params.set("limit", String(limit));
        const query = params.toString();
        return client.requestJson("GET", `/heartbeat-runs/${encodeURIComponent(runId)}/events${query ? `?${query}` : ""}`);
      },
    ),
    makeTool(
      "paperclipListComments",
      "List issue comments with incremental options",
      listCommentsSchema,
      async ({ issueId, after, order, limit }) => {
        const params = new URLSearchParams();
        if (after) params.set("after", after);
        if (order) params.set("order", order);
        if (limit) params.set("limit", String(limit));
        const qs = params.toString();
        return client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}/comments${qs ? `?${qs}` : ""}`);
      },
    ),
    makeTool(
      "paperclipListIssueInteractions",
      "List issue interactions, including status, resolver policy, payload, and result",
      z.object({ issueId: issueIdSchema }),
      async ({ issueId }) =>
        client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}/interactions`),
    ),
    makeTool(
      "paperclipGetComment",
      "Get a specific issue comment by id",
      z.object({ issueId: issueIdSchema, commentId: z.string().uuid() }),
      async ({ issueId, commentId }) =>
        client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}/comments/${encodeURIComponent(commentId)}`),
    ),
    makeTool(
      "paperclipListIssueApprovals",
      "List approvals linked to an issue",
      z.object({ issueId: issueIdSchema }),
      async ({ issueId }) => client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}/approvals`),
    ),
    makeTool(
      "paperclipListDocuments",
      "List issue documents",
      z.object({ issueId: issueIdSchema }),
      async ({ issueId }) => client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}/documents`),
    ),
    makeTool(
      "paperclipGetDocument",
      "Get one issue document by key",
      z.object({ issueId: issueIdSchema, key: documentKeySchema }),
      async ({ issueId, key }) =>
        client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(key)}`),
    ),
    makeTool(
      "paperclipListDocumentRevisions",
      "List revisions for an issue document",
      z.object({ issueId: issueIdSchema, key: documentKeySchema }),
      async ({ issueId, key }) =>
        client.requestJson(
          "GET",
          `/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(key)}/revisions`,
        ),
    ),
    makeTool(
      "paperclipListProjects",
      "List projects in a company",
      z.object({ companyId: companyIdOptional }),
      async ({ companyId }) => client.requestJson("GET", `/companies/${client.resolveCompanyId(companyId)}/projects`),
    ),
    makeTool(
      "paperclipGetProject",
      "Get a project by id or company-scoped short reference",
      z.object({ projectId: projectIdSchema, companyId: companyIdOptional }),
      async ({ projectId, companyId }) => {
        const qs = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
        return client.requestJson("GET", `/projects/${encodeURIComponent(projectId)}${qs}`);
      },
    ),
    makeTool(
      "paperclipGetIssueWorkspaceRuntime",
      "Get the current execution workspace and runtime services for an issue, including service URLs",
      z.object({ issueId: issueIdSchema }),
      async ({ issueId }) => getIssueWorkspaceRuntime(client, issueId),
    ),
    makeTool(
      "paperclipControlIssueWorkspaceServices",
      "Start, stop, or restart the current issue execution workspace runtime services",
      issueWorkspaceRuntimeControlSchema,
      async ({ issueId, action, ...target }) => {
        const runtime = await getIssueWorkspaceRuntime(client, issueId);
        const workspaceId = typeof runtime.workspace?.id === "string" ? runtime.workspace.id : null;
        if (!workspaceId) {
          throw new Error("Issue has no current execution workspace");
        }
        return client.requestJson(
          "POST",
          `/execution-workspaces/${encodeURIComponent(workspaceId)}/runtime-services/${action}`,
          { body: target },
        );
      },
    ),
    makeTool(
      "paperclipWaitForIssueWorkspaceService",
      "Wait until an issue execution workspace runtime service is running and has a URL when one is exposed",
      waitForIssueWorkspaceServiceSchema,
      async ({ issueId, runtimeServiceId, serviceName, timeoutSeconds }) => {
        const deadline = Date.now() + (timeoutSeconds ?? 60) * 1000;
        let latest: Awaited<ReturnType<typeof getIssueWorkspaceRuntime>> | null = null;
        while (Date.now() <= deadline) {
          latest = await getIssueWorkspaceRuntime(client, issueId);
          const service = selectRuntimeService(latest.runtimeServices, { runtimeServiceId, serviceName });
          if (service?.status === "running" && service.healthStatus !== "unhealthy") {
            return {
              workspace: latest.workspace,
              service,
            };
          }
          await sleep(1000);
        }

        return {
          timedOut: true,
          latestWorkspace: latest?.workspace ?? null,
          latestRuntimeServices: latest?.runtimeServices ?? [],
        };
      },
    ),
    makeTool(
      "paperclipGetExecutionWorkspaceDelivery",
      "Get workspace delivery state, git refs, and close-readiness. API authorization determines visibility.",
      z.object({ executionWorkspaceId: executionWorkspaceIdSchema }),
      async ({ executionWorkspaceId }) =>
        client.requestJson("GET", `/execution-workspaces/${encodeURIComponent(executionWorkspaceId)}/delivery`),
    ),
    makeTool(
      "paperclipPrepareIssueDelivery",
      "Board-only delivery preflight. Fetches origin without changing branches, then reports clean/stale/conflict/credential blockers. No credential value is returned.",
      z.object({ executionWorkspaceId: executionWorkspaceIdSchema }),
      async ({ executionWorkspaceId }) =>
        client.requestJson("POST", `/execution-workspaces/${encodeURIComponent(executionWorkspaceId)}/prepare-delivery`),
    ),
    makeTool(
      "paperclipCreateIssuePullRequest",
      "Board-only: create a GitHub pull request after a clean, current delivery preflight. Uses the configured GitHub secret; no PAT input or output.",
      z.object({
        executionWorkspaceId: executionWorkspaceIdSchema,
        title: z.string().trim().min(1).max(256),
        body: z.string().max(65_536).nullable().optional(),
      }),
      async ({ executionWorkspaceId, title, body }) =>
        client.requestJson("POST", `/execution-workspaces/${encodeURIComponent(executionWorkspaceId)}/pull-request`, {
          body: { title, body },
        }),
    ),
    makeTool(
      "paperclipMergeIssuePullRequest",
      "Board-only: merge an exact prepared GitHub pull request SHA. Rejects dirty, stale, conflicting, or credential-less workspaces.",
      z.object({
        executionWorkspaceId: executionWorkspaceIdSchema,
        pullRequestNumber: z.number().int().positive(),
        method: z.enum(["merge", "squash", "rebase"]).optional(),
      }),
      async ({ executionWorkspaceId, pullRequestNumber, method }) =>
        client.requestJson("POST", `/execution-workspaces/${encodeURIComponent(executionWorkspaceId)}/pull-request/merge`, {
          body: { pullRequestNumber, method },
        }),
    ),
    makeTool(
      "paperclipListGoals",
      "List goals in a company",
      z.object({ companyId: companyIdOptional }),
      async ({ companyId }) => client.requestJson("GET", `/companies/${client.resolveCompanyId(companyId)}/goals`),
    ),
    makeTool(
      "paperclipGetGoal",
      "Get a goal by id",
      z.object({ goalId: goalIdSchema }),
      async ({ goalId }) => client.requestJson("GET", `/goals/${encodeURIComponent(goalId)}`),
    ),
    makeTool(
      "paperclipListApprovals",
      "List approvals in a company",
      z.object({ companyId: companyIdOptional, status: z.string().optional() }),
      async ({ companyId, status }) => {
        const qs = status ? `?status=${encodeURIComponent(status)}` : "";
        return client.requestJson("GET", `/companies/${client.resolveCompanyId(companyId)}/approvals${qs}`);
      },
    ),
    makeTool(
      "paperclipCreateApproval",
      "Create a board approval request, optionally linked to one or more issues",
      createApprovalToolSchema,
      async ({ companyId, ...body }) =>
        client.requestJson("POST", `/companies/${client.resolveCompanyId(companyId)}/approvals`, {
          body,
        }),
    ),
    makeTool(
      "paperclipGetApproval",
      "Get an approval by id",
      z.object({ approvalId: approvalIdSchema }),
      async ({ approvalId }) => client.requestJson("GET", `/approvals/${encodeURIComponent(approvalId)}`),
    ),
    makeTool(
      "paperclipGetApprovalIssues",
      "List issues linked to an approval",
      z.object({ approvalId: approvalIdSchema }),
      async ({ approvalId }) => client.requestJson("GET", `/approvals/${encodeURIComponent(approvalId)}/issues`),
    ),
    makeTool(
      "paperclipListApprovalComments",
      "List comments for an approval",
      z.object({ approvalId: approvalIdSchema }),
      async ({ approvalId }) => client.requestJson("GET", `/approvals/${encodeURIComponent(approvalId)}/comments`),
    ),
    makeTool(
      "paperclipCreateIssue",
      "Create a new issue",
      createIssueToolSchema,
      async ({ companyId, ...body }) =>
        client.requestJson("POST", `/companies/${client.resolveCompanyId(companyId)}/issues`, { body }),
    ),
    makeTool(
      "paperclipUpdateIssue",
      "Patch an issue, optionally including a comment; include resume=true when intentionally requesting follow-up on resumable closed work",
      updateIssueToolSchema,
      async ({ issueId, ...body }) =>
        client.requestJson("PATCH", `/issues/${encodeURIComponent(issueId)}`, { body }),
    ),
    makeTool(
      "paperclipCheckoutIssue",
      "Checkout an issue for an agent",
      checkoutIssueToolSchema,
      async ({ issueId, agentId, expectedStatuses }) =>
        client.requestJson("POST", `/issues/${encodeURIComponent(issueId)}/checkout`, {
          body: {
            agentId: client.resolveAgentId(agentId),
            expectedStatuses: expectedStatuses ?? ["todo", "backlog", "blocked"],
          },
        }),
    ),
    makeTool(
      "paperclipReleaseIssue",
      "Release an issue checkout",
      z.object({ issueId: issueIdSchema }),
      async ({ issueId }) => client.requestJson("POST", `/issues/${encodeURIComponent(issueId)}/release`, { body: {} }),
    ),
    makeTool(
      "paperclipAddComment",
      "Add a comment to an issue; include resume=true when intentionally requesting follow-up on resumable closed work",
      addCommentToolSchema,
      async ({ issueId, ...body }) =>
        client.requestJson("POST", `/issues/${encodeURIComponent(issueId)}/comments`, { body }),
    ),
    makeTool(
      "paperclipSuggestTasks",
      "Create a suggest_tasks interaction on an issue",
      createSuggestTasksToolSchema,
      async ({ issueId, ...body }) =>
        client.requestJson("POST", `/issues/${encodeURIComponent(issueId)}/interactions`, {
          body: {
            kind: "suggest_tasks",
            ...body,
          },
        }),
    ),
    makeTool(
      "paperclipAskUserQuestions",
      "Create an ask_user_questions interaction on an issue",
      createAskUserQuestionsToolSchema,
      async ({ issueId, ...body }) =>
        client.requestJson("POST", `/issues/${encodeURIComponent(issueId)}/interactions`, {
          body: {
            kind: "ask_user_questions",
            ...body,
          },
        }),
    ),
    makeTool(
      "paperclipRequestConfirmation",
      "Create a request_confirmation interaction on an issue",
      createRequestConfirmationToolSchema,
      async ({ issueId, ...body }) =>
        client.requestJson("POST", `/issues/${encodeURIComponent(issueId)}/interactions`, {
          body: {
            kind: "request_confirmation",
            ...body,
          },
        }),
    ),
    makeTool(
      "paperclipRequestCheckboxConfirmation",
      "Create a request_checkbox_confirmation interaction on an issue",
      createRequestCheckboxConfirmationToolSchema,
      async ({ issueId, ...body }) =>
        client.requestJson("POST", `/issues/${encodeURIComponent(issueId)}/interactions`, {
          body: {
            kind: "request_checkbox_confirmation",
            ...body,
          },
        }),
    ),
    makeTool(
      "paperclipResolveIssueInteraction",
      "Accept, reject, respond to, or cancel an issue interaction. Human-only and cancel actions require Board credentials; the API enforces resolver policy.",
      resolveIssueInteractionSchema,
      async ({
        issueId,
        interactionId,
        action,
        selectedClientKeys,
        selectedOptionIds,
        reason,
        answers,
        summaryMarkdown,
      }) => {
        const body = action === "accept"
          ? {
              ...(selectedClientKeys !== undefined ? { selectedClientKeys } : {}),
              ...(selectedOptionIds !== undefined ? { selectedOptionIds } : {}),
            }
          : action === "respond"
            ? {
                answers: answers ?? [],
                ...(summaryMarkdown !== undefined ? { summaryMarkdown } : {}),
              }
            : { ...(reason !== undefined ? { reason } : {}) };
        return client.requestJson(
          "POST",
          `/issues/${encodeURIComponent(issueId)}/interactions/${encodeURIComponent(interactionId)}/${action}`,
          { body },
        );
      },
    ),
    makeTool(
      "paperclipUpsertIssueDocument",
      "Create or update an issue document",
      upsertDocumentToolSchema,
      async ({ issueId, key, ...body }) =>
        client.requestJson(
          "PUT",
          `/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(key)}`,
          { body },
        ),
    ),
    makeTool(
      "paperclipRestoreIssueDocumentRevision",
      "Restore a prior revision of an issue document",
      z.object({
        issueId: issueIdSchema,
        key: documentKeySchema,
        revisionId: z.string().uuid(),
      }),
      async ({ issueId, key, revisionId }) =>
        client.requestJson(
          "POST",
          `/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(key)}/revisions/${encodeURIComponent(revisionId)}/restore`,
          { body: {} },
        ),
    ),
    makeTool(
      "paperclipLinkIssueApproval",
      "Link an approval to an issue",
      z.object({ issueId: issueIdSchema }).merge(linkIssueApprovalSchema),
      async ({ issueId, approvalId }) =>
        client.requestJson("POST", `/issues/${encodeURIComponent(issueId)}/approvals`, {
          body: { approvalId },
        }),
    ),
    makeTool(
      "paperclipUnlinkIssueApproval",
      "Unlink an approval from an issue",
      z.object({ issueId: issueIdSchema, approvalId: approvalIdSchema }),
      async ({ issueId, approvalId }) =>
        client.requestJson(
          "DELETE",
          `/issues/${encodeURIComponent(issueId)}/approvals/${encodeURIComponent(approvalId)}`,
        ),
    ),
    makeTool(
      "paperclipApprovalDecision",
      "Approve, reject, request revision, or resubmit a formal approval. Approve, reject, and requestRevision require Board credentials; resubmit is available to the requester.",
      approvalDecisionSchema,
      async ({ approvalId, action, decisionNote, payloadJson }) => {
        const path =
          action === "approve"
            ? `/approvals/${encodeURIComponent(approvalId)}/approve`
            : action === "reject"
              ? `/approvals/${encodeURIComponent(approvalId)}/reject`
              : action === "requestRevision"
                ? `/approvals/${encodeURIComponent(approvalId)}/request-revision`
                : `/approvals/${encodeURIComponent(approvalId)}/resubmit`;

        const body =
          action === "resubmit"
            ? { payload: parseOptionalJson(payloadJson) ?? {} }
            : { decisionNote };

        return client.requestJson("POST", path, { body });
      },
    ),
    makeTool(
      "paperclipAddApprovalComment",
      "Add a comment to an approval",
      z.object({ approvalId: approvalIdSchema, body: z.string().min(1) }),
      async ({ approvalId, body }) =>
        client.requestJson("POST", `/approvals/${encodeURIComponent(approvalId)}/comments`, {
          body: { body },
        }),
    ),
    makeTool(
      "paperclipListSecrets",
      "List company secret metadata. Values and provider credentials are never returned.",
      z.object({ companyId: companyIdOptional }),
      async ({ companyId }) => client.requestJson("GET", `/companies/${client.resolveCompanyId(companyId)}/secrets`),
    ),
    makeTool(
      "paperclipCreateSecret",
      "Create a company secret using a Board credential. The API audits the mutation; secret values are redacted from MCP output.",
      createSecretToolSchema,
      async ({ companyId, ...body }) => client.requestJson("POST", `/companies/${client.resolveCompanyId(companyId)}/secrets`, { body }),
    ),
    makeTool(
      "paperclipUpdateSecret",
      "Update company secret metadata without exposing its value.",
      updateSecretToolSchema,
      async ({ secretId, ...body }) => client.requestJson("PATCH", `/secrets/${encodeURIComponent(secretId)}`, { body }),
    ),
    makeTool(
      "paperclipRotateSecret",
      "Rotate a company secret using a Board credential. Secret values are redacted from MCP output.",
      rotateSecretToolSchema,
      async ({ secretId, ...body }) => client.requestJson("POST", `/secrets/${encodeURIComponent(secretId)}/rotate`, { body }),
    ),
    makeTool(
      "paperclipDeleteSecret",
      "Delete a company secret using a Board credential. The API records an audit event.",
      z.object({ secretId: z.string().uuid() }),
      async ({ secretId }) => client.requestJson("DELETE", `/secrets/${encodeURIComponent(secretId)}`),
    ),
    makeTool(
      "paperclipListToolApplications",
      "List Board-visible Paperclip tool applications for a company.",
      z.object({ companyId: companyIdOptional }),
      async ({ companyId }) => client.requestJson("GET", `/companies/${client.resolveCompanyId(companyId)}/tools/applications`),
    ),
    makeTool(
      "paperclipCreateToolApplication",
      "Create a Paperclip tool application. Board membership and mutation permissions are enforced by the API.",
      createToolApplicationToolSchema,
      async ({ companyId, ...body }) => client.requestJson("POST", `/companies/${client.resolveCompanyId(companyId)}/tools/applications`, { body }),
    ),
    makeTool(
      "paperclipUpdateToolApplication",
      "Update a Paperclip tool application. Board membership and mutation permissions are enforced by the API.",
      updateToolApplicationToolSchema,
      async ({ applicationId, ...body }) => client.requestJson("PATCH", `/tool-applications/${encodeURIComponent(applicationId)}`, { body }),
    ),
    makeTool(
      "paperclipListToolConnections",
      "List Board-visible Paperclip tool connections for a company.",
      z.object({ companyId: companyIdOptional }),
      async ({ companyId }) => client.requestJson("GET", `/companies/${client.resolveCompanyId(companyId)}/tools/connections`),
    ),
    makeTool(
      "paperclipGetToolConnection",
      "Get one Paperclip tool connection, including safe credential references but never credential values.",
      z.object({ connectionId: z.string().uuid() }),
      async ({ connectionId }) => client.requestJson("GET", `/tool-connections/${encodeURIComponent(connectionId)}`),
    ),
    makeTool(
      "paperclipCreateToolConnection",
      "Create a Paperclip tool connection. Use credentialSecretRefs, never plaintext credentials in config.",
      createToolConnectionToolSchema,
      async ({ companyId, ...body }) => client.requestJson("POST", `/companies/${client.resolveCompanyId(companyId)}/tools/connections`, { body }),
    ),
    makeTool(
      "paperclipUpdateToolConnection",
      "Update a Paperclip tool connection. Sensitive config keys are rejected by the API.",
      updateToolConnectionToolSchema,
      async ({ connectionId, ...body }) => client.requestJson("PATCH", `/tool-connections/${encodeURIComponent(connectionId)}`, { body }),
    ),
    makeTool(
      "paperclipTestToolConnection",
      "Run an audited tool-connection health probe. The API returns only a sanitized result.",
      z.object({ connectionId: z.string().uuid() }),
      async ({ connectionId }) => client.requestJson("POST", `/tool-connections/${encodeURIComponent(connectionId)}/health-check`, { body: {} }),
    ),
    makeTool(
      "paperclipRefreshToolConnectionCatalog",
      "Refresh an audited tool-connection catalog. The API returns only sanitized catalog metadata.",
      z.object({ connectionId: z.string().uuid() }),
      async ({ connectionId }) => client.requestJson("POST", `/tool-connections/${encodeURIComponent(connectionId)}/catalog/refresh`, { body: {} }),
    ),
    makeTool(
      "paperclipListToolProfiles",
      "List Board-visible tool profiles for a company.",
      z.object({ companyId: companyIdOptional }),
      async ({ companyId }) => client.requestJson("GET", `/companies/${client.resolveCompanyId(companyId)}/tools/profiles`),
    ),
    makeTool(
      "paperclipGetToolProfile",
      "Get one Board-visible tool profile with its effective entries and bindings.",
      z.object({ profileId: z.string().uuid() }),
      async ({ profileId }) => client.requestJson("GET", `/tool-profiles/${encodeURIComponent(profileId)}`),
    ),
    makeTool(
      "paperclipCreateToolProfile",
      "Create a Board-managed tool profile with explicit entries.",
      createToolProfileToolSchema,
      async ({ companyId, ...body }) => client.requestJson("POST", `/companies/${client.resolveCompanyId(companyId)}/tools/profiles`, { body }),
    ),
    makeTool(
      "paperclipUpdateToolProfile",
      "Update a Board-managed tool profile and its entries.",
      updateToolProfileToolSchema,
      async ({ profileId, ...body }) => client.requestJson("PATCH", `/tool-profiles/${encodeURIComponent(profileId)}`, { body }),
    ),
    makeTool(
      "paperclipBindToolProfile",
      "Bind a Board-managed tool profile to a company or agent target.",
      bindToolProfileToolSchema,
      async ({ companyId, profileId, ...body }) => client.requestJson(
        "POST",
        `/companies/${client.resolveCompanyId(companyId)}/tools/profiles/${encodeURIComponent(profileId)}/bind`,
        { body },
      ),
    ),
    makeTool(
      "paperclipSetAgentAppPermission",
      "Set whether a connection is permitted for no agents, specified agents, or all agents. This does not install it for every run.",
      z.object({
        connectionId: z.string().uuid(),
        mode: z.enum(["none", "specific_agents", "all_agents"]),
        agentIds: z.array(z.string().uuid()).max(1000).default([]),
      }),
      async ({ connectionId, ...body }) => client.requestJson(
        "PUT",
        `/tool-connections/${encodeURIComponent(connectionId)}/agent-permission`,
        { body },
      ),
    ),
    makeTool(
      "paperclipSetAgentAppInstallPolicy",
      "Set whether a connection is installed every run for no agents, specified agents, or all agents. Permission is managed separately.",
      setAgentAppInstallPolicySchema,
      async ({ connectionId, mode, agentIds }) => client.requestJson(
        "PUT",
        `/tool-connections/${encodeURIComponent(connectionId)}/installs`,
        { body: { installs: mode === "all_agents"
          ? [{ targetType: "company", targetId: client.resolveCompanyId(null) }]
          : mode === "specific_agents"
            ? agentIds.map((targetId) => ({ targetType: "agent", targetId }))
            : [] } },
      ),
    ),
    makeTool(
      "paperclipListToolGateways",
      "List Board-managed named MCP gateways for a company.",
      z.object({ companyId: companyIdOptional }),
      async ({ companyId }) => client.requestJson("GET", `/companies/${client.resolveCompanyId(companyId)}/tools/gateways`),
    ),
    makeTool(
      "paperclipCreateToolGateway",
      "Create a Board-managed named MCP gateway. Gateway bearer tokens are intentionally not exposed through this MCP tool.",
      createToolGatewayToolSchema,
      async ({ companyId, ...body }) => client.requestJson("POST", `/companies/${client.resolveCompanyId(companyId)}/tools/gateways`, { body }),
    ),
    makeTool(
      "paperclipUpdateToolGateway",
      "Update a Board-managed named MCP gateway.",
      updateToolGatewayToolSchema,
      async ({ gatewayId, companyId, ...body }) => client.requestJson(
        "PATCH",
        `/tool-gateway/gateways/${encodeURIComponent(gatewayId)}`,
        { body: { companyId, ...body } },
      ),
    ),
    makeTool(
      "paperclipApiRequest",
      "Make a JSON request to an existing Paperclip /api endpoint for unsupported operations",
      apiRequestSchema,
      async ({ method, path, jsonBody }) => {
        if (!path.startsWith("/") || path.includes("..")) {
          throw new Error("path must start with / and be relative to /api, and must not contain '..'");
        }
        return client.requestJson(method, path, {
          body: parseOptionalJson(jsonBody),
        });
      },
    ),
  ];
}
