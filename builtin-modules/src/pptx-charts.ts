//   DATA RULES (IMPORTANT — violations cause runtime errors):
//   • labels/categories arrays must NEVER be empty.
//   • barChart/lineChart/comboChart: each series needs { name: 'string', values: [numbers] }.
//   • pieChart: takes { labels:[], values:[] } directly — NO series objects.
//   • All values must be finite numbers — not null, undefined, NaN, or strings.
//   • pieChart: labels.length must equal values.length.
//   • barChart/lineChart: series.values.length must equal categories.length.
//   • Maximum 24 series per chart (Excel column reference limit).
//   • Chart colours are auto-assigned from the theme palette — omit unless needed.

import {
  hexColor,
  requireHex,
  requireString,
  requireArray,
  requireNumber,
} from "ha:doc-core";
import {
  inches,
  nextShapeId,
  _createShapeFragment,
  type ShapeFragment,
} from "ha:ooxml-core";
import { escapeXml } from "ha:xml-escape";

// ── Chart Complexity Caps ────────────────────────────────────────────
// Hard limits to prevent decks that exhaust PowerPoint's rendering budget.

/** Maximum charts per presentation deck. */
export const MAX_CHARTS_PER_DECK = 50;

/** Maximum data series per chart (Excel column reference limit B–Y). */
export const MAX_SERIES_PER_CHART = 24;

/** Maximum categories (X-axis labels) per chart. */
export const MAX_CATEGORIES_PER_CHART = 100;

// ── Namespace Constants ──────────────────────────────────────────────
const NS_C = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_R =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

// ── Default Chart Colors ─────────────────────────────────────────────
const DEFAULT_COLORS = [
  "2196F3",
  "4CAF50",
  "FF9800",
  "E91E63",
  "9C27B0",
  "00BCD4",
  "FF5722",
  "607D8B",
  "795548",
  "CDDC39",
];

// ── Shared XML Helpers ───────────────────────────────────────────────

function catRef(categories: string[], sheetName?: string): string {
  const sn = sheetName || "Sheet1";
  const count = categories.length;
  const pts = categories
    .map((c, i) => `<c:pt idx="${i}"><c:v>${escapeXml(String(c))}</c:v></c:pt>`)
    .join("");
  return `<c:cat><c:strRef><c:f>${sn}!$A$2:$A$${count + 1}</c:f><c:strCache><c:ptCount val="${count}"/>${pts}</c:strCache></c:strRef></c:cat>`;
}

function numRef(
  values: number[],
  sheetName?: string,
  colLetter?: string,
  seriesName?: string,
): string {
  const sn = sheetName || "Sheet1";
  const col = colLetter || "B";
  const count = values.length;
  const pts = values
    .map((v, i) => {
      // Every chart data value MUST be numeric — strings like "two" produce
      // corrupt XML that renders as an empty chart with no error message.
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw new Error(
          `Chart series "${seriesName || "unknown"}": value at index ${i} is ` +
            `${typeof v} (${JSON.stringify(v)}) — expected a finite number. ` +
            `All chart data values must be numbers (e.g. 42, 3.14, 0). ` +
            `Check your data array for strings, null, or undefined entries.`,
        );
      }
      return `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`;
    })
    .join("");
  return `<c:val><c:numRef><c:f>${sn}!$${col}$2:$${col}$${count + 1}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${count}"/>${pts}</c:numCache></c:numRef></c:val>`;
}

export interface ChartSeries {
  /** Series name (appears in legend). REQUIRED. */
  name: string;
  /** Numeric values, one per category. REQUIRED. */
  values: number[];
  /** Optional hex color (auto-assigned if omitted). */
  color?: string;
}

interface SeriesXmlOptions {
  showValues?: boolean;
}

function seriesXml(
  series: ChartSeries,
  index: number,
  categories: string[],
  opts: SeriesXmlOptions,
): string {
  // Series name is REQUIRED — charts with unnamed series produce meaningless legends.
  requireString(series.name, `series[${index}].name`);
  // Series values are REQUIRED and must be a non-empty array of numbers.
  if (
    !series.values ||
    !Array.isArray(series.values) ||
    series.values.length === 0
  ) {
    throw new Error(
      `series[${index}].values: array must not be empty. ` +
        `This often happens when fetched data is empty. ` +
        `Check if your data source returned results: ` +
        `if (data.length === 0) { /* show placeholder slide instead */ }`,
    );
  }
  // Validate length matches categories (if categories provided)
  if (categories.length > 0 && series.values.length !== categories.length) {
    throw new Error(
      `series[${index}] "${series.name}": values array has ${series.values.length} ` +
        `elements but there are ${categories.length} categories. ` +
        `Each series must have exactly one value per category.`,
    );
  }
  // Validate series colour if provided
  if (series.color) requireHex(series.color, `series[${index}].color`);

  const color = hexColor(
    series.color || DEFAULT_COLORS[index % DEFAULT_COLORS.length],
  );
  const colLetter = String.fromCharCode(66 + index); // B, C, D, ...
  // Guard against too many series exceeding column letter space
  if (index > 23) {
    throw new Error(
      `Too many chart series (${index + 1}). Maximum is 24 series per chart ` +
        `due to Excel column reference limits (B through Y).`,
    );
  }
  const showValues = opts.showValues
    ? `<c:dLbls><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/></c:dLbls>`
    : "";

  return `<c:ser>
<c:idx val="${index}"/><c:order val="${index}"/>
<c:tx><c:strRef><c:f>Sheet1!$${colLetter}$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${escapeXml(series.name)}</c:v></c:pt></c:strCache></c:strRef></c:tx>
<c:spPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></c:spPr>
${showValues}
${catRef(categories)}
${numRef(series.values, "Sheet1", colLetter, series.name)}
</c:ser>`;
}

