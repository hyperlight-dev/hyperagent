// ── MCP browser OAuth provider ───────────────────────────────────────
//
// Implements OAuthClientProvider for interactive browser-based OAuth
// with PKCE. On first use, opens a browser for sign-in. Tokens are
// cached to disk for subsequent sessions.
//
// Flow:
//   1. Check for cached tokens → use if valid
//   2. SDK calls redirectToAuthorization() → we open the browser
//   3. Local callback server receives the auth code
//   4. Caller awaits waitForAuthCallback() to get the code
//   5. Caller calls transport.finishAuth(code) to complete the flow
//   6. SDK exchanges code for tokens → calls saveTokens()
//   7. We cache the tokens to disk
//
// This provider is used for local REPL sessions. For K8s / headless,
// use WorkloadIdentityProvider or ClientCredentialsProvider instead.

import { createServer, type Server } from "node:http";
import { exec } from "node:child_process";

import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientMetadata,
  OAuthTokens,
  OAuthClientInformationMixed,
} from "@modelcontextprotocol/sdk/shared/auth.js";

import type { MCPOAuthConfig } from "../types.js";
import {
  loadCachedTokens,
  saveCachedTokens,
  deleteCachedTokens,
} from "./token-cache.js";

// ── Constants ────────────────────────────────────────────────────────

/** Default port for the OAuth callback server. */
const DEFAULT_CALLBACK_PORT = 8080;

/** How long to wait for the user to authenticate (ms). */
const AUTH_TIMEOUT_MS = 120_000; // 2 minutes

// ── Result type ──────────────────────────────────────────────────────

/**
 * Result from createBrowserOAuthProvider.
 * Includes the provider and a function to wait for the auth callback.
 */
export interface BrowserOAuthProviderResult {
  /** The OAuthClientProvider to pass to StreamableHTTPClientTransport. */
  provider: OAuthClientProvider;

  /**
   * Wait for the OAuth callback to arrive after the browser opens.
   * Resolves with the authorization code.
   * Rejects on timeout or error.
   */
  waitForAuthCallback: () => Promise<string>;

  /** Stop the callback server (cleanup). */
  stopCallbackServer: () => void;
}

// ── Provider implementation ──────────────────────────────────────────

/**
 * Create a browser-based OAuthClientProvider for interactive OAuth flows.
 *
 * @param serverName - MCP server name (used for token cache key).
 * @param authConfig - OAuth configuration from the MCP server config.
 * @returns Provider, waitForAuthCallback function, and cleanup function.
 */
