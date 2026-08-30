import { describe, expect, it } from "vitest";
import {
  HEARTBEAT_RUN_FINALIZATION_FAILED_ERROR_CODE,
  isHeartbeatRunFinalizingStatus,
  isHeartbeatRunTerminalStatus,
  mergePaperclipFinalize,
  resolveExposedRuntimeMcpConnections,
  sanitizePersistedText,
  type RuntimeMcpCandidateConnection,
} from "../services/heartbeat.js";
import type { ToolProfileEffectiveSummary } from "@paperclipai/shared";

function effectiveWith(entries: Array<{ connectionId: string }>): ToolProfileEffectiveSummary {
  return {
    agentId: "agent-1",
    profiles: [],
    entries: entries.map((e) => ({
      effect: "include",
      connectionId: e.connectionId,
      selectorType: "connection",
      toolName: null,
      applicationId: null,
      catalogEntryId: null,
      riskLevel: null,
      conditions: null,
    })) as ToolProfileEffectiveSummary["entries"],
    bindings: [],
    allowedTools: [],
    allowedToolNames: [],
    installedConnections: [],
  } as unknown as ToolProfileEffectiveSummary;
}

const connection = (id: string, name: string): RuntimeMcpCandidateConnection => ({
  id,
  name,
  transport: "mcp_remote",
  status: "active",
  enabled: true,
});

describe("sanitizePersistedText", () => {
  it("strips lone UTF-16 surrogates while preserving valid pairs", () => {
    expect(sanitizePersistedText("a\uD800b")).toBe("ab");
    expect(sanitizePersistedText("c\uDC00d")).toBe("cd");
    expect(sanitizePersistedText("\uD83D\uDE00")).toBe("\uD83D\uDE00");
  });

  it("preserves valid Polish and mixed Unicode", () => {
    const polish = "Zażółć gęślą jaźń — raz, dwa, trzy.";
    expect(sanitizePersistedText(polish)).toBe(polish);
  });

  it("drops runs of consecutive lone surrogates", () => {
    expect(sanitizePersistedText("x\uD800\uD800\uD800y")).toBe("xy");
  });
});

describe("resolveExposedRuntimeMcpConnections", () => {
  it("exposes installed+permitted, flags permitted-only as on-demand, and honors task scope", () => {
    const effective = effectiveWith([
      { connectionId: "git" },
      { connectionId: "slack" },
      { connectionId: "playwright" },
    ]);
    effective.installedConnections = [
      { id: "git", name: "Git" } as never,
      { id: "secret", name: "Secret" } as never,
    ];
    const candidateConnections: RuntimeMcpCandidateConnection[] = [
      connection("git", "Git"),
      connection("slack", "Slack"),
      connection("playwright", "Playwright"),
      connection("secret", "Secret"),
    ];

    const decisions = resolveExposedRuntimeMcpConnections({
      effective,
      candidateConnections,
      taskScopedConnectionIds: new Set(["playwright"]),
    });
    const byId = new Map(decisions.map((d) => [d.connectionId, d]));

    expect(byId.get("git")).toMatchObject({
      permitted: true,
      installedEveryRun: true,
      exposedThisExecution: true,
      activationSource: "installed",
    });
    expect(byId.get("slack")).toMatchObject({
      permitted: true,
      installedEveryRun: false,
      availableOnDemand: true,
      exposedThisExecution: false,
      activationSource: "profile_permitted_only",
    });
    expect(byId.get("playwright")).toMatchObject({
      permitted: true,
      installedEveryRun: false,
      taskScoped: true,
      exposedThisExecution: true,
      activationSource: "task_scoped",
    });
    expect(byId.get("secret")).toMatchObject({
      permitted: false,
      installedEveryRun: true,
      exposedThisExecution: false,
    });
  });

  it("never exposes a non-eligible connection (inactive/disabled/non-remote)", () => {
    const effective = effectiveWith([{ connectionId: "broken" }]);
    effective.installedConnections = [{ id: "broken", name: "Broken" } as never];
    const candidateConnections: RuntimeMcpCandidateConnection[] = [
      { id: "broken", name: "Broken", transport: "local_stdio", status: "active", enabled: true },
      { id: "broken2", name: "Broken2", transport: "mcp_remote", status: "disabled", enabled: true },
      { id: "broken3", name: "Broken3", transport: "mcp_remote", status: "active", enabled: false },
    ];
    const decisions = resolveExposedRuntimeMcpConnections({ effective, candidateConnections });
    expect(decisions.every((d) => d.exposedThisExecution === false)).toBe(true);
  });
});

describe("run finalization classification", () => {
  it("keeps finalization_failed distinct from adapter_failed", () => {
    expect(HEARTBEAT_RUN_FINALIZATION_FAILED_ERROR_CODE).toBe("finalization_failed");
    expect(HEARTBEAT_RUN_FINALIZATION_FAILED_ERROR_CODE).not.toBe("adapter_failed");
  });

  it("classifies terminal and finalizing statuses without overlap", () => {
    expect(isHeartbeatRunTerminalStatus("succeeded")).toBe(true);
    expect(isHeartbeatRunTerminalStatus("failed")).toBe(true);
    expect(isHeartbeatRunTerminalStatus("finalizing")).toBe(false);
    expect(isHeartbeatRunFinalizingStatus("finalizing")).toBe(true);
    expect(isHeartbeatRunFinalizingStatus("succeeded")).toBe(false);
  });

  it("merges the paperclipFinalize marker with the adapter result", () => {
    const merged = mergePaperclipFinalize({ summary: "done" }, "succeeded", null);
    expect(merged).toMatchObject({
      summary: "done",
      paperclipFinalize: { terminalStatus: "succeeded", finalizationErrorCode: null },
    });
    const failedMerge = mergePaperclipFinalize(null, "failed", HEARTBEAT_RUN_FINALIZATION_FAILED_ERROR_CODE);
    expect(failedMerge).toMatchObject({
      paperclipFinalize: { terminalStatus: "failed", finalizationErrorCode: "finalization_failed" },
    });
  });
});
