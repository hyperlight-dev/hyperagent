// ── ha:pdf-charts — Chart Rendering for PDF Documents ────────────────
//
// Renders bar, line, pie, and combo charts as PDF drawing operations.
// Charts are returned as PdfElement objects for use with addContent().
//
// All chart rendering is done using abstract drawing ops (text, rect, line)
// that are coordinates-relative to the chart's top-left corner. The ha:pdf
// module translates these to absolute page coordinates when rendering.
//
// USAGE:
//   import { barChart } from "ha:pdf-charts";
//   import { createDocument, addContent } from "ha:pdf";
//   const doc = createDocument();
//   addContent(doc, [
//     barChart({ categories: ["Q1","Q2"], series: [{ name: "Rev", values: [100,200] }] })
//   ]);

import {
  requireArray,
  requireNumber,
  requireString,
  getTheme,
  hexColor,
  type Theme,
} from "ha:doc-core";
import {
  _createPdfElement,
  measureText,
  type PdfElement,
  type ChartDrawOp,
} from "ha:pdf";

// ── Chart Complexity Caps ────────────────────────────────────────────
// Hard limits to prevent documents that exhaust viewer rendering budgets.

/** Maximum charts per document. */
export const MAX_CHARTS_PER_DOC = 50;

/** Maximum data series per chart. */
export const MAX_SERIES_PER_CHART = 24;

/** Maximum categories (X-axis labels) per chart. */
export const MAX_CATEGORIES = 100;

/** Maximum pie chart slices. */
export const MAX_PIE_SLICES = 100;

// ── Default Chart Colours ────────────────────────────────────────────
// Palette for auto-assigning series colours when not explicitly specified.
// Designed for good contrast and colour-blind friendliness.

const DEFAULT_PALETTE = [
  "2196F3", // Blue
  "4CAF50", // Green
  "FF9800", // Orange
  "E91E63", // Pink
  "9C27B0", // Purple
  "00BCD4", // Cyan
  "FF5722", // Deep Orange
  "607D8B", // Blue Grey
  "795548", // Brown
  "CDDC39", // Lime
  "3F51B5", // Indigo
  "009688", // Teal
];

// ── Chart Layout Constants ───────────────────────────────────────────
// Named constants for chart geometry (no magic numbers! 🎯)

/** Default chart width in points. */
const CHART_WIDTH = 400;

/** Default chart height in points. */
const CHART_HEIGHT = 250;

/** Padding inside the chart area (points). */
const CHART_PADDING = 10;

/** Space reserved for Y-axis labels on the left (points). */
const Y_AXIS_LABEL_WIDTH = 50;

/** Space reserved for X-axis labels at the bottom (points). */
const X_AXIS_LABEL_HEIGHT = 30;

/** Font size for axis labels (points). */
const AXIS_FONT_SIZE = 8;

/** Font size for legend text (points). */
const LEGEND_FONT_SIZE = 8;

/** Legend colour swatch size (points). */
const LEGEND_SWATCH_SIZE = 8;

/** Gap between legend items (points). */
const LEGEND_ITEM_GAP = 12;

/** Space reserved for legend below chart (points). */
const LEGEND_HEIGHT = 20;

/** Font size for chart title (points). */
const TITLE_FONT_SIZE = 14;

/** Space below chart title (points). */
const TITLE_GAP = 8;

// ── Data Validation ──────────────────────────────────────────────────

/** Validate that all values in an array are finite numbers. */
function validateValues(values: unknown[], paramName: string): number[] {
  const result: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(
        `${paramName}[${i}]: expected a finite number but got ${typeof v} (${JSON.stringify(v)}). ` +
          `All chart values must be finite numbers — not null, undefined, NaN, or strings.`,
      );
    }
    result.push(v);
  }
  return result;
}

// ── Axis Rendering Helpers ───────────────────────────────────────────

/**
 * Calculate nice Y-axis tick values for a given data range.
 * Returns evenly spaced values that include 0 and cover the data range.
 * The number of ticks adapts to the available plot height to prevent
 * overlapping labels on small charts.
 *
 * @param minVal - Minimum data value
 * @param maxVal - Maximum data value
 * @param plotHeight - Available plot height in points (optional, defaults to 200)
 */
