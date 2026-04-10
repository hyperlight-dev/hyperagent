//   STRUCTURE RULES (IMPORTANT — violations cause runtime errors):
//   • table: every row must have the same number of cells as the headers array.
//   • kvTable: each item must be { key: 'string', value: 'string' }.
//   • comparisonTable: options array must not be empty, each option needs
//     { name: 'string', values: [booleans] } with values.length === features.length.
//   • timeline: items array must not be empty, each item needs a 'label' property.
//
//   THEME-AWARE COLORS:
//   Pass opts.theme (from pres.theme) to auto-select colors for dark/light backgrounds:
//     table({ ..., theme: pres.theme })
//   The table will use light text on dark backgrounds and vice versa.
//   Style overrides always take precedence over theme-computed values.

import {
  hexColor,
  requireHex,
  requireArray,
  requireNumber,
  isDark,
  type Theme,
} from "ha:doc-core";
import {
  inches,
  fontSize,
  nextShapeId,
  isForceAllColors,
  _createShapeFragment,
  type ShapeFragment,
} from "ha:ooxml-core";
import { escapeXml } from "ha:xml-escape";

// ── Table Style Presets ───────────────────────────────────────────────

/**
 * Predefined table styles for common use cases.
 * Use with table({...opts, style: TABLE_STYLES.dark})
 */
export const TABLE_STYLES = {
  /** Default blue header with light body */
  default: {
    headerBg: "2196F3",
    headerColor: "FFFFFF",
    textColor: "333333",
    borderColor: "CCCCCC",
    altRows: true,
    altRowColor: "F5F5F5",
  },
  /** Dark/brutalist: near-black with white text, red header */
  dark: {
    headerBg: "CC0000",
    headerColor: "FFFFFF",
    textColor: "E6EDF3",
    borderColor: "333333",
    altRows: true,
    altRowColor: "1A1A1A",
  },
  /** Minimal: no alternating rows, subtle borders */
  minimal: {
    headerBg: "F5F5F5",
    headerColor: "333333",
    textColor: "333333",
    borderColor: "E0E0E0",
    altRows: false,
  },
  /** Corporate: navy header, professional look */
  corporate: {
    headerBg: "1B2A4A",
    headerColor: "FFFFFF",
    textColor: "333333",
    borderColor: "CCCCCC",
    altRows: true,
    altRowColor: "F8F9FA",
  },
  /** Emerald: green header */
  emerald: {
    headerBg: "10B981",
    headerColor: "FFFFFF",
    textColor: "333333",
    borderColor: "CCCCCC",
    altRows: true,
    altRowColor: "ECFDF5",
  },
} as const;

// ── Table XML Generation ─────────────────────────────────────────────

interface CellOptions {
  fillColor?: string;
  color?: string;
  fontSize?: number;
  bold?: boolean;
  borderColor?: string;
  align?: "l" | "ctr" | "r";
}

function cellXml(text: string | number, opts?: CellOptions): string {
  const o = opts || {};
  const sz = fontSize(o.fontSize || 12);
  const b = o.bold ? ' b="1"' : "";
  const color = o.color
    ? `<a:solidFill><a:srgbClr val="${hexColor(o.color)}"/></a:solidFill>`
    : "";
  const align = o.align || "l";

  const fill = o.fillColor
    ? `<a:solidFill><a:srgbClr val="${hexColor(o.fillColor)}"/></a:solidFill>`
    : "";
  const borders = o.borderColor
    ? buildBorders(o.borderColor)
    : buildBorders("CCCCCC");

  // ECMA-376 §21.1.3.17: tcPr children must be: borders THEN fill.
  // lnL, lnR, lnT, lnB, ... solidFill/noFill/gradFill ...
  return `<a:tc>
<a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr algn="${align}"/><a:r><a:rPr lang="en-US" sz="${sz}"${b} dirty="0">${color}</a:rPr><a:t>${escapeXml(String(text))}</a:t></a:r></a:p></a:txBody>
<a:tcPr marL="68580" marR="68580" marT="34290" marB="34290">${borders}${fill}</a:tcPr>
</a:tc>`;
}

function buildBorders(color: string): string {
  const c = hexColor(color);
  const border = ` w="12700"><a:solidFill><a:srgbClr val="${c}"/></a:solidFill>`;
  return `<a:lnL${border}</a:lnL><a:lnR${border}</a:lnR><a:lnT${border}</a:lnT><a:lnB${border}</a:lnB>`;
}

// ── Public API ───────────────────────────────────────────────────────

export interface TableStyle {
  /** Header row fill color */
  headerBg?: string;
  /** Header text color */
  headerColor?: string;
  /** Alternating row shading */
  altRows?: boolean;
  /** Alt row fill color (auto from theme if not set) */
  altRowColor?: string;
  /** Border color (auto from theme if not set) */
  borderColor?: string;
  /** Body font size */
  fontSize?: number;
  /** Header font size */
  headerFontSize?: number;
  /** Body text color (auto from theme if not set) */
  textColor?: string;
  /** Theme text color (alias for textColor) */
  themeTextColor?: string;
}

export interface TableOptions {
  /** X position in inches */
  x?: number;
  /** Y position in inches */
  y?: number;
  /** Width in inches */
  w?: number;
  /** Height in inches (auto-calculated from rows if omitted) */
  h?: number;
  /** Row height in inches (default: auto based on content, min 0.35") */
  rowHeight?: number;
  /** Column header texts */
  headers?: string[];
  /** Data rows (array of arrays) */
  rows?: (string | number)[][];
  /** Theme object from pres.theme (auto-selects colors for dark/light) */
  theme?: Theme | { bg?: string; fg?: string };
  /** Style overrides (take precedence over theme) */
  style?: TableStyle;
}

/**
 * Create a styled table as a PPTX shape XML fragment.
 *
 * NOTE: Tables do NOT perform WCAG contrast validation like pptx shapes do.
 * All colors are used as-is. The forceAllColors flag from createPresentation()
 * has no effect on tables (they already accept any color combination).
 *
 * @param opts.x - X position in inches (default: 0.5)
 * @param opts.y - Y position in inches (default: 1.5)
 * @param opts.w - Table width in inches (default: 12.333)
 * @param opts.headers - Column header labels (string array)
 * @param opts.rows - Data rows (2D array)
 * @param opts.theme - Theme name to use for colors (default: uses preset)
 * @param opts.style.headerBg - Header row background color (hex, no #)
 * @param opts.style.headerColor - Header text color (hex, no #)
 * @param opts.style.textColor - Data cell text color (hex, no #)
 * @param opts.style.altRows - Enable alternating row colors (default: true)
 * @param opts.style.altRowColor - Alternating row background color (hex, no #)
 * @param opts.style.borderColor - Cell border color (hex, no #)
 * @param opts.style.fontSize - Data cell font size in pt
 * @param opts.style.headerFontSize - Header font size in pt
 * @returns Shape XML fragment for use in slide body
 */
export function table(opts: TableOptions): ShapeFragment {
  // ── Input validation ──────────────────────────────────────────────
  const headers = opts.headers || [];
  const rows = opts.rows || [];
  if (opts.headers != null) requireArray(headers, "table.headers");
  requireArray(rows, "table.rows");
  // Validate every row is an array and has correct column count
  const expectedCols = headers.length || (rows[0] || []).length || 1;
  rows.forEach((row, i) => {
    requireArray(row, `table.rows[${i}]`);
    if (row.length !== expectedCols) {
      throw new Error(
        `table.rows[${i}]: has ${row.length} cells but expected ${expectedCols} ` +
          `(matching ${headers.length > 0 ? "headers" : "first row"} column count). ` +
          `All rows must have the same number of cells as the header row.`,
      );
    }
  });
  // Validate style colours
  const style = opts.style || {};
  if (style.headerBg) requireHex(style.headerBg, "table.style.headerBg");
  if (style.headerColor)
    requireHex(style.headerColor, "table.style.headerColor");
  if (style.altRowColor)
    requireHex(style.altRowColor, "table.style.altRowColor");
  if (style.borderColor)
    requireHex(style.borderColor, "table.style.borderColor");
  if (style.textColor) requireHex(style.textColor, "table.style.textColor");
  if (style.themeTextColor)
    requireHex(style.themeTextColor, "table.style.themeTextColor");
  if (style.fontSize != null)
    requireNumber(style.fontSize, "table.style.fontSize", { min: 1, max: 200 });
  if (style.headerFontSize != null)
    requireNumber(style.headerFontSize, "table.style.headerFontSize", {
      min: 1,
      max: 200,
    });

  const colCount = expectedCols;
  const rowCount = rows.length + (headers.length > 0 ? 1 : 0);

  const x = inches(opts.x || 0);
  const y = inches(opts.y || 0);
  const w = inches(opts.w || 10);

  // ── Auto-calculate row height based on content ────────────────────────
  // Estimate chars per line based on column width and font size
  const bodyFontSize = opts.style?.fontSize || 12;
  const avgCharWidth = bodyFontSize * 0.5; // rough pixels per char
  const colWidthInches = (opts.w || 10) / colCount;
  const colWidthPx = colWidthInches * 96; // 96 DPI
  const charsPerLine = Math.floor(colWidthPx / avgCharWidth);

  // Calculate per-row heights based on longest cell content
  const calcRowHeight = (cells: (string | number)[]): number => {
    let maxLines = 1;
    for (const cell of cells) {
      const text = String(cell);
      const lines = Math.ceil(text.length / Math.max(charsPerLine, 10));
      maxLines = Math.max(maxLines, lines);
    }
    // Base height 0.35" per line, min 0.35", max 1.5"
    return Math.min(1.5, Math.max(0.35, maxLines * 0.3));
  };

  // Use explicit rowHeight if provided, otherwise auto-calculate
  const headerRowHeight = opts.rowHeight
    ? inches(opts.rowHeight)
    : headers.length > 0
      ? inches(calcRowHeight(headers))
      : 0;

  const dataRowHeights = opts.rowHeight
    ? rows.map(() => inches(opts.rowHeight!))
    : rows.map((row) => inches(calcRowHeight(row)));

  const totalAutoHeight =
    headerRowHeight + dataRowHeights.reduce((a, b) => a + b, 0);
  const h = opts.h ? inches(opts.h) : totalAutoHeight;
  const colWidth = Math.round(w / colCount);

  // ── Theme-aware defaults ────────────────────────────────────────────
  // If opts.theme is passed, auto-compute colors for dark/light backgrounds.
  // Style overrides always take precedence over theme-computed values.
  const theme = opts.theme || {};
  const darkMode = theme.bg ? isDark(theme.bg) : false;

  // Dark mode defaults: light text on dark alt-rows
  // Light mode defaults: dark text on light alt-rows
  const defaultTextColor = darkMode ? theme.fg || "E6EDF3" : "333333";
  const defaultAltRowColor = darkMode ? "2D333B" : "F5F5F5";
  const defaultBorderColor = darkMode ? "444C56" : "CCCCCC";

  const headerBg = style.headerBg || "2196F3";
  const headerColor = style.headerColor || "FFFFFF";
  const headerFontSize = style.headerFontSize || 13;
  const styleFontSize = style.fontSize || 12;
  const textColor = style.textColor || style.themeTextColor || defaultTextColor;
  const altRows = style.altRows !== false;
  const altRowColor = style.altRowColor || defaultAltRowColor;
  const borderColor = style.borderColor || defaultBorderColor;

  // Build grid columns
  const gridCols = Array.from(
    { length: colCount },
    () => `<a:gridCol w="${colWidth}"/>`,
  ).join("");

  // Build header row
  let headerRow = "";
  if (headers.length > 0) {
    const headerCells = headers
      .map((h) =>
        cellXml(h, {
          fillColor: headerBg,
          color: headerColor,
          fontSize: headerFontSize,
          bold: true,
          borderColor,
          align: "ctr",
        }),
      )
      .join("");
    headerRow = `<a:tr h="${headerRowHeight}">${headerCells}</a:tr>`;
  }

  // Build data rows
  const dataRows = rows
    .map((row, rowIdx) => {
      const isAlt = altRows && rowIdx % 2 === 1;
      const cells = row
        .map((cell) =>
          cellXml(cell, {
            fillColor: isAlt ? altRowColor : undefined,
            color: textColor,
            fontSize: styleFontSize,
            borderColor,
          }),
        )
        .join("");
      return `<a:tr h="${dataRowHeights[rowIdx]}">${cells}</a:tr>`;
    })
    .join("");

  return _createShapeFragment(`<p:graphicFrame>
<p:nvGraphicFramePr><p:cNvPr id="${nextShapeId()}" name="Table"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>
<p:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></p:xfrm>
<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">
<a:tbl><a:tblPr firstRow="1" bandRow="${altRows ? "1" : "0"}"/><a:tblGrid>${gridCols}</a:tblGrid>${headerRow}${dataRows}</a:tbl>
</a:graphicData></a:graphic>
</p:graphicFrame>`);
}

export interface KVItem {
  key: string;
  value: string;
}

export interface KVTableOptions {
  /** X position in inches */
  x?: number;
  /** Y position in inches */
  y?: number;
  /** Width in inches */
  w?: number;
  /** Key-value pairs */
  items: KVItem[];
  /** Theme object from pres.theme (auto-selects colors for dark/light) */
  theme?: Theme | { bg?: string; fg?: string };
  /** Style overrides */
  style?: TableStyle;
}

/**
 * Create a key-value pair list as a simple two-column table.
 * Nice for specs, metadata, config displays.
 *
 * @param opts - KV table options: { x?, y?, w?, items: Array<{key, value}>, theme?, style? }
 * @returns Shape XML fragment
 */
export function kvTable(opts: KVTableOptions): ShapeFragment {
  // ── Input validation ──────────────────────────────────────────────
  const items = opts.items || [];
  requireArray(items, "kvTable.items");
  items.forEach((item, i) => {
    if (item == null || typeof item !== "object") {
      throw new Error(
        `kvTable.items[${i}]: expected an object with {key, value} but got ${typeof item}. ` +
          `Provide items like: [{ key: "Name", value: "HyperAgent" }]`,
      );
    }
    if (item.key == null) {
      throw new Error(
        `kvTable.items[${i}]: missing required 'key' property. ` +
          `Each item must have { key: "Label", value: "Data" }.`,
      );
    }
  });

  // Build style object - don't override theme-computed colors
  const baseStyle: TableStyle = {
    altRows: true,
    headerBg: "FFFFFF",
    borderColor: opts.style?.borderColor || "E0E0E0",
    fontSize: opts.style?.fontSize || 11,
    ...opts.style,
  };
  // Only set textColor default if no theme and no explicit style.textColor
  if (!opts.theme && !opts.style?.textColor) {
    baseStyle.textColor = "333333";
  }

  return table({
    x: opts.x,
    y: opts.y,
    w: opts.w || 6,
    headers: [],
    rows: items.map((item) => [item.key, item.value]),
    theme: opts.theme,
    style: baseStyle,
  });
}

export interface ComparisonOption {
  /** Column header name */
  name: string;
  /** One boolean per feature */
  values: boolean[];
}

export interface ComparisonTableOptions {
  /** X position in inches */
  x?: number;
  /** Y position in inches */
  y?: number;
  /** Width in inches */
  w?: number;
  /** Feature/criterion names (row labels). REQUIRED, non-empty. */
  features: string[];
  /** Options to compare. REQUIRED, non-empty. */
  options: ComparisonOption[];
  /** Theme object from pres.theme (auto-selects colors for dark/light) */
  theme?: Theme | { bg?: string; fg?: string };
  /** Style overrides (headerBg, headerColor, fontSize, etc.) */
  style?: TableStyle;
}

/**
 * Create a comparison table with feature rows and ✓/✗ columns.
 * Great for pros/cons, feature comparisons, or option evaluation.
 *
 * @example
 * // Compare three database options across features
 * const tbl = comparisonTable({
 *   x: 0.5, y: 1.5, w: 11,
 *   features: ['ACID compliance', 'Horizontal scaling', 'JSON support', 'Free tier'],
 *   options: [
 *     { name: 'PostgreSQL', values: [true, false, true, true] },
 *     { name: 'MongoDB', values: [false, true, true, true] },
 *     { name: 'DynamoDB', values: [true, true, true, false] }
 *   ],
 *   theme: pres.theme,  // Auto-select colors for dark/light background
 *   style: { headerBg: '1A3A5C', headerColor: 'E6EDF3' }
 * });
 *
 * @param opts - REQUIRED: { features: string[], options: Array<{name: string, values: boolean[]}> }. Optional: x?, y?, w?, theme?, style?
 * @returns Shape XML fragment
 */
