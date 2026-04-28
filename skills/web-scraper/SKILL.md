---
name: web-scraper
description: Extract data from web pages using fetch plugin and ha:html/ha:markdown
triggers:
  - scrape
  - extract
  - crawl
  - website
  - HTML
  - parse
  - web page
  - webpage
  - URL
patterns:
  - fetch-and-process
  - data-extraction
antiPatterns:
  - Don't use string concatenation for fetch chunk assembly — use array push + join
  - Don't parse HTML with regex — use ha:html parseHtml() or htmlToText()
  - Don't fetch without checking meta.ok first — handle HTTP errors
  - Don't hardcode URLs — pass them via event parameter
  - Don't scrape SPA websites (React, Next.js, Astro) — content is loaded by JavaScript. Use JSON APIs or look for API endpoints instead
  - Don't store raw HTML — use parseHtml() to extract text first
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

## Web Scraping Guidance

ALWAYS use the two-step fetch pattern:

1. `f.get(url)` → check `meta.ok` and `meta.contentType`
2. `f.read(url)` in a loop → collect chunks → join

For HTML content:

- `parseHtml(html)` returns `{text, links}` — most efficient for both
- `htmlToText(html)` if you only need text
- `extractLinks(html)` if you only need links

For Markdown content (e.g. GitHub READMEs):

- `markdownToText(md)` strips formatting
- `markdownToHtml(md)` converts to HTML (then use `htmlToText` if needed)

For structured data:

- Parse JSON responses directly
- Filter links by href pattern for navigation
- Use ha:shared-state to pass data to a build handler

Required plugin config:

- `fetch.allowedDomains` MUST be set (comma-separated)
- Enable appropriate content types in `allowedContentTypes`
