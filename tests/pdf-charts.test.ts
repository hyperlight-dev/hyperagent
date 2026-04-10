/**
 * PDF Charts Module Tests
 *
 * Tests for the ha:pdf-charts module covering:
 * - Bar charts (grouped, stacked)
 * - Line charts (with markers)
 * - Pie charts (with percentage labels)
 * - Combo charts (bars + lines)
 * - Data validation (NaN, Infinity, empty, mismatched lengths)
 * - Complexity caps (max series, categories, slices)
 * - Theme colour assignment
 * - Axis tick calculation
 * - Chart integration with addContent()
 */

import { describe, it, expect } from "vitest";

const charts: any = await import("../builtin-modules/pdf-charts.js");
const pdf: any = await import("../builtin-modules/pdf.js");

// ── Helpers ──────────────────────────────────────────────────────────

/** Decode PDF bytes to string for inspection. */
function pdfToString(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += String.fromCharCode(bytes[i]);
  }
  return s;
}

// ── Bar Chart ────────────────────────────────────────────────────────

describe("barChart()", () => {
  it("should create a PdfElement", () => {
    const el = charts.barChart({
      categories: ["Q1", "Q2", "Q3"],
      series: [{ name: "Revenue", values: [100, 200, 150] }],
    });
    expect(pdf.isPdfElement(el)).toBe(true);
    expect(el._kind).toBe("chart");
  });

  it("should require non-empty categories", () => {
    expect(() =>
      charts.barChart({
        categories: [],
        series: [{ name: "A", values: [] }],
      }),
    ).toThrow(/empty/);
  });

  it("should require non-empty series", () => {
    expect(() =>
      charts.barChart({
        categories: ["Q1"],
        series: [],
      }),
    ).toThrow(/empty/);
  });

  it("should require series.name", () => {
    expect(() =>
      charts.barChart({
        categories: ["Q1"],
        series: [{ values: [100] }],
      }),
    ).toThrow(/string/);
  });

  it("should validate values are finite numbers", () => {
    expect(() =>
      charts.barChart({
        categories: ["Q1"],
        series: [{ name: "A", values: [NaN] }],
      }),
    ).toThrow(/finite number/);
  });

  it("should validate values length matches categories", () => {
    expect(() =>
      charts.barChart({
        categories: ["Q1", "Q2"],
        series: [{ name: "A", values: [100] }],
      }),
    ).toThrow(/2 values/);
  });

  it("should enforce max series limit", () => {
    const series = Array.from({ length: 25 }, (_, i) => ({
      name: `S${i}`,
      values: [1],
    }));
    expect(() => charts.barChart({ categories: ["X"], series })).toThrow(
      /maximum of 24/,
    );
  });

  it("should enforce max categories limit", () => {
    const categories = Array.from({ length: 101 }, (_, i) => `C${i}`);
    expect(() =>
      charts.barChart({
        categories,
        series: [{ name: "A", values: categories.map(() => 1) }],
      }),
    ).toThrow(/maximum of 100/);
  });

  it("should accept custom colours", () => {
    const el = charts.barChart({
      categories: ["Q1"],
      series: [{ name: "A", values: [100], color: "FF0000" }],
    });
    expect(el._data.drawOps).toBeDefined();
  });

  it("should accept title", () => {
    const el = charts.barChart({
      categories: ["Q1"],
      series: [{ name: "A", values: [100] }],
      title: "My Chart",
    });
    expect(el._data.title).toBe("My Chart");
  });

  it("should accept custom width and height", () => {
    const el = charts.barChart({
      categories: ["Q1"],
      series: [{ name: "A", values: [100] }],
      width: 500,
      height: 300,
    });
    expect(el._data.width).toBe(500);
    expect(el._data.height).toBe(300);
  });

  it("should handle multiple series", () => {
    const el = charts.barChart({
      categories: ["Q1", "Q2"],
      series: [
        { name: "Revenue", values: [100, 200] },
        { name: "Cost", values: [80, 150] },
        { name: "Profit", values: [20, 50] },
      ],
    });
    // Should have draw ops for all three series
    const rectOps = el._data.drawOps.filter(
      (op: any) => op.type === "rect" && op.fill,
    );
    // At least 6 bars (3 series × 2 categories)
    expect(rectOps.length).toBeGreaterThanOrEqual(6);
  });

  it("should handle stacked bars", () => {
    const el = charts.barChart({
      categories: ["Q1", "Q2"],
      series: [
        { name: "A", values: [100, 200] },
        { name: "B", values: [50, 75] },
      ],
      stacked: true,
    });
    expect(el._data.drawOps.length).toBeGreaterThan(0);
  });

  it("should handle negative values", () => {
    const el = charts.barChart({
      categories: ["Q1", "Q2"],
      series: [{ name: "PnL", values: [-50, 100] }],
    });
    expect(el._data.drawOps.length).toBeGreaterThan(0);
  });

  it("should include legend with series names", () => {
    const el = charts.barChart({
      categories: ["Q1"],
      series: [
        { name: "Alpha", values: [100] },
        { name: "Beta", values: [200] },
      ],
    });
    const textOps = el._data.drawOps.filter((op: any) => op.type === "text");
    const legendTexts = textOps.map((op: any) => op.text);
    expect(legendTexts).toContain("Alpha");
    expect(legendTexts).toContain("Beta");
  });

  it("should include axis labels", () => {
    const el = charts.barChart({
      categories: ["January", "February"],
      series: [{ name: "Sales", values: [100, 200] }],
    });
    const textOps = el._data.drawOps.filter((op: any) => op.type === "text");
    const texts = textOps.map((op: any) => op.text);
    expect(texts).toContain("January");
    expect(texts).toContain("February");
  });
});

// ── Line Chart ───────────────────────────────────────────────────────

describe("lineChart()", () => {
  it("should create a PdfElement", () => {
    const el = charts.lineChart({
      categories: ["Jan", "Feb", "Mar"],
      series: [{ name: "Trend", values: [10, 20, 15] }],
    });
    expect(pdf.isPdfElement(el)).toBe(true);
    expect(el._kind).toBe("chart");
  });

  it("should include data lines", () => {
    const el = charts.lineChart({
      categories: ["A", "B", "C"],
      series: [{ name: "S1", values: [10, 20, 30] }],
    });
    // Should have line ops connecting data points
    const lineOps = el._data.drawOps.filter(
      (op: any) => op.type === "line" && op.lineWidth === 2,
    );
    expect(lineOps.length).toBe(2); // 3 points = 2 line segments
  });

  it("should include data point markers", () => {
    const el = charts.lineChart({
      categories: ["A", "B", "C"],
      series: [{ name: "S1", values: [10, 20, 30] }],
    });
    // Markers are small filled rects
    const markerOps = el._data.drawOps.filter(
      (op: any) => op.type === "rect" && op.fill && (op.w ?? 0) <= 5,
    );
    expect(markerOps.length).toBe(3); // One per data point
  });

  it("should validate inputs same as barChart", () => {
    expect(() =>
      charts.lineChart({
        categories: ["A"],
        series: [{ name: "S", values: [NaN] }],
      }),
    ).toThrow(/finite number/);
  });

  it("should handle multiple series", () => {
    const el = charts.lineChart({
      categories: ["A", "B"],
      series: [
        { name: "S1", values: [10, 20] },
        { name: "S2", values: [15, 25] },
      ],
    });
    // 2 series × 1 segment each = 2 data line ops (lineWidth=2)
    const dataLines = el._data.drawOps.filter(
      (op: any) => op.type === "line" && op.lineWidth === 2,
    );
    expect(dataLines.length).toBe(2);
  });
});

// ── Pie Chart ────────────────────────────────────────────────────────

describe("pieChart()", () => {
  it("should create a PdfElement", () => {
    const el = charts.pieChart({
      labels: ["A", "B", "C"],
      values: [30, 50, 20],
    });
    expect(pdf.isPdfElement(el)).toBe(true);
    expect(el._kind).toBe("chart");
  });

  it("should require labels length matches values length", () => {
    expect(() =>
      charts.pieChart({
        labels: ["A", "B"],
        values: [30],
      }),
    ).toThrow(/must equal/);
  });

  it("should reject negative values", () => {
    expect(() =>
      charts.pieChart({
        labels: ["A"],
        values: [-10],
      }),
    ).toThrow(/non-negative/);
  });

  it("should reject zero total", () => {
    expect(() =>
      charts.pieChart({
        labels: ["A", "B"],
        values: [0, 0],
      }),
    ).toThrow(/greater than 0/);
  });

  it("should enforce max slice limit", () => {
    const labels = Array.from({ length: 101 }, (_, i) => `S${i}`);
    const values = labels.map(() => 1);
    expect(() => charts.pieChart({ labels, values })).toThrow(/maximum of 100/);
  });

  it("should include percentage labels", () => {
    const el = charts.pieChart({
      labels: ["A", "B"],
      values: [75, 25],
    });
    const textOps = el._data.drawOps.filter((op: any) => op.type === "text");
    const texts = textOps.map((op: any) => op.text);
    expect(texts.some((t: string) => t.includes("75.0%"))).toBe(true);
    expect(texts.some((t: string) => t.includes("25.0%"))).toBe(true);
  });

  it("should include legend with labels", () => {
    const el = charts.pieChart({
      labels: ["Cats", "Dogs"],
      values: [60, 40],
    });
    const textOps = el._data.drawOps.filter((op: any) => op.type === "text");
    const texts = textOps.map((op: any) => op.text);
    expect(texts).toContain("Cats");
    expect(texts).toContain("Dogs");
  });

  it("should accept custom colours", () => {
    const el = charts.pieChart({
      labels: ["A", "B"],
      values: [50, 50],
      colors: ["FF0000", "00FF00"],
    });
    expect(el._data.drawOps.length).toBeGreaterThan(0);
  });
});

// ── Combo Chart ──────────────────────────────────────────────────────

