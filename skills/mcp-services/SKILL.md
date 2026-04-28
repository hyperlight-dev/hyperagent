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
  - Don't guess tool names — always call mcp_server_info() first
  - Don't hardcode MCP tool schemas — they change when servers update
allowed-tools:
  - register_handler
  - list_mcp_servers
  - mcp_server_info
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

### Step 3: Get tool schemas

```
mcp_server_info("work-iq-mail")
```

Returns full JSON Schema for every tool plus TypeScript declarations. Read this
BEFORE writing handler code — tool names and parameter shapes vary per server.

### Step 4: Use the tools in handler code

```javascript
import { SearchEmails } from "host:mcp-work-iq-mail";

export default async function handler(event) {
  const result = await SearchEmails({ query: "from:boss subject:urgent" });
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}
```

Key rules:

- Import from `host:mcp-<server-name>` (the name from list_mcp_servers)
- Tool function names are EXACTLY as returned by mcp_server_info
- All MCP tool calls are async — use `await`
- Tools return `{ content: [{type, text}] }` — parse the text field as needed
- Some servers return embedded JSON (status text + JSON) — extract the JSON part
- **Write operations** (tools not marked `readOnlyHint: true`) may prompt the
  user for approval before executing. If denied, the tool returns
  `{ error: "Operation denied..." }` — handle this gracefully and explain
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