function piePtColors(values: number[], colors?: string[]): string {
  const clrs = colors || DEFAULT_COLORS;
  return values
    .map((_, i) => {
      const c = hexColor(clrs[i % clrs.length]);
      return `<c:dPt><c:idx val="${i}"/><c:spPr><a:solidFill><a:srgbClr val="${c}"/></a:solidFill></c:spPr></c:dPt>`;
    })
    .join("");
}

// ── Chart Text Properties ────────────────────────────────────────────

/**
 * Generate a <c:txPr> element that sets text colour for chart elements
 * (axes, legends, data labels).  Without this, chart text inherits the
 * OOXML theme dk1 colour which may match the slide background on dark
 * themes, rendering all chart text invisible.
 * @param color - Hex colour string (e.g. 'E6EDF3')
 * @returns OOXML <c:txPr> fragment
 */
function chartTextProps(color: string): string {
  const c = hexColor(color);
  return (
    "<c:txPr><a:bodyPr/><a:lstStyle/>" +
    "<a:p><a:pPr><a:defRPr>" +
    `<a:solidFill><a:srgbClr val="${c}"/></a:solidFill>` +
    '</a:defRPr></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr>'
  );
}

function axisXml(
  axId: number,
  crossAxId: number,
  position?: string,
  isCategory?: boolean,
  textColor?: string,
): string {
  const axType = isCategory ? "c:catAx" : "c:valAx";
  const pos = position || (isCategory ? "b" : "l");
  // Explicit text colour keeps axis labels readable on dark backgrounds
  const txPr = textColor ? chartTextProps(textColor) : "";
  // ECMA-376: txPr must come BEFORE crossAx in catAx/valAx
  return `<${axType}>
<c:axId val="${axId}"/>
<c:scaling><c:orientation val="minMax"/></c:scaling>
<c:delete val="0"/>
<c:axPos val="${pos}"/>
${txPr}
<c:crossAx val="${crossAxId}"/>
</${axType}>`;
}

function chartTitle(title?: string, textColor?: string): string {
  if (!title) return "";
  const colorXml = textColor
    ? `<a:solidFill><a:srgbClr val="${hexColor(textColor)}"/></a:solidFill>`
    : "";
  return `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="1400" b="1">${colorXml}</a:rPr><a:t>${escapeXml(title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`;
}

function legendXml(position?: string, textColor?: string): string {
  const pos = position || "b";
  // Explicit text colour keeps legend readable on dark backgrounds
  const txPr = textColor ? chartTextProps(textColor) : "";
  return `<c:legend><c:legendPos val="${pos}"/><c:overlay val="0"/>${txPr}</c:legend>`;
}

// ── Chart Wrapper ────────────────────────────────────────────────────

