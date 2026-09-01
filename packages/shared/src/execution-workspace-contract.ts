// Server-side execution workspace contract gate.
//
// This module is the single source of truth for the five mandatory execution
// architecture invariants that govern isolated-workspace execution:
//   1) SERVER-SIDE WORKSPACE CONTRACT GATE BEFORE FIRST MODEL/TOOL WRITE
//   2) PAPERCLIP-ONLY TOPOLOGY OWNERSHIP (no agent self-heal of git topology)
//   3) PUBLICATION AUTHORIZATION IS SEPARATE AND DEFAULT-DENY
//   4) BRANCH TEMPLATE VALIDATION
//   5) OBSERVABILITY (stable codes + machine-readable detail for telemetry)
//
// Every decision returns a stable `code` so downstream telemetry, recovery
// routing, and regression tests can match on it deterministically. The
// functions are pure so they can be fault-injected directly in unit tests
// without a git checkout. The logic is identifier-agnostic and project-agnostic:
// no branch name, issue key, or repository path is treated specially.

export const WORKSPACE_CONTRACT_MISMATCH_CODE = "WORKSPACE_CONTRACT_MISMATCH";
export const PUBLICATION_DENIED_CODE = "PUBLICATION_DENIED";
export const BRANCH_TEMPLATE_MALFORMED_CODE = "BRANCH_TEMPLATE_MALFORMED";
export const WORKSPACE_TOPOLOGY_SELF_HEAL_CODE = "WORKSPACE_TOPOLOGY_SELF_HEAL";

export type ContractWorkspaceMode =
  | "isolated_workspace"
  | "shared_workspace"
  | "operator_branch"
  | "agent_default";

export type ContractWorkspaceStrategy =
  | "git_worktree"
  | "project_primary"
  | "adapter_managed"
  | "cloud_sandbox";

export interface WorkspaceContractRequirement {
  mode: ContractWorkspaceMode;
  strategyType?: ContractWorkspaceStrategy;
  /**
   * When true the task/agent contract explicitly permits a realized
   * shared_workspace (invariant F). When false, a realized shared workspace is
   * only valid if the contract does not require isolation.
   */
  permitsSharedWorkspace?: boolean;
}

export interface RealizedExecutionWorkspace {
  mode?: string | null;
  /** Resolved workspace source: project_primary | git_worktree | adapter_managed | cloud_sandbox | task_session. */
  source?: string | null;
  /** True when the cwd is the operator's base repository checkout (the configured base branch). */
  isOperatorCheckout?: boolean;
  expectedBranchName?: string | null;
  actualBranchName?: string | null;
  worktreePath?: string | null;
  repoRoot?: string | null;
}

export type WorkspaceContractDecision =
  | { ok: true }
  | {
      ok: false;
      code: typeof WORKSPACE_CONTRACT_MISMATCH_CODE;
      reason: string;
      detail: Record<string, unknown>;
    };

function contractMismatch(
  reason: string,
  detail: Record<string, unknown>,
): WorkspaceContractDecision {
  return {
    ok: false,
    code: WORKSPACE_CONTRACT_MISMATCH_CODE,
    reason,
    detail,
  };
}

/**
 * Invariant 1 + F. Fail closed before any model inference or mutating tool
 * call when the authoritative task/agent/project contract requires isolated
 * execution but the resolved/persisted/realized workspace is shared, on the
 * operator checkout, on the project_primary base, a wrong worktree, or missing
 * the expected branch.
 *
 * There is deliberately no automatic fallback from isolated -> shared /
 * project_primary. Matching isolated/git_worktree execution proceeds (returns
 * ok). Shared workspace is allowed only when the contract does not require
 * isolation (invariant F: no global ban).
 */
