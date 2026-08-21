import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";
import { asBoolean } from "@paperclipai/adapter-utils/server-utils";

export const NOT_EXPOSED = "NOT_EXPOSED" as const;
export type NotExposedMarker = typeof NOT_EXPOSED;

export type OpenCodeRuntimeMcpSource =
  | "paperclip_core"
  | "managed_connection"
  | "inherited_user_mcp";

export type OpenCodeRuntimeToolSource =
  | "builtin"
  | "paperclip_core"
  | "managed_connection"
  | "inherited_user_mcp"
  | "inherited_plugin";

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
    inheritedPluginCount: number;
  };
  notes: string[];
};

export type PreparedOpenCodeRuntimeConfig = {
  env: Record<string, string>;
  notes: string[];
  cleanup: () => Promise<void>;
  diagnostics: OpenCodeRuntimeDiagnostics;
};

export type PrepareOpenCodeRuntimeConfigInput = {
  env: Record<string, string>;
  config: Record<string, unknown>;
  targetIsRemote?: boolean;
  runtimeMcpServers?: AdapterRuntimeMcpServer[];
  paperclipCoreMcp?: { name: string; url: string; token: string } | null;
  diagnosticsSink?: (diagnostics: OpenCodeRuntimeDiagnostics) => void;
};

const PAPERCLIP_CORE_MCP_NAME = "paperclip";
const DEFAULT_INHERIT_FLAGS = {
  inheritUserOpenCodeConfig: false,
  inheritUserMcp: false,
  inheritUserPlugins: false,
};

// Top-level OpenCode config keys that are user-level extension / UI surfaces and
// must never leak into a managed, headless Paperclip run unless explicitly opted
// in. The curated runtime config is built from scratch; these are the keys we
// refuse to carry over from the operator's global OpenCode config.
const USER_SURFACE_KEYS = new Set([
  "mcp",
  "plugin",
  "plugins",
  "pluginDirectory",
  "pluginDirectories",
  "command",
  "commands",
  "agent",
  "agents",
  "theme",
  "tui",
]);

