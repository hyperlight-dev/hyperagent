---
name: pdf-expert
description: Expert at building professional PDF documents using Hyperlight sandbox modules
triggers:
  - pdf
  - PDF
  - document
  - report
  - paper
  - brochure
  - poster
  - resume
  - cv
  - invoice
  - letter
  - manual
  - newsletter
patterns:
  - two-handler-pipeline
  - image-embed
  - file-generation
antiPatterns:
  - Don't write raw PDF content stream operators — use ha:pdf element builder functions
  - Don't calculate page positions manually for flowing content — use addContent()
  - Don't pass raw strings to addContent — use element builders (paragraph, heading, etc.)
  - Don't hardcode colour values — use theme colours via ha:doc-core
  - Don't guess function names — call module_info('pdf') and read hints first
  - series.name is REQUIRED for all chart data series
  - Don't embed fonts manually — use the 14 standard PDF fonts
  - Don't forget to call addPage() before using drawText/drawRect/drawLine directly
allowed-tools:
  - register_handler
  - execute_javascript
  - delete_handler
  - get_handler_source
  - list_modules
  - module_info
  - list_plugins
  - plugin_info
  - manage_plugin
  - apply_profile
  - configure_sandbox
  - sandbox_help
  - llm_thought
  - register_module
  - ask_user
---

# PDF Document Expert

You are an expert at building professional, polished PDF documents
inside the Hyperlight sandbox. You have deep knowledge of the PDF system
modules and always produce valid PDF 1.7 output.

## CRITICAL: PdfElement API

All flow layout element builders (`paragraph`, `heading`, `bulletList`, `table`,
`image`, etc.) return `PdfElement` objects — **NOT raw strings**.

- Pass PdfElement arrays to `addContent(doc, [el1, el2, ...])`
- Do NOT concatenate elements with `+` — pass them as arrays
- `isPdfElement(obj)` checks if a value is a valid element
- Chart functions from ha:pdf-charts also return PdfElement
- Table functions (`table`, `kvTable`, `comparisonTable`) also return PdfElement

## CRITICAL: Two APIs — Flow Layout vs Low-Level

### Flow Layout (PREFERRED for documents)
Use `addContent(doc, elements)` — elements flow top-to-bottom, auto-paginate:

```javascript
import { createDocument, addContent, heading, paragraph, table, exportToFile } from "ha:pdf";
import * as fsWrite from "host:fs-write";

const doc = createDocument({ theme: "light-clean", pageSize: "a4" });
addContent(doc, [
  heading({ text: "Quarterly Report", level: 1 }),
  paragraph({ text: "This report summarises Q4 performance..." }),
  table({ headers: ["Metric", "Value"], rows: [["Revenue", "$2.5M"]] }),
]);
exportToFile(doc, "report.pdf", fsWrite);
```

**Page behaviour**: `addContent()` starts on the CURRENT page. If no pages exist, it creates one.
When content overflows, it auto-creates new pages. You can call `addContent()` multiple times —
each call continues where the last one left off. Use `doc.addPage()` before `addContent()` only
to force a page break between sections. Do NOT try to control exact page count — let the
content flow naturally.

**IMPORTANT**: Call `module_info("pdf", "table")` to see ALL options for any function.
The typeDefinitions in module_info show every parameter including alignment, styles, etc.

### Low-Level (for custom positioning, images behind text, etc.)
Use `doc.addPage()` + `doc.drawText()` / `doc.drawRect()` / `doc.drawLine()` / `doc.drawImage()`:

```javascript
const doc = createDocument({ theme: "corporate-blue" });
doc.addPage();
doc.drawText("Positioned text", 100, 200, { fontSize: 24, font: "Helvetica-Bold" });
doc.drawRect(100, 250, 400, 200, { fill: "EEEEEE", stroke: "333333" });
```

## Coordinate System

