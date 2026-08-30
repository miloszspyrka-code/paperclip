import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asBoolean, parseObject } from "@paperclipai/adapter-utils/server-utils";

type PreparedOpenCodeRuntimeConfig = {
  env: Record<string, string>;
  notes: string[];
  /**
   * Per-run runtime diagnostics for cost review: BEFORE/AFTER tool-surface
   * measurement (and removals) surfaced with the invocation meta as
   * `runtimeDiagnostics.mcp.serverNames`. Empty when no MCP map is configured.
   */
  runtimeDiagnostics: OpenCodeRuntimeDiagnostics;
  cleanup: () => Promise<void>;
};

export interface OpenCodeRuntimeDiagnostics {
  mcp?: {
    serverNames: {
      before: string[];
      after: string[];
    };
    removedByAllowlist: string[];
    removedByDenylist: string[];
    removedAsAliases: string[];
    /**
     * Eager-minimal task scope (KOMAA-126): the servers that actually load
     * BEFORE inference for this task. Whens a task declares an `mcpScope` the
     * runtime eagerly loads only those servers and DEFERS every irrelevant one,
     * so the model never pays for an unrelated tool surface at bootstrap.
     */
    eagerServerNames: string[];
    /**
     * Servers deferred from BEFORE-inference load because they are outside the
     * task-declared `mcpScope`. They stay absent from the enabled surface until
     * the task explicitly needs them (progressive disclosure), not silently
     * dropped forever.
     */
    deferredIrrelevant: string[];
  };
  /**
   * Resolved execution-surface facts for the deterministic run preflight
   * (KOMAA-126): whether host/global project config is disabled for the
   * managed runtime and how many host plugin files were inherited into the
   * runtime config snapshot.
   */
  executionSurface?: {
    projectConfigDisabled: boolean;
    inheritedPluginCount: number;
  };
}

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

export interface OpenCodeMcpToolSurfaceFilter {
  /** When set, only these MCP server keys stay enabled for the run. */
  allowlist: ReadonlySet<string> | null;
  /** MCP server keys dropped even when no allowlist is configured. */
  denylist: ReadonlySet<string>;
  active: boolean;
}

function parseNameList(value: unknown): string[] | null {
  let entries: unknown[];
  if (typeof value === "string") {
    entries = value.split(",");
  } else if (Array.isArray(value)) {
    entries = value;
  } else {
    return null;
  }
  const names = entries
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
  return names.length > 0 ? Array.from(new Set(names)) : null;
}

/**
 * Resolve the per-run MCP tool-surface filter from agent config
 * (`toolSurface.mcpAllowlist` / `toolSurface.mcpDenylist`) or run env
 * (`PAPERCLIP_OPENCODE_MCP_ALLOWLIST` / `PAPERCLIP_OPENCODE_MCP_DENYLIST`).
 * Unset on both sides means "no filtering": every configured server stays
 * enabled, preserving existing behavior.
 */
export function resolveOpenCodeMcpToolSurfaceFilter(input: {
  config: Record<string, unknown>;
  env: Record<string, string | undefined>;
}): OpenCodeMcpToolSurfaceFilter {
  const resolveEnv = (name: string): string | undefined => input.env[name] ?? process.env[name];
  const rawToolSurface = isPlainObject(input.config.toolSurface) ? input.config.toolSurface : {};
  const rawAllowlist =
    parseNameList(rawToolSurface.mcpAllowlist) ?? parseNameList(resolveEnv("PAPERCLIP_OPENCODE_MCP_ALLOWLIST"));
  const rawDenylist =
    parseNameList(rawToolSurface.mcpDenylist) ?? parseNameList(resolveEnv("PAPERCLIP_OPENCODE_MCP_DENYLIST"));
  const denylist = new Set(rawDenylist ?? []);
  const allowlist = rawAllowlist ? new Set(rawAllowlist) : null;
  return { allowlist, denylist, active: allowlist !== null || denylist.size > 0 };
}

