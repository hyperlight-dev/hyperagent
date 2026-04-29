// ── MCP client manager ───────────────────────────────────────────────
//
// Manages the lifecycle of MCP server connections. Connections are
// lazy (spawned on first tool call), session-scoped, and auto-reconnect
// on failure (up to MAX_RETRIES).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";

import {
  type MCPServerConfig,
  type MCPHttpServerConfig,
  type MCPConnection,
  type MCPToolSchema,
  type MCPConnectionState,
  isMCPStdioConfig,
  isMCPHttpConfig,
  MAX_MCP_CONNECTIONS,
  MCP_CONNECT_TIMEOUT_MS,
  MCP_CALL_TIMEOUT_MS,
  MCP_MAX_RETRIES,
  MCP_MAX_RESPONSE_BYTES,
  MCP_MAX_DESCRIPTION_LENGTH,
} from "./types.js";
import { sanitiseToolName, sanitiseDescription } from "./sanitise.js";
import {
  acquireMsalToken,
  createMsalOAuthProvider,
  canAcquireSilently,
} from "./auth/msal-oauth.js";
import { createRetryFetch } from "./retry-fetch.js";
import {
  loadCachedSession,
  saveCachedSession,
  deleteCachedSession,
} from "./session-cache.js";

export interface MCPToolCallResult {
  ok: boolean;
  data?: unknown;
  text?: string;
  raw?: unknown;
  meta?: unknown[];
  error?: string;
  truncated?: boolean;
}

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
   * For HTTP servers with OAuth, handles auth via MSAL:
   *   1. Attempt token acquisition via MSAL (silent → interactive)
   *   2. Connect with authenticated transport
   *   3. If no TTY and no cached tokens → fail with clear instructions
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
      // For HTTP + OAuth servers, handle the auth flow via MSAL
      if (
        isMCPHttpConfig(conn.config) &&
        conn.config.auth?.method === "oauth"
      ) {
        return await connectWithMsal(name, conn);
      }

      // Standard connection (stdio or unauthenticated HTTP)
      return await connectDirect(name, conn);
    } catch (err) {
      conn.state = "error";
      conn.lastError = (err as Error).message;
      conn.retryCount++;
      // A cached session id may be stale (server-side expiry); drop it
      // so the next attempt starts a fresh handshake.
      deleteCachedSession(name);
      throw new Error(
        `[mcp] Failed to connect to "${name}": ${(err as Error).message}`,
      );
    }
  }

  /**
   * Direct connection — no OAuth flow. Used for stdio and
   * unauthenticated HTTP servers.
   */
  async function connectDirect(
    name: string,
    conn: MCPConnection,
  ): Promise<MCPConnection> {
    const transport = createTransport(conn.config, name);
    return await connectWithTransport(name, conn, transport);
  }

  /**
   * Connect to an HTTP server using MSAL for OAuth authentication.
   *
   * MSAL handles both browser (PKCE, ephemeral loopback) and device-code
   * flows, plus silent token refresh via its internal cache. We eagerly
   * acquire a token before connecting so the MCP SDK transport gets a
   * valid Bearer token on the first request.
   *
   * If there's already a valid cached token, acquireMsalToken() returns
   * it silently — no browser or device-code prompt.
   */
  async function connectWithMsal(
    name: string,
    conn: MCPConnection,
  ): Promise<MCPConnection> {
    const httpConfig = conn.config as MCPHttpServerConfig;
    const authConfig = httpConfig.auth!;

    if (authConfig.method !== "oauth") {
      throw new Error(`[mcp] connectWithMsal called with non-oauth method`);
    }

    const isInteractive = process.stdin.isTTY === true;
    if (!isInteractive) {
      // In non-interactive mode, we can only succeed if MSAL can
      // refresh silently. Use canAcquireSilently() which never triggers
      // interactive auth — it returns false if interaction is needed.
      const canSilent = await canAcquireSilently(name, authConfig);
      if (!canSilent) {
        throw new Error(
          `[mcp] OAuth authentication required for "${name}" but no valid ` +
            `cached tokens and no interactive terminal available.\n` +
            `  Run HyperAgent interactively first to authenticate:\n` +
            `    npx tsx src/agent/index.ts\n` +
            `    /mcp enable ${name}`,
        );
      }
    } else {
      // Interactive: acquire token eagerly (silent → browser/device-code).
      await acquireMsalToken(name, authConfig);
      console.error(`[mcp] ✅ Authentication successful.`);
    }

    // Build a provider that serves cached tokens to the MCP transport.
    const provider = createMsalOAuthProvider(name, authConfig);

    const url = new URL(httpConfig.url);
    const requestInit: RequestInit = {};
    if (httpConfig.headers && Object.keys(httpConfig.headers).length > 0) {
      requestInit.headers = { ...httpConfig.headers };
    }

    const cachedSessionId = loadCachedSession(name);
    const transport = new StreamableHTTPClientTransport(url, {
      authProvider: provider,
      requestInit,
      fetch: createRetryFetch(),
      ...(cachedSessionId ? { sessionId: cachedSessionId } : {}),
    });

    return await connectWithTransport(name, conn, transport);
  }

  /**
   * Complete a connection using a pre-built transport.
   * Handles client creation, timeout, tool discovery, and state update.
   */
  async function connectWithTransport(
    name: string,
    conn: MCPConnection,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transport: any,
  ): Promise<MCPConnection> {
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
            new Error(`Connection timed out after ${MCP_CONNECT_TIMEOUT_MS}ms`),
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
      // Capture behavioural annotations if the server provides them.
      // These are hints (not guarantees) used by the write-safety gate.
      ...(tool.annotations
        ? {
            annotations: {
              ...(tool.annotations.readOnlyHint !== undefined
                ? { readOnlyHint: tool.annotations.readOnlyHint }
                : {}),
              ...(tool.annotations.destructiveHint !== undefined
                ? { destructiveHint: tool.annotations.destructiveHint }
                : {}),
              ...(tool.annotations.idempotentHint !== undefined
                ? { idempotentHint: tool.annotations.idempotentHint }
                : {}),
              ...(tool.annotations.openWorldHint !== undefined
                ? { openWorldHint: tool.annotations.openWorldHint }
                : {}),
            },
          }
        : {}),
    }));

    conn.client = client;
    conn.transport = transport;
    conn.tools = sanitised;
    conn.state = "connected";
    conn.lastError = undefined;

    // Persist the session id (HTTP transports only) so we can resume on
    // next start. transport.sessionId is set by the SDK after the
    // initialize handshake completes.
    const sessionId =
      typeof transport === "object" &&
      transport !== null &&
      "sessionId" in transport
        ? (transport as { sessionId?: unknown }).sessionId
        : undefined;
    if (typeof sessionId === "string" && sessionId.length > 0) {
      saveCachedSession(name, sessionId);
    }

    console.error(
      `[mcp] Connected to "${name}" — ${sanitised.length} tool(s) available`,
    );

    return conn;
  }

  /**
   * Call a tool on an MCP server. Handles lazy connection and retry.
   */
  async function callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<MCPToolCallResult> {
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
        return {
          ok: false,
          error: errorText,
          text: errorText,
          raw: result.content,
        };
      }

      // Extract content, enforce size limit against the useful payload first.
      // raw duplicates the original MCP content and may be much larger than
      // the parsed data/text the handler actually needs.
      const normalised = normaliseToolResult(result.content);
      const payloadSize = JSON.stringify({
        data: normalised.data,
        text: normalised.text,
        meta: normalised.meta,
      }).length;
      if (payloadSize > MCP_MAX_RESPONSE_BYTES) {
        return {
          ok: false,
          error: `Response too large (${payloadSize} bytes). Maximum is ${MCP_MAX_RESPONSE_BYTES} bytes.`,
          truncated: true,
        };
      }

      const fullSize = JSON.stringify(normalised).length;
      if (fullSize > MCP_MAX_RESPONSE_BYTES) {
        return { ...normalised, raw: undefined, truncated: true };
      }

      return normalised;
    } catch (err) {
      // Server may have died or network is down — mark as error for reconnect
      const msg = (err as Error).message;
      if (
        msg.includes("closed") ||
        msg.includes("EPIPE") ||
        msg.includes("ECONNRESET") ||
        msg.includes("ECONNREFUSED") ||
        msg.includes("ETIMEDOUT") ||
        msg.includes("fetch failed")
      ) {
        conn.state = "error";
        conn.lastError = msg;
      }
      return { ok: false, error: `[mcp] Tool call failed: ${msg}` };
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
 * Create the appropriate transport for a server config.
 * Returns a StdioClientTransport for stdio configs and a
 * StreamableHTTPClientTransport for HTTP configs.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createTransport(config: MCPServerConfig, serverName?: string): any {
  if (isMCPHttpConfig(config)) {
    return createHttpTransport(config, serverName);
  }

  // stdio transport (default)
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...(config.env ?? {}),
  };

  return new StdioClientTransport({
    command: config.command,
    args: config.args,
    env,
  });
}

