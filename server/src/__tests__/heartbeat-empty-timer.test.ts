import { describe, expect, it } from "vitest";
import { isRetryableInteractionContinuationInfrastructureFailure, shouldSkipEmptyManagedTimer } from "../services/heartbeat.ts";

// P0-D: EMPTY TIMER must finish before the adapter, OpenCode spawn, or any LLM
// request. These tests exercise the pure, LLM-free preflight decision that the
// server uses to skip empty managed timer wakes. (The "adapter execute call
// count = 0" assertion is covered by the integration test
// heartbeat-stale-queue-invalidation.test.ts: "skips generic timer wakes with no
// actionable assigned work before adapter execution".)

describe("P0-D shouldSkipEmptyManagedTimer", () => {
  it("does not schedule a recovery loop for deterministic workspace preflight failures", () => {
    expect(isRetryableInteractionContinuationInfrastructureFailure({
      errorCode: "workspace_validation_failed",
      error: "workspace path is missing",
      resultJson: null,
    })).toBe(false);
  });

  it("skips an empty generic timer wake (zero actionable work)", () => {
    expect(
      shouldSkipEmptyManagedTimer({
        source: "timer",
        hasActionableWork: false,
        allowEmptyTimerWakes: false,
      }),
    ).toBe(true);
  });

  it("does NOT skip a generic timer wake that has actionable assigned work", () => {
    expect(
      shouldSkipEmptyManagedTimer({
        source: "timer",
        hasActionableWork: true,
        allowEmptyTimerWakes: false,
      }),
    ).toBe(false);
  });

  it("does NOT cut a wake sourced from assignment", () => {
    expect(
      shouldSkipEmptyManagedTimer({
        source: "assignment",
        hasActionableWork: false,
        allowEmptyTimerWakes: false,
      }),
    ).toBe(false);
  });

  it("does NOT cut a wake sourced from on_demand", () => {
    expect(
      shouldSkipEmptyManagedTimer({
        source: "on_demand",
        hasActionableWork: false,
        allowEmptyTimerWakes: false,
      }),
    ).toBe(false);
  });

  it("does NOT cut a wake sourced from automation", () => {
    expect(
      shouldSkipEmptyManagedTimer({
        source: "automation",
        hasActionableWork: false,
        allowEmptyTimerWakes: false,
      }),
    ).toBe(false);
  });

  it("does NOT cut an issue-scoped timer wake (assignment work present)", () => {
    expect(
      shouldSkipEmptyManagedTimer({
        source: "timer",
        issueId: "issue-1",
        hasActionableWork: false,
        allowEmptyTimerWakes: false,
      }),
    ).toBe(false);
  });

  it("does NOT cut a task-scoped timer wake", () => {
    expect(
      shouldSkipEmptyManagedTimer({
        source: "timer",
        taskId: "task-1",
        hasActionableWork: false,
        allowEmptyTimerWakes: false,
      }),
    ).toBe(false);
  });

  it("honours an explicit opt-in to allow empty timer wakes", () => {
    expect(
      shouldSkipEmptyManagedTimer({
        source: "timer",
        hasActionableWork: false,
        allowEmptyTimerWakes: true,
      }),
    ).toBe(false);
  });

  it("race: work vanishing before spawn yields a skip (zero model invocation)", () => {
    // The recheck gate recomputes hasActionableWork immediately before spawn;
    // if it is now false, the wake is skipped and no LLM request is made.
    const beforeSpawn = shouldSkipEmptyManagedTimer({
      source: "timer",
      hasActionableWork: false,
      allowEmptyTimerWakes: false,
    });
    expect(beforeSpawn).toBe(true);
  });
});
