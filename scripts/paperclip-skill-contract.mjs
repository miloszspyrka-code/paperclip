// Shared execution contract for all Paperclip skills (single source of truth).
// Consumed by: mcp-public-gateway.mjs (paperclipUseSkill router), regression
// fixtures, and skill documents via generated guidance text.

import { createHash } from "node:crypto";

export const SKILL_CONTRACT_VERSION = "2.0.0";
export const MAX_HANDOFF_DEPTH = 2;
export const MAX_ADMIN_WRITES_PER_OPERATION = 3;
export const MODES = ["DIAGNOSE", "PLAN", "EXECUTE"];
export const RESULTS = ["PASS", "FAIL", "BLOCKED", "HANDOFF"];

const CTB_INTENT_RE = /\b(przebuduj|zaprojektuj\s+od\s+nowa|zmien\w*\s+architektur\w*|now\w*\s+architektur\w*)\b.*\b(architektur\w*|execution\s+engine|run\s+persistence|opencode|paperclip)\b|\b(architecture|execution\s+engine|run\s+persistence)\b.*\b(rebuild|redesign|change)\b/i;

export function classifyChangeRequest(request) {
  const text = String(request || "").trim();
  if (CTB_INTENT_RE.test(text)) return { changeClass: "CTB", handoffTo: "OpenCode CTB" };
  if (/\b(napraw\w*|popraw\w*|usprawn\w*|incremental\w*)\b/i.test(text)) return { changeClass: "ITB", handoffTo: null };
  return { changeClass: "RTB", handoffTo: null };
}

// PLAN intent markers. Explicit EXECUTE markers take precedence over planning.
const PLAN_INTENT_RE =
  /\b(zaplanuj|przygotuj\s+plan|plan\s+only|utworz\s+plan|propose\s+a\s+plan)\b/i;
const REQUEST_EXECUTE_RE = /\bMODE\s*=\s*EXECUTE\b/i;
const REPAIR_INTENT_RE = /\b(napraw\w*|popraw\w*|usun\w*|usuń\w*)\b/i;
const CHANGE_INTENT_RE = /\b(wykonaj\s+zmian\w*|wprowadz\w*\s+zmian\w*|wprowadź\s+zmian\w*|wdroz\w*|wdroż\w*|zaimplementuj\w*|zastosuj\s+zmian\w*)\b/i;

// Machine-readable registry. Frontmatter stays minimal (name/description) for
// parser compatibility; versions and write policy live here.
export const SKILL_REGISTRY = {
  "paperclip-debug-run": {
    version: "2.0.0",
    modes: ["DIAGNOSE", "PLAN", "EXECUTE"],
    allowedWrites: 0,
    executeWritesPolicy: "safe-fix-only-with-evidence-and-envelope",
    aliases: ["/debug", "/debug-run"],
  },
  "paperclip-napraw-tools": {
    version: "2.0.0",
    modes: ["DIAGNOSE", "PLAN", "EXECUTE"],
    allowedWrites: MAX_ADMIN_WRITES_PER_OPERATION,
    executeWritesPolicy: "first-broken-paperclip-owned-layer",
    aliases: ["/fix-tools", "/tools"],
  },
  "paperclip-opencode-health": {
    version: "2.0.0",
    modes: ["DIAGNOSE", "PLAN", "EXECUTE"],
    allowedWrites: MAX_ADMIN_WRITES_PER_OPERATION,
    executeWritesPolicy: "smallest-fix-at-failing-layer",
    aliases: ["/health", "/opencode-health"],
  },
  "paperclip-deleguj-coo": {
    version: "2.0.0",
    modes: ["DIAGNOSE", "PLAN"],
    allowedWrites: 0,
    // Issue creation/assignment happens through dedicated tools in a follow-up
    // EXECUTE operation; the skill itself coordinates.
    executeWritesPolicy: "none-in-skill-coordination-only",
    aliases: ["/coo", "/delegate-coo"],
  },
  "paperclip-wdroz-runtime": {
    version: "2.0.0",
    modes: ["DIAGNOSE", "PLAN", "EXECUTE"],
    allowedWrites: MAX_ADMIN_WRITES_PER_OPERATION,
    executeWritesPolicy: "preflight-lock-snapshot-rollback-required",
    aliases: ["/runtime", "/deploy-runtime"],
  },
  "wiki-query": {
    version: "1.0.0",
    modes: ["DIAGNOSE", "PLAN"],
    allowedWrites: 0,
    executeWritesPolicy: "none-read-only-wiki-discovery",
    aliases: [],
  },
  "wiki-propose-change": {
    version: "1.0.0",
    modes: ["PLAN"],
    allowedWrites: 0,
    executeWritesPolicy: "none-proposal-only",
    aliases: [],
  },
  "wiki-apply-change": {
    version: "1.0.0",
    modes: ["EXECUTE"],
    allowedWrites: MAX_ADMIN_WRITES_PER_OPERATION,
    executeWritesPolicy: "expected-hash-required-wiki-page-only",
    aliases: [],
  },
};

