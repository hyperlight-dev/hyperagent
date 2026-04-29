// ── MCP setup CLI commands ───────────────────────────────────────────
//
// Standalone command-line helpers for configuring MCP servers without
// requiring users to download the repository Justfile or helper scripts.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

export type MCPSetupCommand =
  | { kind: "setup-everything" }
  | { kind: "setup-github" }
  | { kind: "setup-filesystem"; dir: string }
  | { kind: "show-config" }
  | { kind: "setup-workiq" }
  | { kind: "add-http"; args: string[] }
  | { kind: "m365-create-app"; args: string[] }
  | { kind: "m365-setup"; args: string[] }
  | { kind: "m365-refresh-servers"; args: string[] }
  | { kind: "m365-show" };

interface RunOptions {
  contentRoot: string;
}

interface OAuthAuth {
  method: "oauth";
  flow: "browser" | "device-code";
  clientId: string;
  scopes: string[];
  tenantId?: string;
}

interface StdioServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  allowTools?: string[];
  denyTools?: string[];
}

interface HttpServerEntry {
  type: "http";
  url: string;
  auth?: OAuthAuth;
}

interface HyperAgentConfig {
  mcpServers?: Record<string, StdioServerEntry | HttpServerEntry>;
  [key: string]: unknown;
}

interface SavedM365State {
  clientId?: string;
  tenantId?: string;
  appName?: string;
  callbackPort?: number;
}

interface CatalogServer {
  id?: string;
  url: string;
  scope: string;
  audience?: string;
  publisher?: string;
}

interface Catalog {
  _comment?: string;
  resourceId?: string;
  discoverEndpoint?: string;
  callbackPort?: number;
  servers: Record<string, CatalogServer>;
}

interface DiscoveredServer {
  readonly mcpServerName?: string;
  readonly id?: string;
  readonly url?: string;
  readonly scope?: string;
  readonly audience?: string;
  readonly publisher?: string;
}

interface DiscoveryPayload {
  readonly mcpServers?: readonly DiscoveredServer[];
}

interface M365AppArgs {
  appName: string;
  callbackPort: number;
  serviceRef: string;
  clientId: string;
}

interface AzResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const AGENT365_RESOURCE_ID = "ea9ffc3e-8a23-4a7d-836d-234d7c7565c1";
const DEFAULT_APP_NAME = "HyperAgent M365";
const DEFAULT_CALLBACK_PORT = 8080;
const ALIAS_PREFIX = "work-iq-";
const AZ_BIN = platform() === "win32" ? "az.cmd" : "az";

const CONFIG_DIR = join(homedir(), ".hyperagent");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const M365_STATE_FILE = join(CONFIG_DIR, "m365.json");
const M365_USER_CATALOG = join(CONFIG_DIR, "m365-mcp-servers.json");
const M365_TOKENS_DIR = join(CONFIG_DIR, "mcp-tokens");
const APPROVAL_FILE = join(CONFIG_DIR, "approved-mcp.json");

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

function logStep(msg: string): void {
  console.log(`${C.cyan}▸${C.reset} ${msg}`);
}

function logSuccess(msg: string): void {
  console.log(`${C.green}✅${C.reset} ${msg}`);
}

function logWarning(msg: string): void {
  console.log(`${C.yellow}⚠️${C.reset}  ${msg}`);
}

function logError(msg: string): void {
  console.error(`${C.red}❌${C.reset} ${msg}`);
}

function fail(msg: string): never {
  logError(msg);
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

function readConfig(): HyperAgentConfig {
  return readJson<HyperAgentConfig>(CONFIG_FILE) ?? {};
}

function writeConfig(cfg: HyperAgentConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n", {
    mode: 0o600,
  });
}

function isHttpServerEntry(
  server: StdioServerEntry | HttpServerEntry,
): server is HttpServerEntry {
  return "type" in server && server.type === "http";
}

function getBundledCatalogPath(contentRoot: string): string {
  return join(contentRoot, "scripts", "m365-mcp-servers.json");
}

function getCatalogPath(contentRoot: string): string {
  return existsSync(M365_USER_CATALOG)
    ? M365_USER_CATALOG
    : getBundledCatalogPath(contentRoot);
}

