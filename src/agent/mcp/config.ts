// ── MCP config parser ────────────────────────────────────────────────
//
// Parses and validates the `mcpServers` section of
// ~/.hyperagent/config.json. Supports stdio (command + args) and
// HTTP (url) transports. Handles ${ENV_VAR} substitution in env
// values. Rejects invalid names, collisions with native plugins,
// and configs exceeding the server limit.

import {
  type MCPServerConfig,
  type MCPStdioServerConfig,
  type MCPHttpServerConfig,
  type MCPAuthConfig,
  type MCPConfig,
  isMCPHttpConfig,
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
 * Dispatches to stdio or HTTP validation based on the "type" field.
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

  // Dispatch based on transport type
  const transportType = obj.type ?? "stdio";
  if (transportType === "http") {
    errors.push(...validateHttpServerEntry(name, obj));
  } else if (transportType === "stdio") {
    errors.push(...validateStdioServerEntry(name, obj));
  } else {
    errors.push({
      server: name,
      message: `Invalid transport type "${String(transportType)}". Must be "stdio" or "http".`,
    });
  }

  // Tool filtering (shared across transports)
  errors.push(...validateToolFiltering(name, obj));

  return errors;
}

/**
 * Validate stdio-specific fields (command, args, env).
 */
function validateStdioServerEntry(
  name: string,
  obj: Record<string, unknown>,
): MCPConfigError[] {
  const errors: MCPConfigError[] = [];

  // Command is required for stdio
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

  return errors;
}

/**
 * Validate HTTP-specific fields (url, headers, auth).
 */
function validateHttpServerEntry(
  name: string,
  obj: Record<string, unknown>,
): MCPConfigError[] {
  const errors: MCPConfigError[] = [];

  // URL is required for HTTP
  if (typeof obj.url !== "string" || obj.url.trim().length === 0) {
    errors.push({
      server: name,
      message:
        '"url" is required for HTTP transport and must be a non-empty string.',
    });
    return errors;
  }

  // Validate URL format
  try {
    const parsed = new URL(obj.url as string);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      errors.push({
        server: name,
        message: `URL must use http:// or https:// protocol (got "${parsed.protocol}").`,
      });
    }
  } catch {
    errors.push({
      server: name,
      message: `Invalid URL: "${String(obj.url)}".`,
    });
  }

  // Headers must be Record<string, string> if present
  if (obj.headers !== undefined) {
    if (
      typeof obj.headers !== "object" ||
      obj.headers === null ||
      Array.isArray(obj.headers)
    ) {
      errors.push({
        server: name,
        message: '"headers" must be an object of string key-value pairs.',
      });
    }
  }

  // Validate auth config if present
  if (obj.auth !== undefined) {
    errors.push(...validateAuthConfig(name, obj.auth));
  }

  return errors;
}

/** Valid auth methods. */
const VALID_AUTH_METHODS = new Set([
  "oauth",
  "workload-identity",
  "client-credentials",
]);

/**
 * Validate the auth configuration for an HTTP server.
 */
function validateAuthConfig(name: string, auth: unknown): MCPConfigError[] {
  const errors: MCPConfigError[] = [];

  if (typeof auth !== "object" || auth === null || Array.isArray(auth)) {
    errors.push({
      server: name,
      message: '"auth" must be an object.',
    });
    return errors;
  }

  const obj = auth as Record<string, unknown>;

  if (typeof obj.method !== "string" || !VALID_AUTH_METHODS.has(obj.method)) {
    errors.push({
      server: name,
      message: `"auth.method" must be one of: ${[...VALID_AUTH_METHODS].join(", ")}.`,
    });
    return errors;
  }

  switch (obj.method) {
    case "oauth":
      errors.push(...validateOAuthConfig(name, obj));
      break;
    case "workload-identity":
      // No additional fields required — env vars are checked at connect time
      break;
    case "client-credentials":
      errors.push(...validateClientCredentialsConfig(name, obj));
      break;
  }

  return errors;
}

/**
 * Validate OAuth browser auth config fields.
 */
function validateOAuthConfig(
  name: string,
  obj: Record<string, unknown>,
): MCPConfigError[] {
  const errors: MCPConfigError[] = [];

  if (typeof obj.clientId !== "string" || obj.clientId.trim().length === 0) {
    errors.push({
      server: name,
      message: '"auth.clientId" is required for OAuth authentication.',
    });
  }

  if (obj.tenantId !== undefined && typeof obj.tenantId !== "string") {
    errors.push({
      server: name,
      message: '"auth.tenantId" must be a string.',
    });
  }

  if (obj.scopes !== undefined) {
    if (
      !Array.isArray(obj.scopes) ||
      !obj.scopes.every((s: unknown) => typeof s === "string")
    ) {
      errors.push({
        server: name,
        message: '"auth.scopes" must be an array of strings.',
      });
    }
  }

  if (obj.redirectUri !== undefined && typeof obj.redirectUri !== "string") {
    errors.push({
      server: name,
      message: '"auth.redirectUri" must be a string.',
    });
  }

  if (obj.flow !== "browser" && obj.flow !== "device-code") {
    errors.push({
      server: name,
      message:
        '"auth.flow" is required and must be "browser" or "device-code".',
    });
  }

  return errors;
}

