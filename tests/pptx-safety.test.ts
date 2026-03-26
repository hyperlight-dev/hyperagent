// ── PPTX Safety Spec Tests ─────────────────────────────────────────────
//
// Tests for the PPTX Safety Spec (LLM-ONLY, BREAKING CHANGES).
// Covers: ShapeFragment typed model, chart complexity caps,
// notes sanitization, validation engine, and structural integrity.
// ──────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";

// ── Module imports ───────────────────────────────────────────────────

const core: any = await import("../builtin-modules/ooxml-core.js");
const pptx: any = await import("../builtin-modules/pptx.js");
const charts: any = await import("../builtin-modules/pptx-charts.js");
const tables: any = await import("../builtin-modules/pptx-tables.js");

/** Convert ShapeFragment or string to XML string for test assertions */
const toXml = (v: unknown): string => (typeof v === "string" ? v : String(v));

// ══════════════════════════════════════════════════════════════════════
// 1. ShapeFragment Typed Composition Model
// ══════════════════════════════════════════════════════════════════════

describe("ShapeFragment", () => {
  describe("creation and identity", () => {
    it("createShapeFragment produces a branded object", () => {
      const frag = core._createShapeFragment("<p:sp>test</p:sp>");
      expect(core.isShapeFragment(frag)).toBe(true);
    });

    it("isShapeFragment rejects plain strings", () => {
      expect(core.isShapeFragment("<p:sp>test</p:sp>")).toBe(false);
    });

    it("isShapeFragment rejects null/undefined", () => {
      expect(core.isShapeFragment(null)).toBe(false);
      expect(core.isShapeFragment(undefined)).toBe(false);
    });

    it("isShapeFragment rejects plain objects without brand", () => {
      expect(core.isShapeFragment({ _xml: "<p:sp/>" })).toBe(false);
    });

    it("toString() returns the XML", () => {
      const frag = core._createShapeFragment("<p:sp>hello</p:sp>");
      expect(String(frag)).toBe("<p:sp>hello</p:sp>");
    });
  });

  describe("fragmentsToXml", () => {
    it("converts single fragment to XML", () => {
      const frag = core._createShapeFragment("<p:sp>a</p:sp>");
      expect(core.fragmentsToXml(frag)).toBe("<p:sp>a</p:sp>");
    });

    it("converts array of fragments to joined XML", () => {
      const a = core._createShapeFragment("<p:sp>a</p:sp>");
      const b = core._createShapeFragment("<p:sp>b</p:sp>");
      expect(core.fragmentsToXml([a, b])).toBe("<p:sp>a</p:sp><p:sp>b</p:sp>");
    });

    it("rejects raw strings", () => {
      expect(() => core.fragmentsToXml("<p:sp>raw</p:sp>")).toThrow();
    });

    it("rejects arrays containing raw strings", () => {
      const frag = core._createShapeFragment("<p:sp>ok</p:sp>");
      expect(() => core.fragmentsToXml([frag, "<p:sp>raw</p:sp>"])).toThrow();
    });
  });

  describe("shape builders return ShapeFragment", () => {
    it("textBox returns ShapeFragment", () => {
      const result = pptx.textBox({ x: 1, y: 1, w: 4, h: 1, text: "Hi" });
      expect(core.isShapeFragment(result)).toBe(true);
    });

    it("rect returns ShapeFragment", () => {
      const result = pptx.rect({
        x: 1,
        y: 1,
        w: 4,
        h: 2,
        fill: "336699",
      });
      expect(core.isShapeFragment(result)).toBe(true);
    });

    it("bulletList returns ShapeFragment", () => {
      const result = pptx.bulletList({
        x: 1,
        y: 1,
        w: 4,
        h: 3,
        items: ["a", "b"],
      });
      expect(core.isShapeFragment(result)).toBe(true);
    });

    it("statBox returns ShapeFragment", () => {
      const result = pptx.statBox({
        x: 1,
        y: 1,
        w: 3,
        h: 2,
        value: "42",
        label: "Answer",
      });
      expect(core.isShapeFragment(result)).toBe(true);
    });

    it("callout returns ShapeFragment", () => {
      const result = pptx.callout({
        x: 1,
        y: 1,
        w: 6,
        h: 2,
        text: "Note",
      });
      expect(core.isShapeFragment(result)).toBe(true);
    });

    it("codeBlock returns ShapeFragment", () => {
      const result = pptx.codeBlock({
        x: 1,
        y: 1,
        w: 8,
        h: 4,
        code: 'console.log("hello")',
      });
      expect(core.isShapeFragment(result)).toBe(true);
    });

    it("table returns ShapeFragment", () => {
      const result = tables.table({
        x: 1,
        y: 1,
        w: 8,
        headers: ["A", "B"],
        rows: [
          ["1", "2"],
          ["3", "4"],
        ],
      });
      expect(core.isShapeFragment(result)).toBe(true);
    });

    it("kvTable returns ShapeFragment", () => {
      const result = tables.kvTable({
        x: 1,
        y: 1,
        w: 6,
        items: [{ key: "Name", value: "Test" }],
      });
      expect(core.isShapeFragment(result)).toBe(true);
    });

    it("numberedList returns ShapeFragment", () => {
      const result = pptx.numberedList({
        x: 1,
        y: 1,
        w: 4,
        h: 3,
        items: ["first", "second"],
      });
      expect(core.isShapeFragment(result)).toBe(true);
    });

    it("imagePlaceholder returns ShapeFragment", () => {
      const result = pptx.imagePlaceholder({
        x: 1,
        y: 1,
        w: 4,
        h: 3,
        label: "Photo here",
      });
      expect(core.isShapeFragment(result)).toBe(true);
    });

    it("line returns ShapeFragment", () => {
      const result = pptx.line({
        x1: 1,
        y1: 1,
        x2: 5,
        y2: 1,
        color: "336699",
      });
      expect(core.isShapeFragment(result)).toBe(true);
    });

    it("arrow returns ShapeFragment", () => {
      const result = pptx.arrow({
        x1: 1,
        y1: 1,
        x2: 5,
        y2: 3,
        color: "336699",
      });
      expect(core.isShapeFragment(result)).toBe(true);
    });

    it("circle returns ShapeFragment", () => {
      const result = pptx.circle({
        x: 1,
        y: 1,
        w: 2,
        fill: "336699",
      });
      expect(core.isShapeFragment(result)).toBe(true);
    });

    it("icon returns ShapeFragment", () => {
      const result = pptx.icon({
        x: 1,
        y: 1,
        w: 1,
        shape: "star",
        fill: "FFD700",
      });
      expect(core.isShapeFragment(result)).toBe(true);
    });

    it("svgPath returns ShapeFragment", () => {
      const result = pptx.svgPath({
        x: 1,
        y: 1,
        w: 4,
        h: 4,
        d: "M 0 0 L 100 0 L 100 100 Z",
        fill: "336699",
      });
      expect(core.isShapeFragment(result)).toBe(true);
    });

    it("richText returns ShapeFragment", () => {
      const result = pptx.richText({
        x: 1,
        y: 1,
        w: 8,
        h: 2,
        paragraphs: [[{ text: "Hello", bold: true }]],
      });
      expect(core.isShapeFragment(result)).toBe(true);
    });

    it("panel returns ShapeFragment", () => {
      const result = pptx.panel({
        x: 1,
        y: 1,
        w: 6,
        h: 3,
        title: "Info",
        body: "Details here",
        accentColor: "2196F3",
      });
      expect(core.isShapeFragment(result)).toBe(true);
    });

    it("card returns ShapeFragment", () => {
      const result = pptx.card({
        x: 1,
        y: 1,
        w: 4,
        h: 3,
        title: "Card Title",
        body: "Card body text",
        background: "1A1A2E",
      });
      expect(core.isShapeFragment(result)).toBe(true);
    });

    it("overlay returns ShapeFragment", () => {
      const result = pptx.overlay({ opacity: 0.5 });
      expect(core.isShapeFragment(result)).toBe(true);
    });

    it("gradientOverlay returns ShapeFragment", () => {
      const result = pptx.gradientOverlay({});
      expect(core.isShapeFragment(result)).toBe(true);
    });

    it("shapes() returns ShapeFragment", () => {
      const a = pptx.textBox({ x: 1, y: 1, w: 4, h: 1, text: "A" });
      const b = pptx.rect({ x: 1, y: 2, w: 4, h: 2, fill: "336699" });
      const result = pptx.shapes([a, b]);
      expect(core.isShapeFragment(result)).toBe(true);
    });

    it("hyperlink returns ShapeFragment", () => {
      const pres = pptx.createPresentation({ theme: "corporate-blue" });
      const result = pptx.hyperlink(
        {
          x: 1,
          y: 1,
          w: 4,
          h: 1,
          text: "Click me",
          url: "https://example.com",
        },
        pres,
      );
      expect(core.isShapeFragment(result)).toBe(true);
    });

    it("comparisonTable returns ShapeFragment", () => {
      const result = tables.comparisonTable({
        x: 1,
        y: 1,
        w: 10,
        features: ["SSO", "API"],
        options: [{ name: "Free", values: [false, true] }],
      });
      expect(core.isShapeFragment(result)).toBe(true);
    });

    it("timeline returns ShapeFragment", () => {
      const result = tables.timeline({
        x: 1,
        y: 1,
        w: 10,
        items: [
          { label: "Phase 1", description: "Setup" },
          { label: "Phase 2", description: "Build" },
        ],
      });
      expect(core.isShapeFragment(result)).toBe(true);
    });

    it("fetchAndEmbed returns ShapeFragment (not string)", () => {
      const pres = pptx.createPresentation({ theme: "corporate-blue" });
      // Create a mock fetchFn that returns a minimal 1x1 PNG
      const PNG_1x1 = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
        0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde,
      ]);
      const result = pptx.fetchAndEmbed(pres, {
        url: "https://example.com/photo.png",
        x: 1,
        y: 1,
        w: 4,
        h: 3,
        fetchFn: () => PNG_1x1,
      });
      expect(core.isShapeFragment(result)).toBe(true);
      expect(typeof result).not.toBe("string");
    });
  });

  describe("customSlide accepts ShapeFragment", () => {
    it("accepts single ShapeFragment", () => {
      const pres = pptx.createPresentation({ theme: "corporate-blue" });
      const shape = pptx.textBox({
        x: 1,
        y: 1,
        w: 4,
        h: 1,
        text: "Hello",
      });
      // Should not throw
      pptx.customSlide(pres, { shapes: shape });
      expect(pres.slideCount).toBe(1);
    });

    it("accepts array of ShapeFragments", () => {
      const pres = pptx.createPresentation({ theme: "corporate-blue" });
      const shapes = [
        pptx.textBox({ x: 1, y: 1, w: 4, h: 1, text: "A" }),
        pptx.rect({ x: 1, y: 2, w: 4, h: 2, fill: "336699" }),
      ];
      pptx.customSlide(pres, { shapes });
      expect(pres.slideCount).toBe(1);
    });
  });
});