function readCatalog(contentRoot: string): Catalog {
  const catalogPath = getCatalogPath(contentRoot);
  const catalog = readJson<Catalog>(catalogPath);
  if (!catalog) fail(`M365 MCP server catalog missing: ${catalogPath}`);
  return catalog;
}

function writeUserCatalog(catalog: Catalog): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(M365_USER_CATALOG, JSON.stringify(catalog, null, 2) + "\n", {
    mode: 0o600,
  });
}

function spawnInherited(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) fail(`${command} failed: ${result.error.message}`);
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function spawnCapture(command: string, args: string[]): string | undefined {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

export function runMCPSetupCommand(
  command: MCPSetupCommand,
  options: RunOptions,
): void {
  switch (command.kind) {
    case "setup-everything":
      setupEverything();
      return;
    case "setup-github":
      setupGithub();
      return;
    case "setup-filesystem":
      setupFilesystem(command.dir);
      return;
    case "show-config":
      showConfig();
      return;
    case "setup-workiq":
      setupWorkIQ();
      return;
    case "add-http":
      addHttp(command.args);
      return;
    case "m365-create-app":
      setupM365App(command.args, options.contentRoot);
      return;
    case "m365-setup":
      setupM365(command.args, options.contentRoot);
      return;
    case "m365-refresh-servers":
      refreshM365Servers(command.args, options.contentRoot);
      return;
    case "m365-show":
      showM365();
      return;
  }
}

function setupEverything(): void {
  console.log("Configuring MCP 'everything' test server...");
  console.log(
    "Requires npm/npx. First use downloads @modelcontextprotocol/server-everything.",
  );

  const cfg = readConfig();
  cfg.mcpServers = cfg.mcpServers ?? {};
  cfg.mcpServers.everything = {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-everything"],
  };
  writeConfig(cfg);

  logSuccess(`MCP 'everything' server configured in ${CONFIG_FILE}`);
  console.log("   Start HyperAgent and ask for the everything test tools.");
}

function setupGithub(): void {
  console.log("Configuring MCP 'github' server...");
  console.log("Requires npm/npx and a GitHub token in GITHUB_TOKEN.");

  if (!process.env.GITHUB_TOKEN) {
    logWarning("GITHUB_TOKEN not set. Trying 'gh auth token'...");
    const token = spawnCapture("gh", ["auth", "token"]);
    if (token) {
      logSuccess(
        "GitHub CLI is authenticated; export GITHUB_TOKEN=$(gh auth token) before connecting.",
      );
    } else {
      logWarning("Could not get a token from gh CLI.");
      console.log("   Run: export GITHUB_TOKEN=$(gh auth token)");
    }
  }

  const cfg = readConfig();
  cfg.mcpServers = cfg.mcpServers ?? {};
  cfg.mcpServers.github = {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}" },
    allowTools: [
      "list_issues",
      "get_issue",
      "search_issues",
      "list_pull_requests",
      "get_pull_request",
      "search_repositories",
      "get_file_contents",
    ],
    denyTools: ["merge_pull_request", "delete_branch", "push_files"],
  };
  writeConfig(cfg);

  logSuccess(`MCP 'github' server configured in ${CONFIG_FILE}`);
  console.log("   Tip: export GITHUB_TOKEN=$(gh auth token)");
}

function setupFilesystem(dir: string): void {
  console.log("Configuring MCP 'filesystem' server...");
  console.log(
    "Requires npm/npx. First use downloads @modelcontextprotocol/server-filesystem.",
  );

  mkdirSync(dir, { recursive: true });
  const cfg = readConfig();
  cfg.mcpServers = cfg.mcpServers ?? {};
  cfg.mcpServers.filesystem = {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", dir],
  };
  writeConfig(cfg);

  logSuccess(`MCP 'filesystem' server configured in ${CONFIG_FILE}`);
  console.log(`   Root directory: ${dir}`);
}

