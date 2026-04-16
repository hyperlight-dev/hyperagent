// ── MCP client manager ───────────────────────────────────────────────
//
// Manages the lifecycle of MCP server connections. Connections are
// lazy (spawned on first tool call), session-scoped, and auto-reconnect
// on failure (up to MAX_RETRIES).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  type MCPServerConfig,
  type MCPConnection,
  type MCPToolSchema,
  type MCPConnectionState,
  MAX_MCP_CONNECTIONS,
  MCP_CONNECT_TIMEOUT_MS,
  MCP_CALL_TIMEOUT_MS,
  MCP_MAX_RETRIES,
  MCP_MAX_RESPONSE_BYTES,
  MCP_MAX_DESCRIPTION_LENGTH,
} from "./types.js";
import { sanitiseToolName, sanitiseDescription } from "./sanitise.js";

/**
 * Create an MCP client manager that handles connection lifecycle,
 * tool discovery, and tool execution for configured MCP servers.
 */
export function createMCPClientManager() {
  const connections = new Map<string, MCPConnection>();

  /**
   * Register a server config without connecting.
   * Connection happens lazily on first tool call.
   */
  function registerServer(name: string, config: MCPServerConfig): void {
    if (connections.has(name)) return;

    connections.set(name, {
      name,
      config,
      client: null,
      transport: null,
      tools: [],
      state: "idle",
      retryCount: 0,
    });
  }

  /**
   * Connect to an MCP server, discover tools, and apply filtering.
   * Throws on connection failure after timeout.
   */
  async function connect(name: string): Promise<MCPConnection> {
    const conn = connections.get(name);
    if (!conn) {
      throw new Error(`[mcp] Unknown server: ${name}`);
    }

    if (conn.state === "connected" && conn.client) {
      return conn;
    }

    // Check connection limit
    const activeCount = [...connections.values()].filter(
      (c) => c.state === "connected",
    ).length;
    if (activeCount >= MAX_MCP_CONNECTIONS) {
      throw new Error(
        `[mcp] Maximum concurrent connections reached (${MAX_MCP_CONNECTIONS}). Disable an existing server first.`,
      );
    }

    conn.state = "connecting";

    try {
      // Build environment with resolved vars
      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        ...(conn.config.env ?? {}),
      };

      const transport = new StdioClientTransport({
        command: conn.config.command,
        args: conn.config.args,
        env,
      });

      const client = new Client({
        name: "hyperagent",
        version: "1.0.0",
      });

      // Connect with timeout
      const connectPromise = client.connect(transport);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `Connection timed out after ${MCP_CONNECT_TIMEOUT_MS}ms`,
              ),
            ),
          MCP_CONNECT_TIMEOUT_MS,
        ),
      );

      await Promise.race([connectPromise, timeoutPromise]);

      // Discover tools
      const toolsResult = await client.listTools();
      const rawTools = toolsResult.tools ?? [];

      // Apply allow/deny filtering and sanitise
      const filtered = filterTools(rawTools, conn.config);
      const sanitised = filtered.map((tool) => ({
        name: sanitiseToolName(tool.name),
        originalName: tool.name,
        description: sanitiseDescription(tool.description ?? ""),
        inputSchema: (tool.inputSchema as Record<string, unknown>) ?? {},
      }));

      conn.client = client;
      conn.transport = transport;
      conn.tools = sanitised;
      conn.state = "connected";
      conn.lastError = undefined;

      console.error(
        `[mcp] Connected to "${name}" — ${sanitised.length} tool(s) available`,
      );

      return conn;
    } catch (err) {
      conn.state = "error";
      conn.lastError = (err as Error).message;
      conn.retryCount++;
      throw new Error(
        `[mcp] Failed to connect to "${name}": ${(err as Error).message}`,
      );
    }
  }

  /**
   * Call a tool on an MCP server. Handles lazy connection and retry.
   */
  async function callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    let conn = connections.get(serverName);
    if (!conn) {
      throw new Error(`[mcp] Unknown server: ${serverName}`);
    }

    // Lazy connect or reconnect on error
    if (conn.state !== "connected") {
      if (conn.state === "error" && conn.retryCount >= MCP_MAX_RETRIES) {
        throw new Error(
          `[mcp] Server "${serverName}" has failed ${MCP_MAX_RETRIES} times. Restart the agent to retry.`,
        );
      }
      conn = await connect(serverName);
    }

    // Find the original tool name (we sanitised it for JS)
    const tool = conn.tools.find((t) => t.name === toolName);
    const originalName = tool?.originalName ?? toolName;

    try {
      // Call with timeout
      const callPromise = conn.client.callTool({
        name: originalName,
        arguments: args,
      });
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(`Tool call timed out after ${MCP_CALL_TIMEOUT_MS}ms`),
            ),
          MCP_CALL_TIMEOUT_MS,
        ),
      );

      const result = await Promise.race([callPromise, timeoutPromise]);

      // Check for errors
      if (result.isError) {
        const errorText = extractTextContent(result.content);
        return { error: errorText };
      }

      // Extract content, enforce size limit
      const content = extractContent(result.content);
      const contentStr = JSON.stringify(content);
      if (contentStr.length > MCP_MAX_RESPONSE_BYTES) {
        return {
          error: `Response too large (${contentStr.length} bytes). Maximum is ${MCP_MAX_RESPONSE_BYTES} bytes.`,
          truncated: true,
        };
      }

      return content;
    } catch (err) {
      // Server may have died — mark as error for reconnect
      if (
        (err as Error).message.includes("closed") ||
        (err as Error).message.includes("EPIPE") ||
        (err as Error).message.includes("ECONNRESET")
      ) {
        conn.state = "error";
        conn.lastError = (err as Error).message;
      }
      return { error: `[mcp] Tool call failed: ${(err as Error).message}` };
    }
  }

  /**
   * Get the current state of a server connection.
   */
  function getConnection(name: string): MCPConnection | undefined {
    return connections.get(name);
  }

  /**
   * List all registered servers with their state.
   */
  function listServers(): MCPConnection[] {
    return [...connections.values()];
  }

  /**
   * Disconnect a specific server.
   */
  async function disconnect(name: string): Promise<void> {
    const conn = connections.get(name);
    if (!conn) return;

    try {
      if (conn.client) {
        await conn.client.close();
      }
    } catch {
      // Ignore close errors
    }

    conn.client = null;
    conn.transport = null;
    conn.tools = [];
    conn.state = "closed";
  }

  /**
   * Disconnect all servers. Called on agent exit.
   */
  async function disconnectAll(): Promise<void> {
    const names = [...connections.keys()];
    await Promise.allSettled(names.map((n) => disconnect(n)));
    connections.clear();
  }

  return {
    registerServer,
    connect,
    callTool,
    getConnection,
    listServers,
    disconnect,
    disconnectAll,
  };
}

