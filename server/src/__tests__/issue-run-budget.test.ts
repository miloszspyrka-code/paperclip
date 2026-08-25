import { describe, expect, it } from "vitest";
import {
  DEFAULT_ISSUE_RUN_BUDGET_TIER,
  ISSUE_RUN_BUDGET_LIMITS,
  evaluateIssueRunBudget,
  parseIssueRunBudgetTier,
  resolveIssueRunBudgetTier,
} from "../services/issue-run-budget.js";

describe("issue run budget tiers", () => {
  it("exposes the acceptance budgets: normal 4, debug 6, complex 8", () => {
    expect(ISSUE_RUN_BUDGET_LIMITS).toEqual({ normal: 4, debug: 6, complex: 8 });
    expect(DEFAULT_ISSUE_RUN_BUDGET_TIER).toBe("normal");
  });

  it("parses known tiers case-insensitively and rejects unknown values", () => {
    expect(parseIssueRunBudgetTier("debug")).toBe("debug");
    expect(parseIssueRunBudgetTier(" COMPLEX ")).toBe("complex");
    expect(parseIssueRunBudgetTier("unbounded")).toBeNull();
    expect(parseIssueRunBudgetTier(8)).toBeNull();
    expect(parseIssueRunBudgetTier(null)).toBeNull();
  });

  it("resolves the tier from the agent runtime override before env before default", () => {
    expect(
      resolveIssueRunBudgetTier({
        runtimeConfig: { heartbeat: { runBudgetTier: "complex" } },
        env: { PAPERCLIP_ISSUE_RUN_BUDGET_TIER: "debug" },
      }),
    ).toEqual({ tier: "complex", limit: 8, source: "agent_override" });

    expect(
      resolveIssueRunBudgetTier({
        runtimeConfig: { runBudget: { tier: "debug" } },
        env: { PAPERCLIP_ISSUE_RUN_BUDGET_TIER: "complex" },
      }),
    ).toEqual({ tier: "debug", limit: 6, source: "agent_override" });

    expect(
      resolveIssueRunBudgetTier({
        runtimeConfig: { runBudgetTier: "nonsense" },
        env: { PAPERCLIP_ISSUE_RUN_BUDGET_TIER: "debug" },
      }),
    ).toEqual({ tier: "debug", limit: 6, source: "env" });

    expect(resolveIssueRunBudgetTier({})).toEqual({
      tier: "normal",
      limit: 4,
      source: "default",
    });
  });
});

describe("evaluateIssueRunBudget", () => {
  it("allows runs below the limit", () => {
    expect(evaluateIssueRunBudget({ limit: 4, used: 3 })).toEqual({
      action: "allow",
      limit: 4,
      used: 3,
    });
  });

  it("holds as soon as completed runs reach the budget", () => {
    expect(evaluateIssueRunBudget({ limit: 4, used: 4 })).toMatchObject({
      action: "compact_and_hold",
      limit: 4,
      used: 4,
      requiredExplicitAction: "continue",
    });
  });

  it("holds once the budget is exhausted and names the explicit next steps", () => {
    const decision = evaluateIssueRunBudget({ limit: 6, used: 9 });
    expect(decision.action).toBe("compact_and_hold");
    if (decision.action === "compact_and_hold") {
      expect(decision.reason).toContain("require explicit continue/block/escalate");
    }
  });

  it("treats a non-positive limit as a disabled guardrail", () => {
    expect(evaluateIssueRunBudget({ limit: 0, used: 100 }).action).toBe("allow");
    expect(evaluateIssueRunBudget({ limit: -1, used: 50 }).action).toBe("allow");
  });

  it("sanitizes non-finite counters defensively", () => {
    expect(evaluateIssueRunBudget({ limit: Number.NaN, used: Number.NaN }).action).toBe("allow");
    expect(evaluateIssueRunBudget({ limit: 4.9, used: 5.7 })).toMatchObject({
      action: "compact_and_hold",
      limit: 4,
      used: 5,
    });
  });
});
