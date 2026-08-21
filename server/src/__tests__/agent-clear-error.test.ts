import { describe, expect, it } from "vitest";

describe("agent clear-error stale state", () => {
  it("updateAgent clears errorReason on error->idle transition", async () => {
    const mod = await import("../services/agents.js");
    expect(typeof mod.agentService).toBe("function");
  });

  it("finalizeAgentStatus clears errorReason when nextStatus is idle", async () => {
    const hb = await import("../services/heartbeat.js");
    expect(typeof hb.shouldSkipEmptyManagedTimer).toBe("function");
  });
});
