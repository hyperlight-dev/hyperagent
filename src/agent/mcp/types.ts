// ── MCP integration types ────────────────────────────────────────────
//
// Types for MCP server configuration, connection management, and
// tool discovery. These are internal to the agent — guest code never
// sees these types directly.

// ── Transport types ──────────────────────────────────────────────────

/** Transport type discriminator. */
export type MCPTransportType = "stdio" | "http";

// ── Tool filtering (shared across transports) ────────────────────────

/** Fields common to both stdio and HTTP server configs. */
interface MCPServerConfigBase {
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

// ── stdio transport ──────────────────────────────────────────────────

/**
 * Configuration for an MCP server running as a child process (stdio).
 * This is the original transport and the default when "type" is omitted.
 */
export interface MCPStdioServerConfig extends MCPServerConfigBase {
  /** Transport type — "stdio" or omitted (defaults to "stdio"). */
  type?: "stdio";

  /** Command to spawn the MCP server process. */
  command: string;

  /** Arguments passed to the command. */
  args?: string[];

  /**
   * Environment variables for the server process.
   * Supports `${ENV_VAR}` substitution from the host environment.
   */
  env?: Record<string, string>;
}

// ── HTTP transport ───────────────────────────────────────────────────

/** Supported authentication methods for HTTP MCP servers. */
export type MCPAuthMethod =
  | "oauth"
  | "workload-identity"
  | "client-credentials";

/**
 * OAuth 2.0 user-delegated authentication via MSAL.
 *
 * Uses @azure/msal-node's PublicClientApplication under the hood.
 * Token caching, refresh, and PKCE are handled by MSAL automatically.
 *
 * Two flows are supported and `flow` MUST be set explicitly:
 *
 *   • "browser" — acquireTokenInteractive (auth-code + PKCE).
 *     MSAL opens the system browser and spins up an ephemeral loopback
 *     server on http://localhost (random port, no path suffix). This
 *     redirect URI is registered by default on MSAL-compatible Entra
 *     apps (FOCI / VS Code / az CLI). Custom registrations may need a
 *     different `redirectUri` — see below.
 *
 *   • "device-code" — acquireTokenByDeviceCode (RFC 8628).
 *     Prints a verification URL + user code to the terminal; the user
 *     opens the URL on any device, types the code, signs in. No
 *     redirect URI or loopback port needed — works in SSH sessions,
 *     containers, and locked-down corporate machines.
 */
export interface MCPOAuthConfig {
  method: "oauth";

  /** Which user-interaction flow to use. Required — no default. */
  flow: "browser" | "device-code";

  /** OAuth client (application) ID. */
  clientId: string;

  /** Entra ID tenant ID. If omitted, defaults to "organizations". */
  tenantId?: string;

  /** Requested OAuth scopes (e.g. ["Mail.Read"]). */
  scopes?: string[];

  /**
   * Override redirect URI for the browser flow. @default "http://localhost"
   * Only needed for custom Entra app registrations that have a different
   * redirect URI configured. MSAL-compatible apps (VS Code FOCI, az CLI)
   * work with the default. Ignored for device-code flow.
   */
  redirectUri?: string;
}

/**
 * Azure Workload Identity authentication for K8s/AKS pods.
 * Uses the projected service account token to obtain an Entra access token.
 * Requires: AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_FEDERATED_TOKEN_FILE
 * environment variables (injected by the workload identity webhook).
 */
export interface MCPWorkloadIdentityConfig {
  method: "workload-identity";
}

/**
 * OAuth 2.0 client credentials flow (service-to-service, no user).
 * Uses a client secret to obtain an app-level access token.
 */
export interface MCPClientCredentialsConfig {
  method: "client-credentials";

  /** OAuth client (application) ID. */
  clientId: string;

  /** Entra ID tenant ID. */
  tenantId: string;

  /**
   * Name of the environment variable holding the client secret.
   * The actual secret is never stored in config — only the env var name.
   */
  clientSecretEnv: string;

  /** Requested scopes (e.g. ["https://graph.microsoft.com/.default"]). */
  scopes?: string[];
}

/** Discriminated union of all auth configurations. */
export type MCPAuthConfig =
  | MCPOAuthConfig
  | MCPWorkloadIdentityConfig
  | MCPClientCredentialsConfig;

/**
 * Configuration for an MCP server accessible over HTTP (Streamable HTTP).
 * Used for remote servers like Microsoft Work IQ / Office 365.
 */
export interface MCPHttpServerConfig extends MCPServerConfigBase {
  /** Transport type — must be "http". */
  type: "http";

  /** Server URL (must be https:// in production). */
  url: string;

  /** Static HTTP headers to include in every request. */
  headers?: Record<string, string>;

  /** Authentication configuration (omit for unauthenticated servers). */
  auth?: MCPAuthConfig;
}

// ── Union type ───────────────────────────────────────────────────────

/**
 * MCP server configuration — discriminated union on the `type` field.
 * When `type` is omitted, defaults to stdio transport.
 */
export type MCPServerConfig = MCPStdioServerConfig | MCPHttpServerConfig;

/**
 * Type guard: returns true if the config uses HTTP transport.
 */
export function isMCPHttpConfig(
  config: MCPServerConfig,
): config is MCPHttpServerConfig {
  return config.type === "http";
}

/**
 * Type guard: returns true if the config uses stdio transport.
 */
export function isMCPStdioConfig(
  config: MCPServerConfig,
): config is MCPStdioServerConfig {
  return config.type !== "http";
}

/**
 * Get a human-readable connection string for display purposes.
 * Returns "command args..." for stdio or the URL for HTTP servers.
 */
export function mcpConfigDisplayString(config: MCPServerConfig): string {
  if (isMCPHttpConfig(config)) {
    return config.url;
  }
  return `${config.command} ${(config.args ?? []).join(" ")}`.trim();
}

/** Parsed and validated MCP configuration (all servers). */
export interface MCPConfig {
  servers: Map<string, MCPServerConfig>;
}

/** MCP tool annotations — hints about tool behaviour (from MCP spec). */
export interface MCPToolAnnotations {
  /** Tool only reads data, no side effects. */
  readOnlyHint?: boolean;
  /** Tool can delete or destroy data. */
  destructiveHint?: boolean;
  /** Tool is safe to retry (same input → same effect). */
  idempotentHint?: boolean;
  /** Tool interacts with the external world. */
  openWorldHint?: boolean;
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

  /** Behavioural annotations from the server (hints, not guarantees). */
  annotations?: MCPToolAnnotations;
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
export const MAX_MCP_SERVERS = 50;

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
