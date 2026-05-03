// ── fetch plugin ─────────────────────────────────────────────────────
//
// Secure HTTPS-only fetch for sandboxed JavaScript.
// Guest JavaScript loads via: const fetch = require("host:fetch")
//
// Security model:
//   - HTTPS only. HTTP is rejected at URL parse time.
//   - Default-deny domain allowlist — empty list = ALL blocked.
//   - SSRF protection via custom DNS lookup + post-connect IP check.
//     Blocks all private/reserved IP ranges including IPv4-mapped IPv6.
//   - Redirects followed (up to 5 hops), each hop re-validated against
//     domain allowlist, SSRF checks, and HTTPS-only policy.
//   - Rate limiting: per-session sliding windows (requests/min, /hour).
//   - Response body capped, Content-Type allowlisted.
//   - Headers: allowlist of names the sandbox may set. Host always
//     overrides Host, Cookie, User-Agent, and proxy headers.
//   - POST gated by config (default: disabled).
//   - All errors return { error: "..." } — categorised but not leaky.
//   - Minimum response delay (200ms) to collapse timing side-channels.
//   - Audit log: JSONL to ~/.hyperagent/fetch-log.jsonl.
//   - Single in-flight request (promise mutex) — no concurrency.
//
// URL Length Limits:
//   - Total URL: 2048 characters maximum
//   - Path + query string: 1024 characters maximum
//   When batching API calls (e.g. Wikipedia with many titles), split into
//   smaller batches to stay under the path+query limit.
//
// But only over HTTPS, to allowlisted domains, after DNS validation.
//
// ─────────────────────────────────────────────────────────────────────

import { request as httpsRequest, Agent as HttpsAgent } from "node:https";
import { resolve4, resolve6 } from "node:dns/promises";
import { isIP, isIPv4, isIPv6 } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
  chmodSync,
} from "node:fs";
import type { ConfigSchema, ConfigValues } from "../plugin-schema-types.js";

// ── Plugin Schema (source of truth) ─────────────────────────────────

/**
 * Configuration schema for the fetch plugin.
 * This is the single source of truth — config types are derived from it.
 */
export const SCHEMA = {
  allowedDomains: {
    type: "array" as const,
    description:
      "Allowed domains (comma-separated). Exact match or *.example.com wildcard",
    required: true,
    promptKey: true,
    items: { type: "string" },
  },
  allowPost: {
    type: "boolean" as const,
    description: "Allow POST requests (GET is always available)",
    default: false,
    promptKey: true,
  },
  allowedRequestHeaders: {
    type: "array" as const,
    description:
      "Allowed request header names the sandbox may set (comma-separated)",
    default: ["Authorization", "Content-Type", "Accept"],
    items: { type: "string" },
  },
  allowedContentTypes: {
    type: "array" as const,
    description:
      'Allowed response Content-Type prefixes or presets. Presets: "text-only" (json, text/*, xml, csv), "media-friendly" (text-only + images, audio, PDFs), "permissive" (any). Examples: ["application/json", "text/"] or ["media-friendly"]',
    default: ["application/json", "text/"],
    items: { type: "string" },
  },
  userAgent: {
    type: "string" as const,
    description: "Static User-Agent header sent on all requests",
    default: "hyperlight-fetch/1.0",
    maxLength: 256,
  },
  connectTimeoutMs: {
    type: "number" as const,
    description: "TCP+TLS connect timeout in milliseconds (max 10000)",
    default: 5000,
    minimum: 1000,
    maximum: 10000,
  },
  readTimeoutMs: {
    type: "number" as const,
    description: "Read timeout in milliseconds (max 30000)",
    default: 10000,
    minimum: 1000,
    maximum: 30000,
  },
  maxResponseSizeKb: {
    type: "number" as const,
    description:
      "Maximum total response body size in KB (max 65536). Responses larger than this are rejected.",
    default: 1024,
    minimum: 1,
    maximum: 65536,
  },
  readSizeKb: {
    type: "number" as const,
    description:
      "Maximum body size returned per read() call in KB (max 256). Must be smaller than the sandbox output buffer.",
    default: 48,
    minimum: 8,
    maximum: 256,
  },
  responseCacheTtlSeconds: {
    type: "number" as const,
    description:
      "How long response bodies stay cached on the host before expiring (seconds, max 600)",
    default: 300,
    minimum: 30,
    maximum: 600,
  },
  maxRequestBodySizeKb: {
    type: "number" as const,
    description: "Maximum POST request body size in KB (max 64)",
    default: 4,
    minimum: 1,
    maximum: 64,
  },
  maxRequestsPerMinute: {
    type: "number" as const,
    description: "Maximum fetch calls per minute (sliding window)",
    default: 30,
    minimum: 1,
    maximum: 60,
  },
  maxRequestsPerHour: {
    type: "number" as const,
    description: "Maximum fetch calls per hour (session-scoped)",
    default: 100,
    minimum: 1,
    maximum: 500,
  },
  maxDomainsPerSession: {
    type: "number" as const,
    description: "Maximum unique domains per session",
    default: 5,
    minimum: 1,
    maximum: 20,
  },
  maxDataReceivedKb: {
    type: "number" as const,
    description: "Maximum total response data per session in KB (max 1048576)",
    default: 2048,
    minimum: 1,
    maximum: 1048576,
  },
  returnXRequestId: {
    type: "boolean" as const,
    description:
      "Include X-Request-Id response header in returned object (if present)",
    default: false,
  },
  conditionalCacheMaxEntries: {
    type: "number" as const,
    description:
      "Maximum number of URLs cached for conditional requests (ETag/Last-Modified). 0 effectively disables caching (min 1).",
    default: 20,
    minimum: 1,
    maximum: 100,
  },
  conditionalCacheTtlSeconds: {
    type: "number" as const,
    description:
      "How long conditional-cache entries remain valid (seconds). After this, the next GET sends a normal request without conditional headers.",
    default: 600,
    minimum: 60,
    maximum: 3600,
  },
  autoRetryOn429: {
    type: "boolean" as const,
    description:
      "Automatically wait and retry when server returns 429 Too Many Requests.",
    default: false,
  },
  autoRetryMaxWaitSeconds: {
    type: "number" as const,
    description:
      "Maximum seconds to wait for a single 429 retry. If server asks for longer, returns error instead of waiting.",
    default: 30,
    minimum: 1,
    maximum: 120,
  },
  autoRetryMaxAttempts: {
    type: "number" as const,
    description:
      "Maximum number of retry attempts on 429 before giving up and returning the error.",
    default: 3,
    minimum: 1,
    maximum: 10,
  },
  maxParallelFetches: {
    type: "number" as const,
    description:
      "Maximum concurrent requests for batch operations like fetchBinaryBatch. Higher values speed up bulk downloads but may trigger server rate limits. Default 1 (serial).",
    default: 1,
    minimum: 1,
    maximum: 10,
  },
  diskCacheMaxMb: {
    type: "number" as const,
    description:
      "Maximum disk cache size in MB for anonymous HTTP responses. Cached in $HOME/.hyperagent/fetch-cache with LFU eviction. Set to 0 to disable.",
    default: 100,
    minimum: 0,
    maximum: 1000,
  },
} satisfies ConfigSchema;

// Hints are now in plugin.json (structured metadata).\n\n// ── TypeScript Interfaces ────────────────────────────────────────────

/** Configuration for the fetch plugin (derived from SCHEMA). */
export type FetchConfig = ConfigValues<typeof SCHEMA>;

/** Rate limit information from response headers. */
export interface RateLimitInfo {
  /** Rate limit maximum requests. */
  limit?: number;
  /** Remaining requests in current window. */
  remaining?: number;
  /** Requests used in current window. */
  used?: number;
  /** Unix timestamp when rate limit resets. */
  resetAt?: number;
  /** Seconds to wait before retrying (from Retry-After header). */
  retryAfterSecs?: number;
}

/** Pagination links from Link header (RFC 8288). */
export interface PaginationLinks {
  /** URL for next page. */
  next?: string;
  /** URL for previous page. */
  prev?: string;
  /** URL for first page. */
  first?: string;
  /** URL for last page. */
  last?: string;
}

/** Result from get() or head() requests. */
export interface FetchResult {
  /** HTTP status code. */
  status?: number;
  /** Whether response is successful (2xx). */
  ok?: boolean;
  /** Content-Type media type. */
  contentType?: string;
  /** Content-Length if present. */
  contentLength?: number;
  /** Total response body size in bytes. */
  totalBytes?: number;
  /** X-Request-Id if returnXRequestId is enabled. */
  xRequestId?: string;
  /** Rate limit information. */
  rateLimit?: RateLimitInfo;
  /** Pagination links. */
  pagination?: PaginationLinks;
  /** Whether response was served from conditional cache. */
  cached?: boolean;
  /** Error message if request failed. */
  error?: string;
}

/** Result from read() calls. */
export interface ReadResult {
  /** Chunk of response body text. */
  data?: string;
  /** Whether this is the last chunk. */
  done?: boolean;
  /** Error message if read failed. */
  error?: string;
}

/** Result from fetchBinaryBatch(). */
export interface FetchBinaryBatchResult {
  /** The URL that was fetched. */
  url: string;
  /** Binary data if successful. */
  data?: Uint8Array;
  /** Error message if request failed. */
  error?: string;
}

/** Options for fetch requests. */
export interface FetchOptions {
  /** Request headers. */
  headers?: Record<string, string>;
}

/** Options for fetchBinaryBatch(). */
export interface FetchBinaryBatchOptions {
  /** Maximum retries on 429/503. */
  maxRetries?: number;
  /** Base delay for exponential backoff (ms). */
  baseDelayMs?: number;
}

/** The fetch host functions available to guest code. */
export interface FetchFunctions {
  /** Perform a GET request. Returns metadata, body retrieved via read(). */
  get(url: string, options?: FetchOptions): Promise<FetchResult>;
  /** Perform a HEAD request. Returns metadata only, no body. */
  head(url: string, options?: FetchOptions): Promise<FetchResult>;
  /** Read next chunk of response body. */
  read(url: string): Promise<ReadResult>;
  /** Read next chunk of binary response body. Returns Buffer → Uint8Array. */
  readBinary(url: string): Promise<Buffer>;
  /** Convenience: GET + parse JSON in one call. Throws on error. */
  fetchJSON(url: string, options?: FetchOptions): Promise<unknown>;
  /** Convenience: GET + read all text content in one call. Throws on error.
   * @param options.includeMeta - If true, returns {data, contentType, status} instead of just string */
  fetchText(
    url: string,
    options?: FetchOptions & { includeMeta?: boolean },
  ): Promise<string | { data: string; contentType: string; status: number }>;
  /** Convenience: GET + read all binary data in one call. Throws on error. */
  fetchBinary(url: string, options?: FetchOptions): Promise<Uint8Array>;
  /** Batch download multiple binary URLs with auto-retry. */
  fetchBinaryBatch(
    urls: string[],
    options?: FetchBinaryBatchOptions,
  ): Promise<FetchBinaryBatchResult[]>;
  /** Perform a POST request (if allowed). Returns metadata, body via read(). */
  post(
    url: string,
    body?: unknown,
    options?: FetchOptions,
  ): Promise<FetchResult>;
}

/** Return type of createHostFunctions. */
export interface FetchHostFunctions {
  fetch: FetchFunctions;
}

// ── Internal Types ───────────────────────────────────────────────────

interface ParsedDomainAllowlist {
  exact: Set<string>;
  wildcards: string[];
  errors: string[];
}

interface UrlValidationResult {
  valid: boolean;
  url?: URL;
  hostname?: string;
  error?: string;
}

interface RateLimitCheckResult {
  allowed: boolean;
  reason?: string;
}

interface RateLimiter {
  check(hostname: string): RateLimitCheckResult;
  recordRequest(hostname: string): void;
  recordResponseBytes(bytes: number): void;
  getCounters(): {
    requestsThisMinute: number;
    requestsTotal: number;
    uniqueDomains: number;
    bytesReceived: number;
  };
}

interface AuditLogger {
  log(entry: Record<string, unknown>): void;
}

interface HeaderBuildResult {
  headers: Record<string, string>;
  error?: string;
}

interface ConditionalValidators {
  etag?: string;
  lastModified?: string;
}

interface ConditionalCache {
  getValidators(url: string): ConditionalValidators | null;
  store(
    url: string,
    body: string,
    status: number,
    contentType: string,
    validators: ConditionalValidators,
  ): void;
  retrieve(
    url: string,
  ): { body: string; status: number; contentType: string } | null;
  remove(url: string): boolean;
  size(): number;
  clear(): void;
}

interface ResponseCacheEntry {
  url: string;
  body: string | Buffer;
  meta: ResponseMetadata;
  cursor: number;
  storedAt: number;
  timer: NodeJS.Timeout;
}

interface ResponseMetadata {
  contentType: string;
  contentLength?: number;
  status: number;
  ok: boolean;
}

interface ResponseCache {
  store(url: string, body: string | Buffer, meta: ResponseMetadata): void;
  read(url: string): { data: string; done: boolean } | null;
  readBinary(url: string): { data: Buffer; done: boolean } | null;
  evict(): void;
  has(url: string): boolean;
  meta(url: string): ResponseMetadata | null;
  stats(): {
    cached: boolean;
    url?: string;
    totalBytes?: number;
    cursor?: number;
    ageMs?: number;
  };
}

interface SecureFetchOptions {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: Buffer | null;
  connectTimeoutMs: number;
  readTimeoutMs: number;
  maxResponseBytes: number;
  allowedContentTypes: Set<string>;
  returnXRequestId: boolean;
  exactDomains: Set<string>;
  wildcardDomains: string[];
  signal?: AbortSignal;
}

interface SecureFetchResult {
  status?: number;
  body?: string | Buffer;
  ok?: boolean;
  contentType?: string;
  contentLength?: number;
  xRequestId?: string;
  rateLimit?: RateLimitInfo;
  pagination?: PaginationLinks;
  validators?: ConditionalValidators;
  headers?: Record<string, string>;
  error?: string;
}

interface SecureFetchSingleOptions extends Omit<
  SecureFetchOptions,
  "exactDomains" | "wildcardDomains"
> {
  returnXRequestId: boolean;
}

// ── Constants ────────────────────────────────────────────────────────

/** Minimum delay (ms) on ALL responses — collapses timing side-channels.
 *  A blocked domain and a successful fetch both take ≥ this long. */
const MIN_RESPONSE_DELAY_MS = 200;

/** Maximum number of HTTP redirects to follow. Each hop is
 *  re-validated against the domain allowlist and SSRF checks. */
const MAX_REDIRECTS = 5;

/** HTTP status codes that trigger redirect following. */
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

/** Safety margin for the outer belt-and-suspenders timeout (ms).
 *  The actual hard ceiling is derived from connectTimeoutMs + readTimeoutMs
 *  at registration time, so it always matches the configured limits. */
const SAFETY_MARGIN_MS = 5000;

/**
 * Default maximum audit log file size in bytes (10 MB).
 * Override via ~/.hyperagent/config.json:
 *   { "maxAuditLogSizeMb": 20 }
 * Zero or negative disables rotation entirely.
 */
const DEFAULT_MAX_AUDIT_LOG_SIZE_BYTES = 10 * 1024 * 1024;

/** Maximum header value length in bytes. */
const MAX_HEADER_VALUE_LENGTH = 4096;

/** Maximum URL total length. */
const MAX_URL_LENGTH = 2048;

/** Maximum path + query length within a URL. */
const MAX_PATH_QUERY_LENGTH = 1024;

/** Minimum wildcard domain depth — *.com, *.co.uk are rejected. */
const MIN_WILDCARD_PARENT_LABELS = 2;

/** File permissions for audit log — owner read/write only. */
const AUDIT_FILE_MODE = 0o600;

/** Headers the sandbox is NEVER allowed to set, regardless of allowlist.
 *  These are overridden or stripped by the host. */
