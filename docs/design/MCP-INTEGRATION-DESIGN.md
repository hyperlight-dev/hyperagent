# MCP Tools as Sandbox Plugins — Design & Implementation Plan

> **Status**: Planned
> **Author**: HyperAgent team
> **Date**: April 2026
> **Updated**: April 2026 — gap analysis, architecture decisions

## Overview

Add [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server
support to HyperAgent so that external MCP tools appear as callable modules
inside the sandbox — identical to how native plugins (`fs-read`, `fs-write`,
`fetch`) work today.

Users configure MCP servers in `~/.hyperagent/config.json` (accepting the same
format as VS Code's `mcp.json`), and the system lazily spawns stdio server
processes, discovers their tools, auto-generates TypeScript declarations and
module metadata, and bridges calls through the existing plugin registration
mechanism under the `host:mcp-<server>` namespace.

### Architecture Decisions

1. **Gateway plugin**: A native `mcp` plugin in `plugins/mcp/` gates the
   entire MCP subsystem. It goes through normal audit/approve/enable. The
   MCP client manager, config parsing, and server lifecycle all live behind
   this plugin — nothing MCP runs until the user approves it.

2. **Separate `/mcp` commands**: MCP servers are managed via `/mcp list`,
   `/mcp enable`, etc. — NOT via `/plugin`. The `/mcp` commands are only
   available when the `mcp` plugin is enabled.

3. **Per-tool filtering**: Each MCP server config supports `allowTools`
   and `denyTools` arrays. If `allowTools` is set, only listed tools are
   exposed. If only `denyTools` is set, all tools except denied ones are
   exposed. If both are set, `allowTools` takes precedence (then deny
   removes from that set). This prevents accidental exposure of destructive
   tools (e.g. `merge_pull_request`, `delete_branch`).

4. **Tool description auditing**: MCP tool descriptions are audited for
   prompt injection risk before being surfaced to the LLM. Suspicious
   patterns (instruction injection, role overrides) are flagged during
   server approval.

5. **v1 scope**: Tools only. MCP resources and prompts are backlogged
   for v2. Server installation is out of band.

6. **Namespace**: MCP modules use the `host:` prefix as `host:mcp-<name>`
   (e.g. `host:mcp-weather`). The NAPI layer's `proto.hostModule()` only
   supports the `host:` prefix — custom `mcp:` prefix is not supported.

### Why Code Mode?

This design is inspired by Cloudflare's
[Code Mode](https://blog.cloudflare.com/code-mode/) insight: LLMs are far
better at writing code that calls a typed API than at making raw tool calls.
By converting MCP tool schemas into typed sandbox modules, the LLM writes
ordinary JavaScript that calls functions — with full type information and
JSDoc documentation — rather than emitting tool-call JSON.

### New Dependency

`@modelcontextprotocol/client` — the official MCP TypeScript SDK (v1.x
stable, MIT/Apache-2.0, 12k+ stars). Provides `Client`, `StdioClientTransport`,
and the `listTools` / `callTool` API.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  ~/.hyperagent/config.json                                         │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ "mcpServers": {                                              │  │
│  │   "weather": { "command": "node", "args": ["server.js"] },   │  │
│  │   "github":  { "command": "npx", "args": ["-y", "..."] }    │  │
│  │ }                                                            │  │
│  └──────────────────────────────────────────────────────────────┘  │
└────────────────────────────┬────────────────────────────────────────┘
                             │ parse + validate (Phase 1.1)
                             ▼
┌──────────────────────────────────────────────────────────────┐
│  MCPClientManager (Phase 1.2)                                │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐             │
│  │ weather    │  │ github     │  │ ...        │  (lazy)     │
│  │ idle       │  │ idle       │  │            │             │
│  └─────┬──────┘  └─────┬──────┘  └────────────┘             │
│        │ first call     │                                    │
│        ▼                │                                    │
│  ┌────────────┐         │                                    │
│  │ connecting │──spawn──│────► stdio process                 │
│  └─────┬──────┘         │                                    │
│        │ listTools()    │                                    │
│        ▼                │                                    │
│  ┌────────────┐         │                                    │
│  │ connected  │         │                                    │
│  │ tools: [..]│         │                                    │
│  └─────┬──────┘         │                                    │
└────────┼────────────────┼────────────────────────────────────┘
         │                │
         │ adapt (Phase 2)│
         ▼                │
┌──────────────────────────┴───────────────────────────────────┐
│  PluginRegistration adapter                                  │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ name: "weather"                                        │  │
│  │ declaredModules: ["weather"]                           │  │
│  │ createHostFunctions(config) → {                        │  │
│  │   "weather": {                                         │  │
│  │     get_forecast: async (args) => callTool(...)        │  │
│  │   }                                                    │  │
│  │ }                                                      │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────┬───────────────────────────────────┘
                           │ setPlugins() (alongside native plugins)
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  Hyperlight Sandbox (micro-VM)                               │
│                                                              │
│  const weather = require("host:mcp-weather");                │
│  const result = weather.get_forecast({ location: "Austin" });│
│  // → { temperature: 93, conditions: "sunny" }              │
│                                                              │
│  // Async is transparent — bridge auto-unwraps Promises.     │
│  // Guest sees synchronous calls (same as fetch plugin).     │
└──────────────────────────────────────────────────────────────┘
```

---

## Phases

### Phase 1: MCP Client Infrastructure

#### Step 1.1 — Config Schema & Parser

Add an `mcpServers` field to the operator config in
`~/.hyperagent/config.json`, accepting VS Code's `mcp.json` format:

```json
{
  "mcpServers": {
    "weather": {
      "command": "node",
      "args": ["weather-server.js"],
      "env": { "API_KEY": "${WEATHER_API_KEY}" }
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" },
      "allowTools": ["list_pull_requests", "get_pull_request", "list_issues", "create_issue"],
      "denyTools": ["merge_pull_request", "delete_branch"]
    }
  }
}
```

- `allowTools` — if set, only these tools are exposed to the sandbox.
- `denyTools` — if set, these tools are hidden even if discovered.
- If both are set, `allowTools` takes precedence (then deny removes from that set).
- If neither is set, all discovered tools are exposed (with user approval).

- Parse and validate at startup via the existing config loading path.
- Support `${ENV_VAR}` substitution in `env` values so secrets stay in the
  OS environment, not on disk.
- Validation rules (see Phase 6 security controls for rationale):
  - Server name: `/^[a-z][a-z0-9-]*$/` — alphanumeric + hyphens only.
  - Reject names colliding with native plugins (`fs-read`, `fs-write`,
    `fetch`) or reserved prefixes (`ha:`, `host:`).
  - Max 20 configured servers.

**Files**:

- `src/agent/mcp/config.ts` — NEW: types, parser, validation
- `src/agent/cli-parser.ts` — extend to load `mcpServers`

#### Step 1.2 — MCP Client Manager

Manages the lifecycle of MCP client connections.

```typescript
interface MCPServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface MCPConnection {
  name: string;
  config: MCPServerConfig;
  client: Client; // from @modelcontextprotocol/client
  transport: StdioClientTransport;
  tools: Tool[]; // discovered tools
  state: "idle" | "connecting" | "connected" | "error";
}
```

- **Lazy connection**: spawn the stdio process on first tool call, not at
  boot. Max 5 simultaneous connections.
- **Session-scoped**: keep alive for the agent session, close on exit.
- **Reconnection**: if the server process dies, set state → `error` and
  attempt respawn on the next call (max 3 retries per session).
- **Graceful shutdown**: close all transports on agent exit.
- **Timeouts**: 10 s connection timeout, per-call timeout = min(30 s,
  remaining sandbox wall-clock time).

**Files**:

- `src/agent/mcp/client-manager.ts` — NEW
- `src/agent/mcp/types.ts` — NEW

#### Step 1.3 — Tool Discovery & Schema Extraction

- On first connection call `client.listTools()` to discover available
  tools and their JSON-Schema input schemas.
- Cache tool schemas per-connection.
- Refresh on `notifications/tools/list_changed`.

---

### Phase 2: Sandbox Bridge (MCP → Plugin Registration)

#### Step 2.1 — MCP-to-PluginRegistration Adapter

Wrap each MCP server as a `PluginRegistration` object (the same interface
native plugins use):

**Guest perspective** — sandbox code:

```javascript
const weather = require("host:mcp-weather");
const result = weather.get_forecast({ location: "Austin, TX" });
// result = { temperature: 93, conditions: "sunny" }
```

**Host perspective** — adapter:

```typescript
createHostFunctions(config) {
  return {
    weather: {
      get_forecast: async (args) => {
        const result = await mcpClient.callTool({
          name: "get_forecast",
          arguments: args,
        });
        if (result.isError) return { error: extractErrorText(result.content) };
        return extractContent(result.content);
      },
    },
  };
}
```

- Async is transparent: host function returns a Promise, the Hyperlight
  bridge auto-unwraps it — guest sees a synchronous call (proven by the
  fetch plugin).
- MCP `isError` responses → `{ error: string }` (consistent with plugin
  error pattern).
- Binary content (images, etc.) → return via sidecar if top-level
  `Uint8Array`.

**Files**:

- `src/agent/mcp/plugin-adapter.ts` — NEW

#### Step 2.2 — `host:mcp-<name>` Namespace Registration

- Register MCP modules with `proto.hostModule("mcp-" + serverName)`
  which exposes them as `host:mcp-<name>` in the sandbox.
- The NAPI layer (`deps/js-host-api/`) hardcodes the `host:` prefix —
  custom prefixes are not supported. Using `mcp-` as a name prefix
  under `host:` gives a clear namespace without NAPI changes.
- `declaredModules` in the `PluginRegistration` lists `"mcp-" + serverName`.
- Guest code imports as: `import { tool } from "host:mcp-weather";`

**Files**:

- `src/sandbox/tool.js` — `hostModule()` name → guest `require()` path

---

### Phase 3: Type Generation & Module Metadata

#### Step 3.1 — TypeScript Declaration Generation

Convert MCP tool JSON Schemas into TypeScript interfaces and ambient
module declarations at runtime (not committed).

Example output for a weather server:

```typescript
declare module "host:mcp-weather" {
  interface GetForecastInput {
    location: string;
  }
  interface GetForecastOutput {
    [key: string]: any;
  }
  /** Get the weather forecast for a location */
  export function get_forecast(input: GetForecastInput): GetForecastOutput;
}
```

**Files**:

- `src/agent/mcp/type-generator.ts` — NEW: JSON Schema → `.d.ts`

#### Step 3.2 — Module Metadata for LLM Discovery

- Generate module metadata so `list_modules()` / `module_info()` can
  expose MCP tools to the LLM.
- Register MCP modules in the module registry alongside built-in and user
  modules.
- Use the `structuredHints` (`ModuleHints` interface) format — the
  current preferred format, populated directly from MCP tool schemas.
  No source extraction needed (there is no TypeScript source for MCP
  servers).

**Files**:

- `src/agent/index.ts` — extend module registration
- `src/agent/mcp/type-generator.ts` — metadata generation

---

### Phase 4: Approval & Profile Integration

#### Step 4.1 — MCP Server Approval

- First-time use requires interactive user approval.
- Approval stored in `~/.hyperagent/approved-mcp.json`.
- Hash = SHA-256(`name + command + JSON.stringify(args)`) — config
  change invalidates the approval.
- **Tool description auditing**: on first connection, tool descriptions
  are scanned for prompt injection patterns (instruction injection,
  role overrides, hidden directives). Suspicious descriptions are
  flagged in the approval prompt with a warning.
- Approval prompt displays: server name, full command + args, env var
  **names** (values masked), discovered tools with descriptions,
  any audit warnings, and the explicit warning that the process runs
  with full OS permissions (see Phase 6 / T2).
- `/mcp approve <name>` and `/mcp revoke <name>` commands.
- The `/mcp` commands are only available when the gateway `mcp` plugin
  is enabled.

**Files**:

- `src/agent/mcp/approval.ts` — NEW (reuses patterns from
  `src/plugin-system/manager.ts`)

#### Step 4.2 — Profile Integration

- Extend profile definitions to include `mcpServers: string[]`.
- Profile stacking: union of MCP servers across stacked profiles.
- Default profile: no MCP servers (opt-in only).
- Per-profile config overrides (e.g. different env vars).

**Files**:

- `src/agent/profiles.ts` — extend `ProfileLimits` / merge logic

#### Step 4.3 — Agent Lifecycle Integration

- Startup: load MCP config, validate, but **don't connect** (lazy).
- `/mcp enable <name>`: approve → register module → regenerate types.
- Sandbox execution with MCP module import: trigger lazy connection.
- Exit: close all MCP connections gracefully.
- `syncPluginsToSandbox()`: include MCP `PluginRegistration` objects.
- System message: list available MCP tools alongside plugin descriptions.

**Files**:

- `src/agent/index.ts`
- `src/agent/system-message.ts`

---

### Phase 5: CLI Commands & UX

#### Step 5.1 — Slash Commands

| Command               | Action                                                            |
| --------------------- | ----------------------------------------------------------------- |
| `/mcp list`           | Show configured servers + status (`idle` / `connected` / `error`) |
| `/mcp enable <name>`  | Approve (if needed) and enable for current session                |
| `/mcp disable <name>` | Disable for current session                                       |
| `/mcp info <name>`    | Show server details, available tools, schemas                     |
| `/mcp approve <name>` | Pre-approve without enabling                                      |
| `/mcp revoke <name>`  | Remove approval                                                   |

Follow the existing `/plugin` command patterns.

#### Step 5.2 — SDK Tool Integration

- `manage_mcp` — LLM-callable tool for MCP server management.
- `list_mcp_servers` — list configured servers, status, available tools.
- `mcp_server_info` — show server details, tool schemas, filtering.
- These tools are only registered when the gateway `mcp` plugin is
  enabled. The LLM discovers MCP by first enabling the `mcp` plugin
  via `manage_plugin`, then using these MCP-specific tools.

#### Step 5.3 — Gateway Plugin

- Native plugin at `plugins/mcp/index.ts` — goes through normal
  audit/approve/enable lifecycle.
- Enabling the `mcp` plugin:
  1. Loads MCP config from `~/.hyperagent/config.json`
  2. Registers `/mcp` slash commands
  3. Registers `manage_mcp` / `list_mcp_servers` / `mcp_server_info` tools
  4. Makes MCP servers discoverable to the LLM
- Disabling the `mcp` plugin closes all MCP connections and removes
  all `host:mcp-*` modules from the sandbox.

### Backlog (v2)

- **MCP Resources**: expose server resources as read-only data sources.
- **MCP Prompts**: surface server prompt templates to the agent.
- **Server installation**: CLI commands to install/manage MCP servers.
  Currently out of band — users install servers themselves.

---

### Phase 6: Security Controls

Security controls derived from the threat model. Each maps to specific
threats (T1–T10); see `docs/design/MCP-THREAT-MODEL.md` (Phase 7) for the
full threat analysis.

#### Step 6.1 — Config Validation & Command Safety (T1, T7, T9)

- Server name: `/^[a-z][a-z0-9-]*$/`. Reject names matching native
  plugin names or reserved prefixes.
- Max 20 configured servers at parse time.
- Max 5 concurrent connections at runtime.
- `${ENV_VAR}` substitution in config `env` values.

#### Step 6.2 — Approval Prompt & Process Warning (T1, T2)

The approval prompt must display:

1. Full `command + args` verbatim (never interpreted or expanded).
2. Env var **names only**, values masked: `API_KEY=sk-l***`.
3. Explicit warning:
   > ⚠️ This MCP server runs as a full OS process with YOUR permissions.
   > It is NOT sandboxed.
4. List of discovered tools (on first connection).

Approval hash = SHA-256(`name + command + JSON.stringify(args)`) — any
config change invalidates the approval.

#### Step 6.3 — Data Sanitisation (T4, T6, T8)

| What              | How                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| Tool names        | Strip to valid JS identifiers (`[a-zA-Z_$][a-zA-Z0-9_$]*`). Reject or transform invalid names. |
| Tool descriptions | Escape `*/` for JSDoc, strip ANSI escapes, truncate to 2 000 chars.                            |
| MCP responses     | Extract text/JSON content only. Log binary sizes, not content.                                 |
| Env var values    | **NEVER** log anywhere — client-manager, approval, error messages. Log names only.             |
| Error messages    | Strip env values and host file paths before surfacing to user or LLM.                          |

Centralised in `src/agent/mcp/sanitise.ts`.

#### Step 6.4 — Timeout & Resource Controls (T5, T9)

| Control            | Default                         | Notes                         |
| ------------------ | ------------------------------- | ----------------------------- |
| Per-call timeout   | min(30 s, remaining wall-clock) | Configurable per-server       |
| Connection timeout | 10 s                            | spawn + connect               |
| Response size cap  | 1 MB                            | Excess truncated with warning |
| Reconnect retries  | 3 per session                   | After transport close / crash |

#### Step 6.5 — Security Tests

- Config rejects native plugin name collisions.
- Config rejects reserved namespace prefixes.
- Config rejects > 20 configured servers.
- Approval hash changes when command/args change.
- Env var values never appear in approval prompt text or log output.
- Tool names with special chars are sanitised to valid JS identifiers.
- Tool descriptions with `*/` are escaped.
- MCP call timeout fires and returns error to guest (not hang).
- Server crash triggers reconnect on next call.
- Namespace collision between MCP and native plugin is rejected.

---

### Phase 7: Documentation

#### Step 7.1 — User-Facing MCP Guide (`docs/MCP.md`)

- What MCP is and how this feature relates to native plugins.
- Configuration: VS Code format, `~/.hyperagent/config.json`,
  `${ENV_VAR}` substitution syntax.
- Usage: `/mcp list`, `/mcp enable`, `/mcp info`, profile integration.
- Examples: GitHub, filesystem, everything-server.
- Calling MCP tools from sandbox code: `require("host:mcp-<name>")`,
  synchronous calling convention.
- Debugging: connection states, error messages, logs.

#### Step 7.2 — Threat Model Document (`docs/design/MCP-THREAT-MODEL.md`)

- New trust boundaries introduced by MCP.
- Comparison: native plugin security (6 layers) vs MCP server security
  (2.5 layers).
- Full threat table (T1–T10) with severity, likelihood, mitigations,
  residual risk.
- Key insight: MCP servers are NOT sandboxed — same trust model as
  VS Code / Claude Desktop.
- Security controls checklist for operators.
- Env var handling: substitution, masking, never-log guarantee.
- What happens if an MCP server is compromised.

#### Step 7.3 — Architecture Updates

- `docs/ARCHITECTURE.md` — add MCP trust boundary to diagram.
- `docs/PLUGINS.md` — section comparing native plugins vs MCP plugins,
  cross-reference `MCP.md`.
- `docs/PROFILES.md` — document `mcpServers` in profile definitions.
- `docs/SECURITY.md` — add MCP section, reference threat model.

---

### Phase 8: Testing

#### Step 8.1 — Unit Tests

- MCP config parsing + validation.
- MCP schema → TypeScript type generation.
- Plugin adapter: `PluginRegistration` interface compliance.
- Approval store (create, check, revoke).
- Profile integration (merging, stacking).

#### Step 8.2 — Integration Tests

- Mock MCP server (simple stdio server that echoes tool calls).
- End-to-end: config → lazy connect → tool discovery → sandbox execution
  → result.
- Error handling: server crash, timeout, invalid response.
- Approval flow: first-use prompt, persistence, config change
  invalidation.

---

## Files

### Existing (Reference / Modify)

| File                                   | Role                                                           |
| -------------------------------------- | -------------------------------------------------------------- |
| `src/agent/index.ts`                   | Agent entry, tool registration, plugin sync, session lifecycle |
| `src/agent/cli-parser.ts`              | CLI arg parsing, config loading                                |
| `src/agent/profiles.ts`                | Profile definitions, merging, plugin defaults                  |
| `src/agent/system-message.ts`          | System prompt construction                                     |
| `src/sandbox/tool.js`                  | Sandbox bridge, plugin registration, host module setup         |
| `src/sandbox/tool.d.ts`                | `PluginRegistration` type definition                           |
| `src/plugin-system/manager.ts`         | Plugin lifecycle, approval store patterns                      |
| `src/plugin-system/types.ts`           | `OperatorConfig`, plugin types                                 |
| `plugins/fetch/index.ts`               | Reference for async host function pattern                      |
| `plugins/plugin-schema-types.ts`       | `ConfigSchema`, `SchemaField` types                            |
| `plugins/host-modules.d.ts`            | Generated module declarations (reference)                      |
| `scripts/generate-host-modules-dts.ts` | Type generation script (reference)                             |
| `deps/js-host-api/`                    | NAPI bridge, host module namespace handling                    |

### New

| File                                      | Purpose                                                     |
| ----------------------------------------- | ----------------------------------------------------------- |
| `src/agent/mcp/config.ts`                 | Config types, parser, validation                            |
| `src/agent/mcp/types.ts`                  | MCP-specific TypeScript types                               |
| `src/agent/mcp/client-manager.ts`         | MCP client lifecycle management                             |
| `src/agent/mcp/plugin-adapter.ts`         | MCP → `PluginRegistration` bridge                           |
| `src/agent/mcp/type-generator.ts`         | JSON Schema → `.d.ts` + metadata generator                  |
| `src/agent/mcp/approval.ts`               | MCP server approval store                                   |
| `src/agent/mcp/sanitise.ts`               | Centralised sanitisation (names, descriptions, env, errors) |
| `docs/MCP.md`                             | User-facing MCP guide                                       |
| `docs/design/MCP-THREAT-MODEL.md`         | Full threat model                                           |
| `tests/mcp-config.test.ts`                | Config tests                                                |
| `tests/mcp-type-generator.test.ts`        | Type generation tests                                       |
| `tests/mcp-plugin-adapter.test.ts`        | Adapter bridge tests                                        |
| `tests/mcp-integration.test.ts`           | E2E tests with mock server                                  |
| `tests/mcp-security.test.ts`              | Security tests (sanitisation, collision, timeout, masking)  |
| `tests/fixtures/mock-mcp-server/index.ts` | Test fixture server                                         |

---

## Verification Checklist

1. `just fmt` — all new code formatted.
2. `just lint` — TypeScript compiles with zero errors.
3. `just test` — all existing + new MCP tests pass (including security
   suite).
4. Manual: configure a real MCP server
   (`@modelcontextprotocol/server-everything`), call tools from sandbox.
5. Lazy lifecycle: server NOT spawned until first `require("host:mcp-*")`.
6. Approval flow: first use prompts (full command, masked env vars,
   warning), second use skips.
7. Profile integration: MCP servers activate/deactivate with profiles.
8. Type generation: `module_info("host:mcp-<name>")` shows tool descriptions.
9. Security:
   - Env var values never in logs (`~/.hyperagent/logs/`).
   - Env var values never in approval prompt output.
   - Server names colliding with native plugins rejected at parse time.
   - MCP call timeout fires correctly.
   - Server crash → reconnect on next call.
   - Malicious tool name → sanitised to safe identifier.
10. Docs: `MCP.md` and `MCP-THREAT-MODEL.md` accurate, cross-referenced
    from `ARCHITECTURE.md` and `SECURITY.md`.

---

## Decisions

| Decision                            | Rationale                                                                          |
| ----------------------------------- | ---------------------------------------------------------------------------------- |
| stdio only (v1)                     | Simplest — no auth complexity. HTTP transport is a future addition.                |
| `mcp:` namespace                    | Keeps MCP distinct from native `host:` plugins.                                    |
| No LLM audit                        | No source code to audit — user approval only.                                      |
| Lazy spawn                          | Don't pay process cost until tools are actually used.                              |
| One module per server               | Tools appear as functions on the module — matches Cloudflare Code Mode.            |
| Guest sees sync calls               | Bridge auto-unwraps Promises (same as fetch plugin).                               |
| VS Code config format               | Familiar, copy-paste from existing configs. Stored in `~/.hyperagent/config.json`. |
| `@modelcontextprotocol/client` v1.x | Stable, official SDK, well-maintained.                                             |

---

## Open Questions

1. **NAPI namespace prefix** — does `deps/js-host-api` hardcode `host:`?
   If so, fallback to `host:mcp-<name>`.
2. **Future: HTTP transport** — add `StreamableHTTPClientTransport` + auth
   provider config in a follow-up.
3. **Future: containerised MCP servers** — for high-security deployments,
   spawn servers inside containers to limit OS access (mitigates T2
   residual risk).

---

## Threat Model Summary

See `docs/design/MCP-THREAT-MODEL.md` for the complete analysis. Key
points:

| ID  | Threat                        | Severity    | Mitigated?                                            |
| --- | ----------------------------- | ----------- | ----------------------------------------------------- |
| T1  | Command injection via config  | 🔴 CRITICAL | ✅ Approval gate                                      |
| T2  | MCP server has full OS access | 🔴 CRITICAL | ⚠️ Inherent to MCP — same as VS Code / Claude Desktop |
| T3  | Response → prompt injection   | 🟠 HIGH     | ✅ Sandbox isolation                                  |
| T4  | Env var leakage               | 🟠 HIGH     | ✅ Masking + substitution                             |
| T5  | Server crash / hang           | 🟡 MEDIUM   | ✅ Timeouts                                           |
| T6  | Schema poisoning              | 🟡 MEDIUM   | ✅ Sanitisation                                       |
| T7  | Namespace collision           | 🟡 MEDIUM   | ✅ Validation                                         |
| T8  | stdio injection               | 🟢 LOW      | ✅ SDK handles                                        |
| T9  | Server proliferation DoS      | 🟢 LOW      | ✅ Caps                                               |
| T10 | Approval file tampering       | 🟡 MEDIUM   | ✅ Hash-based                                         |

**Key insight**: native plugins get 6 security layers (tool gating →
hardware isolation → code validation → static scan → LLM audit →
approval hashing). MCP servers get 2.5: approval gate + sandbox isolation

- namespace validation. The missing layers don't apply because there is no
  source to analyse — the MCP server is an opaque external process. This
  matches the trust model of every other MCP client (VS Code, Claude
  Desktop, etc.).