function resolveXdgConfigHome(env: Record<string, string>): string {
  return (
    (typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim()) ||
    (typeof process.env.XDG_CONFIG_HOME === "string" && process.env.XDG_CONFIG_HOME.trim()) ||
    path.join(os.homedir(), ".config")
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveInheritFlags(config: Record<string, unknown>) {
  return {
    inheritUserOpenCodeConfig: asBoolean(
      config.inheritUserOpenCodeConfig,
      DEFAULT_INHERIT_FLAGS.inheritUserOpenCodeConfig,
    ),
    inheritUserMcp: asBoolean(config.inheritUserMcp, DEFAULT_INHERIT_FLAGS.inheritUserMcp),
    inheritUserPlugins: asBoolean(
      config.inheritUserPlugins,
      DEFAULT_INHERIT_FLAGS.inheritUserPlugins,
    ),
  };
}

// Recursively replace {env:VAR} placeholders with the resolved value. Used to bake
// gateway provider secrets (e.g. the LLM-gateway virtual key) into opencode.json
// SERVER-SIDE, where the value is reliably present. OpenCode's own {env:...}
// resolution happens inside the (possibly sandboxed) run process, whose env
// plumbing is not guaranteed to carry the key to OpenCode's spawned server -- so
// we resolve it here. Unresolvable placeholders are left intact for OpenCode to try.
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
    // Surface the misconfiguration instead of silently dropping the provider
    // block; an unparseable value would otherwise be undiagnosable.
    notes.push("PAPERCLIP_OPENCODE_PROVIDERS contains invalid JSON; custom providers ignored.");
    return null;
  }
  if (!isPlainObject(parsed)) {
    notes.push(
      "PAPERCLIP_OPENCODE_PROVIDERS is set but is not a JSON object; custom providers ignored.",
    );
    return null;
  }
  // Only keep provider entries that are themselves objects; surface the ones
  // we drop so a malformed entry is just as diagnosable as malformed JSON.
  const providers: Record<string, unknown> = {};
  const skipped: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (isPlainObject(value)) providers[key] = expandEnvPlaceholders(value, resolveEnv);
    else skipped.push(key);
  }
  if (skipped.length > 0) {
    notes.push(
      `PAPERCLIP_OPENCODE_PROVIDERS: skipped provider(s) with non-object values: ${skipped.join(", ")}.`,
    );
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

async function readJsonObject(filepath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(filepath, "utf8");
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function stripTopLevelPaperclipMcpEntry(raw: string): string {
  let output = raw;
  let offset = 0;
  while (offset < output.length) {
    const keyIdx = findKeyAtTopLevel(output, "paperclip", offset);
    if (keyIdx === -1) break;
    const braceStart = output.indexOf("{", keyIdx);
    if (braceStart === -1) break;
    let depth = 0;
    let inString = false;
    let end = -1;
    for (let i = braceStart; i < output.length; i++) {
      const ch = output[i];
      if (ch === '"' && output[i - 1] !== "\\") inString = !inString;
      if (inString) continue;
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) break;
    let removalEnd = end + 1;
    while (removalEnd < output.length && (output[removalEnd] === " " || output[removalEnd] === "\t" || output[removalEnd] === "\r" || output[removalEnd] === "\n")) {
      removalEnd += 1;
    }
    if (output[removalEnd] === ",") removalEnd += 1;
    output = `${output.slice(0, keyIdx)}${output.slice(removalEnd)}`;
    offset = keyIdx;
  }
  return output;
}

function findKeyAtTopLevel(text: string, key: string, from: number): number {
  const needle = `"${key}"`;
  let idx = text.indexOf(needle, from);
  while (idx !== -1) {
    const before = text.slice(0, idx);
    const inString = (before.match(/"/g) ?? []).length % 2 === 1;
    const inLineComment = before.lastIndexOf("//") > before.lastIndexOf("\n");
    if (!inString && !inLineComment) {
      const after = text.slice(idx + needle.length).trimStart();
      if (after.startsWith(":")) return idx;
    }
    idx = text.indexOf(needle, idx + needle.length);
  }
  return -1;
}

function buildPaperclipMcpEntry(input: {
  env: Record<string, string>;
}): Record<string, unknown> | null {
  if (input.env.PAPERCLIP_OPENCODE_PAPERCLIP_MCP === "0") return null;
  const stdioCmd = process.env.MCP_STDIO_CMD?.trim();
  const stdioArgsRaw = process.env.MCP_STDIO_ARGS?.trim();
  if (!stdioCmd || !stdioArgsRaw) return null;
  const apiKey = input.env.PAPERCLIP_API_KEY?.trim();
  if (!apiKey) return null;
  const apiUrl =
    input.env.PAPERCLIP_API_URL?.trim() ??
    process.env.PAPERCLIP_API_URL?.trim() ??
    "http://127.0.0.1:3100";
  const environment: Record<string, string> = {
    PAPERCLIP_API_URL: apiUrl,
    PAPERCLIP_API_KEY: apiKey,
    PAPERCLIP_COMPANY_ID: input.env.PAPERCLIP_COMPANY_ID ?? "",
    PAPERCLIP_AGENT_ID: input.env.PAPERCLIP_AGENT_ID ?? "",
    PAPERCLIP_RUN_ID: input.env.PAPERCLIP_RUN_ID ?? "",
  };
  return {
    type: "local",
    command: [stdioCmd, ...stdioArgsRaw.split(/\s+/).filter(Boolean)],
    environment,
    enabled: true,
  };
}

// Read only the `paperclip` core MCP entry from the operator's global OpenCode
// config. We deliberately do NOT copy or inherit the rest of the global config;
// the core Paperclip MCP is the single user-level surface we must preserve so the
// managed agent can still reach the Paperclip control plane.
function extractCorePaperclipMcp(
  existingConfig: Record<string, unknown>,
): Record<string, unknown> | null {
  const mcp = isPlainObject(existingConfig.mcp) ? existingConfig.mcp : {};
  const direct = mcp[PAPERCLIP_CORE_MCP_NAME];
  if (isPlainObject(direct)) return direct;
  const servers = isPlainObject(mcp.servers) ? mcp.servers : {};
  const paperclipEntry = servers[PAPERCLIP_CORE_MCP_NAME];
  if (!isPlainObject(paperclipEntry)) return null;
  return paperclipEntry;
}

function materializeManagedMcpServer(server: AdapterRuntimeMcpServer): Record<string, unknown> {
  return {
    type: "remote",
    url: server.url,
    enabled: true,
    headers: { Authorization: `Bearer ${server.token}` },
  };
}

function materializeCorePaperclipMcp(input: {
  name: string;
  url: string;
  token: string;
}): Record<string, unknown> {
  return {
    type: "remote",
    url: input.url,
    enabled: true,
    headers: { Authorization: `Bearer ${input.token}` },
  };
}

function sanitizeUrlForDiagnostics(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.size > 0) {
      parsed.search = "";
      return `${parsed.toString()}?<redacted>`;
    }
    return parsed.toString();
  } catch {
    return "<unparseable-url>";
  }
}

// Strip user-level extension / UI surfaces from an inherited global config.
// `mcp` is handled separately (only the core Paperclip server is re-added), so it
// is always stripped here. Plugins/commands/agents/theme/tui are stripped unless
// the matching explicit opt-in flag is set.
function stripUnsafeUserSurfaces(
  existing: Record<string, unknown>,
  flags: { inheritUserMcp: boolean; inheritUserPlugins: boolean },
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(existing)) {
    if (USER_SURFACE_KEYS.has(key)) {
      if (key === "plugin" || key === "plugins" || key === "pluginDirectory" || key === "pluginDirectories") {
        if (!flags.inheritUserPlugins) continue;
        out[key] = value;
        continue;
      }
      continue;
    }
    out[key] = value;
  }
  return out;
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
    plugins: { inheritedPluginCount: 0 },
    notes,
  };
}

