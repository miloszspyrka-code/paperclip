import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareOpenCodeRuntimeConfig } from "./runtime-config.js";

const cleanupRoots = new Set<string>();

afterEach(async () => {
  await Promise.all([...cleanupRoots].map(async (root) => {
    await fs.rm(root, { recursive: true, force: true });
    cleanupRoots.delete(root);
  }));
});

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-runtime-test-"));
  cleanupRoots.add(root);
  const host = path.join(root, "host");
  const runtime = path.join(root, "runtime");
  const hostAuth = path.join(host, "auth.json");
  await fs.mkdir(path.join(host, "agents"), { recursive: true });
  await fs.mkdir(path.join(host, "commands"), { recursive: true });
  await fs.mkdir(path.join(host, "skills"), { recursive: true });
  await fs.mkdir(path.join(host, "plugins"), { recursive: true });
  await fs.writeFile(
    path.join(host, "opencode.json"),
    JSON.stringify({
      mcp: {
        HOST_PRIVATE_SENDER: { type: "remote", url: "https://sender.invalid/mcp" },
        HOST_PRIVATE_CLOUDFLARE: { type: "remote", url: "https://cloudflare.invalid/mcp" },
        HOST_PRIVATE_OBSIDIAN: { type: "remote", url: "https://obsidian.invalid/mcp" },
      },
      plugin: ["HOST_PRIVATE_PLUGIN_A", "HOST_PRIVATE_PLUGIN_B"],
    }),
    "utf8",
  );
  await fs.writeFile(hostAuth, JSON.stringify({
    "opencode-go": { type: "api", key: "FAKE_PROVIDER_SECRET" },
    openai: { type: "api", key: "FAKE_OTHER_SECRET" },
  }), "utf8");
  return { root, host, runtime, hostAuth };
}

async function readGeneratedConfig(configHome: string) {
  return JSON.parse(await fs.readFile(path.join(configHome, "opencode", "opencode.json"), "utf8")) as Record<string, any>;
}

