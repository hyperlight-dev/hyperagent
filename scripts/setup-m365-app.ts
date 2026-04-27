#!/usr/bin/env tsx
// ── Set up Entra ID app registration for Microsoft 365 MCP servers ──
//
// Cross-platform replacement for setup-m365-app.sh. Calls the Azure
// CLI (`az`) via execFileSync so it works on Linux, macOS, WSL, native
// Windows (PowerShell or Git Bash). The user must have `az` installed
// and `az login`'d before running this.
//
// What it does:
//   1. Creates / reuses / adopts (--client-id) a single-tenant
//      public-client app registration in Entra ID.
//   2. Verifies the Agent 365 service principal exists in the tenant.
//   3. Reads scripts/m365-mcp-servers.json and declares every catalogued
//      delegated scope on the app reg (required because we request
//      narrow per-server scopes at runtime, not `.default`).
//   4. Attempts admin consent. Non-admins get a URL to share.
//   5. Persists clientId/tenantId/etc. to ~/.hyperagent/m365.json.
//
// Usage:
//   tsx scripts/setup-m365-app.ts [options]
//
// Options:
//   --app-name NAME       Display name (default: "HyperAgent M365")
//   --callback-port PORT  OAuth callback port (default: 8080)
//   --service-ref GUID    Service Tree GUID (some corporate tenants)
//   --client-id ID        Adopt an existing Entra app by client id

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Constants ────────────────────────────────────────────────────────

/** Agent 365 resource app id — gates every Work IQ MCP server. */
const AGENT365_RESOURCE_ID = "ea9ffc3e-8a23-4a7d-836d-234d7c7565c1";

const DEFAULT_APP_NAME = "HyperAgent M365";
const DEFAULT_CALLBACK_PORT = 8080;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = join(scriptDir, "m365-mcp-servers.json");

// On Windows az is `az.cmd` — spawn-without-shell needs the full name.
// execFileSync handles this when shell:true, but we avoid shell:true to
// dodge quoting issues, so resolve the binary name explicitly.
const AZ_BIN = platform() === "win32" ? "az.cmd" : "az";

// ── Colour log helpers (TTY only) ────────────────────────────────────

const supportsColour = process.stdout.isTTY === true;
const C = supportsColour
  ? {
      red: "\u001b[0;31m",
      green: "\u001b[0;32m",
      yellow: "\u001b[0;33m",
      cyan: "\u001b[0;36m",
      reset: "\u001b[0m",
    }
  : { red: "", green: "", yellow: "", cyan: "", reset: "" };

const logStep = (msg: string): void =>
  console.log(`${C.cyan}▸${C.reset} ${msg}`);
const logSuccess = (msg: string): void =>
  console.log(`${C.green}✅${C.reset} ${msg}`);
const logWarning = (msg: string): void =>
  console.log(`${C.yellow}⚠️${C.reset}  ${msg}`);
const logError = (msg: string): void =>
  console.error(`${C.red}❌${C.reset} ${msg}`);

// ── Argument parsing ─────────────────────────────────────────────────

interface CliArgs {
  appName: string;
  callbackPort: number;
  serviceRef: string;
  clientId: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    appName: DEFAULT_APP_NAME,
    callbackPort: DEFAULT_CALLBACK_PORT,
    serviceRef: "",
    clientId: "",
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    switch (arg) {
      case "--app-name":
        args.appName = argv[++i] ?? args.appName;
        break;
      case "--callback-port":
        args.callbackPort =
          Number.parseInt(argv[++i] ?? "", 10) || DEFAULT_CALLBACK_PORT;
        break;
      case "--service-ref":
        args.serviceRef = argv[++i] ?? "";
        break;
      case "--client-id":
        args.clientId = argv[++i] ?? "";
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        logError(`Unknown option: ${arg} (run with --help)`);
        process.exit(1);
    }
    i += 1;
  }
  return args;
}

function printHelp(): void {
  console.log(
    "Usage: tsx scripts/setup-m365-app.ts " +
      "[--app-name NAME] [--callback-port PORT] " +
      "[--service-ref GUID] [--client-id ID]",
  );
  console.log("");
  console.log(
    "Creates a single-tenant public-client Entra ID app registration",
  );
  console.log("for the Microsoft 365 / Agent 365 HTTP MCP servers.");
  console.log("");
  console.log("Prerequisites:");
  console.log("  • Microsoft 365 Copilot licence");
  console.log("  • Frontier preview enrolment:");
  console.log("    https://adoption.microsoft.com/copilot/frontier-program/");
  console.log("");
  console.log("Options:");
  console.log(
    "  --app-name NAME       Display name (default: HyperAgent M365)",
  );
  console.log("  --callback-port PORT  OAuth callback port (default: 8080)");
  console.log("  --service-ref GUID    Service Tree GUID (corporate tenants)");
  console.log("  --client-id ID        Adopt an existing app by client id");
}

