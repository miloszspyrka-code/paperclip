import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";
import { asBoolean } from "@paperclipai/adapter-utils/server-utils";

export const NOT_EXPOSED = "NOT_EXPOSED" as const;
export type NotExposedMarker = typeof NOT_EXPOSED;

export const PAPERCLIP_OPERATOR_COMMAND_NAMES = [
  "paperclip-debug-run",
  "paperclip-napraw-tools",
  "paperclip-opencode-health",
  "paperclip-deleguj-coo",
  "paperclip-wdroz-runtime",
] as const;

export type OpenCodeRuntimeMcpSource = "managed_connection";

export type OpenCodeRuntimeToolSource =
  | "builtin"
  | "managed_connection";

export type OpenCodeRuntimeMcpServer = {
  name: string;
  source: OpenCodeRuntimeMcpSource;
};

export type OpenCodeRuntimeDiagnostics = {
  mcp: {
    paperclipCoreCount: number;
    managedConnectionCount: number;
    inheritedUserMcpCount: number;
    serverNames: OpenCodeRuntimeMcpServer[];
  };
  tools: {
    registeredToolCount: number | NotExposedMarker;
    toolsBySource:
      | Partial<Record<OpenCodeRuntimeToolSource, number | NotExposedMarker>>
      | NotExposedMarker;
    duplicateToolNames: string[] | NotExposedMarker;
    serializedToolSchemaChars: number | NotExposedMarker;
  };
  plugins: {
    allowlistedPluginCount: number;
    inheritedPluginCount: number;
  };
  notes: string[];
};

export type PreparedOpenCodeRuntimeConfig = {
  env: Record<string, string>;
  notes: string[];
  cleanup: () => Promise<void>;
  diagnostics: OpenCodeRuntimeDiagnostics;
  paths: {
    runtimeRoot: string;
    configHome: string;
    dataHome: string;
    cacheHome: string;
    stateHome: string;
    authFile: string;
  };
};

export type PrepareOpenCodeRuntimeConfigInput = {
  env: Record<string, string>;
  config: Record<string, unknown>;
  targetIsRemote?: boolean;
  runtimeMcpServers?: AdapterRuntimeMcpServer[];
  runtimeSkills?: Array<{ runtimeName: string; source: string }>;
  hostAuthFile?: string;
  diagnosticsSink?: (diagnostics: OpenCodeRuntimeDiagnostics) => void;
};

const RUNTIME_ROOT_ENV = "PAPERCLIP_OPENCODE_RUNTIME_ROOT";
const PAPERCLIP_RUNTIME_PLUGIN_KEY = "opencodeRuntimePlugins";
const DEFAULT_STALE_RUNTIME_MS = 24 * 60 * 60 * 1000;
const PAPERCLIP_COMMAND_ROOT_RELATIVE_CANDIDATES = [
  "../../../../../.opencode/commands",
  "../../../../.opencode/commands",
];
const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safePathSegment(value: string | undefined, fallback: string): string {
  const normalized = (value ?? "").trim().replace(/[^a-zA-Z0-9_-]/g, "_");
  return normalized || fallback;
}

function resolveHostDataHome(): string {
  const configured = process.env.XDG_DATA_HOME?.trim();
  return configured || path.join(os.homedir(), ".local", "share");
}

function expandEnvPlaceholders<T>(value: T, resolve: (name: string) => string | undefined): T {
  if (typeof value === "string") {
    return value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => {
      const resolved = resolve(name);
      return resolved !== undefined && resolved.length > 0 ? resolved : match;
    }) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => expandEnvPlaceholders(entry, resolve)) as unknown as T;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = expandEnvPlaceholders(entry, resolve);
    }
    return out as unknown as T;
  }
  return value;
}

function parseProviderConfig(
  raw: unknown,
  resolveEnv: (name: string) => string | undefined,
  notes: string[],
): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    notes.push("PAPERCLIP_OPENCODE_PROVIDERS contains invalid JSON; custom providers ignored.");
    return null;
  }
  if (!isPlainObject(parsed)) {
    notes.push("PAPERCLIP_OPENCODE_PROVIDERS is set but is not a JSON object; custom providers ignored.");
    return null;
  }
  const providers: Record<string, unknown> = {};
  const skipped: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (isPlainObject(value)) providers[key] = expandEnvPlaceholders(value, resolveEnv);
    else skipped.push(key);
  }
  if (skipped.length > 0) {
    notes.push(`PAPERCLIP_OPENCODE_PROVIDERS: skipped provider(s) with non-object values: ${skipped.join(", ")}.`);
  }
  return Object.keys(providers).length > 0 ? providers : null;
}

function parseConfiguredModelRef(raw: unknown): { provider: string; model: string } | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  return { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) };
}

