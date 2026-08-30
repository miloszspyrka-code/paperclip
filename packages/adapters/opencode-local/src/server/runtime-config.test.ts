import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyOpenCodeEagerMinimalMcpSurface,
  prepareOpenCodeRuntimeConfig,
  resolveOpenCodeEagerMcpScope,
} from "./runtime-config.js";

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
  it("injects an external_directory allow rule by default", async () => {
    const configHome = await makeConfigHome({
      permission: {
        read: "allow",
      },
      theme: "system",
    });

    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);

    expect(prepared.env.XDG_CONFIG_HOME).not.toBe(configHome);
    const runtimeConfig = JSON.parse(
      await fs.readFile(
        path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(runtimeConfig).toMatchObject({
      theme: "system",
      permission: {
        read: "allow",
        external_directory: "allow",
      },
    });

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
        options: {
          baseURL: "http://gateway.example.svc.cluster.local:8080/v1",
          apiKey: "{env:ANTHROPIC_API_KEY}",
        },
        models: { "example/model-a": { name: "Model A" } },
      },
    };

    const prepared = await prepareOpenCodeRuntimeConfig({
      env: {
        XDG_CONFIG_HOME: configHome,
        PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify(providers),
      },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);

    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(runtimeConfig).toMatchObject({
      permission: { read: "allow", external_directory: "allow" },
      provider: providers,
    });
    expect(prepared.notes.some((n) => n.includes("bifrost"))).toBe(true);
    await prepared.cleanup();
  });

  it("reads PAPERCLIP_OPENCODE_PROVIDERS from process.env when absent from the run env", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const providers = { bifrost: { npm: "@ai-sdk/openai-compatible", models: { "example/model-a": {} } } };
    process.env.PAPERCLIP_OPENCODE_PROVIDERS = JSON.stringify(providers);
    try {
      const prepared = await prepareOpenCodeRuntimeConfig({
        env: { XDG_CONFIG_HOME: configHome },
        config: {},
      });
      cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
      const runtimeConfig = JSON.parse(
        await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(runtimeConfig).toMatchObject({ provider: providers });
      await prepared.cleanup();
    } finally {
      delete process.env.PAPERCLIP_OPENCODE_PROVIDERS;
    }
  });

  it("expands {env:VAR} placeholders in custom providers using the run/process env (bakes the literal vk)", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const providers = {
      bifrost: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "http://bifrost/v1", apiKey: "{env:ANTHROPIC_API_KEY}" },
        models: { "example/model-a": {} },
      },
    };
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome, PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify(providers), ANTHROPIC_API_KEY: "sk-bf-REALVK" },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as { provider: { bifrost: { options: { apiKey: string } } } };
    // The {env:...} placeholder must be replaced with the literal value, so OpenCode
    // does not depend on its sandboxed process env carrying the key.
    expect(runtimeConfig.provider.bifrost.options.apiKey).toBe("sk-bf-REALVK");
    await prepared.cleanup();
  });

  it("leaves an unresolvable {env:VAR} placeholder intact", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const providers = { bifrost: { options: { apiKey: "{env:DEFINITELY_UNSET_VAR_XYZ}" }, models: { "x/y": {} } } };
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome, PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify(providers) },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as { provider: { bifrost: { options: { apiKey: string } } } };
    expect(runtimeConfig.provider.bifrost.options.apiKey).toBe("{env:DEFINITELY_UNSET_VAR_XYZ}");
    await prepared.cleanup();
  });

  it("pins small_model from PAPERCLIP_OPENCODE_SMALL_MODEL", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome, PAPERCLIP_OPENCODE_SMALL_MODEL: "example/model-a" },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as { small_model?: string };
    expect(runtimeConfig.small_model).toBe("example/model-a");
    await prepared.cleanup();
  });

  it("ignores malformed PAPERCLIP_OPENCODE_PROVIDERS without writing a provider block and surfaces a note", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome, PAPERCLIP_OPENCODE_PROVIDERS: "not json" },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(runtimeConfig.provider).toBeUndefined();
    expect(prepared.notes).toContain(
      "PAPERCLIP_OPENCODE_PROVIDERS contains invalid JSON; custom providers ignored.",
    );
    await prepared.cleanup();
  });

  it("surfaces a note when PAPERCLIP_OPENCODE_PROVIDERS is valid JSON but not an object", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome, PAPERCLIP_OPENCODE_PROVIDERS: "[1,2,3]" },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(runtimeConfig.provider).toBeUndefined();
    expect(prepared.notes).toContain(
      "PAPERCLIP_OPENCODE_PROVIDERS is set but is not a JSON object; custom providers ignored.",
    );
    await prepared.cleanup();
  });

  it("surfaces skipped provider entries with non-object values and keeps the usable ones", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: {
        XDG_CONFIG_HOME: configHome,
        PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify({
          bifrost: "http://gateway.example/v1",
          usable: { options: { baseURL: "http://gateway.example/v1" } },
        }),
      },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as { provider?: Record<string, unknown> };
    expect(runtimeConfig.provider?.usable).toBeDefined();
    expect(runtimeConfig.provider?.bifrost).toBeUndefined();
    expect(prepared.notes).toContain(
      "PAPERCLIP_OPENCODE_PROVIDERS: skipped provider(s) with non-object values: bifrost.",
    );
    await prepared.cleanup();
  });

  it("surfaces skipped provider entries when no usable entries remain", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: {
        XDG_CONFIG_HOME: configHome,
        PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify({ bifrost: "http://gateway.example/v1" }),
      },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(runtimeConfig.provider).toBeUndefined();
    expect(prepared.notes).toContain(
      "PAPERCLIP_OPENCODE_PROVIDERS: skipped provider(s) with non-object values: bifrost.",
    );
    await prepared.cleanup();
  });

  it("registers a configured model missing from the catalog on its provider", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: { model: "openrouter/openai/gpt-oss-120b:nitro" },
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as { provider?: Record<string, { models?: Record<string, unknown> }> };
    expect(runtimeConfig.provider?.openrouter?.models).toEqual({
      "openai/gpt-oss-120b:nitro": {},
    });
    expect(prepared.notes).toContain(
      "Registered configured model openrouter/openai/gpt-oss-120b:nitro in the runtime OpenCode config.",
    );
    await prepared.cleanup();
  });

  it("does not clobber an explicit model definition when registering the configured model", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const providers = {
      openrouter: {
        models: {
          "openai/gpt-oss-120b:nitro": { name: "GPT-OSS 120B (nitro)" },
          "example/other": {},
        },
      },
    };
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: {
        XDG_CONFIG_HOME: configHome,
        PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify(providers),
      },
      config: { model: "openrouter/openai/gpt-oss-120b:nitro" },
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as { provider?: Record<string, { models?: Record<string, unknown> }> };
    expect(runtimeConfig.provider?.openrouter?.models).toEqual(providers.openrouter.models);
    expect(
      prepared.notes.some((note) => note.startsWith("Registered configured model")),
    ).toBe(false);
    await prepared.cleanup();
  });

  it("skips model registration when the configured model is not provider/model shaped", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: { model: "not-a-provider-model" },
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(runtimeConfig.provider).toBeUndefined();
    await prepared.cleanup();
  });

  it("respects explicit opt-out", async () => {
    const configHome = await makeConfigHome();
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: { dangerouslySkipPermissions: false },
    });

    expect(prepared.env).toEqual({ XDG_CONFIG_HOME: configHome });
    expect(prepared.notes).toEqual([]);
    await prepared.cleanup();
  });

  describe("mcp tool surface", () => {
    const mcpFixture = {
      github: { type: "remote", url: "https://mcp.example.com/github" },
      "github-alias": { type: "remote", url: "https://mcp.example.com/github" },
      filesystem: { type: "local", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] },
      slack: { type: "remote", url: "https://mcp.example.com/slack" },
    };

    it("measures the surface without changing behavior when no filter is configured", async () => {
      const configHome = await makeConfigHome({ permission: {}, mcp: mcpFixture });
      const prepared = await prepareOpenCodeRuntimeConfig({
        env: { XDG_CONFIG_HOME: configHome },
        config: {},
      });
      cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);

      expect(prepared.notes.some((note) => note.includes("MCP tool surface: 4 server(s) configured -> 4 enabled"))).toBe(true);
      const runtimeConfig = JSON.parse(
        await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(runtimeConfig.mcp).toEqual(mcpFixture);
      await prepared.cleanup();
    });

    it("emits no tool-surface note when no mcp block is configured", async () => {
      const configHome = await makeConfigHome({ permission: {} });
      const prepared = await prepareOpenCodeRuntimeConfig({
        env: { XDG_CONFIG_HOME: configHome },
        config: {},
      });
      cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
      expect(prepared.notes.some((note) => note.includes("MCP tool surface"))).toBe(false);
      await prepared.cleanup();
    });

    it("applies a config allowlist and collapses duplicate aliases", async () => {
      const configHome = await makeConfigHome({ permission: {}, mcp: mcpFixture });
      const prepared = await prepareOpenCodeRuntimeConfig({
        env: { XDG_CONFIG_HOME: configHome },
        config: { toolSurface: { mcpAllowlist: ["github", "github-alias", "filesystem"] } },
      });
      cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);

      const runtimeConfig = JSON.parse(
        await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
      ) as { mcp?: Record<string, unknown> };
      expect(Object.keys(runtimeConfig.mcp ?? {}).sort()).toEqual(["filesystem", "github"]);
      const note = prepared.notes.find((candidate) => candidate.includes("MCP tool surface"));
      expect(note).toContain("allowlist removed: slack");
      expect(note).toContain("duplicate aliases collapsed: github-alias (= github)");
      expect(note).toContain("-> 2 enabled");
      await prepared.cleanup();
    });

    it("applies an env denylist over the run env", async () => {
      const configHome = await makeConfigHome({ permission: {}, mcp: mcpFixture });
      const prepared = await prepareOpenCodeRuntimeConfig({
        env: { XDG_CONFIG_HOME: configHome, PAPERCLIP_OPENCODE_MCP_DENYLIST: "slack, filesystem" },
        config: {},
      });
      cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);

      const runtimeConfig = JSON.parse(
        await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
      ) as { mcp?: Record<string, unknown> };
      expect(Object.keys(runtimeConfig.mcp ?? {}).sort()).toEqual(["github"]);
      const note = prepared.notes.find((candidate) => candidate.includes("MCP tool surface"));
      expect(note).toContain("denylist removed: filesystem, slack");
      expect(note).toContain("duplicate aliases collapsed: github-alias (= github)");
      await prepared.cleanup();
    });

    it("carries a BEFORE/AFTER runtimeDiagnostics.mcp.serverNames fixture for an unfiltered surface", async () => {
      const configHome = await makeConfigHome({ permission: {}, mcp: mcpFixture });
      const prepared = await prepareOpenCodeRuntimeConfig({
        env: { XDG_CONFIG_HOME: configHome },
        config: {},
      });
      cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);

      expect(prepared.runtimeDiagnostics).toEqual({
        mcp: {
          serverNames: {
            before: ["github", "github-alias", "filesystem", "slack"],
            after: ["github", "github-alias", "filesystem", "slack"],
          },
          removedByAllowlist: [],
          removedByDenylist: [],
          removedAsAliases: [],
          eagerServerNames: ["github", "github-alias", "filesystem", "slack"],
          deferredIrrelevant: [],
        },
        executionSurface: { projectConfigDisabled: true, inheritedPluginCount: 0 },
      });
      await prepared.cleanup();
    });

    it("carries a BEFORE/AFTER runtimeDiagnostics.mcp.serverNames fixture for a filtered surface", async () => {
      const configHome = await makeConfigHome({ permission: {}, mcp: mcpFixture });
      const prepared = await prepareOpenCodeRuntimeConfig({
        env: { XDG_CONFIG_HOME: configHome },
        config: { toolSurface: { mcpAllowlist: ["github", "github-alias", "filesystem"] } },
      });
      cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);

      expect(prepared.runtimeDiagnostics).toEqual({
        mcp: {
          serverNames: {
            before: ["github", "github-alias", "filesystem", "slack"],
            after: ["github", "filesystem"],
          },
          removedByAllowlist: ["slack"],
          removedByDenylist: [],
          removedAsAliases: ["github-alias (= github)"],
          eagerServerNames: ["github", "github-alias", "filesystem", "slack"],
          deferredIrrelevant: [],
        },
        executionSurface: { projectConfigDisabled: true, inheritedPluginCount: 0 },
      });
      await prepared.cleanup();
    });

    it("defers irrelevant MCP servers from before-inference load when a task declares mcpScope (eager-minimal)", async () => {
      const configHome = await makeConfigHome({ permission: {}, mcp: mcpFixture });
      const prepared = await prepareOpenCodeRuntimeConfig({
        env: { XDG_CONFIG_HOME: configHome },
        config: {},
        wake: { mcpScope: "github, filesystem" },
      });
      cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);

      const runtimeConfig = JSON.parse(
        await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
      ) as { mcp?: Record<string, unknown> };
      // Irrelevant servers must be absent from the enabled surface BEFORE inference.
      expect(Object.keys(runtimeConfig.mcp ?? {}).sort()).toEqual(["filesystem", "github"]);
      expect(prepared.runtimeDiagnostics.mcp?.eagerServerNames.sort()).toEqual(["filesystem", "github"]);
      expect(prepared.runtimeDiagnostics.mcp?.deferredIrrelevant.sort()).toEqual(["github-alias", "slack"]);
      await prepared.cleanup();
    });

    it("honours agent config toolSurface.mcpScope when the wake does not declare one", async () => {
      const configHome = await makeConfigHome({ permission: {}, mcp: mcpFixture });
      const prepared = await prepareOpenCodeRuntimeConfig({
        env: { XDG_CONFIG_HOME: configHome },
        config: { toolSurface: { mcpScope: ["github"] } },
      });
      cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
      expect(prepared.runtimeDiagnostics.mcp?.eagerServerNames).toEqual(["github"]);
      expect(prepared.runtimeDiagnostics.mcp?.deferredIrrelevant.sort()).toEqual(["filesystem", "github-alias", "slack"]);
      await prepared.cleanup();
    });

    it("emits only execution-surface diagnostics when no mcp block is configured", async () => {
      const configHome = await makeConfigHome({ permission: {} });
      const prepared = await prepareOpenCodeRuntimeConfig({
        env: { XDG_CONFIG_HOME: configHome },
        config: {},
      });
      cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
      expect(prepared.runtimeDiagnostics).toEqual({
        executionSurface: { projectConfigDisabled: true, inheritedPluginCount: 0 },
      });
      await prepared.cleanup();
    });
  });
});