/**
 * Validate client credentials auth config fields.
 */
function validateClientCredentialsConfig(
  name: string,
  obj: Record<string, unknown>,
): MCPConfigError[] {
  const errors: MCPConfigError[] = [];

  if (typeof obj.clientId !== "string" || obj.clientId.trim().length === 0) {
    errors.push({
      server: name,
      message:
        '"auth.clientId" is required for client-credentials authentication.',
    });
  }

  if (typeof obj.tenantId !== "string" || obj.tenantId.trim().length === 0) {
    errors.push({
      server: name,
      message:
        '"auth.tenantId" is required for client-credentials authentication.',
    });
  }

  if (
    typeof obj.clientSecretEnv !== "string" ||
    obj.clientSecretEnv.trim().length === 0
  ) {
    errors.push({
      server: name,
      message:
        '"auth.clientSecretEnv" is required for client-credentials authentication ' +
        "(name of env var holding the secret).",
    });
  }

  if (obj.scopes !== undefined) {
    if (
      !Array.isArray(obj.scopes) ||
      !obj.scopes.every((s: unknown) => typeof s === "string")
    ) {
      errors.push({
        server: name,
        message: '"auth.scopes" must be an array of strings.',
      });
    }
  }

  return errors;
}

/**
 * Validate tool filtering fields (shared across transports).
 */
function validateToolFiltering(
  name: string,
  obj: Record<string, unknown>,
): MCPConfigError[] {
  const errors: MCPConfigError[] = [];

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
 * Returns the appropriate typed config based on transport type.
 */
function resolveServerConfig(
  _name: string,
  raw: Record<string, unknown>,
): MCPServerConfig {
  const transportType = (raw.type as string | undefined) ?? "stdio";

  if (transportType === "http") {
    return resolveHttpServerConfig(raw);
  }

  return resolveStdioServerConfig(raw);
}

/**
 * Resolve a stdio server config with env var substitution.
 */
function resolveStdioServerConfig(
  raw: Record<string, unknown>,
): MCPStdioServerConfig {
  const resolved: MCPStdioServerConfig = {
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
 * Resolve an HTTP server config with auth configuration.
 */
function resolveHttpServerConfig(
  raw: Record<string, unknown>,
): MCPHttpServerConfig {
  const resolved: MCPHttpServerConfig = {
    type: "http",
    url: (raw.url as string).trim(),
  };

  if (raw.headers) {
    resolved.headers = { ...(raw.headers as Record<string, string>) };
  }

  if (raw.auth) {
    resolved.auth = resolveAuthConfig(raw.auth as Record<string, unknown>);
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
 * Resolve auth config — copies fields without transformation.
 * Env var names are stored as-is (resolved at connect time, not parse time).
 */
function resolveAuthConfig(raw: Record<string, unknown>): MCPAuthConfig {
  const method = raw.method as string;

  switch (method) {
    case "oauth":
      return {
        method: "oauth",
        flow: raw.flow as "browser" | "device-code",
        clientId: (raw.clientId as string).trim(),
        ...(raw.tenantId ? { tenantId: (raw.tenantId as string).trim() } : {}),
        ...(raw.scopes ? { scopes: raw.scopes as string[] } : {}),
        ...(raw.redirectUri
          ? { redirectUri: (raw.redirectUri as string).trim() }
          : {}),
      };

    case "workload-identity":
      return { method: "workload-identity" };

    case "client-credentials":
      return {
        method: "client-credentials",
        clientId: (raw.clientId as string).trim(),
        tenantId: (raw.tenantId as string).trim(),
        clientSecretEnv: (raw.clientSecretEnv as string).trim(),
        ...(raw.scopes ? { scopes: raw.scopes as string[] } : {}),
      };

    default:
      // Validation already rejects invalid methods, but satisfy TS
      throw new Error(`Unknown auth method: ${method}`);
  }
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
 * Any execution-affecting config change invalidates the approval.
 *
 * For stdio: includes name, command, args, tool filtering, env key names.
 * For HTTP: includes name, url, auth method + clientId, tool filtering.
 */
export function computeMCPConfigHash(
  name: string,
  config: MCPServerConfig,
): string {
  const hash = createHash("sha256").update(name, "utf8");

  if (isMCPHttpConfig(config)) {
    hash.update("http", "utf8");
    hash.update(config.url, "utf8");
    if (config.auth) {
      hash.update(config.auth.method, "utf8");
      if ("clientId" in config.auth) {
        hash.update(config.auth.clientId, "utf8");
      }
    }
  } else {
    hash.update("stdio", "utf8");
    hash.update(config.command, "utf8");
    hash.update(JSON.stringify(config.args ?? []), "utf8");
    // Hash env key names (not values — secrets stay out of the hash)
    hash.update(JSON.stringify(Object.keys(config.env ?? {}).sort()), "utf8");
  }

  hash.update(JSON.stringify(config.allowTools ?? []), "utf8");
  hash.update(JSON.stringify(config.denyTools ?? []), "utf8");

  return hash.digest("hex");
}
