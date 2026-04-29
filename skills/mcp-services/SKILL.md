---
name: mcp-services
description: Connect and use external MCP servers (M365, GitHub, custom services)
triggers:
  - MCP
  - Teams
  - Mail
  - Calendar
  - Planner
  - SharePoint
  - OneDrive
  - Copilot
  - email
  - meetings
  - tasks
  - external service
  - mcp server
  - work-iq
antiPatterns:
  - Don't try to manage_plugin("mcp:<name>") — MCP servers are NOT regular plugins
  - Don't import from "host:mcp-gateway" — that's the gateway sentinel, not a server
  - Don't guess tool names or parameters — always call mcp_tool_info() first
  - Don't hardcode MCP tool schemas — they change when servers update
  - Don't call MCP server tools directly from LLM tools — execute them only inside generated handler code
allowed-tools:
  - register_handler
  - list_mcp_servers
  - mcp_server_info
  - mcp_tool_info
  - manage_mcp
  - execute_javascript
  - delete_handler
  - get_handler_source
  - edit_handler
  - list_handlers
  - reset_sandbox
  - list_modules
  - module_info
  - list_plugins
  - plugin_info
  - manage_plugin
  - apply_profile
  - configure_sandbox
  - sandbox_help
  - register_module
  - write_output
  - read_input
  - read_output
  - ask_user
---

## MCP Server Workflow

MCP (Model Context Protocol) servers provide external tool capabilities — M365
services, GitHub, databases, custom APIs. Follow this exact workflow:

## Default Behaviour: Handler-Only MCP Execution

For normal user questions against external services — read, list, search, lookup,
summarise recent items — use focused discovery, then execute MCP calls inside a
registered handler:

```
list_mcp_servers()
manage_mcp({ action: "connect", name: "<server>" })
mcp_tool_info({ name: "<server>", query: "<what you need>" })
apply_profile({ profiles: "mcp-network" }) // external MCP calls need wall-clock time
register_handler(...) // import from host:mcp-<server>, await the selected tool
execute_javascript(...)
```

Do **not** call MCP server tools directly from LLM tools. The handler is the
auditable execution boundary for MCP calls. Avoid `file-builder` and
`fs-write`/`fs-read` unless the user asked for an artifact or the task truly
needs large intermediate output. If a result is too large, first retry with
narrower handler arguments: `limit`, `top`, `$top`, `$select`, `$filter`, date
ranges, search query, or a more specific tool.

### Step 1: Discover configured servers

```
list_mcp_servers()
```

Returns all configured servers with their state (`idle`, `connected`, `error`).
Each server has a name like `work-iq-mail`, `work-iq-teams`, `github`, etc.

### Step 2: Connect the server you need

```
manage_mcp({ action: "connect", name: "work-iq-mail" })
```

- If pre-approved → connects silently
- If not approved → prompts the user for approval (shows tools + security info)
- Returns `{ success: true, tools: [...], module: "host:mcp-<name>" }`

### Step 3: Get focused tool schemas

```
mcp_tool_info({ name: "work-iq-mail", query: "search recent messages" })
```

Returns JSON Schema for the relevant tools plus TypeScript declarations. Read
this BEFORE writing handler code — tool names and parameter shapes vary per
server.

If you already know the tool names, request only those tools:

```
mcp_tool_info({ name: "work-iq-mail", tools: ["SearchEmails", "GetEmail"] })
```

Use `mcp_server_info({ name: "work-iq-mail", query: "..." })` only when you
need server-level details as well. Avoid dumping every schema unless the user
explicitly asks to inspect the whole server.

### Step 4: Apply the MCP network profile

```
apply_profile({ profiles: "mcp-network" })
```

MCP handlers wait on external service calls, so the default 5s wall-clock limit
is often too small even when CPU usage is low. Use `mcp-network` before
executing MCP handlers. It raises wall time without enabling file plugins.

### Step 5: Register handler code that calls MCP tools

For reads, searches, and lookups, generate handler code that imports from the
server module and awaits the selected MCP tool:

```javascript
import { SearchEmails } from "host:mcp-work-iq-mail";

export default async function handler(event) {
  const result = await SearchEmails({
    query: "from:boss subject:urgent",
    top: 5,
  });
  if (!result.ok) return result;
  return { content: [{ type: "text", text: JSON.stringify(result.data) }] };
}
```

MCP calls return a stable envelope inside handler code:

```javascript
{
  ok: true,
  data: { /* parsed primary result */ },
  text: "...",      // original text content when available
  raw: [/* MCP content */],
  meta: [/* secondary content such as correlation IDs */]
}
```

On failure they return `{ ok: false, error: "..." }`. Always check `ok` and
`error` before using `data`.

### Step 6: Execute the handler and iterate narrowly

Run the handler with `execute_javascript`. If output is too large, edit the
handler to narrow the MCP request before enabling file plugins.

Key rules:

- Import from `host:mcp-<server-name>` (the name from list_mcp_servers)
- Apply `mcp-network` before running MCP handlers; network I/O hits wall-clock limits
- Tool function names are EXACTLY as returned by mcp_tool_info
- All MCP tool calls are async — use `await`
- Tools return `{ ok, data, text, raw, error }` — check `ok`/`error` first
- `data` is the parsed primary result; use `raw` only when debugging envelopes
- If output is large, narrow the MCP request in handler code before trying file plugins
- **Write operations** (tools not marked `readOnlyHint: true`) may prompt the
  user for approval before executing. If denied, the tool returns
  `{ ok: false, error: "Operation denied..." }` — handle this gracefully and explain
  to the user what happened. Do NOT retry denied operations.

### Server name patterns

M365 servers use the `work-iq-` prefix:

- `work-iq-mail` — Email (search, send, reply, drafts)
- `work-iq-teams` — Teams (channels, chats, messages)
- `work-iq-calendar` — Calendar (events, scheduling)
- `work-iq-planner` — Planner (tasks, plans)
- `work-iq-sharepoint` — SharePoint (files, sites)
- `work-iq-onedrive` — OneDrive (personal files)
- `work-iq-copilot` — M365 Copilot (natural language queries)

Other servers use their own names (e.g. `github`, `filesystem`).

### Error handling

- If `manage_mcp` returns `success: false` with "requires authentication" —
  tell the user to run `/mcp enable <name>` to authenticate in their browser.
  Once they've done that, retry `manage_mcp` — it will connect silently.
- If `manage_mcp` returns `success: false` with "denied approval" — the user
  declined. Don't retry — explain what the server does and ask if they want to try again.
- If a tool call fails — check `lastError` in `list_mcp_servers()` output.
- OAuth servers may prompt for browser auth on first connect — this is normal.

### Multiple servers in one task

You can connect multiple servers in sequence:

```
manage_mcp({ action: "connect", name: "work-iq-mail" })
manage_mcp({ action: "connect", name: "work-iq-calendar" })
```

Then use tools from both in a single handler.
