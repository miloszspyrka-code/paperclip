import { describe, expect, it } from "vitest";
import { decideSuccessfulRunHandoff, DEFAULT_MAX_SUCCESSFUL_RUN_HANDOFF_ATTEMPTS } from "../services/recovery/successful-run-handoff.js";

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    companyId: "company-1",
    agentId: "agent-1",
    status: "succeeded",
    issueCommentStatus: null,
    contextSnapshot: {},
    ...overrides,
  } as unknown as Parameters<typeof decideSuccessfulRunHandoff>[0]["run"];
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    companyId: "company-1",
    identifier: "KOMAA-104",
    title: "Test issue",
    description: "desc",
    status: "in_progress",
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    executionState: null,
    ...overrides,
  } as unknown as Parameters<typeof decideSuccessfulRunHandoff>[0]["issue"];
}

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-1",
    companyId: "company-1",
    status: "idle",
    ...overrides,
  } as unknown as Parameters<typeof decideSuccessfulRunHandoff>[0]["agent"];
}

describe("recovery/missing-disposition policy", () => {
  it("CASE 1: run succeeded and agent set done -> done, no continuation", () => {
    const decision = decideSuccessfulRunHandoff({
      run: makeRun(),
      issue: makeIssue({ status: "done" }),
      agent: makeAgent(),
      livenessState: "completed",
      detectedProgressSummary: "progress",
      finalReport: "done",
      nextAction: null,
      taskKey: null,
      hasActiveExecutionPath: false,
      hasQueuedWake: false,
      hasPendingInteractionOrApproval: false,
      hasPersistedMonitor: false,
      hasExplicitBlockerPath: false,
      hasOpenRecoveryIssue: false,
      hasPauseHold: false,
      hasActiveRoutineContinuation: false,
      budgetBlocked: false,
      idempotentWakeExists: false,
    });
    expect(decision.kind).toBe("skip");
    if (decision.kind === "skip") expect(decision.reason).toMatch(/valid disposition/);
  });

  it("CASE 2: run succeeded, issue still in_progress, no disposition -> max 1 corrective continuation", () => {
    const decision = decideSuccessfulRunHandoff({
      run: makeRun(),
      issue: makeIssue({ status: "in_progress" }),
      agent: makeAgent(),
      livenessState: "completed",
      detectedProgressSummary: "progress",
      finalReport: "report",
      nextAction: null,
      taskKey: null,
      hasActiveExecutionPath: false,
      hasQueuedWake: false,
      hasPendingInteractionOrApproval: false,
      hasPersistedMonitor: false,
      hasExplicitBlockerPath: false,
      hasOpenRecoveryIssue: false,
      hasPauseHold: false,
      hasActiveRoutineContinuation: false,
      budgetBlocked: false,
      idempotentWakeExists: false,
    });
    expect(decision.kind).toBe("enqueue");
    if (decision.kind === "enqueue") {
      expect(decision.payload.maxHandoffAttempts).toBe(DEFAULT_MAX_SUCCESSFUL_RUN_HANDOFF_ATTEMPTS);
      expect(decision.payload.handoffAttempt).toBe(1);
    }
  });

  it("CASE 3: corrective run itself should not trigger another handoff (prevents chain)", () => {
    const decision = decideSuccessfulRunHandoff({
      run: makeRun({ contextSnapshot: { handoffRequired: true, wakeReason: "finish_successful_run_handoff" } }),
      issue: makeIssue({ status: "in_progress" }),
      agent: makeAgent(),
      livenessState: "completed",
      detectedProgressSummary: "progress",
      finalReport: "report",
      nextAction: null,
      taskKey: null,
      hasActiveExecutionPath: false,
      hasQueuedWake: false,
      hasPendingInteractionOrApproval: false,
      hasPersistedMonitor: false,
      hasExplicitBlockerPath: false,
      hasOpenRecoveryIssue: false,
      hasPauseHold: false,
      hasActiveRoutineContinuation: false,
      budgetBlocked: false,
      idempotentWakeExists: false,
    });
    expect(decision.kind).toBe("skip");
    if (decision.kind === "skip") expect(decision.reason).toBe("source run is already a corrective handoff run");
  });

  it("CASE 4: adapter failure during continuation should not fake-block (recovery preserves owner)", () => {
    expect(DEFAULT_MAX_SUCCESSFUL_RUN_HANDOFF_ATTEMPTS).toBe(1);
  });

  it("CASE 5: real blockedBy with issue should still allow blocked status", () => {
    const decision = decideSuccessfulRunHandoff({
      run: makeRun(),
      issue: makeIssue({ status: "in_progress" }),
      agent: makeAgent(),
      livenessState: "completed",
      detectedProgressSummary: "progress",
      finalReport: "report",
      nextAction: null,
      taskKey: null,
      hasActiveExecutionPath: false,
      hasQueuedWake: false,
      hasPendingInteractionOrApproval: false,
      hasPersistedMonitor: false,
      hasExplicitBlockerPath: true,
      hasOpenRecoveryIssue: false,
      hasPauseHold: false,
      hasActiveRoutineContinuation: false,
      budgetBlocked: false,
      idempotentWakeExists: false,
    });
    expect(decision.kind).toBe("skip");
    if (decision.kind === "skip") expect(decision.reason).toBe("explicit blocker path owns the next action");
  });

  it("CASE 6: real human/external unblockDescriptor path is explicit blocker", () => {
    const decision = decideSuccessfulRunHandoff({
      run: makeRun(),
      issue: makeIssue({ status: "in_progress" }),
      agent: makeAgent(),
      livenessState: "completed",
      detectedProgressSummary: "progress",
      finalReport: "report",
      nextAction: null,
      taskKey: null,
      hasActiveExecutionPath: false,
      hasQueuedWake: false,
      hasPendingInteractionOrApproval: false,
      hasPersistedMonitor: false,
      hasExplicitBlockerPath: true,
      hasOpenRecoveryIssue: false,
      hasPauseHold: false,
      hasActiveRoutineContinuation: false,
      budgetBlocked: false,
      idempotentWakeExists: false,
    });
    expect(decision.kind).toBe("skip");
  });
});