// Mode resolution is deliberately conservative: only explicit markers or the
// conjunction of repair and change intent can enter EXECUTE.
export function resolveMode(request, { explicitMode } = {}) {
  if (explicitMode !== undefined && !MODES.includes(explicitMode)) {
    throw new Error(`Invalid explicit mode: ${explicitMode}`);
  }
  if (explicitMode === "EXECUTE") return "EXECUTE";
  const text = String(request || "");
  if (REQUEST_EXECUTE_RE.test(text)) return "EXECUTE";
  if (explicitMode !== undefined) {
    return explicitMode;
  }
  if (!text.trim()) return "DIAGNOSE";
  if (REPAIR_INTENT_RE.test(text) && CHANGE_INTENT_RE.test(text)) return "EXECUTE";
  if (PLAN_INTENT_RE.test(text)) return "PLAN";
  return "DIAGNOSE";
}

export function assertModeAllowed(skillName, mode) {
  const entry = SKILL_REGISTRY[skillName];
  if (!entry) throw new Error(`Unknown skill: ${skillName}`);
  if (!entry.modes.includes(mode)) {
    throw new Error(`Mode ${mode} is not allowed for ${skillName}`);
  }
  return true;
}

export function buildOperationEnvelope(input) {
  const mode = input.mode ?? resolveMode(input.request, { explicitMode: input.explicitMode });
  const registry = SKILL_REGISTRY[input.skill];
  if (!registry) throw new Error(`Unknown skill: ${input.skill}`);
  assertModeAllowed(input.skill, mode);
  const operationId = `op-${createHash("sha256")
    .update([input.skill, input.target ?? "", input.actor ?? "", Date.now(), Math.random()].join("|"))
    .digest("hex")
    .slice(0, 16)}`;
  return {
    OPERATION_ID: operationId,
    SKILL: input.skill,
    SKILL_VERSION: registry.version,
    MODE: mode,
    TARGET: input.target ?? null,
    ACTOR: input.actor ?? "chatgpt-operator",
    START_STATE: input.startState ?? "unverified",
    WRITE_BUDGET: mode === "DIAGNOSE" ? 0 : mode === "PLAN" ? 0 : registry.allowedWrites,
    HANDOFF_DEPTH: input.handoffDepth ?? 0,
    EVIDENCE: [],
    RESULT: null,
  };
}

// Handoff loop guard: A -> B -> A must terminate with HANDOFF_LOOP_BLOCKED.
export function handoffGuard(chain, nextSkill) {
  const visited = new Set(chain);
  if (visited.has(nextSkill)) {
    return { allowed: false, reason: "HANDOFF_LOOP_BLOCKED" };
  }
  if (chain.length >= MAX_HANDOFF_DEPTH) {
    return { allowed: false, reason: `HANDOFF_DEPTH_EXCEEDED(${MAX_HANDOFF_DEPTH})` };
  }
  return { allowed: true, reason: null };
}

export function checkWriteBudget(envelope, writesPerformed) {
  if (envelope.MODE === "DIAGNOSE" && writesPerformed > 0) {
    return { ok: false, reason: "DIAGNOSE_FORBIDS_WRITES" };
  }
  if (writesPerformed > envelope.WRITE_BUDGET) {
    return { ok: false, reason: "WRITE_BUDGET_EXCEEDED" };
  }
  return { ok: true, reason: null };
}