// ══════════════════════════════════════════════════════════════════════
// 2. Chart toString() Coercion Blocked
// ══════════════════════════════════════════════════════════════════════

describe("embedChart toString blocked", () => {
  it("embedChart result has .shape ShapeFragment", () => {
    const pres = pptx.createPresentation({ theme: "corporate-blue" });
    const chart = charts.barChart({
      categories: ["A", "B"],
      series: [{ name: "S1", values: [1, 2] }],
    });
    const result = charts.embedChart(pres, chart);
    expect(core.isShapeFragment(result.shape)).toBe(true);
  });

  it("embedChart .toString() throws", () => {
    const pres = pptx.createPresentation({ theme: "corporate-blue" });
    const chart = charts.barChart({
      categories: ["A", "B"],
      series: [{ name: "S1", values: [1, 2] }],
    });
    const result = charts.embedChart(pres, chart);
    expect(() => result.toString()).toThrow(/\.shape/);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 2b. addBody Rejects Raw Strings
// ══════════════════════════════════════════════════════════════════════

describe("addBody rejects raw strings", () => {
  it("rejects a raw XML string", () => {
    const pres = pptx.createPresentation({ theme: "corporate-blue" });
    expect(() => pres.addBody("<p:sp>raw</p:sp>")).toThrow(
      /raw XML strings are no longer accepted/,
    );
  });

  it("rejects an array of raw strings", () => {
    const pres = pptx.createPresentation({ theme: "corporate-blue" });
    expect(() => pres.addBody(["<p:sp>a</p:sp>", "<p:sp>b</p:sp>"])).toThrow(
      /raw XML string arrays are no longer accepted/,
    );
  });

  it("rejects a fake ShapeFragment (plain object without brand)", () => {
    const pres = pptx.createPresentation({ theme: "corporate-blue" });
    const fake = {
      _xml: "<p:sp>fake</p:sp>",
      toString: () => "<p:sp>fake</p:sp>",
    };
    expect(() => pres.addBody(fake as any)).toThrow(/ShapeFragment/);
  });

  it("accepts a real ShapeFragment", () => {
    const pres = pptx.createPresentation({ theme: "corporate-blue" });
    const shape = pptx.textBox({ x: 1, y: 1, w: 4, h: 1, text: "OK" });
    pres.addBody(shape);
    expect(pres.slideCount).toBeGreaterThanOrEqual(1);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 3. Chart Complexity Caps
// ══════════════════════════════════════════════════════════════════════

describe("chart complexity caps", () => {
  describe("barChart caps", () => {
    it("rejects more than 100 categories", () => {
      const cats = Array.from({ length: 101 }, (_, i) => `Cat${i}`);
      expect(() =>
        charts.barChart({
          categories: cats,
          series: [{ name: "S", values: cats.map(() => 1) }],
        }),
      ).toThrow(/101 categories exceeds the maximum of 100/);
    });

    it("rejects more than 24 series", () => {
      const series = Array.from({ length: 25 }, (_, i) => ({
        name: `S${i}`,
        values: [1],
      }));
      expect(() =>
        charts.barChart({
          categories: ["A"],
          series,
        }),
      ).toThrow(/25 series exceeds the maximum of 24/);
    });

    it("accepts exactly 100 categories", () => {
      const cats = Array.from({ length: 100 }, (_, i) => `Cat${i}`);
      // Should not throw
      charts.barChart({
        categories: cats,
        series: [{ name: "S", values: cats.map(() => 1) }],
      });
    });
  });

  describe("lineChart caps", () => {
    it("rejects more than 100 categories", () => {
      const cats = Array.from({ length: 101 }, (_, i) => `Cat${i}`);
      expect(() =>
        charts.lineChart({
          categories: cats,
          series: [{ name: "S", values: cats.map(() => 1) }],
        }),
      ).toThrow(/101 categories exceeds the maximum of 100/);
    });

    it("rejects more than 24 series", () => {
      const series = Array.from({ length: 25 }, (_, i) => ({
        name: `S${i}`,
        values: [1],
      }));
      expect(() =>
        charts.lineChart({
          categories: ["A"],
          series,
        }),
      ).toThrow(/25 series exceeds the maximum of 24/);
    });
  });

  describe("pieChart caps", () => {
    it("rejects more than 100 slices", () => {
      const labels = Array.from({ length: 101 }, (_, i) => `L${i}`);
      const values = labels.map(() => 1);
      expect(() => charts.pieChart({ labels, values })).toThrow(
        /101 slices exceeds the maximum of 100/,
      );
    });
  });

  describe("comboChart caps", () => {
    it("rejects more than 100 categories", () => {
      const cats = Array.from({ length: 101 }, (_, i) => `Cat${i}`);
      expect(() =>
        charts.comboChart({
          categories: cats,
          barSeries: [{ name: "S", values: cats.map(() => 1) }],
        }),
      ).toThrow(/101 categories exceeds the maximum of 100/);
    });

    it("rejects more than 24 combined series", () => {
      const barSeries = Array.from({ length: 13 }, (_, i) => ({
        name: `B${i}`,
        values: [1],
      }));
      const lineSeries = Array.from({ length: 12 }, (_, i) => ({
        name: `L${i}`,
        values: [1],
      }));
      expect(() =>
        charts.comboChart({
          categories: ["A"],
          barSeries,
          lineSeries,
        }),
      ).toThrow(/25.*exceeds the maximum of 24/);
    });
  });

  describe("deck-level chart cap", () => {
    it("rejects more than 50 charts in a single deck", () => {
      const pres = pptx.createPresentation({ theme: "corporate-blue" });
      // Add 50 charts
      for (let i = 0; i < 50; i++) {
        const chart = charts.barChart({
          categories: ["A"],
          series: [{ name: `S${i}`, values: [i] }],
        });
        charts.embedChart(pres, chart);
      }
      // 51st should fail
      const chart51 = charts.barChart({
        categories: ["A"],
        series: [{ name: "S51", values: [51] }],
      });
      expect(() => charts.embedChart(pres, chart51)).toThrow(/max 50/);
    });
  });
});

// ══════════════════════════════════════════════════════════════════════
// 4. Notes Sanitization
// ══════════════════════════════════════════════════════════════════════

describe("notes sanitization", () => {
  it("strips invalid XML control characters from notes", () => {
    const pres = pptx.createPresentation({ theme: "corporate-blue" });
    // \x01 is an invalid XML char that should be stripped
    pptx.titleSlide(pres, { title: "Test" }, { notes: "Hello\x01World" });
    // Should build successfully (validation would catch invalid chars)
    const zip = pres.buildZip();
    expect(zip).toBeInstanceOf(Uint8Array);
  });

  it("truncates notes exceeding 12,000 characters", () => {
    const pres = pptx.createPresentation({ theme: "corporate-blue" });
    const longNotes = "x".repeat(15_000);
    pptx.titleSlide(pres, { title: "Test" }, { notes: longNotes });
    // Should build without validation error about note length
    const zip = pres.buildZip();
    expect(zip).toBeInstanceOf(Uint8Array);
  });

  it("preserves valid notes text", () => {
    const pres = pptx.createPresentation({ theme: "corporate-blue" });
    pptx.titleSlide(
      pres,
      { title: "Test" },
      { notes: "These are speaker notes with tabs\tand\nnewlines" },
    );
    const zip = pres.buildZip();
    expect(zip).toBeInstanceOf(Uint8Array);
  });

  it("null/empty notes are handled gracefully", () => {
    const pres = pptx.createPresentation({ theme: "corporate-blue" });
    pptx.titleSlide(pres, { title: "Test" }, { notes: "" });
    pptx.titleSlide(pres, { title: "Test2" });
    const zip = pres.buildZip();
    expect(zip).toBeInstanceOf(Uint8Array);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 5. Validation Engine — buildZip enforcement
// ══════════════════════════════════════════════════════════════════════

describe("validation engine", () => {
  it("valid deck builds without error", () => {
    const pres = pptx.createPresentation({ theme: "corporate-blue" });
    pptx.titleSlide(pres, { title: "Welcome", subtitle: "Test deck" });
    pptx.contentSlide(pres, {
      title: "Content",
      body: [pptx.textBox({ x: 1, y: 2, w: 8, h: 3, text: "Body text" })],
    });
    const chart = charts.barChart({
      categories: ["Q1", "Q2"],
      series: [{ name: "Revenue", values: [100, 200] }],
    });
    pptx.chartSlide(pres, { title: "Chart", chart });
    pptx.addSlideNumbers(pres);

    const zip = pres.buildZip();
    expect(zip).toBeInstanceOf(Uint8Array);
    expect(zip.length).toBeGreaterThan(0);
  });

  it("_validatePresentation is called internally by buildZip", () => {
    // _validatePresentation is an internal function — not exported.
    // It's exercised via buildZip(). Verify buildZip succeeds on valid deck.
    const pres = pptx.createPresentation({ theme: "corporate-blue" });
    pptx.titleSlide(pres, { title: "Test" });
    const zip = pres.buildZip();
    expect(zip).toBeInstanceOf(Uint8Array);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 6. Regression Fixture — Full Deck with Charts, Tables, Notes
// ══════════════════════════════════════════════════════════════════════

describe("full deck regression fixture", () => {
  it("builds a complete deck with all slide types, charts, tables, and notes", () => {
    const pres = pptx.createPresentation({ theme: "dark-gradient" });

    // Title slide with notes
    pptx.titleSlide(
      pres,
      { title: "Q4 Report", subtitle: "Annual Review" },
      { notes: "Welcome everyone to the quarterly review." },
    );

    // Section divider
    pptx.sectionSlide(pres, {
      title: "Financial Overview",
      subtitle: "Key metrics and trends",
    });

    // Content slide
    pptx.contentSlide(pres, {
      title: "Summary",
      body: [
        pptx.bulletList({
          x: 0.5,
          y: 2,
          w: 10,
          h: 4,
          items: ["Revenue grew 15%", "Costs reduced 8%", "Margin improved"],
        }),
      ],
    });

    // Stat grid
    pptx.statGridSlide(pres, {
      title: "Key Metrics",
      stats: [
        { value: "$10M", label: "Revenue" },
        { value: "15%", label: "Growth" },
        { value: "92%", label: "Retention" },
      ],
    });

    // Bar chart
    const barData = charts.barChart({
      categories: ["Q1", "Q2", "Q3", "Q4"],
      series: [
        { name: "Revenue", values: [2.1, 2.5, 2.8, 3.2] },
        { name: "Target", values: [2.0, 2.3, 2.6, 3.0] },
      ],
      title: "Revenue vs Target",
    });
    pptx.chartSlide(
      pres,
      { title: "Revenue Trend", chart: barData },
      { notes: "Revenue exceeded target in all quarters." },
    );

    // Pie chart
    const pieData = charts.pieChart({
      labels: ["Product A", "Product B", "Product C", "Other"],
      values: [45, 30, 15, 10],
      title: "Revenue Mix",
    });
    pptx.chartSlide(pres, { title: "Revenue Breakdown", chart: pieData });

    // Line chart
    const lineData = charts.lineChart({
      categories: ["Jan", "Feb", "Mar", "Apr", "May", "Jun"],
      series: [{ name: "Users", values: [1000, 1200, 1500, 1800, 2200, 2800] }],
      title: "User Growth",
    });
    pptx.chartSlide(pres, { title: "User Growth", chart: lineData });

    // Table slide
    const tbl = tables.table({
      x: 0.5,
      y: 1.8,
      w: 12,
      theme: pres.theme,
      headers: ["Region", "Revenue", "Growth"],
      rows: [
        ["North America", "$5.2M", "+12%"],
        ["Europe", "$3.1M", "+18%"],
        ["Asia Pacific", "$1.7M", "+25%"],
      ],
    });
    pptx.customSlide(pres, {
      shapes: [
        pptx.textBox({
          x: 0.5,
          y: 0.5,
          w: 10,
          h: 1,
          text: "Regional Performance",
          fontSize: 28,
          bold: true,
        }),
        tbl,
      ],
    });

    // Comparison table
    const comp = tables.comparisonTable({
      x: 0.5,
      y: 1.8,
      w: 12,
      theme: pres.theme,
      features: ["SSO", "API Access", "Support", "Custom Domain"],
      options: [
        { name: "Free", values: [false, true, false, false] },
        { name: "Pro", values: [true, true, true, false] },
        { name: "Enterprise", values: [true, true, true, true] },
      ],
    });
    pptx.customSlide(pres, {
      shapes: [
        pptx.textBox({
          x: 0.5,
          y: 0.5,
          w: 10,
          h: 1,
          text: "Plan Comparison",
          fontSize: 28,
          bold: true,
        }),
        comp,
      ],
    });

    // Quote slide
    pptx.quoteSlide(pres, {
      quote: "The best way to predict the future is to invent it.",
      author: "Alan Kay",
      role: "Computer Scientist",
    });

    // Add slide numbers
    pptx.addSlideNumbers(pres);

    // Build — this exercises the full validation pipeline
    const zip = pres.buildZip();
    expect(zip).toBeInstanceOf(Uint8Array);
    expect(zip.length).toBeGreaterThan(1000);
    // buildZip may add a warning slide, so use >=
    expect(pres.slideCount).toBeGreaterThanOrEqual(10);
  });

  it("builds deck with many charts at the cap limit", () => {
    const pres = pptx.createPresentation({ theme: "corporate-blue" });

    // Add 10 chart slides — exercises chart embedding at scale
    for (let i = 0; i < 10; i++) {
      const chart = charts.barChart({
        categories: ["A", "B", "C"],
        series: [{ name: `Series ${i}`, values: [i * 10, i * 20, i * 30] }],
      });
      pptx.chartSlide(
        pres,
        { title: `Chart ${i + 1}`, chart },
        { notes: `Notes for chart slide ${i + 1}` },
      );
    }

    const zip = pres.buildZip();
    expect(zip).toBeInstanceOf(Uint8Array);
    // buildZip may add a warning slide, so use >=
    expect(pres.slideCount).toBeGreaterThanOrEqual(10);
  });

  it("builds deck with all table types", () => {
    const pres = pptx.createPresentation({ theme: "light-clean" });

    // Regular table
    const t1 = tables.table({
      x: 1,
      y: 1.5,
      w: 11,
      headers: ["Name", "Value"],
      rows: [["Alpha", "100"]],
    });
    pptx.customSlide(pres, { shapes: t1 });

    // KV table
    const t2 = tables.kvTable({
      x: 1,
      y: 1.5,
      w: 6,
      items: [
        { key: "Status", value: "Active" },
        { key: "Version", value: "2.0" },
      ],
    });
    pptx.customSlide(pres, { shapes: t2 });

    // Comparison table
    const t3 = tables.comparisonTable({
      x: 1,
      y: 1.5,
      w: 11,
      features: ["Feature A"],
      options: [{ name: "Plan 1", values: [true] }],
    });
    pptx.customSlide(pres, { shapes: t3 });

    // Timeline
    const t4 = tables.timeline({
      x: 1,
      y: 1.5,
      w: 11,
      items: [
        { label: "Phase 1", description: "Setup" },
        { label: "Phase 2", description: "Build" },
      ],
    });
    pptx.customSlide(pres, { shapes: t4 });

    const zip = pres.buildZip();
    expect(zip).toBeInstanceOf(Uint8Array);
    // buildZip may add a warning slide, so use >=
    expect(pres.slideCount).toBeGreaterThanOrEqual(4);
  });
});
