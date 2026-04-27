#!/usr/bin/env tsx
// ── Configure HyperAgent for Microsoft 365 / Agent 365 MCP servers ───
//
// Cross-platform replacement for the bash recipe. Reads the catalog at
// scripts/m365-mcp-servers.json and writes one entry per selected
// service into ~/.hyperagent/config.json (via the shared mcp-add-http
// writer logic).
//
// Usage:
//   tsx scripts/m365-setup.ts [services] [clientId] [tenantId] [scopeOverride] <flow>
//
//   services         "all" (default), comma-separated alias list, or
//                    "list" to print the catalog and exit.
//   clientId         Override Entra app client id (else read from state)
//   tenantId         Override Entra tenant id (else read from state)
//   scopeOverride    Force a single scope for every server (testing)
//   flow             REQUIRED. "browser" or "device-code".
//                    No default — every config must explicitly choose.
//
// State file at ~/.hyperagent/m365.json supplies clientId/tenantId
// when not overridden.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
  appName?: string;
}

interface OAuthAuth {
  method: "oauth";
  flow: "browser" | "device-code";
  clientId: string;
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

// ── Approval store ───────────────────────────────────────────────────

const APPROVAL_FILE = join(homedir(), ".hyperagent", "approved-mcp.json");

interface ApprovalRecord {
  configHash: string;
  approvedAt: string;
  approvedTools: string[];
  auditWarnings: string[];
}

/**
 * Compute the same config hash that `src/agent/mcp/config.ts` uses.
 * Must stay in sync with `computeMCPConfigHash()` — if the hash
 * algorithm changes there, it must change here too.
 */
function computeConfigHash(
  name: string,
  url: string,
  clientId: string,
): string {
  return createHash("sha256")
    .update(name, "utf8")
    .update("http", "utf8")
    .update(url, "utf8")
    .update("oauth", "utf8") // auth method
    .update(clientId, "utf8")
    .update("[]", "utf8") // allowTools
    .update("[]", "utf8") // denyTools
    .digest("hex");
}

/**
 * Pre-approve all configured servers so the LLM can connect them
 * without prompting the user. Approval is keyed on config hash —
 * if the config changes, re-approval is required.
 */
function preApproveServers(
  servers: Array<{ name: string; url: string; clientId: string }>,
): void {
  let store: Record<string, ApprovalRecord> = {};
  try {
    if (existsSync(APPROVAL_FILE)) {
      store = JSON.parse(
        readFileSync(APPROVAL_FILE, "utf8"),
      ) as Record<string, ApprovalRecord>;
    }
  } catch {
    store = {};
  }

  for (const srv of servers) {
    store[srv.name] = {
      configHash: computeConfigHash(srv.name, srv.url, srv.clientId),
      approvedAt: new Date().toISOString(),
      approvedTools: [], // Tools not known until connect — empty is fine
      auditWarnings: [],
    };
  }

  mkdirSync(dirname(APPROVAL_FILE), { recursive: true, mode: 0o700 });
  writeFileSync(APPROVAL_FILE, JSON.stringify(store, null, 2), {
    mode: 0o600,
  });
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

/**
 * Rewrite a discovery URL (`/agents/servers/<name>`) into the
 * tenant-scoped form the Agent 365 gateway actually serves
 * (`/agents/tenants/<tid>/servers/<name>`).
 *
 * If the URL already contains `/agents/tenants/...` it's left alone
 * (the catalog could legitimately store tenant-already-baked URLs in
 * the future).
 */
function injectTenantIntoUrl(url: string, tenantId: string): string {
  if (!tenantId) {
    fail("tenantId is required to build M365 MCP server URLs");
  }
  if (url.includes("/agents/tenants/")) return url;
  const marker = "/agents/servers/";
  const idx = url.indexOf(marker);
  if (idx === -1) {
    fail(
      `Catalog URL does not contain '${marker}' — cannot inject tenant: ${url}`,
    );
  }
  return (
    url.slice(0, idx) +
    "/agents/tenants/" +
    tenantId +
    "/servers/" +
    url.slice(idx + marker.length)
  );
}

function writeServerEntry(
  configFile: string,
  name: string,
  url: string,
  clientId: string,
  tenantId: string,
  scope: string,
  flow: "browser" | "device-code",
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
      flow,
      clientId,
      scopes: [scope],
      ...(tenantId ? { tenantId } : {}),
    },
  };

  writeFileSync(configFile, JSON.stringify(cfg, null, 2) + "\n");
  console.log(`✅ Wrote mcpServers.${name} → ${url} (oauth/${flow})`);
}

// ── Main ─────────────────────────────────────────────────────────────