// ── az CLI wrapper ───────────────────────────────────────────────────

interface AzResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
}

/**
 * Run `az` with the given args. Never throws — returns a result object.
 * Captures stdout/stderr so callers can inspect failures.
 */
function az(args: string[]): AzResult {
  const result = spawnSync(AZ_BIN, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) {
    return {
      ok: false,
      stdout: "",
      stderr: result.error.message,
      status: null,
    };
  }
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
  };
}

/** Run `az` and exit with a friendly error if it fails. */
function azOrFail(args: string[], failMsg: string): string {
  const r = az(args);
  if (!r.ok) {
    logError(failMsg);
    if (r.stderr.trim()) console.error(`  ${r.stderr.trim()}`);
    process.exit(1);
  }
  return r.stdout.trim();
}

// ── Prerequisites ────────────────────────────────────────────────────

function checkPrerequisites(): void {
  // `az --version` returns 0 if installed.
  if (!az(["--version"]).ok) {
    logError("Azure CLI (az) not found.");
    console.error(
      "  Install: https://docs.microsoft.com/en-us/cli/azure/install-azure-cli",
    );
    process.exit(1);
  }

  if (!az(["account", "show"]).ok) {
    logError("Not logged in to Azure CLI.");
    console.error("  Run: az login");
    console.error("  From WSL: az login --use-device-code");
    process.exit(1);
  }

  if (!az(["ad", "signed-in-user", "show"]).ok) {
    logError("Azure CLI session lacks Microsoft Graph permissions.");
    console.error(
      "  Run: az login --scope https://graph.microsoft.com//.default",
    );
    process.exit(1);
  }
}

// ── Tenant + resource verification ───────────────────────────────────

interface TenantInfo {
  tenantId: string;
  tenantDomain: string;
}

function resolveTenant(): TenantInfo {
  logStep("Resolving tenant...");
  const tenantId = azOrFail(
    ["account", "show", "--query", "tenantId", "-o", "tsv"],
    "Failed to read tenantId from az account show",
  );
  const userPrincipal = azOrFail(
    ["account", "show", "--query", "user.name", "-o", "tsv"],
    "Failed to read signed-in user from az account show",
  );
  const tenantDomain = userPrincipal.includes("@")
    ? userPrincipal.split("@")[1]
    : "(unknown)";
  logSuccess(`Tenant: ${tenantId} (${tenantDomain})`);
  return { tenantId, tenantDomain };
}

function verifyAgent365Resource(): void {
  logStep("Verifying Agent 365 resource is available...");
  if (!az(["ad", "sp", "show", "--id", AGENT365_RESOURCE_ID]).ok) {
    logError(
      `Agent 365 service principal (${AGENT365_RESOURCE_ID}) not found in your tenant.`,
    );
    console.error("  This usually means one of:");
    console.error("    1. No Microsoft 365 Copilot licence on this tenant.");
    console.error("    2. Not enrolled in the Frontier preview programme:");
    console.error(
      "       https://adoption.microsoft.com/copilot/frontier-program/",
    );
    console.error("");
    console.error("  Re-run this script once Agent 365 is provisioned.");
    process.exit(1);
  }
  logSuccess("Agent 365 resource present");
}

// ── App registration: create / reuse / adopt ─────────────────────────

interface SavedState {
  clientId?: string;
  tenantId?: string;
  appName?: string;
  callbackPort?: number;
}

function readSavedClientId(stateFile: string): string {
  if (!existsSync(stateFile)) return "";
  try {
    const state = JSON.parse(readFileSync(stateFile, "utf8")) as SavedState;
    return state.clientId ?? "";
  } catch {
    return "";
  }
}

function appExists(appId: string): boolean {
  return az(["ad", "app", "show", "--id", appId]).ok;
}

function updateAppPublicClient(appId: string, redirectUri: string): void {
  azOrFail(
    [
      "ad",
      "app",
      "update",
      "--id",
      appId,
      "--public-client-redirect-uris",
      redirectUri,
      "--is-fallback-public-client",
      "true",
      "-o",
      "none",
    ],
    `Failed to update app ${appId}`,
  );
  logSuccess("Updated redirect URI + public-client flag");
}