describe("resolveOpenCodeEagerMcpScope", () => {
  it("returns inactive with no relevant keys when nothing declares a scope", () => {
    expect(resolveOpenCodeEagerMcpScope({ config: {}, env: {} })).toEqual({
      relevantServerKeys: null,
      active: false,
    });
  });

  it("prefers the task wake mcpScope over agent config and env", () => {
    const result = resolveOpenCodeEagerMcpScope({
      config: { toolSurface: { mcpScope: ["github"] } },
      env: { PAPERCLIP_OPENCODE_EAGER_MCP_SCOPE: "github, slack" },
      wake: { mcpScope: "filesystem" },
    });
    expect(result.active).toBe(true);
    expect([...result.relevantServerKeys!]).toEqual(["filesystem"]);
  });

  it("falls back to agent config scope then env scope", () => {
    expect([...(resolveOpenCodeEagerMcpScope({ config: { toolSurface: { mcpScope: "github, slack" } }, env: {} }).relevantServerKeys!)]).toEqual([
      "github",
      "slack",
    ]);
    expect([...(resolveOpenCodeEagerMcpScope({ config: {}, env: { PAPERCLIP_OPENCODE_EAGER_MCP_SCOPE: "gitlab" } }).relevantServerKeys!)]).toEqual([
      "gitlab",
    ]);
  });
});