describe("comboChart()", () => {
  it("should create a PdfElement", () => {
    const el = charts.comboChart({
      categories: ["Q1", "Q2"],
      barSeries: [{ name: "Revenue", values: [100, 200] }],
      lineSeries: [{ name: "Target", values: [150, 180] }],
    });
    expect(pdf.isPdfElement(el)).toBe(true);
    expect(el._kind).toBe("chart");
  });

  it("should require at least one series type", () => {
    expect(() => charts.comboChart({ categories: ["Q1"] })).toThrow(
      /at least one/,
    );
  });

  it("should work with only bar series", () => {
    const el = charts.comboChart({
      categories: ["Q1"],
      barSeries: [{ name: "A", values: [100] }],
    });
    expect(el._data.drawOps.length).toBeGreaterThan(0);
  });

  it("should work with only line series", () => {
    const el = charts.comboChart({
      categories: ["Q1", "Q2"],
      lineSeries: [{ name: "A", values: [100, 200] }],
    });
    expect(el._data.drawOps.length).toBeGreaterThan(0);
  });

  it("should include both bars and lines", () => {
    const el = charts.comboChart({
      categories: ["Q1", "Q2"],
      barSeries: [{ name: "Rev", values: [100, 200] }],
      lineSeries: [{ name: "Target", values: [150, 180] }],
    });
    const rectOps = el._data.drawOps.filter(
      (op: any) => op.type === "rect" && op.fill && (op.w ?? 0) > 5,
    );
    const dataLines = el._data.drawOps.filter(
      (op: any) => op.type === "line" && op.lineWidth === 2,
    );
    expect(rectOps.length).toBeGreaterThanOrEqual(2); // 2 bars
    expect(dataLines.length).toBeGreaterThanOrEqual(1); // 1 line segment
  });
});

// ── Complexity Caps ──────────────────────────────────────────────────

describe("complexity caps", () => {
  it("should export cap constants", () => {
    expect(charts.MAX_CHARTS_PER_DOC).toBe(50);
    expect(charts.MAX_SERIES_PER_CHART).toBe(24);
    expect(charts.MAX_CATEGORIES).toBe(100);
    expect(charts.MAX_PIE_SLICES).toBe(100);
  });
});

// ── Integration with addContent ──────────────────────────────────────

describe("chart integration with addContent", () => {
  it("should render a bar chart via addContent", () => {
    const doc = pdf.createDocument({ debug: true });
    pdf.addContent(doc, [
      charts.barChart({
        categories: ["Q1", "Q2", "Q3"],
        series: [{ name: "Revenue", values: [100, 200, 150] }],
        title: "Quarterly Revenue",
      }),
    ]);
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("(Quarterly Revenue) Tj");
    expect(str).toContain("re"); // Bars are rects
    expect(str).toContain("(Q1) Tj");
  });

  it("should render a line chart via addContent", () => {
    const doc = pdf.createDocument({ debug: true });
    pdf.addContent(doc, [
      charts.lineChart({
        categories: ["Jan", "Feb", "Mar"],
        series: [{ name: "Trend", values: [10, 20, 15] }],
        title: "Monthly Trend",
      }),
    ]);
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("(Monthly Trend) Tj");
    expect(str).toContain(" m\n"); // Line moveto
    expect(str).toContain(" l\n"); // Line lineto
  });

  it("should render a pie chart via addContent", () => {
    const doc = pdf.createDocument({ debug: true });
    pdf.addContent(doc, [
      charts.pieChart({
        labels: ["Desktop", "Mobile", "Tablet"],
        values: [60, 30, 10],
        title: "Device Distribution",
      }),
    ]);
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("(Device Distribution) Tj");
  });

  it("should render charts alongside text content", () => {
    const doc = pdf.createDocument({ debug: true });
    pdf.addContent(doc, [
      pdf.heading({ text: "Sales Report", level: 1 }),
      pdf.paragraph({ text: "Below is the quarterly breakdown." }),
      charts.barChart({
        categories: ["Q1", "Q2", "Q3", "Q4"],
        series: [
          { name: "Revenue", values: [100, 200, 150, 300] },
          { name: "Cost", values: [80, 150, 120, 200] },
        ],
        title: "Revenue vs Cost",
      }),
      pdf.paragraph({ text: "Revenue grew 200% over the year." }),
    ]);
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("(Sales Report) Tj");
    expect(str).toContain("(Revenue vs Cost) Tj");
    expect(str).toContain("(Revenue grew 200% over the year.) Tj");
  });

  it("should handle multiple charts in one document", () => {
    const doc = pdf.createDocument({ debug: true });
    pdf.addContent(doc, [
      charts.barChart({
        categories: ["A", "B"],
        series: [{ name: "S1", values: [10, 20] }],
        title: "Chart 1",
      }),
      charts.lineChart({
        categories: ["A", "B"],
        series: [{ name: "S2", values: [15, 25] }],
        title: "Chart 2",
      }),
      charts.pieChart({
        labels: ["X", "Y"],
        values: [70, 30],
        title: "Chart 3",
      }),
    ]);
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("(Chart 1) Tj");
    expect(str).toContain("(Chart 2) Tj");
    expect(str).toContain("(Chart 3) Tj");
  });
});
