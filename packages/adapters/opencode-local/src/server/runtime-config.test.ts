import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareOpenCodeRuntimeConfig } from "./runtime-config.js";

const cleanupPaths = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...cleanupPaths].map(async (filepath) => {
      await fs.rm(filepath, { recursive: true, force: true });
      cleanupPaths.delete(filepath);
    }),
  );
});

async function makeConfigHome(initialConfig?: Record<string, unknown>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-test-"));
  cleanupPaths.add(root);
  const configDir = path.join(root, "opencode");
  await fs.mkdir(configDir, { recursive: true });
  if (initialConfig) {
    await fs.writeFile(
      path.join(configDir, "opencode.json"),
      `${JSON.stringify(initialConfig, null, 2)}\n`,
      "utf8",
    );
  }
  return root;
}

describe("prepareOpenCodeRuntimeConfig", () => {
  it("injects the per-run paperclip MCP and strips the user paperclip entry from copied jsonc", async () => {
    process.env.MCP_STDIO_CMD = "C:\\Program Files\\nodejs\\node.exe";
    process.env.MCP_STDIO_ARGS = "C:\\tsx\\cli.mjs C:\\mcp\\stdio.ts";
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    await fs.writeFile(
      path.join(configHome, "opencode", "opencode.jsonc"),
      `{\n  "mcp": { "paperclip": { "type": "remote", "url": "https://example.invalid/mcp", "enabled": true } }\n}\n`,
      "utf8",
    );
    try {
      const prepared = await prepareOpenCodeRuntimeConfig({
        env: {
          XDG_CONFIG_HOME: configHome,
          PAPERCLIP_API_KEY: "run-jwt",
          PAPERCLIP_COMPANY_ID: "company-1",
          PAPERCLIP_AGENT_ID: "agent-1",
          PAPERCLIP_RUN_ID: "run-1",
        },
        config: {},
      });
      cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
      const runtimeConfig = JSON.parse(
        await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
      ) as Record<string, unknown>;
      const mcp = runtimeConfig.mcp as Record<string, unknown> | undefined;
      expect(mcp?.paperclip).toBeDefined();
      expect((mcp as Record<string, unknown>)?.servers).toBeUndefined();
      await prepared.cleanup();
    } finally {
      delete process.env.MCP_STDIO_CMD;
      delete process.env.MCP_STDIO_ARGS;
    }
  });

  it("skips the paperclip MCP injection when the run env has no API key", async () => {
    process.env.MCP_STDIO_CMD = "node";
    process.env.MCP_STDIO_ARGS = "stdio.ts";
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    try {
      const prepared = await prepareOpenCodeRuntimeConfig({
        env: { XDG_CONFIG_HOME: configHome },
        config: {},
      });
      cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
      const runtimeConfig = JSON.parse(
        await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
      ) as Record<string, unknown>;
      expect((runtimeConfig.mcp as Record<string, unknown> | undefined)?.paperclip).toBeUndefined();
      expect((runtimeConfig.mcp as Record<string, unknown> | undefined)?.servers).toBeUndefined();
      await prepared.cleanup();
    } finally {
      delete process.env.MCP_STDIO_CMD;
      delete process.env.MCP_STDIO_ARGS;
    }
  });

  it("does not inherit user-level config (theme/permission) by default (curated runtime)", async () => {
    const configHome = await makeConfigHome({
      permission: { read: "allow" },
      theme: "system",
      agent: { foo: "bar" },
    });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    expect(prepared.env.XDG_CONFIG_HOME).not.toBe(configHome);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(runtimeConfig.theme).toBeUndefined();
    expect(runtimeConfig.agent).toBeUndefined();
    expect(runtimeConfig).toMatchObject({ permission: { external_directory: "allow" } });
    expect((runtimeConfig.permission as Record<string, unknown>).read).toBeUndefined();
    await prepared.cleanup();
    cleanupPaths.delete(prepared.env.XDG_CONFIG_HOME);
    await expect(fs.access(prepared.env.XDG_CONFIG_HOME)).rejects.toThrow();
  });

  it("merges custom providers from PAPERCLIP_OPENCODE_PROVIDERS into the config", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const providers = {
      bifrost: {
        npm: "@ai-sdk/openai-compatible",
        name: "Bifrost EU",
        options: { baseURL: "http://gateway.example.svc.cluster.local:8080/v1", apiKey: "{env:ANTHROPIC_API_KEY}" },
        models: { "example/model-a": { name: "Model A" } },
      },
    };
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome, PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify(providers) },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8")) as Record<string, unknown>;
    expect(runtimeConfig).toMatchObject({ permission: { external_directory: "allow" }, provider: providers });
    expect(prepared.notes.some((n) => n.includes("bifrost"))).toBe(true);
    await prepared.cleanup();
  });

  it("reads PAPERCLIP_OPENCODE_PROVIDERS from process.env when absent from the run env", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const providers = { bifrost: { npm: "@ai-sdk/openai-compatible", models: { "example/model-a": {} } } };
    process.env.PAPERCLIP_OPENCODE_PROVIDERS = JSON.stringify(providers);
    try {
      const prepared = await prepareOpenCodeRuntimeConfig({ env: { XDG_CONFIG_HOME: configHome }, config: {} });
      cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
      const runtimeConfig = JSON.parse(await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8")) as Record<string, unknown>;
      expect(runtimeConfig).toMatchObject({ provider: providers });
      await prepared.cleanup();
    } finally { delete process.env.PAPERCLIP_OPENCODE_PROVIDERS; }
  });

  it("expands {env:VAR} placeholders in custom providers using the run/process env (bakes the literal vk)", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const providers = { bifrost: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://bifrost/v1", apiKey: "{env:ANTHROPIC_API_KEY}" }, models: { "example/model-a": {} } } };
    const prepared = await prepareOpenCodeRuntimeConfig({ env: { XDG_CONFIG_HOME: configHome, PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify(providers), ANTHROPIC_API_KEY: "sk-bf-REALVK" }, config: {} });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8")) as { provider: { bifrost: { options: { apiKey: string } } } };
    expect(runtimeConfig.provider.bifrost.options.apiKey).toBe("sk-bf-REALVK");
    await prepared.cleanup();
  });

  it("leaves an unresolvable {env:VAR} placeholder intact", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const providers = { bifrost: { options: { apiKey: "{env:DEFINITELY_UNSET_VAR_XYZ}" }, models: { "x/y": {} } } };
    const prepared = await prepareOpenCodeRuntimeConfig({ env: { XDG_CONFIG_HOME: configHome, PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify(providers) }, config: {} });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8")) as { provider: { bifrost: { options: { apiKey: string } } } };
    expect(runtimeConfig.provider.bifrost.options.apiKey).toBe("{env:DEFINITELY_UNSET_VAR_XYZ}");
    await prepared.cleanup();
  });

  it("pins small_model from PAPERCLIP_OPENCODE_SMALL_MODEL", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const prepared = await prepareOpenCodeRuntimeConfig({ env: { XDG_CONFIG_HOME: configHome, PAPERCLIP_OPENCODE_SMALL_MODEL: "example/model-a" }, config: {} });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8")) as { small_model?: string };
    expect(runtimeConfig.small_model).toBe("example/model-a");
    await prepared.cleanup();
  });

  it("ignores malformed PAPERCLIP_OPENCODE_PROVIDERS without writing a provider block and surfaces a note", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const prepared = await prepareOpenCodeRuntimeConfig({ env: { XDG_CONFIG_HOME: configHome, PAPERCLIP_OPENCODE_PROVIDERS: "not json" }, config: {} });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8")) as Record<string, unknown>;
    expect(runtimeConfig.provider).toBeUndefined();
    expect(prepared.notes).toContain("PAPERCLIP_OPENCODE_PROVIDERS contains invalid JSON; custom providers ignored.");
    await prepared.cleanup();
  });

  it("surfaces a note when PAPERCLIP_OPENCODE_PROVIDERS is valid JSON but not an object", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const prepared = await prepareOpenCodeRuntimeConfig({ env: { XDG_CONFIG_HOME: configHome, PAPERCLIP_OPENCODE_PROVIDERS: "[1,2,3]" }, config: {} });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8")) as Record<string, unknown>;
    expect(runtimeConfig.provider).toBeUndefined();
    expect(prepared.notes).toContain("PAPERCLIP_OPENCODE_PROVIDERS is set but is not a JSON object; custom providers ignored.");
    await prepared.cleanup();
  });

  it("surfaces skipped provider entries with non-object values and keeps the usable ones", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const prepared = await prepareOpenCodeRuntimeConfig({ env: { XDG_CONFIG_HOME: configHome, PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify({ bifrost: "http://gateway.example/v1", usable: { options: { baseURL: "http://gateway.example/v1" } } }) }, config: {} });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8")) as { provider?: Record<string, unknown> };
    expect(runtimeConfig.provider?.usable).toBeDefined();
    expect(runtimeConfig.provider?.bifrost).toBeUndefined();
    expect(prepared.notes).toContain("PAPERCLIP_OPENCODE_PROVIDERS: skipped provider(s) with non-object values: bifrost.");
    await prepared.cleanup();
  });

  it("surfaces skipped provider entries when no usable entries remain", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const prepared = await prepareOpenCodeRuntimeConfig({ env: { XDG_CONFIG_HOME: configHome, PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify({ bifrost: "http://gateway.example/v1" }) }, config: {} });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8")) as Record<string, unknown>;
    expect(runtimeConfig.provider).toBeUndefined();
    expect(prepared.notes).toContain("PAPERCLIP_OPENCODE_PROVIDERS: skipped provider(s) with non-object values: bifrost.");
    await prepared.cleanup();
  });

  it("registers a configured model missing from the catalog on its provider", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const prepared = await prepareOpenCodeRuntimeConfig({ env: { XDG_CONFIG_HOME: configHome }, config: { model: "openrouter/openai/gpt-oss-120b:nitro" } });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8")) as { provider?: Record<string, { models?: Record<string, unknown> }> };
    expect(runtimeConfig.provider?.openrouter?.models).toEqual({ "openai/gpt-oss-120b:nitro": {} });
    expect(prepared.notes).toContain("Registered configured model openrouter/openai/gpt-oss-120b:nitro in the runtime OpenCode config.");
    await prepared.cleanup();
  });

  it("does not clobber an explicit model definition when registering the configured model", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const providers = { openrouter: { models: { "openai/gpt-oss-120b:nitro": { name: "GPT-OSS 120B (nitro)" }, "example/other": {} } } };
    const prepared = await prepareOpenCodeRuntimeConfig({ env: { XDG_CONFIG_HOME: configHome, PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify(providers) }, config: { model: "openrouter/openai/gpt-oss-120b:nitro" } });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8")) as { provider?: Record<string, { models?: Record<string, unknown> }> };
    expect(runtimeConfig.provider?.openrouter?.models).toEqual(providers.openrouter.models);
    expect(prepared.notes.some((note) => note.startsWith("Registered configured model"))).toBe(false);
    await prepared.cleanup();
  });

  it("skips model registration when the configured model is not provider/model shaped", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const prepared = await prepareOpenCodeRuntimeConfig({ env: { XDG_CONFIG_HOME: configHome }, config: { model: "not-a-provider-model" } });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8")) as Record<string, unknown>;
    expect(runtimeConfig.provider).toBeUndefined();
    await prepared.cleanup();
  });

  it("respects explicit opt-out", async () => {
    const configHome = await makeConfigHome();
    const prepared = await prepareOpenCodeRuntimeConfig({ env: { XDG_CONFIG_HOME: configHome }, config: { dangerouslySkipPermissions: false } });
    expect(prepared.env).toEqual({ XDG_CONFIG_HOME: configHome });
    expect(prepared.notes).toEqual(["dangerouslySkipPermissions=false: skipping managed runtime OpenCode config isolation."]);
    await prepared.cleanup();
  });

  it("does NOT inherit a global user MCP server when inheritUserMcp is false (default)", async () => {
    const configHome = await makeConfigHome({ mcp: { servers: { "user-mcp-x": { type: "remote", url: "https://x.example/mcp", enabled: true } } } });
    const prepared = await prepareOpenCodeRuntimeConfig({ env: { XDG_CONFIG_HOME: configHome }, config: {}, runtimeMcpServers: [] });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8")) as { mcp?: Record<string, unknown> };
    expect((runtimeConfig.mcp as Record<string, unknown>)?.["user-mcp-x"]).toBeUndefined();
    expect((runtimeConfig.mcp as Record<string, unknown>)?.servers).toBeUndefined();
    await prepared.cleanup();
  });

  it("does NOT load a global user plugin when inheritUserPlugins is false (default)", async () => {
    const configHome = await makeConfigHome({ plugin: ["some-user-plugin"] });
    const prepared = await prepareOpenCodeRuntimeConfig({ env: { XDG_CONFIG_HOME: configHome }, config: {} });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8")) as Record<string, unknown>;
    expect(runtimeConfig.plugin).toBeUndefined();
    expect(runtimeConfig.plugins).toBeUndefined();
    await prepared.cleanup();
  });

  it("inherits user MCP servers only when inheritUserMcp is explicitly true", async () => {
    const configHome = await makeConfigHome({ mcp: { servers: { "user-mcp-y": { type: "remote", url: "https://y.example/mcp", enabled: true } } } });
    const prepared = await prepareOpenCodeRuntimeConfig({ env: { XDG_CONFIG_HOME: configHome }, config: { inheritUserMcp: true } });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8")) as { mcp?: Record<string, unknown> };
    expect((runtimeConfig.mcp as Record<string, unknown>)?.["user-mcp-y"]).toBeDefined();
    await prepared.cleanup();
  });

  it("keeps exactly one core Paperclip MCP when the user config contains a paperclip MCP", async () => {
    const configHome = await makeConfigHome({ mcp: { servers: { paperclip: { type: "remote", url: "https://paperclip.example/api/mcp", enabled: true }, "user-mcp-z": { type: "remote", url: "https://z.example/mcp", enabled: true } } } });
    const prepared = await prepareOpenCodeRuntimeConfig({ env: { XDG_CONFIG_HOME: configHome }, config: {}, runtimeMcpServers: [] });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8")) as { mcp?: Record<string, unknown> };
    expect((runtimeConfig.mcp as Record<string, unknown>)?.paperclip).toBeDefined();
    expect((runtimeConfig.mcp as Record<string, unknown>)?.["user-mcp-z"]).toBeUndefined();
    expect(Object.keys((runtimeConfig.mcp as Record<string, unknown>) ?? {}).filter((n) => n === "paperclip")).toHaveLength(1);
    await prepared.cleanup();
  });

  it("materializes managed runtimeMcp servers into the curated config", async () => {
    const configHome = await makeConfigHome();
    const prepared = await prepareOpenCodeRuntimeConfig({ env: { XDG_CONFIG_HOME: configHome }, config: {}, runtimeMcpServers: [{ name: "conn-a", url: "https://paperclip.example/api/tool-gateway/gateways/a/mcp", token: "tok-a", connectionId: "a" }, { name: "conn-b", url: "https://paperclip.example/api/tool-gateway/gateways/b/mcp", token: "tok-b", connectionId: "b" }] });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8")) as { mcp?: Record<string, { type: string; url: string; enabled?: boolean; headers?: Record<string, string> }> };
    expect((runtimeConfig.mcp as Record<string, unknown>)?.servers).toBeUndefined();
    expect((runtimeConfig.mcp as Record<string, unknown>)?.["conn-a"]).toMatchObject({ type: "remote", url: "https://paperclip.example/api/tool-gateway/gateways/a/mcp", enabled: true });
    expect((runtimeConfig.mcp as Record<string, unknown> & { "conn-a": { headers?: Record<string, string> } })["conn-a"]?.headers?.Authorization).toBe("Bearer tok-a");
    expect((runtimeConfig.mcp as Record<string, unknown>)?.["conn-b"]).toBeDefined();
    await prepared.cleanup();
  });

  it("does not leak a Connection gateway that is absent from the effective profile via the global config", async () => {
    const configHome = await makeConfigHome({ mcp: { servers: { "leaky-conn-c": { type: "remote", url: "https://c.example/mcp", enabled: true } } } });
    const prepared = await prepareOpenCodeRuntimeConfig({ env: { XDG_CONFIG_HOME: configHome }, config: {}, runtimeMcpServers: [{ name: "conn-a", url: "https://paperclip.example/api/gateways/a/mcp", token: "t", connectionId: "a" }] });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8")) as { mcp?: Record<string, unknown> };
    expect((runtimeConfig.mcp as Record<string, unknown>)?.["leaky-conn-c"]).toBeUndefined();
    await prepared.cleanup();
  });

  it("preserves provider/model wiring (opencode-go/hy3) after sanitization", async () => {
    const configHome = await makeConfigHome();
    const providers = { "opencode-go": { npm: "@ai-sdk/openai-compatible", models: { hy3: {} } } };
    const prepared = await prepareOpenCodeRuntimeConfig({ env: { XDG_CONFIG_HOME: configHome, PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify(providers) }, config: { model: "opencode-go/hy3" } });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8")) as { provider?: Record<string, { models?: Record<string, unknown> }> };
    expect(runtimeConfig.provider?.["opencode-go"]?.models).toHaveProperty("hy3");
    expect((runtimeConfig.provider as Record<string, unknown>)?.opencode).toBeUndefined();
    await prepared.cleanup();
  });

  it("canonical hy3 model opencode-go/hy3 registers as provider opencode-go / model hy3 (regression)", async () => {
    const configHome = await makeConfigHome();
    const prepared = await prepareOpenCodeRuntimeConfig({ env: { XDG_CONFIG_HOME: configHome }, config: { model: "opencode-go/hy3" } });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8")) as { provider?: Record<string, { models?: Record<string, unknown> }> };
    expect(runtimeConfig.provider?.["opencode-go"]?.models).toHaveProperty("hy3");
    expect((runtimeConfig.provider as Record<string, unknown>)?.opencode).toBeUndefined();
    const models = (runtimeConfig.provider?.["opencode-go"]?.models ?? {}) as Record<string, unknown>;
    expect(models["go/hy3"]).toBeUndefined();
    await prepared.cleanup();
  });

  it("inherits user plugins only when inheritUserPlugins is explicitly true", async () => {
    const configHome = await makeConfigHome({ plugin: ["some-user-plugin"] });
    const prepared = await prepareOpenCodeRuntimeConfig({ env: { XDG_CONFIG_HOME: configHome }, config: { inheritUserPlugins: true, inheritUserOpenCodeConfig: true } });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8")) as Record<string, unknown>;
    expect(runtimeConfig.plugin).toEqual(["some-user-plugin"]);
    await prepared.cleanup();
  });

  it("does not duplicate a managed Connection that also exists in global user MCP (git duplicate)", async () => {
    const configHome = await makeConfigHome({ mcp: { servers: { git: { type: "remote", url: "https://user.example/git/mcp", enabled: true } } } });
    const prepared = await prepareOpenCodeRuntimeConfig({ env: { XDG_CONFIG_HOME: configHome }, config: {}, runtimeMcpServers: [{ name: "git", url: "https://paperclip.example/api/gateways/git/mcp", token: "tok-git", connectionId: "git" }] });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8")) as { mcp?: Record<string, unknown> };
    expect((runtimeConfig.mcp as Record<string, unknown>)?.git).toMatchObject({ url: "https://paperclip.example/api/gateways/git/mcp" });
    expect(Object.keys((runtimeConfig.mcp as Record<string, unknown>) ?? {}).filter((n) => n === "git")).toHaveLength(1);
    await prepared.cleanup();
  });

  it("user paperclip MCP does not replace the managed core Paperclip MCP even with inheritUserMcp=true", async () => {
    const configHome = await makeConfigHome({ mcp: { servers: { paperclip: { type: "remote", url: "https://user.example/paperclip/mcp", enabled: true } } } });
    const prepared = await prepareOpenCodeRuntimeConfig({ env: { XDG_CONFIG_HOME: configHome }, config: { inheritUserMcp: true }, runtimeMcpServers: [] });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8")) as { mcp?: Record<string, unknown> };
    expect((runtimeConfig.mcp as Record<string, unknown>)?.paperclip).toBeDefined();
    expect(Object.keys((runtimeConfig.mcp as Record<string, unknown>) ?? {}).filter((n) => n === "paperclip")).toHaveLength(1);
    await prepared.cleanup();
  });

  it("diagnostics expose mcp counts but never tokens or Authorization headers", async () => {
    const configHome = await makeConfigHome({ mcp: { servers: { paperclip: { type: "remote", url: "https://paperclip.example/api/mcp", enabled: true } } } });
    let captured: unknown = null;
    const prepared = await prepareOpenCodeRuntimeConfig({ env: { XDG_CONFIG_HOME: configHome }, config: {}, runtimeMcpServers: [{ name: "conn-a", url: "https://paperclip.example/api/gateways/a/mcp", token: "SUPER-SECRET", connectionId: "a" }], diagnosticsSink: (d) => { captured = d; } });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    expect(captured).not.toBeNull();
    const diag = captured as { mcp: { paperclipCoreCount: number; managedConnectionCount: number; serverNames: Array<{ name: string; source: string }> } };
    expect(diag.mcp.paperclipCoreCount).toBe(1);
    expect(diag.mcp.managedConnectionCount).toBe(1);
    expect(JSON.stringify(diag)).not.toContain("SUPER-SECRET");
    expect(JSON.stringify(diag)).not.toContain("Authorization");
    expect(JSON.stringify(diag)).not.toContain("Bearer");
    await prepared.cleanup();
  });

  it("emits flat mcp shape without servers key and maps managed gateways to remote with enabled", async () => {
    const configHome = await makeConfigHome();
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: {},
      paperclipCoreMcp: { name: "paperclip", url: "https://paperclip.example/mcp", token: "tok-core" },
      runtimeMcpServers: [
        { name: "Git", url: "https://git.example/mcp", token: "tok-git", connectionId: "git" },
        { name: "Playwright", url: "https://pw.example/mcp", token: "tok-pw", connectionId: "pw" },
      ],
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8")) as { mcp?: Record<string, unknown> };
    expect((runtimeConfig.mcp as Record<string, unknown>)?.servers).toBeUndefined();
    expect((runtimeConfig.mcp as Record<string, { type: string; enabled: boolean; url: string }>)?.Git).toMatchObject({ type: "remote", enabled: true, url: "https://git.example/mcp" });
    expect((runtimeConfig.mcp as Record<string, { type: string; enabled: boolean }>)?.Playwright?.type).toBe("remote");
    expect((runtimeConfig.mcp as Record<string, { type: string; enabled: boolean }>)?.paperclip?.type).toBe("remote");
    expect((runtimeConfig.mcp as Record<string, { headers: Record<string,string> }>)?.Git.headers.Authorization).toBe("Bearer tok-git");
    await prepared.cleanup();
  });

  it("local core paperclip via stdio is exactly one local server", async () => {
    process.env.MCP_STDIO_CMD = "node";
    process.env.MCP_STDIO_ARGS = "stdio.ts";
    const configHome = await makeConfigHome();
    try {
      const prepared = await prepareOpenCodeRuntimeConfig({
        env: { XDG_CONFIG_HOME: configHome, PAPERCLIP_API_KEY: "run-key", PAPERCLIP_API_URL: "http://127.0.0.1:3100" },
        config: {},
      });
      cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
      const runtimeConfig = JSON.parse(await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8")) as { mcp?: Record<string, { type: string; command?: string[]; enabled?: boolean }> };
      expect((runtimeConfig.mcp as Record<string, unknown>)?.servers).toBeUndefined();
      const paperclip = (runtimeConfig.mcp as Record<string, { type: string; enabled: boolean }>)?.paperclip;
      expect(paperclip?.type).toBe("local");
      expect(paperclip?.enabled).toBe(true);
      expect(Object.keys((runtimeConfig.mcp as Record<string, unknown>) ?? {}).filter((k) => k === "paperclip")).toHaveLength(1);
      await prepared.cleanup();
    } finally { delete process.env.MCP_STDIO_CMD; delete process.env.MCP_STDIO_ARGS; }
  });

  it("dedupes managed Git over inherited user Git", async () => {
    const configHome = await makeConfigHome({ mcp: { Git: { type: "remote", url: "https://user.example/git/mcp", enabled: true } } });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: { inheritUserMcp: true },
      runtimeMcpServers: [{ name: "Git", url: "https://managed.example/git/mcp", token: "managed-tok", connectionId: "git" }],
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8")) as { mcp?: Record<string, { url: string }> };
    expect((runtimeConfig.mcp as Record<string, { url: string }>)?.Git.url).toBe("https://managed.example/git/mcp");
    expect(Object.keys((runtimeConfig.mcp as Record<string, unknown>) ?? {}).filter((k) => k === "Git")).toHaveLength(1);
    await prepared.cleanup();
  });
});