const FORBIDDEN_HEADERS = new Set([
  "host",
  "cookie",
  "set-cookie",
  "user-agent",
  "x-forwarded-for",
  "x-real-ip",
  "via",
  "proxy-authorization",
  "proxy-connection",
  "transfer-encoding",
  "connection",
  "upgrade",
  "content-length",
]);

// ── IP Range Checking ────────────────────────────────────────────────
//
// Comprehensive private/reserved IP detection. Covers ALL ranges that
// should never be reached by a sandboxed fetch:
//
//   IPv4:
//     0.0.0.0/8        — "This network"
//     10.0.0.0/8       — RFC 1918 private
//     100.64.0.0/10    — RFC 6598 shared address (CGNAT)
//     127.0.0.0/8      — Loopback
//     169.254.0.0/16   — Link-local (includes cloud metadata 169.254.169.254)
//     172.16.0.0/12    — RFC 1918 private
//     192.0.0.0/24     — IETF protocol assignments
//     192.0.2.0/24     — TEST-NET-1 (documentation)
//     192.168.0.0/16   — RFC 1918 private
//     198.18.0.0/15    — Benchmarking
//     198.51.100.0/24  — TEST-NET-2 (documentation)
//     203.0.113.0/24   — TEST-NET-3 (documentation)
//     240.0.0.0/4      — Reserved (future use)
//     255.255.255.255  — Broadcast
//
//   IPv6:
//     ::/128           — Unspecified
//     ::1/128          — Loopback
//     fc00::/7         — Unique local (private)
//     fe80::/10        — Link-local
//     ::ffff:0:0/96    — IPv4-mapped (re-check embedded IPv4)
//     64:ff9b::/96     — NAT64 well-known (re-check embedded IPv4)
//
// Private IP / loopback detection for SSRF protection.

/**
 * Parse an IPv4 address string into a 32-bit unsigned integer.
 * Returns null if the string is not a valid IPv4 address.
 *
 * @param {string} ip — IPv4 address string (e.g. "192.168.1.1")
 * @returns {number | null} 32-bit unsigned integer or null
 */
function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let num = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    num = (num << 8) | octet;
  }
  // Convert to unsigned 32-bit
  return num >>> 0;
}

/**
 * Check if an IPv4 address (as unsigned 32-bit int) falls within a
 * CIDR range specified as (network, prefixLength).
 *
 * @param {number} ip — 32-bit unsigned int
 * @param {number} network — 32-bit unsigned int (network address)
 * @param {number} prefix — prefix length (0-32)
 * @returns {boolean}
 */
function ipv4InRange(ip: number, network: number, prefix: number): boolean {
  if (prefix === 0) return true;
  const mask = (~0 << (32 - prefix)) >>> 0;
  return (ip & mask) === (network & mask);
}

/** Private/reserved IPv4 CIDR ranges as [networkUint32, prefixLength]. */
const PRIVATE_IPV4_RANGES: Array<[number, number]> = [
  [ipv4ToNumber("0.0.0.0")!, 8], // "This network"
  [ipv4ToNumber("10.0.0.0")!, 8], // RFC 1918
  [ipv4ToNumber("100.64.0.0")!, 10], // RFC 6598 shared address (CGNAT)
  [ipv4ToNumber("127.0.0.0")!, 8], // Loopback
  [ipv4ToNumber("169.254.0.0")!, 16], // Link-local (cloud metadata!)
  [ipv4ToNumber("172.16.0.0")!, 12], // RFC 1918
  [ipv4ToNumber("192.0.0.0")!, 24], // IETF protocol assignments
  [ipv4ToNumber("192.0.2.0")!, 24], // TEST-NET-1
  [ipv4ToNumber("192.168.0.0")!, 16], // RFC 1918
  [ipv4ToNumber("198.18.0.0")!, 15], // Benchmarking
  [ipv4ToNumber("198.51.100.0")!, 24], // TEST-NET-2
  [ipv4ToNumber("203.0.113.0")!, 24], // TEST-NET-3
  [ipv4ToNumber("240.0.0.0")!, 4], // Reserved
];

/** Broadcast address — special case (single IP). */
const BROADCAST_IPV4 = ipv4ToNumber("255.255.255.255");

/**
 * Check whether an IPv4 address string is in a private/reserved range.
 *
 * @param {string} ip — IPv4 address string
 * @returns {boolean} true if private/reserved
 */
function isPrivateIPv4(ip: string): boolean {
  const num = ipv4ToNumber(ip);
  if (num === null) return true; // Unparseable = block
  if (num === BROADCAST_IPV4) return true;
  for (const [network, prefix] of PRIVATE_IPV4_RANGES) {
    if (ipv4InRange(num, network, prefix)) return true;
  }
  return false;
}

/**
 * Parse an IPv6 address into 8 × 16-bit groups.
 * Handles :: expansion. Returns null on invalid input.
 *
 * @param {string} ip — IPv6 address string
 * @returns {number[] | null} Array of 8 uint16 groups, or null
 */
function ipv6ToGroups(ip: string): number[] | null {
  // Strip zone ID (%eth0 etc.)
  const zoneIdx = ip.indexOf("%");
  const clean = zoneIdx >= 0 ? ip.slice(0, zoneIdx) : ip;

  // Handle mixed IPv4-in-IPv6 notation: ::ffff:192.168.1.1
  // Node.js socket.remoteAddress can return this form on dual-stack sockets.
  // Without this, parseInt('192.168.1.1', 16) silently truncates at the
  // first dot, yielding wrong groups and bypassing the SSRF check (F-01).
  const mixedMatch = clean.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mixedMatch) {
    const ipv4Num = ipv4ToNumber(mixedMatch[2]);
    if (ipv4Num === null) return null;
    const hi = (ipv4Num >>> 16) & 0xffff;
    const lo = ipv4Num & 0xffff;
    const hexTail = `${hi.toString(16)}:${lo.toString(16)}`;
    return ipv6ToGroups(mixedMatch[1] + hexTail);
  }

  const halves = clean.split("::");
  if (halves.length > 2) return null; // Multiple :: not valid

  const parseHalf = (h: string): number[] =>
    h === "" ? [] : h.split(":").map((s) => parseInt(s, 16));

  if (halves.length === 2) {
    const left = parseHalf(halves[0]);
    const right = parseHalf(halves[1]);
    const fill = 8 - left.length - right.length;
    if (fill < 0) return null;
    const groups = [...left, ...Array(fill).fill(0), ...right];
    if (groups.length !== 8) return null;
    if (groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff))
      return null;
    return groups;
  }

  const groups = parseHalf(halves[0]);
  if (groups.length !== 8) return null;
  if (groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff))
    return null;
  return groups;
}

/**
 * Convert two 16-bit groups into a dotted-quad IPv4 string.
 * Shared by the IPv4-mapped and NAT64 extraction paths (P-13).
 *
 * @param {number} hi — High 16 bits (groups[6])
 * @param {number} lo — Low 16 bits (groups[7])
 * @returns {string} Dotted-quad IPv4 string
 */
function groupsToIPv4(hi: number, lo: number): string {
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

/**
 * Extract the embedded IPv4 address from an IPv4-mapped or NAT64 IPv6
 * address. Returns the IPv4 string or null if not applicable.
 *
 * IPv4-mapped: ::ffff:A.B.C.D  → groups [0,0,0,0,0,0xffff, hi, lo]
 * NAT64:       64:ff9b::A.B.C.D → groups [0x64, 0xff9b, 0,0,0,0, hi, lo]
 *
 * @param {number[]} groups — 8 × uint16 groups
 * @returns {string | null} Embedded IPv4 string or null
 */
function extractEmbeddedIPv4(groups: number[]): string | null {
  // IPv4-mapped: ::ffff:x:y
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff
  ) {
    return groupsToIPv4(groups[6], groups[7]);
  }

  // NAT64 well-known prefix: 64:ff9b::x:y
  if (
    groups[0] === 0x0064 &&
    groups[1] === 0xff9b &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0
  ) {
    return groupsToIPv4(groups[6], groups[7]);
  }

  return null;
}

/**
 * Check whether an IPv6 address string is in a private/reserved range.
 * Also handles IPv4-mapped/NAT64 by extracting and re-checking the
 * embedded IPv4 address.
 *
 * @param {string} ip — IPv6 address string
 * @returns {boolean} true if private/reserved
 */
function isPrivateIPv6(ip: string): boolean {
  const groups = ipv6ToGroups(ip);
  if (!groups) return true; // Unparseable = block

  // Check for embedded IPv4 (::ffff:x:y or 64:ff9b::x:y)
  const embedded = extractEmbeddedIPv4(groups);
  if (embedded) return isPrivateIPv4(embedded);

  // Unspecified :: (all zeros)
  if (groups.every((g) => g === 0)) return true;

  // Loopback ::1
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0 &&
    groups[6] === 0 &&
    groups[7] === 1
  )
    return true;

  // fc00::/7 — unique local address
  if ((groups[0] & 0xfe00) === 0xfc00) return true;

  // fe80::/10 — link-local
  if ((groups[0] & 0xffc0) === 0xfe80) return true;

  // 2002::/16 — 6to4 relay (embeds arbitrary IPv4 in bits 16-47)
  // Attacker controls the embedded IPv4 → must block (F-05).
  if (groups[0] === 0x2002) return true;

  // 2001:0000::/32 — Teredo tunnelling (encapsulates IPv4 in last 32 bits)
  if (groups[0] === 0x2001 && groups[1] === 0x0000) return true;

  return false;
}

/**
 * Check whether an IP address (v4 or v6) is private/reserved.
 * Returns true if the address should be BLOCKED.
 *
 * @param {string} ip — IP address string
 * @returns {boolean} true if private/reserved
 */
function isPrivateIp(ip: string): boolean {
  if (!ip || typeof ip !== "string") return true;

  // Classify and dispatch
  if (isIPv4(ip)) return isPrivateIPv4(ip);
  if (isIPv6(ip)) return isPrivateIPv6(ip);

  // Not a valid IP at all — block
  return true;
}

// ── URL Validation ───────────────────────────────────────────────────
//
// Six-stage pipeline:
//   1. Parse — new URL(raw), reject on failure
//   2. Scheme — must be exactly "https:"
//   3. Structure — no credentials, no fragments, length limits, no control chars
//   4. Hostname — valid FQDN (≥2 labels), not an IP literal, domain allowlist
//   5. Path normalisation — reject ".." segments, single decode pass
//   6. URL reconstruction — host builds final URL from parsed components

/** Control character regex (C0 + C1 ranges). */
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f-\x9f]/;

/**
 * Parse a domain allowlist from the configuration array.
 * Returns { exact: Set<string>, wildcards: string[] } where wildcards
 * are stored as the parent domain (e.g. "*.example.com" → "example.com").
 *
 * Validation rules:
 *   - Entries are lowercased and trimmed
 *   - Empty entries are skipped
 *   - Global wildcards ("*") are rejected
 *   - Wildcards must have ≥ 2 parent labels (rejects *.com, *.co.uk)
 *   - Only single leading wildcard allowed (*.example.com, not *.*.com)
 *   - Non-wildcard entries must not contain *
 *
 * @param {string[]} domains — Raw domain list from config
 * @returns {{ exact: Set<string>, wildcards: string[], errors: string[] }}
 */
function parseDomainAllowlist(domains: string[]): ParsedDomainAllowlist {
  const exact = new Set<string>();
  const wildcards: string[] = [];
  const errors: string[] = [];

  if (!Array.isArray(domains)) return { exact, wildcards, errors };

  for (const raw of domains) {
    if (typeof raw !== "string") continue;
    const domain = raw.trim().toLowerCase();
    if (domain === "") continue;

    // Reject bare wildcard
    if (domain === "*") {
      errors.push('Global wildcard "*" is not permitted');
      continue;
    }

    if (domain.startsWith("*.")) {
      const parent = domain.slice(2);
      // Reject multi-wildcards: *.*.example.com
      if (parent.includes("*")) {
        errors.push(`Multi-level wildcard "${raw}" is not permitted`);
        continue;
      }
      // Reject shallow wildcards: *.com, *.co.uk need ≥2 labels
      const parentLabels = parent.split(".");
      if (parentLabels.length < MIN_WILDCARD_PARENT_LABELS) {
        errors.push(
          `Wildcard "${raw}" is too broad — parent must have ≥${MIN_WILDCARD_PARENT_LABELS} labels`,
        );
        continue;
      }
      // Validate parent labels
      if (parentLabels.some((l) => l === "" || CONTROL_CHAR_RE.test(l))) {
        errors.push(`Invalid wildcard domain "${raw}"`);
        continue;
      }
      wildcards.push(parent);
    } else {
      // Reject wildcards in the middle: api.*.com
      if (domain.includes("*")) {
        errors.push(
          `Wildcard in non-prefix position "${raw}" is not permitted`,
        );
        continue;
      }
      // Validate labels
      const labels = domain.split(".");
      if (labels.some((l) => l === "" || CONTROL_CHAR_RE.test(l))) {
        errors.push(`Invalid domain "${raw}"`);
        continue;
      }
      exact.add(domain);
    }
  }

  return { exact, wildcards, errors };
}

/**
 * Check whether a hostname matches the domain allowlist.
 * Hostname must be pre-lowercased.
 *
 * @param {string} hostname — Lowercased hostname
 * @param {Set<string>} exact — Exact match set
 * @param {string[]} wildcards — Wildcard parent domains
 * @returns {boolean} true if allowed
 */
function isDomainAllowed(
  hostname: string,
  exact: Set<string>,
  wildcards: string[],
): boolean {
  if (exact.has(hostname)) return true;

  // Auto-allow subdomains of exact-match domains.
  // If "openai.com" is allowed, "developers.openai.com" is also allowed.
  // This prevents the LLM from wasting turns adding redirect domains.
  for (const domain of exact) {
    const suffix = "." + domain;
    if (hostname.endsWith(suffix)) return true;
  }

  // Single-level wildcard: *.example.com matches api.example.com
  // but NOT a.b.example.com
  for (const parent of wildcards) {
    const suffix = "." + parent;
    if (hostname.endsWith(suffix)) {
      // Ensure it's single-level: the part before the suffix must not contain dots
      const prefix = hostname.slice(0, hostname.length - suffix.length);
      if (prefix.length > 0 && !prefix.includes(".")) return true;
    }
  }

  return false;
}

/**
 * Validate a URL from the sandbox. Returns a validated URL object
 * or an error string.
 *
 * @param {string} rawUrl — Raw URL string from the sandbox
 * @param {Set<string>} exactDomains — Allowed exact domains
 * @param {string[]} wildcardDomains — Allowed wildcard parent domains
 * @returns {{ valid: boolean, url?: URL, hostname?: string, error?: string }}
 */
