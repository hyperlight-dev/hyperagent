// ── MCP integration — barrel export ──────────────────────────────────
//
// Re-exports all MCP modules for clean imports from the agent.

export type {
  MCPServerConfig,
  MCPConfig,
  MCPConnection,
  MCPConnectionState,
  MCPToolSchema,
  MCPApprovalRecord,
  MCPApprovalStore,
} from "./types.js";

export {
  MAX_MCP_SERVERS,
  MAX_MCP_CONNECTIONS,
  MCP_CONNECT_TIMEOUT_MS,
  MCP_CALL_TIMEOUT_MS,
  MCP_MAX_RETRIES,
  MCP_MAX_RESPONSE_BYTES,
  MCP_MAX_DESCRIPTION_LENGTH,
  MCP_SERVER_NAME_PATTERN,
  MCP_RESERVED_NAMES,
} from "./types.js";

export { parseMCPConfig, computeMCPConfigHash } from "./config.js";
export type { MCPConfigError } from "./config.js";

export {
  createMCPClientManager,
  type MCPClientManager,
} from "./client-manager.js";

export {
  createMCPPluginAdapter,
  generateMCPDeclarations,
  generateMCPModuleHints,
  type MCPPluginRegistration,
} from "./plugin-adapter.js";

export {
  loadMCPApprovalStore,
  isMCPApproved,
  approveMCPServer,
  revokeMCPApproval,
  auditMCPTools,
} from "./approval.js";

export {
  sanitiseToolName,
  sanitiseDescription,
  maskEnvValue,
  auditDescription,
} from "./sanitise.js";