describe("prepareOpenCodeRuntimeConfig", () => {
  it("builds from scratch without copying host MCP, plugins, or directories", async () => {
    const fixture = await makeFixture();
    const hostConfig = path.join(fixture.host, "opencode.json");
    const beforeHash = (await fs.readFile(hostConfig, "utf8"));
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: {
        PAPERCLIP_OPENCODE_RUNTIME_ROOT: fixture.runtime,
        PAPERCLIP_AGENT_ID: "agent-a",
        PAPERCLIP_RUN_ID: "run-a",
      },
      config: {},
      hostAuthFile: fixture.hostAuth,
    });
    const config = await readGeneratedConfig(prepared.paths.configHome);

    expect(config.mcp).toBeUndefined();
    expect(config.plugin).toBeUndefined();
    expect(Object.keys(config.command)).toEqual([
      "paperclip-debug-run",
      "paperclip-napraw-tools",
      "paperclip-opencode-health",
      "paperclip-deleguj-coo",
      "paperclip-wdroz-runtime",
    ]);
    expect(config.command["paperclip-debug-run"].template).toContain("$ARGUMENTS");
    expect(config.command["paperclip-debug-run"].template).not.toContain("FAILURE_LAYER");
    expect(JSON.stringify(config)).not.toContain("HOST_PRIVATE_");
    expect(await fs.readFile(hostConfig, "utf8")).toBe(beforeHash);
    await expect(fs.access(path.join(prepared.paths.configHome, "agents"))).rejects.toThrow();
    await prepared.cleanup();
  });

  it("isolates config, data, cache and state per Paperclip runtime", async () => {
    const fixture = await makeFixture();
    const first = await prepareOpenCodeRuntimeConfig({
      env: {
        PAPERCLIP_OPENCODE_RUNTIME_ROOT: fixture.runtime,
        PAPERCLIP_AGENT_ID: "agent-a",
        PAPERCLIP_RUN_ID: "run-a",
      },
      config: {},
      hostAuthFile: fixture.hostAuth,
    });
    const second = await prepareOpenCodeRuntimeConfig({
      env: {
        PAPERCLIP_OPENCODE_RUNTIME_ROOT: fixture.runtime,
        PAPERCLIP_AGENT_ID: "agent-b",
        PAPERCLIP_RUN_ID: "run-b",
      },
      config: {},
      hostAuthFile: fixture.hostAuth,
    });

    expect(first.env.XDG_CONFIG_HOME).toBe(first.paths.configHome);
    expect(first.env.XDG_DATA_HOME).toBe(first.paths.dataHome);
    expect(first.env.XDG_CACHE_HOME).toBe(first.paths.cacheHome);
    expect(first.env.XDG_STATE_HOME).toBe(first.paths.stateHome);
    expect(first.paths.dataHome).not.toBe(second.paths.dataHome);
    expect(first.paths.configHome).not.toBe(second.paths.configHome);
    expect(first.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("true");
    expect(first.env.OPENCODE_DISABLE_EXTERNAL_SKILLS).toBe("1");
    await first.cleanup();
    await second.cleanup();
  });

  it("injects only managed Paperclip Connection gateways", async () => {
    const fixture = await makeFixture();
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: {
        PAPERCLIP_OPENCODE_RUNTIME_ROOT: fixture.runtime,
        PAPERCLIP_AGENT_ID: "agent-a",
        PAPERCLIP_RUN_ID: "run-a",
      },
      config: {},
      runtimeMcpServers: [
        { name: "Sender", url: "https://paperclip.invalid/sender/mcp", token: "FAKE_SENDER_TOKEN", connectionId: "sender" },
        { name: "Cloudflare", url: "https://paperclip.invalid/cloudflare/mcp", token: "FAKE_CF_TOKEN", connectionId: "cloudflare" },
      ],
      hostAuthFile: fixture.hostAuth,
    });
    const config = await readGeneratedConfig(prepared.paths.configHome);
    expect(Object.keys(config.mcp)).toEqual(["Sender", "Cloudflare"]);
    expect(config.mcp.Sender.headers.Authorization).toBe("Bearer FAKE_SENDER_TOKEN");
    expect(config.mcp.HOST_PRIVATE_SENDER).toBeUndefined();
    expect(prepared.diagnostics.mcp.inheritedUserMcpCount).toBe(0);
    // Context-cost telemetry: exact server names/count and serialized managed
    // config size; no secrets in the diagnostics payload.
    expect(prepared.diagnostics.mcp.managedConnectionCount).toBe(2);
    expect(prepared.diagnostics.mcp.serverNames.map((s) => s.name)).toEqual(["Sender", "Cloudflare"]);
    expect(prepared.diagnostics.mcp.managedConnectionConfigChars).toBe(JSON.stringify(config.mcp).length);
    expect(JSON.stringify(prepared.diagnostics)).not.toContain("FAKE_SENDER_TOKEN");
    // OpenCode does not expose the registered tool inventory pre-run.
    expect(prepared.diagnostics.tools.measurement).toBe("not_exposed");
    expect(prepared.diagnostics.tools.registeredToolCount).toBe("NOT_EXPOSED");
    await prepared.cleanup();
  });

  it("injects only ctb-* agents from the explicit deployment source", async () => {
    const fixture = await makeFixture();
    const nativeAgentsSource = path.join(fixture.root, "native-agents.json");
    await fs.writeFile(nativeAgentsSource, JSON.stringify({
      agent: {
        "ctb-plan": { mode: "all", permission: { bash: "deny" } },
        "ctb-engineer": { mode: "all", permission: { "git_*": "allow" } },
        "not-ctb": { mode: "all", permission: { bash: "allow" } },
        "ctb-invalid": ["not-an-agent-definition"],
      },
    }), "utf8");
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: {
        PAPERCLIP_OPENCODE_RUNTIME_ROOT: fixture.runtime,
        PAPERCLIP_AGENT_ID: "agent-a",
        PAPERCLIP_RUN_ID: "run-a",
        PAPERCLIP_OPENCODE_NATIVE_AGENTS_CONFIG: nativeAgentsSource,
      },
      config: {},
      hostAuthFile: fixture.hostAuth,
    });
    const config = await readGeneratedConfig(prepared.paths.configHome);

    expect(Object.keys(config.agent)).toEqual(["ctb-plan", "ctb-engineer"]);
    expect(config.agent["not-ctb"]).toBeUndefined();
    expect(prepared.notes.join("\n")).toContain("Injected 2 native CTB agent definition(s)");
    await prepared.cleanup();
  });

  it("loads only the explicit plugin allowlist", async () => {
    const fixture = await makeFixture();
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: {
        PAPERCLIP_OPENCODE_RUNTIME_ROOT: fixture.runtime,
        PAPERCLIP_AGENT_ID: "agent-a",
        PAPERCLIP_RUN_ID: "run-a",
      },
      config: { opencodeRuntimePlugins: ["openslimedit@1.0.1", "openslimedit@1.0.1"] },
      hostAuthFile: fixture.hostAuth,
    });
    const config = await readGeneratedConfig(prepared.paths.configHome);
    expect(config.plugin).toHaveLength(1);
    expect(config.plugin[0]).toContain("openslimedit@1.0.1");
    expect(JSON.stringify(config)).not.toContain("HOST_PRIVATE_PLUGIN");
    expect(prepared.diagnostics.plugins).toEqual({ allowlistedPluginCount: 1, inheritedPluginCount: 0 });
    await prepared.cleanup();
  });

  it("copies only the configured provider auth record into agent data", async () => {
    const fixture = await makeFixture();
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: {
        PAPERCLIP_OPENCODE_RUNTIME_ROOT: fixture.runtime,
        PAPERCLIP_AGENT_ID: "agent-a",
        PAPERCLIP_RUN_ID: "run-a",
      },
      config: { model: "opencode-go/hy3" },
      hostAuthFile: fixture.hostAuth,
    });
    const auth = JSON.parse(await fs.readFile(prepared.paths.authFile, "utf8")) as Record<string, unknown>;
    expect(Object.keys(auth)).toEqual(["opencode-go"]);
    expect(auth["opencode-go"]).toEqual({ type: "api", key: "FAKE_PROVIDER_SECRET" });
    await prepared.cleanup();
  });

  it("materializes Paperclip skills under isolated config instead of host Claude skills", async () => {
    const fixture = await makeFixture();
    const skillSource = path.join(fixture.root, "skill-source");
    await fs.mkdir(skillSource, { recursive: true });
    await fs.writeFile(path.join(skillSource, "SKILL.md"), "---\nname: fixture\ndescription: fixture\n---\n", "utf8");
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: {
        PAPERCLIP_OPENCODE_RUNTIME_ROOT: fixture.runtime,
        PAPERCLIP_AGENT_ID: "agent-a",
        PAPERCLIP_RUN_ID: "run-a",
      },
      config: {},
      runtimeSkills: [{ runtimeName: "fixture", source: skillSource }],
      hostAuthFile: fixture.hostAuth,
    });
    expect(await fs.readFile(path.join(prepared.paths.configHome, "opencode", "skills", "fixture", "SKILL.md"), "utf8")).toContain("name: fixture");
    expect(prepared.env.XDG_CONFIG_HOME).not.toContain(".claude");
    await prepared.cleanup();
  });

  it("does not delete persistent agent data when a run is cleaned up", async () => {
    const fixture = await makeFixture();
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: {
        PAPERCLIP_OPENCODE_RUNTIME_ROOT: fixture.runtime,
        PAPERCLIP_AGENT_ID: "agent-a",
        PAPERCLIP_RUN_ID: "run-a",
      },
      config: {},
      hostAuthFile: fixture.hostAuth,
    });
    await fs.writeFile(path.join(prepared.paths.dataHome, "session-marker"), "persistent", "utf8");
    const tmpRun = path.dirname(prepared.paths.configHome);
    await prepared.cleanup();
    expect(await fs.readFile(path.join(prepared.paths.dataHome, "session-marker"), "utf8")).toBe("persistent");
    await expect(fs.access(tmpRun)).rejects.toThrow();
  });
});
