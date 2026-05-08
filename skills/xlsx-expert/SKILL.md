---
name: xlsx-expert
description: Expert at building Excel XLSX workbooks using Hyperlight sandbox modules
triggers:
  - Excel
  - excel
  - XLSX
  - xlsx
  - spreadsheet
  - workbook
  - worksheet
  - pivot table
  - pivot
  - chart workbook
  - sales report
patterns:
  - two-handler-pipeline
  - file-generation
antiPatterns:
  - Don't write inline OOXML XML — use ha:xlsx workbook and sheet APIs
  - Don't use zero-based public row or column indexes — xlsx APIs use 1-based indexes
  - Don't guess option names — call module_info('xlsx') and read the exported interfaces
  - Don't rely on sheet protection passwords for security — they use legacy Excel XOR hashing
  - Don't pass JavaScript objects directly to addRow — use tableToWorkbook or map rows through headers
allowed-tools:
  - register_handler
  - execute_javascript
  - execute_bash
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

# Excel Workbook Expert

You are an expert at building professional Excel `.xlsx` workbooks inside the Hyperlight sandbox.

## CRITICAL: API Discovery — DO NOT GUESS

1. Call `module_info('xlsx')` before writing handler code.
2. Read the type definitions for every options bag you plan to use: `CellStyle`, `ChartOptions`, `ConditionalFormatRule`, `DataValidationOptions`, `PivotTableAddOptions`, and `TableToWorkbookOptions`.
3. The module is strongly typed. Follow the exported interface names exactly.

## Setup Sequence

1. **Clarify requirements** — use `ask_user` (see Clarifying Questions below)
2. `apply_profile({ profiles: 'file-builder' })` for binary output and larger buffers.
3. `manage_plugin('fs-write', 'enable')` if the workbook needs to be written to disk.
4. `module_info('xlsx')` and read the type definitions.
5. Register a handler that imports from `ha:xlsx`.
6. Build the workbook, then write the returned `Uint8Array` with the fs-write binary API.

## Clarifying Questions

Before building, check the user's request for these details. Ask about any
that are missing — group into ONE `ask_user` call, never ask one at a time.
Skip anything the user already specified. Offer sensible defaults they can
accept with "yes" or "looks good".

**Always needed (ask if missing):**

- **Purpose** — What will this workbook be used for? (tracking, analysis, reporting)
- **Data structure** — What columns/fields are needed? How many rows approximately?
- **Data source** — Will data come from a file, URL, or should I generate sample data? If a URL, also apply `web-research` profile to enable fetching.

**Ask if relevant to the request:**

- **Multiple sheets** — One sheet or multiple? (e.g. summary + detail, by category)
- **Charts** — Any visualisations needed? What types? (column, bar, line, pie)
- **Formulas** — Any calculations? (totals, averages, percentages, lookups)
- **Formatting** — Conditional formatting, data bars, colour coding for thresholds?
- **Pivot tables** — Any pivot analysis needed? Which fields to group by?
- **Filters/Sorting** — Auto-filter, frozen header rows?

**Never ask — use sensible defaults:**

- Column widths → auto-size based on content
- Header styling → bold, coloured background, border
- Number formats → auto-detect from data types
- Sheet protection → don't apply unless explicitly requested

## Common Patterns

For simple tabular reports, prefer `tableToWorkbook()`:

```javascript
import { tableToWorkbook, exportToFile } from "ha:xlsx";

export async function handler(event) {
  const wb = tableToWorkbook({
    sheetName: "Report",
    headers: ["name", "value"],
    data: event.rows,
    columnWidths: [24, 14],
  });
  return exportToFile(wb, "report.xlsx", event.writeFileBinary);
}
```

For richer workbooks, use the workbook/sheet API:

```javascript
import { createWorkbook, exportToFile } from "ha:xlsx";

export async function handler(event) {
  const wb = createWorkbook();
  const sh = wb.addSheet("Data");
  sh.addRow(1, ["Region", "Revenue"], {
    bold: true,
    fill: "#4472C4",
    color: "#FFFFFF",
    border: "thin",
  });
  sh.addData(event.rows, "A2", { border: "thin" });
  sh.freezeRows(1).setAutoFilter("A1:B100");
  sh.addConditionalFormat("B2:B100", { type: "dataBar", color: "#70AD47" });
  return exportToFile(wb, "analysis.xlsx", event.writeFileBinary);
}
```

## Workbook Rules

- Public row and column indexes are 1-based. Cell refs are A1-style strings like `A1`, `C12`, `AA7`.
- `setCell()` accepts strings, numbers, booleans, Dates, null/undefined, or formulas beginning with `=`.
- Dates are stored as Excel serial numbers and default to `mm-dd-yy` if no `numFmt` is provided.
- Use `setColumnWidth()`, `freezeRows()`, and `setAutoFilter()` for scan-friendly reports.
- Use `tableToWorkbook()` for object rows; use `addRow()` only with arrays.

## Chart Rules

- `ChartOptions.series` is an array of `{ name, values }`.
- Every series needs a `name` and numeric `values`.
- `categories.length` should match each series `values.length`.
- Supported chart types are `column`, `bar`, `line`, `area`, `pie`, and `doughnut`.

## Pivot Rules

- Populate the source sheet first, including header row.
- `sourceRange` must include the header row, for example `A1:D100`.
- Field names in `rows`, `columns`, `filters`, and `values[].field` must exactly match headers.
- Create or select a separate target sheet before calling `addPivotTable()`.

## Protection Warning

`protect({ password })` uses Excel's legacy XOR sheet-protection hash. It is useful for preventing accidental edits, but it is not cryptographic security and must not be used to protect sensitive data.

## Common Mistakes

- Forgetting to call `module_info('xlsx')` and guessing option names.
- Passing object rows to `addRow()` instead of arrays.
- Using zero-based row/column indexes in public APIs.
- Writing workbook bytes as text instead of binary.
- Treating `protect({ password })` as secure encryption.
