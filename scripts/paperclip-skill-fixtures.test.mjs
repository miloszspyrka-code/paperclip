// Paperclip skill regression fixtures (CASE A-J) against the shared contract.
// Pure logic, no production mutations, no real agents, no runtime restarts.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_HANDOFF_DEPTH,
  handoffGuard,
  enforceWriteGuard,
  runtimeDesiredStateReplay,
  resolveMode,
  classifyFailureLayers,
  classifyZeroTokenRun,
  firstBrokenPrerequisite,
  boardOnlyGate,
  cooDedupCheck,
  buildIdempotencyKey,
  idempotentCreate,
  wipGuard,
  opencodeIsolationCheck,
  runtimeMutationPreflight,
  createRuntimeMutationLock,
  deploymentSequenceResult,
  checkWriteBudget,
  buildOperationEnvelope,
} from "./paperclip-skill-contract.mjs";

test("CASE A - zero-token PROCESS_LOST never blames PRODUCT_CODE", () => {
  const result = classifyZeroTokenRun({
    inputTokens: 0,
    outputTokens: 0,
    processLost: true,
    providerRequestSent: false,
  });
  assert.equal(result.OBSERVED_FAILURE_LAYER, "PROCESS");
  assert.notEqual(result.ROOT_CAUSE_LAYER, "PRODUCT_CODE");
  assert.equal(result.WRITES_PERFORMED, 0);
  assert.equal(result.IS_RETRY_SAFE, false);
});

test("CASE B - healthy connection without Access stops at ACCESS", () => {
  const broken = firstBrokenPrerequisite({
    APPLICATION: true,
    CONNECTION: true,
    CONNECTION_HEALTH: true,
    CATALOG: true,
    ACCESS: false,
  });
  assert.equal(broken.broken, "ACCESS");
});

test("CASE C - unexpected host plugin fails isolation with OPENCODE_RUNTIME root cause", () => {
  const check = opencodeIsolationCheck({
    runtimeProfile: {
      EXPECTED_PLUGINS: ["pinned-plugin@1.0.0"],
      EXPECTED_MCP_SERVERS: ["Sender"],
      EXPECTED_PROVIDER: "opencode-go",
      EXPECTED_MODEL: "hy3",
    },
    presentPlugins: [
      { name: "pinned-plugin@1.0.0", pinned: true },
      { name: "host-private-plugin@2.0.0", pinned: false },
    ],
    presentMcpServers: [{ name: "Sender" }],
    providerSmoke: true,
    nativeTools: true,
  });
  assert.equal(check.HOST_PLUGIN_LEAK, true);
  assert.equal(check.CONFIG_ISOLATED, false);
  assert.equal(check.ROOT_CAUSE_LAYER, "OPENCODE_RUNTIME");
});

test("CASE D - identical COO goal on an in_review task is reused", () => {
  const decision = cooDedupCheck({
    existingIssues: [
      { id: "KOMAA-104", normalizedGoal: "wdrozyc nowy onboarding", status: "in_review" },
    ],
    normalizedGoal: "wdrozyc nowy onboarding",
  });
  assert.equal(decision.reuse, "KOMAA-104");
  assert.equal(decision.NEW_TASKS_CREATED, 0);
  assert.equal(decision.matchedStatus, "in_review");
});

test("CASE E - idempotent create returns the same issue twice", () => {
  const key = buildIdempotencyKey({
    companyId: "c1",
    goal: "Wdrożyć nowy Onboarding",
    scope: "implementation + QA",
    project: "kompas",
    ownerRole: "engineer",
  });
  const store = new Map();
  const first = idempotentCreate(store, key, () => "issue-1");
  const second = idempotentCreate(store, key, () => "issue-2");
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.issueId, second.issueId);
});

