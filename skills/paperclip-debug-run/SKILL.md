---
name: paperclip-debug-run
description: Use this skill to diagnose a specific Paperclip or OpenCode execution run, including runtime failure, agent failure, logs, tool calls, model errors, workspace state and execution evidence. Prefer this skill whenever the user asks why a run failed or provides a run ID. Explicit aliases: /debug, /debug-run.
---

# Paperclip Debug Run

## Shared execution contract

Every invocation carries an explicit `MODE` from the shared contract
(`scripts/paperclip-skill-contract.mjs`, contract version 2.0.0):
`DIAGNOSE` (default for ambiguous requests), `PLAN`, or `EXECUTE`.

- `DIAGNOSE`: strictly read-only. GET/list/health/metadata/bounded logs/safe
  read probes only. No create/update/restart/retry-write/install/resync/
  assignment/status mutation/comments that resume or interrupt, and none of the
  "safe fixes" below — they are EXECUTE-only.
- `PLAN`: read-only preparation of an exact change plan. No mutations.
- `EXECUTE`: allowed only when user intent explicitly requires a change, the
  actor is authorized, the operation is in scope, preconditions PASS, root-cause
  evidence exists, and idempotency protection applies where possible. Never
  infer EXECUTE merely because this skill can repair.

Operation envelope: `OPERATION_ID`, `SKILL`, `SKILL_VERSION`, `MODE`, `TARGET`,
`ACTOR`, `START_STATE`, `WRITE_BUDGET` (DIAGNOSE/PLAN = 0), `HANDOFF_DEPTH`,
`EVIDENCE`, `RESULT`. `MAX_HANDOFF_DEPTH=2`; a handoff back to a skill already
in the chain terminates with `HANDOFF_LOOP_BLOCKED`.

Use the sequence:

OBSERVE -> CLASSIFY -> PROVE -> FIX IF SAFE -> VERIFY

This is a bounded forensic procedure. If the request contains only a run id,
inspect that run and its directly related task, agent, invocation, workspace,
session, and process evidence. Do not audit the whole Paperclip installation.

## Safety

- Diagnose before changing anything.
- Prefer read-only Paperclip API and MCP calls.
- Never retry the same failed control-plane write indefinitely.
- Never blame product code before adapter, generated config, provider request,
  tool schema, and provider authentication have been checked.
- Do not print large logs, tokens, cookies, API keys, or full environment dumps.
- If the root cause is MCP/tools, hand off to `paperclip-napraw-tools`.
- If the root cause is OpenCode isolation or runtime, hand off to
  `paperclip-opencode-health`.

## Failure layers

Separate observed failure from root cause. Classify:

- `OBSERVED_FAILURE_LAYER`: where the failure became visible.
- `ROOT_CAUSE_LAYER`: the layer that caused it.
- `CONTRIBUTING_LAYERS`: additional involved layers.

Example: a plugin mutates the provider tool schema, the provider rejects it,
and the request never reaches the model. Report
`OBSERVED_FAILURE_LAYER=PROVIDER`, `ROOT_CAUSE_LAYER=OPENCODE_RUNTIME`,
`CONTRIBUTING_LAYERS=[TOOL_GATEWAY_MCP]`. Never collapse these into one
arbitrary `FAILURE_LAYER` choice.

Classify exactly one primary observed layer:

- `CONTROL_PLANE`: Paperclip state, lifecycle, assignment, queue, or wake.
- `ADAPTER`: adapter execution, generated invocation, adapter parsing, or
  adapter/provider bridge.
- `PROVIDER`: provider auth, model availability, provider request, or provider
  schema/name rejection.
- `OPENCODE_RUNTIME`: binary, config roots, session, plugin, native runtime,
  or OpenCode process.
- `TOOL_GATEWAY_MCP`: MCP connection, tool gateway, tool catalog, access,
  install, effective profile, or tool call.
- `WORKSPACE_GIT`: workspace realization, reuse, branch, repository, or dirty
  state.
- `PROCESS`: process liveness, exit, signal, timeout, or lost child process.
- `PRODUCT_CODE`: verified application implementation defect.
- `UNKNOWN`: evidence is insufficient; state what evidence is missing.

## Bounded inspection

Collect only the evidence needed for this run:

1. run id
2. agent
3. issue/task
4. invocation source
5. status
6. errorCode and compact error message
7. adapter
8. provider and model
9. input, cached, and output tokens
10. workspace realization
11. workspace reuse
12. session reuse
13. generated config freshness
14. bounded stdout/stderr excerpts
15. useful next actions
16. issue disposition
17. retry and recovery state
18. process state

If `inputTokens=0` and `outputTokens=0`, treat the run as likely having done
no model work. Check adapter startup, generated config, provider request,
tool schema, tool/provider names, and provider auth before inspecting product
implementation.

## Session and workspace rules

Always distinguish:

- `workspaceReused`: the filesystem/worktree was reused.
- `sessionReused` or `taskSessionReused`: the model session was resumed.

Inspect `sessionIdBefore`, `sessionIdAfter`, `persistedSessionId`,
`freshSession`, `sessionReused`, `taskSessionReused`, and `resetReason`.
Do not infer session reuse from workspace reuse. A random temporary path is not
by itself a sufficient explanation for a reset.

Session fingerprints must use semantic configuration, provider, model, adapter,
and execution identity. Do not use random temp paths as the only fingerprint
input.

## Safe fixes (EXECUTE only)

Apply a fix only in `EXECUTE` mode, only with a filled operation envelope, and
only when evidence identifies a concrete, low-risk cause. Safe
examples include repairing a stale generated runtime config, removing a stale
Paperclip-owned skill link, correcting a Paperclip-owned session identity, or
re-running a bounded read-only health probe. Do not mutate external data while
diagnosing.

For retry decisions, check whether the provider request was sent, whether an
external mutation could have happened, whether the run is idempotent, and
whether Paperclip has a first-class recovery path. Mark retry unsafe when any
of those are unknown for a write operation.

## Verification

Repeat the smallest read-only probe that proves the fix. Verify the issue has a
valid disposition. Do not claim success from a process exit alone: confirm a
useful run result, session state, or Paperclip state transition.

## Required output

Common result envelope (required for every mode), wrapping the domain fields:

`SKILL:` / `SKILL_VERSION:` / `MODE:` /
`RESULT: PASS | FAIL | BLOCKED | HANDOFF` /
`ROOT_CAUSE_LAYER:` / `OBSERVED_FAILURE_LAYER:` / `CONTRIBUTING_LAYERS:` /
`CONFIDENCE: HIGH | MEDIUM | LOW` / `EVIDENCE_REFERENCES:` /
`WRITES_PERFORMED:` / `HANDOFF_TO:` / `RETRY_SAFE:` / `ROLLBACK_REQUIRED:` /
`NEXT_SINGLE_ACTION:`

Domain output (bounded forensic):

RUN:
STATUS:
ERROR_CODE:

EVIDENCE:
- ...

FIX_PERFORMED:
VERIFICATION:

IS_RETRY_SAFE:
IS_CODE_CHANGE_REQUIRED:
IS_CONFIG_CHANGE_REQUIRED:
