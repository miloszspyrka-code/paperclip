---
name: paperclip-opencode-health
description: Use this skill to diagnose and repair the OpenCode runtime used by Paperclip, including binary, isolated roots, provider/model, plugins, managed MCP, native tools and session reuse. Use for OpenCode startup, plugin, provider, isolation, or session failures. Explicit aliases: /health, /opencode-health.
---

# Paperclip OpenCode Health

## Shared execution contract

Explicit `MODE` per shared contract v2.0.0: `DIAGNOSE` (default), `PLAN`,
`EXECUTE`. DIAGNOSE/PLAN read-only. EXECUTE applies the smallest fix at the
failing layer with an operation envelope and write budget <= 3 admin/config
writes. Handoff depth limit 2; loops terminate with `HANDOFF_LOOP_BLOCKED`.

Use the sequence:

BINARY -> VERSION -> PROCESS ENV -> CONFIG ROOT -> DATA ROOT -> CACHE ROOT ->
GENERATED CONFIG -> PROVIDER -> MODEL -> PLUGINS -> MCP -> NATIVE TOOLS ->
SESSION

Never print secrets. Report paths, names, counts, and compact errors only.

## Expected profile (source of truth)

Compare the runtime against the explicit expected profile before declaring any
leak:

- `EXPECTED_PLUGINS`: pinned specs from agent adapterConfig
  (`opencodeRuntimePlugins`) - production desired state must be pinned; `latest`
  is never a valid production pin unless a plugin's documented policy says so.
- `EXPECTED_MCP_SERVERS`: effective Paperclip Connections / Tool Gateway output.
- `EXPECTED_PROVIDER`, `EXPECTED_MODEL`: configured provider/model refs.

Never label a host plugin as a leak without this comparison. A plugin absent
from `EXPECTED_PLUGINS` present at runtime = HOST_PLUGIN_LEAK and root cause is
OPENCODE_RUNTIME/config, not PROVIDER.

## Required checks

Collect:

OPENCODE_BINARY:
OPENCODE_VERSION:
CONFIG_ROOT:
DATA_ROOT:
CACHE_ROOT:
PROJECT_CONFIG_DISABLED:
PROVIDER:
MODEL:
PLUGINS:
MCP_SERVERS:
SESSION:

The runtime must start headlessly through the Paperclip adapter. A package is
not healthy merely because it installed. Each allowlisted plugin must pass a
headless OpenCode run.

## Isolation contract

The Paperclip runtime must satisfy:

- `PAPERCLIP_CONFIG_ISOLATED=true`
- `PAPERCLIP_DATA_ISOLATED=true`
- `PAPERCLIP_CACHE_ISOLATED=true`
- `HOST_MCP_LEAK=false`
- `HOST_PLUGIN_LEAK=false`
- `PAPERCLIP_MCP_ONLY=true`

Paperclip OpenCode config is built from scratch. It must not automatically read
the host `opencode.json`, host commands, host agents, host plugins, or host MCP.
Provider auth may be bridged as a single provider record only. Never copy the
whole host auth or config file into the runtime.

Paperclip MCP servers must come only from effective Paperclip Connections and
Tool Gateway output.

## Native baseline

Check `bash`, `read`, and `edit` independently of MCP. A native tool failure is
not fixed by repairing a connection. A clean native baseline with a failed MCP
call points to the managed MCP chain instead.

## Plugin check

For every configured plugin report five separate findings:

PLUGIN:
VERSION (must be pinned):
LOAD:
HEADLESS:
TOOL_CONTRIBUTION:
CONTEXT_MUTATION:
SCHEMA_MUTATION:
ERROR:

Load failure, headless execution failure, tool contribution, context mutation,
and schema mutation are independent findings. Do not call a plugin healthy only
because its package is installed. A provider schema rejection caused by plugin
schema mutation assigns `ROOT_CAUSE_LAYER=OPENCODE_RUNTIME` (plugin/config);
PROVIDER remains the observed failure layer.

## Session check

Inspect:

- `sessionIdBefore`
- `sessionIdAfter`
- `persistedSessionId`
- `freshSession`
- `sessionReused`
- `taskSessionReused`
- `resetReason`

Distinguish workspace reuse from task-session reuse. A random temporary path
cannot be the only reset explanation. Verify semantic adapter, provider, model,
task, and execution identity before deciding whether a session is resumable.

## Repair and verification

Use the smallest fix at the failing layer. Rebuild the generated runtime config,
restart the affected process, and run a headless smoke with the configured
provider/model. Then verify native `bash/read/edit`, expected plugins, expected
Paperclip MCP only, no host MCP/plugin leak, and session behavior.

## Required output

Common result envelope first:

`SKILL:` / `SKILL_VERSION:` / `MODE:` / `RESULT: PASS | FAIL | BLOCKED | HANDOFF` /
`ROOT_CAUSE_LAYER:` / `OBSERVED_FAILURE_LAYER:` / `CONTRIBUTING_LAYERS:` /
`CONFIDENCE:` / `EVIDENCE_REFERENCES:` / `WRITES_PERFORMED:` / `HANDOFF_TO:` /
`RETRY_SAFE:` / `ROLLBACK_REQUIRED:` / `NEXT_SINGLE_ACTION:`

Domain output:

OPENCODE_BINARY:
OPENCODE_VERSION:
RUNTIME_STARTS:
EXPECTED_PLUGINS:
EXPECTED_MCP_SERVERS:
EXPECTED_PROVIDER:
EXPECTED_MODEL:
PROVIDER:
MODEL:
PROVIDER_SMOKE:
CONFIG_ISOLATED:
DATA_ISOLATED:
CACHE_ISOLATED:
HOST_MCP_LEAK:
HOST_PLUGIN_LEAK:
PAPERCLIP_MCP_ONLY:
PLUGINS (LOAD/HEADLESS/TOOL_CONTRIBUTION/CONTEXT_MUTATION/SCHEMA_MUTATION):
NATIVE_TOOLS:
SESSION_STATE:
FIX:
TESTS:
FINAL_GATE: PASS/FAIL