export function validateExecutionWorkspaceContract(input: {
  requirement: WorkspaceContractRequirement;
  realized: RealizedExecutionWorkspace;
}): WorkspaceContractDecision {
  const { requirement, realized } = input;

  if (requirement.mode === "isolated_workspace") {
    if (realized.mode === "shared_workspace") {
      return contractMismatch("realized_shared_workspace", {
        requiredMode: requirement.mode,
        realizedMode: realized.mode ?? null,
      });
    }
    if (realized.source === "project_primary") {
      return contractMismatch("realized_project_primary_source", {
        requiredMode: requirement.mode,
        realizedSource: realized.source,
      });
    }
    if (realized.isOperatorCheckout) {
      return contractMismatch("realized_operator_checkout", {
        requiredMode: requirement.mode,
        isOperatorCheckout: true,
      });
    }
    if (requirement.strategyType === "git_worktree") {
      if (realized.source && realized.source !== "git_worktree") {
        return contractMismatch("missing_isolated_worktree", {
          requiredStrategy: "git_worktree",
          realizedSource: realized.source,
        });
      }
      if (realized.expectedBranchName && !realized.actualBranchName) {
        return contractMismatch("missing_expected_branch", {
          expectedBranchName: realized.expectedBranchName,
          actualBranchName: realized.actualBranchName ?? null,
        });
      }
      if (
        realized.expectedBranchName &&
        realized.actualBranchName &&
        realized.actualBranchName !== realized.expectedBranchName
      ) {
        return contractMismatch("worktree_branch_mismatch", {
          expectedBranchName: realized.expectedBranchName,
          actualBranchName: realized.actualBranchName,
        });
      }
    }
  }

  if (requirement.mode === "operator_branch") {
    if (realized.mode === "shared_workspace") {
      return contractMismatch("operator_branch_realized_shared", {
        requiredMode: requirement.mode,
        realizedMode: realized.mode ?? null,
      });
    }
    if (realized.source === "project_primary" && !realized.actualBranchName) {
      return contractMismatch("operator_branch_on_base_checkout", {
        requiredMode: requirement.mode,
        realizedSource: realized.source,
      });
    }
  }

  // Invariant F: a realized shared_workspace is allowed unless the contract
  // explicitly requires isolation. Isolation is enforced above, so this only
  // rejects the contradictory case of a shared realization with no permit while
  // the contract is something other than shared/agent_default.
  if (
    realized.mode === "shared_workspace" &&
    !requirement.permitsSharedWorkspace &&
    requirement.mode !== "shared_workspace" &&
    requirement.mode !== "agent_default"
  ) {
    return contractMismatch("shared_workspace_not_permitted_by_contract", {
      requiredMode: requirement.mode,
      permitsSharedWorkspace: false,
    });
  }

  return { ok: true };
}

/**
 * Derive the contract requirement from a parsed project execution workspace
 * policy. When the project authoritatively requires isolated execution (enabled
 * + defaultMode isolated + overrides not allowed), the requirement is
 * isolated_workspace + git_worktree. Otherwise the project does not force
 * isolation and shared/agent_default flows proceed.
 */
export function deriveContractRequirementFromProjectPolicy(input: {
  defaultMode?: string | null;
  enabled?: boolean | null;
  allowIssueOverride?: boolean | null;
  workspaceStrategyType?: string | null;
}): WorkspaceContractRequirement | null {
  const enabled = input.enabled === true;
  if (!enabled) return null;
  if (input.defaultMode !== "isolated_workspace") return null;
  // If issue overrides are allowed, the project does not authoritatively pin
  // isolated execution, so the contract gate does not force it.
  if (input.allowIssueOverride === true) return null;
  return {
    mode: "isolated_workspace",
    strategyType:
      input.workspaceStrategyType === "git_worktree" ? "git_worktree" : "git_worktree",
  };
}

// ---------------------------------------------------------------------------
// Branch template validation (invariant 4)
// ---------------------------------------------------------------------------

export interface BranchTemplateValidationResult {
  ok: boolean;
  code?: typeof BRANCH_TEMPLATE_MALFORMED_CODE;
  reason?: string;
  /** Unresolved single-brace placeholder that triggered the rejection, if any. */
  offendingPlaceholder?: string;
}

// Matches a single-brace placeholder such as `{issueKey}` while ignoring the
// supported double-brace tokens like `{{issue.identifier}}`.
const SINGLE_BRACE_PLACEHOLDER = /(^|[^{])\{([a-zA-Z_][a-zA-Z0-9_]*)\}([^}]|$)/;

// Legacy single-brace tokens the template engine historically sanitized to a
// literal (e.g. `{slug}`), preserved so existing default templates keep working.
// Any other single-brace placeholder (e.g. `{issueKey}`) is unresolved/malformed.
const ALLOWED_LEGACY_SINGLE_BRACE_TOKENS = new Set(["slug"]);

/**
 * Reject malformed literal `{issueKey}` / unresolved single-brace placeholders.
 * The canonical supported template for this project is `{{issue.identifier}}`
 * (double-brace). A malformed template must fail preflight and must not
 * silently create a branch literally named `issueKey`.
 */
export function validateBranchTemplate(
  template: string | null | undefined,
): BranchTemplateValidationResult {
  if (!template || template.length === 0) return { ok: true };
  const match = template.match(SINGLE_BRACE_PLACEHOLDER);
  if (match && !ALLOWED_LEGACY_SINGLE_BRACE_TOKENS.has(match[2]!)) {
    const placeholder = `{${match[2]}}`;
    return {
      ok: false,
      code: BRANCH_TEMPLATE_MALFORMED_CODE,
      reason: `branch template contains unresolved single-brace placeholder "${placeholder}"; use the supported double-brace token "{{issue.identifier}}"`,
      offendingPlaceholder: placeholder,
    };
  }
  return { ok: true };
}

/**
 * Resolve a branch template against known variables. Only the supported
 * `{{issue.identifier}}` token is interpolated; anything else is preserved
 * verbatim so a malformed template is never silently expanded.
 */
export function resolveBranchTemplate(
  template: string,
  vars: { identifier: string },
): string {
  return template.replace(/\{\{issue\.identifier\}\}/g, vars.identifier);
}

// ---------------------------------------------------------------------------
// Publication authorization (invariant 3) ÔÇö default deny
// ---------------------------------------------------------------------------

export type PublicationAction =
  | "push"
  | "create_remote_branch"
  | "create_pr"
  | "update_pr"
  | "merge"
  | "rebase_upstream"
  | "auto_merge";

export interface PublicationCapability {
  action: PublicationAction;
  /** Target repository, e.g. "paperclipai/paperclip". Omit to allow any repo. */
  repo?: string;
  /** Target ref/branch. Omit to allow any ref. */
  ref?: string;
}

export interface PublicationRequest {
  action: PublicationAction;
  repo?: string;
  ref?: string;
}

export type PublicationAuthorizationDecision =
  | { ok: true }
  | {
      ok: false;
      code: typeof PUBLICATION_DENIED_CODE;
      reason: string;
      detail: Record<string, unknown>;
    };

function publicationDenied(
  reason: string,
  detail: Record<string, unknown>,
): PublicationAuthorizationDecision {
  return { ok: false, code: PUBLICATION_DENIED_CODE, reason, detail };
}

/**
 * Invariant 3. Local scoped edits/tests are never authorization to publish.
 * Push, remote branch creation/update, PR creation/update, merge,
 * rebase-to-upstream and auto-merge must be denied by default unless an explicit
 * server-side publication capability is present for that issue/run. When a
 * capability exists it authorizes only the specific action (and, if set, the
 * specific repo/ref). Generic prompt wording must not inject or request
 * push/PR/merge.
 */
export function authorizePublication(
  request: PublicationRequest,
  capability: PublicationCapability | null | undefined,
): PublicationAuthorizationDecision {
  if (!capability) {
    return publicationDenied("no_publication_capability", {
      requestedAction: request.action,
      requestedRepo: request.repo ?? null,
      requestedRef: request.ref ?? null,
    });
  }
  if (capability.action !== request.action) {
    return publicationDenied("capability_action_mismatch", {
      requestedAction: request.action,
      capabilityAction: capability.action,
    });
  }
  if (request.repo && capability.repo && capability.repo !== request.repo) {
    return publicationDenied("capability_repo_mismatch", {
      requestedRepo: request.repo,
      capabilityRepo: capability.repo,
    });
  }
  if (request.ref && capability.ref && capability.ref !== request.ref) {
    return publicationDenied("capability_ref_mismatch", {
      requestedRef: request.ref,
      capabilityRef: capability.ref,
    });
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Publication policy directive (invariant 3 - runtime prompt gate)
// ---------------------------------------------------------------------------

/**
 * Build the deterministic publication policy directive that the Paperclip
 * runtime injects into the OpenCode agent prompt. When no publication
 * capability is present the directive is a hard default-deny: local scoped
 * edits/tests are not authorization to publish, and the agent must not push /
 * create-or-update a PR / merge / rebase onto upstream / auto-merge. If the
 * task text itself asks for push/merge without explicit authorization, the
 * agent must surface this denial rather than attempt it.
 *
 * When an explicit capability is present, the directive authorizes ONLY the
 * specific action (and, if set, the specific repo/ref) - nothing else.
 */
export function buildPublicationPolicyDirective(
  capability: PublicationCapability | null | undefined,
): string {
  const HEADER = "[paperclip] Publication policy";
  if (!capability) {
    return (
      `${HEADER} (default-deny): you are NOT authorized to publish this work. ` +
      `Local scoped edits and tests are not authorization to publish. ` +
      `Do not run \`git push\`, do not create or update a pull request, do not merge, ` +
      `do not rebase onto upstream, and do not auto-merge. ` +
      `If the assigned task text asks you to push, open a PR, or merge, do not attempt it - ` +
      `report that publication requires explicit server-side authorization.`
    );
  }
  const repoPart = capability.repo ? ` to repository ${capability.repo}` : "";
  const refPart = capability.ref ? ` on ref ${capability.ref}` : "";
  return (
    `${HEADER}: you are authorized ONLY to perform the publication action "${capability.action}"${repoPart}${refPart}. ` +
    `No other publication action (push, create_pr, update_pr, merge, rebase_upstream, auto_merge) ` +
    `or target is permitted.`
  );
}

// ---------------------------------------------------------------------------
// Topology self-heal detection (invariant 2)
// ---------------------------------------------------------------------------

const TOPOLOGY_SELF_HEAL_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "git_switch", pattern: /(^|\s)git\s+switch(\s|$)/ },
  { label: "git_checkout_b", pattern: /(^|\s)git\s+checkout\s+(-[^\s]*\s+)*(-?b\S*|-?[^\s]*b)\b/ },
  { label: "git_branch_create", pattern: /(^|\s)git\s+branch\s+(-[^\s]*\s+)*[^\s-]/ },
  { label: "git_worktree_add", pattern: /(^|\s)git\s+worktree\s+add(\s|$)/ },
];

export interface TopologySelfHealDecision {
  ok: boolean;
  code?: typeof WORKSPACE_TOPOLOGY_SELF_HEAL_CODE;
  reason?: string;
  matched?: string;
}

/**
 * Invariant 2. Detect an agent/OpenCode runtime attempt to self-heal a workspace
 * mismatch by mutating git topology in the operator/checkout context:
 * `git switch`, `git checkout -b`, `git branch <task>`, `git worktree add`.
 * Only Paperclip's workspace provisioner may create task worktree/branch
 * topology; such commands must be denied / not generated by the runtime.
 */
export function detectWorkspaceTopologyMutation(command: string): TopologySelfHealDecision {
  const normalized = command.replace(/`/g, " ").replace(/;/g, " ; ");
  for (const { label, pattern } of TOPOLOGY_SELF_HEAL_PATTERNS) {
    if (pattern.test(normalized)) {
      return {
        ok: false,
        code: WORKSPACE_TOPOLOGY_SELF_HEAL_CODE,
        reason: `agent attempted topology self-heal "${label}" in operator/checkout context; only Paperclip may provision workspace topology`,
        matched: label,
      };
    }
  }
  return { ok: true };
}