function niceAxisTicks(
  minVal: number,
  maxVal: number,
  plotHeight?: number,
): number[] {
  if (minVal === maxVal) {
    // All values are the same — create a range around it
    return minVal === 0 ? [0, 1] : [0, minVal];
  }

  // Ensure we include 0 in the axis
  const lo = Math.min(0, minVal);
  const hi = Math.max(0, maxVal);
  const range = hi - lo;

  // Adapt tick count to chart height — each tick label needs ~18pt
  // (8pt font + 10pt gap) to avoid overlapping
  const MIN_PT_PER_TICK = 18;
  const availableHeight = plotHeight ?? 200;
  const maxTicks = Math.max(2, Math.floor(availableHeight / MIN_PT_PER_TICK));
  const TARGET_TICKS = Math.min(5, maxTicks);

  // Pick a nice step size (1, 2, 5, 10, 20, 50, 100, ...)
  const rawStep = range / TARGET_TICKS;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const residual = rawStep / magnitude;

  let niceStep: number;
  if (residual <= 1.5) niceStep = magnitude;
  else if (residual <= 3.5) niceStep = 2 * magnitude;
  else if (residual <= 7.5) niceStep = 5 * magnitude;
  else niceStep = 10 * magnitude;

  // Generate ticks
  const tickStart = Math.floor(lo / niceStep) * niceStep;
  const ticks: number[] = [];
  for (let t = tickStart; t <= hi + niceStep * 0.01; t += niceStep) {
    ticks.push(Math.round(t * 1e10) / 1e10); // Avoid floating point noise
  }
  return ticks;
}

/**
 * Format a number for axis labels (compact representation).
 */
function formatAxisValue(v: number): string {
  if (Math.abs(v) >= 1_000_000) return (v / 1_000_000).toFixed(1) + "M";
  if (Math.abs(v) >= 1_000) return (v / 1_000).toFixed(1) + "K";
  if (Number.isInteger(v)) return v.toString();
  return v.toFixed(1);
}

// ── Chart Series Type ────────────────────────────────────────────────

/** A data series for bar/line/combo charts. */
export interface ChartSeries {
  /** Series name (REQUIRED — shown in legend). */
  name: string;
  /** Data values (must match categories length). */
  values: number[];
  /** Series colour as 6-char hex. Auto-assigned from palette if omitted. */
  color?: string;
}

// ── Bar Chart ────────────────────────────────────────────────────────

/** Options for barChart(). */
export interface BarChartOptions {
  /** Category labels (X-axis). */
  categories: string[];
  /** Data series. Each must have name and values matching categories length. */
  series: ChartSeries[];
  /** Chart title (drawn above chart). */
  title?: string;
  /** Chart subtitle (rendered smaller below title, e.g. "Values in $M"). */
  subtitle?: string;
  /** Chart width in points. Default: 400. */
  width?: number;
  /** Chart height in points (TOTAL including axes, legend, and padding — not just the plot area). Default: 250. In addContent, a chart title adds ~21pt on top. */
  height?: number;
  /** If true, draw horizontal bars instead of vertical. Default: false. */
  horizontal?: boolean;
  /** If true, stack series instead of grouping. Default: false. */
  stacked?: boolean;
  /** Text colour for labels. Default: theme foreground. */
  textColor?: string;
}

/**
 * Create a bar chart element for flow layout.
 * Returns a PdfElement containing pre-computed drawing operations.
 *
 * @param opts - Bar chart options
 * @returns PdfElement for use with addContent()
 */