function parsePluginAllowlist(config: Record<string, unknown>, runtimeRoot: string, notes: string[]): string[] {
  const raw = config[PAPERCLIP_RUNTIME_PLUGIN_KEY];
  if (raw === undefined) return [];
  const entries = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(",")
      : null;
  if (!entries) {
    notes.push(`${PAPERCLIP_RUNTIME_PLUGIN_KEY} must be an array of pinned plugin specs; no plugins enabled.`);
    return [];
  }
  const plugins: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string" || entry.trim().length === 0) continue;
    const spec = entry.trim();
    if (path.isAbsolute(spec) && !path.resolve(spec).startsWith(path.resolve(runtimeRoot) + path.sep)) {
      notes.push(`Skipped plugin path outside Paperclip runtime root: ${path.basename(spec)}.`);
      continue;
    }
    if (!plugins.includes(spec)) plugins.push(spec);
  }
  return plugins;
}

function parseCommandFrontmatter(markdown: string): { description: string; template: string } | null {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/m.exec(normalized);
  if (!match) return null;
  const descriptionLine = match[1]
    .split("\n")
    .map((line) => /^description\s*:\s*(.*)$/.exec(line)?.[1]?.trim() ?? "")
    .find(Boolean);
  const description = descriptionLine?.replace(/^(["'])(.*)\1$/, "$2").trim() ?? "";
  const template = (match[2] ?? "").trim();
  if (!description || !template) return null;
  return { description, template };
}

async function loadPaperclipOperatorCommands(): Promise<Record<string, { description: string; template: string }>> {
  for (const relativeRoot of PAPERCLIP_COMMAND_ROOT_RELATIVE_CANDIDATES) {
    const root = path.resolve(__moduleDir, relativeRoot);
    const commands: Record<string, { description: string; template: string }> = {};
    for (const name of PAPERCLIP_OPERATOR_COMMAND_NAMES) {
      const source = await fs.readFile(path.join(root, `${name}.md`), "utf8").catch(() => null);
      if (!source) continue;
      const parsed = parseCommandFrontmatter(source);
      if (parsed) commands[name] = parsed;
    }
    if (Object.keys(commands).length > 0) return commands;
  }
  return {};
}

function materializeManagedMcpServer(server: AdapterRuntimeMcpServer): Record<string, unknown> {
  return {
    type: "remote",
    url: server.url,
    enabled: true,
    headers: { Authorization: `Bearer ${server.token}` },
  };
}

function pluginPackageName(spec: string): string | null {
  const at = spec.startsWith("@") ? spec.indexOf("@", spec.indexOf("/") + 1) : spec.lastIndexOf("@");
  if (at <= 0) return null;
  return spec.slice(0, at);
}

async function seedAllowlistedPlugins(
  plugins: string[],
  runtimeRoot: string,
): Promise<Map<string, string>> {
  const hostCacheRoot = process.env.XDG_CACHE_HOME?.trim() || path.join(os.homedir(), ".cache");
  const hostPackagesRoot = path.join(hostCacheRoot, "opencode", "packages");
  const runtimePluginRoot = path.join(runtimeRoot, "plugins");
  const resolved = new Map<string, string>();
  for (const spec of plugins) {
    if (!/^(?:@[^/\s]+\/[^@/\s]+|[^@/\s]+)@[^\s]+$/.test(spec)) continue;
    const packageName = pluginPackageName(spec);
    if (!packageName) continue;
    const source = path.join(hostPackagesRoot, spec);
    const destination = path.join(runtimePluginRoot, spec.replace(/[\\/]/g, "_"));
    const sourcePackage = path.join(source, "node_modules", packageName);
    const destinationPackage = path.join(destination, "node_modules", packageName);
    const [sourceStat, destinationStat] = await Promise.all([
      fs.stat(sourcePackage).catch(() => null),
      fs.stat(destinationPackage).catch(() => null),
    ]);
    if (!sourceStat?.isDirectory()) continue;
    if (!destinationStat) {
      await fs.mkdir(path.dirname(destinationPackage), { recursive: true });
      await fs.cp(sourcePackage, destinationPackage, { recursive: true, errorOnExist: false });
    }
    const packageJsonRaw = await fs.readFile(path.join(destinationPackage, "package.json"), "utf8").catch(() => null);
    if (!packageJsonRaw) continue;
    try {
      const packageJson = JSON.parse(packageJsonRaw) as {
        exports?: string | { "."?: string | { import?: string; default?: string } };
        main?: string;
      };
      const exported = typeof packageJson.exports === "string"
        ? packageJson.exports
        : typeof packageJson.exports?.["."] === "string"
          ? packageJson.exports["."]
          : typeof packageJson.exports?.["."] === "object"
            ? packageJson.exports["."]?.import ?? packageJson.exports["."]?.default
            : null;
      const entryPath = path.resolve(destinationPackage, exported ?? packageJson.main ?? "src/index.ts");
      if (entryPath.startsWith(path.resolve(destinationPackage) + path.sep)) resolved.set(spec, entryPath);
    } catch {
      // Keep the pinned npm spec when package metadata is malformed.
    }
  }
  return resolved;
}

function emptyDiagnostics(notes: string[]): OpenCodeRuntimeDiagnostics {
  return {
    mcp: {
      paperclipCoreCount: 0,
      managedConnectionCount: 0,
      inheritedUserMcpCount: 0,
      serverNames: [],
    },
    tools: {
      registeredToolCount: NOT_EXPOSED,
      toolsBySource: NOT_EXPOSED,
      duplicateToolNames: NOT_EXPOSED,
      serializedToolSchemaChars: NOT_EXPOSED,
    },
    plugins: { allowlistedPluginCount: 0, inheritedPluginCount: 0 },
    notes,
  };
}

async function sweepStaleRuntimeDirectories(runtimeRoot: string): Promise<void> {
  const tmpRoot = path.join(runtimeRoot, "tmp");
  const entries = await fs.readdir(tmpRoot, { withFileTypes: true }).catch(() => []);
  const cutoff = Date.now() - DEFAULT_STALE_RUNTIME_MS;
  await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const candidate = path.join(tmpRoot, entry.name);
    const marker = path.join(candidate, ".paperclip-active");
    const [stat, markerStat] = await Promise.all([
      fs.stat(candidate).catch(() => null),
      fs.stat(marker).catch(() => null),
    ]);
    const age = Math.max(stat?.mtimeMs ?? 0, markerStat?.mtimeMs ?? 0);
    if (age > 0 && age < cutoff) await fs.rm(candidate, { recursive: true, force: true });
  }));
}