/**
 * Create a StreamableHTTPClientTransport for an HTTP MCP server.
 * Used for unauthenticated HTTP servers and non-OAuth auth methods.
 * OAuth is handled separately in connectWithMsal().
 */
function createHttpTransport(
  config: MCPHttpServerConfig,
  serverName?: string,
): StreamableHTTPClientTransport {
  const url = new URL(config.url);

  // Build request init with static headers from config
  const requestInit: RequestInit = {};
  if (config.headers && Object.keys(config.headers).length > 0) {
    requestInit.headers = { ...config.headers };
  }

  const sessionId = serverName ? loadCachedSession(serverName) : undefined;
  return new StreamableHTTPClientTransport(url, {
    requestInit,
    fetch: createRetryFetch(),
    ...(sessionId ? { sessionId } : {}),
  });
}

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
 *
 * Agent 365 servers return three flavours of single-text responses:
 *
 *   1. Clean JSON      — `{"teams":[...]}`                  (Teams)
 *   2. Status + JSON   — `Success.\n{"value":[...]}`        (Calendar)
 *   3. Wrapped JSON    — `{"rawResponse":"…","message":…}`  (Mail)
 *
 * `extractEmbeddedJson` peels back layers (1) → (2) → (3) so callers
 * always get the structured data.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractContent(content: any[]): unknown {
  if (!Array.isArray(content)) return content;

  // Single text content → unwrap to structured data when possible
  if (content.length === 1 && content[0].type === "text") {
    return extractEmbeddedJson(content[0].text);
  }

  // Multiple items → return structured, parsing each text item
  return content.map((c) => {
    if (c.type === "text") {
      return { type: "text", data: extractEmbeddedJson(c.text) };
    }
    return c;
  });
}