function showConfig(): void {
  if (!existsSync(CONFIG_FILE)) {
    console.log(`No config file found at ${CONFIG_FILE}`);
    console.log("Run: hyperagent --mcp-setup-everything");
    return;
  }

  const cfg = readConfig();
  if (!cfg.mcpServers || Object.keys(cfg.mcpServers).length === 0) {
    console.log("No MCP servers configured.");
    return;
  }

  console.log("Configured MCP servers:");
  for (const [name, server] of Object.entries(cfg.mcpServers)) {
    if (isHttpServerEntry(server)) {
      const auth = server.auth
        ? ` [${server.auth.method}/${server.auth.flow}]`
        : "";
      console.log(`  ${name}: ${server.url}${auth}`);
    } else {
      console.log(
        `  ${name}: ${server.command ?? "?"} ${(server.args ?? []).join(" ")}`,
      );
    }
  }
}

function setupWorkIQ(): void {
  console.log("Configuring Microsoft Work IQ stdio MCP server...");
  console.log("Requires Node/npm and a Microsoft 365 Copilot licence.");
  console.log(
    "Tenant admins may need to consent to the Work IQ CLI enterprise app.",
  );
  console.log(
    "This command pre-fetches @microsoft/workiq and runs its EULA step.",
  );
  console.log("");

  logStep("Pre-fetching @microsoft/workiq (~188 MB on first run)...");
  spawnInherited("npx", ["-y", "@microsoft/workiq@latest", "version"]);

  logStep("Accepting EULA (interactive, safe to re-run)...");
  spawnInherited("npx", ["-y", "@microsoft/workiq@latest", "accept-eula"]);

  logStep("Writing MCP config entry...");
  const cfg = readConfig();
  cfg.mcpServers = cfg.mcpServers ?? {};
  for (const key of Object.keys(cfg.mcpServers)) {
    if (key.startsWith("work-iq-")) delete cfg.mcpServers[key];
  }
  cfg.mcpServers.workiq = {
    command: "npx",
    args: ["-y", "@microsoft/workiq@latest", "mcp"],
  };
  writeConfig(cfg);

  logSuccess(`Work IQ stdio MCP server ready in ${CONFIG_FILE}`);
  console.log("   First tool call opens a browser for Microsoft sign-in.");
}

function addHttp(args: string[]): void {
  const [name, url, clientId, tenantId, scopes, flowArg] = args;
  if (!name || !url) {
    fail(
      "Usage: hyperagent --mcp-add-http <name> <url> [clientId] [tenantId] [scopes] [flow]",
    );
  }
  writeHttpServerEntry(
    name,
    url,
    clientId ?? "",
    tenantId ?? "",
    scopes ?? "",
    flowArg ?? "",
  );
}

function writeHttpServerEntry(
  name: string,
  url: string,
  clientId: string,
  tenantId: string,
  scopes: string,
  flowArg: string,
): void {
  if (!NAME_PATTERN.test(name)) {
    fail(`Invalid name '${name}' (use lowercase letters, digits, hyphens)`);
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    fail(`Invalid URL: ${url}`);
  }
  const isLocal =
    parsedUrl.hostname === "localhost" || parsedUrl.hostname === "127.0.0.1";
  if (parsedUrl.protocol !== "https:" && !isLocal) {
    fail(`URL must be https:// (or localhost for testing): ${url}`);
  }

  const entry: HttpServerEntry = { type: "http", url };
  if (clientId) {
    if (flowArg !== "browser" && flowArg !== "device-code") {
      fail(
        `flow is required when clientId is provided and must be "browser" or "device-code" (got: "${flowArg}")`,
      );
    }
    const scopeList = scopes
      ? scopes
          .split(",")
          .map((scope) => scope.trim())
          .filter(Boolean)
      : [`${parsedUrl.origin}/.default`];
    entry.auth = {
      method: "oauth",
      flow: flowArg,
      clientId,
      scopes: scopeList,
      ...(tenantId ? { tenantId } : {}),
    };
  }

  const cfg = readConfig();
  cfg.mcpServers = cfg.mcpServers ?? {};
  cfg.mcpServers[name] = entry;
  writeConfig(cfg);

  const suffix = clientId ? ` (oauth/${flowArg})` : "";
  logSuccess(`Wrote mcpServers.${name} -> ${url}${suffix}`);
}

