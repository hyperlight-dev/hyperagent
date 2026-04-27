// ── MCP OAuth token cache ────────────────────────────────────────────
//
// Persists OAuth tokens to ~/.hyperagent/mcp-tokens/<server-name>.json
// with restrictive file permissions (0o600). Used by the browser OAuth
// provider to cache tokens between sessions so users don't have to
// re-authenticate every time.
//
// Token files contain:
//   - access_token, refresh_token, token_type, expires_in, scope
//   - savedAt: ISO timestamp of when tokens were saved
//
// No encryption at rest (v1) — relies on file permissions.
// Future: Key Vault–backed encryption for enterprise deployments.

import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

// ── Constants ────────────────────────────────────────────────────────

/** Directory for cached MCP OAuth tokens. */
const TOKENS_DIR = join(homedir(), ".hyperagent", "mcp-tokens");

/** File permission: owner read/write only (no group, no other). */
const TOKEN_FILE_MODE = 0o600;

/** Directory permission: owner only. */
const TOKEN_DIR_MODE = 0o700;

// ── Types ────────────────────────────────────────────────────────────

/** On-disk shape of a cached token file. */
interface CachedTokenFile {
  /** ISO timestamp of when tokens were saved. */
  savedAt: string;

  /** The OAuth tokens. */
  tokens: OAuthTokens;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Load cached OAuth tokens for a server.
 * Returns undefined if no cached tokens exist or they can't be read.
 */
export function loadCachedTokens(serverName: string): OAuthTokens | undefined {
  const filePath = tokenFilePath(serverName);
  try {
    if (!existsSync(filePath)) return undefined;

    // Warn if file permissions are too open (Unix only)
    warnIfInsecurePermissions(filePath);

    const raw = readFileSync(filePath, "utf8");
    const cached = JSON.parse(raw) as CachedTokenFile;

    if (!cached.tokens || typeof cached.tokens.access_token !== "string") {
      console.error(
        `[mcp] Warning: corrupt token cache for "${serverName}" — ignoring`,
      );
      return undefined;
    }

    return cached.tokens;
  } catch {
    return undefined;
  }
}

/**
 * Save OAuth tokens to disk for a server.
 * Creates the token directory if it doesn't exist.
 */
export function saveCachedTokens(
  serverName: string,
  tokens: OAuthTokens,
): void {
  const filePath = tokenFilePath(serverName);
  try {
    ensureTokenDir();

    const cached: CachedTokenFile = {
      savedAt: new Date().toISOString(),
      tokens,
    };

    writeFileSync(filePath, JSON.stringify(cached, null, 2), {
      mode: TOKEN_FILE_MODE,
    });
  } catch (err) {
    console.error(
      `[mcp] Failed to cache tokens for "${serverName}": ${(err as Error).message}`,
    );
  }
}

/**
 * Delete cached tokens for a server.
 * Used when tokens are explicitly invalidated or the server is removed.
 */
export function deleteCachedTokens(serverName: string): void {
  const filePath = tokenFilePath(serverName);
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  } catch {
    // Best-effort — ignore errors
  }
}

/**
 * Check whether cached tokens exist for a server.
 */
export function hasCachedTokens(serverName: string): boolean {
  return existsSync(tokenFilePath(serverName));
}

// ── Internal helpers ─────────────────────────────────────────────────

/** Compute the file path for a server's cached tokens. */
function tokenFilePath(serverName: string): string {
  // Sanitise server name for safe filesystem use
  const safeName = serverName.replace(/[^a-z0-9-]/g, "_");
  return join(TOKENS_DIR, `${safeName}.json`);
}

/** Ensure the token directory exists with secure permissions. */
function ensureTokenDir(): void {
  if (!existsSync(TOKENS_DIR)) {
    mkdirSync(TOKENS_DIR, { recursive: true, mode: TOKEN_DIR_MODE });
  }
}

/**
 * Warn if a token file has permissions that are too open.
 * Only checks on Unix systems where `mode` is meaningful.
 */
function warnIfInsecurePermissions(filePath: string): void {
  if (process.platform === "win32") return;

  try {
    const stat = statSync(filePath);
    // Check if group or other have any permissions
    // mode & 0o077 gives us any non-owner permission bits
    const insecureBits = stat.mode & 0o077;
    if (insecureBits !== 0) {
      console.error(
        `[mcp] Warning: token file ${filePath} has insecure permissions ` +
          `(${(stat.mode & 0o777).toString(8)}). Should be 600.`,
      );
    }
  } catch {
    // Ignore — stat failure is not a security issue we can fix
  }
}