// Server-side write guard. Enforced by the gateway before any mutating tool
// call reaches upstream when an operation envelope is active for the session.
// Target scope convention: envelope.TARGET = "issue:<id>" enforces that writes
// carry the same issueId; other target formats do not constrain scope.
export function enforceWriteGuard({ envelope, writesUsed = 0, toolName, arguments: args = {} }) {
  if (!envelope) return { allowed: true }; // no active skill operation - unchanged behavior
  const deny = (detail) => ({
    allowed: false,
    code: "SKILL_WRITE_GUARD_DENIED",
    operationId: envelope.OPERATION_ID,
    detail,
  });
  if (envelope.MODE !== "EXECUTE") {
    return deny(`MODE=${envelope.MODE} forbids mutations. Reopen the skill with explicitMode="EXECUTE".`);
  }
  if (writesUsed >= envelope.WRITE_BUDGET) {
    return deny(`WRITE_BUDGET_EXCEEDED (${writesUsed}/${envelope.WRITE_BUDGET}).`);
  }
  if (typeof envelope.TARGET === "string" && envelope.TARGET.startsWith("issue:")) {
    const scopedIssueId = envelope.TARGET.slice("issue:".length);
    const argIssueId = args?.issueId ?? null;
    if (argIssueId && argIssueId !== scopedIssueId) {
      return deny(`TARGET_OUT_OF_SCOPE: ${argIssueId} != ${scopedIssueId}`);
    }
  }
  return { allowed: true, operationId: envelope.OPERATION_ID, writesUsed };
}

// CASE K: desired-state replay for runtime operations. Re-running an applied
// change must yield NO_CHANGE_REQUIRED, not another mutation/restart.
export function runtimeDesiredStateReplay(entries) {
  const changes = entries.filter((entry) => entry.desired !== entry.current);
  if (changes.length === 0) {
    return { action: "NO_CHANGE_REQUIRED", keys: [], restartRequired: false };
  }
  return { action: "APPLY", keys: changes.map((entry) => entry.key), restartRequired: true };
}

// CASE G / debug-run layer split validation.
export function classifyFailureLayers({ observedLayer, rootCauseLayer, contributingLayers = [] }) {
  const validLayers = new Set([
    "CONTROL_PLANE", "ADAPTER", "PROVIDER", "OPENCODE_RUNTIME",
    "TOOL_GATEWAY_MCP", "WORKSPACE_GIT", "PROCESS", "PRODUCT_CODE", "UNKNOWN",
  ]);
  for (const layer of [observedLayer, rootCauseLayer]) {
    if (!validLayers.has(layer)) throw new Error(`Invalid failure layer: ${layer}`);
  }
  for (const layer of contributingLayers) {
    if (!validLayers.has(layer)) throw new Error(`Invalid contributing layer: ${layer}`);
  }
  if (observedLayer === rootCauseLayer && contributingLayers.length === 0) {
    throw new Error("Root cause requires separation from observed layer or explicit contributing layers");
  }
  return { OBSERVED_FAILURE_LAYER: observedLayer, ROOT_CAUSE_LAYER: rootCauseLayer, CONTRIBUTING_LAYERS: contributingLayers };
}

// CASE A: zero-token PROCESS_LOST classification.
export function classifyZeroTokenRun(run) {
  const noModelWork = run.inputTokens === 0 && run.outputTokens === 0;
  let observedLayer = run.processLost ? "PROCESS" : "UNKNOWN";
  let rootCauseLayer;
  if (noModelWork && run.providerRequestSent === false) {
    // Request never reached the provider: adapter/runtime/config/schema/auth
    // chain first. PRODUCT_CODE is forbidden without direct implementation evidence.
    rootCauseLayer = "OPENCODE_RUNTIME";
  } else if (noModelWork) {
    rootCauseLayer = "PROVIDER";
  } else {
    rootCauseLayer = "UNKNOWN";
  }
  return {
    ...classifyFailureLayers({
      observedLayer,
      rootCauseLayer,
      contributingLayers: ["ADAPTER"],
    }),
    IS_RETRY_SAFE: false,
    WRITES_PERFORMED: 0,
  };
}

