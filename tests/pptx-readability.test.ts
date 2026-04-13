// ── PPTX Readability Tests ────────────────────────────────────────────
//
// Tests for the visual readability fixes:
// - WCAG 2.0 contrast utilities (luminance, contrastRatio, autoTextColor)
// - Chart legend manual layout (prevents legend/label overlap)
// - Pie chart data label positioning (outEnd + leader lines)
// - Theme-aware shape defaults (readable text on any background)
// - Table themeTextColor fallback
// - chartSlide reduced default height
//
// ─────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";

// ── ooxml-core contrast utilities ────────────────────────────────────

const core: any = await import("../builtin-modules/doc-core.js");

/** Convert ShapeFragment or string to XML string for test assertions */
const toXml = (v: unknown): string => (typeof v === "string" ? v : String(v));

describe("ooxml-core contrast utilities", () => {
  describe("luminance", () => {
    it("should return ~0 for black", () => {
      expect(core.luminance("000000")).toBeLessThan(0.01);
    });

    it("should return ~1 for white", () => {
      expect(core.luminance("FFFFFF")).toBeGreaterThan(0.99);
    });

    it("should return ~0.2 for mid-grey", () => {
      const l = core.luminance("808080");
      expect(l).toBeGreaterThan(0.15);
      expect(l).toBeLessThan(0.25);
    });

    it("should handle red channel correctly (R=0.2126 weight)", () => {
      const l = core.luminance("FF0000");
      expect(l).toBeGreaterThan(0.19);
      expect(l).toBeLessThan(0.22);
    });

    it("should handle green channel correctly (G=0.7152 weight)", () => {
      const l = core.luminance("00FF00");
      expect(l).toBeGreaterThan(0.71);
      expect(l).toBeLessThan(0.73);
    });

    it("should handle blue channel correctly (B=0.0722 weight)", () => {
      const l = core.luminance("0000FF");
      expect(l).toBeGreaterThan(0.06);
      expect(l).toBeLessThan(0.08);
    });

    it("should strip leading # from hex strings", () => {
      expect(core.luminance("#FFFFFF")).toBeGreaterThan(0.99);
    });
  });

  describe("contrastRatio", () => {
    it("should return ~21:1 for black vs white", () => {
      const ratio = core.contrastRatio("000000", "FFFFFF");
      expect(ratio).toBeGreaterThan(20.9);
      expect(ratio).toBeLessThan(21.1);
    });

    it("should return 1:1 for same colour", () => {
      expect(core.contrastRatio("FF0000", "FF0000")).toBe(1);
    });

    it("should be symmetric (a,b) === (b,a)", () => {
      const ab = core.contrastRatio("336699", "FFCC00");
      const ba = core.contrastRatio("FFCC00", "336699");
      expect(ab).toBe(ba);
    });

    it("should show dark-gradient bg vs white text meets AA (>= 4.5)", () => {
      const ratio = core.contrastRatio("0D1117", "FFFFFF");
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    });

    it("should show dark-gradient bg vs dark text is unreadable (< 2)", () => {
      const ratio = core.contrastRatio("0D1117", "333333");
      expect(ratio).toBeLessThan(2);
    });
  });

  describe("autoTextColor", () => {
    it("should pick white for black background", () => {
      expect(core.autoTextColor("000000")).toBe("FFFFFF");
    });

    it("should pick dark for white background", () => {
      expect(core.autoTextColor("FFFFFF")).toBe("333333");
    });

    it("should pick white for dark-gradient bg (0D1117)", () => {
      expect(core.autoTextColor("0D1117")).toBe("FFFFFF");
    });

    it("should pick dark for light-clean bg (FFFFFF)", () => {
      expect(core.autoTextColor("FFFFFF")).toBe("333333");
    });

    it("should pick white for emerald bg (004D40)", () => {
      expect(core.autoTextColor("004D40")).toBe("FFFFFF");
    });

    it("should pick dark for F5F5F5 callout bg", () => {
      expect(core.autoTextColor("F5F5F5")).toBe("333333");
    });

    it("should pick white for corporate-blue bg (1B2A4A)", () => {
      expect(core.autoTextColor("1B2A4A")).toBe("FFFFFF");
    });

    it("should pick white for sunset bg (370617)", () => {
      expect(core.autoTextColor("370617")).toBe("FFFFFF");
    });

    it("should respect custom light/dark options", () => {
      // Dark bg — should pick light option
      expect(core.autoTextColor("000000", "E6EDF3", "1A1A2E")).toBe("E6EDF3");
      // Light bg — should pick dark option
      expect(core.autoTextColor("FFFFFF", "E6EDF3", "1A1A2E")).toBe("1A1A2E");
    });
  });
});