function validateUrl(
  rawUrl: string,
  exactDomains: Set<string>,
  wildcardDomains: string[],
): UrlValidationResult {
  // Stage 1: Parse
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    return { valid: false, error: "fetch blocked: invalid URL" };
  }
  if (rawUrl.length > MAX_URL_LENGTH) {
    return {
      valid: false,
      error: `fetch blocked: URL too long (${rawUrl.length} > ${MAX_URL_LENGTH} chars). Split into multiple requests.`,
    };
  }
  // Reject control characters BEFORE parsing — prevents smuggling
  if (CONTROL_CHAR_RE.test(rawUrl)) {
    return { valid: false, error: "fetch blocked: invalid URL characters" };
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { valid: false, error: "fetch blocked: invalid URL" };
  }

  // Stage 2: Scheme — HTTPS only
  if (parsed.protocol !== "https:") {
    return { valid: false, error: "fetch blocked: only HTTPS is permitted" };
  }

  // Stage 3: Structure
  // No credentials in URL
  if (parsed.username || parsed.password) {
    return {
      valid: false,
      error: "fetch blocked: credentials in URL not permitted",
    };
  }
  // Path + query length
  const pathQuery = parsed.pathname + (parsed.search || "");
  if (pathQuery.length > MAX_PATH_QUERY_LENGTH) {
    return {
      valid: false,
      error: `fetch blocked: path+query too long (${pathQuery.length} > ${MAX_PATH_QUERY_LENGTH} chars). Split into multiple requests or reduce query string size.`,
    };
  }
  // Reject ".." in path segments after normalisation
  const segments = parsed.pathname.split("/");
  if (segments.some((s) => s === ".." || s === ".")) {
    return {
      valid: false,
      error: "fetch blocked: path traversal not permitted",
    };
  }

  // Stage 4: Hostname
  const hostname = parsed.hostname.toLowerCase();
  // Must be a valid FQDN — at least 2 labels
  const hostLabels = hostname.split(".");
  if (hostLabels.length < 2 || hostLabels.some((l) => l === "")) {
    return { valid: false, error: "fetch blocked: invalid hostname" };
  }
  // Reject IP literals (both [::1] and 127.0.0.1)
  if (
    isIP(hostname) !== 0 ||
    (hostname.startsWith("[") && hostname.endsWith("]"))
  ) {
    return {
      valid: false,
      error: "fetch blocked: IP addresses not permitted, use domain names",
    };
  }

  // Stage 5: Port — only default 443 allowed. Non-standard ports
  // could target internal services on unusual ports (F-02).
  if (parsed.port && parsed.port !== "443") {
    return {
      valid: false,
      error: "fetch blocked: non-standard port not permitted",
    };
  }

  // Domain allowlist check
  if (!isDomainAllowed(hostname, exactDomains, wildcardDomains)) {
    return { valid: false, error: "fetch blocked: domain not in allowlist" };
  }

  // Stage 6: Reconstruct a clean URL from parsed components.
  // Strip fragments, ensure no smuggling via raw string pass-through.
  // The host uses this URL, NEVER the raw sandbox string.
  const cleanUrl = new URL(
    `https://${hostname}${parsed.pathname}${parsed.search || ""}`,
  );

  return { valid: true, url: cleanUrl, hostname };
}

// ── Rate Limiter ─────────────────────────────────────────────────────
//
// Per-session rate limiting with sliding windows. Dropped per-execution
// limits per Porthos's recommendation — session + sliding windows are
// sufficient and have clear lifecycle semantics.

/**
 * Create a session-scoped rate limiter.
 *
 * @param {object} config — Rate limit config
 * @param {number} config.maxPerMinute — Max requests per 60s sliding window
 * @param {number} config.maxPerHour — Max requests per hour (session)
 * @param {number} config.maxDomains — Max unique domains
 * @param {number} config.maxDataReceivedBytes — Max total response bytes
 * @returns {Readonly<{
 *   check: (hostname: string) => { allowed: boolean, reason?: string },
 *   recordRequest: (hostname: string) => void,
 *   recordResponseBytes: (bytes: number) => void,
 *   getCounters: () => { requestsThisMinute: number, requestsTotal: number, uniqueDomains: number, bytesReceived: number },
 * }>} Rate limiter API
 */
function createRateLimiter(config: {
  maxPerMinute: number;
  maxPerHour: number;
  maxDomains: number;
  maxDataReceivedBytes: number;
}): Readonly<RateLimiter> {
  /** Timestamps of all requests in the current session. */
  const timestamps: number[] = [];

  /** Total requests in the session. */
  let totalRequests = 0;

  /** Unique domains contacted. */
  const domains = new Set<string>();

  /** Total response bytes received. */
  let totalBytesReceived = 0;

  /**
   * Check if a request is allowed. Does NOT increment counters —
   * call recordRequest() after a successful check.
   *
   * @param {string} hostname — Target hostname
   * @returns {{ allowed: boolean, reason?: string }}
   */
  function check(hostname: string): RateLimitCheckResult {
    const now = Date.now();

    // Prune stale timestamps — only keep those within the sliding
    // window.  Without this the array grows unbounded for long-lived
    // sessions that make many requests (F-07/P-04/R-05).
    const oneMinuteAgo = now - 60_000;
    while (timestamps.length > 0 && timestamps[0] <= oneMinuteAgo) {
      timestamps.shift();
    }

    // Per-minute sliding window
    if (timestamps.length >= config.maxPerMinute) {
      return {
        allowed: false,
        reason: "fetch blocked: rate limit exceeded (per-minute)",
      };
    }

    // Per-hour total
    if (totalRequests >= config.maxPerHour) {
      return {
        allowed: false,
        reason: "fetch blocked: rate limit exceeded (per-hour)",
      };
    }

    // Domain count
    if (!domains.has(hostname) && domains.size >= config.maxDomains) {
      return {
        allowed: false,
        reason: "fetch blocked: too many unique domains",
      };
    }

    // Data budget
    if (totalBytesReceived >= config.maxDataReceivedBytes) {
      return { allowed: false, reason: "fetch blocked: data budget exhausted" };
    }

    return { allowed: true };
  }

  /**
   * Record a request (call AFTER the check passes and request is about
   * to be issued). This is the "increment" part of check-and-increment.
   * Single-threaded Node.js makes this pattern safe — no interleaving
   * between check() and recordRequest().
   *
   * @param {string} hostname — Target hostname
   */
  function recordRequest(hostname: string): void {
    timestamps.push(Date.now());
    totalRequests++;
    domains.add(hostname);
  }

  /**
   * Record response bytes received.
   *
   * @param {number} bytes — Response body size in bytes
   */
  function recordResponseBytes(bytes: number): void {
    totalBytesReceived += bytes;
  }

  /** Get current counters (for diagnostics). */
  function getCounters() {
    const now = Date.now();
    const oneMinuteAgo = now - 60_000;
    return {
      requestsThisMinute: timestamps.filter((t) => t >= oneMinuteAgo).length,
      requestsTotal: totalRequests,
      uniqueDomains: domains.size,
      bytesReceived: totalBytesReceived,
    };
  }

  return Object.freeze({
    check,
    recordRequest,
    recordResponseBytes,
    getCounters,
  });
}

// ── Audit Logger ─────────────────────────────────────────────────────
//
// JSONL audit log to ~/.hyperagent/fetch-log.jsonl
// Rotates when the file exceeds a configurable size limit (default 10 MB,
// override via ~/.hyperagent/config.json  maxAuditLogSizeMb).
// File permissions: 0600 (owner read/write only).
//
// Logs hostname only (not full URL) — query params may contain secrets.

/** How many writes between rotation checks (avoids statSync on every write). */
const ROTATION_CHECK_INTERVAL = 50;

/**
 * Read the operator's maxAuditLogSizeMb from the global config file.
 * Returns the value in bytes.  Falls back to DEFAULT_MAX_AUDIT_LOG_SIZE_BYTES
 * if the file is missing, unparseable, or the field is absent/invalid.
 *
 * @returns {number} Maximum log size in bytes (0 = rotation disabled)
 */
function loadMaxAuditLogSizeBytes(): number {
  try {
    const configPath = join(homedir(), ".hyperagent", "config.json");
    if (!existsSync(configPath)) return DEFAULT_MAX_AUDIT_LOG_SIZE_BYTES;
    const raw = JSON.parse(readFileSync(configPath, "utf8"));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return DEFAULT_MAX_AUDIT_LOG_SIZE_BYTES;
    }
    const mb = raw.maxAuditLogSizeMb;
    if (!Number.isFinite(mb) || mb < 0) return DEFAULT_MAX_AUDIT_LOG_SIZE_BYTES;
    // 0 is valid — means rotation disabled
    return Math.floor(mb * 1024 * 1024);
  } catch {
    return DEFAULT_MAX_AUDIT_LOG_SIZE_BYTES;
  }
}

/**
 * Create an audit logger instance.
 *
 * @param {string} sessionId — Unique session identifier
 * @returns {Readonly<{ log: (entry: object) => void }>} Logger API with a single `log(entry)` method
 */