// Canonical tool-repair chain (single ordering used by docs + diagnostics).
export const NAPRAW_CHAIN = [
  "APPLICATION",
  "CONNECTION",
  "CONNECTION_HEALTH",
  "CATALOG",
  "ACCESS",
  "INSTALL",
  "PROFILE",
  "RULE/POLICY",
  "EFFECTIVE_PROFILE",
  "TOOL_GATEWAY",
  "GENERATED_MCP",
  "PROVIDER_SCHEMA",
  "SAFE_TOOL_CALL",
  "AUDIT",
];

// CASE B: stop at first broken prerequisite.
export function firstBrokenPrerequisite(layerResults) {
  for (const step of NAPRAW_CHAIN) {
    const result = layerResults[step];
    if (result === undefined || result === null) continue;
    if (result !== true) return { broken: step, healthyUpstream: NAPRAW_CHAIN.indexOf(step) };
  }
  return { broken: null, healthyUpstream: NAPRAW_CHAIN.length };
}

export function boardOnlyGate(actorIsBoard) {
  if (!actorIsBoard) {
    return { allowed: false, action: "BOARD_ACTION_REQUIRED" };
  }
  return { allowed: true, action: null };
}

// CASE D/E: COO dedup across active statuses plus recent done.
export function cooDedupCheck({ existingIssues, normalizedGoal }) {
  const activeStatuses = new Set(["backlog", "todo", "in_progress", "in_review", "blocked"]);
  const match = existingIssues.find(
    (issue) =>
      issue.normalizedGoal === normalizedGoal &&
      (activeStatuses.has(issue.status) ||
        (issue.status === "done" && issue.recentlyDone === true)),
  );
  return {
    reuse: match?.id ?? null,
    NEW_TASKS_CREATED: match ? 0 : 1,
    matchedStatus: match?.status ?? null,
  };
}