// ── pptx-charts legend and label fixes ───────────────────────────────

const charts: any = await import("../builtin-modules/pptx-charts.js");

describe("pptx-charts readability fixes", () => {
  describe("barChart legend space", () => {
    it("should include manual plot area layout when legend is shown", () => {
      const result = charts.barChart({
        categories: ["A", "B"],
        series: [{ name: "S1", values: [1, 2] }],
        title: "Test",
      });
      expect(result._chartXml).toContain("<c:manualLayout>");
      // With title + legend: y=0.15 (15% top for title), h=0.69 (69% for plot)
      expect(result._chartXml).toContain('<c:y val="0.15"/>');
      expect(result._chartXml).toContain('<c:h val="0.69"/>');
      expect(result._chartXml).toContain("<c:legend>");
    });

    it("should use manual layout even when legend is disabled (for title spacing)", () => {
      const result = charts.barChart({
        categories: ["A", "B"],
        series: [{ name: "S1", values: [1, 2] }],
        title: "Test",
        showLegend: false,
      });
      // Always use manual layout now to prevent title/label overlap
      expect(result._chartXml).toContain("<c:manualLayout>");
      expect(result._chartXml).not.toContain("<c:legend>");
    });
  });

  describe("pieChart data labels", () => {
    it("should position labels outEnd with leader lines for pie", () => {
      const result = charts.pieChart({
        labels: ["A", "B", "C"],
        values: [30, 50, 20],
        showPercent: true,
      });
      expect(result._chartXml).toContain('<c:dLblPos val="outEnd"/>');
      expect(result._chartXml).toContain('<c:showLeaderLines val="1"/>');
    });

    it("should omit outEnd and leader lines for donut", () => {
      const result = charts.pieChart({
        labels: ["A", "B", "C"],
        values: [30, 50, 20],
        showPercent: true,
        donut: true,
      });
      expect(result._chartXml).not.toContain('<c:dLblPos val="outEnd"/>');
      expect(result._chartXml).not.toContain('<c:showLeaderLines val="1"/>');
    });

    it("should omit dLbls entirely when no show flags set", () => {
      const result = charts.pieChart({
        labels: ["A", "B"],
        values: [60, 40],
        showPercent: false,
      });
      expect(result._chartXml).not.toContain("<c:dLbls>");
    });
  });

  describe("lineChart legend space", () => {
    it("should include manual plot area layout", () => {
      const result = charts.lineChart({
        categories: ["Q1", "Q2"],
        series: [{ name: "Revenue", values: [100, 200] }],
      });
      expect(result._chartXml).toContain("<c:manualLayout>");
    });
  });

  describe("comboChart legend space", () => {
    it("should include manual plot area layout", () => {
      const result = charts.comboChart({
        categories: ["Q1", "Q2"],
        barSeries: [{ name: "Rev", values: [100, 200] }],
        lineSeries: [{ name: "Growth", values: [10, 20] }],
      });
      expect(result._chartXml).toContain("<c:manualLayout>");
    });
  });
});

// ── pptx theme-aware shape defaults ──────────────────────────────────

const pptx: any = await import("../builtin-modules/pptx.js");