export async function prepareOpenCodeRuntimeConfig(
  input: PrepareOpenCodeRuntimeConfigInput,
): Promise<PreparedOpenCodeRuntimeConfig> {
  const skipPermissions = asBoolean(input.config.dangerouslySkipPermissions, true);
  if (!skipPermissions) {
    const notes = [
      "dangerouslySkipPermissions=false: skipping managed runtime OpenCode config isolation.",
    ];
    return {
      env: input.env,
      notes,
      cleanup: async () => {},
      diagnostics: emptyDiagnostics(notes),
    };
  }

  const flags = resolveInheritFlags(input.config);
  const notes: string[] = [];
  const diagnostics: OpenCodeRuntimeDiagnostics = emptyDiagnostics(notes);

  const runtimeConfigHome = await fs.mkdtemp(
    path.join(os.tmpdir(), "paperclip-opencode-config-"),
  );
  const runtimeConfigDir = path.join(runtimeConfigHome, "opencode");
  const runtimeConfigPath = path.join(runtimeConfigDir, "opencode.json");
  await fs.mkdir(runtimeConfigDir, { recursive: true });

  // We no longer recursively copy the operator's global OpenCode config. The
  // managed, headless run gets a curated config built below. We only READ the
  // global config (local runs) to extract the single core Paperclip MCP the
  // agent needs to reach the control plane.
  const sourceConfigDir = path.join(resolveXdgConfigHome(input.env), "opencode");
  // Read the operator's global OpenCode config. We read it so we can (a) preserve
  // the single core Paperclip MCP and (b) optionally inherit benign top-level
  // keys when explicitly opted in. We never copy the directory, and we never set
  // XDG_CONFIG_HOME to the host path (the curated config lives in a fresh tmpdir,
  // which is what gets shipped to remote targets).
  const existingConfig = await readJsonObject(
    path.join(sourceConfigDir, "opencode.json"),
  );

  const inheritedBase = flags.inheritUserOpenCodeConfig
    ? stripUnsafeUserSurfaces(existingConfig, {
        inheritUserMcp: flags.inheritUserMcp,
        inheritUserPlugins: flags.inheritUserPlugins,
      })
    : {};

  // --- Curated permission: only what headless execution requires. ---
  const existingPermission = isPlainObject(inheritedBase.permission)
    ? inheritedBase.permission
    : {};
  notes.push(
    "Injected runtime OpenCode config with permission.external_directory=allow to avoid headless approval prompts.",
  );

  // --- Provider / model wiring (unchanged, kept minimal). ---
  const resolveEnv = (name: string): string | undefined => input.env[name] ?? process.env[name];
  const gatewayProviders = parseProviderConfig(
    input.env.PAPERCLIP_OPENCODE_PROVIDERS ?? process.env.PAPERCLIP_OPENCODE_PROVIDERS,
    resolveEnv,
    notes,
  );
  const existingProvider = isPlainObject(inheritedBase.provider)
    ? (inheritedBase.provider as Record<string, unknown>)
    : {};
  let nextProvider = gatewayProviders
    ? { ...existingProvider, ...gatewayProviders }
    : existingProvider;
  if (gatewayProviders) {
    notes.push(
      `Injected ${Object.keys(gatewayProviders).length} custom OpenCode provider(s) from PAPERCLIP_OPENCODE_PROVIDERS: ${Object.keys(gatewayProviders).join(", ")}.`,
    );
  }

  const configuredModel = parseConfiguredModelRef(input.config.model);
  if (configuredModel) {
    const providerEntry = isPlainObject(nextProvider[configuredModel.provider])
      ? { ...(nextProvider[configuredModel.provider] as Record<string, unknown>) }
      : {};
    const providerModels = isPlainObject(providerEntry.models)
      ? { ...(providerEntry.models as Record<string, unknown>) }
      : {};
    if (!isPlainObject(providerModels[configuredModel.model])) {
      providerModels[configuredModel.model] = {};
      providerEntry.models = providerModels;
      nextProvider = { ...nextProvider, [configuredModel.provider]: providerEntry };
      notes.push(
        `Registered configured model ${configuredModel.provider}/${configuredModel.model} in the runtime OpenCode config.`,
      );
    }
  }

  const smallModel = (
    input.env.PAPERCLIP_OPENCODE_SMALL_MODEL ?? process.env.PAPERCLIP_OPENCODE_SMALL_MODEL
  )?.trim();
  if (smallModel) {
    notes.push(`Pinned OpenCode small_model to ${smallModel}.`);
  }

  // --- Curated MCP surfaces ---
  const mcpServers: Record<string, { def: Record<string, unknown>; source: OpenCodeRuntimeMcpSource }> = {};

  // 1. Core Paperclip MCP -- exactly one. Prefer an explicit run-scoped core
  //    definition; otherwise extract the operator's global `paperclip` entry.
  const corePaperclipMcp = input.paperclipCoreMcp
    ? input.paperclipCoreMcp
    : extractCorePaperclipMcp(existingConfig);
  if (input.paperclipCoreMcp) {
    mcpServers[PAPERCLIP_CORE_MCP_NAME] = {
      def: materializeCorePaperclipMcp(input.paperclipCoreMcp),
      source: "paperclip_core",
    };
    diagnostics.mcp.paperclipCoreCount = 1;
    notes.push("Injected the run-scoped core Paperclip MCP server (exactly one).");
  } else if (corePaperclipMcp) {
    mcpServers[PAPERCLIP_CORE_MCP_NAME] = { def: corePaperclipMcp, source: "paperclip_core" };
    diagnostics.mcp.paperclipCoreCount = 1;
    notes.push(
      "Preserved exactly one core Paperclip MCP server extracted from the operator config (no bulk inheritance).",
    );
  } else {
    notes.push(
      "No core Paperclip MCP was available to inject into the managed runtime config.",
    );
  }

  // 2. Managed Connection gateways from the effective Paperclip Connection
  //    profile. These are scoped to the agent's allowed tools.
  const runtimeMcpServers = input.runtimeMcpServers ?? [];
  for (const server of runtimeMcpServers) {
    if (server.name === PAPERCLIP_CORE_MCP_NAME) continue;
    mcpServers[server.name] = {
      def: materializeManagedMcpServer(server),
      source: "managed_connection",
    };
  }
  diagnostics.mcp.managedConnectionCount = runtimeMcpServers.filter(
    (s) => s.name !== PAPERCLIP_CORE_MCP_NAME,
  ).length;

  // 3. Inherited user MCP servers (opt-in only). The `paperclip` name is reserved
  //    for the core server, so any user server colliding with it is skipped to
  //    avoid a duplicate core MCP.
  let inheritedUserMcpCount = 0;
  if (flags.inheritUserMcp) {
    const userMcp = isPlainObject(existingConfig.mcp) ? existingConfig.mcp : {};
    const flatServers: Record<string, unknown> = {};
    for (const [name, def] of Object.entries(userMcp)) {
      if (name === "servers") continue;
      if (isPlainObject(def) && typeof (def as Record<string, unknown>).type === "string") flatServers[name] = def;
    }
    const legacyServers = isPlainObject(userMcp.servers) ? (userMcp.servers as Record<string, unknown>) : {};
    const userServers = { ...flatServers, ...legacyServers };
    for (const [name, def] of Object.entries(userServers)) {
      if (name === PAPERCLIP_CORE_MCP_NAME) continue;
      if (!isPlainObject(def)) continue;
      if (mcpServers[name]) continue;
      mcpServers[name] = { def, source: "inherited_user_mcp" };
      inheritedUserMcpCount += 1;
    }
  }
  diagnostics.mcp.inheritedUserMcpCount = inheritedUserMcpCount;

  diagnostics.mcp.serverNames = Object.entries(mcpServers).map(([name, value]) => ({
    name,
    source: value.source,
  }));

  if (!mcpServers[PAPERCLIP_CORE_MCP_NAME]) {
    const stdioEntry = buildPaperclipMcpEntry({ env: input.env });
    if (stdioEntry) {
      mcpServers[PAPERCLIP_CORE_MCP_NAME] = { def: stdioEntry, source: "paperclip_core" };
      diagnostics.mcp.paperclipCoreCount = 1;
      diagnostics.mcp.serverNames = Object.entries(mcpServers).map(([name, v]) => ({ name, source: v.source }));
      notes.push("Injected per-run Paperclip MCP (stdio) with run-scoped identity.");
    }
  }

  // --- Curated plugins (opt-in only) ---
  const inheritedPluginCount = flags.inheritUserPlugins
    ? countPluginEntries(inheritedBase)
    : 0;
  diagnostics.plugins.inheritedPluginCount = inheritedPluginCount;

  // --- Assemble the curated config ---
  const nextConfig: Record<string, unknown> = {
    ...inheritedBase,
    permission: {
      ...existingPermission,
      external_directory: "allow",
    },
  };
  if (Object.keys(nextProvider).length > 0) {
    nextConfig.provider = nextProvider;
  }
  if (smallModel) {
    nextConfig.small_model = smallModel;
  }
  if (Object.keys(mcpServers).length > 0) {
    nextConfig.mcp = Object.fromEntries(
      Object.entries(mcpServers).map(([name, value]) => [name, value.def]),
    );
  }
  if (inheritedPluginCount > 0) {
    const plugins = inheritedBase.plugin ?? inheritedBase.plugins;
    if (plugins !== undefined) nextConfig.plugin = plugins;
    if (inheritedBase.plugins !== undefined) nextConfig.plugins = inheritedBase.plugins;
  }

  notes.push(
    `Curated managed OpenCode runtime config: mcp servers=${diagnostics.mcp.serverNames.length} (core=${diagnostics.mcp.paperclipCoreCount}, managed=${diagnostics.mcp.managedConnectionCount}, inherited=${diagnostics.mcp.inheritedUserMcpCount}), inherited plugins=${inheritedPluginCount}.`,
  );

  await fs.writeFile(
    runtimeConfigPath,
    `${JSON.stringify(nextConfig, null, 2)}\n`,
    "utf8",
  );

  input.diagnosticsSink?.(diagnostics);

  return {
    env: {
      ...input.env,
      XDG_CONFIG_HOME: runtimeConfigHome,
    },
    notes,
    cleanup: async () => {
      await fs.rm(runtimeConfigHome, { recursive: true, force: true });
    },
    diagnostics,
  };
}

function countPluginEntries(base: Record<string, unknown>): number {
  const plugin = base.plugin;
  const plugins = base.plugins;
  let count = 0;
  if (Array.isArray(plugin)) count += plugin.length;
  else if (typeof plugin === "string" && plugin.length > 0) count += 1;
  if (Array.isArray(plugins)) count += plugins.length;
  else if (typeof plugins === "string" && plugins.length > 0) count += 1;
  return count;
}