describe("applyOpenCodeEagerMinimalMcpSurface", () => {
  const mcp = { github: { url: "a" }, slack: { url: "b" }, gitlab: { url: "c" } };

  it("keeps the full surface when inactive (unchanged behavior)", () => {
    const result = applyOpenCodeEagerMinimalMcpSurface(mcp, { relevantServerKeys: null, active: false });
    expect(result.next).toBeNull();
    expect(result.eagerServerNames.sort()).toEqual(["github", "gitlab", "slack"]);
    expect(result.deferredIrrelevant).toEqual([]);
  });

  it("defers every server outside the relevant set", () => {
    const result = applyOpenCodeEagerMinimalMcpSurface(mcp, {
      relevantServerKeys: new Set(["github"]),
      active: true,
    });
    expect(Object.keys(result.next ?? {})).toEqual(["github"]);
    expect(result.eagerServerNames).toEqual(["github"]);
    expect(result.deferredIrrelevant.sort()).toEqual(["gitlab", "slack"]);
  });

  it("returns no change when every configured server is relevant", () => {
    const result = applyOpenCodeEagerMinimalMcpSurface(mcp, {
      relevantServerKeys: new Set(["github", "slack", "gitlab"]),
      active: true,
    });
    expect(result.next).toBeNull();
    expect(result.deferredIrrelevant).toEqual([]);
  });
});
