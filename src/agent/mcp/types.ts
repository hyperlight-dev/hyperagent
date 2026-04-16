// ── MCP integration types ────────────────────────────────────────────
//
// Types for MCP server configuration, connection management, and
// tool discovery. These are internal to the agent — guest code never
// sees these types directly.

/**
 * MCP server configuration as specified in ~/.hyperagent/config.json.
 * Accepts the same format as VS Code's mcp.json for familiarity.
 */
export interface MCPServerConfig {
  /** Command to spawn the MCP server process. */
  command: string;

  /** Arguments passed to the command. */
  args?: string[];

  /**
   * Environment variables for the server process.
   * Supports `${ENV_VAR}` substitution from the host environment.
   */
  env?: Record<string, string>;

  /**
   * Allowlist of tool names to expose. If set, only these tools are
   * available in the sandbox. Takes precedence over denyTools.
   */
  allowTools?: string[];

  /**
   * Denylist of tool names to hide. If set, these tools are excluded
   * even if discovered. If allowTools is also set, deny is applied
   * after allow (intersection minus denied).
   */
  denyTools?: string[];
}

/** Parsed and validated MCP configuration (all servers). */
export interface MCPConfig {
  servers: Map<string, MCPServerConfig>;
}

/** MCP tool schema as returned by listTools(). */
export interface MCPToolSchema {
  /** Tool name (sanitised to valid JS identifier). */
  name: string;

  /** Original tool name from the server (may contain special chars). */
  originalName: string;

  /** Tool description (sanitised, truncated). */
  description: string;

  /** JSON Schema for the tool's input parameters. */
  inputSchema: Record<string, unknown>;
}

/** Connection state for an MCP server. */
export type MCPConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "error"
  | "closed";

/** Runtime state for a single MCP server connection. */
export interface MCPConnection {
  /** Server name (matches config key). */
  name: string;

  /** Server configuration. */
  config: MCPServerConfig;

  /** MCP SDK client instance (null until connected). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any | null;

  /** MCP SDK transport instance (null until connected). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transport: any | null;

  /** Discovered tools (populated after connection). */
  tools: MCPToolSchema[];

  /** Current connection state. */
  state: MCPConnectionState;

  /** Number of reconnection attempts this session. */
  retryCount: number;

  /** Error message if state is "error". */
  lastError?: string;
}

/** MCP approval record stored in ~/.hyperagent/approved-mcp.json. */
export interface MCPApprovalRecord {
  /** SHA-256 of name + command + JSON.stringify(args). */
  configHash: string;

  /** When the server was approved. */
  approvedAt: string;

  /** Tool names that were visible at approval time. */
  approvedTools: string[];

  /** Any audit warnings flagged during approval. */
  auditWarnings: string[];
}

/** Approval store for MCP servers. */
export type MCPApprovalStore = Record<string, MCPApprovalRecord>;

// ── Constants ────────────────────────────────────────────────────────

/** Maximum number of configured MCP servers. */
export const MAX_MCP_SERVERS = 20;

/** Maximum concurrent MCP connections. */
export const MAX_MCP_CONNECTIONS = 5;

/** Connection timeout in milliseconds. */
export const MCP_CONNECT_TIMEOUT_MS = 10_000;

/** Default per-call timeout in milliseconds. */
export const MCP_CALL_TIMEOUT_MS = 30_000;

/** Maximum response size in bytes (1 MB). */
export const MCP_MAX_RESPONSE_BYTES = 1_048_576;

/** Maximum reconnection attempts per session. */
export const MCP_MAX_RETRIES = 3;

/** Maximum tool description length (chars). */
export const MCP_MAX_DESCRIPTION_LENGTH = 2_000;

/** Valid server name pattern. */
export const MCP_SERVER_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Reserved names that cannot be used for MCP servers. */
export const MCP_RESERVED_NAMES = new Set([
  "fs-read",
  "fs-write",
  "fetch",
  "mcp",
]);
