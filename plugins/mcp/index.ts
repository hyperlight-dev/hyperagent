// ── MCP gateway plugin ───────────────────────────────────────────────
//
// Gateway plugin that enables the MCP subsystem. This plugin goes
// through the normal audit/approve/enable lifecycle. Once enabled,
// it unlocks /mcp slash commands and makes MCP servers discoverable.
//
// The plugin itself provides no host modules — its role is purely
// to gate the MCP subsystem. Individual MCP servers register their
// own host modules dynamically (host:mcp-<name>) when enabled via
// /mcp enable.
//
// Guest JavaScript loads MCP tools via:
//   import { tool_name } from "host:mcp-<server-name>"

import type { ConfigSchema, ConfigValues } from "../plugin-schema-types.js";

// ── Schema ───────────────────────────────────────────────────────────

export const SCHEMA = {} satisfies ConfigSchema;

export type MCPGatewayConfig = ConfigValues<typeof SCHEMA>;

// ── Hints ────────────────────────────────────────────────────────────

export const _HINTS = `
MCP Gateway — Model Context Protocol server integration.

Available /mcp commands:
  /mcp list              — Show configured servers and status
  /mcp enable <name>     — Approve and connect a server
  /mcp disable <name>    — Disconnect a server
  /mcp info <name>       — Show server tools and details
  /mcp approve <name>    — Pre-approve without connecting
  /mcp revoke <name>     — Remove approval

MCP servers are configured in ~/.hyperagent/config.json:
  {
    "mcpServers": {
      "github": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-github"],
        "env": { "GITHUB_TOKEN": "\${GITHUB_TOKEN}" },
        "allowTools": ["list_issues", "create_issue"],
        "denyTools": ["delete_branch"]
      }
    }
  }

Importing MCP tools in handler code:
  import { list_issues } from "host:mcp-github";
  const issues = list_issues({ repo: "owner/repo", state: "open" });

Note: MCP servers are OS processes (not micro-VM sandboxed).
`;

// ── Host functions ───────────────────────────────────────────────────

/**
 * The MCP gateway plugin provides a single sentinel host module,
 * `mcp-gateway`, used to signal that the MCP subsystem is enabled
 * via the plugin approval flow.
 *
 * Individual MCP servers register their own host modules dynamically
 * (`host:mcp-<name>`) when enabled via /mcp enable.
 */
export function createHostFunctions(
  _config?: MCPGatewayConfig,
): Record<string, Record<string, (...args: unknown[]) => unknown>> {
  // Single sentinel module — signals to the agent that MCP is active.
  // Actual MCP server modules are registered dynamically via /mcp enable.
  return {
    "mcp-gateway": {
      status: () => ({ enabled: true }),
    },
  };
}