// Stable idempotency key derived from company+goal+scope+project+owner role.
export function buildIdempotencyKey({ companyId, goal, scope, project, ownerRole }) {
  const canonical = [companyId, normalize(goal), normalize(scope), project ?? "", ownerRole].join("\u241F");
  return `coo-${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}

function normalize(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Idempotent create: same key reuses the stored issue id.
export function idempotentCreate(store, key, factory) {
  if (store.has(key)) return { issueId: store.get(key), created: false };
  const issueId = factory();
  store.set(key, issueId);
  return { issueId, created: true };
}

// WIP guard: START READY WORK respects existing WIP and dependencies.
export function wipGuard({ readyTasks, maxWip, activeCount }) {
  const slots = Math.max(0, maxWip - activeCount);
  return {
    startable: readyTasks.filter((task) => task.blockedBy.length === 0).slice(0, slots),
    deferred: readyTasks.filter(
      (task) => task.blockedBy.length > 0 || slots <= readyTasks.filter((t) => t.blockedBy.length === 0).indexOf(task),
    ),
    slotsAvailable: slots,
  };
}

// OpenCode health expected-profile comparison (source of truth inputs).
export function opencodeIsolationCheck({ runtimeProfile, presentPlugins, presentMcpServers, providerSmoke, nativeTools }) {
  const expectedPlugins = new Set(runtimeProfile.EXPECTED_PLUGINS);
  const expectedMcp = new Set(runtimeProfile.EXPECTED_MCP_SERVERS);
  const pluginLeak = presentPlugins.some((p) => !expectedPlugins.has(p));
  const mcpLeak = presentMcpServers.some((m) => !expectedMcp.has(m.name));
  const unpinned = presentPlugins.filter((p) => !p.pinned);
  const isolationFail = pluginLeak || mcpLeak;
  return {
    CONFIG_ISOLATED: !isolationFail,
    HOST_PLUGIN_LEAK: pluginLeak,
    HOST_MCP_LEAK: mcpLeak,
    PAPERCLIP_MCP_ONLY: !mcpLeak,
    UNPINNED_PLUGINS: unpinned.map((p) => p.name),
    PROVIDER_SMOKE: providerSmoke ? "PASS" : "FAIL",
    NATIVE_TOOLS: nativeTools ? "PASS" : "FAIL",
    ROOT_CAUSE_LAYER: isolationFail ? "OPENCODE_RUNTIME" : null,
    OBSERVED_FAILURE_LAYER: isolationFail ? "OPENCODE_RUNTIME" : null,
  };
}

// Runtime mutation preflight (CASE F).
export function runtimeMutationPreflight(state) {
  const blockers = [];
  if (state.activeRuns > 0) blockers.push("ACTIVE_EXECUTION");
  if (state.activeAgentExecutions > 0) blockers.push("ACTIVE_EXECUTION");
  if (state.activeRuntimeWrites) blockers.push("ACTIVE_RUNTIME_WRITE");
  if (state.pendingFinalize) blockers.push("PENDING_FINALIZE");
  if (state.dirtyRepository && state.requireCleanRepository) blockers.push("DIRTY_REPOSITORY");
  if (!state.existingTask) blockers.push("MISSING_AUDITABLE_TASK");
  if (!state.rollbackCapability) blockers.push("NO_ROLLBACK_PATH");
  return {
    allowed: blockers.length === 0,
    BLOCKER: blockers[0] ?? null,
    FINAL_GATE: blockers.length === 0 ? "READY" : "BLOCKED",
  };
}

// Mutex for runtime mutations.
export function createRuntimeMutationLock() {
  let holder = null;
  return {
    acquire(owner) {
      if (holder) return { acquired: false, holder };
      holder = owner;
      return { acquired: true, holder: owner };
    },
    release(owner) {
      if (holder !== owner) return false;
      holder = null;
      return true;
    },
    get holder() {
      return holder;
    },
  };
}

// CASE I: smoke fail forces rollback path and post-rollback verification.
export function deploymentSequenceResult({ smokeResult, rollbackSafe, postRollbackHealth }) {
  if (smokeResult === "PASS") {
    return { FINAL_GATE: "PASS", ROLLBACK_REQUIRED: false };
  }
  if (!rollbackSafe) {
    return { FINAL_GATE: "FAIL", ROLLBACK_REQUIRED: true, ROLLBACK_PERFORMED: false, NOTE: "rollback unsafe - manual path required" };
  }
  const verified = postRollbackHealth === "PASS" && postRollbackHealth != null;
  return {
    FINAL_GATE: verified ? "ROLLBACK_VERIFIED_FAIL_ORIGINAL" : "FAIL",
    ROLLBACK_REQUIRED: true,
    ROLLBACK_PERFORMED: true,
    POST_ROLLBACK_HEALTH: postRollbackHealth,
    PASS_CLAIMED: false,
  };
}

// Common result envelope builder wrapping domain-specific fields.
export function buildResultEnvelope(envelope, domainOutput, patch = {}) {
  return {
    SKILL: envelope.SKILL,
    SKILL_VERSION: envelope.SKILL_VERSION,
    MODE: envelope.MODE,
    RESULT: patch.RESULT ?? "PASS",
    ROOT_CAUSE_LAYER: patch.ROOT_CAUSE_LAYER ?? null,
    OBSERVED_FAILURE_LAYER: patch.OBSERVED_FAILURE_LAYER ?? null,
    CONTRIBUTING_LAYERS: patch.CONTRIBUTING_LAYERS ?? [],
    CONFIDENCE: patch.CONFIDENCE ?? "MEDIUM",
    EVIDENCE_REFERENCES: patch.EVIDENCE_REFERENCES ?? [],
    WRITES_PERFORMED: patch.WRITES_PERFORMED ?? 0,
    HANDOFF_TO: patch.HANDOFF_TO ?? null,
    RETRY_SAFE: patch.RETRY_SAFE ?? false,
    ROLLBACK_REQUIRED: patch.ROLLBACK_REQUIRED ?? false,
    NEXT_SINGLE_ACTION: patch.NEXT_SINGLE_ACTION ?? null,
    DOMAIN_OUTPUT: domainOutput,
  };
}
