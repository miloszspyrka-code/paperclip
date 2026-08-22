---
name: paperclip-wdroz-runtime
description: Use this skill to perform an installation or runtime change only through an auditable Paperclip task, with build, tests, restart and live smoke. Use for C:\paperclip, plugins, adapters, start-paperclip.cmd, OpenCode isolation or local repair. Explicit aliases: /runtime, /deploy-runtime.
---

# Paperclip Wdroz Runtime

## Shared execution contract

Explicit `MODE` per shared contract v2.0.0: `DIAGNOSE` (default), `PLAN`,
`EXECUTE`. This is the critical safety path. DIAGNOSE/PLAN are strictly
read-only. EXECUTE requires a filled operation envelope, write budget <= 3
admin/config writes unless scoped by an authorized task, and the full runtime
mutation sequence below. Handoff depth limit 2; loops terminate with
`HANDOFF_LOOP_BLOCKED`.

## RUNTIME MUTATION PREFLIGHT (before any restart)

Check all of:

- active runs / active agent executions / active runtime writes
- workspace lifecycle state (`pending_finalize`)
- dirty repository state
- runtime mutation lock availability
- existing auditable Paperclip task
- rollback capability

If a restart would interrupt active work:
`FINAL_GATE=BLOCKED`, `BLOCKER=ACTIVE_EXECUTION`. Never kill running work just
to finish a deployment task. Only one runtime mutation operation may hold the
global lock at a time.

## Mutation sequence

PRECHECK -> LOCK -> SNAPSHOT -> CHANGE -> BUILD -> TYPECHECK -> TARGETED TEST
-> INTEGRATION -> ACTIVE WORK RECHECK -> RESTART -> HEALTH -> FUNCTIONAL SMOKE
-> COMMIT/FINALIZE -> UNLOCK

If restart or smoke FAILS: execute the defined rollback path when rollback is
safe, then re-run health and smoke. Never report PASS when only the process is
up - PASS requires a useful live smoke.

This skill forbids side-channel runtime changes. Use:

REQUEST -> FIND/CREATE PAPERCLIP TASK -> ASSIGN CORRECT AGENT -> CHECKOUT /
EXECUTION -> LOCAL CHANGE -> BUILD -> TESTS -> COMMIT IF APPROPRIATE ->
RESTART -> LIVE SMOKE -> UPDATE TASK -> DONE/BLOCKED

If a suitable task exists, use it. Do not create a duplicate.

## Ownership

- Normal implementation: Engineer.
- Architecture or genuinely risky infrastructure: CTO only with a concrete
  reason.
- COO coordinates but does not write the runtime patch.

## Windows preflight

Before changing the Paperclip runtime, run:

```text
git status --short
```

Never use `git reset --hard`, `git clean`, or blanket stash. Preserve unrelated
dirty state. Review the diff before committing and stage only intended files.

The canonical final local startup command is exactly:

`C:\paperclip\start-paperclip.cmd`

When the runtime changes, the final smoke must run after that command. An
alternate dev command is not sufficient evidence.

## Change rules

Prefer repo-local, runtime-local, pinned package/plugin versions. Do not use
global npm installation, global XDG/OpenCode variables, or `setx` for a
Paperclip-only runtime. If the issue is a Connections or tool-access problem,
route diagnosis to `paperclip-napraw-tools` instead of patching runtime without
evidence.

## Test flow

PRE-FLIGHT -> CHANGE -> BUILD -> TYPECHECK -> TARGETED TESTS -> RELEVANT
INTEGRATION -> RESTART -> HEALTH -> FUNCTIONAL SMOKE

For OpenCode changes verify provider/model smoke, native `bash/read/edit`,
expected plugins, expected Paperclip MCP, no host MCP/plugin leak, and session
behavior. For connection changes verify the managed Connection and Tool Gateway
chain before changing adapter code.

## Task evidence

Update the task with:

`BEFORE`, `AFTER`, `WHY`, `FILES`, `TESTS`, `SMOKE`, `COMMIT`, `KNOWN_RISKS`,
and `FINAL_GATE`.

Use `blocked` only for a real blocker and name the owner and exact unblock
action. Do not claim a deployment or smoke that did not run.

## Required output

Common result envelope first:

`SKILL:` / `SKILL_VERSION:` / `MODE:` / `RESULT: PASS | FAIL | BLOCKED | HANDOFF` /
`ROOT_CAUSE_LAYER:` / `OBSERVED_FAILURE_LAYER:` / `CONTRIBUTING_LAYERS:` /
`CONFIDENCE:` / `EVIDENCE_REFERENCES:` / `WRITES_PERFORMED:` / `HANDOFF_TO:` /
`RETRY_SAFE:` / `ROLLBACK_REQUIRED:` / `NEXT_SINGLE_ACTION:`

Domain output:

TASK:
OWNER:
PREFLIGHT:
LOCK_HOLDER:
SNAPSHOT:
HEAD_BEFORE:
FILES_CHANGED:
BUILD:
TYPECHECK:
TESTS:
ACTIVE_WORK_RECHECK:
RESTART:
START_COMMAND: C:\paperclip\start-paperclip.cmd
LIVE_SMOKE:
ROLLBACK_PATH:
COMMIT:
TASK_UPDATED:
FINAL_GATE: PASS/FAIL/BLOCKED
BLOCKER:
