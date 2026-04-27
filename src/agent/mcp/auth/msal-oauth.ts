// ── MCP OAuth via MSAL ──────────────────────────────────────────────
//
// Wraps @azure/msal-node's PublicClientApplication to implement the
// MCP SDK's OAuthClientProvider interface.
//
// Supports two interactive flows:
//
//   • "browser" — acquireTokenInteractive()
//     MSAL opens a system browser and spins up an ephemeral loopback
//     server on http://localhost (random port, no /callback path) to
//     receive the auth code. This matches the redirect URI registered
//     on MSAL-compatible Entra apps (FOCI / VS Code app, az CLI, etc.).
//
//   • "device-code" — acquireTokenByDeviceCode()
//     Prints verification URL + user code to stderr. No browser or
//     loopback port needed — works in SSH, containers, headless boxes.
//
// Both flows try acquireTokenSilent() first (cached/refreshed tokens),
// falling back to interactive only when silent fails.
//
// Token persistence uses MSAL's ICachePlugin with a per-server JSON
// file at ~/.hyperagent/mcp-tokens/<server>.msal.json (0o600).

import { exec } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import * as msal from "@azure/msal-node";
import type { ICachePlugin } from "@azure/msal-common/node";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientMetadata,
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

import type { MCPOAuthConfig } from "../types.js";

// ── Constants ────────────────────────────────────────────────────────

/** Directory for MSAL token caches. */
const MSAL_CACHE_DIR = join(homedir(), ".hyperagent", "mcp-tokens");
const CACHE_FILE_MODE = 0o600;
const CACHE_DIR_MODE = 0o700;

// ── MSAL cache plugin ────────────────────────────────────────────────

/**
 * Minimal file-based MSAL cache plugin.
 *
 * Before MSAL accesses the cache it deserialises from the file; after a
 * mutation it serialises back. File permissions are locked to owner-only.
 */
function createFileCachePlugin(cacheFilePath: string): ICachePlugin {
  return {
    async beforeCacheAccess(ctx) {
      if (existsSync(cacheFilePath)) {
        const raw = readFileSync(cacheFilePath, "utf8");
        ctx.tokenCache.deserialize(raw);
      }
    },
    async afterCacheAccess(ctx) {
      if (ctx.cacheHasChanged) {
        ensureCacheDir();
        writeFileSync(cacheFilePath, ctx.tokenCache.serialize(), {
          mode: CACHE_FILE_MODE,
        });
      }
    },
  };
}

function ensureCacheDir(): void {
  if (!existsSync(MSAL_CACHE_DIR)) {
    mkdirSync(MSAL_CACHE_DIR, { recursive: true, mode: CACHE_DIR_MODE });
  }
}

function msalCacheFilePath(serverName: string): string {
  const safeName = serverName.replace(/[^a-z0-9-]/g, "_");
  return join(MSAL_CACHE_DIR, `${safeName}.msal.json`);
}

/**
 * Check if an MSAL token cache file exists for this server. Used for
 * fast pre-flight checks (e.g. "is there any chance silent auth will
 * work?") without instantiating a full PCA.
 */
export function hasMsalCache(serverName: string): boolean {
  return existsSync(msalCacheFilePath(serverName));
}

// ── Build MSAL PCA ───────────────────────────────────────────────────

/**
 * Build a configured PublicClientApplication for the given OAuth config
 * and server name.
 */
function buildPca(
  serverName: string,
  authConfig: MCPOAuthConfig,
): msal.PublicClientApplication {
  const authority = authConfig.tenantId
    ? `https://login.microsoftonline.com/${authConfig.tenantId}`
    : "https://login.microsoftonline.com/organizations";

  const cachePlugin = createFileCachePlugin(msalCacheFilePath(serverName));

  return new msal.PublicClientApplication({
    auth: {
      clientId: authConfig.clientId,
      authority,
    },
    cache: { cachePlugin },
    system: {
      // Suppress MSAL's info-level log spam.
      loggerOptions: {
        logLevel: msal.LogLevel.Warning,
      },
    },
  });
}

// ── Scopes helper ────────────────────────────────────────────────────

/**
 * Resolve scopes to send to Entra. Falls back to `.default` if none
 * configured. Always includes `offline_access` for refresh tokens.
 */