test("CASE F - restart blocked while a run is active; restart count stays zero", () => {
  const preflight = runtimeMutationPreflight({
    activeRuns: 1,
    activeAgentExecutions: 0,
    activeRuntimeWrites: false,
    pendingFinalize: false,
    dirtyRepository: false,
    requireCleanRepository: true,
    existingTask: true,
    rollbackCapability: true,
  });
  assert.equal(preflight.allowed, false);
  assert.equal(preflight.BLOCKER, "ACTIVE_EXECUTION");
  assert.equal(preflight.FINAL_GATE, "BLOCKED");
  let restartCount = 0;
  if (preflight.allowed) restartCount += 1;
  assert.equal(restartCount, 0);
});

test("CASE G - plugin schema mutation splits PROVIDER observed from OPENCODE_RUNTIME root cause", () => {
  const layers = classifyFailureLayers({
    observedLayer: "PROVIDER",
    rootCauseLayer: "OPENCODE_RUNTIME",
    contributingLayers: ["TOOL_GATEWAY_MCP"],
  });
  assert.equal(layers.OBSERVED_FAILURE_LAYER, "PROVIDER");
  assert.equal(layers.ROOT_CAUSE_LAYER, "OPENCODE_RUNTIME");
  // No handoff loop: debug-run -> health is within depth limit and acyclic.
  const chain = ["paperclip-debug-run"];
  assert.equal(chain.includes("paperclip-opencode-health"), false);
  assert.ok(chain.length < MAX_HANDOFF_DEPTH);
});

test("CASE H - Board-only mutation requires BOARD_ACTION_REQUIRED without spoofing", () => {
  const gate = boardOnlyGate(false);
  assert.equal(gate.allowed, false);
  assert.equal(gate.action, "BOARD_ACTION_REQUIRED");
  assert.ok(!JSON.stringify(gate).includes("impersonat"));
});

test("CASE I - failed smoke forces rollback path and forbids false PASS", () => {
  const outcome = deploymentSequenceResult({
    smokeResult: "FAIL",
    rollbackSafe: true,
    postRollbackHealth: "PASS",
  });
  assert.equal(outcome.PASS_CLAIMED, false);
  assert.equal(outcome.ROLLBACK_PERFORMED, true);
  assert.match(String(outcome.FINAL_GATE), /ROLLBACK|FAIL/);
  const unsafe = deploymentSequenceResult({ smokeResult: "FAIL", rollbackSafe: false, postRollbackHealth: null });
  assert.equal(unsafe.FINAL_GATE, "FAIL");
});

test("CASE J - DIAGNOSE mode performs zero writes for every registered skill", () => {
  for (const skill of [
    "paperclip-debug-run",
    "paperclip-napraw-tools",
    "paperclip-opencode-health",
    "paperclip-deleguj-coo",
    "paperclip-wdroz-runtime",
  ]) {
    const envelope = buildOperationEnvelope({ skill, request: "sprawdz stan" });
    assert.equal(envelope.MODE, "DIAGNOSE");
    assert.equal(envelope.WRITE_BUDGET, 0);
    const budget = checkWriteBudget(envelope, 0);
    assert.equal(budget.ok, true);
    const violation = checkWriteBudget(envelope, 1);
    assert.equal(violation.ok, false);
    assert.equal(violation.reason, "DIAGNOSE_FORBIDS_WRITES");
  }
});

test("handoff loop A -> B -> A terminates with HANDOFF_LOOP_BLOCKED", () => {
  const chain = ["paperclip-debug-run", "paperclip-opencode-health"];
  const backToStart = handoffGuard(chain, "paperclip-debug-run");
  assert.equal(backToStart.allowed, false);
  assert.equal(backToStart.reason, "HANDOFF_LOOP_BLOCKED");
  const depthExceeded = handoffGuard(["a", "b"], "c");
  assert.equal(depthExceeded.allowed, false);
  assert.match(String(depthExceeded.reason), /HANDOFF_DEPTH_EXCEEDED\(2\)/);
  assert.equal(handoffGuard(["paperclip-debug-run"], "paperclip-napraw-tools").allowed, true);
});