/** Stable identity of an MCP server definition used to collapse duplicates. */
function mcpServerSignature(entry: unknown): string {
  if (!isPlainObject(entry)) return typeof entry === "string" ? `raw:${entry}` : "unknown";
  if (typeof entry.url === "string" && entry.url.trim()) {
    return `remote:${entry.type === "string" ? entry.type : ""}:${entry.url.trim()}`;
  }
  if (typeof entry.command === "string" && entry.command.trim()) {
    return `local:${entry.command.trim()}:${JSON.stringify(Array.isArray(entry.args) ? entry.args : [])}`;
  }
  return `json:${JSON.stringify(entry)}`;
}

export interface AppliedOpenCodeMcpToolSurfaceResult {
  next: Record<string, unknown> | null;
  beforeCount: number;
  afterCount: number;
  beforeServerNames: string[];
  afterServerNames: string[];
  removedByAllowlist: string[];
  removedByDenylist: string[];
  removedAsAliases: string[];
}

/**
 * Apply the resolved filter to an opencode.json `mcp` map and collapse
 * compatibility aliases: multiple keys pointing at the identical server
 * definition keep only one canonical entry (the lexicographically first key),
 * so the model sees a single execution path instead of duplicated tools.
 * Alias collapsing only happens when a filter is explicitly configured.
 */
export function applyOpenCodeMcpToolSurface(
  mcp: unknown,
  filter: OpenCodeMcpToolSurfaceFilter,
): AppliedOpenCodeMcpToolSurfaceResult {
  const result: AppliedOpenCodeMcpToolSurfaceResult = {
    next: null,
    beforeCount: 0,
    afterCount: 0,
    beforeServerNames: [],
    afterServerNames: [],
    removedByAllowlist: [],
    removedByDenylist: [],
    removedAsAliases: [],
  };
  if (!isPlainObject(mcp)) return result;

  const entries = Object.entries(mcp).filter(([, value]) => value !== null && value !== undefined);
  result.beforeCount = entries.length;
  result.beforeServerNames = entries.map(([key]) => key);

  const filtered = entries.filter(([key]) => {
    if (filter.allowlist && !filter.allowlist.has(key)) {
      result.removedByAllowlist.push(key);
      return false;
    }
    if (filter.denylist.has(key)) {
      result.removedByDenylist.push(key);
      return false;
    }
    return true;
  });

  const kept = [...filtered];
  if (filter.active && filtered.length > 1) {
    const canonicalByKey = new Map<string, string>();
    const sortedKeys = filtered.map(([key]) => key).sort();
    const entryByKey = new Map(filtered);
    for (const key of sortedKeys) {
      const signature = mcpServerSignature(entryByKey.get(key));
      const canonical = canonicalByKey.get(signature);
      if (canonical === undefined) {
        canonicalByKey.set(signature, key);
        continue;
      }
      result.removedAsAliases.push(`${key} (= ${canonical})`);
    }
    const aliased = new Set(result.removedAsAliases.map((alias) => alias.split(" ")[0]));
    const nextEntries = filtered.filter(([key]) => !aliased.has(key));
    kept.length = 0;
    kept.push(...nextEntries);
  }

  // Null means "no change": callers leave the configured mcp map untouched.
  result.next = kept.length !== entries.length ? Object.fromEntries(kept) : null;
  result.afterCount = kept.length;
  result.afterServerNames = kept.map(([key]) => key);
  return result;
}

/**
 * Eager-minimal task scope (KOMAA-126): a task may declare the subset of MCP
 * servers relevant to it. When it does, only those servers load BEFORE
 * inference and every other configured server is deferred (progressive
 * disclosure) instead of padding the bootstrap tool surface. Absent scope =
 * unchanged behavior (all configured servers load eagerly).
 *
 * Resolution priority: task-declared `wake.mcpScope` (per-run, most specific)
 * > agent config `toolSurface.mcpScope` > env `PAPERCLIP_OPENCODE_EAGER_MCP_SCOPE`.
 */
export interface OpenCodeEagerMcpScope {
  relevantServerKeys: ReadonlySet<string> | null;
  active: boolean;
}

