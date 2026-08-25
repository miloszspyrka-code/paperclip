/**
 * Bounded per-issue run budget guardrail.
 *
 * An issue assigned to an agent can otherwise absorb an unbounded number of
 * automatic heartbeat runs: liveness continuations, graph backstops, and
 * assignment reconcilers each re-wake the same agent for the same issue, and
 * every wake pays a full-price adapter session. This module caps the number of
 * terminal runs one issue may accumulate within a lookback window before the
 * automatic wake gate stops issuing unconditional heartbeats.
 *
 * Budget tiers (per acceptance): normal feature work 4, debug 6, complex 8.
 * The tier resolves from the agent runtime config or env; the default is the
 * normal tier so the guardrail errs toward cost containment.
 *
 * When the budget is exhausted the gate records a compact-and-hold decision:
 * the next allowed activity must be an explicit operator path - a human
 * comment to continue, marking the issue blocked, or escalation/reassignment -
 * instead of another unconditional heartbeat. Event-carrying wakes (human
 * comments, approvals, monitors) and explicit resumes never reach this gate;
 * they are the sanctioned "continue" path. Session compaction at the boundary
 * stays owned by the existing threshold-based session rotation policy.
 */

export const ISSUE_RUN_BUDGET_LIMITS = {
  normal: 4,
  debug: 6,
  complex: 8,
} as const;

export type IssueRunBudgetTier = keyof typeof ISSUE_RUN_BUDGET_LIMITS;

export const DEFAULT_ISSUE_RUN_BUDGET_TIER: IssueRunBudgetTier = "normal";

/** Terminal runs older than this do not count against the budget. */
export const ISSUE_RUN_BUDGET_LOOKBACK_MS = 24 * 60 * 60_000;

export const ISSUE_RUN_BUDGET_ENV_VAR = "PAPERCLIP_ISSUE_RUN_BUDGET_TIER";

export type IssueRunBudgetTierSource = "agent_override" | "env" | "default";

export interface ResolvedIssueRunBudgetTier {
  tier: IssueRunBudgetTier;
  limit: number;
  source: IssueRunBudgetTierSource;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseIssueRunBudgetTier(value: unknown): IssueRunBudgetTier | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized in ISSUE_RUN_BUDGET_LIMITS ? (normalized as IssueRunBudgetTier) : null;
}

export function resolveIssueRunBudgetTier(input: {
  runtimeConfig?: unknown;
  env?: Record<string, string | undefined>;
}): ResolvedIssueRunBudgetTier {
  const runtime = isRecord(input.runtimeConfig) ? input.runtimeConfig : {};
  const heartbeat = isRecord(runtime.heartbeat) ? runtime.heartbeat : {};
  const configured =
    parseIssueRunBudgetTier(heartbeat.runBudgetTier) ??
    parseIssueRunBudgetTier((isRecord(runtime.runBudget) ? runtime.runBudget : {}).tier) ??
    parseIssueRunBudgetTier(runtime.runBudgetTier);
  if (configured) {
    return { tier: configured, limit: ISSUE_RUN_BUDGET_LIMITS[configured], source: "agent_override" };
  }
  const fromEnv = parseIssueRunBudgetTier(input.env?.[ISSUE_RUN_BUDGET_ENV_VAR]);
  if (fromEnv) {
    return { tier: fromEnv, limit: ISSUE_RUN_BUDGET_LIMITS[fromEnv], source: "env" };
  }
  return {
    tier: DEFAULT_ISSUE_RUN_BUDGET_TIER,
    limit: ISSUE_RUN_BUDGET_LIMITS[DEFAULT_ISSUE_RUN_BUDGET_TIER],
    source: "default",
  };
}

export interface IssueRunBudgetInput {
  /** Maximum terminal runs allowed within the lookback window. */
  limit: number;
  /** Terminal runs already observed for this (agent, issue) in the window. */
  used: number;
}

export type IssueRunBudgetDecision =
  | { action: "allow"; limit: number; used: number }
  | {
      action: "compact_and_hold";
      limit: number;
      used: number;
      requiredExplicitAction: "continue" | "block" | "escalate";
      reason: string;
    };

export function evaluateIssueRunBudget(input: IssueRunBudgetInput): IssueRunBudgetDecision {
  const limit = Number.isFinite(input.limit) && input.limit > 0 ? Math.floor(input.limit) : 0;
  const used = Number.isFinite(input.used) && input.used > 0 ? Math.floor(input.used) : 0;
  // A non-positive limit disables the guardrail rather than blocking forever.
  if (limit <= 0 || used < limit) {
    return { action: "allow", limit, used };
  }
  return {
    action: "compact_and_hold",
    limit,
    used,
    requiredExplicitAction: "continue",
    reason:
      `issue accumulated ${used} terminal runs (budget ${limit}); ` +
      "require explicit continue/block/escalate instead of another unconditional heartbeat",
  };
}