function resolveAppId(
  args: CliArgs,
  redirectUri: string,
  stateFile: string,
): string {
  const savedClientId = readSavedClientId(stateFile);

  // Path 1: explicit --client-id (adopt)
  if (args.clientId) {
    if (!appExists(args.clientId)) {
      logError(`App not found in this tenant: ${args.clientId}`);
      console.error(
        "  Check that you're logged into the right tenant (az account show)",
      );
      console.error("  and that the app id is correct.");
      process.exit(1);
    }
    logWarning(`Adopting existing app via --client-id: ${args.clientId}`);
    updateAppPublicClient(args.clientId, redirectUri);
    return args.clientId;
  }

  // Path 2: saved client id from previous run
  if (savedClientId && appExists(savedClientId)) {
    logWarning(`Reusing saved app from ${stateFile}: ${savedClientId}`);
    updateAppPublicClient(savedClientId, redirectUri);
    return savedClientId;
  }

  // Path 3: lookup by display name
  logStep(`Checking for existing app: ${args.appName}`);
  const lookup = az([
    "ad",
    "app",
    "list",
    "--display-name",
    args.appName,
    "--query",
    "[0].appId",
    "-o",
    "tsv",
  ]);
  const existing = lookup.ok ? lookup.stdout.trim() : "";
  if (existing && existing !== "None") {
    logWarning(`App already exists (${existing}) — updating redirect URI`);
    updateAppPublicClient(existing, redirectUri);
    return existing;
  }

  // Path 4: create
  logStep("Creating app registration...");
  if (args.serviceRef) {
    return createAppViaGraph(args.appName, redirectUri, args.serviceRef);
  }
  return createAppViaCli(args.appName, redirectUri);
}

function createAppViaCli(appName: string, redirectUri: string): string {
  const r = az([
    "ad",
    "app",
    "create",
    "--display-name",
    appName,
    "--sign-in-audience",
    "AzureADMyOrg",
    "--public-client-redirect-uris",
    redirectUri,
    "--is-fallback-public-client",
    "true",
    "--query",
    "appId",
    "-o",
    "tsv",
  ]);

  if (!r.ok) {
    const combined = `${r.stdout}\n${r.stderr}`.toLowerCase();
    if (combined.includes("servicemanagementreference")) {
      logError("Your tenant requires a Service Tree GUID.");
      console.error(
        "  Find one: az ad app list --all --query '[0].serviceManagementReference' -o tsv",
      );
      console.error(
        '  Re-run:   tsx scripts/setup-m365-app.ts --service-ref "<GUID>"',
      );
      process.exit(1);
    }
    logError(`Failed to create app: ${(r.stderr || r.stdout).trim()}`);
    process.exit(1);
  }

  const appId = r.stdout.trim();
  logSuccess(`App created: ${appId}`);
  return appId;
}

function createAppViaGraph(
  appName: string,
  redirectUri: string,
  serviceRef: string,
): string {
  const body = JSON.stringify({
    displayName: appName,
    signInAudience: "AzureADMyOrg",
    isFallbackPublicClient: true,
    publicClient: { redirectUris: [redirectUri] },
    serviceManagementReference: serviceRef,
  });

  const appId = azOrFail(
    [
      "rest",
      "--method",
      "POST",
      "--url",
      "https://graph.microsoft.com/v1.0/applications",
      "--headers",
      "Content-Type=application/json",
      "--body",
      body,
      "--query",
      "appId",
      "-o",
      "tsv",
    ],
    "Failed to create app via Graph API",
  );

  logSuccess(`App created: ${appId}`);
  return appId;
}

// ── Scope declaration ────────────────────────────────────────────────

interface CatalogServer {
  scope?: string;
}

interface Catalog {
  servers: Record<string, CatalogServer>;
}

interface SpScope {
  value: string;
  id: string;
}