/**
 * Convert arbitrary MCP content into the stable shape exposed to the LLM.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normaliseToolResult(content: any[]): MCPToolCallResult {
  const extracted = extractContent(content);
  const text = extractTextContent(content);
  const { data, meta } = selectPrimaryData(extracted);

  return {
    ok: true,
    data,
    ...(text ? { text } : {}),
    raw: content,
    ...(meta.length > 0 ? { meta } : {}),
  };
}

function selectPrimaryData(extracted: unknown): {
  data: unknown;
  meta: unknown[];
} {
  if (!Array.isArray(extracted)) {
    return { data: extracted, meta: [] };
  }

  const dataItems = extracted.filter(hasDataProperty);
  if (dataItems.length === 0) {
    return { data: extracted, meta: [] };
  }

  const structuredItems = dataItems.filter((item) => isStructured(item.data));
  if (structuredItems.length === 1) {
    return {
      data: structuredItems[0].data,
      meta: extracted.filter((item) => item !== structuredItems[0]),
    };
  }

  if (structuredItems.length > 1) {
    return {
      data: structuredItems.map((item) => item.data),
      meta: extracted.filter((item) => !structuredItems.includes(item)),
    };
  }

  return {
    data: dataItems.map((item) => item.data),
    meta: extracted.filter((item) => !dataItems.includes(item)),
  };
}

function hasDataProperty(value: unknown): value is { data: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.prototype.hasOwnProperty.call(value, "data")
  );
}

function isStructured(value: unknown): boolean {
  return typeof value === "object" && value !== null;
}

/**
 * Try to recover structured JSON from a text content payload.
 * Handles three patterns observed in the wild:
 *
 *   • clean JSON           → returns the parsed object
 *   • status + JSON        → strips leading status text, returns JSON
 *   • {rawResponse: "..."} → un-nests one level, recurses
 *
 * Falls back to the original string if no pattern matches.
 */
export function extractEmbeddedJson(text: string): unknown {
  if (typeof text !== "string") return text;
  const trimmed = text.trim();
  if (trimmed.length === 0) return text;

  // (1) Clean JSON — most common.
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      // (3) Wrapped: { rawResponse: "<json string>", message: "..." }
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        typeof (parsed as { rawResponse?: unknown }).rawResponse === "string"
      ) {
        const inner = (parsed as { rawResponse: string }).rawResponse;
        return extractEmbeddedJson(inner);
      }
      return parsed;
    } catch {
      // fall through
    }
  }

  // (2) Status + JSON — find the first "{" or "[" after some prefix and
  // try parsing from there. Only accept if the suffix is itself valid
  // JSON, otherwise we'd false-positive on prose containing a brace.
  const firstBrace = trimmed.search(/[\{\[]/);
  if (firstBrace > 0) {
    const suffix = trimmed.slice(firstBrace);
    try {
      return JSON.parse(suffix) as unknown;
    } catch {
      // fall through
    }
  }

  return text;
}
