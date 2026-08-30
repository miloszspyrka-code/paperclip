/**
 * Deterministic run preflight for opencode_local (KOMAA-126 / KOMAA-134).
 *
 * Before OpenCode is spawned (i.e. before any model-backed inference), the
 * task-declared execution contract is compared against what this runtime can
 * actually resolve. A mismatch fails the run immediately with a typed code
 * instead of burning a full-price model bootstrap that cannot satisfy the
 * task (K134: task required host/global OpenCode config while the synthetic
 * runtime ran with OPENCODE_DISABLE_PROJECT_CONFIG=true and zero inherited
 * plugins; likewise a required provider/model that differs from the resolved
 * one must fail as MODEL_CONTRACT_MISMATCH before inference).
 *
 * The contract arrives through run context (`paperclipRunContract`) which the
 * control plane copies from the wake payload when the task declares one.
 * Absent contract = no gate (unchanged behavior).
 */

export const MODEL_CONTRACT_MISMATCH_CODE = "MODEL_CONTRACT_MISMATCH";
export const EXECUTION_SURFACE_MISMATCH_CODE = "EXECUTION_SURFACE_MISMATCH";

/** Task-declared execution requirements for a single run. */
export interface OpenCodeRunContract {
  /** Required provider/model id (e.g. "opencode/x-preview-f-free"). */
  model?: string;
  /**
   * Task requires host/global OpenCode project config (plugins, custom
   * settings) to be inherited. The managed runtime deliberately isolates host
   * config, so declaring this on an isolated runtime is a hard mismatch.
   */
  requiresHostProjectConfig?: boolean;
  /** Minimum number of plugins the runtime must inherit from host config. */
  minInheritedPlugins?: number;
}

export interface OpenCodeRunPreflightMismatch {
  code: typeof MODEL_CONTRACT_MISMATCH_CODE | typeof EXECUTION_SURFACE_MISMATCH_CODE;
  message: string;
}

export interface OpenCodeRunPreflightInput {
  contract: unknown;
  /** Model id that will be passed to `opencode run --model` ("" = unset). */
  resolvedModel: string;
  /**
   * Whether the runtime disables host/global project config. Null = the
   * runtime did not report the fact; a task requiring host config fails
   * closed.
   */
  projectConfigDisabled: boolean | null;
  /**
   * Plugins inherited into the runtime snapshot. Null = unknown/unreported;
   * a minimum requirement fails closed.
   */
  inheritedPluginCount: number | null;
}

export type OpenCodeRunPreflightResult =
  | { ok: true; contract: OpenCodeRunContract | null }
  | { ok: false; contract: OpenCodeRunContract; mismatches: OpenCodeRunPreflightMismatch[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readNonNegativeInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** Parse the task-declared contract out of run context; null when absent. */
export function resolveOpenCodeRunContract(contextValue: unknown): OpenCodeRunContract | null {
  if (!isPlainObject(contextValue)) return null;
  const model = readNonEmptyString(contextValue.model);
  const requiresHostProjectConfig = readBoolean(contextValue.requiresHostProjectConfig);
  const minInheritedPlugins = readNonNegativeInt(contextValue.minInheritedPlugins);
  if (
    model === null &&
    requiresHostProjectConfig === null &&
    minInheritedPlugins === null
  ) {
    return null;
  }
  return {
    ...(model ? { model } : {}),
    ...(requiresHostProjectConfig !== null ? { requiresHostProjectConfig } : {}),
    ...(minInheritedPlugins !== null ? { minInheritedPlugins } : {}),
  };
}

/**
 * Compare the required contract against the resolved runtime. Pure and
 * deterministic — no probing, no policy engine, just field comparison so a
 * doomed run dies before inference.
 */
export function evaluateOpenCodeRunPreflight(
  input: OpenCodeRunPreflightInput,
): OpenCodeRunPreflightResult {
  const contract = resolveOpenCodeRunContract(input.contract);
  if (!contract) return { ok: true, contract: null };

  const mismatches: OpenCodeRunPreflightMismatch[] = [];
  if (contract.model) {
    const resolvedModel = input.resolvedModel.trim();
    if (!resolvedModel || resolvedModel !== contract.model) {
      mismatches.push({
        code: MODEL_CONTRACT_MISMATCH_CODE,
        message:
          `Task requires model "${contract.model}" but the runtime resolved ` +
          `"${resolvedModel || "<default/unset>"}"`,
      });
    }
  }
  if (
    contract.requiresHostProjectConfig === true &&
    input.projectConfigDisabled !== false
  ) {
    mismatches.push({
      code: EXECUTION_SURFACE_MISMATCH_CODE,
      message:
        "Task requires host/global OpenCode project config but the managed runtime does not inherit it " +
        "(OPENCODE_DISABLE_PROJECT_CONFIG=true or inheritance unreported)",
    });
  }
  if (
    typeof contract.minInheritedPlugins === "number" &&
    (input.inheritedPluginCount === null || input.inheritedPluginCount < contract.minInheritedPlugins)
  ) {
    mismatches.push({
      code: EXECUTION_SURFACE_MISMATCH_CODE,
      message:
        `Task requires at least ${contract.minInheritedPlugins} inherited plugin(s) but the ` +
        `runtime snapshot carries ${input.inheritedPluginCount ?? "an unreported number of"} plugin(s)`,
    });
  }

  if (mismatches.length === 0) return { ok: true, contract };
  return { ok: false, contract, mismatches };
}

export class OpenCodeRunPreflightError extends Error {
  readonly code: string;
  readonly mismatches: OpenCodeRunPreflightMismatch[];

  constructor(mismatches: OpenCodeRunPreflightMismatch[]) {
    super(
      `OpenCode run preflight failed before inference: ${mismatches
        .map((mismatch) => `[${mismatch.code}] ${mismatch.message}`)
        .join("; ")}`,
    );
    this.name = "OpenCodeRunPreflightError";
    this.code = mismatches[0]?.code ?? "RUN_PREFLIGHT_MISMATCH";
    this.mismatches = mismatches;
  }
}