export function barChart(opts: BarChartOptions): PdfElement {
  const categories = requireArray<string>(
    opts.categories,
    "barChart.categories",
    {
      nonEmpty: true,
    },
  );
  const series = requireArray<ChartSeries>(opts.series, "barChart.series", {
    nonEmpty: true,
  });

  // Validate constraints
  if (series.length > MAX_SERIES_PER_CHART) {
    throw new Error(
      `barChart: ${series.length} series exceeds the maximum of ${MAX_SERIES_PER_CHART}.`,
    );
  }
  if (categories.length > MAX_CATEGORIES) {
    throw new Error(
      `barChart: ${categories.length} categories exceeds the maximum of ${MAX_CATEGORIES}.`,
    );
  }

  // Validate and assign colours
  const seriesData = series.map((s, i) => {
    requireString(s.name, `barChart.series[${i}].name`);
    const values = validateValues(s.values, `barChart.series[${i}].values`);
    if (values.length !== categories.length) {
      throw new Error(
        `barChart.series[${i}].values: expected ${categories.length} values ` +
          `(matching categories) but got ${values.length}.`,
      );
    }
    return {
      name: s.name,
      values,
      color: s.color
        ? hexColor(s.color)
        : DEFAULT_PALETTE[i % DEFAULT_PALETTE.length],
    };
  });

  const chartW = opts.width ?? CHART_WIDTH;
  const chartH = opts.height ?? CHART_HEIGHT;
  const textColor = opts.textColor ?? "333333";

  const ops: ChartDrawOp[] = [];

  // Calculate plot area (inside padding and axis labels)
  const plotLeft = Y_AXIS_LABEL_WIDTH;
  const plotTop = CHART_PADDING;
  const plotRight = chartW - CHART_PADDING;
  const plotBottom = chartH - X_AXIS_LABEL_HEIGHT - LEGEND_HEIGHT;
  const plotW = plotRight - plotLeft;
  const plotH = plotBottom - plotTop;

  // Find data range for Y axis
  let minVal = 0;
  let maxVal = 0;
  if (opts.stacked) {
    for (let ci = 0; ci < categories.length; ci++) {
      let stackPos = 0;
      let stackNeg = 0;
      for (const s of seriesData) {
        if (s.values[ci] >= 0) stackPos += s.values[ci];
        else stackNeg += s.values[ci];
      }
      maxVal = Math.max(maxVal, stackPos);
      minVal = Math.min(minVal, stackNeg);
    }
  } else {
    for (const s of seriesData) {
      for (const v of s.values) {
        maxVal = Math.max(maxVal, v);
        minVal = Math.min(minVal, v);
      }
    }
  }

  const ticks = niceAxisTicks(minVal, maxVal, plotH);
  const axisMin = ticks[0];
  const axisMax = ticks[ticks.length - 1];
  const axisRange = axisMax - axisMin || 1;

  // ── Draw axes ──
  // Y-axis line
  ops.push({
    type: "line",
    x: plotLeft,
    y: plotTop,
    x2: plotLeft,
    y2: plotBottom,
    stroke: "CCCCCC",
    lineWidth: 0.5,
  });
  // X-axis line
  ops.push({
    type: "line",
    x: plotLeft,
    y: plotBottom,
    x2: plotRight,
    y2: plotBottom,
    stroke: "CCCCCC",
    lineWidth: 0.5,
  });

  // ── Y-axis ticks and grid lines ──
  for (const tick of ticks) {
    const yFrac = (tick - axisMin) / axisRange;
    const y = plotBottom - yFrac * plotH;
    // Grid line
    ops.push({
      type: "line",
      x: plotLeft,
      y,
      x2: plotRight,
      y2: y,
      stroke: "EEEEEE",
      lineWidth: 0.25,
    });
    // Label (right-aligned against the Y-axis)
    const tickLabel = formatAxisValue(tick);
    const tickLabelW = measureText(tickLabel, "Helvetica", AXIS_FONT_SIZE);
    ops.push({
      type: "text",
      x: plotLeft - 4 - tickLabelW,
      y: y - AXIS_FONT_SIZE / 3,
      text: tickLabel,
      font: "Helvetica",
      fontSize: AXIS_FONT_SIZE,
      color: textColor,
    });
  }

  // ── Draw bars ──
  const categoryWidth = plotW / categories.length;
  const numSeries = seriesData.length;
  const barGap = 2; // Gap between bars in a group (points)
  const groupPadding = categoryWidth * 0.15; // Padding on each side of group

  if (opts.stacked) {
    const barWidth = categoryWidth - groupPadding * 2;
    for (let ci = 0; ci < categories.length; ci++) {
      let stackY = 0;
      for (const s of seriesData) {
        const v = s.values[ci];
        const barH = (Math.abs(v) / axisRange) * plotH;
        const yBase =
          plotBottom -
          ((stackY + Math.max(0, v) - axisMin) / axisRange) * plotH;
        ops.push({
          type: "rect",
          x: plotLeft + ci * categoryWidth + groupPadding,
          y: yBase,
          w: barWidth,
          h: barH,
          fill: s.color,
        });
        stackY += v;
      }
    }
  } else {
    const barWidth =
      (categoryWidth - groupPadding * 2 - barGap * (numSeries - 1)) / numSeries;

    for (let ci = 0; ci < categories.length; ci++) {
      for (let si = 0; si < numSeries; si++) {
        const v = seriesData[si].values[ci];
        const barH = (Math.abs(v) / axisRange) * plotH;
        const zeroY = plotBottom - ((0 - axisMin) / axisRange) * plotH;
        const barX =
          plotLeft +
          ci * categoryWidth +
          groupPadding +
          si * (barWidth + barGap);
        const barY = v >= 0 ? zeroY - barH : zeroY;
        ops.push({
          type: "rect",
          x: barX,
          y: barY,
          w: barWidth,
          h: barH,
          fill: seriesData[si].color,
        });
      }
    }
  }

  // ── X-axis category labels ──
  for (let ci = 0; ci < categories.length; ci++) {
    const labelX = plotLeft + ci * categoryWidth + categoryWidth / 2;
    const labelW = measureText(categories[ci], "Helvetica", AXIS_FONT_SIZE);
    ops.push({
      type: "text",
      x: labelX - labelW / 2,
      y: plotBottom + 8,
      text: categories[ci],
      font: "Helvetica",
      fontSize: AXIS_FONT_SIZE,
      color: textColor,
    });
  }

  // ── Legend ──
  let legendX = plotLeft;
  const legendY = chartH - LEGEND_HEIGHT + 4;
  for (const s of seriesData) {
    // Colour swatch
    ops.push({
      type: "rect",
      x: legendX,
      y: legendY,
      w: LEGEND_SWATCH_SIZE,
      h: LEGEND_SWATCH_SIZE,
      fill: s.color,
    });
    // Label
    ops.push({
      type: "text",
      x: legendX + LEGEND_SWATCH_SIZE + 3,
      y: legendY,
      text: s.name,
      font: "Helvetica",
      fontSize: LEGEND_FONT_SIZE,
      color: textColor,
    });
    legendX +=
      LEGEND_SWATCH_SIZE +
      3 +
      measureText(s.name, "Helvetica", LEGEND_FONT_SIZE) +
      LEGEND_ITEM_GAP;
  }

  return _createPdfElement("chart", {
    drawOps: ops,
    width: chartW,
    height: chartH,
    title: opts.title,
    subtitle: opts.subtitle,
  });
}

