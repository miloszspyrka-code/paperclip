import { describe, expect, it } from "vitest";
import {
  authorizePublication,
  BRANCH_TEMPLATE_MALFORMED_CODE,
  buildPublicationPolicyDirective,
  detectWorkspaceTopologyMutation,
  deriveContractRequirementFromProjectPolicy,
  PUBLICATION_DENIED_CODE,
  resolveBranchTemplate,
  validateBranchTemplate,
  validateExecutionWorkspaceContract,
  WORKSPACE_CONTRACT_MISMATCH_CODE,
  WORKSPACE_TOPOLOGY_SELF_HEAL_CODE,
} from "./execution-workspace-contract.js";

describe("validateExecutionWorkspaceContract ÔÇö invariant 1 (KOMAA-151 regression, acceptance A)", () => {
  it("rejects shared_workspace realization when contract requires isolated", () => {
    const result = validateExecutionWorkspaceContract({
      requirement: { mode: "isolated_workspace", strategyType: "git_worktree" },
      realized: { mode: "shared_workspace", source: "project_primary" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(WORKSPACE_CONTRACT_MISMATCH_CODE);
      expect(result.reason).toBe("realized_shared_workspace");
    }
  });

  it("rejects project_primary source when contract requires isolated", () => {
    const result = validateExecutionWorkspaceContract({
      requirement: { mode: "isolated_workspace", strategyType: "git_worktree" },
      realized: { mode: "isolated_workspace", source: "project_primary" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("realized_project_primary_source");
  });

  it("rejects operator checkout when contract requires isolated", () => {
    const result = validateExecutionWorkspaceContract({
      requirement: { mode: "isolated_workspace", strategyType: "git_worktree" },
      realized: { mode: "isolated_workspace", source: "task_session", isOperatorCheckout: true },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("realized_operator_checkout");
  });

  it("rejects a non-worktree source when contract requires git_worktree", () => {
    const result = validateExecutionWorkspaceContract({
      requirement: { mode: "isolated_workspace", strategyType: "git_worktree" },
      realized: { mode: "isolated_workspace", source: "adapter_managed" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing_isolated_worktree");
  });

  it("rejects missing expected branch in the realized worktree", () => {
    const result = validateExecutionWorkspaceContract({
      requirement: { mode: "isolated_workspace", strategyType: "git_worktree" },
      realized: {
        mode: "isolated_workspace",
        source: "git_worktree",
        expectedBranchName: "KOMAA-151",
        actualBranchName: null,
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing_expected_branch");
  });

  it("rejects a worktree on the wrong branch", () => {
    const result = validateExecutionWorkspaceContract({
      requirement: { mode: "isolated_workspace", strategyType: "git_worktree" },
      realized: {
        mode: "isolated_workspace",
        source: "git_worktree",
        expectedBranchName: "KOMAA-151",
        actualBranchName: "main",
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("worktree_branch_mismatch");
  });
});

describe("validateExecutionWorkspaceContract ÔÇö matching execution proceeds (acceptance B)", () => {
  it("allows a correctly realized isolated git_worktree", () => {
    const result = validateExecutionWorkspaceContract({
      requirement: { mode: "isolated_workspace", strategyType: "git_worktree" },
      realized: {
        mode: "isolated_workspace",
        source: "git_worktree",
        expectedBranchName: "KOMAA-151",
        actualBranchName: "KOMAA-151",
      },
    });
    expect(result).toEqual({ ok: true });
  });

  it("allows established operator_branch execution", () => {
    const result = validateExecutionWorkspaceContract({
      requirement: { mode: "operator_branch" },
      realized: { mode: "operator_branch", source: "project_primary", actualBranchName: "KOMAA-151" },
    });
    expect(result).toEqual({ ok: true });
  });
});

describe("validateExecutionWorkspaceContract ÔÇö shared flows (acceptance F)", () => {
  it("allows shared_workspace when the contract explicitly permits shared", () => {
    const result = validateExecutionWorkspaceContract({
      requirement: { mode: "shared_workspace", permitsSharedWorkspace: true },
      realized: { mode: "shared_workspace", source: "project_primary" },
    });
    expect(result).toEqual({ ok: true });
  });

  it("allows agent_default realized on a shared workspace (no global ban)", () => {
    const result = validateExecutionWorkspaceContract({
      requirement: { mode: "agent_default" },
      realized: { mode: "shared_workspace", source: "project_primary" },
    });
    expect(result).toEqual({ ok: true });
  });

  it("rejects shared realization when contract demands non-shared isolation", () => {
    const result = validateExecutionWorkspaceContract({
      requirement: { mode: "operator_branch" },
      realized: { mode: "shared_workspace", source: "project_primary" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("operator_branch_realized_shared");
  });
});

describe("detectWorkspaceTopologyMutation ÔÇö invariant 2 (acceptance C)", () => {
  it("flags git switch as self-heal", () => {
    expect(detectWorkspaceTopologyMutation("git switch -c KOMAA-151").ok).toBe(false);
  });
  it("flags git checkout -b as self-heal", () => {
    const r = detectWorkspaceTopologyMutation("git checkout -b KOMAA-151");
    expect(r.ok).toBe(false);
    expect(r.code).toBe(WORKSPACE_TOPOLOGY_SELF_HEAL_CODE);
  });
  it("flags git branch create as self-heal", () => {
    expect(detectWorkspaceTopologyMutation("git branch KOMAA-151").ok).toBe(false);
  });
  it("flags git worktree add as self-heal", () => {
    expect(detectWorkspaceTopologyMutation("git worktree add ../wt KOMAA-151").ok).toBe(false);
  });
  it("does not flag a read-only git status", () => {
    expect(detectWorkspaceTopologyMutation("git status --porcelain").ok).toBe(true);
  });
  it("does not flag the supported double-brace branch template", () => {
    expect(detectWorkspaceTopologyMutation("git commit -m '{{issue.identifier}} done'").ok).toBe(true);
  });
});

describe("authorizePublication ÔÇö invariant 3 default-deny (acceptance D)", () => {
  it("denies push when no capability is present", () => {
    const r = authorizePublication({ action: "push", repo: "paperclipai/paperclip" }, null);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe(PUBLICATION_DENIED_CODE);
      expect(r.reason).toBe("no_publication_capability");
    }
  });

  it("denies PR creation even when prompt/DOD says commit+push", () => {
    const r = authorizePublication({ action: "create_pr", repo: "paperclipai/paperclip" }, null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(PUBLICATION_DENIED_CODE);
  });

  it("denies merge when no capability is present", () => {
    expect(authorizePublication({ action: "merge" }, null).ok).toBe(false);
  });

  it("allows push only for the specifically authorized action/repo/ref", () => {
    const cap = { action: "push" as const, repo: "paperclipai/paperclip", ref: "KOMAA-151" };
    expect(authorizePublication({ action: "push", repo: "paperclipai/paperclip", ref: "KOMAA-151" }, cap).ok).toBe(true);
  });

  it("denies push to a different repo than authorized", () => {
    const cap = { action: "push" as const, repo: "paperclipai/paperclip" };
    const r = authorizePublication({ action: "push", repo: "octocat/other" }, cap);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("capability_repo_mismatch");
  });

  it("denies a different action than authorized", () => {
    const cap = { action: "push" as const, repo: "paperclipai/paperclip" };
    const r = authorizePublication({ action: "create_pr", repo: "paperclipai/paperclip" }, cap);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("capability_action_mismatch");
  });

  it("denies push to a different ref than authorized", () => {
    const cap = { action: "push" as const, repo: "paperclipai/paperclip", ref: "KOMAA-151" };
    const r = authorizePublication({ action: "push", repo: "paperclipai/paperclip", ref: "main" }, cap);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("capability_ref_mismatch");
  });
});

describe("validateBranchTemplate ÔÇö invariant 4 (acceptance E)", () => {
  it("rejects malformed literal {issueKey}", () => {
    const r = validateBranchTemplate("{issueKey}");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe(BRANCH_TEMPLATE_MALFORMED_CODE);
      expect(r.offendingPlaceholder).toBe("{issueKey}");
    }
  });

  it("rejects a template mixing a valid token with a malformed placeholder", () => {
    const r = validateBranchTemplate("{{issue.identifier}}-{issueKey}");
    expect(r.ok).toBe(false);
  });

  it("allows the legacy single-brace {slug} token (default template compatibility)", () => {
    expect(validateBranchTemplate("{{issue.identifier}}-{slug}").ok).toBe(true);
  });

  it("accepts the canonical {{issue.identifier}} template", () => {
    expect(validateBranchTemplate("{{issue.identifier}}").ok).toBe(true);
  });

  it("accepts empty/undefined template (default is applied by caller)", () => {
    expect(validateBranchTemplate("").ok).toBe(true);
    expect(validateBranchTemplate(undefined).ok).toBe(true);
    expect(validateBranchTemplate(null).ok).toBe(true);
  });

  it("resolveBranchTemplate interpolates {{issue.identifier}}", () => {
    expect(resolveBranchTemplate("{{issue.identifier}}-fix", { identifier: "KOMAA-151" })).toBe(
      "KOMAA-151-fix",
    );
  });

  it("resolveBranchTemplate leaves malformed placeholders verbatim", () => {
    expect(resolveBranchTemplate("{issueKey}", { identifier: "KOMAA-151" })).toBe("{issueKey}");
  });
});

describe("deriveContractRequirementFromProjectPolicy", () => {
  it("forces isolated when project policy is authoritative", () => {
    const r = deriveContractRequirementFromProjectPolicy({
      enabled: true,
      defaultMode: "isolated_workspace",
      allowIssueOverride: false,
      workspaceStrategyType: "git_worktree",
    });
    expect(r).toEqual({ mode: "isolated_workspace", strategyType: "git_worktree" });
  });

  it("does not force isolation when issue overrides are allowed", () => {
    const r = deriveContractRequirementFromProjectPolicy({
      enabled: true,
      defaultMode: "isolated_workspace",
      allowIssueOverride: true,
    });
    expect(r).toBeNull();
  });

  it("does not force isolation when disabled or not isolated default", () => {
    expect(
      deriveContractRequirementFromProjectPolicy({ enabled: false, defaultMode: "isolated_workspace" }),
    ).toBeNull();
    expect(
      deriveContractRequirementFromProjectPolicy({
        enabled: true,
        defaultMode: "shared_workspace",
        allowIssueOverride: false,
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Synthetic-identifier / synthetic-path coverage (mandatory: in addition to the
// regression-shaped fixtures above). No logic keys on these values; they exist
// to prove the gate is identifier-agnostic and project-agnostic.
// ---------------------------------------------------------------------------

const SYNTH_ID = "SYNTH-9f3a2c";
const SYNTH_REPO = "acme/atlas";
const SYNTH_WORKTREE = "/srv/paperclip-worktrees/synth-2c7b1d";

describe("validateExecutionWorkspaceContract ÔÇö synthetic identifiers (acceptance A/B/F)", () => {
  it("rejects a synthetic shared realization when contract requires isolated", () => {
    const result = validateExecutionWorkspaceContract({
      requirement: { mode: "isolated_workspace", strategyType: "git_worktree" },
      realized: { mode: "shared_workspace", source: "project_primary", worktreePath: SYNTH_WORKTREE },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(WORKSPACE_CONTRACT_MISMATCH_CODE);
  });

  it("allows a correctly realized isolated git_worktree addressed by synthetic path", () => {
    const result = validateExecutionWorkspaceContract({
      requirement: { mode: "isolated_workspace", strategyType: "git_worktree" },
      realized: {
        mode: "isolated_workspace",
        source: "git_worktree",
        worktreePath: SYNTH_WORKTREE,
        expectedBranchName: SYNTH_ID,
        actualBranchName: SYNTH_ID,
      },
    });
    expect(result).toEqual({ ok: true });
  });

  it("allows shared_workspace with a synthetic path when explicitly permitted", () => {
    const result = validateExecutionWorkspaceContract({
      requirement: { mode: "shared_workspace", permitsSharedWorkspace: true },
      realized: { mode: "shared_workspace", source: "project_primary", worktreePath: SYNTH_WORKTREE },
    });
    expect(result).toEqual({ ok: true });
  });
});

describe("detectWorkspaceTopologyMutation ÔÇö synthetic commands (acceptance C)", () => {
  it("flags git worktree add with a synthetic path", () => {
    const r = detectWorkspaceTopologyMutation(`git worktree add ${SYNTH_WORKTREE} ${SYNTH_ID}`);
    expect(r.ok).toBe(false);
    expect(r.code).toBe(WORKSPACE_TOPOLOGY_SELF_HEAL_CODE);
  });

  it("flags git checkout -b with a synthetic branch name", () => {
    expect(detectWorkspaceTopologyMutation(`git checkout -b ${SYNTH_ID}`).ok).toBe(false);
  });

  it("does not flag a synthetic read-only status command", () => {
    expect(detectWorkspaceTopologyMutation(`git -C ${SYNTH_WORKTREE} status --porcelain`).ok).toBe(true);
  });
});

describe("authorizePublication ÔÇö synthetic repo/ref (acceptance D)", () => {
  it("denies push to a synthetic repo when no capability is present", () => {
    const r = authorizePublication({ action: "push", repo: SYNTH_REPO, ref: SYNTH_ID }, null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(PUBLICATION_DENIED_CODE);
  });

  it("allows push only for the specifically authorized synthetic repo/ref", () => {
    const cap = { action: "push" as const, repo: SYNTH_REPO, ref: SYNTH_ID };
    expect(authorizePublication({ action: "push", repo: SYNTH_REPO, ref: SYNTH_ID }, cap).ok).toBe(true);
  });

  it("denies a different ref on the authorized synthetic repo", () => {
    const cap = { action: "push" as const, repo: SYNTH_REPO, ref: SYNTH_ID };
    const r = authorizePublication({ action: "push", repo: SYNTH_REPO, ref: "release" }, cap);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("capability_ref_mismatch");
  });
});

describe("validateBranchTemplate ÔÇö synthetic placeholders (acceptance E)", () => {
  it("rejects an unresolved {ticketId} placeholder", () => {
    const r = validateBranchTemplate("{ticketId}");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe(BRANCH_TEMPLATE_MALFORMED_CODE);
      expect(r.offendingPlaceholder).toBe("{ticketId}");
    }
  });

  it("resolves a synthetic branch name from {{issue.identifier}}", () => {
    expect(resolveBranchTemplate("{{issue.identifier}}-synth", { identifier: SYNTH_ID })).toBe(
      `${SYNTH_ID}-synth`,
    );
  });
});

describe("buildPublicationPolicyDirective - invariant 3 runtime prompt gate", () => {
  it("emits a default-deny directive when no capability is present", () => {
    const directive = buildPublicationPolicyDirective(null);
    expect(directive).toContain("[paperclip] Publication policy");
    expect(directive).toContain("default-deny");
    expect(directive).toContain("git push");
    expect(directive).toContain("pull request");
    expect(directive).toContain("merge");
  });

  it("does not mention authorization when default-denied", () => {
    const directive = buildPublicationPolicyDirective(undefined);
    expect(directive).toContain("NOT authorized to publish");
  });

  it("authorizes only the specific action when a capability is present", () => {
    const directive = buildPublicationPolicyDirective({
      action: "push",
      repo: SYNTH_REPO,
      ref: SYNTH_ID,
    });
    expect(directive).toContain(`"push"`);
    expect(directive).toContain(SYNTH_REPO);
    expect(directive).toContain(SYNTH_ID);
    expect(directive).toContain("authorized ONLY");
  });

  it("does not over-authorize other actions when a capability is present", () => {
    const directive = buildPublicationPolicyDirective({ action: "create_pr", repo: SYNTH_REPO });
    expect(directive).toContain(`"create_pr"`);
    expect(directive).not.toContain("git push");
  });
});
