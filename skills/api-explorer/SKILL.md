---
name: api-explorer
description: Discover, test, and document public REST/GraphQL/JSON APIs — explore endpoints, inspect responses, and build integration guides
triggers:
  - API
  - endpoint
  - REST
  - GraphQL
  - swagger
  - openapi
  - API documentation
  - API reference
  - test endpoint
  - request
  - response
  - status code
  - rate limit
  - webhook
patterns:
  - fetch-and-process
  - data-extraction
  - two-handler-pipeline
  - file-generation
antiPatterns:
  - Don't hardcode API keys or secrets in handler code — authenticated APIs are not yet supported, stick to public endpoints
  - Don't ignore rate limits — add delays between requests and respect Retry-After headers
  - Don't assume JSON responses — always check content-type before parsing
  - Don't fetch OpenAPI/Swagger specs by scraping docs pages — look for /openapi.json, /swagger.json, or /api-docs endpoints first
  - Don't make destructive API calls (POST/PUT/DELETE) without explicit user confirmation via ask_user
  - Don't store full API responses in handler source — use ha:shared-state for large payloads
  - Don't skip error response documentation — 4xx/5xx responses are as important as 2xx
  - Don't ignore pagination — check for next/Link headers and follow them
  - Don't scrape SPA API documentation sites — fetch the OpenAPI spec directly or use raw API endpoints
  - Don't parse HTML documentation with regex — use ha:html parseHtml() if you must read docs pages
allowed-tools:
  - register_handler
  - execute_javascript
  - delete_handler
  - get_handler_source
  - edit_handler
  - list_handlers
  - reset_sandbox
  - list_modules
  - module_info
  - list_plugins
  - plugin_info
  - manage_plugin
  - list_mcp_servers
  - mcp_server_info
  - manage_mcp
  - apply_profile
  - configure_sandbox
  - sandbox_help
  - register_module
  - write_output
  - read_input
  - read_output
  - ask_user
---

# API Explorer

Guidance for discovering, testing, and documenting public REST and JSON APIs.

> **NOTE**: This skill is for **public, unauthenticated APIs only**. Authenticated API support (tokens, API keys, OAuth) is planned but not yet available — see SECRET-MANAGEMENT-DESIGN.md. Do not ask the user for API keys or tokens.

## Discovery Phase

Find the API surface before making requests:

1. **OpenAPI/Swagger spec first** — Check common spec paths before anything else:
   - `GET /openapi.json`
   - `GET /swagger.json`
   - `GET /api-docs`
   - `GET /v2/api-docs` (Spring Boot)
   - `GET /api/v1` or `/api/v2` (versioned roots)
2. **Root endpoint** — Many APIs return a resource index at the root (e.g., GitHub's `api.github.com`)
3. **Documentation pages** — Only as a last resort. If the docs site is an SPA (React, Next.js), the HTML will be empty. Prefer finding the raw spec URL

If you find an OpenAPI spec, parse it as JSON — it contains all endpoints, methods, parameters, and response schemas in machine-readable form.

## Testing Phase

For each endpoint you want to test:

1. **Start with GET** — Never make POST/PUT/DELETE calls without explicit user permission via `ask_user`
2. **Check status and content-type** — Use `f.get(url)` meta to verify before reading body
3. **Read the full response** — Use the standard fetch chunk loop: `f.read(url)` until done, collect chunks, join
4. **Inspect headers** — Note rate limit headers (`X-RateLimit-*`, `Retry-After`), pagination headers (`Link`), and caching headers (`ETag`, `Cache-Control`)
5. **Test edge cases** — Try invalid IDs, missing parameters, wrong content types to document error responses

### Handler Pattern

```javascript
// Handler 1: API Discovery + Testing
import * as f from "host:fetch";
import * as state from "ha:shared-state";

export function handler(event) {
  const { urls } = event;
  const results = [];

  for (const url of urls) {
    const meta = f.get(url);
    if (!meta.ok) {
      results.push({ url, error: meta.statusText, status: meta.status });
      continue;
    }

    const chunks = [];
    while (true) {
      const chunk = f.read(url);
      if (chunk.done) break;
      chunks.push(chunk.text);
    }

    const body = chunks.join("");
    const parsed = meta.contentType?.includes("json") ? JSON.parse(body) : body;

    results.push({
      url,
      status: meta.status,
      contentType: meta.contentType,
      data: parsed,
    });
  }

  state.set("api-results", JSON.stringify(results));
  return { tested: results.length, stored: "api-results" };
}
```

## Analysis Phase

After collecting responses:

1. **Infer schemas** — Look at response JSON structure: field names, types, nesting. Document as a table
2. **Identify pagination** — Look for `next`/`previous` fields, `Link` headers, `offset`/`limit`/`cursor` parameters
3. **Note rate limits** — Document limits from response headers (`X-RateLimit-Limit`, `X-RateLimit-Remaining`)
4. **Catalogue error formats** — How does the API return errors? `{ error: string }`, `{ message, code }`, HTTP status only?

## Documentation Phase

Produce clear, structured output:

### Endpoint Table Format

For each endpoint discovered, document:

| Method | Path       | Description    | Response Type | Paginated         |
| ------ | ---------- | -------------- | ------------- | ----------------- |
| GET    | /users     | List users     | Array of User | Yes (Link header) |
| GET    | /users/:id | Get user by ID | User object   | No                |

### Response Schema Format

For each unique response type, document field names and types:

| Field      | Type              | Description        |
| ---------- | ----------------- | ------------------ |
| id         | number            | Unique identifier  |
| name       | string            | Display name       |
| created_at | string (ISO 8601) | Creation timestamp |

### Output

Use `write_output` for the final documentation. Markdown is the default format. Include:

- API base URL and version
- Endpoint table with all discovered routes
- Response schemas with field descriptions
- Pagination pattern description
- Rate limit information
- Example request URLs (ready to use)
- Error response format

## Public API Examples

These APIs are known to be public and well-structured for exploration:

- **JSONPlaceholder** — `jsonplaceholder.typicode.com` — Fake REST API for testing (posts, comments, users, todos)
- **PokéAPI** — `pokeapi.co/api/v2` — Pokémon data with discoverable root, pagination, nested resources
- **Open-Meteo** — `api.open-meteo.com` — Weather forecasts via query parameters, no auth needed
- **REST Countries** — `restcountries.com/v3.1` — Country data by name, code, region
- **HTTPBin** — `httpbin.org` — Echo/test API for request inspection
- **Dog API** — `dog.ceo/api` — Random dog images, breeds list
- **Petstore** — `petstore3.swagger.io` — OpenAPI 3.0 spec available at `/api/v3/openapi.json`