function createAuditLogger(sessionId: string): Readonly<AuditLogger> {
  const configDir = join(homedir(), ".hyperagent");
  const logPath = join(configDir, "fetch-log.jsonl");
  let writesSinceRotationCheck = 0;

  // Read the size limit once at creation time.
  const maxLogSizeBytes = loadMaxAuditLogSizeBytes();

  // Ensure directory exists
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }

  /**
   * Append a log entry. Best-effort — audit failures don't block requests.
   *
   * @param {object} entry — Log entry fields
   */
  function log(entry: Record<string, unknown>): void {
    try {
      const record = {
        ...entry,
        ts: new Date().toISOString(),
        session_id: sessionId,
      };
      appendFileSync(logPath, JSON.stringify(record) + "\n", {
        mode: AUDIT_FILE_MODE,
      });

      // Throttle rotation checks — only check every N writes.
      // Sync I/O on every append is acceptable (best-effort audit),
      // but statSync + readSync for rotation is expensive (P-06).
      writesSinceRotationCheck++;
      if (writesSinceRotationCheck >= ROTATION_CHECK_INTERVAL) {
        writesSinceRotationCheck = 0;
        maybeRotate();
      }
    } catch (err: unknown) {
      // Best-effort — audit failures should never block the request,
      // but operators need to know audit records are being dropped.
      console.error(
        `[fetch] Audit log write failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * Rotate the log if it exceeds the configured size limit.
   * Truncates to the newest half by reading only the tail portion
   * rather than the entire file (avoids loading unbounded data into
   * memory on a hot guest-request path).
   *
   * Size limit: operator-configurable via config.json maxAuditLogSizeMb
   * (default 10 MB).  Set to 0 to disable rotation entirely.
   */
  function maybeRotate(): void {
    try {
      // Rotation disabled by operator config.
      if (maxLogSizeBytes <= 0) return;

      if (!existsSync(logPath)) return;
      const stat = statSync(logPath);
      if (stat.size < maxLogSizeBytes) return;

      // Read only the newest half of the file (tail bytes).
      // Worst case we keep slightly more than half, but we
      // never load the entire file for multi-MB logs.
      // Uses the statically imported openSync/readSync/closeSync
      // rather than dynamic require() (audit finding: static
      // analysis visibility).
      const tailBytes = Math.floor(stat.size / 2);
      const buf = Buffer.alloc(tailBytes);
      const fd = openSync(logPath, "r");
      try {
        readSync(fd, buf, 0, tailBytes, stat.size - tailBytes);
      } finally {
        closeSync(fd);
      }
      const tail = buf.toString("utf8");
      // Drop partial first line (we likely landed mid-entry)
      const firstNewline = tail.indexOf("\n");
      const clean = firstNewline >= 0 ? tail.slice(firstNewline + 1) : tail;
      if (clean.trim().length > 0) {
        writeFileSync(logPath, clean, { mode: AUDIT_FILE_MODE });
      }
    } catch (err: unknown) {
      // Rotation failure is non-fatal, but operators should know.
      console.error(
        `[fetch] Audit log rotation failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  return Object.freeze({ log });
}

// ── Header Validation ────────────────────────────────────────────────

/** CRLF and NUL characters — these enable header injection attacks. */
const HEADER_INJECTION_RE = /[\r\n\x00]/;

/**
 * Build sanitised request headers from sandbox-provided headers.
 * Applies the allowlist, strips forbidden headers, validates values.
 *
 * @param {object} sandboxHeaders — Raw headers from the sandbox
 * @param {Set<string>} allowedHeaderNames — Lowercased allowed names
 * @param {string} userAgent — Static User-Agent from config
 * @returns {{ headers: Record<string, string>, error?: string }}
 */
function buildRequestHeaders(
  sandboxHeaders: unknown,
  allowedHeaderNames: Set<string>,
  userAgent: string,
): HeaderBuildResult {
  const headers: Record<string, string> = {
    "User-Agent": userAgent,
    "Accept-Encoding": "identity", // No compression — we need to measure body size
  };

  if (!sandboxHeaders || typeof sandboxHeaders !== "object") {
    return { headers };
  }

  for (const [name, value] of Object.entries(sandboxHeaders)) {
    if (typeof name !== "string" || typeof value !== "string") continue;

    const lowerName = name.toLowerCase();

    // Skip forbidden headers
    if (FORBIDDEN_HEADERS.has(lowerName)) continue;

    // Must be in the allowlist
    if (!allowedHeaderNames.has(lowerName)) continue;

    // Validate value — reject header injection
    if (HEADER_INJECTION_RE.test(value)) {
      return { headers: {}, error: "fetch blocked: invalid header value" };
    }

    // Length limit
    if (Buffer.byteLength(value, "utf8") > MAX_HEADER_VALUE_LENGTH) {
      return { headers: {}, error: "fetch blocked: header value too large" };
    }

    headers[name] = value;
  }

  return { headers };
}

// ── Response Header Extraction ───────────────────────────────────────
//
// Extract structured metadata from response headers so the guest/LLM
// can make informed decisions about rate limiting and pagination.
// All values are validated and capped on the host side — the guest
// never sees raw headers.
//

/** Maximum reasonable value for retryAfterSecs (1 hour). */
const MAX_RETRY_AFTER_SECS = 3600;

/** Maximum reasonable Unix timestamp (~year 2100). */
const MAX_RESET_EPOCH = 4_102_444_800;

/**
 * Extract rate-limit headers from an HTTP response.
 *
 * Supports both the de facto standard (`X-RateLimit-*`) and the
 * IETF draft standard (`RateLimit-*`, no X- prefix). If both are
 * present the `X-` variant wins (more widely deployed).
 *
 * Also parses `Retry-After` (RFC 7231) on 429/503 responses.
 *
 * Returns null if no rate-limit headers are detected.
 *
 * @param {import('http').IncomingMessage} res — The HTTP response
 * @param {number} status — The HTTP status code
 * @returns {{ limit?: number, remaining?: number, used?: number, resetAt?: number, retryAfterSecs?: number } | null} Sanitised rate-limit info or null
 */
function extractRateLimitInfo(
  res: import("http").IncomingMessage,
  status: number,
): RateLimitInfo | null {
  const h = res.headers;

  // Parse an integer header, preferring X- variant over draft variant.
  // Returns undefined if neither is present or values are invalid.
  const intHeader = (xName: string, draftName: string): number | undefined => {
    const raw = h[xName] ?? h[draftName];
    if (raw === undefined) return undefined;
    const n = parseInt(String(raw), 10);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };

  const limit = intHeader("x-ratelimit-limit", "ratelimit-limit");
  const remaining = intHeader("x-ratelimit-remaining", "ratelimit-remaining");
  const used = intHeader("x-ratelimit-used", "ratelimit-used");

  // Reset timestamp — cap at a reasonable future date to guard
  // against absurd values from untrusted servers.
  let resetAt = intHeader("x-ratelimit-reset", "ratelimit-reset");
  if (resetAt !== undefined) {
    const now = Math.floor(Date.now() / 1000);
    if (resetAt < now - 86400 || resetAt > MAX_RESET_EPOCH) {
      resetAt = undefined; // Discard unreasonable values
    }
  }

  // Retry-After (RFC 7231) — only meaningful on 429/503.
  // Can be seconds (integer) or an HTTP-date; we normalise to seconds.
  let retryAfterSecs;
  if (status === 429 || status === 503) {
    const raw = h["retry-after"];
    if (typeof raw === "string") {
      const parsed = parseInt(raw, 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        retryAfterSecs = Math.min(parsed, MAX_RETRY_AFTER_SECS);
      } else {
        // Try parsing as HTTP-date (e.g. "Mon, 03 Mar 2026 12:00:00 GMT")
        const date = new Date(raw);
        if (!isNaN(date.getTime())) {
          const diffSecs = Math.ceil((date.getTime() - Date.now()) / 1000);
          if (diffSecs > 0) {
            retryAfterSecs = Math.min(diffSecs, MAX_RETRY_AFTER_SECS);
          }
        }
      }
    }
  }

  // Only return rateLimit if we found at least one useful field.
  if (
    limit === undefined &&
    remaining === undefined &&
    used === undefined &&
    resetAt === undefined &&
    retryAfterSecs === undefined
  ) {
    return null;
  }

  const info: RateLimitInfo = {};
  if (limit !== undefined) info.limit = limit;
  if (remaining !== undefined) info.remaining = remaining;
  if (used !== undefined) info.used = used;
  if (resetAt !== undefined) info.resetAt = resetAt;
  if (retryAfterSecs !== undefined) info.retryAfterSecs = retryAfterSecs;
  return info;
}

/**
 * Extract pagination links from the Link header (RFC 8288).
 *
 * Parses `rel="next"`, `rel="prev"`, `rel="first"`, `rel="last"`
 * links. Returns null if no Link header or no recognised rels.
 *
 * Only HTTPS URLs are included — any HTTP links are silently dropped
 * (consistent with the plugin's HTTPS-only policy).
 *
 * @param {import('http').IncomingMessage} res — The HTTP response
 * @returns {{ next?: string, prev?: string, first?: string, last?: string } | null} Pagination info or null
 */
function extractPaginationLinks(
  res: import("http").IncomingMessage,
): PaginationLinks | null {
  const linkHeader = res.headers["link"];
  if (typeof linkHeader !== "string") return null;

  // Parse RFC 8288 Link header format:
  // <https://api.github.com/repos?page=2>; rel="next", <...>; rel="last"
  const LINK_RE = /<([^>]+)>\s*;\s*rel="(next|prev|first|last)"/gi;
  const links: Record<string, string> = {};
  let match;
  while ((match = LINK_RE.exec(linkHeader)) !== null) {
    const url = match[1];
    const rel = match[2].toLowerCase();
    // Only include HTTPS URLs (security: no HTTP downgrade)
    if (url.startsWith("https://")) {
      links[rel] = url;
    }
  }

  return Object.keys(links).length > 0 ? (links as PaginationLinks) : null;
}

// ── Conditional Request Cache ────────────────────────────────────────
//
// Transparent ETag / Last-Modified cache for GET responses. When a
// server returns an ETag or Last-Modified header, we store the
// response alongside the validators. On the next GET to the same URL,
// we inject If-None-Match / If-Modified-Since headers. If the server
// responds 304 Not Modified, we serve the cached body — saving
// bandwidth, time, and (crucially) server-side rate-limit budget.
//
// Design constraints:
//   - GET only — POST is not safe/idempotent, never cached.
//   - Bounded: max N entries with LRU eviction.
//   - TTL: entries expire after a configurable duration.
//   - URL-exact: no normalisation — cache keys are the raw URL strings.
//   - Transparent: guest code never knows about conditional requests.
//   - 304 responses do NOT count toward the data budget (no new data).
//   - All SSRF/domain/HTTPS checks still apply (the cache only stores
//     the body — the HTTP request itself is still fully validated).

/** Maximum ETag header length we'll store. Anything longer is ignored. */
const MAX_ETAG_LENGTH = 512;

/** Maximum Last-Modified header length. RFC 7232 dates are ~29 chars. */
const MAX_LAST_MODIFIED_LENGTH = 64;

/**
 * Extract ETag and Last-Modified validators from a response.
 *
 * Returns an object with `etag` and/or `lastModified` fields, or null
 * if neither is present. Values are validated for length and format.
 *
 * @param {{ headers: Record<string, string|string[]> }} res — Node.js HTTP response
 * @returns {{ etag?: string, lastModified?: string } | null}
 */
function extractConditionalValidators(res: {
  headers: Record<string, string | string[] | undefined>;
}): ConditionalValidators | null {
  const rawEtag = res.headers["etag"];
  const rawLastMod = res.headers["last-modified"];

  let etag: string | null = null;
  let lastModified: string | null = null;

  // ETag: must be a quoted string (W/"..." or "...").
  // RFC 7232 §2.3: etag = [ weak ] opaque-tag
  if (
    typeof rawEtag === "string" &&
    rawEtag.length > 0 &&
    rawEtag.length <= MAX_ETAG_LENGTH
  ) {
    // Accept both strong ("...") and weak (W/"...") ETags.
    // Reject bare values without quotes — they're non-compliant
    // and could be spoofed into header injection.
    if (/^(W\/)?"[^"]*"$/.test(rawEtag)) {
      etag = rawEtag;
    }
  }

  // Last-Modified: must be a valid HTTP date.
  // RFC 7232 §2.2 says it's an HTTP-date (RFC 7231 §7.1.1.1).
  // We validate by parsing — Date.parse returns NaN for garbage.
  if (
    typeof rawLastMod === "string" &&
    rawLastMod.length > 0 &&
    rawLastMod.length <= MAX_LAST_MODIFIED_LENGTH
  ) {
    const parsed = Date.parse(rawLastMod);
    if (Number.isFinite(parsed) && parsed > 0) {
      lastModified = rawLastMod;
    }
  }

  if (!etag && !lastModified) return null;
  const result: ConditionalValidators = {};
  if (etag) result.etag = etag;
  if (lastModified) result.lastModified = lastModified;
  return result;
}

/**
 * Create a bounded conditional-request cache with LRU eviction and TTL.
 *
 * The cache stores response bodies alongside their ETag/Last-Modified
 * validators. Before a GET request, the caller checks for a cached
 * entry and adds conditional headers. After a 304 response, the cached
 * body is served instead.
 *
 * @param {number} maxEntries — Maximum number of URL entries to cache
 * @param {number} ttlMs — Time-to-live per entry in milliseconds
 * @returns {{
 *   getValidators: (url: string) => { etag?: string, lastModified?: string } | null,
 *   store: (url: string, body: string, status: number, contentType: string, validators: object) => void,
 *   retrieve: (url: string) => { body: string, status: number, contentType: string } | null,
 *   remove: (url: string) => boolean,
 *   size: () => number,
 *   clear: () => void,
 * }}
 */
function createConditionalCache(
  maxEntries: number,
  ttlMs: number,
): ConditionalCache {
  // Map preserves insertion order — we use this for LRU eviction.
  // Accessing an entry moves it to the end (delete + re-insert).
  const cache = new Map();

  /**
   * Touch an entry — move it to the end of the Map (most recently used).
   * @param {string} url
   * @param {object} entry
   */
  function touch(url: string, entry: unknown): void {
    cache.delete(url);
    cache.set(url, entry);
  }

  /**
   * Evict the least-recently-used entry (first in Map iteration order).
   */
  function evictLRU(): void {
    if (cache.size === 0) return;
    const oldestKey = cache.keys().next().value;
    const oldest = cache.get(oldestKey);
    if (oldest && oldest.timer) clearTimeout(oldest.timer);
    cache.delete(oldestKey);
  }

  /**
   * Get conditional request validators for a URL (if cached).
   *
   * @param {string} url — The URL to look up
   * @returns {{ etag?: string, lastModified?: string } | null}
   */
  function getValidators(url: string): ConditionalValidators | null {
    const entry = cache.get(url);
    if (!entry) return null;

    // Check TTL (belt-and-suspenders — timer should have evicted,
    // but check in case the timer fires late)
    if (Date.now() - entry.storedAt > ttlMs) {
      if (entry.timer) clearTimeout(entry.timer);
      cache.delete(url);
      return null;
    }

    // Build validators object
    const validators: ConditionalValidators = {};
    if (entry.etag) validators.etag = entry.etag;
    if (entry.lastModified) validators.lastModified = entry.lastModified;

    // Move to end (most recently used)
    touch(url, entry);

    return Object.keys(validators).length > 0 ? validators : null;
  }

  /**
   * Store a response body and its validators in the cache.
   *
   * @param {string} url — The URL this response belongs to
   * @param {string} body — Full response body text
   * @param {number} status — HTTP status code (original, not 304)
   * @param {string} contentType — Response Content-Type (media type only)
   * @param {{ etag?: string, lastModified?: string }} validators
   */
  function store(
    url: string,
    body: string,
    status: number,
    contentType: string,
    validators: ConditionalValidators,
  ): void {
    // Remove existing entry (if any) to reset timer
    const existing = cache.get(url);
    if (existing && existing.timer) clearTimeout(existing.timer);
    cache.delete(url);

    // Evict LRU if at capacity
    while (cache.size >= maxEntries) {
      evictLRU();
    }

    // Create TTL timer
    const timer = setTimeout(() => cache.delete(url), ttlMs);
    if (timer.unref) timer.unref();

    cache.set(url, {
      body,
      status,
      contentType,
      etag: validators.etag || null,
      lastModified: validators.lastModified || null,
      storedAt: Date.now(),
      timer,
    });
  }

  /**
   * Retrieve a cached response body (for 304 handling).
   *
   * @param {string} url — The URL to retrieve
   * @returns {{ body: string, status: number, contentType: string } | null}
   */
  function retrieve(url: string) {
    const entry = cache.get(url);
    if (!entry) return null;

    // Check TTL
    if (Date.now() - entry.storedAt > ttlMs) {
      if (entry.timer) clearTimeout(entry.timer);
      cache.delete(url);
      return null;
    }

    // Move to end (most recently used)
    touch(url, entry);

    return {
      body: entry.body,
      status: entry.status,
      contentType: entry.contentType,
    };
  }

  /**
   * Explicitly remove a URL from the cache.
   * @param {string} url
   * @returns {boolean} true if an entry was removed
   */
  function remove(url: string): boolean {
    const entry = cache.get(url);
    if (!entry) return false;
    if (entry.timer) clearTimeout(entry.timer);
    cache.delete(url);
    return true;
  }

  /** Current number of cached entries. */
  function size(): number {
    return cache.size;
  }

  /** Clear all entries and their timers. */
  function clear(): void {
    for (const [, entry] of Array.from(cache)) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    cache.clear();
  }

  return { getValidators, store, retrieve, remove, size, clear };
}

// ── Disk Cache (LFU) ─────────────────────────────────────────────────
//
// Persistent HTTP response cache stored in $HOME/.hyperagent/fetch-cache.
// Uses Least Frequently Used (LFU) eviction when cache exceeds size limit.
// Files have 600 permissions for security.
//
// Structure:
//   $HOME/.hyperagent/fetch-cache/
//     index.json     — metadata: {url, size, accessCount, contentType, timestamp}
//     <hash>.bin     — raw response body
//
// Cache key: SHA256(url) truncated to 16 hex chars

interface DiskCacheEntry {
  url: string;
  hash: string;
  size: number;
  accessCount: number;
  contentType: string;
  timestamp: number;
}

interface DiskCacheIndex {
  version: number;
  totalSize: number;
  entries: Record<string, DiskCacheEntry>;
}

interface DiskCache {
  get(url: string): { data: Buffer; contentType: string } | null;
  set(url: string, data: Buffer, contentType: string): void;
  stats(): { entries: number; totalSizeMb: number };
}

function createDiskCache(maxSizeBytes: number): DiskCache {
  // Disabled if maxSize is 0
  if (maxSizeBytes <= 0) {
    return {
      get: () => null,
      set: () => {},
      stats: () => ({ entries: 0, totalSizeMb: 0 }),
    };
  }

  const cacheDir = join(homedir(), ".hyperagent", "fetch-cache");
  const indexPath = join(cacheDir, "index.json");

  // Ensure cache directory exists with proper permissions
  function ensureCacheDir(): void {
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    }
  }

  // Hash URL to cache key
  function urlToHash(url: string): string {
    return createHash("sha256").update(url).digest("hex").slice(0, 16);
  }

  // Load index from disk
  function loadIndex(): DiskCacheIndex {
    try {
      if (existsSync(indexPath)) {
        const raw = readFileSync(indexPath, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed.version === 1 && parsed.entries) {
          return parsed as DiskCacheIndex;
        }
      }
    } catch {
      // Corrupt index — start fresh
    }
    return { version: 1, totalSize: 0, entries: {} };
  }

  // Save index to disk
  function saveIndex(index: DiskCacheIndex): void {
    ensureCacheDir();
    const data = JSON.stringify(index);
    writeFileSync(indexPath, data, { mode: 0o600 });
  }

  // Evict LFU entries until under size limit
  function evictLFU(index: DiskCacheIndex, neededSpace: number): void {
    const targetSize = maxSizeBytes - neededSpace;
    if (index.totalSize <= targetSize) return;

    // Sort by access count (ascending), then by timestamp (oldest first)
    const sorted = Object.values(index.entries).sort((a, b) => {
      if (a.accessCount !== b.accessCount) return a.accessCount - b.accessCount;
      return a.timestamp - b.timestamp;
    });

    for (const entry of sorted) {
      if (index.totalSize <= targetSize) break;

      // Delete the file
      const filePath = join(cacheDir, `${entry.hash}.bin`);
      try {
        if (existsSync(filePath)) unlinkSync(filePath);
      } catch {
        // Ignore delete errors
      }

      // Update index
      index.totalSize -= entry.size;
      delete index.entries[entry.hash];
    }
  }

  // Clean up orphaned files (files in dir but not in index)
  function cleanOrphans(index: DiskCacheIndex): void {
    try {
      if (!existsSync(cacheDir)) return;
      const files = readdirSync(cacheDir);
      for (const file of files) {
        if (file === "index.json") continue;
        if (!file.endsWith(".bin")) continue;
        const hash = file.replace(".bin", "");
        if (!index.entries[hash]) {
          try {
            unlinkSync(join(cacheDir, file));
          } catch {
            // Ignore
          }
        }
      }
    } catch {
      // Ignore errors during cleanup
    }
  }

  // Get cached response
  function get(url: string): { data: Buffer; contentType: string } | null {
    const hash = urlToHash(url);
    const index = loadIndex();
    const entry = index.entries[hash];

    if (!entry || entry.url !== url) return null;

    const filePath = join(cacheDir, `${hash}.bin`);
    try {
      if (!existsSync(filePath)) {
        // File missing — remove from index
        delete index.entries[hash];
        index.totalSize -= entry.size;
        saveIndex(index);
        return null;
      }

      const data = readFileSync(filePath);

      // Increment access count
      entry.accessCount++;
      entry.timestamp = Date.now();
      saveIndex(index);

      return { data, contentType: entry.contentType };
    } catch {
      return null;
    }
  }

  // Store response in cache
  function set(url: string, data: Buffer, contentType: string): void {
    const hash = urlToHash(url);
    const size = data.length;

    // Don't cache if single item exceeds 10% of max cache size
    if (size > maxSizeBytes * 0.1) return;

    const index = loadIndex();

    // Remove existing entry if present
    if (index.entries[hash]) {
      const existing = index.entries[hash];
      index.totalSize -= existing.size;
      delete index.entries[hash];
    }

    // Evict if needed
    evictLFU(index, size);

    // Write file
    ensureCacheDir();
    const filePath = join(cacheDir, `${hash}.bin`);
    try {
      writeFileSync(filePath, data, { mode: 0o600 });
      chmodSync(filePath, 0o600); // Ensure permissions even on existing files
    } catch {
      return; // Failed to write — don't update index
    }

    // Update index
    index.entries[hash] = {
      url,
      hash,
      size,
      accessCount: 1,
      contentType,
      timestamp: Date.now(),
    };
    index.totalSize += size;
    saveIndex(index);

    // Opportunistically clean orphans (once per ~10 writes)
    if (Math.random() < 0.1) {
      cleanOrphans(index);
    }
  }

  // Get cache stats
  function stats(): { entries: number; totalSizeMb: number } {
    const index = loadIndex();
    return {
      entries: Object.keys(index.entries).length,
      totalSizeMb: Math.round((index.totalSize / (1024 * 1024)) * 100) / 100,
    };
  }

  return { get, set, stats };
}

// ── Secure Fetch ─────────────────────────────────────────────────────
//
// Core HTTPS request wrapper. Uses node:https with a custom Agent
// whose lookup callback intercepts DNS resolution for SSRF protection.
// Post-connect remoteAddress check as defence-in-depth (Athos F-01/02).
//

/**
 * Categorise a request error into a user-safe message.
 *
 * Exposes the POSIX/OpenSSL error CODE (e.g. ENOTFOUND, ECONNREFUSED,
 * CERT_HAS_EXPIRED) but never the raw .message — which can leak internal
 * hostnames, redirect targets, or stack frames.
 *
 * @param {Error} err — The Node.js error object
 * @returns {string} A safe, categorised error message
 */
function categoriseRequestError(err: NodeJS.ErrnoException): string {
  // DNS-level failures (our safeLookup or system resolver)
  if (err.message === "DNS resolution failed" || err.code === "ENOTFOUND") {
    return "fetch failed: DNS resolution failed";
  }
  if (err.message === "SSRF blocked") {
    // Deliberately opaque — don't reveal private IP detection
    return "fetch failed: request error";
  }

  // Connection refused / reset
  if (err.code === "ECONNREFUSED") return "fetch failed: connection refused";
  if (err.code === "ECONNRESET") return "fetch failed: connection reset";
  if (err.code === "EPIPE") return "fetch failed: connection broken";
  if (err.code === "ETIMEDOUT") return "fetch failed: connection timed out";
  if (err.code === "EHOSTUNREACH") return "fetch failed: host unreachable";
  if (err.code === "ENETUNREACH") return "fetch failed: network unreachable";

  // TLS errors — the code itself is safe to expose
  if (err.code && err.code.startsWith("ERR_TLS_")) {
    return `fetch failed: TLS error (${err.code})`;
  }

  // Specific OpenSSL certificate errors — friendly names
  if (err.code === "CERT_HAS_EXPIRED") {
    return "fetch failed: certificate error (expired)";
  }
  if (err.code === "DEPTH_ZERO_SELF_SIGNED_CERT") {
    return "fetch failed: certificate error (self-signed certificate)";
  }
  if (err.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") {
    return "fetch failed: certificate error (UNABLE_TO_VERIFY_LEAF_SIGNATURE)";
  }

  // Generic OpenSSL error codes with CERT in the name
  if (err.code && /^[A-Z_]+$/.test(err.code) && err.code.includes("CERT")) {
    return `fetch failed: certificate error (${err.code})`;
  }

  // Fallback — include the code if we have one, but not the message
  if (err.code) {
    return `fetch failed: request error (${err.code})`;
  }
  return "fetch failed: request error";
}

/**
 * Perform a single HTTPS request (no redirect following).
 *
 * Returns the raw response including status, headers, and body.
 * Redirect handling is done by the outer secureFetch wrapper.
 *
 * @param {object} opts — Request options
 * @param {URL} opts.url — Validated URL object
 * @param {string} opts.method — "GET" or "POST"
 * @param {Record<string, string>} opts.headers — Sanitised headers
 * @param {Buffer | null} opts.body — Request body (POST only)
 * @param {number} opts.connectTimeoutMs — Connect timeout
 * @param {number} opts.readTimeoutMs — Read timeout
 * @param {number} opts.maxResponseBytes — Max response body size
 * @param {Set<string>} opts.allowedContentTypes — Content-Type prefixes
 * @param {boolean} opts.returnXRequestId — Include X-Request-Id in response
 * @param {AbortSignal} [opts.signal] — External abort signal (sandbox death)
 * @returns {Promise<{ status: number, body: string, ok: boolean, headers?: object, xRequestId?: string } | { error: string }>}
 */
function secureFetchSingle(
  opts: SecureFetchSingleOptions,
): Promise<SecureFetchResult> {
  return new Promise((outerResolve) => {
    // Settled guard — ensures outerResolve is called exactly once.
    // Multiple code paths (socket connect, data, end, error, abort)
    // can race to resolve; without this guard the Promise resolves
    // multiple times, leaking resources and state (P-01).
    let settled = false;
    let agent: HttpsAgent | null = null; // hoisted so settle() can destroy it safely
    const settle = (value: SecureFetchResult) => {
      if (settled) return;
      settled = true;
      if (agent) agent.destroy(); // clean up if agent was created
      outerResolve(value);
    };

    // Hard timeout via AbortController — uses the caller-derived
    // ceiling (connectTimeout + readTimeout + safety margin) so it
    // never exceeds the actual configured limits (audit finding F-09).
    const hardCeiling =
      opts.connectTimeoutMs + opts.readTimeoutMs + SAFETY_MARGIN_MS;
    const ac = new AbortController();
    const hardTimer = setTimeout(() => ac.abort(), hardCeiling);

    // If an external signal is provided (sandbox death), wire it
    if (opts.signal) {
      if (opts.signal.aborted) {
        clearTimeout(hardTimer);
        return settle({ error: "fetch failed: request aborted" });
      }
      opts.signal.addEventListener("abort", () => ac.abort(), { once: true });
    }

    /**
     * Custom DNS lookup — resolves hostname and checks ALL returned IPs
     * against private ranges. If ANY IP is private, the request is blocked.
     *
     * This is the primary SSRF defence. The resolved IP is passed to
     * Node's net.Socket, which uses it directly for TCP connect — no
     * TOCTOU gap between lookup and connect for the initially resolved IP.
     *
     * Node may call this with { all: true } (expecting an array of
     * { address, family } objects) or { all: false } (expecting a
     * single (address, family) pair). We handle both.
     */
    const safeLookup: any = (
      hostname: string,
      lookupOpts: any,
      cb: (err: Error | null, ...args: any[]) => void,
    ) => {
      // Resolve both A and AAAA records
      const p4 = resolve4(hostname).catch(() => []);
      const p6 = resolve6(hostname).catch(() => []);

      Promise.all([p4, p6])
        .then(([v4addrs, v6addrs]) => {
          const allAddrs = [...v4addrs, ...v6addrs];
          if (allAddrs.length === 0) {
            return cb(new Error("DNS resolution failed"));
          }

          // Check ALL resolved IPs — if any is private, block
          for (const addr of allAddrs) {
            if (isPrivateIp(addr)) {
              return cb(new Error("SSRF blocked"));
            }
          }

          // Node passes { all: true } when it wants an array of
          // { address, family } objects (e.g. HttpsAgent internals).
          // Without this, Node receives (address, family) as positional
          // args and ignores them, causing ERR_INVALID_IP_ADDRESS.
          if (lookupOpts && lookupOpts.all) {
            // Build array — prefer IPv4 first for compatibility
            const results = [
              ...v4addrs.map((a) => ({ address: a, family: 4 })),
              ...v6addrs.map((a) => ({ address: a, family: 6 })),
            ];
            return cb(null, results);
          }

          // Single-address mode — return first IPv4, fallback to IPv6
          const chosen = v4addrs[0] || v6addrs[0];
          const family = v4addrs[0] ? 4 : 6;
          cb(null, chosen, family);
        })
        .catch((err) => cb(err));
    };

    // Create agent with custom lookup — keepAlive: false prevents
    // socket reuse that could bypass DNS checks (Athos F-01/02).
    agent = new HttpsAgent({
      lookup: safeLookup,
      keepAlive: false,
      maxSockets: 1,
    });

    const reqOpts = {
      hostname: opts.url.hostname,
      port: opts.url.port || 443,
      path: opts.url.pathname + (opts.url.search || ""),
      method: opts.method,
      headers: opts.headers,
      agent,
      signal: ac.signal,
      // TLS hardening
      minVersion: "TLSv1.2" as const,
      rejectUnauthorized: true,
    };

    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let readTimer: ReturnType<typeof setTimeout> | undefined;

    const req = httpsRequest(reqOpts, (res) => {
      clearTimeout(connectTimer);

      // Start read timeout
      readTimer = setTimeout(() => {
        req.destroy();
        ac.abort();
      }, opts.readTimeoutMs);

      const status = res.statusCode!;

      // For redirects, we only need the status + location header.
      // Drain the response body and return immediately.
      if (REDIRECT_STATUS_CODES.has(status)) {
        res.resume(); // drain body to free socket
        clearTimeout(readTimer);
        clearTimeout(hardTimer);
        return settle({
          status,
          body: "",
          ok: false,
          headers: { location: res.headers["location"] || "" },
        });
      }

      // Content-Type check for 2xx responses — block when the
      // header is missing OR doesn't match the allowlist (F-03/F-10).
      // Previous code allowed absent Content-Type; an attacker could
      // omit the header to serve arbitrary content.
      if (status >= 200 && status < 300) {
        const contentType = (res.headers["content-type"] || "").toLowerCase();
        const typeAllowed = Array.from(opts.allowedContentTypes).some(
          (prefix) => contentType.startsWith(prefix.toLowerCase()),
        );
        if (!typeAllowed) {
          clearTimeout(readTimer);
          clearTimeout(hardTimer);
          res.destroy();
          return settle({ error: "fetch blocked: content type not permitted" });
        }
      }

      // Collect response body for ALL status codes — non-2xx
      // bodies contain useful info (API error messages, 401
      // challenge details, 429 retry-after headers, validation
      // failures). The same maxResponseBytes cap applies to
      // prevent a malicious server from sending a huge 404 body.
      const chunks: Buffer[] = [];
      let totalBytes = 0;

      res.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > opts.maxResponseBytes) {
          clearTimeout(readTimer);
          clearTimeout(hardTimer);
          res.destroy();
          return settle({ error: "fetch blocked: response too large" });
        }
        chunks.push(chunk);
      });

      res.on("end", () => {
        clearTimeout(readTimer);
        clearTimeout(hardTimer);

        const ok = status >= 200 && status < 300;

        // Expose Content-Type and Content-Length so the guest
        // knows what kind of data `body` contains (HTML vs JSON
        // vs plain text) and how large the original response was.
        const rawCT = res.headers["content-type"] || "";
        // Strip parameters (charset, boundary, etc.) — the guest
        // only needs the media type, e.g. "application/json".
        const contentType = rawCT.split(";")[0].trim().toLowerCase();

        // Keep binary content as raw Buffer to prevent UTF-8 corruption.
        // Binary types (image/*, application/octet-stream, etc.) have bytes
        // >127 that get destroyed by toString("utf8") replacement chars.
        const isBinary =
          contentType.startsWith("image/") ||
          contentType === "application/octet-stream" ||
          contentType.startsWith("audio/") ||
          contentType.startsWith("video/") ||
          contentType === "application/pdf" ||
          contentType === "application/zip";
        const rawBuf = Buffer.concat(chunks);
        const body = isBinary ? rawBuf : rawBuf.toString("utf8");
        const contentLength =
          typeof res.headers["content-length"] === "string"
            ? parseInt(res.headers["content-length"], 10)
            : undefined;

        const result: SecureFetchResult = { status, body, ok, contentType };
        if (Number.isFinite(contentLength)) {
          result.contentLength = contentLength;
        }

        // Optionally include X-Request-Id
        if (opts.returnXRequestId) {
          const xrid = res.headers["x-request-id"];
          if (typeof xrid === "string") {
            result.xRequestId = xrid;
          }
        }

        // Extract rate-limit headers (X-RateLimit-* / RateLimit-*
        // and Retry-After). Host-side validation caps values to
        // prevent untrusted servers from injecting absurd numbers.
        const rateLimit = extractRateLimitInfo(res, status);
        if (rateLimit) {
          result.rateLimit = rateLimit;
        }

        // Extract pagination links from the Link header (RFC 8288).
        // Only HTTPS URLs are included.
        const pagination = extractPaginationLinks(res);
        if (pagination) {
          result.pagination = pagination;
        }

        // Extract conditional-request validators (ETag, Last-Modified)
        // for the conditional cache. These are attached to the result
        // so the caller can store them alongside the response body.
        const validators = extractConditionalValidators(res);
        if (validators) {
          result.validators = validators;
        }

        settle(result);
      });

      res.on("error", (err) => {
        clearTimeout(readTimer);
        clearTimeout(hardTimer);
        settle({ error: categoriseRequestError(err) });
      });
    });

    // Connect timeout
    connectTimer = setTimeout(() => {
      req.destroy();
      ac.abort();
    }, opts.connectTimeoutMs);

    // Post-connect defence-in-depth: verify remoteAddress is not
    // private AFTER TCP connect completes. Closes the TOCTOU gap
    // identified by Athos (F-01/F-02/F-19).
    req.on("socket", (socket) => {
      socket.on("connect", () => {
        const remote = socket.remoteAddress;
        if (remote && isPrivateIp(remote)) {
          clearTimeout(connectTimer);
          clearTimeout(hardTimer);
          socket.destroy();
          settle({ error: "fetch failed: request error" });
        }
      });
    });

    req.on("error", (err) => {
      clearTimeout(connectTimer);
      clearTimeout(readTimer);
      clearTimeout(hardTimer);

      if (err.name === "AbortError" || ac.signal.aborted) {
        settle({ error: "fetch failed: timeout" });
      } else {
        settle({ error: categoriseRequestError(err) });
      }
    });

    // Send body for POST requests
    if (opts.body) {
      req.write(opts.body);
    }
    req.end();
  });
}

/**
 * Validate a redirect Location URL against security policies.
 *
 * Every redirect hop is re-validated from scratch:
 *   1. HTTPS only (no downgrade to HTTP)
 *   2. Domain must be in the operator's allowlist
 *   3. SSRF checks run on the new hostname (via safeLookup in secureFetchSingle)
 *   4. No credentials, no IP literals, no non-standard ports
 *
 * @param {string} location — Raw Location header value
 * @param {URL} originalUrl — The URL that triggered the redirect (for relative resolution)
 * @param {Set<string>} exactDomains — Allowed exact domains
 * @param {string[]} wildcardDomains — Allowed wildcard parent domains
 * @returns {{ valid: boolean, url?: URL, error?: string }}
 */
function validateRedirectTarget(
  location: string,
  originalUrl: URL,
  exactDomains: Set<string>,
  wildcardDomains: string[],
): UrlValidationResult {
  if (!location || typeof location !== "string") {
    return {
      valid: false,
      error: "fetch blocked: redirect with no Location header",
    };
  }

  // Resolve relative redirects against the original URL
  let parsed;
  try {
    parsed = new URL(location, originalUrl);
  } catch {
    return { valid: false, error: "fetch blocked: redirect to invalid URL" };
  }

  // HTTPS only — no protocol downgrade
  if (parsed.protocol !== "https:") {
    return { valid: false, error: "fetch blocked: redirect to non-HTTPS URL" };
  }

  // No credentials
  if (parsed.username || parsed.password) {
    return {
      valid: false,
      error: "fetch blocked: redirect URL contains credentials",
    };
  }

  // No non-standard ports
  if (parsed.port && parsed.port !== "443") {
    return {
      valid: false,
      error: "fetch blocked: redirect to non-standard port",
    };
  }

  // No IP literals
  const hostname = parsed.hostname.toLowerCase();
  if (
    isIP(hostname) !== 0 ||
    (hostname.startsWith("[") && hostname.endsWith("]"))
  ) {
    return { valid: false, error: "fetch blocked: redirect to IP address" };
  }

  // Domain allowlist — the redirect target must be allowed.
  //
  // SECURITY TRADE-OFF: The error includes the redirect hostname so the
  // LLM can suggest actionable remediation (e.g. `/plugin enable fetch
  // allowedDomains=cdn.example.com`).  On a multi-tenant host this
  // could leak internal hostnames of backend services.  If that's a
  // concern in your deployment, replace `hostname` with a generic
  // message below.  For single-tenant / dev use the trade-off is
  // acceptable — the hostname was already visible in the HTTP redirect
  // response the guest sandbox received.
  if (!isDomainAllowed(hostname, exactDomains, wildcardDomains)) {
    return {
      valid: false,
      error: `fetch blocked: redirect to domain not in allowlist (${hostname})`,
    };
  }

  // Reconstruct clean URL (strip fragments, prevent smuggling)
  const cleanUrl = new URL(
    `https://${hostname}${parsed.pathname}${parsed.search || ""}`,
  );
  return { valid: true, url: cleanUrl };
}

/**
 * Perform a secure HTTPS request with redirect following.
 *
 * Wraps secureFetchSingle in a redirect loop (up to MAX_REDIRECTS hops).
 * Each redirect target is fully re-validated:
 *   - HTTPS only (no protocol downgrade)
 *   - Domain must be in the operator's allowlist
 *   - SSRF DNS + private IP checks on every hop
 *   - Redirect loop detection via URL history
 *
 * Method handling per HTTP spec:
 *   - 301, 302, 303 → switch to GET, drop body
 *   - 307, 308 → preserve original method and body
 *
 * @param {object} opts — Request options (same as secureFetchSingle + domain lists)
 * @param {URL} opts.url — Validated URL object
 * @param {string} opts.method — "GET" or "POST"
 * @param {Record<string, string>} opts.headers — Sanitised headers
 * @param {Buffer | null} opts.body — Request body (POST only)
 * @param {number} opts.connectTimeoutMs — Connect timeout
 * @param {number} opts.readTimeoutMs — Read timeout
 * @param {number} opts.maxResponseBytes — Max response body size
 * @param {Set<string>} opts.allowedContentTypes — Content-Type prefixes
 * @param {boolean} opts.returnXRequestId — Include X-Request-Id in response
 * @param {Set<string>} opts.exactDomains — Allowed exact domains
 * @param {string[]} opts.wildcardDomains — Allowed wildcard parent domains
 * @param {AbortSignal} [opts.signal] — External abort signal (sandbox death)
 * @returns {Promise<{ status: number, body: string, ok: boolean, xRequestId?: string } | { error: string }>}
 */
async function secureFetch(
  opts: SecureFetchOptions,
): Promise<SecureFetchResult> {
  let currentUrl = opts.url;
  let currentMethod = opts.method;
  let currentBody = opts.body;
  const visited = new Set();

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const urlKey = currentUrl.href;

    // Redirect loop detection
    if (visited.has(urlKey)) {
      return { error: "fetch blocked: redirect loop detected" };
    }
    visited.add(urlKey);

    const result = await secureFetchSingle({
      ...opts,
      url: currentUrl,
      method: currentMethod,
      body: currentBody,
    });

    // Error or non-redirect → return immediately
    if (result.error || !REDIRECT_STATUS_CODES.has(result.status!)) {
      // Strip internal headers from the final response
      // (only used for redirect plumbing)
      if (result.headers) delete result.headers;
      return result;
    }

    // Extract and validate the redirect target
    const location = result.headers?.location;
    const check = validateRedirectTarget(
      location ?? "",
      currentUrl,
      opts.exactDomains,
      opts.wildcardDomains,
    );

    if (!check.valid) {
      return { error: check.error! };
    }

    // 301, 302, 303 → change method to GET, drop body (HTTP spec)
    // 307, 308 → preserve method and body
    if (
      result.status === 301 ||
      result.status === 302 ||
      result.status === 303
    ) {
      currentMethod = "GET";
      currentBody = null;
      // Remove Content-Length / Content-Type if switching to GET
      const stripped = { ...opts.headers };
      delete stripped["Content-Length"];
      delete stripped["content-length"];
      opts = { ...opts, headers: stripped };
    }

    currentUrl = check.url!;
  }

  // Exhausted redirect budget
  return { error: `fetch blocked: too many redirects (max ${MAX_REDIRECTS})` };
}

// ── Utility ──────────────────────────────────────────────────────────

/**
 * Safely parse a numeric config value. Rejects NaN, Infinity, and
 * values below the floor. Falls back to the provided default,
 * clamped between floor and ceiling.
 *
 * @param {*} value — Raw config value
 * @param {number} def — Default
 * @param {number} ceil — Hard ceiling
 * @param {number} [floor=1] — Hard floor (prevents DoS via zero values, F-04)
 * @returns {number}
 */
function safeNumericConfig(
  value: unknown,
  def: number,
  ceil: number,
  floor: number = 1,
): number {
  const raw = typeof value === "number" ? value : def;
  if (!Number.isFinite(raw) || raw < floor) return def;
  return Math.min(raw, ceil);
}

/**
 * Enforce a minimum delay. Returns a promise that resolves after
 * at least `minMs` milliseconds from `startTime`.
 *
 * @param {number} startTime — Date.now() at request start
 * @param {number} minMs — Minimum elapsed time
 * @returns {Promise<void>}
 */
function enforceMinDelay(startTime: number, minMs: number): Promise<void> {
  const elapsed = Date.now() - startTime;
  const remaining = minMs - elapsed;
  if (remaining <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, remaining));
}

// ── Response Cache ───────────────────────────────────────────────────
//
// Single-entry cache for HTTP responses. Every successful response is
// cached host-side and served to the guest via sequential read() calls.
// The guest calls get()/post() to make the request (returns metadata
// only), then read(url) in a loop until done. This gives the LLM one
// uniform code pattern regardless of response size.
//
// Only the most recent URL is cached — a new request evicts the
// previous one. TTL-based expiry ensures we don't hold buffers
// indefinitely if the guest never calls read().
//
// The cache is scoped to a single plugin registration (one per sandbox).

/**
 * Create a single-entry response cache with cursor-based sequential
 * reading and TTL expiry.
 *
 * @param {number} ttlMs — Time-to-live for cached entries in milliseconds
 * @param {number} defaultChunkSize — Default chunk size in bytes
 * @returns {{ store: (url: string, body: string | Buffer, meta: { contentType: string, contentLength?: number, status: number, ok: boolean }) => void, read: (url: string) => { data: string, done: boolean } | null, readBinary: (url: string) => { data: Buffer, done: boolean } | null, evict: () => void, has: (url: string) => boolean, meta: (url: string) => { contentType: string, contentLength?: number, status: number, ok: boolean } | null, stats: () => { cached: boolean, url?: string, totalBytes?: number, cursor?: number, ageMs?: number } }}
 */
function createResponseCache(
  ttlMs: number,
  defaultChunkSize: number,
): ResponseCache {
  // Entry shape: { url, body, meta, cursor, storedAt, timer }
  // `meta` carries HTTP metadata returned alongside every read():
  //   { contentType, contentLength?, status, ok }
  // `cursor` is the byte offset for the next read().
  interface CacheEntry {
    url: string;
    body: string | Buffer;
    meta: ResponseMetadata;
    cursor: number;
    storedAt: number;
    timer: ReturnType<typeof setTimeout>;
  }
  let entry: CacheEntry | null = null;

  /** Evict the current entry and clear its TTL timer. */
  function evict(): void {
    if (entry) {
      clearTimeout(entry.timer);
      entry = null;
    }
  }

  /**
   * Store a response body and its HTTP metadata in the cache.
   * Evicts any previous entry and resets the read cursor to 0.
   *
   * @param {string} url  — The URL this response belongs to
   * @param {string | Buffer} body — The full response body (text or binary)
   * @param {{ contentType: string, contentLength?: number, status: number, ok: boolean }} meta
   *        — HTTP metadata to include with every read()
   */
  function store(
    url: string,
    body: string | Buffer,
    meta: ResponseMetadata,
  ): void {
    evict();
    const timer = setTimeout(evict, ttlMs);
    // Prevent the timer from keeping the Node.js process alive
    if (timer.unref) timer.unref();
    entry = {
      url,
      body,
      meta: meta || {},
      cursor: 0,
      storedAt: Date.now(),
      timer,
    };
  }

  /**
   * Read the next chunk from the cached response.
   *
   * Returns `{ data, done }` where `done` is true on the last
   * (or only) chunk. When `done` is true the cache entry is
   * automatically purged — no stale data lingers on the host.
   *
   * @param {string} url — Must match the cached URL
   * @returns {{ data: string, done: boolean } | null}
   */
  function read(url: string): { data: string; done: boolean } | null {
    if (!entry || entry.url !== url) return null;

    const buf = Buffer.isBuffer(entry.body)
      ? entry.body
      : Buffer.from(entry.body, "utf8");
    const start = entry.cursor;
    let end = Math.min(start + defaultChunkSize, buf.length);

    // ── UTF-8 safe boundary ──────────────────────────────────
    // Avoid splitting a multi-byte character across chunks.
    // Continuation bytes have the pattern 10xxxxxx (0x80–0xBF).
    // If `end` lands on one, back up to the leading byte so the
    // full character falls into the next chunk instead.
    if (end < buf.length) {
      while (end > start && (buf[end] & 0xc0) === 0x80) {
        end--;
      }
      // Degenerate case: chunk too small for a single character.
      // Advance past the character instead of returning nothing.
      if (end === start) {
        end = Math.min(start + defaultChunkSize, buf.length);
        while (end < buf.length && (buf[end] & 0xc0) === 0x80) {
          end++;
        }
      }
    }

    const data = buf.subarray(start, end).toString("utf8");
    const done = end >= buf.length;

    if (done) {
      // Last chunk — auto-evict immediately
      evict();
    } else {
      // Advance cursor for next read
      entry.cursor = end;
    }

    return { data, done };
  }

  /**
   * Read the next binary chunk from the cached response.
   * Returns raw Buffer (→ Uint8Array on guest side via NAPI).
   * No UTF-8 boundary handling — binary data doesn't care about char boundaries.
   *
   * @param {string} url — Must match the cached URL
   * @returns {{ data: Buffer, done: boolean } | null}
   */
  function readBinary(url: string): { data: Buffer; done: boolean } | null {
    if (!entry || entry.url !== url) return null;

    const buf = Buffer.isBuffer(entry.body)
      ? entry.body
      : Buffer.from(entry.body, "utf8");
    const start = entry.cursor;
    const end = Math.min(start + defaultChunkSize, buf.length);

    // subarray() creates a zero-copy view into the original buffer.
    const data = buf.subarray(start, end);
    const done = end >= buf.length;

    if (done) {
      // IMPORTANT: Defer eviction to the next event loop tick.
      // The returned `data` is a view into entry.body's memory.
      // If we evict() synchronously, entry.body becomes eligible for GC
      // before napi has a chance to read the buffer contents.
      // setImmediate ensures the buffer survives until after napi copies it.
      setImmediate(evict);
    } else {
      entry.cursor = end;
    }

    return { data, done };
  }

  /** Check if a URL is currently cached. */
  function has(url: string): boolean {
    return entry !== null && entry.url === url;
  }

  /** Return the stored metadata for a cached URL (or null). */
  function meta(url: string): ResponseMetadata | null {
    if (!entry || entry.url !== url) return null;
    return { ...entry.meta };
  }

  /** Return cache stats (for testing / debugging). */
  function stats() {
    if (!entry) return { cached: false };
    return {
      cached: true,
      url: entry.url,
      totalBytes: Buffer.isBuffer(entry.body)
        ? entry.body.length
        : Buffer.byteLength(entry.body, "utf8"),
      cursor: entry.cursor,
      ageMs: Date.now() - entry.storedAt,
    };
  }

  return { store, read, readBinary, evict, has, meta, stats };
}

// ── Plugin Host Functions ─────────────────────────────────────────────

/**
 * Create the host functions for the fetch plugin.
 *
 * SECURITY: This is a declarative API — the host calls this function
 * and registers the returned functions itself. The plugin never gets
 * access to the proto/sandbox object, closing the GAP 2 attack vector.
 *
 * @param {object} config — Resolved plugin configuration
 * @returns {Record<string, Record<string, Function>>} Host functions by module name
 */
