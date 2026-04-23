# MCP (Model Context Protocol) Integration

HyperAgent can connect to external [MCP servers](https://modelcontextprotocol.io/)
and expose their tools as typed sandbox modules — identical to how native plugins
(`fs-read`, `fs-write`, `fetch`) work. The LLM writes ordinary JavaScript that
calls functions with full type information, rather than emitting raw tool-call JSON.

> **Status**: v1 — tools only. MCP resources and prompts are backlogged for v2.

---

## Quick Start

### 1. Configure MCP servers

Add servers to `~/.hyperagent/config.json` (same format as VS Code's `mcp.json`):

```json
{
  "mcpServers": {
    "everything": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-everything"]
    }
  }
}
```

Or use the setup script:

```bash
just mcp-setup-everything   # sets up the MCP everything test server
```

### 2. Enable the MCP gateway plugin

```
/plugin enable mcp
```

### 3. Connect a server

```
/mcp enable everything
```

### 4. Use MCP tools in your prompt

```
Use the echo tool to echo "Hello from MCP!"
```

The LLM will write:
```javascript
import { echo } from "host:mcp-everything";

function handler(event) {
  const result = echo({ message: "Hello from MCP!" });
  return result;
}
```

---

## Configuration

### Server format

```json
{
  "mcpServers": {
    "<name>": {
      "command": "string",       // Required: command to spawn
      "args": ["string"],        // Optional: arguments
      "env": {                   // Optional: environment variables
        "KEY": "${ENV_VAR}"      // Supports ${VAR} substitution from host env
      },
      "allowTools": ["a", "b"], // Optional: whitelist specific tools
      "denyTools": ["c"]        // Optional: blacklist specific tools
    }
  }
}
```

### Naming rules

- Names must match `/^[a-z][a-z0-9-]*$/` (lowercase, alphanumeric, hyphens).
- Cannot collide with native plugin names (`fs-read`, `fs-write`, `fetch`).
- Maximum 20 configured servers.

### Tool filtering

- **`allowTools`** — only these tools are exposed. Takes precedence.
- **`denyTools`** — these tools are hidden even if discovered.
- If both are set, `allowTools` is applied first, then `denyTools` removes from that set.
- If neither is set, all discovered tools are exposed (after user approval).

### Environment variables

Use `${ENV_VAR}` syntax in `env` values. The variable is substituted from the
host environment at connection time. Values are **never logged** — only names
are shown during approval.

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}"
      },
      "allowTools": ["list_issues", "get_issue", "search_issues", "list_pull_requests"],
      "denyTools": ["merge_pull_request", "delete_branch"]
    }
  }
}
```

---

## Commands

### Slash commands

| Command                | Action                                                |
|------------------------|-------------------------------------------------------|
| `/mcp list`            | Show configured servers + status                      |
| `/mcp enable <name>`   | Approve (if needed) and connect                       |
| `/mcp disable <name>`  | Disconnect for current session                        |
| `/mcp info <name>`     | Show server details, tools, schemas                   |
| `/mcp approve <name>`  | Pre-approve without connecting                        |
| `/mcp revoke <name>`   | Remove approval                                       |

### SDK tools (LLM-callable)

| Tool                   | Purpose                                               |
|------------------------|-------------------------------------------------------|
| `list_mcp_servers()`   | List configured servers, state, tool counts            |
| `mcp_server_info(name)`| Detailed info + TypeScript declarations               |
| `manage_mcp(action, name)` | Connect/disconnect servers                        |

The LLM discovers MCP by:
1. Enabling the `mcp` plugin via `manage_plugin`
2. Calling `list_mcp_servers()` to see what's available
3. Calling `mcp_server_info(name)` for tool schemas
4. Writing handler code with `import { tool } from "host:mcp-<name>"`

---

## Security Model

### Key differences from native plugins

| Aspect               | Native plugins           | MCP servers                    |
|----------------------|--------------------------|--------------------------------|
| Code runs in         | Hyperlight micro-VM      | **Full OS process**            |
| Sandbox layers       | 6 (VM + audit + approve) | 2.5 (approve + tool filtering) |
| File access          | Jailed to base dir       | Whatever the process can see   |
| Network access       | Controlled by plugin     | Whatever the process can do    |

**MCP servers are NOT sandboxed.** They run as full OS processes with your
user permissions. This is the same trust model as VS Code extensions and
Claude Desktop MCP servers.

### Approval flow

When you first enable an MCP server:

1. **Full command + args** shown verbatim (never interpreted)
2. **Env var names** shown, values masked: `GITHUB_TOKEN=gh-****`
3. **Explicit warning**: "This MCP server runs as a full OS process with YOUR permissions"
4. **Discovered tools** listed for review
5. **Audit warnings** flagged if tool descriptions contain suspicious patterns

Approval hash = SHA-256(`name + command + JSON.stringify(args)`). Changing the
config invalidates the approval.

### Tool description auditing

Tool descriptions from MCP servers are automatically audited for prompt
injection risk:

- Instruction injection ("ignore previous", "you must", "system:")
- Role overrides ("you are now", "act as")
- Hidden directives in whitespace or encoded text

Suspicious descriptions are flagged during approval.

### Data sanitisation

- Tool names are sanitised to valid JS identifiers
- Tool descriptions are truncated to 2,000 chars, `*/` escaped for JSDoc
- Env var values are **never** logged anywhere
- MCP responses are capped at 1 MB

---

## End-to-End Example: GitHub Issue Report

This example connects HyperAgent to the GitHub MCP server and generates a
PowerPoint presentation summarising open issues from a repository — combining
MCP tools with native PPTX generation in a single workflow.

### Setup

```bash
# Set your GitHub token
export GITHUB_TOKEN="ghp_your_token_here"

