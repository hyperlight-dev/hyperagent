# Modules

Hyperagent provides ES modules that handler code can import. Modules provide common functionality like encoding, compression, and file format builders.

## Importing Modules

Use the `ha:` prefix to import modules:

```javascript
import { encode, decode } from "ha:base64";
import { buildPptx, addSlide } from "ha:pptx";
import { set, get, clear } from "ha:shared-state";
```

## System Modules

Built-in modules available in every session:

### Core Utilities

| Module | Description |
|--------|-------------|
| `ha:str-bytes` | String↔binary conversion, uint LE encoding |
| `ha:crc32` | CRC-32 checksum for ZIP/PNG |
| `ha:base64` | Base64 encode/decode |
| `ha:xml-escape` | XML escaping + element builder |
| `ha:deflate` | DEFLATE compression (RFC 1951) |

### Shared State

| Module | Description |
|--------|-------------|
| `ha:shared-state` | Cross-handler key-value store |

Shared state persists across handler registrations and recompiles:

```javascript
import { set, get, clear, keys, has } from "ha:shared-state";

// Store data
set("results", { count: 42, items: [...] });

// Retrieve later (even from different handler)
const results = get("results");

// Check existence
if (has("results")) { ... }

// List all keys
const allKeys = keys();

// Clear everything
clear();
```

### Shared Infrastructure

| Module | Description |
|--------|-------------|
| `ha:doc-core` | Themes, colours, WCAG contrast, input validation (shared by all format modules) |

### File Formats

| Module | Description |
|--------|-------------|
| `ha:zip-format` | ZIP archive builder (DEFLATE compressed) |
| `ha:ooxml-core` | EMU conversions, themes, Content_Types, rels |
| `ha:pptx` | PowerPoint builder - layouts, shapes, notes |
| `ha:pptx-charts` | Bar, pie/donut, line, area, combo charts |
| `ha:pptx-tables` | Styled tables, key-value lists, comparisons |
| `ha:pdf` | PDF 1.7 document builder - flow layout, tables, images |
| `ha:pdf-charts` | PDF chart rendering - bar, line, pie, combo |

### Media Processing

| Module | Description |
|--------|-------------|
| `ha:image` | Image format detection and processing |
| `ha:html` | HTML parsing utilities |
| `ha:markdown` | Markdown processing |

## Module Information

Query module exports and documentation:

### list_modules Tool

```
LLM calls list_modules()

Result:
  System modules (12):
    ha:str-bytes (2.1 KB) - String/bytes utilities
    ha:crc32 (1.5 KB) - CRC-32 checksum
    ...

  User modules (2):
    ha:my-utils (0.8 KB) - Custom utilities
    ...
```

### module_info Tool

```
LLM calls module_info("pptx")

Result:
  Module: ha:pptx
  Exports:
    - buildPptx(slides, options): Buffer
    - addSlide(builder, layout, content): void
    - createTextBox(text, options): Shape
    ...

  Hints:
    Use buildPptx() to create a complete presentation.
    Layouts: 'title', 'content', 'two-column', 'section', ...
```

## User Modules

Create reusable modules at runtime via the `register_module` tool.

### Creating a Module

```
LLM calls register_module({
  name: "my-utils",
  source: `
    export function formatDate(date) {
      return date.toISOString().split('T')[0];
    }

    export function sum(numbers) {
      return numbers.reduce((a, b) => a + b, 0);
    }

    export const _HINTS = \`
      formatDate(date) - Format as YYYY-MM-DD
      sum(numbers) - Sum an array of numbers
    \`;
  `,
  description: "Common utility functions"
})
```

### Using a User Module

```javascript
import { formatDate, sum } from "ha:my-utils";