export function createHostFunctions(config?: FetchConfig): FetchHostFunctions {
  const cfg = config ?? {};

  // ── Parse domain allowlist ───────────────────────────────────
  const rawDomains = Array.isArray(cfg.allowedDomains)
    ? cfg.allowedDomains
    : [];
  const {
    exact: exactDomains,
    wildcards: wildcardDomains,
    errors: domainErrors,
  } = parseDomainAllowlist(rawDomains);

  if (domainErrors.length > 0) {
    console.error(`[fetch] Domain allowlist warnings:`);
    for (const err of domainErrors) {
      console.error(`  ⚠️  ${err}`);
    }
  }

  if (exactDomains.size === 0 && wildcardDomains.length === 0) {
    // Fail loudly at registration time rather than silently blocking
    // every request with a cryptic domain-not-in-allowlist error
    // (audit finding F-10). Operators see the error immediately.
    //
    // Consolidate ALL validation errors (rejected entries + zero valid
    // result) so the operator sees the full picture in one message.
    const detail =
      domainErrors.length > 0
        ? ` Rejected entries:\n${domainErrors.map((e) => `  • ${e}`).join("\n")}`
        : "";
    throw new Error(
      "[fetch] No valid domains configured — ALL requests would be blocked. " +
        "Set allowedDomains (e.g. allowedDomains=api.example.com) and re-enable." +
        detail,
    );
  }

  // ── Parse config values ──────────────────────────────────────
  const allowPost = !!cfg.allowPost;
  const userAgent =
    typeof cfg.userAgent === "string" && cfg.userAgent.length > 0
      ? cfg.userAgent.slice(0, 256)
      : "hyperlight-fetch/1.0";

  // Enforce manifest-declared minimums as the floor parameter (4th arg).
  // Previously floor defaulted to 1, so e.g. connectTimeoutMs=1 was silently
  // accepted despite the manifest declaring minimum: 1000 (audit finding F-08).
  const connectTimeoutMs = safeNumericConfig(
    cfg.connectTimeoutMs,
    5000,
    10_000,
    1000,
  );
  const readTimeoutMs = safeNumericConfig(
    cfg.readTimeoutMs,
    10_000,
    30_000,
    1000,
  );
  const maxResponseBytes =
    safeNumericConfig(cfg.maxResponseSizeKb, 1024, 65536) * 1024;
  const readSizeBytes = safeNumericConfig(cfg.readSizeKb, 48, 256, 8) * 1024;
  const responseCacheTtlMs =
    safeNumericConfig(cfg.responseCacheTtlSeconds, 300, 600, 30) * 1000;
  const maxRequestBodyBytes =
    safeNumericConfig(cfg.maxRequestBodySizeKb, 4, 64) * 1024;
  const maxPerMinuteRaw = safeNumericConfig(cfg.maxRequestsPerMinute, 30, 60);
  const maxPerHour = safeNumericConfig(cfg.maxRequestsPerHour, 100, 500);
  // Clamp per-minute to never exceed per-hour — an operator setting
  // 60/minute with 1/hour makes no sense and defeats the hourly cap.
  const maxPerMinute = Math.min(maxPerMinuteRaw, maxPerHour);
  if (maxPerMinuteRaw > maxPerHour) {
    console.error(
      `[fetch] maxRequestsPerMinute (${maxPerMinuteRaw}) exceeds maxRequestsPerHour (${maxPerHour}) — clamped to ${maxPerMinute}`,
    );
  }
  const maxDomains = safeNumericConfig(cfg.maxDomainsPerSession, 5, 20);
  const maxDataReceivedBytes =
    safeNumericConfig(cfg.maxDataReceivedKb, 2048, 1048576) * 1024;
  const returnXRequestId = !!cfg.returnXRequestId;
  const conditionalCacheMax = safeNumericConfig(
    cfg.conditionalCacheMaxEntries,
    20,
    100,
  );
  const conditionalCacheTtlMs =
    safeNumericConfig(cfg.conditionalCacheTtlSeconds, 600, 3600, 60) * 1000;

  // Auto-retry on 429 configuration
  const autoRetryOn429 = !!cfg.autoRetryOn429;
  const autoRetryMaxWaitSeconds = safeNumericConfig(
    cfg.autoRetryMaxWaitSeconds,
    30,
    120,
  );
  const autoRetryMaxAttempts = safeNumericConfig(
    cfg.autoRetryMaxAttempts,
    3,
    10,
  );

  // Parallel fetch configuration — controls how many requests can be in flight
  // simultaneously. Default 1 for backwards compatibility (serial).
  // Higher values speed up batch downloads but may trigger server rate limits.
  const maxParallelFetches = safeNumericConfig(cfg.maxParallelFetches, 1, 10);

  // Disk cache configuration — persistent LFU cache in $HOME/.hyperagent/fetch-cache
  const diskCacheMaxBytes =
    safeNumericConfig(cfg.diskCacheMaxMb, 100, 1000, 0) * 1024 * 1024;

  // Build allowed header names set (lowercased)
  const rawAllowedHeaders = Array.isArray(cfg.allowedRequestHeaders)
    ? cfg.allowedRequestHeaders
    : ["Authorization", "Content-Type", "Accept"];
  const allowedHeaderNames = new Set(
    rawAllowedHeaders
      .map((h) => (typeof h === "string" ? h.toLowerCase() : ""))
      .filter((h) => h.length > 0),
  );

  // Build allowed Content-Type prefixes (lowercased)
  // Default allows application/json and all text/* types (text/plain, text/html,
  // text/xml, text/css, text/markdown, etc.). The prefix matching means "text/"
  // matches any text subtype.
  //
  // Preset names expand to commonly-needed content type sets:
  //   "text-only"      → json, plain, html, xml, csv (safe textual data)
  //   "media-friendly" → text-only + images, audio, PDFs (common media)
  //   "permissive"     → any content type (use with caution)
  const CONTENT_TYPE_PRESETS: Record<string, string[]> = {
    "text-only": [
      "application/json",
      "text/",
      "application/xml",
      "application/csv",
    ],
    "media-friendly": [
      "application/json",
      "text/",
      "application/xml",
      "application/csv",
      "image/",
      "audio/",
      "application/pdf",
    ],
    permissive: [""], // Empty string prefix matches everything
  };

  const rawContentTypesInput = Array.isArray(cfg.allowedContentTypes)
    ? cfg.allowedContentTypes
    : ["application/json", "text/"];

  // Expand presets into their constituent content types
  const rawContentTypes = rawContentTypesInput.flatMap((t) => {
    if (typeof t !== "string") return [];
    const lower = t.toLowerCase().trim();
    return CONTENT_TYPE_PRESETS[lower] || [lower];
  });

  const allowedContentTypes = new Set(
    rawContentTypes.filter(
      (t) => t.length > 0 || rawContentTypesInput.includes("permissive"),
    ),
  );

  // ── Create rate limiter + audit logger ────────────────────────
  const rateLimiter = createRateLimiter({
    maxPerMinute,
    maxPerHour,
    maxDomains,
    maxDataReceivedBytes,
  });

  const sessionId = randomUUID();
  const auditLogger = createAuditLogger(sessionId);

  // ── Response cache ─────────────────────────────────────────────
  // Single-entry cache: stores every successful response so the
  // guest can retrieve the body via sequential read() calls. Only
  // one URL is cached at a time — a new fetch evicts the previous.
  const responseCache = createResponseCache(responseCacheTtlMs, readSizeBytes);

  // ── Conditional request cache ──────────────────────────────────
  // Stores response bodies alongside their ETag/Last-Modified validators.
  // On subsequent GETs to the same URL, the host automatically injects
  // If-None-Match / If-Modified-Since. A 304 serves the cached body
  // without counting toward the data budget — saving bandwidth and
  // server-side rate-limit budget. "Sometimes dead is better." — Pet
  // Sematary (1989)… but for HTTP responses, cached is better.
  const conditionalCache = createConditionalCache(
    conditionalCacheMax,
    conditionalCacheTtlMs,
  );

  // ── Disk Cache — persistent LFU cache ────────────────────────────
  // Stores HTTP response bodies on disk with LFU eviction.
  // Useful for repeated fetches of same URLs across handlers/sessions.
  const diskCache = createDiskCache(diskCacheMaxBytes);

  // ── Semaphore — limit concurrent requests ─────────────────────
  // When maxParallelFetches=1 (default), this behaves like the original mutex.
  // Higher values allow parallel batch downloads.
  let inFlightCount = 0;

  /**
   * Core request handler — shared by get() and post().
   *
   * @param {string} method — "GET" or "POST"
   * @param {string} rawUrl — Raw URL from sandbox
   * @param {object} [sandboxHeaders] — Headers from sandbox
   * @param {*} [body] — POST body (object, will be JSON-serialised)
   * @param {AbortSignal} [signal] — External abort signal
   * @returns {Promise<object>} Metadata envelope: { status, ok, contentType } or { error }
   */
  async function handleRequest(
    method: string,
    rawUrl: string,
    sandboxHeaders?: unknown,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<FetchResult> {
    const startTime = Date.now();

    // Semaphore — reject if at capacity
    if (inFlightCount >= maxParallelFetches) {
      await enforceMinDelay(startTime, MIN_RESPONSE_DELAY_MS);
      return { error: "fetch blocked: request already in flight" };
    }
    inFlightCount++;

    try {
      // ── URL validation ────────────────────────────────────
      const urlCheck = validateUrl(rawUrl, exactDomains, wildcardDomains);
      if (!urlCheck.valid) {
        auditLogger.log({
          method,
          hostname: "(invalid)",
          url_length: typeof rawUrl === "string" ? rawUrl.length : 0,
          outcome: "blocked",
          block_reason: urlCheck.error,
        });
        await enforceMinDelay(startTime, MIN_RESPONSE_DELAY_MS);
        return { error: urlCheck.error! };
      }

      const url = urlCheck.url!;
      const hostname = urlCheck.hostname!;

      // ── Rate limit check ──────────────────────────────────
      const rateCheck = rateLimiter.check(hostname);
      if (!rateCheck.allowed) {
        auditLogger.log({
          method,
          hostname,
          url_length: rawUrl.length,
          outcome: "blocked",
          block_reason: rateCheck.reason,
        });
        await enforceMinDelay(startTime, MIN_RESPONSE_DELAY_MS);
        return { error: rateCheck.reason };
      }

      // ── Header validation ─────────────────────────────────
      const headerCheck = buildRequestHeaders(
        sandboxHeaders,
        allowedHeaderNames,
        userAgent,
      );
      if (headerCheck.error) {
        auditLogger.log({
          method,
          hostname,
          url_length: rawUrl.length,
          outcome: "blocked",
          block_reason: headerCheck.error,
        });
        await enforceMinDelay(startTime, MIN_RESPONSE_DELAY_MS);
        return { error: headerCheck.error };
      }

      // ── POST body validation ──────────────────────────────
      let bodyBuffer = null;
      if (method === "POST") {
        if (body === undefined || body === null) {
          bodyBuffer = Buffer.from("", "utf8");
        } else if (typeof body === "object") {
          try {
            const serialised = JSON.stringify(body);
            bodyBuffer = Buffer.from(serialised, "utf8");
          } catch {
            await enforceMinDelay(startTime, MIN_RESPONSE_DELAY_MS);
            return {
              error: "fetch blocked: body is not JSON-serialisable",
            };
          }
        } else if (typeof body === "string") {
          bodyBuffer = Buffer.from(body, "utf8");
        } else {
          await enforceMinDelay(startTime, MIN_RESPONSE_DELAY_MS);
          return {
            error: "fetch blocked: body must be a string or object",
          };
        }

        if (bodyBuffer && bodyBuffer.length > maxRequestBodyBytes) {
          auditLogger.log({
            method,
            hostname,
            url_length: rawUrl.length,
            request_body_size: bodyBuffer.length,
            outcome: "blocked",
            block_reason: "request body too large",
          });
          await enforceMinDelay(startTime, MIN_RESPONSE_DELAY_MS);
          return {
            error: `fetch blocked: request body too large (max ${maxRequestBodyBytes / 1024}KB)`,
          };
        }

        // Set Content-Type if not already set
        if (
          !headerCheck.headers["Content-Type"] &&
          !headerCheck.headers["content-type"]
        ) {
          headerCheck.headers["Content-Type"] = "application/json";
        }
        headerCheck.headers["Content-Length"] = String(bodyBuffer.length);
      }

      // ── Record request (check-then-increment, atomically safe
      //    in single-threaded Node.js) ───────────────────────
      rateLimiter.recordRequest(hostname);

      // ── Inject conditional-request headers ────────────────
      // For GET requests, check if we have cached validators
      // (ETag / Last-Modified) for this URL. If so, add
      // If-None-Match / If-Modified-Since so the server can
      // return 304 Not Modified (saving bandwidth + rate budget).
      // POST is never conditional — it's not safe/idempotent.
      let conditionalHit = false;
      if (method === "GET") {
        const validators = conditionalCache.getValidators(rawUrl);
        if (validators) {
          if (validators.etag) {
            headerCheck.headers["If-None-Match"] = validators.etag;
          }
          if (validators.lastModified) {
            headerCheck.headers["If-Modified-Since"] = validators.lastModified;
          }
        }
      }

      // ── Execute fetch with safety timeout ─────────────────
      // secureFetch has its own hard timeout (connect + read +
      // SAFETY_MARGIN_MS), but if something goes pathologically
      // wrong (stuck callback etc.) we add a belt-and-suspenders
      // outer timeout here, slightly beyond the inner one (F-06).
      const innerCeiling = connectTimeoutMs + readTimeoutMs + SAFETY_MARGIN_MS;
      const OUTER_MARGIN_MS = 2000;

      // ── Retry loop for 429 responses ────────────────────────
      let result: SecureFetchResult;
      let retryAttempt = 0;

      while (true) {
        let safetyTimerId: ReturnType<typeof setTimeout> | undefined;
        const safetyTimeout = new Promise<SecureFetchResult>((resolve) => {
          safetyTimerId = setTimeout(
            () => resolve({ error: "fetch failed: timeout" }),
            innerCeiling + OUTER_MARGIN_MS,
          );
        });

        try {
          result = await Promise.race([
            secureFetch({
              url,
              method,
              headers: headerCheck.headers,
              body: bodyBuffer,
              connectTimeoutMs,
              readTimeoutMs,
              maxResponseBytes,
              allowedContentTypes,
              returnXRequestId,
              exactDomains,
              wildcardDomains,
              signal,
            }),
            safetyTimeout,
          ]);
        } finally {
          // Always clear the safety timer to prevent leaked handles
          // that keep Node.js alive after the request completes.
          clearTimeout(safetyTimerId);
        }

        // ── Auto-retry on 429 ─────────────────────────────────
        // If enabled and we got a 429, wait and retry up to maxAttempts.
        if (
          autoRetryOn429 &&
          !result.error &&
          result.status === 429 &&
          retryAttempt < autoRetryMaxAttempts
        ) {
          retryAttempt++;

          // Determine wait time: use server's Retry-After if available,
          // otherwise exponential backoff (1s, 2s, 4s, 8s, ...)
          const retryAfterSecs = result.rateLimit?.retryAfterSecs;
          const backoffSecs = Math.min(Math.pow(2, retryAttempt - 1), 30);
          const waitSecs = retryAfterSecs ?? backoffSecs;

          if (waitSecs > autoRetryMaxWaitSeconds) {
            // Server wants us to wait longer than configured max — give up
            console.error(
              `[fetch] 429 retry wait (${waitSecs}s) exceeds max (${autoRetryMaxWaitSeconds}s) — returning error`,
            );
            result = {
              error: `fetch blocked: 429 retry wait (${waitSecs}s) exceeds max (${autoRetryMaxWaitSeconds}s)`,
            };
            break;
          }

          console.error(
            `[fetch] 429 received, waiting ${waitSecs}s before retry (attempt ${retryAttempt}/${autoRetryMaxAttempts})`,
          );

          // Wait before retrying
          await new Promise((resolve) => setTimeout(resolve, waitSecs * 1000));
          continue; // Retry the fetch
        }

        // Not a 429 or auto-retry disabled or max attempts reached — exit loop
        break;
      }

      // Record response bytes for data budget.
      // 304 Not Modified responses carry no new body data,
      // so they don't count toward the data budget — one of the
      // key benefits of conditional requests.
      if (!result.error && result.status !== 304 && result.body) {
        const bodySize = Buffer.isBuffer(result.body)
          ? result.body.length
          : Buffer.byteLength(result.body, "utf8");
        rateLimiter.recordResponseBytes(bodySize);
      }

      // ── Handle 304 Not Modified ───────────────────────────
      // If the server returned 304, serve the cached body. The
      // response still carried rate-limit and pagination headers,
      // so we extract those before swapping in the cached body.
      if (!result.error && result.status === 304 && method === "GET") {
        const cached = conditionalCache.retrieve(rawUrl);
        if (cached) {
          conditionalHit = true;
          // Replace the empty 304 body with the cached body,
          // and restore the original status/contentType.
          result.body = cached.body;
          result.status = cached.status;
          result.contentType = cached.contentType;
          result.ok = cached.status >= 200 && cached.status < 300;
          // Don't overwrite rateLimit/pagination — the 304
          // response's rate-limit headers are still current.
        } else {
          // 304 but no cached body — shouldn't happen if the
          // server is well-behaved. Treat as an empty 200.
          // The guest will get an empty body from read().
          result.status = 200;
          result.ok = true;
          result.body = result.body || "";
        }
      }

      // ── Update conditional cache ──────────────────────────
      // Store response bodies with their validators for future
      // conditional requests. Only cache GET responses with
      // 2xx status that have at least one validator.
      if (
        !result.error &&
        method === "GET" &&
        result.ok &&
        result.validators &&
        !conditionalHit
      ) {
        const bodyStr = typeof result.body === "string" ? result.body : "";
        conditionalCache.store(
          rawUrl,
          bodyStr,
          result.status!,
          result.contentType!,
          result.validators,
        );
      }

      // ── Audit log ─────────────────────────────────────────
      auditLogger.log({
        method,
        hostname,
        url_length: rawUrl.length,
        request_body_size: bodyBuffer ? bodyBuffer.length : 0,
        outcome: result.error
          ? "error"
          : conditionalHit
            ? "cache_hit"
            : "success",
        block_reason: result.error || null,
        response_status: result.status || null,
        response_body_size: result.body
          ? Buffer.isBuffer(result.body)
            ? result.body.length
            : Buffer.byteLength(result.body, "utf8")
          : 0,
        conditional_hit: conditionalHit,
        duration_ms: Date.now() - startTime,
      });

      // ── Enforce minimum delay ─────────────────────────────
      await enforceMinDelay(startTime, MIN_RESPONSE_DELAY_MS);

      // ── Cache body & return metadata only ──────────────────
      // The guest retrieves the body via sequential read() calls.
      // This gives a single code pattern regardless of response size.
      // Cache ALL non-error responses — even non-OK (4xx/5xx) bodies
      // contain useful info (API error messages, rate-limit details).
      if (!result.error) {
        const totalBytes = result.body
          ? Buffer.isBuffer(result.body)
            ? result.body.length
            : Buffer.byteLength(result.body, "utf8")
          : 0;

        const meta: ResponseMetadata = {
          contentType: result.contentType!,
          status: result.status!,
          ok: result.ok!,
        };
        if (Number.isFinite(result.contentLength)) {
          meta.contentLength = result.contentLength;
        }

        // Store body in cache (even for small responses — one
        // read() call with done:true handles those trivially).
        // Skip caching for HEAD requests — they have no body.
        if (method !== "HEAD") {
          responseCache.store(rawUrl, result.body || "", meta);
        }

        // Return metadata only — no body in the envelope
        const envelope: FetchResult = { ...meta, totalBytes };
        if (result.xRequestId) {
          envelope.xRequestId = result.xRequestId;
        }
        if (result.rateLimit) {
          envelope.rateLimit = result.rateLimit;
        }
        if (result.pagination) {
          envelope.pagination = result.pagination;
        }
        // Flag conditional cache hits so the LLM knows this
        // is a cached response (body unchanged from last fetch).
        if (conditionalHit) {
          envelope.cached = true;
        }
        return envelope;
      }

      return result;
    } finally {
      inFlightCount--;
    }
  }

  // ── Host function implementations ────────────────────────────

  // GET — always available
  function get(rawUrl: string, options?: FetchOptions): Promise<FetchResult> {
    const headers =
      options && typeof options === "object" ? options.headers : undefined;
    return handleRequest("GET", rawUrl, headers, null);
  }

  // HEAD — check URL status without downloading body
  // Returns: { status, ok, contentType, contentLength? } or { error }
  // Useful for verifying URLs exist before batch downloads
  function head(rawUrl: string, options?: FetchOptions): Promise<FetchResult> {
    const headers =
      options && typeof options === "object" ? options.headers : undefined;
    return handleRequest("HEAD", rawUrl, headers, null);
  }

  // read — sequential body reader. Returns { data, done }. When
  // done is true the cache entry is purged automatically. The
  // guest calls read(url) in a loop until done — same pattern
  // regardless of response size (small = one call, large = many).
  async function read(rawUrl: string): Promise<ReadResult> {
    if (!responseCache.has(rawUrl)) {
      return {
        error:
          "fetch error: no cached response for this URL (cache may have expired)",
      };
    }

    const chunk = responseCache.read(rawUrl);
    if (!chunk) {
      return {
        error:
          "fetch error: no cached response for this URL (cache may have expired)",
      };
    }

    return { data: chunk.data, done: chunk.done };
  }

  // readBinary — returns raw Buffer (top-level) → Uint8Array on guest.
  // Uses the fast binary sidecar path — no base64, no JSON wrapping.
  // Returns empty Buffer (length 0) when all data has been read.
  // Throws on error (since return type is Buffer, not object).
  async function readBinary(rawUrl: string): Promise<Buffer> {
    if (!responseCache.has(rawUrl)) {
      throw new Error(
        "fetch error: no cached response for this URL (cache may have expired)",
      );
    }

    const chunk = responseCache.readBinary(rawUrl);
    if (!chunk) {
      throw new Error(
        "fetch error: no cached response for this URL (cache may have expired)",
      );
    }

    // Return Buffer as top-level value for the fast binary transfer path.
    // Empty Buffer signals "done" (all data read).
    //
    // IMPORTANT: Copy the buffer data with Buffer.from() instead of returning
    // the subarray view directly. Buffer.subarray() creates a view into the
    // original buffer's memory. Between returning and napi reading the data,
    // a GC cycle could collect the backing ArrayBuffer if nothing else refs it.
    // napi_get_buffer_info would then get a dangling pointer → crash at
    // slice::from_raw_parts in js-host-api.
    // Buffer.from(view) creates an owned copy whose memory is guaranteed valid.
    return chunk.done ? Buffer.alloc(0) : Buffer.from(chunk.data);
  }

  // fetchJSON — convenience: GET + read all + parse JSON in one call.
  // Returns the parsed JSON object directly. No get+read loop needed.
  // Only works for responses that fit in the output buffer (~1MB).
  // THROWS on all errors including 429 — callers get a clear exception,
  // not a silent {error: "..."} object that masquerades as valid data.
  async function fetchJSON(
    rawUrl: string,
    options?: FetchOptions,
  ): Promise<unknown> {
    const headers =
      options && typeof options === "object" ? options.headers : undefined;
    const meta = await handleRequest("GET", rawUrl, headers, null);
    if (meta.error) throw new Error(meta.error);
    if (!meta.ok) {
      // 429: include rate limit info in error message for intelligent retry
      if (meta.status === 429) {
        const rl = meta.rateLimit;
        const retryInfo = rl?.retryAfterSecs
          ? ` Retry after ${rl.retryAfterSecs}s.`
          : "";
        const limitInfo =
          rl?.remaining != null
            ? ` (${rl.remaining}/${rl.limit} remaining)`
            : "";
        throw new Error(
          `fetchJSON: HTTP 429 (rate limited).${retryInfo}${limitInfo}`,
        );
      }
      throw new Error(`fetchJSON: HTTP ${meta.status}`);
    }

    // Read ALL chunks
    const chunks = [];
    let chunk;
    do {
      chunk = responseCache.read(rawUrl);
      if (!chunk) throw new Error("fetchJSON: response lost from cache");
      chunks.push(chunk.data);
    } while (!chunk.done);

    const body = chunks.join("");

    // Guard against oversized responses blowing through heap limits.
    // 1MB is reasonable for JSON APIs; larger responses should stream.
    const MAX_JSON_BYTES = 1024 * 1024;
    if (body.length > MAX_JSON_BYTES) {
      throw new Error(
        `fetchJSON: response too large ` +
          `(${body.length} bytes, max ${MAX_JSON_BYTES}). ` +
          `Use get() + read() loop to stream large responses instead.`,
      );
    }

    try {
      return JSON.parse(body);
    } catch {
      throw new Error(
        `fetchJSON: response is not valid JSON (${body.length} bytes). ` +
          `Use get() + read() to inspect the raw response.`,
      );
    }
  }

  // fetchText — convenience: GET + read all text content in one call.
  // Returns raw string content. Use for HTML, XML, plain text, etc.
  // Unlike fetchJSON, does NOT parse the response — returns it as-is.
  // THROWS on all errors including 429.
  //
  // Use case: fetching HTML pages for parsing with ha:html module.
  // Example: const html = await fetch.fetchText(url); const text = htmlToText(html);
  async function fetchText(
    rawUrl: string,
    options?: FetchOptions & { includeMeta?: boolean },
  ): Promise<string | { data: string; contentType: string; status: number }> {
    const headers =
      options && typeof options === "object" ? options.headers : undefined;
    const meta = await handleRequest("GET", rawUrl, headers, null);
    if (meta.error) throw new Error(meta.error);
    if (!meta.ok) {
      // 429: include rate limit info in error message for intelligent retry
      if (meta.status === 429) {
        const rl = meta.rateLimit;
        const retryInfo = rl?.retryAfterSecs
          ? ` Retry after ${rl.retryAfterSecs}s.`
          : "";
        const limitInfo =
          rl?.remaining != null
            ? ` (${rl.remaining}/${rl.limit} remaining)`
            : "";
        throw new Error(
          `fetchText: HTTP 429 (rate limited).${retryInfo}${limitInfo}`,
        );
      }
      throw new Error(`fetchText: HTTP ${meta.status}`);
    }

    // Read ALL chunks
    const chunks = [];
    let chunk;
    do {
      chunk = responseCache.read(rawUrl);
      if (!chunk) throw new Error("fetchText: response lost from cache");
      chunks.push(chunk.data);
    } while (!chunk.done);

    const body = chunks.join("");

    // Guard against oversized responses blowing through heap limits.
    // 2MB is reasonable for text content like HTML pages.
    const MAX_TEXT_BYTES = 2 * 1024 * 1024;
    if (body.length > MAX_TEXT_BYTES) {
      throw new Error(
        `fetchText: response too large ` +
          `(${body.length} bytes, max ${MAX_TEXT_BYTES}). ` +
          `Use get() + read() loop to stream large responses instead.`,
      );
    }

    // Return with metadata if requested
    if (options?.includeMeta) {
      return {
        data: body,
        contentType: meta.contentType || "text/plain",
        status: meta.status || 200,
      };
    }

    return body;
  }

  // fetchBinary — convenience: GET + read all binary chunks in one call.
  // Returns raw Uint8Array. Validates content-type is binary (image/*, etc).
  // THROWS on all errors including 429 — callers get a clear exception,
  // not a silent object that masquerades as valid Uint8Array data.
  //
  // Checks disk cache first (if enabled) before making network request.
  // Caches successful responses for future requests.
  async function fetchBinary(
    rawUrl: string,
    options?: FetchOptions,
  ): Promise<Uint8Array> {
    // Check disk cache first
    const cached = diskCache.get(rawUrl);
    if (cached) {
      // Validate cached content type is binary
      const ct = (cached.contentType || "").toLowerCase();
      const isBinaryType =
        ct.startsWith("image/") ||
        ct.startsWith("audio/") ||
        ct.startsWith("video/") ||
        ct === "application/octet-stream" ||
        ct === "application/pdf" ||
        ct === "application/zip" ||
        ct === "application/x-zip-compressed" ||
        ct === "application/gzip";
      if (isBinaryType) {
        return new Uint8Array(cached.data);
      }
      // Content type mismatch — fetch fresh
    }

    const headers =
      options && typeof options === "object" ? options.headers : undefined;
    const meta = await handleRequest("GET", rawUrl, headers, null);
    if (meta.error) throw new Error(meta.error);
    if (!meta.ok) {
      // 429: include rate limit info in error message for intelligent retry
      if (meta.status === 429) {
        const rl = meta.rateLimit;
        const retryInfo = rl?.retryAfterSecs
          ? ` Retry after ${rl.retryAfterSecs}s.`
          : "";
        const limitInfo =
          rl?.remaining != null
            ? ` (${rl.remaining}/${rl.limit} remaining)`
            : "";
        throw new Error(
          `fetchBinary: HTTP 429 (rate limited).${retryInfo}${limitInfo}`,
        );
      }
      throw new Error(`fetchBinary: HTTP ${meta.status}`);
    }

    // Validate content type is binary
    const ct = (meta.contentType || "").toLowerCase();
    const isBinaryType =
      ct.startsWith("image/") ||
      ct.startsWith("audio/") ||
      ct.startsWith("video/") ||
      ct === "application/octet-stream" ||
      ct === "application/pdf" ||
      ct === "application/zip" ||
      ct === "application/x-zip-compressed" ||
      ct === "application/gzip";

    if (!isBinaryType) {
      throw new Error(
        `fetchBinary: unexpected content-type "${meta.contentType}". ` +
          `Expected binary type (image/*, audio/*, application/pdf, etc). ` +
          `Use fetchJSON() for JSON or get()+read() for other text types.`,
      );
    }

    // Read ALL binary chunks
    const chunks = [];
    let chunk;
    do {
      chunk = responseCache.readBinary(rawUrl);
      if (!chunk) throw new Error("fetchBinary: response lost from cache");
      if (chunk.data.length > 0) chunks.push(chunk.data);
    } while (!chunk.done);

    // Combine into single Uint8Array
    const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const c of chunks) {
      result.set(c, offset);
      offset += c.length;
    }

    // Store in disk cache for future requests
    diskCache.set(rawUrl, Buffer.from(result), meta.contentType || ct);

    return result;
  }

  // fetchBinaryBatch — batch download: GET + read binary for multiple URLs.
  // Returns array of {url, data?, error?} objects in the SAME ORDER as input.
  // Best-effort: continues even if some URLs fail, returning errors inline.
  //
  // Parallelism is controlled by the `maxParallelFetches` config option:
  // - maxParallelFetches=1 (default): serial, one request at a time
  // - maxParallelFetches=N: up to N concurrent requests
  //
  // Rate limit handling (parallel mode):
  // - When ANY request gets 429, ALL parallel requests pause globally
  // - After the retry-after period, requests resume with jitter to prevent thundering herd
  // - This prevents hammering a rate-limited server with parallel retries
  //
  // Automatic retry: on 429/503, waits and retries with exponential backoff.
  async function fetchBinaryBatch(
    urls: string[],
    options?: FetchBinaryBatchOptions,
  ): Promise<FetchBinaryBatchResult[]> {
    if (!Array.isArray(urls)) {
      throw new Error(
        "fetchBinaryBatch: first parameter must be an array of URLs",
      );
    }
    const maxRetries = options?.maxRetries ?? 1;
    const baseDelayMs = options?.baseDelayMs ?? 1000;

    // Global pause state for coordinated 429 handling
    let globalPauseUntil = 0;
    let globalPauseReason = "";

    // Wait for global pause to clear, with jitter to prevent thundering herd
    async function waitForGlobalPause(): Promise<void> {
      const now = Date.now();
      if (globalPauseUntil <= now) return;

      const baseWait = globalPauseUntil - now;
      // Add 0-500ms jitter to stagger retry attempts
      const jitter = Math.random() * 500;
      const totalWait = baseWait + jitter;

      await new Promise((r) => setTimeout(r, totalWait));
    }

    // Set global pause - called when any request gets 429
    function setGlobalPause(waitMs: number, _reason: string): void {
      const pauseUntil = Date.now() + waitMs;
      // Only extend pause, never shorten it
      if (pauseUntil > globalPauseUntil) {
        globalPauseUntil = pauseUntil;
        globalPauseReason = _reason;
      }
    }

    // Helper: fetch a single URL with retries and global pause coordination
    async function fetchOneWithRetry(
      url: string,
    ): Promise<FetchBinaryBatchResult> {
      let lastError: string | null = null;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        // Wait for any global pause before attempting
        await waitForGlobalPause();

        try {
          const data = await fetchBinary(url);
          return { url, data };
        } catch (e: unknown) {
          const err = e as Error;
          lastError = err.message;
          // Retry on 429 (rate limited) or 503 (service unavailable)
          const isRetryable =
            err.message.includes("429") || err.message.includes("503");
          if (isRetryable && attempt < maxRetries) {
            // Extract retry-after if present, else use exponential backoff
            const retryMatch = err.message.match(/Retry after (\d+)s/);
            const waitMs = retryMatch
              ? parseInt(retryMatch[1], 10) * 1000
              : baseDelayMs * Math.pow(2, attempt);

            // In parallel mode, set global pause so ALL requests wait
            if (maxParallelFetches > 1) {
              setGlobalPause(waitMs, `429 from ${new URL(url).hostname}`);
            } else {
              // Serial mode: just wait locally
              await new Promise((r) => setTimeout(r, waitMs));
            }
            continue;
          }
          break;
        }
      }
      return { url, error: lastError ?? undefined };
    }

    // Serial mode (maxParallelFetches=1): original behavior
    if (maxParallelFetches === 1) {
      const results: FetchBinaryBatchResult[] = [];
      for (const url of urls) {
        results.push(await fetchOneWithRetry(url));
      }
      return results;
    }

    // Parallel mode: process in batches of maxParallelFetches
    // Results array maintains input order
    const results = new Array(urls.length);
    const pending = urls.map((url, index) => ({ url, index }));

    while (pending.length > 0) {
      // Wait for any global pause before starting a new batch
      await waitForGlobalPause();

      // Take up to maxParallelFetches items
      const batch = pending.splice(0, maxParallelFetches);
      const batchPromises = batch.map(async ({ url, index }) => {
        const result = await fetchOneWithRetry(url);
        results[index] = result;
      });
      await Promise.all(batchPromises);
    }

    return results;
  }

  // POST — gated by config, returns stub if not allowed
  function post(
    rawUrl: string,
    body?: unknown,
    options?: FetchOptions,
  ): Promise<FetchResult> {
    if (!allowPost) {
      // Return a promise with error to match expected async return type
      return Promise.resolve({ error: "fetch blocked: POST not allowed" });
    }
    const headers =
      options && typeof options === "object" ? options.headers : undefined;
    return handleRequest("POST", rawUrl, headers, body);
  }

  // Return the host functions keyed by module name
  return {
    fetch: {
      get,
      head,
      read,
      readBinary,
      fetchJSON,
      fetchText,
      fetchBinary,
      fetchBinaryBatch,
      post,
    },
  };
}

