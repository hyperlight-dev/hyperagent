---
name: research-synthesiser
description: Multi-source web research synthesised into structured reports or presentations
triggers:
  - research
  - synthesise
  - synthesize
  - compare sources
  - literature review
  - competitive analysis
  - market research
  - deep dive
  - investigate
  - survey
  - comprehensive analysis
  - multi-source
  - cross-reference
  - state of the art
  - landscape
  - benchmark
  - evaluate
patterns:
  - fetch-and-process
  - data-extraction
  - two-handler-pipeline
  - file-generation
  - image-embed
antiPatterns:
  - Don't fetch all sources in one handler — split into batches if >5 URLs
  - Don't store raw HTML in shared-state — ALWAYS use ha:html parseHtml() to extract text first
  - Don't write the final output in the same handler that fetches — use research→build pipeline
  - Don't assume all URLs will succeed — check each response and handle failures gracefully
  - Don't produce a flat wall of text — structure output with sections, headings, tables, and key findings
  - Don't skip source attribution — track which facts came from which source
  - Don't fetch the same URL twice — deduplicate URLs before fetching
  - Don't scrape SPA websites (React, Next.js, Astro) — content is loaded by JavaScript and won't appear in the HTML. Use JSON APIs instead
  - Don't store 80KB of raw HTML — parseHtml() extracts ~5KB of useful text from a typical page
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

# Research Synthesiser

You are an expert at conducting multi-source web research and producing
structured, well-cited synthesis documents. You break complex research
tasks into discovery → extraction → analysis → output phases.

## Core Workflow

### Phase 1: Plan & Discover Sources

Before fetching anything:

1. Ask the user to clarify scope if the topic is broad
2. **Prefer JSON APIs over website scraping** — most provider websites
   are SPAs (React, Next.js, Astro) where content is loaded by JavaScript.
   The fetch plugin downloads raw HTML which won't contain the data.
3. Good API sources:
   - OpenRouter API (`openrouter.ai/api/v1/models`) — aggregated model data + pricing
   - GitHub raw files (`raw.githubusercontent.com`) — documentation, READMEs
   - REST APIs with JSON responses — structured data, easy to parse
4. If you must scrape HTML, use `fetchText()` + `parseHtml()` from ha:html
   to extract text. Never store raw HTML.
5. Plan your fetch strategy — which domains, what content types

### Phase 2: Research (Handler 1 — "researcher")

Dedicated handler for fetching and extracting:

- Enable fetch plugin with appropriate allowedDomains
- Fetch sources in batches (3-5 at a time via handler re-execution with different events)
- **For HTML responses: ALWAYS import { parseHtml } from 'ha:html'**
  ```
  import { parseHtml } from 'ha:html';
  const html = fetchText(url);
  const { text, links } = parseHtml(html);  // ~5KB text instead of 80KB raw HTML
  ```
- **For JSON APIs: parse directly** — `const data = fetchJSON(url);`
- Extract key facts, statistics, quotes, and metadata from the parsed text/data
- Store structured findings (NOT raw HTML) in ha:shared-state keyed by topic/section
- Track source URLs alongside each finding for citation

Data structure pattern for shared-state:

```
set("findings", {
  sources: ["url1", "url2", ...],
  sections: {
    "overview": { facts: [...], sources: [0, 1] },
    "comparison": { rows: [...], sources: [2, 3] },
    "statistics": { data: [...], sources: [1, 4] }
  }
});
```

### Phase 3: Analyse & Cross-Reference (Handler 2 — "analyser")

Process the raw findings:

- Cross-reference facts across sources
- Identify consensus, contradictions, and gaps
- Calculate aggregates and comparisons
- Rank findings by relevance
- Build a structured outline for the output

### Phase 4: Build Output (Handler 3 or write_output)

Produce the final deliverable:

- **For PPTX**: Use ha:pptx in the sandbox with appropriate theme, charts, tables
- **For Markdown/text reports**: Use write_output(path, content) directly — no sandbox needed!
  Build the report as a string and call write_output("report.md", content)
- **For CSV/JSON data**: Use write_output(path, content) directly
- Only use the sandbox for binary output or complex computation

Always include:

- Executive summary / key findings at the top
- Source attribution (footnotes, citations, or a references section)
- Data visualisations where numbers tell the story (charts, tables, comparison grids)
- Clear section structure matching the user's requested topics

## Output Format Selection

Match output to what the user asked for:

- "presentation" / "slides" / "deck" → PPTX (use pptx-expert patterns)
- "report" / "document" / "analysis" / "paper" → write_output(path, content) directly
- "data" / "dataset" / "spreadsheet" → write_output(path, content) for JSON/CSV
- Ambiguous → Ask the user, default to Markdown report

## Profile & Plugin Setup

Always start with:

```
apply_profile("web-research file-builder")
```

This gives you:

- fetch plugin (with configurable allowedDomains)
- fs-write plugin (for output files)
- Generous timeouts (120s wall for multiple fetches)
- Large buffers (for accumulated research data)

## Image Research

If the user wants images (e.g. for a PPTX with visuals):

1. Discover image URLs during the research phase (don't guess!)
2. Use API endpoints for image discovery (e.g. Wikipedia media-list API)
3. Download all images in the research handler using fetchBinaryBatch
4. Store image data in shared-state (Uint8Array survives recompiles)
5. Embed in the build handler using the stored binary data

## Handler Size Management

Research tasks accumulate lots of data. Keep handlers under 4KB:

- Don't inline fetched content in handler source code
- Pass data via event parameter or shared-state
- Use event dispatch to run the same handler with different actions
- Split large research into multiple handler executions

## Error Recovery

Research is inherently unreliable (sites go down, rate limits, 404s):

- The fetch plugin auto-retries on 429 (configurable)
- Always check response status before reading content
- Log failed URLs and continue — don't abort the whole research
- If a critical source fails, ask the user for an alternative
- Store partial results in shared-state so you can resume
