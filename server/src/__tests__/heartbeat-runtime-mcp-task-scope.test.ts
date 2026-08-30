import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  toolApplications,
  toolConnectionInstalls,
  toolConnections,
  toolProfiles,
  toolProfileBindings,
  toolProfileEntries,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { buildPaperclipRuntimeMcpIdentity } from "../services/heartbeat.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("heartbeat runtime MCP exact exposure", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-runtime-mcp-scope-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(toolConnectionInstalls);
    await db.delete(toolProfileBindings);
    await db.delete(toolProfileEntries);
    await db.delete(toolProfiles);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function setupEngineer(opts: {
    install: string[];
    permitOnly?: string[];
    taskScoped?: string[];
  }): Promise<{ companyId: string; agentId: string; taskScoped: Set<string> }> {
    const [company] = await db.insert(companies).values({
      name: `Runtime MCP Scope ${randomUUID()}`,
      issuePrefix: `RS${randomUUID().slice(0, 5).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    }).returning();
    const [agent] = await db.insert(agents).values({
      companyId: company!.id,
      name: "Scope Engineer",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning();
    const [application] = await db.insert(toolApplications).values({
      companyId: company!.id,
      applicationKey: `scope-${randomUUID().slice(0, 8)}`,
      name: "Scope App",
      type: "mcp_http",
      status: "active",
    }).returning();

    const names = ["Git", "Playwright", "Cloudflare", "Storybook"];
    const connections: Record<string, { id: string }> = {};
    for (const name of names) {
      const [conn] = await db.insert(toolConnections).values({
        companyId: company!.id,
        applicationId: application!.id,
        name,
        uid: `test/${name.toLowerCase()}-${randomUUID().slice(0, 8)}`,
        transport: "mcp_remote",
        status: "active",
        enabled: true,
        config: { url: `https://${name.toLowerCase()}.example.test/mcp` },
      }).returning();
      connections[name] = conn!;
    }

    const permitted = [...opts.install, ...(opts.permitOnly ?? [])];
    for (const name of permitted) {
      const conn = connections[name];
      const [profile] = await db.insert(toolProfiles).values({
        companyId: company!.id,
        profileKey: `app:${conn.id}`,
        name,
        defaultAction: "deny",
      }).returning();
      await db.insert(toolProfileEntries).values({
        companyId: company!.id,
        profileId: profile!.id,
        selectorType: "connection",
        effect: "include",
        applicationId: application!.id,
        connectionId: conn.id,
      });
      await db.insert(toolProfileBindings).values({
        companyId: company!.id,
        profileId: profile!.id,
        targetType: "agent",
        targetId: agent!.id,
      });
    }
    for (const name of opts.install) {
      const conn = connections[name];
      await db.insert(toolConnectionInstalls).values({
        companyId: company!.id,
        connectionId: conn.id,
        targetType: "agent",
        targetId: agent!.id,
      });
    }

    return {
      companyId: company!.id,
      agentId: agent!.id,
      taskScoped: new Set(opts.taskScoped?.map((n) => connections[n].id) ?? []),
    };
  }

  function namesOf(identity: Array<{ name: string }>): string[] {
    return identity.map((entry) => entry.name).sort();
  }

  it("exposes only the installed Git connection for an Engineer baseline", async () => {
    const { companyId, agentId } = await setupEngineer({ install: ["Git"] });
    const identity = await buildPaperclipRuntimeMcpIdentity({ db, agent: { id: agentId, companyId }, taskScopedConnectionIds: null });
    expect(namesOf(identity)).toEqual(["Git"]);
  });

  it("exposes Git plus a task-scoped Playwright connection, never Cloudflare or Storybook", async () => {
    const { companyId, agentId, taskScoped } = await setupEngineer({
      install: ["Git", "Playwright"],
      permitOnly: ["Cloudflare"],
      taskScoped: ["Playwright"],
    });
    const identity = await buildPaperclipRuntimeMcpIdentity({ db, agent: { id: agentId, companyId }, taskScopedConnectionIds: taskScoped });
    expect(namesOf(identity)).toEqual(["Git", "Playwright"]);
  });

  it("does not expose a permitted-but-not-installed connection (Cloudflare) even when permitted", async () => {
    const { companyId, agentId } = await setupEngineer({ install: ["Git"], permitOnly: ["Cloudflare"] });
    const identity = await buildPaperclipRuntimeMcpIdentity({ db, agent: { id: agentId, companyId }, taskScopedConnectionIds: null });
    expect(namesOf(identity)).toEqual(["Git"]);
    expect(identity.some((entry) => entry.name === "Cloudflare")).toBe(false);
  });
});
