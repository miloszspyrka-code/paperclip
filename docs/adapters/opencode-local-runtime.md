# Paperclip OpenCode Runtime

`opencode_local` uses the same OpenCode binary as a manual terminal session, but
the child process receives a Paperclip-owned runtime environment.

## Runtime roots

When started by `C:\paperclip\start-paperclip.cmd`, the runtime root is:

`C:\paperclip\.paperclip-runtime\opencode`

- `tmp/<run-id>/config`: generated config, removed after the run
- `agents/<agent-id>/data`: persistent OpenCode data and per-agent sessions
- `agents/<agent-id>/data/state`: persistent state for that agent
- `cache`: Paperclip-only OpenCode/Bun plugin cache
- `plugins`: Paperclip-owned plugin namespace

The launcher sets only `PAPERCLIP_OPENCODE_RUNTIME_ROOT`. It does not change
user-wide `HOME`, `XDG_*`, `OPENCODE_CONFIG`, or `OPENCODE_CONFIG_DIR` values.
The adapter sets the XDG roots only in the OpenCode child process.

## Config and MCP

The adapter creates `opencode.json` from scratch for every run. It does not
copy the manual OpenCode config, commands, agents, plugins, skills, or MCP.
Only effective Paperclip Connection gateways are written to `mcp`.

The plugin surface is an explicit `adapterConfig.opencodeRuntimePlugins` array.
An empty array loads no external plugin. Plugin packages are resolved in the
Paperclip-only cache. Project config and external Claude-compatible skills are
disabled for the child process.

Provider auth is bridged by copying only the configured provider record from
the host OpenCode `auth.json` into the agent data root. MCP credentials are not
copied.

## Verification

Targeted adapter tests cover host-config non-leakage, per-agent roots,
Paperclip Connection injection, plugin allowlisting, provider-auth scoping and
cleanup. The runtime config fingerprint includes the effective MCP Connection
identity and plugin allowlist, but never run tokens or ephemeral paths.