function chartXml(
  plotArea: string,
  title?: string,
  showLegend?: boolean,
  textColor?: string,
): string {
  const hasLegend = showLegend !== false;
  const hasTitle = Boolean(title);
  // Manual layout reserves:
  // - Top: 8% (no title) or 15% (with title) to prevent data label/title overlap
  // - Bottom: 20% for legend (if present)
  // Empty <c:layout/> means "auto" which often overlaps.
  const topOffset = hasTitle ? 0.15 : 0.08;
  const height = hasLegend ? 0.69 : hasTitle ? 0.77 : 0.84;
  const plotLayout =
    "<c:layout><c:manualLayout>" +
    '<c:layoutTarget val="inner"/>' +
    '<c:xMode val="edge"/><c:yMode val="edge"/>' +
    `<c:x val="0.06"/><c:y val="${topOffset}"/>` +
    `<c:w val="0.88"/><c:h val="${height}"/>` +
    "</c:manualLayout></c:layout>";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="${NS_C}" xmlns:a="${NS_A}" xmlns:r="${NS_R}">
<c:chart>
${chartTitle(title, textColor)}
<c:autoTitleDeleted val="${title ? "0" : "1"}"/>
<c:plotArea>${plotLayout}${plotArea}</c:plotArea>
${hasLegend ? legendXml("b", textColor) : ""}
<c:plotVisOnly val="1"/>
</c:chart>
</c:chartSpace>`;
}

// ── Public API: Chart Builders ───────────────────────────────────────

export interface ChartResult {
  type: "chart";
  chartType: string;
  /**
   * Internal chart XML — do NOT concatenate into slide shapes.
   * Use chartSlide() or embedChart() to add charts to presentations.
   * @internal
   */
  _chartXml: string;
  /** Optional X position in inches (for embedChart fallback) */
  x?: number;
  /** Optional Y position in inches (for embedChart fallback) */
  y?: number;
  /** Optional width in inches (for embedChart fallback) */
  w?: number;
  /** Optional height in inches (for embedChart fallback) */
  h?: number;
  /** @internal Guard: throws if chart is accidentally concatenated into shapes */
  toString(): string;
}

/** Build a ChartResult with a toString() guard that prevents accidental
 *  concatenation of chart XML into slide shapes. */
function chartResult(chartType: string, xml: string): ChartResult {
  return {
    type: "chart",
    chartType,
    _chartXml: xml,
    toString(): string {
      throw new Error(
        "Cannot concatenate a chart directly into slide shapes. " +
          "Use chartSlide(pres, { chart: ... }) or " +
          "embedChart(pres, chart, { x, y, w, h }) instead.",
      );
    },
  };
}

export interface BarChartOptions {
  /** X-axis category labels (e.g. ['Q1', 'Q2', 'Q3']) */
  categories?: string[];
  /** Data series array. REQUIRED. */
  series: ChartSeries[];
  /** Horizontal bars (bar chart vs column chart) */
  horizontal?: boolean;
  /** Stack bars */
  stacked?: boolean;
  /** Show data labels on bars */
  showValues?: boolean;
  /** Chart title */
  title?: string;
  /** Show legend */
  showLegend?: boolean;
  /** Explicit text colour for axes/legend/labels (hex). Use on dark themes. */
  textColor?: string;
}

/**
 * Create a bar/column chart.
 *
 * @example
 * // Simple bar chart with two series
 * const chart = barChart({
 *   categories: ['Q1', 'Q2', 'Q3', 'Q4'],
 *   series: [
 *     { name: 'Revenue', values: [100, 120, 140, 160] },
 *     { name: 'Profit', values: [20, 25, 30, 35], color: '4CAF50' }
 *   ],
 *   title: 'Quarterly Results',
 *   textColor: 'E6EDF3'  // Use on dark themes for readability
 * });
 *
 * @param opts - REQUIRED: { series: Array<{name, values}> }. Optional: categories?, horizontal?, stacked?, showValues?, title?, showLegend?, textColor?
 * @returns Chart object with xml property and type metadata. Pass to chartSlide() or embedChart().
 */
export function barChart(opts: BarChartOptions): ChartResult {
  // ── Input validation ──────────────────────────────────────────────
  requireArray(opts.categories || [], "barChart.categories");
  requireArray(opts.series || [], "barChart.series", { nonEmpty: true });
  if (opts.textColor) requireHex(opts.textColor, "barChart.textColor");
  // Enforce complexity caps
  if ((opts.categories || []).length > MAX_CATEGORIES_PER_CHART) {
    throw new Error(
      `barChart: ${(opts.categories || []).length} categories exceeds the maximum of ${MAX_CATEGORIES_PER_CHART}. ` +
        `Reduce category count or aggregate data.`,
    );
  }
  if ((opts.series || []).length > MAX_SERIES_PER_CHART) {
    throw new Error(
      `barChart: ${(opts.series || []).length} series exceeds the maximum of ${MAX_SERIES_PER_CHART}.`,
    );
  }

  const dir = opts.horizontal ? "bar" : "col";
  const grouping = opts.stacked ? "stacked" : "clustered";
  const tc = opts.textColor || undefined;
  const seriesXmls = (opts.series || [])
    .map((s, i) => seriesXml(s, i, opts.categories || [], opts))
    .join("");

  const plotArea = `<c:barChart>
<c:barDir val="${dir}"/>
<c:grouping val="${grouping}"/>
<c:varyColors val="0"/>
${seriesXmls}
<c:axId val="1"/><c:axId val="2"/>
</c:barChart>
${axisXml(1, 2, opts.horizontal ? "l" : "b", true, tc)}
${axisXml(2, 1, opts.horizontal ? "b" : "l", false, tc)}`;

  return chartResult(
    "bar",
    chartXml(plotArea, opts.title, opts.showLegend, tc),
  );
}

export interface PieChartOptions {
  /** Slice labels */
  labels: string[];
  /** Slice values */
  values: number[];
  /** Custom colors per slice */
  colors?: string[];
  /** Show percentage labels (disable for many slices) */
  showPercent?: boolean;
  /**
   * Hide labels for slices below this percentage (0-100).
   * - 'auto' (default): hide labels for slices <5% when there are >5 slices
   * - number: explicit threshold (e.g., 3 = hide slices below 3%)
   * - 0: show all labels (same as omitting this option with ≤5 slices)
   */
  labelThreshold?: number | "auto";
  /** Donut style */
  donut?: boolean;
  /** Donut hole size (1-90) */
  holeSize?: number;
  /** Chart title (renders inside chart — don't add external title) */
  title?: string;
  /** Show legend */
  showLegend?: boolean;
  /** Explicit text colour for legend/labels (hex) */
  textColor?: string;
}

/**
 * Create a pie chart.
 *
 * SMART LABEL HANDLING: By default (labelThreshold='auto'), labels are hidden
 * for slices below 5% when there are more than 5 slices. This prevents the
 * common problem of overlapping labels on small slices. The legend always
 * shows all slices, so hidden labels are still identifiable.
 *
 * To show all labels regardless of size, set labelThreshold: 0.
 * To hide labels below a specific percentage, set labelThreshold: 3 (for 3%).
 *
 * TITLE: The opts.title renders INSIDE the chart area. Do NOT also add a
 * textBox title above the chart — this causes overlapping text.
 *
 * @param opts - REQUIRED: { labels: string[], values: number[] }. Optional: colors?, showPercent?, labelThreshold?, donut?, holeSize?, title?, showLegend?, textColor?
 * @returns Chart object
 */
export function pieChart(opts: PieChartOptions): ChartResult {
  // ── Input validation ──────────────────────────────────────────────
  const labels = opts.labels || [];
  const values = opts.values || [];
  // Check for empty arrays with helpful error message
  if (!labels || labels.length === 0) {
    throw new Error(
      `pieChart.labels: array must not be empty. ` +
        `This often happens when fetched data is empty. ` +
        `Check if your data source returned results: ` +
        `if (data.length === 0) { /* show placeholder slide instead */ }`,
    );
  }
  if (!values || values.length === 0) {
    throw new Error(
      `pieChart.values: array must not be empty. ` +
        `This often happens when fetched data is empty. ` +
        `Check if your data source returned results: ` +
        `if (data.length === 0) { /* show placeholder slide instead */ }`,
    );
  }
  if (labels.length !== values.length) {
    throw new Error(
      `pieChart: labels array has ${labels.length} elements but values array ` +
        `has ${values.length}. They must have the same length — one label per slice.`,
    );
  }
  // Enforce complexity caps
  if (labels.length > MAX_CATEGORIES_PER_CHART) {
    throw new Error(
      `pieChart: ${labels.length} slices exceeds the maximum of ${MAX_CATEGORIES_PER_CHART}. ` +
        `Group smaller values into an "Other" slice.`,
    );
  }
  // Validate each value is a finite number
  values.forEach((v, i) => {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(
        `pieChart.values[${i}]: expected a number but got ${typeof v} (${JSON.stringify(v)}). ` +
          `All pie chart values must be finite numbers.`,
      );
    }
  });
  if (opts.colors) {
    requireArray(opts.colors, "pieChart.colors");
    opts.colors.forEach((c, i) => requireHex(c, `pieChart.colors[${i}]`));
  }
  if (opts.textColor) requireHex(opts.textColor, "pieChart.textColor");
  if (opts.holeSize != null) {
    requireNumber(opts.holeSize, "pieChart.holeSize", { min: 1, max: 90 });
  }
  if (
    opts.labelThreshold != null &&
    opts.labelThreshold !== "auto" &&
    (typeof opts.labelThreshold !== "number" ||
      opts.labelThreshold < 0 ||
      opts.labelThreshold > 100)
  ) {
    throw new Error(
      `pieChart.labelThreshold: must be 'auto', or a number 0-100, got ${JSON.stringify(opts.labelThreshold)}`,
    );
  }
  const showPercent = opts.showPercent !== false;
  const chartTag = opts.donut ? "c:doughnutChart" : "c:pieChart";
  const tc = opts.textColor || undefined;

  // Calculate slice percentages for smart label hiding
  const total = values.reduce((a, b) => a + b, 0);
  const percentages = total > 0 ? values.map((v) => (v / total) * 100) : [];

  // Determine label threshold
  // 'auto' (default): hide <5% labels when >5 slices
  const threshold =
    opts.labelThreshold === "auto" || opts.labelThreshold === undefined
      ? labels.length > 5
        ? 5
        : 0
      : opts.labelThreshold;

  // Check if any labels will be hidden (to force legend visibility)
  const hasHiddenLabels =
    showPercent && percentages.some((pct) => pct < threshold);

  const pts = labels
    .map((l, i) => `<c:pt idx="${i}"><c:v>${escapeXml(String(l))}</c:v></c:pt>`)
    .join("");
  const numPts = values
    .map((v, i) => `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`)
    .join("");

  // Generate per-point data labels for selective visibility based on threshold
  // Per ECMA-376, c:dLbl inside c:ser allows per-point label customization
  const dLblPos = !opts.donut ? '<c:dLblPos val="outEnd"/>' : "";
  const dlblTxPr = tc ? chartTextProps(tc) : "";

  let seriesDataLabels = "";
  if (showPercent) {
    // Generate per-point labels: show only for slices >= threshold
    const perPointLabels = percentages
      .map((pct, i) => {
        const showLabel = pct >= threshold ? "1" : "0";
        // Per ECMA-376 CT_DLbl: idx, then optional delete, then layout/tx/numFmt/spPr/txPr,
        // then dLblPos, then showLegendKey/showVal/showCatName/showSerName/showPercent
        return `<c:dLbl><c:idx val="${i}"/>${dlblTxPr}${dLblPos}<c:showVal val="0"/><c:showCatName val="${showLabel}"/><c:showSerName val="0"/><c:showPercent val="${showLabel}"/></c:dLbl>`;
      })
      .join("");

    // c:dLbls container with per-point labels + leader lines setting
    const leaderLines = !opts.donut ? '<c:showLeaderLines val="1"/>' : "";
    seriesDataLabels = `<c:dLbls>${perPointLabels}${leaderLines}</c:dLbls>`;
  }

  // Doughnut charts require a c:holeSize element (ECMA-376 §21.2.2.36).
  const holeSize = opts.donut
    ? `<c:holeSize val="${opts.holeSize || 50}"/>`
    : "";

  // Force legend to show when labels are hidden (so small slices are identifiable)
  const effectiveShowLegend =
    opts.showLegend !== false || hasHiddenLabels ? true : opts.showLegend;

  const plotArea = `<${chartTag}>
<c:varyColors val="1"/>
<c:ser>
<c:idx val="0"/><c:order val="0"/>
${piePtColors(values, opts.colors)}
${seriesDataLabels}
<c:cat><c:strRef><c:f>Sheet1!$A$2:$A$${labels.length + 1}</c:f><c:strCache><c:ptCount val="${labels.length}"/>${pts}</c:strCache></c:strRef></c:cat>
<c:val><c:numRef><c:f>Sheet1!$B$2:$B$${values.length + 1}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${values.length}"/>${numPts}</c:numCache></c:numRef></c:val>
</c:ser>
${holeSize}
</${chartTag}>`;

  return chartResult(
    "pie",
    chartXml(plotArea, opts.title, effectiveShowLegend, tc),
  );
}

export interface LineChartOptions {
  /** X-axis category labels */
  categories?: string[];
  /** Data series array. Each series must have name, values, optional color. */
  series: ChartSeries[];
  /** Smooth lines (spline) */
  smooth?: boolean;
  /** Show data point markers */
  showMarkers?: boolean;
  /** Fill area under the line */
  area?: boolean;
  /** Show data labels */
  showValues?: boolean;
  /** Chart title */
  title?: string;
  /** Show legend */
  showLegend?: boolean;
  /** Explicit text colour for axes/legend/labels (hex). Use on dark themes. */
  textColor?: string;
}

/**
 * Create a line chart.
 *
 * @example
 * const chart = lineChart({
 *   categories: ['Jan', 'Feb', 'Mar', 'Apr'],
 *   series: [
 *     { name: 'Sales', values: [100, 120, 115, 140] },
 *     { name: 'Costs', values: [80, 85, 90, 95], color: 'E91E63' }
 *   ],
 *   smooth: true,
 *   title: 'Monthly Trend',
 *   textColor: 'E6EDF3'
 * });
 *
 * @param opts - REQUIRED: { series: Array<{name, values}> }. Optional: categories?, smooth?, showMarkers?, area?, showValues?, title?, showLegend?, textColor?
 * @returns Chart object. Pass to chartSlide() or embedChart().
 */
export function lineChart(opts: LineChartOptions): ChartResult {
  // ── Input validation ──────────────────────────────────────────────
  requireArray(opts.categories || [], "lineChart.categories");
  requireArray(opts.series || [], "lineChart.series", { nonEmpty: true });
  if (opts.textColor) requireHex(opts.textColor, "lineChart.textColor");
  // Enforce complexity caps
  if ((opts.categories || []).length > MAX_CATEGORIES_PER_CHART) {
    throw new Error(
      `lineChart: ${(opts.categories || []).length} categories exceeds the maximum of ${MAX_CATEGORIES_PER_CHART}.`,
    );
  }
  if ((opts.series || []).length > MAX_SERIES_PER_CHART) {
    throw new Error(
      `lineChart: ${(opts.series || []).length} series exceeds the maximum of ${MAX_SERIES_PER_CHART}.`,
    );
  }

  const chartTag = opts.area ? "c:areaChart" : "c:lineChart";
  const grouping = "standard";
  const categories = opts.categories || [];
  const series = opts.series || [];
  const tc = opts.textColor || undefined;

  const seriesXmls = series
    .map((s, i) => {
      const color = hexColor(
        s.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length],
      );
      const colLetter = String.fromCharCode(66 + i);
      // c:smooth is only valid in lineChart, NOT in areaChart (ECMA-376)
      const smooth = opts.area
        ? ""
        : opts.smooth
          ? `<c:smooth val="1"/>`
          : `<c:smooth val="0"/>`;
      // c:marker is only valid in lineChart, NOT in areaChart (ECMA-376)
      const marker = opts.area
        ? ""
        : opts.showMarkers === false
          ? `<c:marker><c:symbol val="none"/></c:marker>`
          : `<c:marker><c:symbol val="circle"/><c:size val="5"/><c:spPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></c:spPr></c:marker>`;
      const showVals = opts.showValues
        ? `<c:dLbls><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/></c:dLbls>`
        : "";

      if (!s.name) {
        throw new Error(
          `lineChart series at index ${i} is missing required 'name'. ` +
            `Provide: { name: 'Revenue', values: [...] }`,
        );
      }
      // Check for empty values with helpful error message
      if (!s.values || s.values.length === 0) {
        throw new Error(
          `lineChart.series[${i}].values: array must not be empty. ` +
            `This often happens when fetched data is empty. ` +
            `Check if your data source returned results: ` +
            `if (data.length === 0) { /* show placeholder slide instead */ }`,
        );
      }
      if (s.color) requireHex(s.color, `lineChart.series[${i}].color`);
      // Validate values-to-categories length match
      if (categories.length > 0 && s.values.length !== categories.length) {
        throw new Error(
          `lineChart series[${i}] "${s.name}": values array has ${s.values.length} ` +
            `elements but there are ${categories.length} categories. ` +
            `Each series must have exactly one value per category.`,
        );
      }
      // Validate each value is numeric
      s.values.forEach((v, vi) => {
        if (typeof v !== "number" || !Number.isFinite(v)) {
          throw new Error(
            `lineChart series[${i}] "${s.name}": value at index ${vi} is ` +
              `${typeof v} (${JSON.stringify(v)}) — expected a finite number.`,
          );
        }
      });

      return `<c:ser>
<c:idx val="${i}"/><c:order val="${i}"/>
<c:tx><c:strRef><c:f>Sheet1!$${colLetter}$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${escapeXml(s.name)}</c:v></c:pt></c:strCache></c:strRef></c:tx>
<c:spPr><a:ln w="25400"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:ln></c:spPr>
${marker}
${showVals}
${catRef(categories)}
${numRef(s.values, "Sheet1", colLetter, s.name)}
${smooth}
</c:ser>`;
    })
    .join("");

  const plotArea = `<${chartTag}>
<c:grouping val="${grouping}"/>
${seriesXmls}
<c:axId val="1"/><c:axId val="2"/>
</${chartTag}>
${axisXml(1, 2, "b", true, tc)}
${axisXml(2, 1, "l", false, tc)}`;

  return chartResult(
    opts.area ? "area" : "line",
    chartXml(plotArea, opts.title, opts.showLegend, tc),
  );
}

export interface ComboChartOptions {
  /** X-axis category labels */
  categories?: string[];
  /** Bar data series. Each must have name, values, optional color. */
  barSeries?: ChartSeries[];
  /** Line data series (overlaid). Each must have name, values, optional color. */
  lineSeries?: ChartSeries[];
  /** Show data labels */
  showValues?: boolean;
  /** Chart title */
  title?: string;
  /** Show legend */
  showLegend?: boolean;
  /** Explicit text colour for axes/legend (hex). Use on dark themes. */
  textColor?: string;
}

/**
 * Create a combo chart — bars + line overlay on the same axes.
 *
 * @example
 * const chart = comboChart({
 *   categories: ['Q1', 'Q2', 'Q3', 'Q4'],
 *   barSeries: [
 *     { name: 'Revenue', values: [100, 120, 140, 160] }
 *   ],
 *   lineSeries: [
 *     { name: 'Target', values: [110, 130, 150, 170], color: 'FF5722' }
 *   ],
 *   title: 'Revenue vs Target'
 * });
 *
 * @param opts - Optional: { categories?, barSeries?, lineSeries?, showValues?, title?, showLegend?, textColor? }. At least one of barSeries or lineSeries required.
 * @returns Chart object. Pass to chartSlide() or embedChart().
 */
export function comboChart(opts: ComboChartOptions): ChartResult {
  // ── Input validation ──────────────────────────────────────────────
  requireArray(opts.categories || [], "comboChart.categories");
  // Enforce complexity caps
  if ((opts.categories || []).length > MAX_CATEGORIES_PER_CHART) {
    throw new Error(
      `comboChart: ${(opts.categories || []).length} categories exceeds the maximum of ${MAX_CATEGORIES_PER_CHART}.`,
    );
  }
  const barSeries = opts.barSeries || [];
  const lineSeries = opts.lineSeries || [];
  requireArray(barSeries, "comboChart.barSeries");
  requireArray(lineSeries, "comboChart.lineSeries");
  if (barSeries.length + lineSeries.length === 0) {
    throw new Error(
      "comboChart: at least one series is required in barSeries or lineSeries. " +
        "Provide data like: barSeries: [{ name: 'Revenue', values: [1,2,3] }]",
    );
  }
  if (barSeries.length + lineSeries.length > 24) {
    throw new Error(
      `comboChart: total series count (${barSeries.length + lineSeries.length}) ` +
        `exceeds the maximum of 24 due to Excel column reference limits.`,
    );
  }
  if (opts.textColor) requireHex(opts.textColor, "comboChart.textColor");

  const categories = opts.categories || [];
  const tc = opts.textColor || undefined;

  const barXmls = barSeries
    .map((s, i) => seriesXml(s, i, categories, opts))
    .join("");
  const lineXmls = lineSeries
    .map((s, i) => {
      const idx = barSeries.length + i;
      requireString(s.name, `comboChart.lineSeries[${i}].name`);
      requireArray(s.values, `comboChart.lineSeries[${i}].values`, {
        nonEmpty: true,
      });
      if (s.color) requireHex(s.color, `comboChart.lineSeries[${i}].color`);
      // Validate values-to-categories length match
      if (categories.length > 0 && s.values.length !== categories.length) {
        throw new Error(
          `comboChart lineSeries[${i}] "${s.name}": values array has ${s.values.length} ` +
            `elements but there are ${categories.length} categories.`,
        );
      }
      // Validate each value is numeric
      s.values.forEach((v, vi) => {
        if (typeof v !== "number" || !Number.isFinite(v)) {
          throw new Error(
            `comboChart lineSeries[${i}] "${s.name}": value at index ${vi} is ` +
              `${typeof v} (${JSON.stringify(v)}) — expected a finite number.`,
          );
        }
      });
      const color = hexColor(
        s.color || DEFAULT_COLORS[idx % DEFAULT_COLORS.length],
      );
      const colLetter = String.fromCharCode(66 + idx);
      return `<c:ser>
<c:idx val="${idx}"/><c:order val="${idx}"/>
<c:tx><c:strRef><c:f>Sheet1!$${colLetter}$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${escapeXml(s.name)}</c:v></c:pt></c:strCache></c:strRef></c:tx>
<c:spPr><a:ln w="25400"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:ln></c:spPr>
<c:marker><c:symbol val="circle"/><c:size val="5"/><c:spPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></c:spPr></c:marker>
${catRef(categories)}
${numRef(s.values, "Sheet1", colLetter, s.name)}
<c:smooth val="0"/>
</c:ser>`;
    })
    .join("");

  const plotArea = `<c:barChart>
<c:barDir val="col"/>
<c:grouping val="clustered"/>
<c:varyColors val="0"/>
${barXmls}
<c:axId val="1"/><c:axId val="2"/>
</c:barChart>
<c:lineChart>
<c:grouping val="standard"/>
${lineXmls}
<c:axId val="1"/><c:axId val="2"/>
</c:lineChart>
${axisXml(1, 2, "b", true, tc)}
${axisXml(2, 1, "l", false, tc)}`;

  return chartResult(
    "combo",
    chartXml(plotArea, opts.title, opts.showLegend, tc),
  );
}

// ── Chart Embedding into PPTX Slides ─────────────────────────────────

export interface ChartPosition {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

export interface EmbedChartResult {
  /** ShapeFragment for use in customSlide shapes array. */
  shape: ShapeFragment;
  /** @internal Raw shape XML string (kept for internal compatibility). */
  shapeXml: string;
  zipEntries: Array<{ name: string; data: string }>;
  chartRelId: string;
  chartIndex: number;
  /** @deprecated Throws error — use .shape instead. */
  toString(): string;
}

// Internal presentation type for chart embedding
interface PresentationWithCharts {
  slides: unknown[];
  _chartIndex?: number;
  _charts?: Array<{
    index: number;
    slideIndex: number;
    relId: string;
    chartPath: string;
  }>;
  _chartEntries?: Array<{ name: string; data: string }>;
}

/**
 * Embed a chart into a presentation. Returns the shape XML fragment for the
 * slide body + the ZIP entries for the chart parts.
 *
 * POSITIONING: Pass position via the third argument, OR set x/y/w/h on the chart
 * object itself. The pos argument takes precedence if provided.
 *
 * Usage:
 *   const chart = barChart({...});
 *   const { shapeXml, zipEntries } = embedChart(pres, chart, {x:1, y:1.5, w:10, h:5});
 *   customSlide(pres, { shapes: shapeXml });
 *   // Add zipEntries to pres before build, or merge into final entries
 *
 * @param pres - Presentation builder (to track chart index)
 * @param chart - Chart object from barChart/pieChart/lineChart
 * @param pos - Position {x?, y?, w?, h?} in inches. Falls back to chart.x/y/w/h if not specified.
 * @returns Embed result with shapeXml and zipEntries
 */
export function embedChart(
  pres: PresentationWithCharts,
  chart: ChartResult,
  pos: ChartPosition,
): EmbedChartResult {
  // ── Input validation ──────────────────────────────────────────────
  if (pres == null) {
    throw new Error(
      "embedChart: 'pres' (presentation builder) is required as the first argument. " +
        "Pass the object returned by createPresentation().",
    );
  }
  // Enforce deck-level chart cap
  const currentChartCount = (pres._charts || []).length;
  if (currentChartCount >= MAX_CHARTS_PER_DECK) {
    throw new Error(
      `embedChart: deck already has ${currentChartCount} charts — max ${MAX_CHARTS_PER_DECK}. ` +
        `Reduce chart count or split into multiple presentations.`,
    );
  }
  if (chart == null || chart.type !== "chart") {
    throw new Error(
      "embedChart: 'chart' must be a chart object from barChart/pieChart/lineChart/comboChart. " +
        "Build the chart first: const chart = barChart({...}); then pass it to embedChart.",
    );
  }

  // Position can come from pos argument OR from chart object (for convenience)
  // This allows: embedChart(pres, chart, {x:1, y:2, w:8, h:5})
  // Or:          embedChart(pres, {...barChart(...), x:1, y:2, w:8, h:5})
  const position = pos || {};
  const chartPos: ChartPosition =
    chart.x != null || chart.y != null || chart.w != null || chart.h != null
      ? { x: chart.x, y: chart.y, w: chart.w, h: chart.h }
      : {};

  // Find highest chart index to avoid conflicts after sandbox rebuild
  let maxIdx = pres._chartIndex || 0;
  if (pres._charts) {
    for (const c of pres._charts) {
      if (c.index > maxIdx) maxIdx = c.index;
    }
  }
  if (pres._chartEntries) {
    for (const entry of pres._chartEntries) {
      const match = entry.name.match(/chart(\d+)\.xml$/);
      if (match) {
        const entryIdx = parseInt(match[1], 10);
        if (entryIdx > maxIdx) maxIdx = entryIdx;
      }
    }
  }
  pres._chartIndex = maxIdx + 1;
  const idx = pres._chartIndex;
  const slideIdx = pres.slides.length + 1; // will be added to this slide

  const relId = `rIdChart${idx}`;
  const x = inches(position.x ?? chartPos.x ?? 0);
  const y = inches(position.y ?? chartPos.y ?? 0);
  const w = inches(position.w ?? chartPos.w ?? 8);
  const h = inches(position.h ?? chartPos.h ?? 5);

  // Shape XML fragment (graphicFrame referencing the chart)
  const shapeXml = `<p:graphicFrame>
<p:nvGraphicFramePr><p:cNvPr id="${nextShapeId()}" name="Chart ${idx}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>
<p:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></p:xfrm>
<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="${NS_C}" r:id="${relId}"/></a:graphicData></a:graphic>
</p:graphicFrame>`;

  // ZIP entries for the chart part + rels
  const chartPath = `ppt/charts/chart${idx}.xml`;
  const zipEntries = [
    { name: chartPath, data: chart._chartXml },
    {
      name: `ppt/charts/_rels/chart${idx}.xml.rels`,
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`,
    },
  ];

  // Track chart metadata for build() to add rels + content types
  if (!pres._charts) pres._charts = [];
  pres._charts.push({
    index: idx,
    slideIndex: slideIdx,
    relId,
    chartPath: `charts/chart${idx}.xml`,
  });

  // Store chart ZIP entries on pres so build() includes them automatically
  if (!pres._chartEntries) pres._chartEntries = [];
  for (const entry of zipEntries) {
    pres._chartEntries.push(entry);
  }

  // Return structured result — use .shape for customSlide arrays.
  // toString() now THROWS to prevent accidental XML concatenation.
  const result: EmbedChartResult = {
    shape: _createShapeFragment(shapeXml),
    shapeXml,
    zipEntries,
    chartRelId: relId,
    chartIndex: idx,
    toString(): string {
      throw new Error(
        "Cannot concatenate embedChart result directly into shapes. " +
          "Use the .shape property in your shapes array: " +
          "customSlide(pres, { shapes: [textBox(...), chart.shape, rect(...)] })",
      );
    },
  };
  return result;
}