describe("pptx theme-aware shape defaults", () => {
  describe("rect", () => {
    it("should auto-select white text on dark fill", () => {
      const xml = toXml(
        pptx.rect({
          x: 0,
          y: 0,
          w: 2,
          h: 1,
          fill: "0D1117",
          text: "Hello",
        }),
      );
      // Should contain FFFFFF (white) not 333333 (dark)
      expect(xml).toContain("FFFFFF");
      expect(xml).not.toContain("333333");
    });

    it("should auto-select dark text on light fill", () => {
      const xml = toXml(
        pptx.rect({
          x: 0,
          y: 0,
          w: 2,
          h: 1,
          fill: "FFFFFF",
          text: "Hello",
        }),
      );
      expect(xml).toContain("333333");
    });

    it("should respect explicitly set color", () => {
      const xml = toXml(
        pptx.rect({
          x: 0,
          y: 0,
          w: 2,
          h: 1,
          fill: "000000",
          text: "Hello",
          color: "FF0000",
        }),
      );
      expect(xml).toContain("FF0000");
    });
  });

  describe("callout", () => {
    it("should auto-select dark text on default light background", () => {
      const xml = toXml(
        pptx.callout({
          x: 0,
          y: 0,
          w: 8,
          h: 1,
          text: "Insight",
        }),
      );
      // Default bg is F5F5F5 (light) — text should be dark
      expect(xml).toContain("333333");
    });

    it("should auto-select white text on dark background", () => {
      const xml = toXml(
        pptx.callout({
          x: 0,
          y: 0,
          w: 8,
          h: 1,
          text: "Insight",
          background: "0D1117",
        }),
      );
      expect(xml).toContain("FFFFFF");
    });
  });

  describe("circle", () => {
    it("should auto-select readable text on default blue fill", () => {
      const xml = toXml(
        pptx.circle({
          x: 2,
          y: 2,
          w: 1,
          fill: "2196F3",
          text: "1",
        }),
      );
      // 2196F3 (Material Blue) has luminance ~0.29 — dark text (333333) has
      // higher contrast (4.1:1) than white (3.1:1), so autoTextColor is correct
      // to pick dark. Verify the auto-selection works (not hardcoded FFFFFF).
      expect(xml).toContain("333333");
    });

    it("should auto-select white text on very dark fill", () => {
      const xml = toXml(
        pptx.circle({
          x: 2,
          y: 2,
          w: 1,
          fill: "0D1117",
          text: "1",
        }),
      );
      expect(xml).toContain("FFFFFF");
    });

    it("should auto-select dark text on light fill", () => {
      const xml = toXml(
        pptx.circle({
          x: 2,
          y: 2,
          w: 1,
          fill: "FFFFFF",
          text: "1",
        }),
      );
      expect(xml).toContain("333333");
    });
  });

  describe("statBox", () => {
    it("should auto-select readable text when background is set", () => {
      const xml = toXml(
        pptx.statBox({
          x: 0,
          y: 0,
          w: 3,
          h: 2,
          value: "42",
          label: "Items",
          background: "0D1117",
        }),
      );
      // Dark bg — text should be white
      expect(xml).toContain("FFFFFF");
    });

    it("should use theme fg when no background and theme is active", () => {
      // When _activeTheme is set (post-createPresentation), statBox without
      // a background fill picks up the theme foreground automatically.
      pptx.createPresentation({ theme: "dark-gradient" });
      const xml = toXml(
        pptx.statBox({
          x: 0,
          y: 0,
          w: 3,
          h: 2,
          value: "42",
          label: "Items",
        }),
      );
      // dark-gradient fg = E6EDF3 — should be used for value + label text
      expect(xml).toContain("E6EDF3");
    });
  });

  describe("icon", () => {
    it("should use theme accent for fill when _theme is passed", () => {
      const xml = toXml(
        pptx.icon({
          x: 0,
          y: 0,
          w: 0.5,
          shape: "star",
          _theme: { accent1: "58A6FF", subtle: "8B949E" },
        }),
      );
      expect(xml).toContain("58A6FF");
    });

    it("should fall back to 2196F3 when no theme provided", () => {
      const xml = toXml(
        pptx.icon({
          x: 0,
          y: 0,
          w: 0.5,
          shape: "star",
        }),
      );
      expect(xml).toContain("2196F3");
    });
  });

  describe("line", () => {
    it("should use theme subtle colour when _theme is passed", () => {
      const xml = toXml(
        pptx.line({
          x1: 0,
          y1: 0,
          x2: 5,
          y2: 0,
          _theme: { subtle: "8B949E" },
        }),
      );
      expect(xml).toContain("8B949E");
    });

    it("should fall back to 666666 when no theme provided", () => {
      const xml = toXml(pptx.line({ x1: 0, y1: 0, x2: 5, y2: 0 }));
      expect(xml).toContain("666666");
    });
  });

  describe("arrow", () => {
    it("should use theme subtle colour when _theme is passed", () => {
      const xml = toXml(
        pptx.arrow({
          x1: 0,
          y1: 0,
          x2: 5,
          y2: 0,
          _theme: { subtle: "8B949E" },
        }),
      );
      expect(xml).toContain("8B949E");
    });

    it("should fall back to 666666 when no theme provided", () => {
      const xml = toXml(pptx.arrow({ x1: 0, y1: 0, x2: 5, y2: 0 }));
      expect(xml).toContain("666666");
    });
  });
});

