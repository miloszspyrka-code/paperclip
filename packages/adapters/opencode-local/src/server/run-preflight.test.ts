import { describe, expect, it } from "vitest";
import {
  evaluateOpenCodeRunPreflight,
  EXECUTION_SURFACE_MISMATCH_CODE,
  MODEL_CONTRACT_MISMATCH_CODE,
  OpenCodeRunPreflightError,
  resolveOpenCodeRunContract,
} from "./run-preflight.js";

describe("resolveOpenCodeRunContract", () => {
  it("returns null for absent or empty contracts", () => {
    expect(resolveOpenCodeRunContract(undefined)).toBeNull();
    expect(resolveOpenCodeRunContract(null)).toBeNull();
    expect(resolveOpenCodeRunContract({})).toBeNull();
    expect(resolveOpenCodeRunContract("nope")).toBeNull();
  });

  it("keeps only recognized fields", () => {
    expect(
      resolveOpenCodeRunContract({
        model: "opencode/x-preview-f-free",
        requiresHostProjectConfig: true,
        minInheritedPlugins: 2,
        unknownJunk: "ignored",
      }),
    ).toEqual({
      model: "opencode/x-preview-f-free",
      requiresHostProjectConfig: true,
      minInheritedPlugins: 2,
    });
  });
});

describe("evaluateOpenCodeRunPreflight", () => {
  it("passes when no contract is declared (unchanged behavior)", () => {
    const result = evaluateOpenCodeRunPreflight({
      contract: undefined,
      resolvedModel: "",
      projectConfigDisabled: true,
      inheritedPluginCount: 0,
    });
    expect(result).toEqual({ ok: true, contract: null });
  });

  it("fails with MODEL_CONTRACT_MISMATCH when the resolved model differs from the required one", () => {
    const result = evaluateOpenCodeRunPreflight({
      contract: { model: "opencode/x-preview-f-free" },
      resolvedModel: "openai/gpt-4o-mini",
      projectConfigDisabled: true,
      inheritedPluginCount: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.mismatches).toHaveLength(1);
      expect(result.mismatches[0].code).toBe(MODEL_CONTRACT_MISMATCH_CODE);
      expect(result.mismatches[0].message).toContain("opencode/x-preview-f-free");
    }
  });

  it("fails with MODEL_CONTRACT_MISMATCH when no model is resolved but one is required", () => {
    const result = evaluateOpenCodeRunPreflight({
      contract: { model: "opencode/x-preview-f-free" },
      resolvedModel: "",
      projectConfigDisabled: null,
      inheritedPluginCount: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.mismatches.map((mismatch) => mismatch.code)).toEqual([
        MODEL_CONTRACT_MISMATCH_CODE,
      ]);
    }
  });

  it("passes the model check on an exact match", () => {
    const result = evaluateOpenCodeRunPreflight({
      contract: { model: "opencode/x-preview-f-free" },
      resolvedModel: "opencode/x-preview-f-free",
      projectConfigDisabled: false,
      inheritedPluginCount: 0,
    });
    expect(result.ok).toBe(true);
  });

  it("reproduces K134: host config required but the managed runtime isolates it", () => {
    const result = evaluateOpenCodeRunPreflight({
      contract: { requiresHostProjectConfig: true, minInheritedPlugins: 1 },
      resolvedModel: "opencode/x-preview-f-free",
      // K134 runtime evidence: OPENCODE_DISABLE_PROJECT_CONFIG=true, inheritedPluginCount=0.
      projectConfigDisabled: true,
      inheritedPluginCount: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.mismatches.map((mismatch) => mismatch.code)).toEqual([
        EXECUTION_SURFACE_MISMATCH_CODE,
        EXECUTION_SURFACE_MISMATCH_CODE,
      ]);
      expect(result.mismatches[0].message).toContain("OPENCODE_DISABLE_PROJECT_CONFIG");
      expect(result.mismatches[1].message).toContain("inherited plugin");
    }
  });

  it("allows a task requiring host config when the runtime proves inheritance", () => {
    const result = evaluateOpenCodeRunPreflight({
      contract: { requiresHostProjectConfig: true, minInheritedPlugins: 2 },
      resolvedModel: "opencode/x-preview-f-free",
      projectConfigDisabled: false,
      inheritedPluginCount: 3,
    });
    expect(result.ok).toBe(true);
  });

  it("fails closed when the runtime does not report surface facts", () => {
    const result = evaluateOpenCodeRunPreflight({
      contract: { requiresHostProjectConfig: true },
      resolvedModel: "opencode/x-preview-f-free",
      projectConfigDisabled: null,
      inheritedPluginCount: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.mismatches[0].code).toBe(EXECUTION_SURFACE_MISMATCH_CODE);
    }
  });

  it("builds a typed error carrying the first mismatch code", () => {
    const error = new OpenCodeRunPreflightError([
      { code: MODEL_CONTRACT_MISMATCH_CODE, message: "model drift" },
      { code: EXECUTION_SURFACE_MISMATCH_CODE, message: "surface" },
    ]);
    expect(error.code).toBe(MODEL_CONTRACT_MISMATCH_CODE);
    expect(error.message).toContain("before inference");
    expect(error.message).toContain("model drift");
  });
});