// ── Test-only exports ────────────────────────────────────────────────
// Exported for unit tests. NOT part of the public API.

export {
  isPrivateIp as _isPrivateIp,
  isPrivateIPv4 as _isPrivateIPv4,
  isPrivateIPv6 as _isPrivateIPv6,
  ipv4ToNumber as _ipv4ToNumber,
  ipv6ToGroups as _ipv6ToGroups,
  extractEmbeddedIPv4 as _extractEmbeddedIPv4,
  groupsToIPv4 as _groupsToIPv4,
  validateUrl as _validateUrl,
  parseDomainAllowlist as _parseDomainAllowlist,
  isDomainAllowed as _isDomainAllowed,
  buildRequestHeaders as _buildRequestHeaders,
  createRateLimiter as _createRateLimiter,
  createAuditLogger as _createAuditLogger,
  secureFetch as _secureFetch,
  secureFetchSingle as _secureFetchSingle,
  validateRedirectTarget as _validateRedirectTarget,
  safeNumericConfig as _safeNumericConfig,
  enforceMinDelay as _enforceMinDelay,
  categoriseRequestError as _categoriseRequestError,
  createResponseCache as _createResponseCache,
  extractRateLimitInfo as _extractRateLimitInfo,
  extractPaginationLinks as _extractPaginationLinks,
  extractConditionalValidators as _extractConditionalValidators,
  createConditionalCache as _createConditionalCache,
};