// ── pptx-tables theme text colour ────────────────────────────────────

const tables: any = await import("../builtin-modules/pptx-tables.js");

describe("pptx-tables theme text colour", () => {
  it("should use themeTextColor fallback when textColor not set", () => {
    const xml = toXml(
      tables.table({
        headers: ["Name", "Value"],
        rows: [["A", "1"]],
        style: { themeTextColor: "E6EDF3" },
      }),
    );
    // The text colour E6EDF3 should appear in the output
    expect(xml).toContain("E6EDF3");
  });

  it("should prefer explicit textColor over themeTextColor", () => {
    const xml = toXml(
      tables.table({
        headers: ["Name", "Value"],
        rows: [["A", "1"]],
        style: { textColor: "FF0000", themeTextColor: "E6EDF3" },
      }),
    );
    expect(xml).toContain("FF0000");
  });

  it("should fall back to 333333 when neither is set", () => {
    const xml = toXml(
      tables.table({
        headers: ["Name", "Value"],
        rows: [["A", "1"]],
      }),
    );
    expect(xml).toContain("333333");
  });
});

// ── chartSlide default height ────────────────────────────────────────

describe("chartSlide default height", () => {
  it("should create a chart slide without throwing", () => {
    const pres = pptx.createPresentation({ theme: "corporate-blue" });
    const chart = charts.barChart({
      categories: ["A", "B"],
      series: [{ name: "S", values: [1, 2] }],
    });
    pptx.chartSlide(pres, { title: "Test Chart", chart });
    expect(pres.slides.length).toBe(1);
  });

  it("should build successfully with a chart slide", () => {
    const pres = pptx.createPresentation({ theme: "dark-gradient" });
    const chart = charts.pieChart({
      labels: ["Go", "Rust", "JS"],
      values: [40, 35, 25],
    });
    pptx.chartSlide(pres, { title: "Languages", chart });
    const entries = pres.build();
    expect(entries.length).toBeGreaterThan(0);
    // Verify the chart XML is included
    const chartEntry = entries.find((e: any) =>
      e.name.startsWith("ppt/charts/"),
    );
    expect(chartEntry).toBeDefined();
  });
});

// ── Active theme auto text colour ────────────────────────────────────

