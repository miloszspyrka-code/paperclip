import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  companies,
  createDb,
  toolConnections,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { toolAccessService } from "../services/tool-access.js";

// Live end-to-end check against the real Sender MCP OAuth endpoints
// (https://mcp.sender.net + https://auth.sender.net). Runs only when
// LIVE_OAUTH_TEST=1 is set; skipped in the normal test suite. Performs real
// discovery, real Dynamic Client Registration, and returns the real
// authorization URL. No browser consent is performed here.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeLive = process.env.LIVE_OAUTH_TEST === "1"
  ? (embeddedPostgresSupport.supported ? describe : describe.skip)
  : describe.skip;

const REDIRECT_URI = "https://paperclip.kompaszbiorek.pl/api/tools/oauth/callback";

describeLive("Sender MCP live OAuth (BYO link)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tool-oauth-live-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("discovers Sender OAuth, registers a dynamic client and builds the authorization URL", async () => {
    const company = await db.insert(companies).values({
      name: `Sender Live ${randomUUID()}`,
      issuePrefix: `SL${randomUUID().slice(0, 6).toUpperCase()}`,
    }).returning().then((rows) => rows[0]!);

    let registerCalls = 0;
    const originalFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
      if (String(args[0]).endsWith("/oauth/register")) registerCalls += 1;
      return originalFetch(...args);
    });

    const service = toolAccessService(db);
    const connect = await service.connectGalleryApp(company.id, {
      link: "https://mcp.sender.net/mcp",
      name: `Sender Live ${randomUUID().slice(0, 6)}`,
    });

    expect(connect.auth?.kind).toBe("oauth");

    const start = await service.startOAuth(company.id, connect.connectionId, {
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board" },
    });

    const url = new URL(start.authorizationUrl);
    expect(`${url.origin}${url.pathname}`).toBe("https://auth.sender.net/oauth/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBeTruthy();
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(url.searchParams.get("scope")).toBe("mcp:use");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(registerCalls).toBe(1);

    const [row] = await db.select().from(toolConnections).where(eq(toolConnections.id, connect.connectionId));
    expect(row).toMatchObject({ ownership: "dcr" });
    expect(row.config).toMatchObject({
      oauth: {
        provider: "mcp_sender_net",
        clientId: expect.any(String),
        clientRegistrationSource: "dcr",
        clientRedirectUri: REDIRECT_URI,
        registrationUrl: "https://auth.sender.net/oauth/register",
        tokenUrl: "https://auth.sender.net/oauth/token",
        authorizationUrl: "https://auth.sender.net/oauth/authorize",
      },
    });
    expect(JSON.stringify(row.config)).not.toContain("secret");

    registerCalls = 0;
    const reused = await service.startOAuth(company.id, connect.connectionId, {
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board" },
    });
    expect(new URL(reused.authorizationUrl).searchParams.get("client_id"))
      .toBe(url.searchParams.get("client_id"));
    expect(registerCalls).toBe(0);

    console.log("SENDER AUTHORIZATION URL:", reused.authorizationUrl);
  });
});
