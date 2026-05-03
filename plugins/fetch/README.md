# 🌐 fetch Plugin

> But only over HTTPS, to allowlisted domains, after DNS validation.

Secure HTTPS-only network access for the Hyperlight sandbox. Default-deny
domain allowlist, SSRF protection, rate limiting, audit logging, and
timing side-channel mitigation.

**Version:** 1.0.0  
**Host Module:** `host:fetch`

## Quick Start

```
You: /plugin enable fetch allowedDomains=api.github.com,*.example.com
```

Guest code:

```javascript
const fetch = require("host:fetch");

// GET returns metadata only — body is read separately
const res = fetch.get("https://api.github.com/repos/deislabs/hyperlight");
if (res.error) {
  console.log("Failed:", res.error);
} else {
  // Read the body (same pattern for small or large responses)
  let body = "";
  let chunk;
  do {
    chunk = fetch.read("https://api.github.com/repos/deislabs/hyperlight");
    body += chunk.data;
  } while (!chunk.done);

  if (res.contentType === "application/json") {
    const data = JSON.parse(body);
    console.log(data.full_name); // "deislabs/hyperlight"
  }
}
```

## Security Model

This is the most security-sensitive plugin — it opens a controlled channel
between untrusted guest code and the internet.

| Layer                              | Defence                                                                                                        |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Default-deny allowlist**         | No domains accessible unless explicitly configured. Empty list = all blocked.                                  |
| **HTTPS-only**                     | HTTP rejected at URL validation. TLS 1.2+ enforced, `rejectUnauthorized: true`.                                |
| **SSRF protection (DNS)**          | All resolved A/AAAA records checked against 13 private IPv4 CIDR ranges + IPv6 ranges before connection.       |
| **SSRF protection (post-connect)** | After TCP/TLS handshake, `socket.remoteAddress` re-checked (defence-in-depth against DNS rebinding / TOCTOU).  |
| **IPv4-mapped IPv6**               | `::ffff:127.0.0.1`, NAT64 `64:ff9b::`, 6to4, and Teredo prefixes extracted and re-checked as IPv4.             |
| **No redirects**                   | HTTP 3xx responses returned as-is. No redirect following = no open-redirect chains.                            |
| **Header injection**               | CRLF/NUL characters rejected. Forbidden headers stripped. Value length limited to 4KB.                         |
| **Domain validation**              | Rejects `*`, `*.com` (shallow TLD), `*.*.com` (multi-level), `api.*.com` (non-prefix). Normalised to punycode. |
| **Non-standard ports**             | Only default HTTPS port (443) allowed. Explicit port numbers rejected.                                         |
| **Rate limiting**                  | Per-minute sliding window, per-hour cap, per-session unique domain count, per-session data budget.             |
| **Timing side-channel**            | 200ms minimum response delay on ALL code paths (blocked, allowed, error).                                      |
| **Connection isolation**           | `keepAlive: false`, `maxSockets: 1` per request. No connection reuse.                                          |
| **Single in-flight**               | Promise mutex — only one request at a time. No concurrency.                                                    |
| **Audit logging**                  | JSONL to `~/.hyperagent/fetch-log.jsonl`. File mode `0600`. Auto-rotation at 5000 entries.                     |
| **Content-Type gating**            | Response Content-Type must match the allowlist. Non-matching types rejected.                                   |
| **SSRF masking**                   | Private/internal IP blocking masked behind generic `fetch failed: request error` to avoid leaking topology.    |

## Configuration

Only two fields are prompted interactively during `/plugin enable` (via
the `promptKeys` feature). All others use safe defaults and can be
overridden via inline config.