// ── Line Chart ───────────────────────────────────────────────────────

/** Options for lineChart(). */
export interface LineChartOptions {
  /** Category labels (X-axis). */
  categories: string[];
  /** Data series. */
  series: ChartSeries[];
  /** Chart title. */
  title?: string;
  /** Chart subtitle (rendered smaller below title, e.g. "Values in $M"). */
  subtitle?: string;
  /** Chart width in points. Default: 400. */
  width?: number;
  /** Chart height in points (TOTAL including axes, legend, and padding — not just the plot area). Default: 250. In addContent, a chart title adds ~21pt on top. */
  height?: number;
  /** If true, draw area fill under lines. Default: false. */
  area?: boolean;
  /** Text colour for labels. Default: '333333'. */
  textColor?: string;
}

/**
 * Create a line chart element for flow layout.
 *
 * @param opts - Line chart options
 * @returns PdfElement for use with addContent()
 */
export function lineChart(opts: LineChartOptions): PdfElement {
  const categories = requireArray<string>(
    opts.categories,
    "lineChart.categories",
    {
      nonEmpty: true,
    },
  );
  const series = requireArray<ChartSeries>(opts.series, "lineChart.series", {
    nonEmpty: true,
  });

  if (series.length > MAX_SERIES_PER_CHART) {
    throw new Error(
      `lineChart: ${series.length} series exceeds the maximum of ${MAX_SERIES_PER_CHART}.`,
    );
  }
  if (categories.length > MAX_CATEGORIES) {
    throw new Error(
      `lineChart: ${categories.length} categories exceeds the maximum of ${MAX_CATEGORIES}.`,
    );
  }

  const seriesData = series.map((s, i) => {
    requireString(s.name, `lineChart.series[${i}].name`);
    const values = validateValues(s.values, `lineChart.series[${i}].values`);
    if (values.length !== categories.length) {
      throw new Error(
        `lineChart.series[${i}].values: expected ${categories.length} values ` +
          `(matching categories) but got ${values.length}.`,
      );
    }
    return {
      name: s.name,
      values,
      color: s.color
        ? hexColor(s.color)
        : DEFAULT_PALETTE[i % DEFAULT_PALETTE.length],
    };
  });

  const chartW = opts.width ?? CHART_WIDTH;
  const chartH = opts.height ?? CHART_HEIGHT;
  const textColor = opts.textColor ?? "333333";

  const ops: ChartDrawOp[] = [];

  // Plot area
  const plotLeft = Y_AXIS_LABEL_WIDTH;
  const plotTop = CHART_PADDING;
  const plotRight = chartW - CHART_PADDING;
  const plotBottom = chartH - X_AXIS_LABEL_HEIGHT - LEGEND_HEIGHT;
  const plotW = plotRight - plotLeft;
  const plotH = plotBottom - plotTop;

  // Data range
  let minVal = 0;
  let maxVal = 0;
  for (const s of seriesData) {
    for (const v of s.values) {
      maxVal = Math.max(maxVal, v);
      minVal = Math.min(minVal, v);
    }
  }

  const ticks = niceAxisTicks(minVal, maxVal, plotH);
  const axisMin = ticks[0];
  const axisMax = ticks[ticks.length - 1];
  const axisRange = axisMax - axisMin || 1;

  // Axes
  ops.push({
    type: "line",
    x: plotLeft,
    y: plotTop,
    x2: plotLeft,
    y2: plotBottom,
    stroke: "CCCCCC",
    lineWidth: 0.5,
  });
  ops.push({
    type: "line",
    x: plotLeft,
    y: plotBottom,
    x2: plotRight,
    y2: plotBottom,
    stroke: "CCCCCC",
    lineWidth: 0.5,
  });

  // Y-axis ticks
  for (const tick of ticks) {
    const yFrac = (tick - axisMin) / axisRange;
    const y = plotBottom - yFrac * plotH;
    ops.push({
      type: "line",
      x: plotLeft,
      y,
      x2: plotRight,
      y2: y,
      stroke: "EEEEEE",
      lineWidth: 0.25,
    });
    // Label (right-aligned against the Y-axis)
    const tickLabel = formatAxisValue(tick);
    const tickLabelW = measureText(tickLabel, "Helvetica", AXIS_FONT_SIZE);
    ops.push({
      type: "text",
      x: plotLeft - 4 - tickLabelW,
      y: y - AXIS_FONT_SIZE / 3,
      text: tickLabel,
      font: "Helvetica",
      fontSize: AXIS_FONT_SIZE,
      color: textColor,
    });
  }

  // X-axis labels
  const catStep = plotW / (categories.length - 1 || 1);
  for (let ci = 0; ci < categories.length; ci++) {
    const x = plotLeft + ci * catStep;
    const labelW = measureText(categories[ci], "Helvetica", AXIS_FONT_SIZE);
    ops.push({
      type: "text",
      x: x - labelW / 2,
      y: plotBottom + 8,
      text: categories[ci],
      font: "Helvetica",
      fontSize: AXIS_FONT_SIZE,
      color: textColor,
    });
  }

  // Data lines
  for (const s of seriesData) {
    for (let ci = 0; ci < s.values.length - 1; ci++) {
      const x1 = plotLeft + ci * catStep;
      const y1 = plotBottom - ((s.values[ci] - axisMin) / axisRange) * plotH;
      const x2 = plotLeft + (ci + 1) * catStep;
      const y2 =
        plotBottom - ((s.values[ci + 1] - axisMin) / axisRange) * plotH;
      ops.push({
        type: "line",
        x: x1,
        y: y1,
        x2: x2,
        y2: y2,
        stroke: s.color,
        lineWidth: 2,
      });
    }

    // Data point markers (circular, approximated with polygon)
    const MARKER_RADIUS = 3;
    const MARKER_SEGMENTS = 12; // Enough for a small circle
    for (let ci = 0; ci < s.values.length; ci++) {
      const cx = plotLeft + ci * catStep;
      const cy = plotBottom - ((s.values[ci] - axisMin) / axisRange) * plotH;
      const circlePoints: Array<[number, number]> = [];
      for (let seg = 0; seg <= MARKER_SEGMENTS; seg++) {
        const angle = (seg / MARKER_SEGMENTS) * Math.PI * 2;
        circlePoints.push([
          cx + Math.cos(angle) * MARKER_RADIUS,
          cy + Math.sin(angle) * MARKER_RADIUS,
        ]);
      }
      ops.push({
        type: "polygon",
        x: 0,
        y: 0,
        points: circlePoints,
        fill: s.color,
      });
    }
  }

  // Legend
  let legendX = plotLeft;
  const legendY = chartH - LEGEND_HEIGHT + 4;
  for (const s of seriesData) {
    ops.push({
      type: "rect",
      x: legendX,
      y: legendY,
      w: LEGEND_SWATCH_SIZE,
      h: LEGEND_SWATCH_SIZE,
      fill: s.color,
    });
    ops.push({
      type: "text",
      x: legendX + LEGEND_SWATCH_SIZE + 3,
      y: legendY,
      text: s.name,
      font: "Helvetica",
      fontSize: LEGEND_FONT_SIZE,
      color: textColor,
    });
    legendX +=
      LEGEND_SWATCH_SIZE +
      3 +
      measureText(s.name, "Helvetica", LEGEND_FONT_SIZE) +
      LEGEND_ITEM_GAP;
  }

  return _createPdfElement("chart", {
    drawOps: ops,
    width: chartW,
    height: chartH,
    title: opts.title,
    subtitle: opts.subtitle,
  });
}