test("mode invariant - regex can never produce EXECUTE; explicit mode wins", () => {
  // Mutation-flavored text without explicitMode stays DIAGNOSE.
  for (const request of [
    "sprawdz i jak trzeba napraw",
    "zobacz co nie działa i popraw",
    "napraw tylko jeżeli to bezpieczne",
    "oceń czy wymaga wdrożenia",
    "napraw i wdrozy izolacje",
  ]) {
    assert.equal(resolveMode(request), "DIAGNOSE");
  }
  // Explicit operator intent is the only path to EXECUTE.
  assert.equal(resolveMode("cokolwiek", { explicitMode: "EXECUTE" }), "EXECUTE");
  assert.throws(() => resolveMode("x", { explicitMode: "MUTATE" }));
});

test("server-side write guard denies non-EXECUTE modes and budget overrun", () => {
  const diagnoseEnvelope = buildOperationEnvelope({ skill: "paperclip-napraw-tools", request: "sprawdz sender" });
  const denied = enforceWriteGuard({
    envelope: diagnoseEnvelope,
    writesUsed: 0,
    toolName: "paperclipUpdateIssue",
    arguments: { issueId: "KOMAA-104", status: "done" },
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.code, "SKILL_WRITE_GUARD_DENIED");

  const executeEnvelope = buildOperationEnvelope({
    skill: "paperclip-napraw-tools",
    request: "apply",
    explicitMode: "EXECUTE",
  });
  assert.ok(executeEnvelope.WRITE_BUDGET > 0);
  // Budget exhaustion.
  const exhausted = enforceWriteGuard({
    envelope: executeEnvelope,
    writesUsed: executeEnvelope.WRITE_BUDGET,
    toolName: "paperclipAddComment",
    arguments: { issueId: "KOMAA-104" },
  });
  assert.equal(exhausted.allowed, false);
  assert.match(exhausted.detail, /WRITE_BUDGET_EXCEEDED/);
  // In-budget write passes.
  const okWrite = enforceWriteGuard({
    envelope: executeEnvelope,
    writesUsed: 0,
    toolName: "paperclipAddComment",
    arguments: { issueId: "KOMAA-104" },
  });
  assert.equal(okWrite.allowed, true);
  // No active envelope leaves normal operation untouched (backwards compat).
  assert.equal(enforceWriteGuard({ envelope: null }).allowed, true);
});

test("target scope guard enforces issue:<id> envelope target", () => {
  const envelope = buildOperationEnvelope({
    skill: "paperclip-napraw-tools",
    request: "apply fix",
    explicitMode: "EXECUTE",
    target: "issue:c293e25d-6f8c-4636-a238-fb692afee9ef",
  });
  const inScope = enforceWriteGuard({
    envelope,
    writesUsed: 0,
    toolName: "paperclipAddComment",
    arguments: { issueId: "c293e25d-6f8c-4636-a238-fb692afee9ef" },
  });
  assert.equal(inScope.allowed, true);
  const outOfScope = enforceWriteGuard({
    envelope,
    writesUsed: 0,
    toolName: "paperclipAddComment",
    arguments: { issueId: "other-issue" },
  });
  assert.equal(outOfScope.allowed, false);
  assert.match(outOfScope.detail, /TARGET_OUT_OF_SCOPE/);
});

test("CASE K - runtime desired-state replay is idempotent (no double restart)", () => {
  const entries = [{ key: "opencodeRuntimePlugins", desired: "plugin@1.2.3", current: "plugin@1.2.3" }];
  const first = runtimeDesiredStateReplay(entries.map((e) => ({ ...e, current: "1.2.2" })));
  assert.equal(first.action, "APPLY");
  assert.equal(first.restartRequired, true);
  // Replay after apply: current == desired -> no change, no second restart.
  let restarts = 0;
  if (first.restartRequired) restarts += 1;
  const replay = runtimeDesiredStateReplay(entries);
  assert.equal(replay.action, "NO_CHANGE_REQUIRED");
  assert.equal(replay.restartRequired, false);
  if (replay.restartRequired) restarts += 1;
  assert.equal(restarts, 1);
});