export function resolveOpenCodeEagerMcpScope(input: {
  config: Record<string, unknown>;
  env: Record<string, string | undefined>;
  wake?: unknown;
}): OpenCodeEagerMcpScope {
  const resolveEnv = (name: string): string | undefined => input.env[name] ?? process.env[name];
  const wakeScope = parseNameList(parseObject(input.wake).mcpScope);
  const rawToolSurface = isPlainObject(input.config.toolSurface) ? input.config.toolSurface : {};
  const configScope = parseNameList(rawToolSurface.mcpScope);
  const envScope = parseNameList(resolveEnv("PAPERCLIP_OPENCODE_EAGER_MCP_SCOPE"));
  const scope = wakeScope ?? configScope ?? envScope;
  if (!scope) return { relevantServerKeys: null, active: false };
  return { relevantServerKeys: new Set(scope), active: true };
}

export interface AppliedOpenCodeEagerMcpResult {
  /** Filtered map to write into the runtime config (null = no change). */
  next: Record<string, unknown> | null;
  /** Servers that load before inference under the eager scope. */
  eagerServerNames: string[];
  /** Configured servers deferred from before-inference load. */
  deferredIrrelevant: string[];
}

/**
 * Apply the eager-minimal task scope to an `mcp` map: keep only the servers in
 * the relevant set; record the rest as deferred. Pure and deterministic so the
 * deferred set is both testable and reproducible across runs.
 */
export function applyOpenCodeEagerMinimalMcpSurface(
  mcp: unknown,
  scope: OpenCodeEagerMcpScope,
): AppliedOpenCodeEagerMcpResult {
  const empty: AppliedOpenCodeEagerMcpResult = {
    next: null,
    eagerServerNames: [],
    deferredIrrelevant: [],
  };
  if (!isPlainObject(mcp)) return empty;
  const entries = Object.entries(mcp).filter(([, value]) => value !== null && value !== undefined);
  if (!scope.active || scope.relevantServerKeys === null) {
    return {
      next: null,
      eagerServerNames: entries.map(([key]) => key),
      deferredIrrelevant: [],
    };
  }
  const kept = entries.filter(([key]) => scope.relevantServerKeys!.has(key));
  const deferred = entries.filter(([key]) => !scope.relevantServerKeys!.has(key)).map(([key]) => key);
  return {
    next: kept.length !== entries.length ? Object.fromEntries(kept) : null,
    eagerServerNames: kept.map(([key]) => key),
    deferredIrrelevant: deferred,
  };
}

function openCodeRuntimeDiagnosticsFromToolSurface(
  toolSurfaceResult: AppliedOpenCodeMcpToolSurfaceResult,
  eagerResult: AppliedOpenCodeEagerMcpResult,
  eagerActive: boolean,
): OpenCodeRuntimeDiagnostics {
  if (toolSurfaceResult.beforeCount === 0 && !eagerActive) return {};
  return {
    mcp: {
      serverNames: {
        before: [...toolSurfaceResult.beforeServerNames],
        after: [...toolSurfaceResult.afterServerNames],
      },
      removedByAllowlist: [...toolSurfaceResult.removedByAllowlist],
      removedByDenylist: [...toolSurfaceResult.removedByDenylist],
      removedAsAliases: [...toolSurfaceResult.removedAsAliases],
      eagerServerNames: [...eagerResult.eagerServerNames],
      deferredIrrelevant: [...eagerResult.deferredIrrelevant],
    },
  };
}

