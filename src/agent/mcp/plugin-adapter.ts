// ── MCP plugin adapter ───────────────────────────────────────────────
//
// Wraps an MCP server connection as a PluginRegistration so it can
// be registered with the sandbox via setPlugins() alongside native
// plugins. Each MCP server becomes a host module at `host:mcp-<name>`.
//
// Write-safety gate: tools that are not read-only are intercepted
// before execution. In interactive mode, the user is prompted to
// approve. In auto-approve mode, they execute silently. In non-
// interactive mode without auto-approve, they are refused.

import type { MCPClientManager } from "./client-manager.js";
import type {
  MCPConnection,
  MCPToolSchema,
  MCPToolAnnotations,
} from "./types.js";
import { isReadOnlyMCPTool } from "./tool-utils.js";

/**
 * Callback that decides whether a write operation should proceed.
 *
 * @param serverName - MCP server name (e.g. "work-iq-mail")
 * @param toolName - Tool name (e.g. "SendEmail")
 * @param args - The arguments being passed to the tool
 * @param annotations - Tool annotations (hints from server)
 * @returns true to allow, false to deny
 */
export type WriteSafetyGate = (
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
  annotations: MCPToolAnnotations | undefined,
) => Promise<boolean>;

/**
 * PluginRegistration-compatible interface.
 * Matches the shape expected by src/sandbox/tool.js setPlugins().
 */
export interface MCPPluginRegistration {
  name: string;
  declaredModules: string[];
  createHostFunctions: (
    config: object,
  ) => Record<string, Record<string, (...args: unknown[]) => unknown>>;
  config: Record<string, unknown>;
}

/**
 * Create a PluginRegistration adapter for an MCP server.
 * The adapter bridges sandbox function calls to MCP tool calls
 * via the client manager.
 *
 * @param conn - The MCP server connection (must be connected).
 * @param manager - The client manager for making tool calls.
 * @param gate - Optional write-safety gate. When provided, non-read-only
 *   tools are checked before execution.
 * @returns A PluginRegistration that can be passed to setPlugins().
 */
export function createMCPPluginAdapter(
  conn: MCPConnection,
  manager: MCPClientManager,
  gate?: WriteSafetyGate,
): MCPPluginRegistration {
  const moduleName = `mcp-${conn.name}`;

  return {
    name: moduleName,
    declaredModules: [moduleName],
    config: {},
    createHostFunctions: () => {
      const functions: Record<string, (...args: unknown[]) => unknown> = {};

      for (const tool of conn.tools) {
        functions[tool.name] = async (...args: unknown[]): Promise<unknown> => {
          const toolArgs = (args[0] as Record<string, unknown>) ?? {};

          // Write-safety gate: check tools that are not known or inferred
          // read-only. The guest VM is paused during this check, so it is
          // safe to prompt the user.
          if (gate && !isReadOnlyMCPTool(tool)) {
            const allowed = await gate(
              conn.name,
              tool.name,
              toolArgs,
              tool.annotations,
            );
            if (!allowed) {
              return {
                ok: false,
                error: `Operation denied: ${tool.name} on ${conn.name} was blocked by the write-safety gate. The user declined the operation.`,
              };
            }
          }

          return manager.callTool(conn.name, tool.name, toolArgs);
        };
      }

      return { [moduleName]: functions };
    },
  };
}

/**
 * Generate TypeScript declarations for an MCP server's tools.
 * Used for LLM discovery via module_info().
 */
export function generateMCPDeclarations(
  serverName: string,
  tools: MCPToolSchema[],
): string {
  // NOTE: No `declare module` wrapper — the validator's .d.ts parser
  // doesn't handle ambient module blocks. The dtsSources key already
  // identifies which module this belongs to.
  const lines: string[] = [];

  for (const tool of tools) {
    // Generate input interface from JSON Schema
    const inputInterface = generateInputInterface(tool);
    if (inputInterface) {
      lines.push(inputInterface);
    }

    // Generate function declaration with JSDoc
    const paramType = inputInterface
      ? `${pascalCase(tool.name)}Input`
      : "Record<string, unknown>";
    lines.push(`/** ${tool.description} */`);
    lines.push(
      `export declare function ${tool.name}(input: ${paramType}): Promise<unknown>;`,
    );
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Generate module hints for LLM discovery (structuredHints format).
 */
export function generateMCPModuleHints(
  serverName: string,
  tools: MCPToolSchema[],
): Record<string, unknown> {
  return {
    overview: `MCP server "${serverName}" — ${tools.length} tool(s) available via host:mcp-${serverName}`,
    criticalRules: [
      `Import with: import { toolName } from "host:mcp-${serverName}"`,
      "All calls are async — use await",
      "Returns { ok: boolean, data?: unknown, text?: string, error?: string } — always check ok/error",
    ],
    exports: tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: extractParameterSummary(t.inputSchema),
    })),
  };
}

// ── Internal helpers ─────────────────────────────────────────────────

/**
 * Generate a TypeScript interface from a JSON Schema input.
 */
function generateInputInterface(tool: MCPToolSchema): string | null {
  const schema = tool.inputSchema;
  if (!schema || typeof schema !== "object") return null;

  const properties = (schema as Record<string, unknown>).properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!properties) return null;

  const required = new Set(
    ((schema as Record<string, unknown>).required as string[]) ?? [],
  );

  const interfaceName = `${pascalCase(tool.name)}Input`;
  const lines: string[] = [];
  lines.push(`interface ${interfaceName} {`);

  for (const [propName, propSchema] of Object.entries(properties)) {
    const tsType = jsonSchemaToTS(propSchema);
    const optional = required.has(propName) ? "" : "?";
    const desc = propSchema.description
      ? ` /** ${propSchema.description} */\n`
      : "";
    // Quote property names that aren't valid JS identifiers
    const safeName = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(propName)
      ? propName
      : `"${propName}"`;
    lines.push(`${desc}  ${safeName}${optional}: ${tsType};`);
  }

  lines.push("}");
  return lines.join("\n");
}

/**
 * Convert a JSON Schema type to a TypeScript type string.
 */
function jsonSchemaToTS(schema: Record<string, unknown>): string {
  const type = schema.type as string | undefined;
  switch (type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "array": {
      const items = schema.items as Record<string, unknown> | undefined;
      const itemType = items ? jsonSchemaToTS(items) : "unknown";
      return `${itemType}[]`;
    }
    case "object":
      return "Record<string, unknown>";
    default:
      return "unknown";
  }
}

/**
 * Convert a tool name to PascalCase for interface names.
 */
function pascalCase(name: string): string {
  return name
    .split(/[_-]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/**
 * Extract a human-readable parameter summary from JSON Schema.
 */
function extractParameterSummary(schema: Record<string, unknown>): string {
  const properties = schema.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!properties) return "(no parameters)";

  const required = new Set((schema.required as string[]) ?? []);

  return Object.entries(properties)
    .map(([name, prop]) => {
      const type = prop.type ?? "unknown";
      const req = required.has(name) ? "" : "?";
      return `${name}${req}: ${type}`;
    })
    .join(", ");
}
