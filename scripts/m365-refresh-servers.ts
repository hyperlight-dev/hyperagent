// ── M365 MCP server catalog refresher ────────────────────────────────
//
// Hits Agent 365's `discoverToolServers` endpoint and rewrites
// `scripts/m365-mcp-servers.json`. The catalog stores the discovered
// `url` and `scope` per server verbatim (the Agent 365 gateway does NOT
// use the /tenants/<tid>/ URL pattern from MS Learn — it uses
// /agents/servers/<name> directly).
//
// Token source (in order of preference):
//   1. --token <bearer> command-line flag
//   2. Any file in ~/.hyperagent/mcp-tokens/work-iq-*.json
//      (so the user can `/mcp enable work-iq-<anything>` once, then
//       run this recipe to discover the rest)
//
// Tenant-custom servers (audience != Agent 365 resource id) are
// excluded from the public catalog by default — they tend to be
// per-tenant Dataverse plugins.
//
// Usage:
//   just mcp-m365-refresh-servers
//   just mcp-m365-refresh-servers --token <bearer>
//   just mcp-m365-refresh-servers --include-custom
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { homedir } from "node:os";

const __filename = fileURLToPath(import.meta.url);
const CATALOG_PATH = resolve(dirname(__filename), "m365-mcp-servers.json");
const TOKENS_DIR = join(homedir(), ".hyperagent", "mcp-tokens");

interface CatalogServer {
  readonly id: string;
  readonly url: string;
  readonly scope: string;
}
interface Catalog {
  _comment?: string;
  resourceId: string;
  discoverEndpoint: string;
  callbackPort: number;
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

interface CliArgs {
  token?: string;
  includeCustom: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const out: CliArgs = { includeCustom: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--token" && i + 1 < argv.length) {
      out.token = argv[i + 1];
      i++;
    } else if (argv[i] === "--include-custom") {
      out.includeCustom = true;
    }
  }
  return out;
}

/**
 * Load the most recent OAuth access token from the MSAL cache.
 *
 * MSAL cache files are named *.msal.json and contain an AccessToken
 * map with {secret, expires_on} entries. We pick the freshest
 * non-expired token — any Agent 365 server token works for discovery
 * since they all share the same audience.
 *
 * Returns undefined if no usable token is found.
 */
function loadTokenFromCache(): string | undefined {
  if (!existsSync(TOKENS_DIR)) return undefined;
  const files = readdirSync(TOKENS_DIR).filter((f) =>
    f.endsWith(".msal.json"),
  );
  if (files.length === 0) return undefined;

  let best: { token: string; expiresOn: number } | undefined;

  for (const f of files) {
    try {
      const raw = readFileSync(join(TOKENS_DIR, f), "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const atMap = parsed["AccessToken"] as
        | Record<string, { secret?: string; expires_on?: string }>
        | undefined;
      if (!atMap) continue;
      for (const entry of Object.values(atMap)) {
        if (typeof entry.secret !== "string") continue;
        const expiresOn = Number(entry.expires_on ?? "0");
        if (expiresOn * 1000 < Date.now()) continue; // expired
        if (!best || expiresOn > best.expiresOn) {
          best = { token: entry.secret, expiresOn };
        }
      }
    } catch {
      // skip corrupt files
    }
  }
  return best?.token;
}

/**
 * Derive a short alias from an Agent 365 server id. Best-effort only —
 * the existing alias map always wins for known ids so renames don't
 * surprise anyone.
 */
function deriveAlias(serverId: string): string {
  let s = serverId.replace(/^mcp_/i, "");
  // Normalise common Microsoft-internal suffixes.
  s = s.replace(/(RemoteServer|Server|Tools)$/i, "");
  // M365Copilot → Copilot
  s = s.replace(/^M365/i, "");
  // Camel/PascalCase → kebab-case (e.g. SharePointLists → sharepoint-lists)
  s = s.replace(/([a-z0-9])([A-Z])/g, "$1-$2");
  s = s.replace(/_/g, "-");
  return s.toLowerCase() || serverId.toLowerCase();
}

async function main(): Promise<void> {
  const { token: cliToken, includeCustom } = parseArgs(process.argv.slice(2));

  const raw = readFileSync(CATALOG_PATH, "utf8");
  const catalog = JSON.parse(raw) as Catalog;

  const token = cliToken ?? loadTokenFromCache();
  if (!token) {
    throw new Error(
      "No bearer token found.\n" +
        `  Provide one via --token <bearer>, OR run /mcp enable <work-iq-*>\n` +
        `  inside HyperAgent first to seed ${TOKENS_DIR}/.`,
    );
  }

  console.log(`▸ Fetching ${catalog.discoverEndpoint}`);
  const res = await fetch(catalog.discoverEndpoint, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Discovery failed: ${res.status} ${res.statusText}\n${body.slice(0, 500)}`,
    );
  }
  const payload = (await res.json()) as DiscoveryPayload;
  const list = payload.mcpServers ?? [];
  if (list.length === 0) {
    throw new Error(
      "Discovery returned no servers — endpoint shape may have changed",
    );
  }

  // Build reverse lookup of existing alias map so we keep stable names.
  const idToExistingAlias = new Map<string, string>();
  for (const [alias, srv] of Object.entries(catalog.servers)) {
    idToExistingAlias.set(srv.id, alias);
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
      skipped++;
      continue;
    }
    if (typeof url !== "string" || !url.startsWith("https://")) {
      console.error(`  ⚠ skipping ${id}: invalid url`);
      skipped++;
      continue;
    }
    if (typeof scope !== "string" || scope.length === 0) {
      console.error(`  ⚠ skipping ${id}: missing scope`);
      skipped++;
      continue;
    }
    if (!includeCustom && audience !== catalog.resourceId) {
      console.error(
        `  ⚠ skipping ${id}: audience '${audience ?? "(none)"}' != resource (use --include-custom to allow)`,
      );
      skipped++;
      continue;
    }

    const existingAlias = idToExistingAlias.get(id);
    let alias = existingAlias ?? deriveAlias(id);
    if (next[alias] && next[alias].id !== id) {
      alias = `${alias}-${id.toLowerCase()}`;
    }
    next[alias] = { id, url, scope };
    if (!existingAlias) added++;
  }

  catalog.servers = Object.fromEntries(
    Object.entries(next).sort(([a], [b]) => a.localeCompare(b)),
  );

  writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2) + "\n");
  const total = Object.keys(catalog.servers).length;
  console.log(
    `✅ Rewrote ${CATALOG_PATH} (${total} servers, ${added} new, ${skipped} skipped)`,
  );
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`❌ ${msg}`);
  process.exit(1);
});