export function createBrowserOAuthProvider(
  serverName: string,
  authConfig: MCPOAuthConfig,
): BrowserOAuthProviderResult {
  const callbackPort = authConfig.callbackPort ?? DEFAULT_CALLBACK_PORT;
  const callbackUrl = new URL(`http://localhost:${callbackPort}/callback`);

  // In-memory session state (not persisted — per-session only)
  let currentCodeVerifier: string = "";
  let callbackServer: Server | null = null;
  let authTimeout: ReturnType<typeof setTimeout> | null = null;

  // Promise resolve/reject for the auth code — set when callback server starts
  let resolveAuthCode: ((code: string) => void) | null = null;
  let rejectAuthCode: ((err: Error) => void) | null = null;
  let authCodePromise: Promise<string> | null = null;

  const provider: OAuthClientProvider = {
    get redirectUrl(): URL {
      return callbackUrl;
    },

    get clientMetadata(): OAuthClientMetadata {
      return {
        redirect_uris: [callbackUrl.toString()],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_name: "HyperAgent",
        ...(authConfig.scopes ? { scope: authConfig.scopes.join(" ") } : {}),
      };
    },

    clientInformation(): OAuthClientInformationMixed | undefined {
      // Pre-registered client — return static client ID
      return { client_id: authConfig.clientId };
    },

    tokens(): OAuthTokens | undefined {
      return loadCachedTokens(serverName);
    },

    saveTokens(tokens: OAuthTokens): void {
      saveCachedTokens(serverName, tokens);
    },

    async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
      console.error(`[mcp] 🔐 Opening browser for authentication...`);
      console.error(
        `[mcp]    URL: ${authorizationUrl.origin}${authorizationUrl.pathname}`,
      );

      // Start callback server before opening browser
      await startServer(callbackPort);

      // Open browser
      openBrowser(authorizationUrl.toString());
    },

    saveCodeVerifier(codeVerifier: string): void {
      currentCodeVerifier = codeVerifier;
    },

    codeVerifier(): string {
      return currentCodeVerifier;
    },

    invalidateCredentials(
      scope: "all" | "client" | "tokens" | "verifier" | "discovery",
    ): void {
      if (scope === "all" || scope === "tokens") {
        deleteCachedTokens(serverName);
        currentCodeVerifier = "";
      }
      if (scope === "verifier") {
        currentCodeVerifier = "";
      }
    },
  };

  /**
   * Start an ephemeral HTTP server on localhost to receive the OAuth callback.
   * Only binds to 127.0.0.1 — not accessible from the network.
   */
  function startServer(port: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      stopServer();

      // Create the auth code promise that waitForAuthCallback returns
      authCodePromise = new Promise<string>((res, rej) => {
        resolveAuthCode = res;
        rejectAuthCode = rej;
      });

      callbackServer = createServer((req, res) => {
        // Only handle the callback path
        if (!req.url?.startsWith("/callback")) {
          res.writeHead(404);
          res.end();
          return;
        }

        const parsed = new URL(req.url, `http://localhost:${port}`);
        const code = parsed.searchParams.get("code");
        const error = parsed.searchParams.get("error");

        if (code) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            "<html><body><h1>Authentication Successful</h1>" +
              "<p>You can close this window and return to HyperAgent.</p>" +
              "<script>setTimeout(()=>window.close(),2000)</script>" +
              "</body></html>",
          );

          resolveAuthCode?.(code);
          resolveAuthCode = null;
          rejectAuthCode = null;
          setTimeout(() => stopServer(), 1000);
        } else if (error) {
          const desc = parsed.searchParams.get("error_description") ?? error;
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(
            `<html><body><h1>Authentication Failed</h1>` +
              `<p>${escapeHtml(desc)}</p></body></html>`,
          );

          rejectAuthCode?.(new Error(`OAuth error: ${desc}`));
          resolveAuthCode = null;
          rejectAuthCode = null;
          setTimeout(() => stopServer(), 1000);
        } else {
          res.writeHead(400);
          res.end("Missing authorization code");
        }
      });

      callbackServer.listen(port, "127.0.0.1", () => {
        resolve();
      });

      callbackServer.on("error", (err) => {
        reject(
          new Error(
            `Failed to start OAuth callback server on port ${port}: ${err.message}`,
          ),
        );
      });

      // Timeout — don't leave the server hanging forever
      authTimeout = setTimeout(() => {
        rejectAuthCode?.(
          new Error(
            `OAuth authentication timed out after ${AUTH_TIMEOUT_MS / 1000}s`,
          ),
        );
        resolveAuthCode = null;
        rejectAuthCode = null;
        stopServer();
      }, AUTH_TIMEOUT_MS);
    });
  }

  /** Stop the callback server and clear the timeout. */
  function stopServer(): void {
    if (authTimeout) {
      clearTimeout(authTimeout);
      authTimeout = null;
    }
    if (callbackServer) {
      try {
        callbackServer.close();
      } catch {
        // Ignore close errors
      }
      callbackServer = null;
    }
  }

  /**
   * Wait for the OAuth callback to deliver an authorization code.
   * The callback server must have been started first
   * (via redirectToAuthorization).
   */
  function waitForAuthCallback(): Promise<string> {
    if (!authCodePromise) {
      return Promise.reject(
        new Error(
          "OAuth callback server not started — redirectToAuthorization must be called first",
        ),
      );
    }
    return authCodePromise;
  }

  return {
    provider,
    waitForAuthCallback,
    stopCallbackServer: stopServer,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Open a URL in the default browser.
 * Falls back to logging the URL if no browser command is available.
 */
function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";

  exec(`${cmd} "${url}"`, (err) => {
    if (err) {
      console.error(
        `[mcp] Could not open browser automatically. Please open this URL manually:`,
      );
      console.error(`[mcp]   ${url}`);
    }
  });
}

/** Escape HTML special characters to prevent XSS in callback page. */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