function main(): void {
  const [
    servicesArg = "all",
    clientIdArg = "",
    tenantIdArg = "",
    scopeOverride = "",
    flowArg = "",
  ] = process.argv.slice(2);

  const stateFile = join(homedir(), ".hyperagent", "m365.json");
  const configFile = join(homedir(), ".hyperagent", "config.json");

  const catalog = readJson<Catalog>(CATALOG_PATH);
  if (!catalog) fail(`Catalog missing: ${CATALOG_PATH}`);
  const known = Object.keys(catalog.servers);
  const raw = (servicesArg || "all").trim().toLowerCase();

  // `list` / `--list` / `ls`: print catalog and exit (no config writes).
  // Runs BEFORE flow validation so users can discover the catalog
  // without having to pick a flow first.
  if (raw === "list" || raw === "--list" || raw === "ls") {
    console.log("Available M365 / Agent 365 MCP servers:\n");
    const sorted = [...known].sort();
    const aliasWidth = Math.max(...sorted.map((a) => a.length));
    for (const alias of sorted) {
      const srv = catalog.servers[alias];
      console.log(`  ${alias.padEnd(aliasWidth)}  ${srv.scope}`);
    }
    console.log("");
    console.log("Usage (FLOW is required — browser or device-code):");
    console.log('  just mcp-setup-m365 all "" "" "" browser');
    console.log('  just mcp-setup-m365 "mail,planner" "" "" "" device-code');
    console.log("  just mcp-setup-m365 list                          # this listing");
    return;
  }

  // `flow` is mandatory for any path that writes config. Comes last
  // positionally so earlier optional args can be left blank —
  // `just mcp-setup-m365 ... "" "" "" device-code`.
  if (flowArg !== "browser" && flowArg !== "device-code") {
    fail(
      `flow is required and must be "browser" or "device-code" (got: "${flowArg}")`,
    );
  }
  const flow = flowArg as "browser" | "device-code";

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

  // Resolve client/tenant from args ⊕ state file.
  let clientId = clientIdArg;
  let tenantId = tenantIdArg;

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
    console.log(`▸ Using saved app from ${stateFile}`);
  }

  if (!clientId || !tenantId) {
    fail("clientId/tenantId required (state file missing them)");
  }

  console.log(`▸ clientId:     ${clientId}`);
  console.log(`▸ tenantId:     ${tenantId}`);
  console.log(`▸ services:     ${servicesArg}`);
  console.log(`▸ flow:         ${flow}`);
  if (scopeOverride) {
    console.log(`▸ scope (override): ${scopeOverride}`);
  }
  console.log("");

  // The Agent 365 resource app id. Per-server scopes (e.g.
  // McpServers.MailTools.All) are not fully qualified — MSAL doesn't
  // know which resource they belong to and falls back to Graph, which
  // breaks with FOCI apps like the VS Code client. Using
  // {resourceId}/.default requests all pre-consented scopes for the
  // Agent 365 resource in one shot, matching what a365cli does.
  const defaultScope = catalog.resourceId
    ? `${catalog.resourceId}/.default`
    : undefined;

  let count = 0;
  const configured: Array<{ name: string; url: string; clientId: string }> = [];
  for (const s of selected) {
    const srv = catalog.servers[s];
    const scope = scopeOverride || defaultScope || srv.scope;
    if (!srv.url || !scope) {
      fail(`Catalog entry for ${s} missing url or scope`);
    }
    // The discovery endpoint returns URLs of the form
    //   https://<host>/agents/servers/<name>
    // but the Agent 365 gateway requires the caller's tenantId in the
    // path, otherwise it responds with EndpointInvalid / TenantIdInvalid:
    //   https://<host>/agents/tenants/<tenantId>/servers/<name>
    // Inject the tenantId here at config-write time. We don't store the
    // already-tenanted URL in the catalog because the catalog is shared
    // across tenants.
    const tenantedUrl = injectTenantIntoUrl(srv.url, tenantId);
    writeServerEntry(
      configFile,
      ALIAS_PREFIX + s,
      tenantedUrl,
      clientId,
      tenantId,
      scope,
      flow,
    );
    configured.push({
      name: ALIAS_PREFIX + s,
      url: tenantedUrl,
      clientId,
    });
    count += 1;
  }

  // Pre-approve all configured servers so the LLM can connect them
  // without interactive approval prompts.
  preApproveServers(configured);

  console.log("");
  console.log(`✅ Configured ${count} M365 MCP server(s) (pre-approved)`);
  console.log("");
  console.log("   Next:");
  console.log("     just start");
  console.log('     Ask: "What\'s happening in Teams?"');
  console.log("");
  console.log(
    flow === "device-code"
      ? "   First connect shows a device code + URL to enter on any browser."
      : "   First connect opens a browser for Microsoft sign-in.",
  );
  console.log("   Tokens cached in ~/.hyperagent/mcp-tokens/");
}

main();
