// ── HTTP retry middleware for MCP transports ─────────────────────────
//
// Wraps `fetch` so transient gateway failures (429/502/503/504) trigger
// retries with exponential backoff. Honours `Retry-After` headers up to
// a sane cap. All other failures pass through untouched.
//
// The Agent 365 gateway in particular returns 502/503 occasionally
// during normal operation; without retries every reconnect is brittle.
//
// Policy (hard-coded — not configurable per-server):
//   • Retry on: 429, 502, 503, 504 + network errors (TypeError from fetch)
//   • Max attempts: 3 (1 initial + 2 retries)
//   • Backoff: 1s, 2s (exponential, factor 2)
//   • Retry-After: respected if ≤ MAX_RETRY_AFTER_MS, else fail
//
// Auth errors (401/403) are NEVER retried here — the OAuth provider
// handles them at the transport level.

import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

// ── Constants ────────────────────────────────────────────────────────

/** Initial retry delay in milliseconds. Doubles each retry. */
const INITIAL_BACKOFF_MS = 1000;

/** Maximum number of attempts (initial + retries). */
const MAX_ATTEMPTS = 3;

/**
 * Cap on Retry-After header. If the server asks us to wait longer than
 * this, we fail fast rather than appearing to hang. 30s is generous
 * enough for any well-behaved gateway throttle.
 */
const MAX_RETRY_AFTER_MS = 30_000;

/** Status codes that warrant a retry. */
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

// ── Public API ───────────────────────────────────────────────────────

/**
 * Wrap a fetch implementation with retry/backoff for transient failures.
 *
 * @param baseFetch - The underlying fetch implementation. Defaults to
 *                    globalThis.fetch.
 * @returns A FetchLike that retries 429/502/503/504 + network errors.
 */
export function createRetryFetch(baseFetch?: FetchLike): FetchLike {
  const f: FetchLike = baseFetch ?? ((url, init) => fetch(url, init));

  return async (url, init) => {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let response: Response | undefined;
      try {
        response = await f(url, init);
      } catch (err) {
        lastError = err;
        // Network errors (DNS, connection refused, etc.) — retry only
        // if attempts remain. AbortError indicates intentional cancel —
        // never retry.
        if (isAbortError(err) || attempt === MAX_ATTEMPTS) throw err;
        await sleep(backoffMs(attempt));
        continue;
      }

      if (!RETRYABLE_STATUS.has(response.status)) {
        return response;
      }

      // Retryable status. If this was the last attempt, return the
      // response as-is — let the caller see the error.
      if (attempt === MAX_ATTEMPTS) return response;

      const wait = retryAfterMs(response) ?? backoffMs(attempt);
      if (wait > MAX_RETRY_AFTER_MS) {
        // Server wants us to wait too long — give up and surface the
        // response so the caller can react properly.
        return response;
      }

      // Drain the body so the connection can be reused. Errors here are
      // best-effort — we're about to retry anyway.
      try {
        await response.body?.cancel();
      } catch {
        // ignore
      }

      await sleep(wait);
    }

    // Unreachable: loop either returns or throws on the final attempt.
    throw lastError ?? new Error("retry-fetch: exhausted attempts");
  };
}

// ── Internals ────────────────────────────────────────────────────────

function backoffMs(attempt: number): number {
  // attempt is 1-based: 1 → 1000ms, 2 → 2000ms.
  return INITIAL_BACKOFF_MS * 2 ** (attempt - 1);
}

/**
 * Parse the Retry-After header. Supports both delta-seconds and
 * HTTP-date formats. Returns undefined if absent or unparseable.
 */
function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const trimmed = header.trim();

  // delta-seconds (e.g. "30")
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    return seconds * 1000;
  }

  // HTTP-date (e.g. "Wed, 21 Oct 2026 07:28:00 GMT")
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) {
    const delta = date - Date.now();
    return delta > 0 ? delta : 0;
  }

  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || err.message.includes("aborted"))
  );
}