| Field                     | Type      | Default                               | Prompted | Description                                                               |
| ------------------------- | --------- | ------------------------------------- | -------- | ------------------------------------------------------------------------- |
| `allowedDomains`          | `array`   | _(none)_                              | ✅       | Allowed domains. Empty = all blocked. Supports `*.example.com` wildcards. |
| `allowPost`               | `boolean` | `false`                               | ✅       | Enable POST requests (GET always available).                              |
| `allowedRequestHeaders`   | `array`   | `Authorization, Content-Type, Accept` | ❌       | Headers the guest may set.                                                |
| `allowedContentTypes`     | `array`   | `application/json, text/*`            | ❌       | Allowed response Content-Type prefixes.                                   |
| `userAgent`               | `string`  | `hyperlight-fetch/1.0`                | ❌       | Static User-Agent header sent on all requests.                            |
| `connectTimeoutMs`        | `number`  | `5000`                                | ❌       | TCP+TLS connect timeout (1000-10000ms).                                   |
| `readTimeoutMs`           | `number`  | `10000`                               | ❌       | Read timeout (1000-30000ms).                                              |
| `maxResponseSizeKb`       | `number`  | `1024`                                | ❌       | Max response body (1-65536 KB).                                           |
| `readSizeKb`              | `number`  | `48`                                  | ❌       | Max body returned per read() call (8-256 KB).                             |
| `responseCacheTtlSeconds` | `number`  | `300`                                 | ❌       | Response body cache TTL on host (30-600s).                                |
| `maxRequestBodySizeKb`    | `number`  | `4`                                   | ❌       | Max POST body (1-64 KB).                                                  |
| `maxRequestsPerMinute`    | `number`  | `30`                                  | ❌       | Sliding window per-minute cap (1-60).                                     |
| `maxRequestsPerHour`      | `number`  | `100`                                 | ❌       | Per-session hourly cap (1-500).                                           |
| `maxDomainsPerSession`    | `number`  | `5`                                   | ❌       | Unique domains per session (1-20).                                        |
| `maxDataReceivedKb`       | `number`  | `2048`                                | ❌       | Total data budget per session (1-1048576 KB).                             |
| `returnXRequestId`        | `boolean` | `false`                               | ❌       | Include `X-Request-Id` in response.                                       |

### Inline Config Examples

```
/plugin enable fetch allowedDomains=api.github.com
/plugin enable fetch allowedDomains=api.github.com,*.example.com allowPost=true
/plugin enable fetch allowedDomains=api.github.com maxRequestsPerMinute=10 maxResponseSizeKb=65536 maxDataReceivedKb=1048576
```

## Functions

### `fetch.get(url)` / `fetch.get(url, options)`

HTTPS GET request. Returns **metadata only** — the response body is cached
host-side and retrieved via `fetch.read(url)`.

- **Input:** URL string, optional `{ headers: { ... } }` object
- **Returns:** `{ status, ok, contentType, totalBytes }` on success, `{ error: string }` on failure
- **Note:** `contentLength` (number) is included when the server sends a Content-Length header. The body is **not** included — use `fetch.read(url)` to read it.

### `fetch.read(url)`

Sequential body reader. Returns the next chunk of a previously fetched response.

- **Input:** URL string (must match a prior `get()` or `post()` call)
- **Returns:** `{ data, done }` — `data` is a string, `done` is a boolean
- **Note:** Call in a loop until `done === true`. The cache is automatically purged when the last chunk is read. If the cache has expired (TTL), returns `{ error: "fetch error: no cached response for this URL (cache may have expired)" }` — re-fetch with `get()`.

### `fetch.post(url, body)` / `fetch.post(url, body, options)`

HTTPS POST request (requires `allowPost: true`). Returns **metadata only**,
same as `get()`.

- **Input:** URL string, JSON-serialisable body, optional `{ headers: { ... } }` object
- **Returns:** `{ status, ok, contentType, totalBytes }` on success, `{ error: string }` on failure
- **Note:** if POST is disabled, returns `{ error: "fetch blocked: POST not allowed" }`. Use `fetch.read(url)` to read the response body.

### `fetch.fetchJSON(url)` / `fetch.fetchJSON(url, options)`

Convenience function: GET + read all + parse JSON in one call.

- **Input:** URL string, optional `{ headers: { ... } }` object
- **Returns:** Parsed JSON object directly
- **Throws:** Error on fetch errors, non-2xx responses (including 429), non-JSON content, or oversized responses (>512KB)
- **429 Error:** Includes rate limit info in the error message: `"fetchJSON: HTTP 429 (rate limited). Retry after 60s. (0/100 remaining)"`

### `fetch.fetchBinary(url)` / `fetch.fetchBinary(url, options)`

Convenience function: GET + read all binary chunks in one call.

- **Input:** URL string, optional `{ headers: { ... } }` object
- **Returns:** `Uint8Array` of the response body (always — never returns an object)
- **Throws:** Error on fetch errors, non-2xx responses (including 429), or non-binary content type
- **429 Error:** Includes rate limit info in the error message: `"fetchBinary: HTTP 429 (rate limited). Retry after 60s. (0/100 remaining)"`
- **Note:** Validates Content-Type is binary (image/\*, audio/\*, video/\*, application/octet-stream, application/pdf, application/zip, etc.)

## Error Categories

Errors are returned as `{ error: "..." }` for low-level functions (`get`, `post`, `read`)
or thrown as exceptions for convenience functions (`fetchJSON`, `fetchBinary`).
The system message includes all categories so the LLM knows which are retryable and which are permanent.

### Permanent Errors (do NOT retry)