# Configure the GitHub MCP server
just mcp-setup-github
```

This creates `~/.hyperagent/config.json` with the GitHub server configured,
using `allowTools` to expose only read-only operations.

### Run

```bash
just start
```

```
/plugin enable mcp
/mcp enable github
/plugin enable fs-write

Create a PowerPoint report of the top 10 open issues in the
hyperlight-dev/hyperlight repository. Include a title slide with the
repo name, then a slide for each issue showing the title, author,
labels, and a summary. End with a bar chart showing issues by label.
```

### What happens

1. The LLM calls `list_mcp_servers()` → discovers `github` is connected
2. Calls `mcp_server_info("github")` → gets `list_issues`, `get_issue` etc.
3. Writes a handler that:
   ```javascript
   import { list_issues } from "host:mcp-github";
   import * as pptx from "ha:pptx";

   function handler(event) {
     // Pull live data from GitHub via MCP
     const issues = list_issues({
       owner: "hyperlight-dev",
       repo: "hyperlight",
       state: "open",
       per_page: 10
     });

     // Generate a presentation with native PPTX module
     const pres = pptx.createPresentation();
     pres.addSlide("title", { title: "Hyperlight Issues Report" });

     for (const issue of issues) {
       pres.addSlide("content", {
         title: issue.title,
         body: `Author: ${issue.user}\nLabels: ${issue.labels.join(", ")}`
       });
     }

     return pres.build();
   }
   ```
4. The handler runs inside the Hyperlight micro-VM, calling the GitHub MCP
   server for data and the PPTX module for rendering
5. Output: a `.pptx` file with live GitHub data, generated in seconds

This is the power of MCP + HyperAgent: **live external data sources combined
with sandboxed document generation in a single typed JavaScript handler.**

---

## Work IQ (Microsoft 365)

Microsoft publishes a first-party stdio MCP server,
[`@microsoft/workiq`](https://github.com/microsoft/work-iq), that exposes the
Microsoft 365 Copilot Chat API as MCP tools (emails, meetings, documents,
Teams messages, people). HyperAgent spawns it like any other stdio server —
no HTTP transport, no OAuth config in HyperAgent, no per-tenant app
registration.

### Prerequisites

- **Node.js 22+** — required by HyperAgent (`just start`); also satisfies the
  Work IQ CLI's own Node.js 18+ minimum.
- **Microsoft 365 Copilot licence** on the signing-in user.
- **Tenant admin consent** for the "Work IQ CLI" enterprise application.
  See the [Tenant Administrator Enablement Guide][wiq-admin] — admins can
  grant consent in one click via the URL at the top of that page, or run the
  published `Enable-WorkIQToolsForTenant.ps1` script for tenants where the
  Work IQ Tools service principal hasn't been auto-provisioned.
- **Accept the EULA once** (interactive, in your own shell):

  ```bash
  npx -y @microsoft/workiq@latest accept-eula
  ```

[wiq-admin]: https://github.com/microsoft/work-iq/blob/main/ADMIN-INSTRUCTIONS.md

### One-shot setup

```bash
just mcp-setup-workiq
```

This writes the following entry to `~/.hyperagent/config.json`:

```json
{
  "mcpServers": {
    "workiq": {
      "command": "npx",
      "args": ["-y", "@microsoft/workiq@latest", "mcp"]
    }
  }
}
```

### Connecting

```
/plugin enable mcp
/mcp enable workiq
```

On the first tool call the `workiq` binary opens a browser for Microsoft
sign-in (MSAL interactive flow). Tokens are cached in the standard MSAL
cache under the user's home directory — not in `~/.hyperagent/`. Subsequent
sessions reuse the cache silently.

### Available tools

The Work IQ MCP server exposes three tools:

| Tool             | Purpose                                                                 |
|------------------|-------------------------------------------------------------------------|
| `ask_work_iq`    | Natural-language query against M365 (mail, calendar, files, Teams, people). |
| `accept_eula`    | Accept the EULA from inside an agent session (alternative to the CLI).  |
| `get_debug_link` | Return a support link for reporting issues.                             |

Most real work happens through `ask_work_iq` with prompts like:

- "What are my upcoming meetings this week?"
- "Summarise emails from Sarah about the budget."
- "Find documents I worked on yesterday."

### Running in a container / AKS

Because auth is interactive, a long-running pod can't sign in on its own.
Two options, ordered by how fragile they are:

1. **Prime the cache locally, then mount it** — run `workiq ask -q hi`
   once on a workstation, copy the MSAL token cache file(s) into a
   Kubernetes Secret, mount it into the pod at the path `workiq` expects.
   The refresh token will eventually expire (typically days).
2. **Device-code flow** — if `workiq` ever exposes it (check
   `npx -y @microsoft/workiq mcp --help` in the version you have), run it
   once inside the pod with kubectl attach, auth from another browser, let
   the refresh token take over.

At time of writing, the sanctioned path is **desktop use only**. There is
no documented service-principal / client-credentials flow for Work IQ.

### Troubleshooting

| Symptom                                      | Fix                                                                           |
|----------------------------------------------|-------------------------------------------------------------------------------|
| "Admin approval required" on sign-in         | Tenant admin must grant consent — see [admin guide][wiq-admin].               |
| EULA prompt blocks MCP session startup       | Run `npx -y @microsoft/workiq@latest accept-eula` once in an interactive shell. |
| `/mcp enable workiq` hangs                   | First run downloads ~188 MB of platform binaries via `npx`. Be patient.        |
| "AADSTS650052" / "Access denied" on consent URL | Work IQ Tools service principal not provisioned. Run the admin PS script.   |

---

## Debugging

### Connection states

| State        | Meaning                                           |
|--------------|---------------------------------------------------|
| `idle`       | Configured but not yet connected                  |
| `connecting` | Spawning process and performing handshake         |
| `connected`  | Ready — tools discovered                          |
| `error`      | Connection failed (see `lastError`)               |
| `closed`     | Explicitly disconnected                           |

### Logs

MCP activity is logged to `~/.hyperagent/logs/`:
- Connection events, tool discovery
- Call timings and errors
- Reconnection attempts (max 3 per session)

### Common issues

| Problem                           | Solution                                        |
|-----------------------------------|-------------------------------------------------|
| "Module not available"            | Run `/mcp enable <name>` first                  |
| "require() is not available"      | Use `import { x } from "host:mcp-<name>"`       |
| Server hangs on connect           | Check `command` is correct, try running manually |
| "Config hash changed"             | Re-approve with `/mcp approve <name>`            |
| Tools missing from module         | Check `allowTools`/`denyTools` in config         |

---

## Available MCP Servers

Any MCP-compatible server works. Popular options from the
[official registry](https://registry.modelcontextprotocol.io/):

| Server                                     | Install                                              | Use case                    |
|--------------------------------------------|------------------------------------------------------|-----------------------------|
| [@modelcontextprotocol/server-everything]  | `npx -y @modelcontextprotocol/server-everything`     | Testing & reference         |
| [@modelcontextprotocol/server-filesystem]  | `npx -y @modelcontextprotocol/server-filesystem /dir`| File operations             |
| [@modelcontextprotocol/server-git]         | `uvx mcp-server-git --repository /path`              | Git repo operations         |
| [@modelcontextprotocol/server-memory]      | `npx -y @modelcontextprotocol/server-memory`         | Persistent knowledge graph  |
| [@modelcontextprotocol/server-github]      | `npx -y @modelcontextprotocol/server-github`         | GitHub API                  |
| [@modelcontextprotocol/server-fetch]       | `uvx mcp-server-fetch`                               | Web content fetching        |

---

## Architecture

```
┌─────────────────────────────────────┐
│  ~/.hyperagent/config.json          │
│  mcpServers: { github: {...} }      │
└──────────────┬──────────────────────┘
               │ parse + validate
               ▼
┌──────────────────────────────────────┐
│  MCPClientManager                    │
│  Lazy connect → stdio process        │
│  Tool discovery → PluginAdapter      │
└──────────────┬───────────────────────┘
               │ setPlugins()
               ▼
┌──────────────────────────────────────┐
│  Hyperlight Sandbox (micro-VM)       │
│                                      │
│  import { echo } from               │
│    "host:mcp-everything";            │
│  const r = echo({ message: "hi" }); │
│  // → { content: "Echo: hi" }       │
└──────────────────────────────────────┘
```

MCP tools are bridged through the same `host:` module mechanism as native
plugins. The sandbox sees synchronous function calls — async transport is
handled transparently by the bridge layer.

---

## See Also

- [PLUGINS.md](PLUGINS.md) — Native plugin system
- [ARCHITECTURE.md](ARCHITECTURE.md) — System architecture
- [SECURITY.md](SECURITY.md) — Security model
- [MCP-INTEGRATION-DESIGN.md](design/MCP-INTEGRATION-DESIGN.md) — Design document