// ── Pie Chart ────────────────────────────────────────────────────────

/** Options for pieChart(). */
export interface PieChartOptions {
  /** Slice labels. */
  labels: string[];
  /** Slice values (positive numbers). */
  values: number[];
  /** Chart title. */
  title?: string;
  /** Chart subtitle (rendered smaller below title, e.g. "Values in $M"). */
  subtitle?: string;
  /** Chart width in points. Default: 400. */
  width?: number;
  /** Chart height in points (TOTAL including axes, legend, and padding — not just the plot area). Default: 250. In addContent, a chart title adds ~21pt on top. */
  height?: number;
  /** Slice colours as 6-char hex array. Auto-assigned if omitted. */
  colors?: string[];
  /** If true, render as donut chart with a hole in the center. Default: false. */
  donut?: boolean;
  /** Text colour for labels. Default: '333333'. */
  textColor?: string;
}

/**
 * Create a pie chart element for flow layout.
 * Pie slices are approximated using line segments (PDF has no arc primitive
 * — Bézier arc approximation is complex). For Phase 5, we use a polygon
 * approximation with enough segments to look smooth.
 *
 * @param opts - Pie chart options
 * @returns PdfElement for use with addContent()
 */
export function pieChart(opts: PieChartOptions): PdfElement {
  const labels = requireArray<string>(opts.labels, "pieChart.labels", {
    nonEmpty: true,
  });
  const rawValues = requireArray<number>(opts.values, "pieChart.values", {
    nonEmpty: true,
  });
  const values = validateValues(rawValues, "pieChart.values");

  if (labels.length !== values.length) {
    throw new Error(
      `pieChart: labels.length (${labels.length}) must equal values.length (${values.length}).`,
    );
  }
  if (values.length > MAX_PIE_SLICES) {
    throw new Error(
      `pieChart: ${values.length} slices exceeds the maximum of ${MAX_PIE_SLICES}.`,
    );
  }
  // All values must be positive
  for (let i = 0; i < values.length; i++) {
    if (values[i] < 0) {
      throw new Error(
        `pieChart.values[${i}]: pie chart values must be non-negative but got ${values[i]}.`,
      );
    }
  }

  const total = values.reduce((sum, v) => sum + v, 0);
  if (total <= 0) {
    throw new Error("pieChart: total of all values must be greater than 0.");
  }

  const chartW = opts.width ?? CHART_WIDTH;
  const chartH = opts.height ?? CHART_HEIGHT;
  const textColor = opts.textColor ?? "333333";
  const colors =
    opts.colors?.map((c) => hexColor(c)) ??
    labels.map((_, i) => DEFAULT_PALETTE[i % DEFAULT_PALETTE.length]);

  const ops: ChartDrawOp[] = [];

  // Pie center and radius
  const centerX = chartW / 2;
  const centerY = (chartH - LEGEND_HEIGHT) / 2;
  const radius =
    Math.min(centerX - CHART_PADDING, centerY - CHART_PADDING) * 0.85;

  // Draw slices as filled polygon wedges.
  // Each wedge is a polygon: center → arc points → center.
  // PDF path rendering fills the polygon properly for solid pie slices.
  let startAngle = -Math.PI / 2; // Start from top (12 o'clock)

  /** Number of line segments per full circle for smooth arc appearance. */
  const SEGMENTS_PER_CIRCLE = 72;

  for (let i = 0; i < values.length; i++) {
    const sliceAngle = (values[i] / total) * Math.PI * 2;
    const sliceSegments = Math.max(
      3,
      Math.ceil((sliceAngle / (Math.PI * 2)) * SEGMENTS_PER_CIRCLE),
    );
    const endAngle = startAngle + sliceAngle;

    // Build wedge polygon: center → arc points around the slice → back to center
    const wedgePoints: Array<[number, number]> = [];
    wedgePoints.push([centerX, centerY]); // Start at center
    for (let seg = 0; seg <= sliceSegments; seg++) {
      const angle = startAngle + (seg / sliceSegments) * sliceAngle;
      wedgePoints.push([
        centerX + Math.cos(angle) * radius,
        centerY + Math.sin(angle) * radius,
      ]);
    }
    // Path closes back to center automatically via closePath in polygonOp

    // Emit filled polygon wedge
    ops.push({
      type: "polygon",
      x: 0,
      y: 0,
      points: wedgePoints,
      fill: colors[i],
      stroke: "FFFFFF", // White border between slices
      lineWidth: 1.5,
    });

    // Percentage label outside the pie
    const midAngle = startAngle + sliceAngle / 2;
    const pct = ((values[i] / total) * 100).toFixed(1) + "%";
    const pctRadius = radius * 1.15;
    const pctX = centerX + Math.cos(midAngle) * pctRadius;
    const pctY = centerY + Math.sin(midAngle) * pctRadius;
    const pctW = measureText(pct, "Helvetica", AXIS_FONT_SIZE);
    ops.push({
      type: "text",
      x: pctX - pctW / 2,
      y: pctY - AXIS_FONT_SIZE / 3,
      text: pct,
      font: "Helvetica",
      fontSize: AXIS_FONT_SIZE,
      color: textColor,
    });

    startAngle = endAngle;
  }

  // Donut hole — white circle over center (polygon approximation)
  if (opts.donut) {
    const holeRadius = radius * 0.5;
    const holeSegments = SEGMENTS_PER_CIRCLE;
    const holePoints: Array<[number, number]> = [];
    for (let seg = 0; seg <= holeSegments; seg++) {
      const angle = (seg / holeSegments) * Math.PI * 2;
      holePoints.push([
        centerX + Math.cos(angle) * holeRadius,
        centerY + Math.sin(angle) * holeRadius,
      ]);
    }
    ops.push({
      type: "polygon",
      x: 0,
      y: 0,
      points: holePoints,
      fill: "FFFFFF",
    });
  }

  // Legend
  let legendX = CHART_PADDING;
  const legendY = chartH - LEGEND_HEIGHT + 4;
  for (let i = 0; i < labels.length; i++) {
    ops.push({
      type: "rect",
      x: legendX,
      y: legendY,
      w: LEGEND_SWATCH_SIZE,
      h: LEGEND_SWATCH_SIZE,
      fill: colors[i],
    });
    ops.push({
      type: "text",
      x: legendX + LEGEND_SWATCH_SIZE + 3,
      y: legendY,
      text: labels[i],
      font: "Helvetica",
      fontSize: LEGEND_FONT_SIZE,
      color: textColor,
    });
    legendX +=
      LEGEND_SWATCH_SIZE +
      3 +
      measureText(labels[i], "Helvetica", LEGEND_FONT_SIZE) +
      LEGEND_ITEM_GAP;
  }

  return _createPdfElement("chart", {
    drawOps: ops,
    width: chartW,
    height: chartH,
    title: opts.title,
    subtitle: opts.subtitle,
  });
}

