---
name: paperclip-napraw-tools
description: Use this skill to diagnose and repair Paperclip Apps, Connections, MCP access, installs, profiles, rules, policies, tool gateway and managed MCP schemas. Use when a tool or connector is missing, unhealthy, inaccessible, or rejected before execution. Explicit aliases: /fix-tools, /tools.
---

# Paperclip Napraw Tools

## Shared execution contract

Explicit `MODE` per shared contract v2.0.0: `DIAGNOSE` (default), `PLAN`,
`EXECUTE`. DIAGNOSE/PLAN are read-only (no repair of Access/Install/Profile/
Rules). EXECUTE repairs only the first broken Paperclip-owned layer with a
filled operation envelope, evidence, and write budget <= 3 admin/config writes
unless a scoped implementation task authorizes more. Handoff depth limit 2;
loops terminate with `HANDOFF_LOOP_BLOCKED`.

Use the canonical chain everywhere (diagnostics, docs, reports):

APPLICATION -> CONNECTION -> CONNECTION HEALTH -> CATALOG -> ACCESS -> INSTALL
-> PROFILE -> RULE/POLICY -> EFFECTIVE PROFILE -> TOOL GATEWAY -> GENERATED MCP
-> PROVIDER SCHEMA -> SAFE TOOL CALL -> AUDIT

Stop at the first broken prerequisite unless an additional read is required to
determine root cause. Do not skip layers because a later layer looks healthy.

## Diagnostic questions

For a report such as "Sender nie dziala", "GitHub zniknal", or "Cloudflare nie
dziala u Engineera", check in canonical chain order:

1. Application exists?
2. Connection exists?
3. Connection healthy?
4. Catalog exists?
5. Tool count?
6. Agent Access?
7. Agent Install?
8. Effective Profile?
9. Rule or policy?
10. Generated OpenCode MCP?
11. Tool Gateway?
12. Provider accepted schema?
13. Safe read call?
14. Audit?

## Invariants

- `Access != Install`.
- `Connection Healthy != agent can use tool`.
- Agent MCP credentials are not product runtime secrets.
- Paperclip OpenCode MCP comes only from Paperclip Connections and Tool Gateway.
- Do not solve a Paperclip MCP failure by adding unmanaged MCP to global
  OpenCode config.
- Do not copy the whole host OpenCode config into a Paperclip runtime.
- Keep exposed provider tool names at or below 64 characters.
- Do not rename or rewrite an existing canonical provider tool name without
  evidence that the provider rejects it.

## Evidence collection

Read compact metadata first. Record identifiers and counts, not full secrets or
large payloads. A healthy connection proves only the connection layer. An
installed agent profile proves only that the desired state is recorded. The
generated runtime must still contain the expected managed MCP server and tool
schema.

When the provider rejects a tool name or schema before a model call, classify
the failure as a provider/schema compatibility problem. Do not report an
upstream service outage without a completed safe call or service evidence.

## Safe tests

Use only read-only calls during diagnosis:

- health
- list
- get
- read metadata

Never mutate external data without an explicit user request. If the current
actor lacks a Board-only operation, do not spoof Board identity. Report:

`BOARD_ACTION_REQUIRED`

and name the exact endpoint and operation.

## Repairs

If permissions allow, repair the first broken Paperclip-owned layer directly:
Access, Install, Profile, or Rules. Preserve existing desired skills and add a
skill rather than replacing the full selection unless the state is explicitly
corrupt and replacement is required.

After a repair, regenerate or resync the effective runtime profile, inspect the
generated MCP server list, validate tool schemas, execute one safe read call,
and check the audit record.

## Required output

Common result envelope first:

`SKILL:` / `SKILL_VERSION:` / `MODE:` / `RESULT: PASS | FAIL | BLOCKED | HANDOFF` /
`ROOT_CAUSE_LAYER:` / `OBSERVED_FAILURE_LAYER:` / `CONTRIBUTING_LAYERS:` /
`CONFIDENCE:` / `EVIDENCE_REFERENCES:` / `WRITES_PERFORMED:` / `HANDOFF_TO:` /
`RETRY_SAFE:` / `ROLLBACK_REQUIRED:` / `NEXT_SINGLE_ACTION:`

Domain output (canonical chain order):

APPLICATION:
CONNECTION_FOUND:
CONNECTION_HEALTH:
CATALOG_TOOL_COUNT:
AGENT:
ACCESS:
INSTALLED:
EFFECTIVE_PROFILE:
POLICY:
RUNTIME_MCP_PRESENT:
HOST_MCP_LEAK:
TOOL_SCHEMA_VALID:
SAFE_CALL:
AUDIT:
FIRST_BROKEN_PREREQUISITE:
FIX:
FINAL_GATE: PASS/FAIL
