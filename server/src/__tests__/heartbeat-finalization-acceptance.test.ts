import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  agentWakeupRequests,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Acceptance run completed.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// Each test gets a fully isolated embedded Postgres cluster. afterEach disposes
// the whole cluster, so no per-table FK cleanup is needed and the fixture stays
// isolated regardless of which child rows the heartbeat service writes.
describeEmbeddedPostgres("heartbeat run finalization acceptance", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeEach(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-finalization-accept-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    mockAdapterExecute.mockClear();
    if (tempDb) {
      const closed = tempDb;
      tempDb = null;
      await closed.cleanup();
    }
  });

  async function seedQueuedRun() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const now = new Date("2026-03-19T00:00:00.000Z");
    await db.insert(companies).values({
      id: companyId,
      name: "Finalization Acceptance",
      issuePrefix: `FA${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Acceptance Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: {},
      status: "claimed",
      runId,
      claimedAt: now,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: {},
      startedAt: now,
      updatedAt: now,
    });
    return { companyId, agentId, runId };
  }

  async function waitForSettled(runId: string, timeoutMs = 8_000) {
    const deadline = Date.now() + timeoutMs;
    const readRun = () =>
      db
        .select({ status: heartbeatRuns.status, error: heartbeatRuns.error })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
    while (Date.now() < deadline) {
      const run = await readRun();
      if (!run || (run.status !== "queued" && run.status !== "running" && run.status !== "finalizing")) {
        return run;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return readRun();
  }

  it("invokes the model exactly once across a productive run and reaches a terminal state", async () => {
    const { runId } = await seedQueuedRun();
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();
    const settled = await waitForSettled(runId);

    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
    expect(settled?.status).not.toBe("finalizing");
    expect(["succeeded", "failed", "interrupted", "cancelled", "timed_out"]).toContain(settled?.status);
  });

  it("never re-invokes the model if finalization were to retry (throw on second call)", async () => {
    const { runId } = await seedQueuedRun();
    mockAdapterExecute
      .mockImplementationOnce(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Acceptance run completed.",
        provider: "test",
        model: "test-model",
      }))
      .mockImplementationOnce(() => {
        throw new Error("MODEL_REINVOKED_DURING_FINALIZATION");
      });
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();
    const settled = await waitForSettled(runId);

    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
    expect(settled?.status).not.toBe("finalizing");
    if (settled?.error) expect(settled.error).not.toContain("MODEL_REINVOKED_DURING_FINALIZATION");
  });

  it("reconciles a finalizing run to terminal without invoking the model", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const now = new Date("2026-03-19T00:00:00.000Z");
    await db.insert(companies).values({
      id: companyId,
      name: "Reconcile Acceptance",
      issuePrefix: `RA${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Reconcile Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "finalizing",
      contextSnapshot: {},
      startedAt: now,
      finishedAt: now,
      updatedAt: now,
      resultJson: { paperclipFinalize: { terminalStatus: "succeeded" } },
    });

    const heartbeat = heartbeatService(db);
    mockAdapterExecute.mockClear();

    const result = await heartbeat.reconcileFinalizingRuns();

    expect(result.terminalized).toContain(runId);
    const run = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(run?.status).toBe("succeeded");
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });
});