function parseM365AppArgs(argv: string[]): M365AppArgs {
  const args: M365AppArgs = {
    appName: DEFAULT_APP_NAME,
    callbackPort: DEFAULT_CALLBACK_PORT,
    serviceRef: "",
    clientId: "",
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    switch (arg) {
      case "--app-name":
        args.appName = argv[++index] ?? args.appName;
        break;
      case "--callback-port":
        args.callbackPort =
          Number.parseInt(argv[++index] ?? "", 10) || DEFAULT_CALLBACK_PORT;
        break;
      case "--service-ref":
        args.serviceRef = argv[++index] ?? "";
        break;
      case "--client-id":
        args.clientId = argv[++index] ?? "";
        break;
      case "--help":
      case "-h":
        printM365CreateAppHelp();
        process.exit(0);
        break;
      default:
        fail(`Unknown --mcp-m365-create-app option: ${arg}`);
    }
  }
  return args;
}

function printM365CreateAppHelp(): void {
  console.log(
    "Usage: hyperagent --mcp-m365-create-app " +
      "[--app-name NAME] [--callback-port PORT] [--service-ref GUID] [--client-id ID]",
  );
  console.log("");
  console.log(
    "Creates or reuses a single-tenant public-client Entra ID app registration",
  );
  console.log("for Microsoft 365 / Agent 365 HTTP MCP servers.");
  console.log("");
  console.log("Prerequisites:");
  console.log("  - Azure CLI installed and logged in: az login");
  console.log("  - Microsoft 365 Copilot licence");
  console.log("  - Frontier preview enrolment where required");
}

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

function azOrFail(args: string[], failMsg: string): string {
  const result = az(args);
  if (!result.ok) {
    logError(failMsg);
    if (result.stderr.trim()) console.error(`  ${result.stderr.trim()}`);
    process.exit(1);
  }
  return result.stdout.trim();
}