const today = formatDate(new Date());
const total = sum([1, 2, 3, 4, 5]);
```

### Module Persistence

User modules are persisted to `~/.hyperagent/modules/`:
- Survive across sessions
- Available in all projects
- Can be listed and deleted

### Deleting a Module

```
LLM calls delete_module("my-utils")
```

System modules cannot be deleted.

## Module Hints

Hints provide LLM-readable documentation for modules.

### System Modules: Structured Hints (JSON)

System modules use structured hints in a companion `.json` file:

```json
{
  "name": "pptx",
  "description": "PowerPoint builder",
  "hints": {
    "overview": "Build PPTX presentations with slides, shapes, and charts",
    "relatedModules": ["ooxml-core", "pptx-charts", "pptx-tables"],
    "requiredPlugins": ["fs-write"],
    "criticalRules": [
      "Call buildPptx() only once at the end",
      "Use theme colors from ha:ooxml-core"
    ],
    "antiPatterns": [
      "Don't write raw XML - use builder functions",
      "Don't create shapes at overlapping positions"
    ],
    "commonPatterns": [
      "Create presentation → add slides → build → write"
    ]
  }
}
```

Structured hints are queryable and used by the approach resolver.

### User Modules: Legacy _HINTS Export

User-created modules can export a `_HINTS` string:

```javascript
export const _HINTS = `
  formatDate(date) - Format as YYYY-MM-DD
  sum(numbers) - Sum an array of numbers
`;
```

The LLM reads hints via `module_info` to understand how to use the module.

## PPTX Module Details

The `ha:pptx` module is the most complex. Key exports:

### Building Presentations

```javascript
import { createPresentation } from "ha:pptx";

const pptx = createPresentation();
pptx.addSlide("title", {
  title: "My Presentation",
  subtitle: "A great topic"
});
pptx.addSlide("content", {
  title: "Key Points",
  bullets: ["Point 1", "Point 2", "Point 3"]
});
const buffer = pptx.build();
```

### Slide Layouts

| Layout | Content |
|--------|---------|
| `title` | Title + subtitle |
| `content` | Title + bullet points |
| `two-column` | Title + two columns |
| `section` | Section header |
| `blank` | Empty slide |
| `image` | Full-bleed image |
| `comparison` | Side-by-side comparison |

### Chart Support

```javascript
import { addBarChart, addPieChart } from "ha:pptx-charts";

addBarChart(slide, {
  title: "Sales by Region",
  series: [
    { name: "2024", data: [100, 200, 150] },
    { name: "2025", data: [120, 250, 180] }
  ],
  categories: ["North", "South", "West"]
});
```

### Table Support

```javascript
import { addTable } from "ha:pptx-tables";

addTable(slide, {
  headers: ["Name", "Value", "Status"],
  rows: [
    ["Item A", "100", "Active"],
    ["Item B", "200", "Pending"]
  ]
});
```

## Module Development

### TypeScript Modules (`builtin-modules/src/`)

Pure JavaScript modules written in TypeScript:

1. Create `builtin-modules/src/my-module.ts`
2. Export functions
3. Add companion JSON with structured hints
4. Run `npm run build:modules`
5. Commit the generated JSON

### Native Modules (`src/sandbox/runtime/modules/`)

Rust modules compiled into the QuickJS runtime via rquickjs:

| Module | Registered As | Description |
|--------|---------------|-------------|
| `native-deflate` | `ha:ziplib` | DEFLATE compress/decompress |
| `native-html` | `ha:html` | HTML tag stripping and text/link extraction |
| `native-image` | `ha:image` | Image dimension reading (PNG, JPEG, GIF, BMP) |
| `native-markdown` | `ha:markdown` | Markdown to HTML/plain text conversion |
| `native-globals` | _(globals)_ | TextEncoder, TextDecoder, atob, btoa, console |

Native modules are compiled into the hyperagent-runtime binary and registered at startup.

### Module Guidelines

- **Pure functions**: No side effects, no state (use `ha:shared-state` for state)
- **Type safety**: Use TypeScript for TS modules
- **Documentation**: Add structured hints in companion JSON
- **Small size**: Keep modules focused
- **No external dependencies**: Use only stdlib

## See Also

- [SKILLS.md](SKILLS.md) - Domain expertise
- [PROFILES.md](PROFILES.md) - Resource profiles
- [HOW-IT-WORKS.md](HOW-IT-WORKS.md) - System overview
