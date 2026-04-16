// ── MCP config parser ────────────────────────────────────────────────
//
// Parses and validates the `mcpServers` section of
// ~/.hyperagent/config.json. Supports ${ENV_VAR} substitution
// in env values. Rejects invalid names, collisions with native
// plugins, and configs exceeding the server limit.

import {
  type MCPServerConfig,
  type MCPConfig,
  MAX_MCP_SERVERS,
  MCP_SERVER_NAME_PATTERN,
  MCP_RESERVED_NAMES,
} from "./types.js";

import { createHash } from "node:crypto";

/** Errors collected during config validation. */
export interface MCPConfigError {
  server: string;
  message: string;
}

/**
 * Parse and validate MCP server configuration from config.json data.
 *
 * @param raw - The `mcpServers` object from config.json (or undefined).
 * @returns Parsed config and any validation errors.
 */
export function parseMCPConfig(raw: unknown): {
  config: MCPConfig;
  errors: MCPConfigError[];
} {
  const config: MCPConfig = { servers: new Map() };
  const errors: MCPConfigError[] = [];

  if (raw === undefined || raw === null) {
    return { config, errors };
  }

  if (typeof raw !== "object" || Array.isArray(raw)) {
    errors.push({
      server: "(root)",
      message: "mcpServers must be an object",
    });
    return { config, errors };
  }

  const entries = Object.entries(raw as Record<string, unknown>);

  if (entries.length > MAX_MCP_SERVERS) {
    errors.push({
      server: "(root)",
      message: `Too many MCP servers (${entries.length}). Maximum is ${MAX_MCP_SERVERS}.`,
    });
    return { config, errors };
  }

  for (const [name, value] of entries) {
    const serverErrors = validateServerEntry(name, value);
    if (serverErrors.length > 0) {
      errors.push(...serverErrors);
      continue;
    }

    const serverConfig = value as Record<string, unknown>;
    const resolved = resolveServerConfig(name, serverConfig);
    config.servers.set(name, resolved);
  }

  return { config, errors };
}

/**
 * Validate a single server entry.
 */
function validateServerEntry(name: string, value: unknown): MCPConfigError[] {
  const errors: MCPConfigError[] = [];

  // Name validation
  if (!MCP_SERVER_NAME_PATTERN.test(name)) {
    errors.push({
      server: name,
      message: `Invalid server name. Must match ${MCP_SERVER_NAME_PATTERN} (lowercase alphanumeric + hyphens, starting with a letter).`,
    });
    return errors;
  }

  if (MCP_RESERVED_NAMES.has(name)) {
    errors.push({
      server: name,
      message: `"${name}" is a reserved name (conflicts with native plugin or MCP system).`,
    });
    return errors;
  }

  // Value must be an object
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    errors.push({
      server: name,
      message: "Server config must be an object.",
    });
    return errors;
  }

  const obj = value as Record<string, unknown>;

  // Command is required
  if (typeof obj.command !== "string" || obj.command.trim().length === 0) {
    errors.push({
      server: name,
      message: '"command" is required and must be a non-empty string.',
    });
  }

  // Args must be array of strings if present
  if (obj.args !== undefined) {
    if (
      !Array.isArray(obj.args) ||
      !obj.args.every((a: unknown) => typeof a === "string")
    ) {
      errors.push({
        server: name,
        message: '"args" must be an array of strings.',
      });
    }
  }

  // Env must be Record<string, string> if present
  if (obj.env !== undefined) {
    if (
      typeof obj.env !== "object" ||
      obj.env === null ||
      Array.isArray(obj.env)
    ) {
      errors.push({
        server: name,
        message: '"env" must be an object of string key-value pairs.',
      });
    }
  }

  // allowTools must be array of strings if present
  if (obj.allowTools !== undefined) {
    if (
      !Array.isArray(obj.allowTools) ||
      !obj.allowTools.every((t: unknown) => typeof t === "string")
    ) {
      errors.push({
        server: name,
        message: '"allowTools" must be an array of strings.',
      });
    }
  }

  // denyTools must be array of strings if present
  if (obj.denyTools !== undefined) {
    if (
      !Array.isArray(obj.denyTools) ||
      !obj.denyTools.every((t: unknown) => typeof t === "string")
    ) {
      errors.push({
        server: name,
        message: '"denyTools" must be an array of strings.',
      });
    }
  }

  return errors;
}

/**
 * Resolve a validated server config, performing ${ENV_VAR} substitution.
 */
function resolveServerConfig(
  _name: string,
  raw: Record<string, unknown>,
): MCPServerConfig {
  const resolved: MCPServerConfig = {
    command: (raw.command as string).trim(),
  };

  if (raw.args) {
    resolved.args = (raw.args as string[]).map((a) => a.trim());
  }

  if (raw.env) {
    resolved.env = {};
    for (const [key, value] of Object.entries(
      raw.env as Record<string, string>,
    )) {
      resolved.env[key] = substituteEnvVars(String(value));
    }
  }

  if (raw.allowTools) {
    resolved.allowTools = raw.allowTools as string[];
  }

  if (raw.denyTools) {
    resolved.denyTools = raw.denyTools as string[];
  }

  return resolved;
}

/**
 * Substitute ${ENV_VAR} references with values from the host environment.
 * Unresolved variables are left as empty strings with a warning logged.
 */
function substituteEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
    const envValue = process.env[varName.trim()];
    if (envValue === undefined) {
      console.error(
        `[mcp] Warning: environment variable ${varName} is not set`,
      );
      return "";
    }
    return envValue;
  });
}

/**
 * Compute a config hash for approval validation.
 * Includes name, command, args, tool filtering, and env key names.
 * Any execution-affecting config change invalidates the approval.
 */
export function computeMCPConfigHash(
  name: string,
  config: MCPServerConfig,
): string {
  return (
    createHash("sha256")
      .update(name, "utf8")
      .update(config.command, "utf8")
      .update(JSON.stringify(config.args ?? []), "utf8")
      .update(JSON.stringify(config.allowTools ?? []), "utf8")
      .update(JSON.stringify(config.denyTools ?? []), "utf8")
      // Hash env key names (not values — secrets stay out of the hash)
      .update(JSON.stringify(Object.keys(config.env ?? {}).sort()), "utf8")
      .digest("hex")
  );
}