function checkAzurePrerequisites(): void {
  if (!az(["--version"]).ok) {
    logError("Azure CLI (az) not found.");
    console.error(
      "  Install: https://learn.microsoft.com/cli/azure/install-azure-cli",
    );
    process.exit(1);
  }
  if (!az(["account", "show"]).ok) {
    logError("Not logged in to Azure CLI.");
    console.error("  Run: az login");
    console.error("  From SSH/WSL: az login --use-device-code");
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

function setupM365App(argv: string[], contentRoot: string): void {
  const args = parseM365AppArgs(argv);
  const redirectUri = `http://localhost:${args.callbackPort}/callback`;

  console.log("Setting up Microsoft 365 / Agent 365 MCP app registration...");
  console.log(
    "Requires Azure CLI, az login, Microsoft 365 Copilot licensing, and tenant consent.",
  );
  console.log("");

  checkAzurePrerequisites();
  const tenantId = resolveTenantId();
  verifyAgent365Resource();

  const appId = resolveAppId(args, redirectUri);
  declareCatalogScopes(appId, contentRoot);
  requestAdminConsent(appId, tenantId);
  saveM365State({
    clientId: appId,
    tenantId,
    appName: args.appName,
    callbackPort: args.callbackPort,
  });
  printM365AppSummary(args.appName, appId, tenantId, redirectUri);
}

function resolveTenantId(): string {
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
  return tenantId;
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
    process.exit(1);
  }
  logSuccess("Agent 365 resource present");
}

function readSavedClientId(): string {
  const state = readJson<SavedM365State>(M365_STATE_FILE);
  return state?.clientId ?? "";
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

function resolveAppId(args: M365AppArgs, redirectUri: string): string {
  const savedClientId = readSavedClientId();

  if (args.clientId) {
    if (!appExists(args.clientId)) {
      fail(`App not found in this tenant: ${args.clientId}`);
    }
    logWarning(`Adopting existing app via --client-id: ${args.clientId}`);
    updateAppPublicClient(args.clientId, redirectUri);
    return args.clientId;
  }

  if (savedClientId && appExists(savedClientId)) {
    logWarning(`Reusing saved app from ${M365_STATE_FILE}: ${savedClientId}`);
    updateAppPublicClient(savedClientId, redirectUri);
    return savedClientId;
  }

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

  logStep("Creating app registration...");
  if (args.serviceRef) {
    return createAppViaGraph(args.appName, redirectUri, args.serviceRef);
  }
  return createAppViaCli(args.appName, redirectUri);
}

function createAppViaCli(appName: string, redirectUri: string): string {
  const result = az([
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

  if (!result.ok) {
    const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
    if (combined.includes("servicemanagementreference")) {
      logError("Your tenant requires a Service Tree GUID.");
      console.error(
        "  Find one: az ad app list --all --query '[0].serviceManagementReference' -o tsv",
      );
      console.error(
        '  Re-run: hyperagent --mcp-m365-create-app --service-ref "<GUID>"',
      );
      process.exit(1);
    }
    fail(`Failed to create app: ${(result.stderr || result.stdout).trim()}`);
  }

  const appId = result.stdout.trim();
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

function declareCatalogScopes(appId: string, contentRoot: string): void {
  const catalog = readCatalog(contentRoot);
  const scopeValues = [
    ...new Set(
      Object.values(catalog.servers)
        .map((server) => server.scope)
        .filter(Boolean),
    ),
  ];

  if (scopeValues.length === 0) {
    logWarning("Catalog has no scopes to declare — skipping");
    return;
  }

  logStep("Discovering Agent 365 published scopes...");
  const result = az([
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
  if (!result.ok || !result.stdout.trim() || result.stdout.trim() === "null") {
    logWarning(
      "Could not enumerate Agent 365 scopes — skipping scope declaration",
    );
    logWarning(
      "Users will need to consent each scope individually on first sign-in",
    );
    return;
  }

  let spScopes: Array<{ value: string; id: string }>;
  try {
    spScopes = JSON.parse(result.stdout) as Array<{
      value: string;
      id: string;
    }>;
  } catch {
    logWarning("Agent 365 scope list returned invalid JSON — skipping");
    return;
  }

  logStep("Declaring catalog scopes on the app registration...");
  const valueToId = new Map(spScopes.map((scope) => [scope.value, scope.id]));
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
    const addResult = az([
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
    if (addResult.ok) {
      console.log(`    ✅ ${scopeValue}`);
      added += 1;
    } else {
      console.log(`    ➖ ${scopeValue} (already declared)`);
    }
  }

  logSuccess(`Declared scopes (${added} new, ${missing} missing in tenant)`);
}

function requestAdminConsent(appId: string, tenantId: string): void {
  logStep("Requesting admin consent for the app...");
  const result = az([
    "ad",
    "app",
    "permission",
    "admin-consent",
    "--id",
    appId,
  ]);
  if (result.ok) {
    logSuccess("Admin consent granted");
    return;
  }
  logWarning("Admin consent not granted (you are probably not a tenant admin)");
  console.log("  Ask a tenant admin to open this URL once:");
  console.log(
    `    https://login.microsoftonline.com/${tenantId}/adminconsent?client_id=${appId}`,
  );
}

function saveM365State(next: SavedM365State): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const cur = readJson<SavedM365State>(M365_STATE_FILE) ?? {};
  writeFileSync(
    M365_STATE_FILE,
    JSON.stringify({ ...cur, ...next }, null, 2) + "\n",
    {
      mode: 0o600,
    },
  );
  logSuccess(`Saved app details to ${M365_STATE_FILE}`);
}

function printM365AppSummary(
  appName: string,
  appId: string,
  tenantId: string,
  redirectUri: string,
): void {
  console.log("");
  logSuccess("App registration complete!");
  console.log(`  App Name:  ${appName}`);
  console.log(`  Client ID: ${appId}`);
  console.log(`  Tenant ID: ${tenantId}`);
  console.log(`  Redirect:  ${redirectUri}`);
  console.log("");
  console.log("Next:");
  console.log('  hyperagent --mcp-setup-m365 all "" "" "" browser');
  console.log("  hyperagent");
}

function setupM365(argv: string[], contentRoot: string): void {
  const [
    servicesArg = "all",
    clientIdArg = "",
    tenantIdArg = "",
    scopeOverride = "",
    flowArg = "",
  ] = argv;
  const catalog = readCatalog(contentRoot);
  const known = Object.keys(catalog.servers);
  const raw = (servicesArg || "all").trim().toLowerCase();

  if (raw === "list" || raw === "--list" || raw === "ls") {
    console.log("Available M365 / Agent 365 MCP servers:\n");
    const sorted = [...known].sort();
    const aliasWidth = Math.max(...sorted.map((alias) => alias.length));
    for (const alias of sorted) {
      const server = catalog.servers[alias];
      console.log(`  ${alias.padEnd(aliasWidth)}  ${server.scope}`);
    }
    console.log("");
    console.log("Usage:");
    console.log('  hyperagent --mcp-setup-m365 all "" "" "" browser');
    console.log(
      '  hyperagent --mcp-setup-m365 "mail,planner" "" "" "" device-code',
    );
    return;
  }

  if (flowArg !== "browser" && flowArg !== "device-code") {
    fail(
      `flow is required and must be "browser" or "device-code" (got: "${flowArg}")`,
    );
  }
  const flow = flowArg;

  const selected =
    raw === "" || raw === "all"
      ? known
      : raw
          .split(",")
          .map((service) => service.trim())
          .filter(Boolean);
  const unknown = selected.filter((service) => !known.includes(service));
  if (unknown.length > 0) {
    console.error(`❌ Unknown service(s): ${unknown.join(", ")}`);
    console.error(`   Known: ${known.join(", ")}, all`);
    process.exit(1);
  }

  let clientId = clientIdArg;
  let tenantId = tenantIdArg;
  if (!clientId || !tenantId) {
    const state = readJson<SavedM365State>(M365_STATE_FILE);
    if (!state) {
      console.error("❌ No saved app state and no clientId/tenantId provided.");
      console.error("   Run: hyperagent --mcp-m365-create-app");
      console.error(
        '   Or:  hyperagent --mcp-setup-m365 <services> <clientId> <tenantId> "" <flow>',
      );
      process.exit(1);
    }
    clientId = clientId || state.clientId || "";
    tenantId = tenantId || state.tenantId || "";
    logStep(`Using saved app from ${M365_STATE_FILE}`);
  }

  if (!clientId || !tenantId) fail("clientId/tenantId required");

  console.log(`▸ clientId: ${clientId}`);
  console.log(`▸ tenantId: ${tenantId}`);
  console.log(`▸ services: ${servicesArg}`);
  console.log(`▸ flow:     ${flow}`);
  if (scopeOverride) console.log(`▸ scope override: ${scopeOverride}`);
  console.log("");

  const defaultScope = catalog.resourceId
    ? `${catalog.resourceId}/.default`
    : undefined;
  let count = 0;
  const configured: Array<{
    name: string;
    url: string;
    clientId: string;
    flow: string;
    tenantId: string;
    scopes: string[];
  }> = [];

  for (const service of selected) {
    const server = catalog.servers[service];
    const scope = scopeOverride || defaultScope || server.scope;
    if (!server.url || !scope)
      fail(`Catalog entry for ${service} missing url or scope`);
    const tenantedUrl = injectTenantIntoUrl(server.url, tenantId);
    const name = ALIAS_PREFIX + service;
    writeM365ServerEntry(name, tenantedUrl, clientId, tenantId, scope, flow);
    configured.push({
      name,
      url: tenantedUrl,
      clientId,
      flow,
      tenantId,
      scopes: [scope],
    });
    count += 1;
  }

  preApproveServers(configured);
  logSuccess(`Configured ${count} M365 MCP server(s) and pre-approved them`);
  console.log(
    "   First connect opens a browser or device-code flow, depending on config.",
  );
}

function injectTenantIntoUrl(url: string, tenantId: string): string {
  if (!tenantId) fail("tenantId is required to build M365 MCP server URLs");
  if (url.includes("/agents/tenants/")) return url;
  const marker = "/agents/servers/";
  const index = url.indexOf(marker);
  if (index === -1) {
    fail(
      `Catalog URL does not contain '${marker}' — cannot inject tenant: ${url}`,
    );
  }
  return `${url.slice(0, index)}/agents/tenants/${tenantId}/servers/${url.slice(index + marker.length)}`;
}

function writeM365ServerEntry(
  name: string,
  url: string,
  clientId: string,
  tenantId: string,
  scope: string,
  flow: "browser" | "device-code",
): void {
  const cfg = readConfig();
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
  writeConfig(cfg);
  logSuccess(`Wrote mcpServers.${name} -> ${url} (oauth/${flow})`);
}

function computeConfigHash(
  name: string,
  url: string,
  clientId: string,
  flow: string,
  tenantId: string,
  scopes: string[],
): string {
  return createHash("sha256")
    .update(name, "utf8")
    .update("http", "utf8")
    .update(url, "utf8")
    .update("oauth", "utf8")
    .update(flow, "utf8")
    .update(clientId, "utf8")
    .update(tenantId, "utf8")
    .update(JSON.stringify(scopes), "utf8")
    .update("", "utf8")
    .update("[]", "utf8")
    .update("[]", "utf8")
    .digest("hex");
}

interface ApprovalRecord {
  configHash: string;
  approvedAt: string;
  approvedTools: string[];
  auditWarnings: string[];
}

function preApproveServers(
  servers: Array<{
    name: string;
    url: string;
    clientId: string;
    flow: string;
    tenantId: string;
    scopes: string[];
  }>,
): void {
  const store = readJson<Record<string, ApprovalRecord>>(APPROVAL_FILE) ?? {};
  for (const server of servers) {
    store[server.name] = {
      configHash: computeConfigHash(
        server.name,
        server.url,
        server.clientId,
        server.flow,
        server.tenantId,
        server.scopes,
      ),
      approvedAt: new Date().toISOString(),
      approvedTools: [],
      auditWarnings: [],
    };
  }
  mkdirSync(dirname(APPROVAL_FILE), { recursive: true, mode: 0o700 });
  writeFileSync(APPROVAL_FILE, JSON.stringify(store, null, 2) + "\n", {
    mode: 0o600,
  });
}

function refreshM365Servers(argv: string[], contentRoot: string): void {
  const args = parseRefreshArgs(argv);
  const catalog = readCatalog(contentRoot);
  const endpoint = catalog.discoverEndpoint;
  if (!endpoint) fail("M365 catalog is missing discoverEndpoint");

  const token = args.token ?? loadTokenFromCache();
  if (!token) {
    fail(
      "No bearer token found. Provide --token <bearer>, or connect any work-iq-* server once to seed ~/.hyperagent/mcp-tokens/.",
    );
  }

  logStep(`Fetching ${endpoint}`);
  const payload = fetchDiscoveryPayload(endpoint, token);
  const list = payload.mcpServers ?? [];
  if (list.length === 0) fail("Discovery returned no servers");

  const idToExistingAlias = new Map<string, string>();
  for (const [alias, server] of Object.entries(catalog.servers)) {
    if (server.id) idToExistingAlias.set(server.id, alias);
  }

  const next: Record<string, CatalogServer> = {};
  let added = 0;
  let skipped = 0;
  for (const entry of list) {
    const id = entry.mcpServerName ?? entry.id;
    const url = entry.url;
    const scope = entry.scope;
    const audience = entry.audience;
    if (typeof id !== "string" || !/^[A-Za-z0-9_]+$/.test(id)) {
      skipped += 1;
      continue;
    }
    if (typeof url !== "string" || !url.startsWith("https://")) {
      logWarning(`skipping ${id}: invalid url`);
      skipped += 1;
      continue;
    }
    if (typeof scope !== "string" || scope.length === 0) {
      logWarning(`skipping ${id}: missing scope`);
      skipped += 1;
      continue;
    }
    if (
      !args.includeCustom &&
      catalog.resourceId &&
      audience !== catalog.resourceId
    ) {
      logWarning(
        `skipping ${id}: audience '${audience ?? "(none)"}' != resource`,
      );
      skipped += 1;
      continue;
    }

    const existingAlias = idToExistingAlias.get(id);
    let alias = existingAlias ?? deriveAlias(id);
    if (next[alias] && next[alias].id !== id) {
      alias = `${alias}-${id.toLowerCase()}`;
    }
    next[alias] = { id, url, scope };
    if (!existingAlias) added += 1;
  }

  catalog.servers = Object.fromEntries(
    Object.entries(next).sort(([left], [right]) => left.localeCompare(right)),
  );
  writeUserCatalog(catalog);
  logSuccess(
    `Rewrote ${M365_USER_CATALOG} (${Object.keys(catalog.servers).length} servers, ${added} new, ${skipped} skipped)`,
  );
}

function fetchDiscoveryPayload(
  endpoint: string,
  token: string,
): DiscoveryPayload {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
const endpoint = process.env.HYPERAGENT_DISCOVERY_ENDPOINT;
const token = process.env.HYPERAGENT_DISCOVERY_TOKEN;
if (!endpoint || !token) process.exit(2);
const response = await fetch(endpoint, {
  headers: { Accept: "application/json", Authorization: \`Bearer \${token}\` },
});
if (!response.ok) {
  const body = await response.text().catch(() => "");
  console.error(\`Discovery failed: \${response.status} \${response.statusText}\\n\${body.slice(0, 500)}\`);
  process.exit(1);
}
process.stdout.write(await response.text());
`,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HYPERAGENT_DISCOVERY_ENDPOINT: endpoint,
        HYPERAGENT_DISCOVERY_TOKEN: token,
      },
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  if (result.error) fail(`Discovery failed: ${result.error.message}`);
  if (result.status !== 0) fail(result.stderr.trim() || "Discovery failed");
  try {
    return JSON.parse(result.stdout) as DiscoveryPayload;
  } catch (error) {
    fail(
      `Discovery returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseRefreshArgs(argv: string[]): {
  token?: string;
  includeCustom: boolean;
} {
  const parsed: { token?: string; includeCustom: boolean } = {
    includeCustom: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--token" && index + 1 < argv.length) {
      parsed.token = argv[++index];
    } else if (arg === "--include-custom") {
      parsed.includeCustom = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: hyperagent --mcp-m365-refresh-servers [--token <bearer>] [--include-custom]",
      );
      process.exit(0);
    } else {
      fail(`Unknown --mcp-m365-refresh-servers option: ${arg}`);
    }
  }
  return parsed;
}

function loadTokenFromCache(): string | undefined {
  if (!existsSync(M365_TOKENS_DIR)) return undefined;
  const files = readdirSync(M365_TOKENS_DIR).filter((file) =>
    file.endsWith(".msal.json"),
  );
  let best: { token: string; expiresOn: number } | undefined;
  for (const file of files) {
    try {
      const parsed = JSON.parse(
        readFileSync(join(M365_TOKENS_DIR, file), "utf8"),
      ) as Record<string, unknown>;
      const tokenMap = parsed.AccessToken as
        | Record<string, { secret?: string; expires_on?: string }>
        | undefined;
      if (!tokenMap) continue;
      for (const entry of Object.values(tokenMap)) {
        if (typeof entry.secret !== "string") continue;
        const expiresOn = Number(entry.expires_on ?? "0");
        if (expiresOn * 1000 < Date.now()) continue;
        if (!best || expiresOn > best.expiresOn) {
          best = { token: entry.secret, expiresOn };
        }
      }
    } catch {
      // Skip corrupt token cache files.
    }
  }
  return best?.token;
}

function deriveAlias(serverId: string): string {
  let alias = serverId.replace(/^mcp_/i, "");
  alias = alias.replace(/(RemoteServer|Server|Tools)$/i, "");
  alias = alias.replace(/^M365/i, "");
  alias = alias.replace(/([a-z0-9])([A-Z])/g, "$1-$2");
  alias = alias.replace(/_/g, "-");
  return alias.toLowerCase() || serverId.toLowerCase();
}

function showM365(): void {
  const state = readJson<SavedM365State>(M365_STATE_FILE);
  if (!state) {
    console.log("No saved M365 app. Run: hyperagent --mcp-m365-create-app");
    return;
  }
  console.log("M365 app registration:");
  console.log(`  App name:      ${state.appName ?? "(unset)"}`);
  console.log(`  Client ID:     ${state.clientId ?? "(unset)"}`);
  console.log(`  Tenant ID:     ${state.tenantId ?? "(unset)"}`);
  console.log(
    `  Callback port: ${state.callbackPort ?? DEFAULT_CALLBACK_PORT}`,
  );
  console.log(`  State file:    ${M365_STATE_FILE}`);
}