describe("active theme auto text colour", () => {
  // After createPresentation(), shapes without explicit colour should use
  // the theme foreground colour rather than inheriting (potentially invisible)
  // defaults from the OOXML theme dk1.

  it("textBox should use theme fg when no colour specified", () => {
    pptx.createPresentation({ theme: "dark-gradient" });
    const xml = toXml(pptx.textBox({ x: 0, y: 0, w: 4, h: 1, text: "Hello" }));
    // dark-gradient fg = E6EDF3
    expect(xml).toContain("E6EDF3");
  });

  it("textBox with explicit colour should use that colour", () => {
    pptx.createPresentation({ theme: "dark-gradient" });
    const xml = toXml(
      pptx.textBox({
        x: 0,
        y: 0,
        w: 4,
        h: 1,
        text: "Hello",
        color: "FF0000",
      }),
    );
    expect(xml).toContain("FF0000");
    // Should NOT contain theme fg since explicit colour overrides
    expect(xml).not.toContain("E6EDF3");
  });

  it("bulletList should use theme fg when no colour specified", () => {
    pptx.createPresentation({ theme: "dark-gradient" });
    const xml = toXml(
      pptx.bulletList({
        x: 0,
        y: 0,
        w: 8,
        h: 4,
        items: ["item1", "item2"],
      }),
    );
    expect(xml).toContain("E6EDF3");
  });

  it("numberedList should use theme fg when no colour specified", () => {
    pptx.createPresentation({ theme: "dark-gradient" });
    const xml = toXml(
      pptx.numberedList({
        x: 0,
        y: 0,
        w: 8,
        h: 4,
        items: ["first", "second"],
      }),
    );
    expect(xml).toContain("E6EDF3");
  });

  it("statBox without background should use theme fg", () => {
    pptx.createPresentation({ theme: "dark-gradient" });
    const xml = toXml(
      pptx.statBox({
        x: 0,
        y: 0,
        w: 3,
        h: 2,
        value: "42",
        label: "Score",
      }),
    );
    expect(xml).toContain("E6EDF3");
  });

  it("statBox WITH background should use autoTextColor not theme fg", () => {
    pptx.createPresentation({ theme: "dark-gradient" });
    const xml = toXml(
      pptx.statBox({
        x: 0,
        y: 0,
        w: 3,
        h: 2,
        value: "42",
        label: "Score",
        background: "FFFFFF",
      }),
    );
    // White background → dark text (333333), not theme fg
    expect(xml).toContain("333333");
    expect(xml).not.toContain("E6EDF3");
  });

  it("richText should use theme fg for runs without explicit colour", () => {
    pptx.createPresentation({ theme: "dark-gradient" });
    const xml = toXml(
      pptx.richText({
        x: 0,
        y: 0,
        w: 8,
        h: 2,
        paragraphs: [[{ text: "Hello" }]],
      }),
    );
    expect(xml).toContain("E6EDF3");
  });

  it("textBox on light-clean theme should use light theme fg", () => {
    pptx.createPresentation({ theme: "light-clean" });
    const xml = toXml(pptx.textBox({ x: 0, y: 0, w: 4, h: 1, text: "Hello" }));
    // light-clean fg = 333333
    expect(xml).toContain("333333");
  });
});

// ── Chart text colour ────────────────────────────────────────────────