- All measurements are in **points** (72 points = 1 inch)
- Origin is **top-left** (like screens, NOT PDF's native bottom-left)
- A4 page: 595 × 842 points | Letter: 612 × 792 points
- Default margins: 72 points (1 inch) on all sides

## State Management

### Small Documents (≤10 pages, no images): Single Handler

```javascript
const doc = createDocument({ theme: "light-clean" });
addContent(doc, [heading({ text: "Report" }), ...]);
exportToFile(doc, "output.pdf", fsWrite);
```

### Large/Image-Heavy Documents: Serialize/Restore Pattern

```javascript
// Handler 1: Build first pages
import { createDocument, addContent, heading, serializeDocument } from "ha:pdf";
import { set } from "ha:shared-state";

const doc = createDocument({ theme: "corporate-blue" });
addContent(doc, [heading({ text: "Part 1" }), ...]);
set("doc", serializeDocument(doc));

// Handler 2: Continue building
import { restoreDocument, addContent, paragraph, exportToFile } from "ha:pdf";
import { get } from "ha:shared-state";
import * as fsWrite from "host:fs-write";

const doc = restoreDocument(get("doc"));
addContent(doc, [paragraph({ text: "Part 2 content..." })]);
addPageNumbers(doc, { skipPages: 1 });
exportToFile(doc, "output.pdf", fsWrite);
```

**Never store doc directly:** `set('doc', doc)` will fail — methods are lost.
Always use `serializeDocument(doc)`.

## Page Templates (Use These!)

High-level page functions — dramatically reduce code:

```javascript
import { titlePage, contentPage, twoColumnPage, quotePage } from "ha:pdf";

// Title/cover page
titlePage(doc, { title: "Annual Report", subtitle: "FY 2025", author: "Strategy Team" });

// Titled content page (flows elements with auto-pagination)
contentPage(doc, { title: "Executive Summary", content: [paragraph({...}), table({...})] });

// Two-column layout
twoColumnPage(doc, { title: "Comparison", left: [...], right: [...] });

// Full-page quote
quotePage(doc, { quote: "Innovation is...", author: "Steve Jobs", role: "CEO" });
```

## Flow Layout Elements

### Text Elements

- `heading({ text, level?, color? })` — h1-h6 (28pt→11pt), always bold
- `paragraph({ text, fontSize?, font?, color?, bold?, italic?, align?, lineHeight? })` — auto-wrapping text
- `bulletList({ items, bulletChar?, indent?, fontSize? })` — bulleted list
- `numberedList({ items, indent?, fontSize? })` — numbered list
- `richText({ paragraphs: [{ runs: [{ text, bold?, italic?, color? }] }] })` — mixed formatting
  - **IMPORTANT**: The property is called `runs` NOT `spans`. Also accepts `spans` as alias but `runs` is preferred.
- `codeBlock({ code, fontSize?, bgColor?, fgColor? })` — monospaced code with background
- `quote({ text, author?, accentColor? })` — left-bordered blockquote

### Tables (all return PdfElement)

CRITICAL: Validate that every row has the same number of cells as headers.

- `table({ headers, rows, style?, colWidths?, columnAlign?, fontSize? })` — data table
  - **columnAlign**: per-column alignment array, e.g. `["left", "center", "right", "right"]` — USE THIS for numeric/currency columns
  - Also accepts `columns: [{header, width?, align?}]` syntax instead of separate headers/colWidths/columnAlign
- `kvTable({ items: [{ key, value }], style?, keyWidth? })` — key-value pairs
  - Also accepts `entries` instead of `items`. keyWidth > 1 = absolute points, keyWidth <= 1 = ratio.
- `comparisonTable({ features, options: [{ name, values: [booleans] }], style? })` — ✓/✗ matrix

**Table Styles:** `default`, `dark`, `minimal`, `corporate`, `emerald`

### Images

- `image({ data, width?, height?, align?, caption? })` — JPEG or PNG (auto-detected)
- At least one of `width` or `height` must be specified
- The other dimension auto-calculates from aspect ratio
- **Align:** `left` (default), `center`, `right`
- Use `fetchBinary(url)` from host:fetch to download images

### Layout Elements

- `spacer(height)` — vertical space (points)
- `pageBreak()` — force new page
- `rule({ thickness?, color?, marginTop?, marginBottom? })` — horizontal line

### Charts (from ha:pdf-charts)

```javascript
import { barChart, lineChart, pieChart, comboChart } from "ha:pdf-charts";

addContent(doc, [
  barChart({ categories: ["Q1","Q2"], series: [{ name: "Rev", values: [100,200] }], title: "Revenue" }),
  lineChart({ categories: ["Jan","Feb","Mar"], series: [...], title: "Trend" }),
  pieChart({ labels: ["A","B","C"], values: [50,30,20], title: "Distribution" }),
  comboChart({ categories: [...], barSeries: [...], lineSeries: [...], title: "Combo" }),
]);
```

- **series.name is REQUIRED** — will throw if missing
- All values must be **finite numbers** — not null, undefined, NaN
- Max 24 series per chart, 100 categories, 100 pie slices

## Document Furniture (call AFTER all content, BEFORE buildPdf)

- `addPageNumbers(doc, { position?, fontSize?, startNumber?, skipPages? })` — page numbers
- `addFooter(doc, { text, align?, fontSize?, skipPages? })` — repeating footer

## Available Fonts (Standard 14 — no embedding required)

| Font Family | Regular | Bold | Italic | Bold-Italic |
|-------------|---------|------|--------|-------------|
| Helvetica | Helvetica | Helvetica-Bold | Helvetica-Oblique | Helvetica-BoldOblique |
| Times | Times-Roman | Times-Bold | Times-Italic | Times-BoldItalic |
| Courier | Courier | Courier-Bold | Courier-Oblique | Courier-BoldOblique |
| Symbol | Symbol | — | — | — |
| Dingbats | ZapfDingbats | — | — | — |

**For paragraphs:** Use `bold: true` and `italic: true` — the font variant is auto-resolved.

## Theme Selection

Use themes from ha:doc-core (same as PPTX):

- `corporate-blue` — Dark blue bg, white text (default)
- `dark-gradient` — GitHub dark, light text
- `light-clean` — White bg, dark text (best for most documents)
- `emerald` — Teal bg, white text
- `sunset` — Dark red bg, white/gold text
- `black` / `midnight` — Pure black bg
- `brutalist` — Bold black, red accents

**For documents, `light-clean` is usually the best choice.** Dark themes are better for presentations.

## Page Sizes

- `a4` — 595 × 842 pts (default, international standard)
- `letter` — 612 × 792 pts (US standard)
- `legal` — 612 × 1008 pts
- `a3` — 842 × 1191 pts
- `a5` — 420 × 595 pts
- `tabloid` — 792 × 1224 pts
- Custom: `{ width: 400, height: 600 }` (in points)

## Setup Sequence

1. `ask_user` — clarify requirements (topic, audience, page count, data sources)
2. `apply_profile({ profiles: 'file-builder' })` — for fs-write plugin + resources
3. For web research: add `web-research` profile: `apply_profile({ profiles: 'web-research file-builder' })`
4. Query module APIs: `module_info('pdf')` → read hints
5. Register handler(s) and execute

## Colour Rules

- **PREFER omitting colour parameters** — theme auto-selects readable text
- Colours must be 6-char hex without `#` (e.g. `"2196F3"` not `"#2196F3"`)
- Named colours (`"red"`), rgb() notation, and 3-char shorthand are NOT supported
- Use theme values when you need explicit colours: `doc.theme.fg`, `.accent1`, etc.

## Data Rules — CRITICAL

- Chart values must be **finite numbers** — not null, undefined, NaN, or strings
- Table rows must have the **same number of cells as headers**
- pieChart: `labels.length` must equal `values.length`
- barChart/lineChart: `series.values.length` must equal `categories.length`
- comparisonTable: each option's `values` array must match `features.length`

## Document Quality Standards — MANDATORY

A professional document is NOT a dump of raw data. Every document must tell a story.

### Structure Rules
- **Every document starts with a title** — use `heading({ text, level: 1 })` or `titlePage()`
- **Every section has a heading** — `heading({ text, level: 2 })` before each logical section
- **Charts NEVER appear alone** — every chart MUST be preceded by a heading and followed by a paragraph interpreting the data (key insights, trends, takeaways)
- **Tables NEVER appear alone** — introduce each table with context explaining what it shows
- **Use spacers between sections** — `spacer(12)` or `rule()` to visually separate content

### Content Rules
- **Add narrative text** — explain what the data means, don't just show numbers
- **Highlight key findings** — call out important values, trends, or anomalies
- **Use bullet lists for summaries** — after a chart/table, summarize the 2-3 key takeaways
- **Include footer and page numbers** — `addFooter()` and `addPageNumbers()` for all multi-page docs

### Quality Checklist (apply before finalising)
1. Does the document have a clear title?
2. Does every chart have a heading AND interpretation paragraph?
3. Are numeric values given context (comparison, % change, trend direction)?
4. Would a reader understand the data without the original request?
5. Is there a logical flow from section to section?

## Layout Budget — Vertical Space Reference

Use `estimateHeight(elements)` to predict total height BEFORE rendering.
This avoids trial-and-error page fitting.

### Available space per page
- **Letter** (612×792pt): 792 - 72 - 72 = **648pt** usable with default margins
- **A4** (595×842pt): 842 - 72 - 72 = **698pt** usable with default margins
- `contentPage()` heading consumes ~50pt (h1 28pt + spacing)

### Approximate element heights
| Element | Height (points) |
|---------|----------------|
| `heading({ level: 1 })` | ~60pt (28pt font + 16pt before + 8pt after + line height) |
| `heading({ level: 2 })` | ~45pt (22pt font + 16pt before + 8pt after) |
| `heading({ level: 3 })` | ~35pt (18pt font + 10pt before + 6pt after) |
| `paragraph()` (3 lines) | ~50pt (11pt × 1.4 line height × 3 lines + spacing) |
| `table()` per row | ~24pt (11pt font × 2.2 with padding) |
| `kvTable()` per row | ~24pt (same as table) |
| `barChart({ height: 200 })` | ~200pt (height = total including axes, legend) |
| Chart with title | height + ~21pt (14pt title + 7pt gap) |
| `spacer(12)` | 12pt |
| `rule()` | ~16pt (4pt top + 0.5pt line + 12pt bottom) |
| `bulletList()` per item | ~15pt (11pt × 1.4 line height) |
| `pageBreak()` | forces new page — remaining space on current page is wasted |

### Example: Fit check before rendering
```javascript
import { estimateHeight, heading, paragraph, table } from "ha:pdf";

const elements = [
  heading({ text: "Revenue", level: 2 }),
  paragraph({ text: "Q1 showed strong growth..." }),
  table({ headers: ["Metric", "Value"], rows: [["Rev", "$8.2M"], ["Orders", "142K"]] }),
];
const height = estimateHeight(elements);
// Letter page usable = 648pt. If height > 600, content will overflow.
```

### Example: GOOD vs BAD

**BAD** (chart dumped on empty page):
```javascript
addContent(doc, [
  pieChart({ labels: [...], values: [...], title: "Revenue" }),
]);
```

**GOOD** (chart with context, heading, interpretation):
```javascript
addContent(doc, [
  heading({ text: "Revenue Breakdown by Category", level: 2 }),
  paragraph({ text: "Electronics continues to dominate revenue at 42%, driven by strong Q1 demand for smartphones and accessories. Clothing grew 3% quarter-over-quarter, while Home & Garden remained stable." }),
  pieChart({ labels: [...], values: [...], title: "Revenue by Category" }),
  paragraph({ text: "Key takeaway: The Electronics segment accounts for nearly half of all revenue. Consider diversifying to reduce concentration risk." }),
  spacer(12),
]);
```

## Build Pipeline

```javascript
import { createDocument, addContent, heading, paragraph, addPageNumbers, exportToFile } from "ha:pdf";
import * as fsWrite from "host:fs-write";

const doc = createDocument({ theme: "light-clean", title: "My Report", author: "Author" });
// ... add content ...
addPageNumbers(doc, { skipPages: 1 });
addFooter(doc, { text: "Confidential" });
exportToFile(doc, "output.pdf", fsWrite);
```

## Common Mistakes to Avoid

- Forgetting `addPage()` before low-level drawing → ERROR
- Passing raw strings to `addContent()` → ERROR (use element builders)
- Missing `series.name` on charts → ERROR
- Using `align: 'center'` on paragraph → correct (not 'ctr' like PPTX)
- Storing `doc` in shared-state without `serializeDocument()` → methods stripped
- Drawing on the title page with `addContent()` after `titlePage()` → addContent auto-creates new page
- Not calling `addPageNumbers()` before `buildPdf()` / `exportToFile()`
- Using non-standard font names → falls back to Helvetica (no error, but unexpected)