// ── Combo Chart ──────────────────────────────────────────────────────

/** Options for comboChart(). */
export interface ComboChartOptions {
  /** Category labels (X-axis). */
  categories: string[];
  /** Bar data series. */
  barSeries?: ChartSeries[];
  /** Line data series (overlaid on bars). */
  lineSeries?: ChartSeries[];
  /** Chart title. */
  title?: string;
  /** Chart subtitle (rendered smaller below title, e.g. "Values in $M"). */
  subtitle?: string;
  /** Chart width in points. Default: 400. */
  width?: number;
  /** Chart height in points (TOTAL including axes, legend, and padding — not just the plot area). Default: 250. In addContent, a chart title adds ~21pt on top. */
  height?: number;
  /** Text colour. Default: '333333'. */
  textColor?: string;
}

/**
 * Create a combo chart (bars + lines) element for flow layout.
 *
 * @param opts - Combo chart options
 * @returns PdfElement for use with addContent()
 */
export function comboChart(opts: ComboChartOptions): PdfElement {
  const categories = requireArray<string>(
    opts.categories,
    "comboChart.categories",
    {
      nonEmpty: true,
    },
  );
  const barSeries = opts.barSeries ?? [];
  const lineSeries = opts.lineSeries ?? [];

  if (barSeries.length === 0 && lineSeries.length === 0) {
    throw new Error(
      "comboChart: at least one of barSeries or lineSeries must be provided.",
    );
  }

  const totalSeries = barSeries.length + lineSeries.length;
  if (totalSeries > MAX_SERIES_PER_CHART) {
    throw new Error(
      `comboChart: ${totalSeries} total series exceeds the maximum of ${MAX_SERIES_PER_CHART}.`,
    );
  }

  // Validate all series
  const allSeries = [...barSeries, ...lineSeries];
  let colourIdx = 0;
  const validatedBar = barSeries.map((s, i) => {
    requireString(s.name, `comboChart.barSeries[${i}].name`);
    const values = validateValues(
      s.values,
      `comboChart.barSeries[${i}].values`,
    );
    if (values.length !== categories.length) {
      throw new Error(
        `comboChart.barSeries[${i}].values: expected ${categories.length} values but got ${values.length}.`,
      );
    }
    return {
      name: s.name,
      values,
      color: s.color
        ? hexColor(s.color)
        : DEFAULT_PALETTE[colourIdx++ % DEFAULT_PALETTE.length],
    };
  });
  const validatedLine = lineSeries.map((s, i) => {
    requireString(s.name, `comboChart.lineSeries[${i}].name`);
    const values = validateValues(
      s.values,
      `comboChart.lineSeries[${i}].values`,
    );
    if (values.length !== categories.length) {
      throw new Error(
        `comboChart.lineSeries[${i}].values: expected ${categories.length} values but got ${values.length}.`,
      );
    }
    return {
      name: s.name,
      values,
      color: s.color
        ? hexColor(s.color)
        : DEFAULT_PALETTE[colourIdx++ % DEFAULT_PALETTE.length],
    };
  });

  const chartW = opts.width ?? CHART_WIDTH;
  const chartH = opts.height ?? CHART_HEIGHT;
  const textColor = opts.textColor ?? "333333";

  const ops: ChartDrawOp[] = [];

  // Plot area
  const plotLeft = Y_AXIS_LABEL_WIDTH;
  const plotTop = CHART_PADDING;
  const plotRight = chartW - CHART_PADDING;
  const plotBottom = chartH - X_AXIS_LABEL_HEIGHT - LEGEND_HEIGHT;
  const plotW = plotRight - plotLeft;
  const plotH = plotBottom - plotTop;

  // Combined data range
  let minVal = 0;
  let maxVal = 0;
  for (const s of [...validatedBar, ...validatedLine]) {
    for (const v of s.values) {
      maxVal = Math.max(maxVal, v);
      minVal = Math.min(minVal, v);
    }
  }

  const ticks = niceAxisTicks(minVal, maxVal, plotH);
  const axisMin = ticks[0];
  const axisMax = ticks[ticks.length - 1];
  const axisRange = axisMax - axisMin || 1;

  // Axes
  ops.push({
    type: "line",
    x: plotLeft,
    y: plotTop,
    x2: plotLeft,
    y2: plotBottom,
    stroke: "CCCCCC",
    lineWidth: 0.5,
  });
  ops.push({
    type: "line",
    x: plotLeft,
    y: plotBottom,
    x2: plotRight,
    y2: plotBottom,
    stroke: "CCCCCC",
    lineWidth: 0.5,
  });

  // Y-axis ticks
  for (const tick of ticks) {
    const yFrac = (tick - axisMin) / axisRange;
    const y = plotBottom - yFrac * plotH;
    ops.push({
      type: "line",
      x: plotLeft,
      y,
      x2: plotRight,
      y2: y,
      stroke: "EEEEEE",
      lineWidth: 0.25,
    });
    // Label (right-aligned against the Y-axis)
    const tickLabel = formatAxisValue(tick);
    const tickLabelW = measureText(tickLabel, "Helvetica", AXIS_FONT_SIZE);
    ops.push({
      type: "text",
      x: plotLeft - 4 - tickLabelW,
      y: y - AXIS_FONT_SIZE / 3,
      text: tickLabel,
      font: "Helvetica",
      fontSize: AXIS_FONT_SIZE,
      color: textColor,
    });
  }

  // Bars
  const categoryWidth = plotW / categories.length;
  const barGap = 2;
  const groupPadding = categoryWidth * 0.15;
  const numBars = validatedBar.length;
  if (numBars > 0) {
    const barWidth =
      (categoryWidth - groupPadding * 2 - barGap * (numBars - 1)) / numBars;
    for (let ci = 0; ci < categories.length; ci++) {
      for (let si = 0; si < numBars; si++) {
        const v = validatedBar[si].values[ci];
        const barH = (Math.abs(v) / axisRange) * plotH;
        const zeroY = plotBottom - ((0 - axisMin) / axisRange) * plotH;
        const barX =
          plotLeft +
          ci * categoryWidth +
          groupPadding +
          si * (barWidth + barGap);
        const barY = v >= 0 ? zeroY - barH : zeroY;
        ops.push({
          type: "rect",
          x: barX,
          y: barY,
          w: barWidth,
          h: barH,
          fill: validatedBar[si].color,
        });
      }
    }
  }

  // Lines (overlaid on bars)
  const catStep = plotW / (categories.length - 1 || 1);
  for (const s of validatedLine) {
    for (let ci = 0; ci < s.values.length - 1; ci++) {
      const x1 = plotLeft + ci * catStep;
      const y1 = plotBottom - ((s.values[ci] - axisMin) / axisRange) * plotH;
      const x2 = plotLeft + (ci + 1) * catStep;
      const y2 =
        plotBottom - ((s.values[ci + 1] - axisMin) / axisRange) * plotH;
      ops.push({
        type: "line",
        x: x1,
        y: y1,
        x2: x2,
        y2: y2,
        stroke: s.color,
        lineWidth: 2,
      });
    }
    // Markers (circular)
    const COMBO_MARKER_RADIUS = 3;
    const COMBO_MARKER_SEGS = 12;
    for (let ci = 0; ci < s.values.length; ci++) {
      const cx = plotLeft + ci * catStep;
      const cy = plotBottom - ((s.values[ci] - axisMin) / axisRange) * plotH;
      const circlePoints: Array<[number, number]> = [];
      for (let seg = 0; seg <= COMBO_MARKER_SEGS; seg++) {
        const angle = (seg / COMBO_MARKER_SEGS) * Math.PI * 2;
        circlePoints.push([
          cx + Math.cos(angle) * COMBO_MARKER_RADIUS,
          cy + Math.sin(angle) * COMBO_MARKER_RADIUS,
        ]);
      }
      ops.push({
        type: "polygon",
        x: 0,
        y: 0,
        points: circlePoints,
        fill: s.color,
      });
    }
  }

  // X-axis labels
  for (let ci = 0; ci < categories.length; ci++) {
    const labelX = plotLeft + ci * categoryWidth + categoryWidth / 2;
    const labelW = measureText(categories[ci], "Helvetica", AXIS_FONT_SIZE);
    ops.push({
      type: "text",
      x: labelX - labelW / 2,
      y: plotBottom + 8,
      text: categories[ci],
      font: "Helvetica",
      fontSize: AXIS_FONT_SIZE,
      color: textColor,
    });
  }

  // Legend
  const allValidated = [...validatedBar, ...validatedLine];
  let legendX = plotLeft;
  const legendY = chartH - LEGEND_HEIGHT + 4;
  for (const s of allValidated) {
    ops.push({
      type: "rect",
      x: legendX,
      y: legendY,
      w: LEGEND_SWATCH_SIZE,
      h: LEGEND_SWATCH_SIZE,
      fill: s.color,
    });
    ops.push({
      type: "text",
      x: legendX + LEGEND_SWATCH_SIZE + 3,
      y: legendY,
      text: s.name,
      font: "Helvetica",
      fontSize: LEGEND_FONT_SIZE,
      color: textColor,
    });
    legendX +=
      LEGEND_SWATCH_SIZE +
      3 +
      measureText(s.name, "Helvetica", LEGEND_FONT_SIZE) +
      LEGEND_ITEM_GAP;
  }

  void allSeries; // Validated above

  return _createPdfElement("chart", {
    drawOps: ops,
    width: chartW,
    height: chartH,
    title: opts.title,
    subtitle: opts.subtitle,
  });
}