export function comparisonTable(opts: ComparisonTableOptions): ShapeFragment {
  // ── Input validation ──────────────────────────────────────────────
  const features = opts.features || [];
  const options = opts.options || [];
  requireArray(features, "comparisonTable.features", { nonEmpty: true });
  requireArray(options, "comparisonTable.options", { nonEmpty: true });
  options.forEach((o, i) => {
    if (o.name == null) {
      throw new Error(
        `comparisonTable.options[${i}]: missing required 'name' property. ` +
          `Each option must have { name: "Option A", values: [true, false, ...] }.`,
      );
    }
    requireArray(o.values, `comparisonTable.options[${i}].values`);
    if (o.values.length !== features.length) {
      throw new Error(
        `comparisonTable.options[${i}] "${o.name}": values array has ` +
          `${o.values.length} elements but there are ${features.length} features. ` +
          `Each option must have one boolean value per feature.`,
      );
    }
  });

  const headers = ["", ...options.map((o) => o.name)];
  const rows = features.map((feature, i) => [
    feature,
    ...options.map((o) => (o.values[i] ? "✓" : "✗")),
  ]);

  return table({
    x: opts.x,
    y: opts.y,
    w: opts.w || 10,
    headers,
    rows,
    theme: opts.theme,
    style: {
      headerBg: opts.style?.headerBg || "2196F3",
      headerColor: opts.style?.headerColor || "FFFFFF",
      altRows: true,
      fontSize: opts.style?.fontSize || 13,
      ...opts.style,
    },
  });
}

export interface TimelineItem {
  /** Phase/milestone label */
  label: string;
  /** Optional description */
  description?: string;
  /** Optional custom color */
  color?: string;
}

export interface TimelineOptions {
  /** X position in inches */
  x?: number;
  /** Y position in inches */
  y?: number;
  /** Width in inches */
  w?: number;
  /** Timeline items */
  items: TimelineItem[];
  /** Theme object from pres.theme (auto-selects colors for dark/light) */
  theme?: Theme | { bg?: string; fg?: string };
  /** Style overrides */
  style?: TableStyle;
}

/**
 * Create a horizontal timeline/roadmap display.
 * Shows phases or milestones as a sequence of colored boxes.
 *
 * @param opts - Timeline options: { x?, y?, w?, items: Array<{label, description?, color?}>, theme?, style? }
 * @returns Shape XML fragment (uses table layout)
 */
export function timeline(opts: TimelineOptions): ShapeFragment {
  // ── Input validation ──────────────────────────────────────────────
  // Accept 'events' and 'entries' as common aliases for 'items' (LLMs often use these)
  const aliasOpts = opts as unknown as {
    events?: TimelineOptions["items"];
    entries?: TimelineOptions["items"];
  };
  const rawItems = opts.items || aliasOpts.events || aliasOpts.entries || [];
  requireArray(rawItems, "timeline.items", { nonEmpty: true });

  // Normalize items: accept 'title' as alias for 'label', prepend 'date' if present
  type RawItem = {
    label?: string;
    title?: string;
    date?: string;
    description?: string;
    color?: string;
  };
  const items = rawItems.map((raw, i) => {
    const item = raw as RawItem;
    const label = item.label || item.title;
    if (!label) {
      throw new Error(
        `timeline.items[${i}]: missing required 'label' (or 'title') property. ` +
          `Each timeline item must have { label: "Phase 1", description?: "Details" }.`,
      );
    }
    // If date is provided, prepend it to the label
    const displayLabel = item.date ? `${item.date}\n${label}` : label;
    return {
      label: displayLabel,
      description: item.description,
      color: item.color,
    };
  });

  const headers = items.map((item) => item.label);
  const rows: string[][] =
    items[0]?.description !== undefined
      ? [items.map((item) => item.description || "")]
      : [];

  return table({
    x: opts.x,
    y: opts.y,
    w: opts.w || 12,
    headers,
    rows,
    theme: opts.theme,
    style: {
      headerBg: opts.style?.headerBg || "2196F3",
      headerColor: opts.style?.headerColor || "FFFFFF",
      headerFontSize: opts.style?.headerFontSize || 11,
      fontSize: opts.style?.fontSize || 10,
      altRows: false,
      ...opts.style,
    },
  });
}