/** Export the type for use elsewhere. */
export type MCPClientManager = ReturnType<typeof createMCPClientManager>;

// ── Internal helpers ─────────────────────────────────────────────────

/**
 * Filter discovered tools based on allowTools/denyTools config.
 * allowTools takes precedence — if set, only those are included.
 * denyTools is then applied to remove any denied tools.
 */
function filterTools(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: any[],
  config: MCPServerConfig,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any[] {
  let filtered = tools;

  if (config.allowTools && config.allowTools.length > 0) {
    const allowed = new Set(config.allowTools);
    filtered = filtered.filter((t) => allowed.has(t.name));
  }

  if (config.denyTools && config.denyTools.length > 0) {
    const denied = new Set(config.denyTools);
    filtered = filtered.filter((t) => !denied.has(t.name));
  }

  return filtered;
}

/**
 * Extract text content from MCP response content array.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractTextContent(content: any[]): string {
  if (!Array.isArray(content)) return String(content);
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/**
 * Extract structured content from MCP response.
 * Returns text for text-only responses, or the full content array.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractContent(content: any[]): unknown {
  if (!Array.isArray(content)) return content;

  // Single text content → return as string
  if (content.length === 1 && content[0].type === "text") {
    // Try to parse as JSON
    try {
      return JSON.parse(content[0].text);
    } catch {
      return content[0].text;
    }
  }

  // Multiple items → return structured
  return content.map((c) => {
    if (c.type === "text") {
      try {
        return { type: "text", data: JSON.parse(c.text) };
      } catch {
        return { type: "text", data: c.text };
      }
    }
    return c;
  });
}
