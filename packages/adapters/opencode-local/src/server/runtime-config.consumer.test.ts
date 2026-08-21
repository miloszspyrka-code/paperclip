import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { prepareOpenCodeRuntimeConfig } from "./runtime-config.js";

describe("consumer-contract: real OpenCode parser accepts generated config", () => {
  it("managed Paperclip gateways + opencode-go/hy3 pass the real parser", async () => {
    const configHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-consumer-"));
    const opencodeDir = path.join(configHome, "opencode");
    await fs.mkdir(opencodeDir, { recursive: true });
    try {
      const prepared = await prepareOpenCodeRuntimeConfig({
        env: { PAPERCLIP_OPENCODE_RUNTIME_ROOT: configHome, PAPERCLIP_AGENT_ID: "consumer", PAPERCLIP_RUN_ID: "run", PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify({ "opencode-go": { npm: "@ai-sdk/openai-compatible", models: { hy3: {} } } }) },
        config: { model: "opencode-go/hy3" },
        runtimeMcpServers: [
          { name: "Git", url: "https://paperclip.example/api/tool-gateway/gateways/git/mcp", token: "tok-git", connectionId: "git" },
          { name: "Playwright", url: "https://paperclip.example/api/tool-gateway/gateways/pw/mcp", token: "tok-pw", connectionId: "pw" },
        ],
      });
      const runtimeConfigPath = path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json");
      const raw = await fs.readFile(runtimeConfigPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expect((parsed.mcp as Record<string, unknown>)?.servers).toBeUndefined();
      expect((parsed.mcp as Record<string, { type: string }>)?.Git?.type).toBe("remote");
      expect((parsed.mcp as Record<string, { type: string }>)?.Playwright?.type).toBe("remote");
      expect((parsed.mcp as Record<string, { type: string }>)?.paperclip).toBeUndefined();
      const result = spawnSync("opencode", ["run", "hello", "--model", "opencode-go/hy3", "--print-logs"], { env: { ...process.env, ...prepared.env }, timeout: 15000, encoding: "utf8" });
      const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      expect(combined).not.toContain("Configuration is invalid");
      expect(combined).not.toContain("mcp.servers");
      await prepared.cleanup();
    } finally {
      await fs.rm(configHome, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("loads the pinned OpenSlimEdit plugin from the Paperclip-only cache", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-plugin-consumer-"));
    try {
      const prepared = await prepareOpenCodeRuntimeConfig({
        env: {
          PAPERCLIP_OPENCODE_RUNTIME_ROOT: root,
          PAPERCLIP_AGENT_ID: "plugin-consumer",
          PAPERCLIP_RUN_ID: "plugin-run",
        },
        config: { opencodeRuntimePlugins: ["openslimedit@1.0.1"] },
      });
      const generated = JSON.parse(await fs.readFile(path.join(prepared.paths.configHome, "opencode", "opencode.json"), "utf8")) as { plugin?: string[] };
      expect(generated.plugin?.[0]).toContain("plugins");
      expect(generated.plugin?.[0]).toContain("openslimedit@1.0.1");
      const result = spawnSync("cmd.exe", ["/d", "/s", "/c", "opencode.cmd debug info"], {
        env: { ...process.env, ...prepared.env },
        cwd: root,
        timeout: 30_000,
        encoding: "utf8",
      });
      const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      if (result.status !== 0) {
        throw new Error(JSON.stringify({ status: result.status, signal: result.signal, error: result.error?.message, output: combined.slice(-2000) }));
      }
      expect(combined.toLowerCase()).toContain("openslimedit");
      expect(combined).not.toContain("opencode-antigravity-auth");
      await prepared.cleanup();
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 45_000);
});
