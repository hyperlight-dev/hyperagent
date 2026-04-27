#!/usr/bin/env tsx
// ── Add an HTTP MCP server entry to ~/.hyperagent/config.json ────────
//
// Cross-platform replacement for the inline node script that used to
// live in the `just mcp-add-http` recipe. Runs on any OS where Node +
// tsx work (Linux, macOS, Windows native, WSL, Git Bash).
//
// Usage:
//   tsx scripts/mcp-add-http.ts <name> <url> [clientId] [tenantId] [scopes] [flow]
//
// All args after <url> are optional. If clientId is provided, an OAuth
// auth block is written and `flow` becomes REQUIRED — must be "browser"
// or "device-code". scopes is comma-separated; if empty, defaults to
// "<origin>/.default".
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

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

function fail(msg: string): never {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

function main(): void {
  const [name, url, clientId, tenantId, scopes, flowArg] =
    process.argv.slice(2);

  if (!name || !url) {
    fail(
      "Usage: tsx scripts/mcp-add-http.ts <name> <url> " +
        "[clientId] [tenantId] [scopes] [flow]",
    );
  }

  if (!NAME_PATTERN.test(name)) {
    fail(`Invalid NAME: '${name}' (use lowercase letters, digits, hyphens)`);
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

  const configDir = join(homedir(), ".hyperagent");
  const configFile = join(configDir, "config.json");
  mkdirSync(configDir, { recursive: true });

  const cfg: HyperAgentConfig = existsSync(configFile)
    ? (JSON.parse(readFileSync(configFile, "utf8")) as HyperAgentConfig)
    : {};
  cfg.mcpServers = cfg.mcpServers ?? {};

  const entry: HttpServerEntry = { type: "http", url };
  if (clientId) {
    if (flowArg !== "browser" && flowArg !== "device-code") {
      fail(
        `flow is required when clientId is provided and must be "browser" or "device-code" (got: "${flowArg ?? ""}")`,
      );
    }
    const scopeList = scopes
      ? scopes
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [`${parsedUrl.origin}/.default`];
    entry.auth = {
      method: "oauth",
      flow: flowArg as "browser" | "device-code",
      clientId,
      scopes: scopeList,
    };
    if (tenantId) entry.auth.tenantId = tenantId;
  }
  cfg.mcpServers[name] = entry;

  // Ensure the config dir exists for writeFileSync (idempotent).
  mkdirSync(dirname(configFile), { recursive: true });
  writeFileSync(configFile, JSON.stringify(cfg, null, 2) + "\n");

  const suffix = clientId ? ` (oauth/${flowArg})` : "";
  console.log(`✅ Wrote mcpServers.${name} → ${url}${suffix}`);
}

main();