function resolveScopes(authConfig: MCPOAuthConfig): string[] {
  const base =
    authConfig.scopes && authConfig.scopes.length > 0
      ? [...authConfig.scopes]
      : [];
  // offline_access is needed for refresh_token. openid + profile for
  // id_token. MSAL adds these itself for interactive flows but being
  // explicit avoids surprises.
  for (const s of ["offline_access"]) {
    if (!base.includes(s)) base.push(s);
  }
  return base;
}

// ── Silent acquisition ───────────────────────────────────────────────

/**
 * Try acquireTokenSilent. Returns null if there are no cached accounts
 * or the silent request fails (token expired, no refresh token, etc.).
 */
async function tryAcquireSilent(
  pca: msal.PublicClientApplication,
  scopes: string[],
): Promise<msal.AuthenticationResult | null> {
  const accounts = await pca.getAllAccounts();
  if (accounts.length === 0) return null;

  try {
    return await pca.acquireTokenSilent({
      account: accounts[0],
      scopes,
    });
  } catch {
    // InteractionRequired, token expired, etc. — fall through.
    return null;
  }
}

// ── Browser flow helpers ─────────────────────────────────────────────

/**
 * Open a URL in the system browser (best-effort).
 *
 * Always prints the URL to stderr so the user can copy/paste if the
 * browser doesn't open (e.g. headless distro, SSH, no xdg-open).
 */