async function copyProviderAuth(input: {
  provider: string | null;
  sourceFile: string;
  destinationFile: string;
  notes: string[];
}): Promise<void> {
  if (!input.provider) return;
  const raw = await fs.readFile(input.sourceFile, "utf8").catch(() => null);
  if (!raw) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    input.notes.push("Host OpenCode auth.json is invalid; provider auth bridge skipped.");
    return;
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed[input.provider])) return;
  await fs.mkdir(path.dirname(input.destinationFile), { recursive: true });
  await fs.writeFile(
    input.destinationFile,
    `${JSON.stringify({ [input.provider]: parsed[input.provider] }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await fs.chmod(input.destinationFile, 0o600).catch(() => undefined);
  input.notes.push(`Copied only the configured provider auth record for ${input.provider} into the Paperclip agent data root.`);
}

export async function prepareOpenCodeRuntimeConfig(
  input: PrepareOpenCodeRuntimeConfigInput,
): Promise<PreparedOpenCodeRuntimeConfig> {
  const notes: string[] = [];
  const diagnostics = emptyDiagnostics(notes);
  const configuredRoot = input.env[RUNTIME_ROOT_ENV]?.trim();
  const runtimeRoot = path.resolve(
    configuredRoot || await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-runtime-")),
  );
  const ownsRuntimeRoot = !configuredRoot;
  const agentId = safePathSegment(input.env.PAPERCLIP_AGENT_ID, "unknown-agent");
  const runId = safePathSegment(input.env.PAPERCLIP_RUN_ID, `run-${Date.now()}`);
  const configHome = path.join(runtimeRoot, "tmp", runId, "config");
  const dataHome = path.join(runtimeRoot, "agents", agentId, "data");
  const cacheHome = path.join(runtimeRoot, "cache");
  const stateHome = path.join(dataHome, "state");
  const authFile = path.join(dataHome, "opencode", "auth.json");
  const activeMarker = path.join(runtimeRoot, "tmp", runId, ".paperclip-active");

  await fs.mkdir(path.dirname(activeMarker), { recursive: true });
  await Promise.all([
    fs.mkdir(path.join(configHome, "opencode"), { recursive: true }),
    fs.mkdir(dataHome, { recursive: true }),
    fs.mkdir(cacheHome, { recursive: true }),
    fs.mkdir(stateHome, { recursive: true }),
    fs.mkdir(path.join(runtimeRoot, "plugins"), { recursive: true }),
    fs.writeFile(activeMarker, `${process.pid}\n`, "utf8"),
  ]);
  const skillsRoot = path.join(configHome, "opencode", "skills");
  for (const skill of input.runtimeSkills ?? []) {
    const runtimeName = safePathSegment(skill.runtimeName, "skill");
    if (!skill.source || runtimeName !== skill.runtimeName) continue;
    const destination = path.join(skillsRoot, runtimeName);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.cp(skill.source, destination, { recursive: true, force: true, dereference: true }).catch(() => undefined);
  }
  await sweepStaleRuntimeDirectories(runtimeRoot);

  const skipPermissions = asBoolean(input.config.dangerouslySkipPermissions, true);
  const configuredModel = parseConfiguredModelRef(input.config.model);
  const resolveEnv = (name: string): string | undefined => input.env[name] ?? process.env[name];
  const gatewayProviders = parseProviderConfig(
    input.env.PAPERCLIP_OPENCODE_PROVIDERS ?? process.env.PAPERCLIP_OPENCODE_PROVIDERS,
    resolveEnv,
    notes,
  );
  let provider = gatewayProviders ?? {};
  if (configuredModel) {
    const providerEntry = isPlainObject(provider[configuredModel.provider])
      ? { ...(provider[configuredModel.provider] as Record<string, unknown>) }
      : {};
    const models = isPlainObject(providerEntry.models)
      ? { ...(providerEntry.models as Record<string, unknown>) }
      : {};
    if (!isPlainObject(models[configuredModel.model])) {
      models[configuredModel.model] = {};
      providerEntry.models = models;
      provider = { ...provider, [configuredModel.provider]: providerEntry };
    }
  }

  const mcpServers: Record<string, Record<string, unknown>> = {};
  for (const server of input.runtimeMcpServers ?? []) {
    if (!server.name.trim()) continue;
    mcpServers[server.name] = materializeManagedMcpServer(server);
  }
  diagnostics.mcp.managedConnectionCount = Object.keys(mcpServers).length;
  diagnostics.mcp.serverNames = Object.keys(mcpServers).map((name) => ({
    name,
    source: "managed_connection",
  }));
  const plugins = parsePluginAllowlist(input.config, runtimeRoot, notes);
  diagnostics.plugins.allowlistedPluginCount = plugins.length;
  diagnostics.plugins.inheritedPluginCount = 0;
  const localPluginEntries = await seedAllowlistedPlugins(plugins, runtimeRoot);
  const operatorCommands = await loadPaperclipOperatorCommands();

  const nextConfig: Record<string, unknown> = {
    "$schema": "https://opencode.ai/config.json",
    instructions: [],
    permission: skipPermissions ? { external_directory: "allow" } : {},
  };
  if (Object.keys(provider).length > 0) nextConfig.provider = provider;
  const smallModel = (
    input.env.PAPERCLIP_OPENCODE_SMALL_MODEL ?? process.env.PAPERCLIP_OPENCODE_SMALL_MODEL
  )?.trim();
  if (smallModel) nextConfig.small_model = smallModel;
  if (Object.keys(mcpServers).length > 0) nextConfig.mcp = mcpServers;
  if (plugins.length > 0) nextConfig.plugin = plugins.map((plugin) => localPluginEntries.get(plugin) ?? plugin);
  if (Object.keys(operatorCommands).length > 0) nextConfig.command = operatorCommands;
  await fs.writeFile(
    path.join(configHome, "opencode", "opencode.json"),
    `${JSON.stringify(nextConfig, null, 2)}\n`,
    "utf8",
  );

  const hostAuthFile = input.hostAuthFile ?? path.join(resolveHostDataHome(), "opencode", "auth.json");
  await copyProviderAuth({
    provider: configuredModel?.provider ?? null,
    sourceFile: hostAuthFile,
    destinationFile: authFile,
    notes,
  });
  notes.push("Built Paperclip OpenCode config from scratch; host MCP, plugins, commands, agents and skills were not read.");
  notes.push("Injected only effective Paperclip Connection MCP gateways.");
  if (Object.keys(operatorCommands).length > 0) {
    notes.push(`Injected ${Object.keys(operatorCommands).length} Paperclip operator command wrappers.`);
  } else {
    notes.push("No Paperclip operator command wrappers were found.");
  }
  if (plugins.length === 0) notes.push("No Paperclip OpenCode plugins are enabled for this run.");

  const runtimeEnv: Record<string, string> = {
    ...input.env,
    PAPERCLIP_OPENCODE_CONFIG_ROOT: configHome,
    PAPERCLIP_OPENCODE_DATA_ROOT: dataHome,
    PAPERCLIP_OPENCODE_CACHE_ROOT: cacheHome,
    PAPERCLIP_OPENCODE_STORAGE_DIR: dataHome,
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: dataHome,
    XDG_CACHE_HOME: cacheHome,
    XDG_STATE_HOME: stateHome,
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    ...(input.targetIsRemote ? {} : {
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
    }),
  };

  return {
    env: runtimeEnv,
    notes,
    diagnostics,
    paths: { runtimeRoot, configHome, dataHome, cacheHome, stateHome, authFile },
    cleanup: async () => {
      await fs.rm(activeMarker, { force: true }).catch(() => undefined);
      await fs.rm(path.join(runtimeRoot, "tmp", runId), { recursive: true, force: true }).catch(() => undefined);
      if (ownsRuntimeRoot) await fs.rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