| Error                                                    | Meaning                                 |
| -------------------------------------------------------- | --------------------------------------- |
| `fetch blocked: domain not in allowlist`                 | URL domain isn't in the configured list |
| `fetch blocked: POST not allowed`                        | POST disabled in config                 |
| `fetch blocked: only HTTPS is permitted`                 | Use `https://` URLs                     |
| `fetch blocked: non-standard port not permitted`         | Only default 443 is allowed             |
| `fetch blocked: IP addresses not permitted, use domains` | Use a domain name, not an IP            |
| `fetch blocked: invalid URL`                             | Malformed URL                           |
| `fetch blocked: invalid URL characters`                  | URL contains invalid characters         |
| `fetch blocked: URL too long`                            | Shorten the URL                         |
| `fetch blocked: path+query too long`                     | Shorten the path                        |
| `fetch blocked: credentials in URL not permitted`        | Use Authorization header instead        |
| `fetch blocked: path traversal not permitted`            | Remove `..` segments                    |
| `fetch blocked: invalid hostname`                        | Use a valid FQDN                        |
| `fetch blocked: invalid header value`                    | Fix the header value                    |
| `fetch blocked: header value too large`                  | Shorten the header                      |
| `fetch blocked: body is not JSON-serialisable`           | Fix the POST body                       |
| `fetch blocked: body must be a string or object`         | Fix the POST body                       |
| `fetch blocked: request body too large`                  | Reduce body size                        |

### Session Limit Errors (do NOT retry this session)

| Error                                           | Meaning                         |
| ----------------------------------------------- | ------------------------------- |
| `fetch blocked: rate limit exceeded (per-hour)` | Session hourly limit reached    |
| `fetch blocked: too many unique domains`        | Session domain budget exhausted |
| `fetch blocked: data budget exhausted`          | Session data budget exhausted   |

### Transient Errors (may retry)

| Error                                             | Advice                                  |
| ------------------------------------------------- | --------------------------------------- |
| `fetch blocked: rate limit exceeded (per-minute)` | Wait 60s and retry                      |
| `fetch blocked: response too large`               | Try a smaller resource or paginated API |
| `fetch blocked: content type not permitted`       | Response Content-Type not in allowlist  |
| `fetch blocked: request already in flight`        | Wait for previous request, then retry   |
| `fetch failed: timeout`                           | Transient, may retry once               |
| `fetch failed: request error`                     | Transient network issue, may retry once |
| `fetch failed: request aborted`                   | Transient, may retry once               |

> **Note:** SSRF protection (private/internal IP blocking) is intentionally
> masked behind generic `fetch failed: request error` to avoid leaking
> infrastructure topology to the sandbox.

## Guest Usage Examples

```javascript
const fetch = require("host:fetch");

// --- Helper to read the full body ---
function readBody(url) {
  let body = "";
  let chunk;
  do {
    chunk = fetch.read(url);
    body += chunk.data;
  } while (!chunk.done);
  return body;
}

// Simple GET — result is metadata, body is read separately
const url = "https://api.example.com/data";
const res = fetch.get(url);
if (res.error) {
  console.log("Error:", res.error);
} else {
  const body = readBody(url);
  if (res.contentType === "application/json") {
    const data = JSON.parse(body);
    console.log(data);
  } else {
    console.log(body); // HTML, plain text, etc.
  }
}

// GET with headers
const authedUrl = "https://api.example.com/me";
const authed = fetch.get(authedUrl, {
  headers: { Authorization: "Bearer token123" },
});
if (authed.ok) {
  const profile = JSON.parse(readBody(authedUrl));
  console.log(profile);
}

// POST (if enabled)
const postUrl = "https://api.example.com/submit";
const posted = fetch.post(
  postUrl,
  { key: "value" },
  { headers: { "Content-Type": "application/json" } },
);
if (posted.ok) {
  const result = JSON.parse(readBody(postUrl));
  console.log(result);
}
```

## Enable Example

```
You: /plugin enable fetch allowedDomains=api.github.com,*.example.com
  🔍 Auditing "fetch"...
  ⚙️  Configure "fetch":
     allowedDomains []: api.github.com, *.example.com  <-- from inline config
     Allow POST requests? [n]: n
  ℹ️  12 advanced settings using defaults. Use inline config to override.
  ✅ Plugin "fetch" enabled.
```

## Audit Logging

All requests are logged to `~/.hyperagent/fetch-log.jsonl` (JSONL
format, file mode `0600`). Each entry includes:

- Timestamp, session ID, request method, URL, domain
- Whether the request was allowed or blocked
- Response status code and body size (if allowed)
- Error message (if blocked)

The log auto-rotates at 5000 entries, keeping the newest half. Rotation
is throttled to every 50 writes to avoid I/O overhead.