describe("chart text colour", () => {
  describe("native textColor option", () => {
    it("barChart with textColor should include txPr in axes", () => {
      const chart = charts.barChart({
        categories: ["A", "B"],
        series: [{ name: "S", values: [1, 2] }],
        textColor: "E6EDF3",
      });
      // Axis should contain txPr with the colour
      expect(chart._chartXml).toContain("c:txPr");
      expect(chart._chartXml).toContain("E6EDF3");
    });

    it("barChart without textColor should NOT include txPr in axes", () => {
      const chart = charts.barChart({
        categories: ["A", "B"],
        series: [{ name: "S", values: [1, 2] }],
      });
      expect(chart._chartXml).not.toContain("c:txPr");
    });

    it("pieChart with textColor should include txPr in legend and dLbls", () => {
      const chart = charts.pieChart({
        labels: ["X", "Y"],
        values: [60, 40],
        textColor: "FFFFFF",
      });
      expect(chart._chartXml).toContain("c:txPr");
      expect(chart._chartXml).toContain("FFFFFF");
      // Should appear in both legend and dLbls
      const matches = chart._chartXml.match(/c:txPr/g);
      expect(matches!.length).toBeGreaterThanOrEqual(2);
    });

    it("lineChart with textColor should include txPr in axes and legend", () => {
      const chart = charts.lineChart({
        categories: ["Q1", "Q2"],
        series: [{ name: "Rev", values: [100, 200] }],
        textColor: "AABBCC",
      });
      expect(chart._chartXml).toContain("c:txPr");
      expect(chart._chartXml).toContain("AABBCC");
    });

    it("comboChart with textColor should include txPr", () => {
      const chart = charts.comboChart({
        categories: ["A", "B"],
        barSeries: [{ name: "Bar", values: [10, 20] }],
        lineSeries: [{ name: "Line", values: [15, 25] }],
        textColor: "DDEEFF",
      });
      expect(chart._chartXml).toContain("c:txPr");
      expect(chart._chartXml).toContain("DDEEFF");
    });

    it("chart title with textColor should have colour in title rPr", () => {
      const chart = charts.barChart({
        categories: ["A"],
        series: [{ name: "S", values: [1] }],
        title: "My Chart",
        textColor: "AABBCC",
      });
      // Title should contain the colour
      expect(chart._chartXml).toContain("My Chart");
      // The title rPr should include a solidFill with our colour
      const titleMatch = chart._chartXml.match(
        /<c:title>.*?<a:rPr[^>]*>(.*?)<\/a:rPr>/s,
      );
      expect(titleMatch).toBeTruthy();
      expect(titleMatch![1]).toContain("AABBCC");
    });
  });

  describe("chartSlide auto text colour injection", () => {
    it("should inject theme fg into chart XML via _patchChartTextColor", () => {
      const pres = pptx.createPresentation({ theme: "dark-gradient" });
      const chart = charts.barChart({
        categories: ["A", "B"],
        series: [{ name: "S", values: [1, 2] }],
        // NOTE: no textColor — relies on chartSlide to inject
      });
      pptx.chartSlide(pres, { title: "Test", chart });
      const entries = pres.build();
      const chartEntry = entries.find(
        (e: any) => e.name === "ppt/charts/chart1.xml",
      );
      expect(chartEntry).toBeDefined();
      // dark-gradient fg = E6EDF3 — should be injected into chart XML
      expect(chartEntry.data).toContain("E6EDF3");
      expect(chartEntry.data).toContain("c:txPr");
    });

    it("should inject txPr into legend, catAx, and valAx", () => {
      const pres = pptx.createPresentation({ theme: "dark-gradient" });
      const chart = charts.barChart({
        categories: ["X"],
        series: [{ name: "Y", values: [5] }],
      });
      pptx.chartSlide(pres, { title: "Check", chart });
      const entries = pres.build();
      const chartEntry = entries.find(
        (e: any) => e.name === "ppt/charts/chart1.xml",
      );
      const xml = chartEntry.data;
      // Should have txPr in legend block
      const legendBlock = xml.match(/<c:legend>.*?<\/c:legend>/s)?.[0] || "";
      expect(legendBlock).toContain("c:txPr");
      // Should have txPr in catAx block
      const catBlock = xml.match(/<c:catAx>.*?<\/c:catAx>/s)?.[0] || "";
      expect(catBlock).toContain("c:txPr");
      // Should have txPr in valAx block
      const valBlock = xml.match(/<c:valAx>.*?<\/c:valAx>/s)?.[0] || "";
      expect(valBlock).toContain("c:txPr");
    });

    it("should inject txPr into pie chart dLbls", () => {
      const pres = pptx.createPresentation({ theme: "emerald" });
      const chart = charts.pieChart({
        labels: ["A", "B"],
        values: [70, 30],
      });
      pptx.chartSlide(pres, { title: "Pie", chart });
      const entries = pres.build();
      const chartEntry = entries.find(
        (e: any) => e.name === "ppt/charts/chart1.xml",
      );
      const xml = chartEntry.data;
      const dlblBlock = xml.match(/<c:dLbls>.*?<\/c:dLbls>/s)?.[0] || "";
      expect(dlblBlock).toContain("c:txPr");
      // emerald fg = FFFFFF
      expect(dlblBlock).toContain("FFFFFF");
    });

    it("should NOT double-inject if chart already has textColor", () => {
      const pres = pptx.createPresentation({ theme: "dark-gradient" });
      const chart = charts.barChart({
        categories: ["A"],
        series: [{ name: "S", values: [1] }],
        textColor: "FF0000", // explicit
      });
      pptx.chartSlide(pres, { title: "T", chart });
      const entries = pres.build();
      const chartEntry = entries.find(
        (e: any) => e.name === "ppt/charts/chart1.xml",
      );
      // Should contain the explicit colour, not the theme fg
      expect(chartEntry.data).toContain("FF0000");
      // The legend block should have exactly 1 txPr (from native, not double)
      const legendBlock =
        chartEntry.data.match(/<c:legend>.*?<\/c:legend>/s)?.[0] || "";
      const txPrCount = (legendBlock.match(/c:txPr/g) || []).length;
      // 2 = open + close tag of ONE txPr element
      expect(txPrCount).toBe(2);
    });

    it("should work with light theme too", () => {
      const pres = pptx.createPresentation({ theme: "light-clean" });
      const chart = charts.lineChart({
        categories: ["Jan", "Feb"],
        series: [{ name: "Sales", values: [100, 150] }],
      });
      pptx.chartSlide(pres, { title: "Sales", chart });
      const entries = pres.build();
      const chartEntry = entries.find(
        (e: any) => e.name === "ppt/charts/chart1.xml",
      );
      // light-clean fg = 333333
      expect(chartEntry.data).toContain("333333");
    });
  });

  describe("addSlideNumbers / addFooter on mixed backgrounds", () => {
    it("should not throw on dark-gradient theme with section divider slide", () => {
      // Regression: addSlideNumbers auto-selected "333333" for section slides
      // (accent1 bg = 58A6FF), which then failed textBox's contrast check
      // against theme.bg (0D1117). Fixed by passing _against to textBox.
      const pres = pptx.createPresentation({ theme: "dark-gradient" });
      pptx.titleSlide(pres, { title: "Title" });
      pptx.sectionSlide(pres, { title: "Section" });
      pptx.contentSlide(pres, { title: "Content", items: [] });
      // This must not throw — previously crashed with WCAG contrast error
      expect(() => pptx.addSlideNumbers(pres)).not.toThrow();
    });

    it("should not throw addFooter on dark-gradient with section divider", () => {
      const pres = pptx.createPresentation({ theme: "dark-gradient" });
      pptx.titleSlide(pres, { title: "Title" });
      pptx.sectionSlide(pres, { title: "Section" });
      expect(() => pptx.addFooter(pres, { text: "Footer" })).not.toThrow();
    });

    it("should produce readable slide numbers across all themes", () => {
      for (const theme of [
        "corporate-blue",
        "dark-gradient",
        "light-clean",
        "emerald",
        "sunset",
      ]) {
        const pres = pptx.createPresentation({ theme });
        pptx.titleSlide(pres, { title: "Title" });
        pptx.sectionSlide(pres, { title: "Section" });
        pptx.contentSlide(pres, { title: "Content", items: [] });
        // Must not throw for any theme — slide numbers must be readable
        // on all backgrounds including accent-coloured section dividers
        expect(() => pptx.addSlideNumbers(pres)).not.toThrow();
        expect(() =>
          pptx.addFooter(pres, { text: "Test footer" }),
        ).not.toThrow();
      }
    });
  });
});