export async function prepareOpenCodeRuntimeConfig(input: {
  env: Record<string, string>;
  config: Record<string, unknown>;
  /** Task wake payload; when it declares `mcpScope` the runtime loads only those servers before inference. */
  wake?: unknown;
  targetIsRemote?: boolean;
}): Promise<PreparedOpenCodeRuntimeConfig> {
  const skipPermissions = asBoolean(input.config.dangerouslySkipPermissions, true);
  if (!skipPermissions) {
    return {
      env: input.env,
      notes: [],
      runtimeDiagnostics: {},
      cleanup: async () => {},
    };
  }

  // For remote execution targets the host XDG_CONFIG_HOME path is meaningless
  // (and actively harmful — it leaks a macOS-only path into the remote Linux
  // env). Callers that need to ship a runtime opencode config to the remote
  // box do that via prepareAdapterExecutionTargetRuntime in execute.ts; this
  // host-fs helper is local-only.
  if (input.targetIsRemote) {
    return {
      env: input.env,
      notes: [],
      runtimeDiagnostics: {},
      cleanup: async () => {},
    };
  }

  const sourceConfigDir = path.join(resolveXdgConfigHome(input.env), "opencode");
  const runtimeConfigHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-config-"));
  const runtimeConfigDir = path.join(runtimeConfigHome, "opencode");
  const runtimeConfigPath = path.join(runtimeConfigDir, "opencode.json");

  await fs.mkdir(runtimeConfigDir, { recursive: true });
  try {
    await fs.cp(sourceConfigDir, runtimeConfigDir, {
      recursive: true,
      force: true,
      errorOnExist: false,
      dereference: false,
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code !== "ENOENT") {
      throw err;
    }
  }

  const existingConfig = await readJsonObject(runtimeConfigPath);
  const existingPermission = isPlainObject(existingConfig.permission)
    ? existingConfig.permission
    : {};
  const notes = [
    "Injected runtime OpenCode config with permission.external_directory=allow to avoid headless approval prompts.",
  ];

  // Merge gateway/custom provider definitions supplied via PAPERCLIP_OPENCODE_PROVIDERS
  // (a JSON object in OpenCode's `provider` shape). OpenCode resolves a `--model
  // provider/model` only when that model exists in a provider's `models` map, and
  // OPENCODE_ALLOW_ALL_MODELS does NOT bypass its internal getModel(). So routing a
  // gateway model (e.g. an EU LLM gateway exposing OpenAI-compatible /v1) requires a
  // custom provider with an explicit models map. We accept it as config (not
  // hard-coded) so the gateway URL, key env, and model list stay declarative.
  const resolveEnv = (name: string): string | undefined => input.env[name] ?? process.env[name];
  const gatewayProviders = parseProviderConfig(
    input.env.PAPERCLIP_OPENCODE_PROVIDERS ?? process.env.PAPERCLIP_OPENCODE_PROVIDERS,
    resolveEnv,
    notes,
  );
  const existingProvider = isPlainObject(existingConfig.provider) ? existingConfig.provider : {};
  let nextProvider = gatewayProviders
    ? { ...existingProvider, ...gatewayProviders }
    : existingProvider;
  if (gatewayProviders) {
    notes.push(
      `Injected ${Object.keys(gatewayProviders).length} custom OpenCode provider(s) from PAPERCLIP_OPENCODE_PROVIDERS: ${Object.keys(gatewayProviders).join(", ")}.`,
    );
  }

  // Register the configured model on its provider's models map. OpenCode resolves
  // `--model provider/model` only when the model id exists in that map, so ids the
  // models.dev catalog does not carry — OpenRouter routing variants such as
  // `openai/gpt-oss-120b:nitro`, or models newer than the bundled catalog — are
  // otherwise rejected with "Model not found" even though the provider serves them.
  // An empty entry deep-merges with catalog metadata, so this is a no-op for models
  // the catalog already knows, and we never clobber an explicit definition from the
  // user config or PAPERCLIP_OPENCODE_PROVIDERS.
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

  const nextConfig: Record<string, unknown> = {
    ...existingConfig,
    permission: {
      ...existingPermission,
      external_directory: "allow",
    },
  };
  if (Object.keys(nextProvider).length > 0) {
    nextConfig.provider = nextProvider;
  }

  // Eager-minimal task scope (KOMAA-126): a task-declared mcpScope defers every
  // irrelevant server from BEFORE-inference load (progressive disclosure) so the
  // bootstrap tool surface carries only what this task can use. The deferred set
  // is recorded in diagnostics and never silently dropped.
  const eagerScope = resolveOpenCodeEagerMcpScope({ config: input.config, env: input.env, wake: input.wake });
  const eagerResult = applyOpenCodeEagerMinimalMcpSurface(existingConfig.mcp, eagerScope);
  const mcpAfterEager = eagerResult.next ?? existingConfig.mcp;

  // Measure and optionally constrain the per-run MCP tool surface. Without an
  // explicit allow/deny configuration every configured server stays enabled
  // (unchanged behavior); the measurement note is always emitted so runs carry
  // BEFORE/AFTER tool-surface metrics for cost review.
  const toolSurfaceFilter = resolveOpenCodeMcpToolSurfaceFilter({ config: input.config, env: input.env });
  const toolSurfaceResult = applyOpenCodeMcpToolSurface(mcpAfterEager, toolSurfaceFilter);
  if (eagerScope.active || toolSurfaceResult.beforeCount > 0 || toolSurfaceFilter.active) {
    const beforeCount = toolSurfaceResult.beforeCount;
    if (eagerScope.active) {
      notes.push(
        `Eager-minimal MCP scope: ${eagerResult.eagerServerNames.length} relevant server(s) load before inference` +
          `${eagerResult.deferredIrrelevant.length ? `; deferred irrelevant: ${eagerResult.deferredIrrelevant.join(", ")}` : ""}.`,
      );
    }
    notes.push(
      `MCP tool surface: ${beforeCount} server(s) configured -> ${toolSurfaceResult.afterCount} enabled` +
        `${toolSurfaceResult.removedByAllowlist.length ? `; allowlist removed: ${toolSurfaceResult.removedByAllowlist.join(", ")}` : ""}` +
        `${toolSurfaceResult.removedByDenylist.length ? `; denylist removed: ${toolSurfaceResult.removedByDenylist.join(", ")}` : ""}` +
        `${toolSurfaceResult.removedAsAliases.length ? `; duplicate aliases collapsed: ${toolSurfaceResult.removedAsAliases.join(", ")}` : ""}` +
        `.`,
    );
    if (eagerResult.next !== null) {
      nextConfig.mcp = eagerResult.next;
    }
    if (toolSurfaceResult.next !== null) {
      nextConfig.mcp = toolSurfaceResult.next;
    }
  }

  // Pin OpenCode's auxiliary "small" model (used for session-title generation and
  // other helper tasks) via PAPERCLIP_OPENCODE_SMALL_MODEL. OpenCode otherwise
  // defaults the small model to a built-in provider default (e.g. a claude-* model
  // for the anthropic provider); when that provider is repointed at a gateway that
  // does not serve that exact model, the title-gen call fails and aborts the run.
  // Setting small_model to a gateway-served model keeps every call on supported models.
  const smallModel = (input.env.PAPERCLIP_OPENCODE_SMALL_MODEL ?? process.env.PAPERCLIP_OPENCODE_SMALL_MODEL)?.trim();
  if (smallModel) {
    nextConfig.small_model = smallModel;
    notes.push(`Pinned OpenCode small_model to ${smallModel}.`);
  }
  await fs.writeFile(runtimeConfigPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");

  // Measure the host plugin surface inherited into this runtime snapshot.
  // OpenCode loads plugins from <config>/plugin; the managed runtime copies the
  // host config dir, so the count here is what the run can actually inherit
  // (0 when OPENCODE_DISABLE_PROJECT_CONFIG keeps host config isolated).
  const inheritedPluginCount = await fs
    .readdir(path.join(runtimeConfigDir, "plugin"), { withFileTypes: true })
    .then((entries) => entries.length)
    .catch(() => 0);

  return {
    env: {
      ...input.env,
      XDG_CONFIG_HOME: runtimeConfigHome,
    },
    notes,
    runtimeDiagnostics: {
      ...openCodeRuntimeDiagnosticsFromToolSurface(toolSurfaceResult, eagerResult, eagerScope.active),
      executionSurface: {
        projectConfigDisabled: true,
        inheritedPluginCount,
      },
    },
    cleanup: async () => {
      await fs.rm(runtimeConfigHome, { recursive: true, force: true });
    },
  };
}
