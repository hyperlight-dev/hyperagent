#!/usr/bin/env tsx
// ── Configure HyperAgent for Microsoft 365 / Agent 365 MCP servers ───
//
// Cross-platform replacement for the bash recipe. Reads the catalog at
// scripts/m365-mcp-servers.json and writes one entry per selected
// service into ~/.hyperagent/config.json (via the shared mcp-add-http
// writer logic).
//
// Usage:
//   tsx scripts/m365-setup.ts [services] [clientId] [tenantId] [scopeOverride]
//
//   services         "all" (default) or comma-separated alias list
//   clientId         Override Entra app client id (else read from state)
//   tenantId         Override Entra tenant id (else read from state)
//   scopeOverride    Force a single scope for every server (testing)
//
// State file at ~/.hyperagent/m365.json supplies clientId/tenantId/
// callbackPort when not overridden.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_CALLBACK_PORT = 8080;
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const ALIAS_PREFIX = "work-iq-";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = join(scriptDir, "m365-mcp-servers.json");

// ── Types ────────────────────────────────────────────────────────────

interface CatalogServer {
  id?: string;
  url: string;
  scope: string;
  audience?: string;
  publisher?: string;
}

interface Catalog {
  servers: Record<string, CatalogServer>;
  resourceId?: string;
}

interface SavedState {
  clientId?: string;
  tenantId?: string;
  callbackPort?: number;
  appName?: string;
}

interface OAuthAuth {
  method: "oauth";
  clientId: string;
  callbackPort: number;
  scopes: string[];
  tenantId?: string;
}

interface HttpServerEntry {
  type: "http";
  url: string;
  auth?: OAuthAuth;
}

interface HyperAgentConfig {
  mcpServers?: Record<string, HttpServerEntry>;
  [key: string]: unknown;
}

// ── Helpers ──────────────────────────────────────────────────────────

function fail(msg: string): never {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (err) {
    fail(`Failed to read ${path}: ${(err as Error).message}`);
  }
}

function writeServerEntry(
  configFile: string,
  name: string,
  url: string,
  clientId: string,
  tenantId: string,
  scope: string,
  callbackPort: number,
): void {
  if (!NAME_PATTERN.test(name)) {
    fail(`Invalid alias '${name}' — must match ${NAME_PATTERN}`);
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    fail(`Invalid URL for ${name}: ${url}`);
  }
  const isLocal =
    parsedUrl.hostname === "localhost" || parsedUrl.hostname === "127.0.0.1";
  if (parsedUrl.protocol !== "https:" && !isLocal) {
    fail(`URL must be https:// (or localhost): ${url}`);
  }

  mkdirSync(dirname(configFile), { recursive: true });
  const cfg: HyperAgentConfig = existsSync(configFile)
    ? (JSON.parse(readFileSync(configFile, "utf8")) as HyperAgentConfig)
    : {};
  cfg.mcpServers = cfg.mcpServers ?? {};

  cfg.mcpServers[name] = {
    type: "http",
    url,
    auth: {
      method: "oauth",
      clientId,
      callbackPort,
      scopes: [scope],
      ...(tenantId ? { tenantId } : {}),
    },
  };

  writeFileSync(configFile, JSON.stringify(cfg, null, 2) + "\n");
  console.log(`✅ Wrote mcpServers.${name} → ${url} (oauth)`);
}

// ── Main ─────────────────────────────────────────────────────────────

function main(): void {
  const [
    servicesArg = "all",
    clientIdArg = "",
    tenantIdArg = "",
    scopeOverride = "",
  ] = process.argv.slice(2);

  const stateFile = join(homedir(), ".hyperagent", "m365.json");
  const configFile = join(homedir(), ".hyperagent", "config.json");

  const catalog = readJson<Catalog>(CATALOG_PATH);
  if (!catalog) fail(`Catalog missing: ${CATALOG_PATH}`);
  const known = Object.keys(catalog.servers);
  const raw = (servicesArg || "all").trim().toLowerCase();
  const selected =
    raw === "" || raw === "all"
      ? known
      : raw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
  const unknown = selected.filter((s) => !known.includes(s));
  if (unknown.length > 0) {
    console.error(`❌ Unknown service(s): ${unknown.join(", ")}`);
    console.error(`   Known: ${known.join(", ")}, all`);
    process.exit(1);
  }

  // Resolve client/tenant/callbackPort from args ⊕ state file.
  let clientId = clientIdArg;
  let tenantId = tenantIdArg;
  let callbackPort = DEFAULT_CALLBACK_PORT;

  if (!clientId || !tenantId) {
    const state = readJson<SavedState>(stateFile);
    if (!state) {
      console.error("❌ No saved app state and no clientId/tenantId provided.");
      console.error("   Run:  just mcp-m365-create-app");
      console.error(
        "   Or:   just mcp-setup-m365 <services> <clientId> <tenantId>",
      );
      process.exit(1);
    }
    clientId = clientId || state.clientId || "";
    tenantId = tenantId || state.tenantId || "";
    callbackPort = state.callbackPort || DEFAULT_CALLBACK_PORT;
    console.log(`▸ Using saved app from ${stateFile}`);
  }

  if (!clientId || !tenantId) {
    fail("clientId/tenantId required (state file missing them)");
  }

  console.log(`▸ clientId:     ${clientId}`);
  console.log(`▸ tenantId:     ${tenantId}`);
  console.log(`▸ callbackPort: ${callbackPort}`);
  console.log(`▸ services:     ${servicesArg}`);
  if (scopeOverride) {
    console.log(`▸ scope (override): ${scopeOverride}`);
  }
  console.log("");

  let count = 0;
  for (const s of selected) {
    const srv = catalog.servers[s];
    const scope = scopeOverride || srv.scope;
    if (!srv.url || !scope) {
      fail(`Catalog entry for ${s} missing url or scope`);
    }
    writeServerEntry(
      configFile,
      ALIAS_PREFIX + s,
      srv.url,
      clientId,
      tenantId,
      scope,
      callbackPort,
    );
    count += 1;
  }

  console.log("");
  console.log(`✅ Configured ${count} M365 MCP server(s)`);
  console.log("");
  console.log("   Next:");
  console.log("     just start");
  console.log("     /plugin enable mcp");
  console.log("     /mcp enable work-iq-<service>");
  console.log("");
  console.log("   First enable opens a browser for Microsoft sign-in.");
  console.log("   Tokens cached in ~/.hyperagent/mcp-tokens/");
}

main();
