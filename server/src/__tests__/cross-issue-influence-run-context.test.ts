import { describe, expect, it } from "vitest";
import { requiresCrossIssueInfluenceRunContext } from "../services/cross-issue-influence-limit.js";

describe("requiresCrossIssueInfluenceRunContext", () => {
  it("never requires run context from board actors", () => {
    expect(requiresCrossIssueInfluenceRunContext({ type: "board" })).toBe(false);
  });

  it("requires run ownership from run-bound and JWT agents", () => {
    expect(requiresCrossIssueInfluenceRunContext({
      type: "agent",
      agentId: "agent-1",
      runId: "run-1",
      source: "agent_key",
      onBehalfOfUserId: "user-1",
    })).toBe(false);
  });

  it("treats a header-less agent-key call with a responsible user as an operator command", () => {
    expect(requiresCrossIssueInfluenceRunContext({
      type: "agent",
      agentId: "agent-1",
      runId: null,
      source: "agent_key",
      onBehalfOfUserId: "user-1",
    })).toBe(false);
  });

  it("stays fail-closed without a responsible user behind the key", () => {
    expect(requiresCrossIssueInfluenceRunContext({
      type: "agent",
      agentId: "agent-1",
      runId: null,
      source: "agent_key",
      onBehalfOfUserId: null,
    })).toBe(true);
  });

  it("stays fail-closed for agents without an agent id", () => {
    expect(requiresCrossIssueInfluenceRunContext({ type: "agent", agentId: null })).toBe(true);
  });
});
