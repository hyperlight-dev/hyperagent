// ── Tool Gating ──────────────────────────────────────────────────────
//
// The SDK registers a zoo of built-in tools (bash, grep, edit, view,
// write_bash, read_bash, sql…). We use the hooks.onPreToolUse hook
// (from the README) to deny everything except our sandboxed tool and
// the protocol tool the model needs to signal intent.
//
// Everything not on this list gets denied before execution.
//
// ─────────────────────────────────────────────────────────────────────

/** Tool names we allow. Everything else gets denied before execution. */
export const ALLOWED_TOOLS = new Set<string>([
  "register_handler", // Register named JavaScript handler
  "execute_javascript", // Execute a registered handler
  "delete_handler", // Remove a handler
  "get_handler_source", // Retrieve handler source for editing
  "edit_handler", // Surgical edit to existing handler
  "list_handlers", // List registered handlers with line counts
  "reset_sandbox", // Clear state, keep handlers
  "configure_sandbox", // Change resource limits (heap, scratch, timeouts, buffers)
  "manage_plugin", // Enable/disable plugins
  "list_plugins", // Discover available plugins
  "plugin_info", // Detailed plugin information
  "sandbox_help", // On-demand patterns and guidance
  "apply_profile", // Apply named resource profiles
  "register_module", // Register a reusable ES module
  "list_modules", // List available modules (system + user)
  "module_info", // Detailed module info + exports
  "delete_module", // Delete a user module
  "write_output", // Write text content directly to fs-write base directory
  "read_input", // Read text content directly from fs-read base directory
  "read_output", // Read content from a previously written output
  "report_intent", // SDK protocol — the model uses this to signal intent
  "ask_user", // SDK protocol — structured questions to the user
  "list_mcp_servers", // List configured MCP servers + status
  "mcp_server_info", // Detailed MCP server info + tool schemas
  "manage_mcp", // Connect/disconnect MCP servers
]);