function openBrowser(url: string): void {
  console.error(`[mcp]    If the browser doesn't open, visit:`);
  console.error(`[mcp]    ${url}`);

  const cmd =
    process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;

  exec(cmd, { timeout: 10_000 }, () => {
    // ignore errors — URL is printed above for manual use
  });
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Try to acquire a token silently (cached or refresh token).
 * Returns true if a valid token can be obtained without user interaction.
 * Returns false if interactive auth (browser/device-code) would be needed.
 *
 * Use this to pre-flight check before calling acquireMsalToken() in
 * contexts where interactive auth would hang (e.g. inside a tool call).
 */
export async function canAcquireSilently(
  serverName: string,
  authConfig: MCPOAuthConfig,
): Promise<boolean> {
  const pca = buildPca(serverName, authConfig);
  const scopes = resolveScopes(authConfig);
  const result = await tryAcquireSilent(pca, scopes);
  return result !== null;
}

/**
 * Acquire an OAuth access token using MSAL.
 *
 * 1. Tries silent acquisition (cached / refresh token).
 * 2. Falls back to interactive (browser or device-code per config).
 *
 * Returns the AuthenticationResult from MSAL (includes accessToken,
 * account, expiresOn, etc.).
 */
export async function acquireMsalToken(
  serverName: string,
  authConfig: MCPOAuthConfig,
): Promise<msal.AuthenticationResult> {
  const pca = buildPca(serverName, authConfig);
  const scopes = resolveScopes(authConfig);

  // 1. Try silent first.
  const silent = await tryAcquireSilent(pca, scopes);
  if (silent) return silent;

  // 2. Interactive fallback.
  if (authConfig.flow === "device-code") {
    return await acquireByDeviceCode(pca, scopes);
  }
  return await acquireByBrowser(pca, scopes);
}

/**
 * Interactive browser flow — MSAL opens a loopback server and the
 * system browser. Uses `http://localhost` (random port, no path) which
 * matches the redirect URI registered on MSAL-compatible apps (FOCI,
 * VS Code, az CLI).
 */
async function acquireByBrowser(
  pca: msal.PublicClientApplication,
  scopes: string[],
): Promise<msal.AuthenticationResult> {
  console.error("[mcp] 🔐 Opening browser for authentication...");

  return await pca.acquireTokenInteractive({
    scopes,
    openBrowser: async (url: string) => {
      openBrowser(url);
    },
    successTemplate:
      "<html><body><h1>Authentication Successful</h1>" +
      "<p>You can close this window and return to HyperAgent.</p>" +
      "<script>setTimeout(()=>window.close(),2000)</script></body></html>",
    errorTemplate:
      "<html><body><h1>Authentication Failed</h1>" +
      "<p>Check the terminal for details.</p></body></html>",
  });
}

/**
 * Device code flow — prints the verification URL and user code to
 * stderr; the user opens the URL on any device and types the code.
 */
async function acquireByDeviceCode(
  pca: msal.PublicClientApplication,
  scopes: string[],
): Promise<msal.AuthenticationResult> {
  const result = await pca.acquireTokenByDeviceCode({
    scopes,
    deviceCodeCallback: (response) => {
      console.error("");
      console.error("[mcp] 🔐 Device code authentication required");
      console.error(`[mcp]    ${response.message}`);
      console.error("");
    },
  });

  if (!result) {
    throw new Error(
      "Device code flow returned null — user may have cancelled.",
    );
  }
  return result;
}

/**
 * Create an OAuthClientProvider backed by MSAL for the MCP SDK.
 *
 * The provider's `tokens()` method acquires tokens via MSAL (silent →
 * interactive fallback). The MCP SDK calls `tokens()` before each
 * request, so we get automatic re-auth when tokens expire.
 *
 * The `redirectToAuthorization`, `saveCodeVerifier`, `codeVerifier`
 * hooks are stubs — MSAL handles the full auth dance internally,
 * so the MCP SDK's PKCE orchestration layer is bypassed.
 */
export function createMsalOAuthProvider(
  serverName: string,
  authConfig: MCPOAuthConfig,
): OAuthClientProvider {
  const pca = buildPca(serverName, authConfig);
  const scopes = resolveScopes(authConfig);

  const provider: OAuthClientProvider = {
    get redirectUrl(): string {
      // MSAL handles the redirect internally. Return the OOB urn so
      // the SDK doesn't crash if it inspects this field.
      return "urn:ietf:wg:oauth:2.0:oob";
    },

    get clientMetadata(): OAuthClientMetadata {
      return {
        redirect_uris: [],
        grant_types: [
          "authorization_code",
          "urn:ietf:params:oauth:grant-type:device_code",
          "refresh_token",
        ],
        response_types: ["code"],
        client_name: "HyperAgent",
        ...(authConfig.scopes ? { scope: authConfig.scopes.join(" ") } : {}),
      };
    },

    clientInformation(): OAuthClientInformationMixed | undefined {
      return { client_id: authConfig.clientId };
    },

    async tokens(): Promise<OAuthTokens | undefined> {
      // Try silent acquisition — returns cached / refreshed token.
      const result = await tryAcquireSilent(pca, scopes);
      if (!result) return undefined;

      return {
        access_token: result.accessToken,
        token_type: "Bearer",
        ...(result.expiresOn
          ? {
              expires_in: Math.max(
                0,
                Math.floor((result.expiresOn.getTime() - Date.now()) / 1000),
              ),
            }
          : {}),
      };
    },

    saveTokens(_tokens: OAuthTokens): void {
      // MSAL manages its own cache via the ICachePlugin — nothing to do.
    },

    async redirectToAuthorization(_authorizationUrl: URL): Promise<void> {
      // The MCP SDK calls this when tokens() returns undefined. We run
      // the MSAL interactive flow right here instead of using the SDK's
      // own PKCE machinery (which doesn't know about MSAL).
      //
      // NOTE: The SDK doesn't use our return value from this method —
      // it expects us to open a browser and have the callback server
      // handle the code. Since MSAL does everything internally, we
      // just acquire the token now and let the next tokens() call pick
      // it up from the MSAL cache.
      if (authConfig.flow === "device-code") {
        await acquireByDeviceCode(pca, scopes);
      } else {
        await acquireByBrowser(pca, scopes);
      }
    },

    saveCodeVerifier(_codeVerifier: string): void {
      // MSAL handles PKCE internally.
    },

    codeVerifier(): string {
      // MSAL handles PKCE internally.
      return "";
    },

    invalidateCredentials(
      scope: "all" | "client" | "tokens" | "verifier" | "discovery",
    ): void {
      if (scope === "all" || scope === "tokens") {
        // Clear all cached accounts from MSAL's in-memory cache. The
        // file cache will be updated on next afterCacheAccess.
        pca
          .getAllAccounts()
          .then((accounts) => {
            for (const account of accounts) {
              pca.signOut({ account }).catch(() => {});
            }
          })
          .catch(() => {});
      }
    },
  };

  return provider;
}
