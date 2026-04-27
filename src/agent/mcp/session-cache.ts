// ── MCP session cache ────────────────────────────────────────────────
//
// Persists the Mcp-Session-Id from the StreamableHTTPClientTransport so
// the agent can reattach to an existing server session across REPL
// restarts instead of doing a fresh `initialize` handshake every time.
//
// On-disk shape (~/.hyperagent/mcp-sessions/<server-name>.json):
//   { "savedAt": "<iso>", "sessionId": "<opaque>" }
//
// Sessions naturally expire server-side; if the cached id is stale the
// server returns 404 and we just discard the file and reconnect fresh.

import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SESSIONS_DIR = join(homedir(), ".hyperagent", "mcp-sessions");
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/**
 * 30 minutes — anything older we treat as definitely stale and don't
 * even try. Keeps us from sending obviously-dead session ids.
 */
const SESSION_MAX_AGE_MS = 30 * 60 * 1000;

interface CachedSession {
  savedAt: string;
  sessionId: string;
}

function sessionFilePath(serverName: string): string {
  // serverName is validated upstream (alphanumeric + hyphen) so it's
  // safe to use directly in the file path.
  return join(SESSIONS_DIR, `${serverName}.json`);
}

function ensureDir(): void {
  if (!existsSync(SESSIONS_DIR)) {
    mkdirSync(SESSIONS_DIR, { recursive: true, mode: DIR_MODE });
  }
}

/**
 * Load a cached session id for a server. Returns undefined if missing,
 * corrupt, or older than the max age.
 */
export function loadCachedSession(serverName: string): string | undefined {
  const path = sessionFilePath(serverName);
  try {
    if (!existsSync(path)) return undefined;
    const cached = JSON.parse(readFileSync(path, "utf8")) as CachedSession;
    if (typeof cached.sessionId !== "string" || !cached.sessionId) {
      return undefined;
    }
    const savedAt = Date.parse(cached.savedAt);
    if (Number.isNaN(savedAt)) return undefined;
    if (Date.now() - savedAt > SESSION_MAX_AGE_MS) return undefined;
    return cached.sessionId;
  } catch {
    return undefined;
  }
}

/**
 * Save a session id for a server. No-op on errors — session caching is
 * an optimisation, never required for correctness.
 */
export function saveCachedSession(serverName: string, sessionId: string): void {
  if (!sessionId) return;
  try {
    ensureDir();
    const cached: CachedSession = {
      savedAt: new Date().toISOString(),
      sessionId,
    };
    writeFileSync(sessionFilePath(serverName), JSON.stringify(cached), {
      mode: FILE_MODE,
    });
  } catch {
    // ignore
  }
}

/**
 * Discard a cached session — call when the server has rejected the
 * session (typically a 404 from the gateway).
 */
export function deleteCachedSession(serverName: string): void {
  try {
    const path = sessionFilePath(serverName);
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // ignore
  }
}