function declareCatalogScopes(appId: string): void {
  if (!existsSync(CATALOG_PATH)) {
    logWarning(`Catalog missing: ${CATALOG_PATH} — skipping scope declaration`);
    return;
  }
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8")) as Catalog;
  const scopeValues = [
    ...new Set(
      Object.values(catalog.servers)
        .map((s) => s.scope)
        .filter((v): v is string => Boolean(v)),
    ),
  ];

  if (scopeValues.length === 0) {
    logWarning("Catalog has no scopes to declare — skipping");
    return;
  }

  logStep("Discovering Agent 365 published scopes...");
  const r = az([
    "ad",
    "sp",
    "show",
    "--id",
    AGENT365_RESOURCE_ID,
    "--query",
    "oauth2PermissionScopes[].{value:value,id:id}",
    "-o",
    "json",
  ]);
  if (!r.ok || !r.stdout.trim() || r.stdout.trim() === "null") {
    logWarning(
      "Could not enumerate Agent 365 scopes — skipping scope declaration",
    );
    logWarning(
      "Users will need to consent each scope individually on first sign-in",
    );
    return;
  }

  let spScopes: SpScope[];
  try {
    spScopes = JSON.parse(r.stdout) as SpScope[];
  } catch {
    logWarning("Agent 365 scope list returned invalid JSON — skipping");
    return;
  }

  logStep("Declaring catalog scopes on the app registration...");
  const valueToId = new Map(spScopes.map((s) => [s.value, s.id]));

  let added = 0;
  let missing = 0;
  for (const scopeValue of scopeValues) {
    const scopeId = valueToId.get(scopeValue);
    if (!scopeId) {
      console.log(
        `    ⚠️  ${scopeValue} (not published by Agent 365 in this tenant)`,
      );
      missing += 1;
      continue;
    }
    const addRes = az([
      "ad",
      "app",
      "permission",
      "add",
      "--id",
      appId,
      "--api",
      AGENT365_RESOURCE_ID,
      "--api-permissions",
      `${scopeId}=Scope`,
      "-o",
      "none",
    ]);
    if (addRes.ok) {
      console.log(`    ✅ ${scopeValue}`);
      added += 1;
    } else {
      console.log(`    ➖ ${scopeValue} (already declared)`);
    }
  }

  logSuccess(`Declared scopes (${added} new, ${missing} missing in tenant)`);
  if (missing > 0) {
    console.log(
      "  Missing scopes are normal in tenants without all Agent 365 features.",
    );
    console.log("  Refresh the catalog from a tenant that has them:");
    console.log("    just mcp-m365-refresh-servers");
  }
}

// ── Admin consent ────────────────────────────────────────────────────

function requestAdminConsent(appId: string, tenantId: string): void {
  logStep("Requesting admin consent for the app...");
  const r = az(["ad", "app", "permission", "admin-consent", "--id", appId]);
  if (r.ok) {
    logSuccess("Admin consent granted");
    return;
  }
  logWarning("Admin consent not granted (you are probably not a tenant admin)");
  console.log("  Ask a tenant admin to open this URL once:");
  console.log(
    `    https://login.microsoftonline.com/${tenantId}/adminconsent?client_id=${appId}`,
  );
  console.log("");
  console.log(
    "  Until then, end users will see 'Need admin approval' on first sign-in",
  );
  console.log("  for any scopes that are not user-consentable in this tenant.");
}

// ── Persist state ────────────────────────────────────────────────────

function saveState(stateFile: string, next: SavedState): void {
  mkdirSync(dirname(stateFile), { recursive: true });
  let cur: SavedState = {};
  if (existsSync(stateFile)) {
    try {
      cur = JSON.parse(readFileSync(stateFile, "utf8")) as SavedState;
    } catch {
      // ignore — we'll overwrite
    }
  }
  writeFileSync(stateFile, JSON.stringify({ ...cur, ...next }, null, 2) + "\n");
  logSuccess(`Saved app details to ${stateFile}`);
}

// ── Final summary ────────────────────────────────────────────────────

function printSummary(
  appName: string,
  appId: string,
  tenantId: string,
  redirectUri: string,
): void {
  console.log("");
  console.log(
    "════════════════════════════════════════════════════════════════",
  );
  logSuccess("App registration complete!");
  console.log("");
  console.log(`  App Name:    ${appName}`);
  console.log(`  Client ID:   ${appId}`);
  console.log(`  Tenant ID:   ${tenantId}`);
  console.log(`  Redirect:    ${redirectUri}`);
  console.log("");
  console.log("  Next steps:");
  console.log("");
  console.log("  1. Configure HyperAgent (writes one entry per M365 service):");
  console.log("     just mcp-setup-m365");
  console.log("");
  console.log("  2. Start HyperAgent:");
  console.log("     just start");
  console.log("");
  console.log("  3. Enable and connect:");
  console.log("     /plugin enable mcp");
  console.log("     /mcp enable work-iq-planner");
  console.log("     /mcp enable work-iq-mail        # may need admin consent");
  console.log("");
  console.log("  Browser opens for Microsoft sign-in on first use.");
  console.log("  Tokens cached in ~/.hyperagent/mcp-tokens/");
  console.log(
    "════════════════════════════════════════════════════════════════",
  );
}

// ── Main ─────────────────────────────────────────────────────────────

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const redirectUri = `http://localhost:${args.callbackPort}/callback`;
  const stateFile = join(homedir(), ".hyperagent", "m365.json");

  checkPrerequisites();
  const { tenantId } = resolveTenant();
  verifyAgent365Resource();

  const appId = resolveAppId(args, redirectUri, stateFile);
  declareCatalogScopes(appId);
  requestAdminConsent(appId, tenantId);

  saveState(stateFile, {
    clientId: appId,
    tenantId,
    appName: args.appName,
    callbackPort: args.callbackPort,
  });

  printSummary(args.appName, appId, tenantId, redirectUri);
}

main();
