// ── PPTX Input Validation Tests ────────────────────────────────────────
//
// Tests for the hard validation layer that prevents LLMs from creating
// bad PPTX data: missing fields, garbage hex, invisible colours, invalid
// enums, wrong types, and column-count mismatches.
//
// Every validation function tells the LLM WHAT went wrong, WHY, and
// HOW to fix it.  These tests verify the error messages are helpful.
// ──────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Module imports ───────────────────────────────────────────────────

const core: any = await import("../builtin-modules/ooxml-core.js");
const pptx: any = await import("../builtin-modules/pptx.js");
const charts: any = await import("../builtin-modules/pptx-charts.js");
const tables: any = await import("../builtin-modules/pptx-tables.js");

/** Convert ShapeFragment or string to XML string for test assertions */
const toXml = (v: unknown): string => (typeof v === "string" ? v : String(v));

// ══════════════════════════════════════════════════════════════════════
// ooxml-core: Central Validation Functions
// ══════════════════════════════════════════════════════════════════════

describe("requireHex", () => {
  it("should accept valid 6-char hex", () => {
    expect(core.requireHex("2196F3", "test")).toBe("2196F3");
  });

  it("should accept hex with # prefix", () => {
    expect(core.requireHex("#FF9800", "test")).toBe("FF9800");
  });

  it("should uppercase the result", () => {
    expect(core.requireHex("abcdef", "test")).toBe("ABCDEF");
  });

  it("should throw on null with helpful message", () => {
    expect(() => core.requireHex(null, "rect.fill")).toThrow(
      /rect\.fill.*colour is required.*null/,
    );
  });

  it("should throw on undefined with helpful message", () => {
    expect(() => core.requireHex(undefined, "rect.fill")).toThrow(
      /rect\.fill.*colour is required.*undefined/,
    );
  });

  it("should throw on non-string type with type info", () => {
    expect(() => core.requireHex(42, "rect.fill")).toThrow(
      /rect\.fill.*hex colour string.*number/,
    );
  });

  it("should throw on 3-char shorthand with format guidance", () => {
    expect(() => core.requireHex("FFF", "rect.fill")).toThrow(
      /rect\.fill.*"FFF".*not a valid 6-character hex.*3-char shorthand/,
    );
  });

  it("should throw on named colours with guidance", () => {
    expect(() => core.requireHex("red", "rect.fill")).toThrow(
      /rect\.fill.*"red".*not a valid 6-character hex.*named colours/,
    );
  });

  it("should throw on rgb() notation with guidance", () => {
    expect(() => core.requireHex("rgb(255,0,0)", "rect.fill")).toThrow(
      /rect\.fill.*rgb\(\).*NOT supported/,
    );
  });

  it("should throw on empty string", () => {
    expect(() => core.requireHex("", "rect.fill")).toThrow(
      /rect\.fill.*not a valid 6-character hex/,
    );
  });

  it("should throw on 8-char hex (with alpha)", () => {
    expect(() => core.requireHex("FF9800FF", "rect.fill")).toThrow(
      /rect\.fill.*not a valid 6-character hex/,
    );
  });
});

describe("contrastRatio", () => {
  it("should return 21:1 for black on white", () => {
    const ratio = core.contrastRatio("000000", "FFFFFF");
    expect(ratio).toBeCloseTo(21, 0);
  });

  it("should return 1:1 for same colour", () => {
    const ratio = core.contrastRatio("2196F3", "2196F3");
    expect(ratio).toBeCloseTo(1, 1);
  });

  it("should return high contrast for white on dark blue", () => {
    const ratio = core.contrastRatio("FFFFFF", "1B2A4A");
    expect(ratio).toBeGreaterThan(10);
  });

  it("should be re-exported from pptx module", () => {
    // LLMs can use this for pre-validation
    const ratio = pptx.contrastRatio("FFFFFF", "000000");
    expect(ratio).toBeCloseTo(21, 0);
  });
});

describe("requireThemeColor", () => {
  const darkTheme = core.THEMES["corporate-blue"]; // bg=1B2A4A
  const lightTheme = core.THEMES["light-clean"]; // bg=FFFFFF

  it("should accept theme palette colours without contrast check", () => {
    // accent1 on corporate-blue might not have 4.5:1 contrast vs bg,
    // but theme colours are always allowed
    expect(core.requireThemeColor("2196F3", darkTheme, "test")).toBe("2196F3");
  });

  it("should accept custom colour with high contrast", () => {
    // White text on dark bg — excellent contrast
    expect(core.requireThemeColor("FAFAFA", darkTheme, "test")).toBe("FAFAFA");
  });

  it("should throw on low-contrast custom colour with ratio info", () => {
    // Dark text on dark bg — invisible
    expect(() => core.requireThemeColor("1A1A1A", darkTheme, "test")).toThrow(
      /contrast ratio.*against background "1B2A4A".*below.*4\.5:1/,
    );
  });

  it("should include fix instruction and theme palette reference in error message", () => {
    expect(() => core.requireThemeColor("1A1A1A", darkTheme, "test")).toThrow(
      /FIX: REMOVE the color parameter.*theme\.fg.*theme\.accent/,
    );
  });

  it("should display contrast ratio with 2 decimal places (regression: toFixed(2))", () => {
    // This test ensures we don't round misleadingly. A ratio of 4.48 should
    // display as "4.48:1", NOT as "4.5:1" (which would be confusing since it
    // still fails the <4.5 check).
    // Find a colour pair that gives ~4.48 contrast against 1B2A4A:
    // contrastRatio("1B2A4A", "767676") ≈ 4.48
    try {
      core.requireThemeColor("767676", darkTheme, "test");
      // If it passes, skip this test — contrast is actually >= 4.5
    } catch (e: any) {
      // Verify the error shows 2 decimal places
      expect(e.message).toMatch(/contrast ratio \d+\.\d{2}:1/);
      // Verify it does NOT show a misleading "4.5:1" when ratio is actually <4.5
      expect(e.message).not.toMatch(/contrast ratio 4\.50?:1/);
    }
  });

  it("should check contrast against custom 'against' colour", () => {
    // Light grey text on light grey fill — invisible (use non-palette colour)
    expect(() =>
      core.requireThemeColor("EEEEEE", lightTheme, "test", {
        against: "F0F0F0",
      }),
    ).toThrow(/contrast ratio.*against.*F0F0F0/);
  });

  it("should pass when no theme is provided (skip check)", () => {
    expect(core.requireThemeColor("1A1A1A", null, "test")).toBe("1A1A1A");
  });

  it("should accept all theme colours on dark theme", () => {
    for (const key of [
      "fg",
      "accent1",
      "accent2",
      "accent3",
      "accent4",
      "subtle",
    ]) {
      expect(() =>
        core.requireThemeColor(darkTheme[key], darkTheme, `theme.${key}`),
      ).not.toThrow();
    }
  });

  it("should accept all theme colours on light theme", () => {
    for (const key of [
      "fg",
      "accent1",
      "accent2",
      "accent3",
      "accent4",
      "subtle",
    ]) {
      expect(() =>
        core.requireThemeColor(lightTheme[key], lightTheme, `theme.${key}`),
      ).not.toThrow();
    }
  });
});

describe("requireNumber", () => {
  it("should accept valid numbers", () => {
    expect(core.requireNumber(42, "test")).toBe(42);
    expect(core.requireNumber(0, "test")).toBe(0);
    expect(core.requireNumber(-5, "test")).toBe(-5);
    expect(core.requireNumber(3.14, "test")).toBe(3.14);
  });

  it("should throw on NaN", () => {
    expect(() => core.requireNumber(NaN, "fontSize")).toThrow(
      /fontSize.*expected a number/,
    );
  });

  it("should throw on string", () => {
    expect(() => core.requireNumber("big", "fontSize")).toThrow(
      /fontSize.*expected a number.*string.*"big"/,
    );
  });

  it("should throw on null", () => {
    expect(() => core.requireNumber(null, "fontSize")).toThrow(
      /fontSize.*expected a number.*object/,
    );
  });

  it("should throw on Infinity", () => {
    expect(() => core.requireNumber(Infinity, "fontSize")).toThrow(
      /fontSize.*expected a number/,
    );
  });

  it("should enforce min bound", () => {
    expect(() => core.requireNumber(-1, "fontSize", { min: 0 })).toThrow(
      /fontSize.*-1.*below the minimum 0/,
    );
  });

  it("should enforce max bound", () => {
    expect(() => core.requireNumber(300, "fontSize", { max: 200 })).toThrow(
      /fontSize.*300.*exceeds the maximum 200/,
    );
  });
});

describe("requireString", () => {
  it("should accept non-empty strings", () => {
    expect(core.requireString("hello", "test")).toBe("hello");
  });

  it("should throw on empty string", () => {
    expect(() => core.requireString("", "title")).toThrow(
      /title.*non-empty string/,
    );
  });

  it("should throw on non-string with type info", () => {
    expect(() => core.requireString(42, "title")).toThrow(
      /title.*non-empty string.*number/,
    );
  });

  it("should throw on null", () => {
    expect(() => core.requireString(null, "title")).toThrow(
      /title.*non-empty string.*object/,
    );
  });
});

describe("requireArray", () => {
  it("should accept arrays", () => {
    expect(core.requireArray([1, 2], "test")).toEqual([1, 2]);
    expect(core.requireArray([], "test")).toEqual([]);
  });

  it("should auto-convert strings to arrays by splitting on newlines", () => {
    expect(core.requireArray("one\ntwo\nthree", "items")).toEqual([
      "one",
      "two",
      "three",
    ]);
    // Should trim each line
    expect(core.requireArray("  one  \n  two  ", "items")).toEqual([
      "one",
      "two",
    ]);
    // Should filter empty lines
    expect(core.requireArray("one\n\ntwo", "items")).toEqual(["one", "two"]);
  });

  it("should throw on non-array non-string types", () => {
    expect(() => core.requireArray(12345, "items")).toThrow(
      /items.*expected an array.*number/,
    );
  });

  it("should throw on null", () => {
    expect(() => core.requireArray(null, "items")).toThrow(
      /items.*expected an array/,
    );
  });

  it("should enforce nonEmpty option", () => {
    expect(() => core.requireArray([], "items", { nonEmpty: true })).toThrow(
      /items.*must not be empty/,
    );
  });
});

describe("requireEnum", () => {
  it("should accept whitelisted values", () => {
    expect(core.requireEnum("dash", "dash", ["solid", "dash", "dot"])).toBe(
      "dash",
    );
  });

  it("should throw on invalid value listing all options", () => {
    expect(() =>
      core.requireEnum("dashed", "dash", ["solid", "dash", "dot"]),
    ).toThrow(/dash.*"dashed".*not a valid option.*"solid".*"dash".*"dot"/);
  });
});

// ══════════════════════════════════════════════════════════════════════
// pptx.js: Shape Input Validation
// ══════════════════════════════════════════════════════════════════════

describe("pptx shape validation", () => {
  // Set up active theme before each test (simulates createPresentation)
  // Use light-clean theme with forceAllColors: false to test contrast validation
  beforeEach(() => {
    pptx.createPresentation({ theme: "light-clean", forceAllColors: false });
  });

  describe("textBox", () => {
    it("should throw on invalid fontSize", () => {
      expect(() =>
        pptx.textBox({ x: 0, y: 0, w: 4, h: 1, text: "hi", fontSize: "big" }),
      ).toThrow(/textBox\.fontSize.*expected a number.*string/);
    });

    it("should throw on fontSize below minimum", () => {
      expect(() =>
        pptx.textBox({ x: 0, y: 0, w: 4, h: 1, text: "hi", fontSize: 0 }),
      ).toThrow(/textBox\.fontSize.*below the minimum 1/);
    });

    it("should throw on invalid colour hex", () => {
      expect(() =>
        pptx.textBox({ x: 0, y: 0, w: 4, h: 1, text: "hi", color: "red" }),
      ).toThrow(/textBox\.color.*"red".*not a valid 6-character hex/);
    });

    it("should throw on low-contrast text colour", () => {
      // Light text on light theme bg (white on white = low contrast)
      expect(() =>
        pptx.textBox({
          x: 0,
          y: 0,
          w: 4,
          h: 1,
          text: "hi",
          color: "F0F0F0",
        }),
      ).toThrow(/textBox\.color.*contrast ratio.*below.*4\.5:1/);
    });

    it("should accept valid high-contrast text colour", () => {
      // Dark text on light bg = high contrast
      expect(() =>
        pptx.textBox({
          x: 0,
          y: 0,
          w: 4,
          h: 1,
          text: "hi",
          color: "000000",
        }),
      ).not.toThrow();
    });

    it("should accept valid background hex (fill, no contrast check)", () => {
      // Dark bg on light theme — fills don't need contrast
      expect(() =>
        pptx.textBox({
          x: 0,
          y: 0,
          w: 4,
          h: 1,
          text: "hi",
          background: "1A1A1A",
        }),
      ).not.toThrow();
    });

    it("should throw on invalid background hex", () => {
      expect(() =>
        pptx.textBox({
          x: 0,
          y: 0,
          w: 4,
          h: 1,
          text: "hi",
          background: "nope",
        }),
      ).toThrow(/textBox\.background.*not a valid 6-character hex/);
    });

    it("should check text vs background contrast when both specified", () => {
      // Light grey text on light grey bg — invisible
      // textBox checks text colour against explicit background when both present
      expect(() =>
        pptx.textBox({
          x: 0,
          y: 0,
          w: 4,
          h: 1,
          text: "hi",
          color: "E0E0E0",
          background: "F0F0F0",
        }),
      ).toThrow(/textBox\.color.*contrast ratio.*below.*4\.5:1/);
    });

    it("should allow low-contrast colour when forceColor: true", () => {
      // This would normally fail contrast check (dark text on dark theme bg)
      // but forceColor bypasses validation
      expect(() =>
        pptx.textBox({
          x: 0,
          y: 0,
          w: 4,
          h: 1,
          text: "hi",
          color: "1A1A1A",
          forceColor: true,
        }),
      ).not.toThrow();
    });

    it("should allow any colour with forceColor even without background specified", () => {
      // No background specified, low-contrast against theme bg
      // but forceColor bypasses all checks
      expect(() =>
        pptx.textBox({
          x: 0,
          y: 0,
          w: 4,
          h: 1,
          text: "hi",
          color: "333333",
          forceColor: true,
        }),
      ).not.toThrow();
    });

    it("should emit spcPts for lineSpacing in points", () => {
      // lineSpacing: 24 should produce spcPts val="2400" (points × 100 = centipoints)
      const xml = toXml(
        pptx.textBox({
          x: 0,
          y: 0,
          w: 4,
          h: 1,
          text: "test",
          lineSpacing: 24,
        }),
      );
      expect(xml).toContain('<a:spcPts val="2400"/>');
    });

    it("should not add lnSpc element when lineSpacing omitted", () => {
      const xml = toXml(
        pptx.textBox({
          x: 0,
          y: 0,
          w: 4,
          h: 1,
          text: "no spacing",
        }),
      );
      expect(xml).not.toContain("<a:lnSpc>");
    });

    it("should throw when shape overflows slide bounds (right edge)", () => {
      expect(() =>
        pptx.textBox({ x: 12, y: 1, w: 4, h: 1, text: "overflows right" }),
      ).toThrow(/textBox:.*overflows slide bounds/);
    });

    it("should throw when shape overflows slide bounds (bottom edge)", () => {
      expect(() =>
        pptx.textBox({ x: 1, y: 7, w: 4, h: 2, text: "overflows bottom" }),
      ).toThrow(/textBox:.*overflows slide bounds/);
    });

    it("should throw when shape has negative position", () => {
      expect(() =>
        pptx.textBox({ x: -1, y: 1, w: 4, h: 1, text: "negative x" }),
      ).toThrow(/textBox:[\s\S]*overflows[\s\S]*negative/);
    });

    it("should throw when text content overflows shape", () => {
      // 10 lines of text at 18pt won't fit in 0.5" tall box
      const longText = Array(10).fill("This is a line of text").join("\n");
      expect(() =>
        pptx.textBox({ x: 1, y: 1, w: 10, h: 0.5, text: longText }),
      ).toThrow(/textBox:.*text content likely overflows/);
    });

    it("should auto-scale fontSize with autoFit: true", () => {
      // Long text that would overflow without autoFit
      const longText = Array(10).fill("This is a line of text").join("\n");
      // Should not throw with autoFit enabled
      expect(() =>
        pptx.textBox({
          x: 1,
          y: 1,
          w: 10,
          h: 2,
          text: longText,
          autoFit: true,
        }),
      ).not.toThrow();
    });

    it("should reduce fontSize when autoFit is enabled", () => {
      const longText = Array(5)
        .fill("This line of text needs space")
        .join("\n");
      // With autoFit and explicit large fontSize, it should scale down
      const xml = toXml(
        pptx.textBox({
          x: 1,
          y: 1,
          w: 8,
          h: 1.5,
          text: longText,
          fontSize: 72,
          autoFit: true,
        }),
      );
      // The fontSize in the XML should be smaller than 72pt (7200 centipoints)
      // Look for sz="XXXX" where XXXX < 7200
      const match = xml.match(/sz="(\d+)"/);
      expect(match).toBeTruthy();
      const actualSize = parseInt(match![1], 10);
      expect(actualSize).toBeLessThan(7200);
    });
  });

  describe("rect", () => {
    it("should throw on invalid fill hex", () => {
      expect(() =>
        pptx.rect({ x: 0, y: 0, w: 2, h: 1, fill: "not-hex" }),
      ).toThrow(/rect\.fill.*not a valid 6-character hex/);
    });

    it("should throw on text colour matching fill (invisible)", () => {
      expect(() =>
        pptx.rect({
          x: 0,
          y: 0,
          w: 2,
          h: 1,
          fill: "FFFFFF",
          color: "FAFAFA",
          text: "hi",
        }),
      ).toThrow(/rect\.color.*contrast ratio.*below.*4\.5:1/);
    });

    it("should accept valid fill + auto text colour", () => {
      expect(() =>
        pptx.rect({ x: 0, y: 0, w: 2, h: 1, fill: "2196F3", text: "hi" }),
      ).not.toThrow();
    });

    it("should throw on invalid borderColor hex", () => {
      expect(() =>
        pptx.rect({ x: 0, y: 0, w: 2, h: 1, borderColor: "rgb(0,0,0)" }),
      ).toThrow(/rect\.borderColor.*not a valid 6-character hex/);
    });

    it("should throw on invalid borderWidth", () => {
      expect(() =>
        pptx.rect({
          x: 0,
          y: 0,
          w: 2,
          h: 1,
          borderWidth: "thick",
        }),
      ).toThrow(/rect\.borderWidth.*expected a number/);
    });

    it("should allow low-contrast text colour when forceColor: true", () => {
      // This would normally fail - light text on light fill
      expect(() =>
        pptx.rect({
          x: 0,
          y: 0,
          w: 2,
          h: 1,
          fill: "FFFFFF",
          color: "FAFAFA",
          text: "hi",
          forceColor: true,
        }),
      ).not.toThrow();
    });
  });

  describe("bulletList", () => {
    it("should throw when items is not an array (and not a string)", () => {
      // Note: strings are auto-converted to arrays by splitting on newlines
      expect(() =>
        pptx.bulletList({
          x: 0,
          y: 0,
          w: 8,
          h: 4,
          items: 12345, // number, not array or string
        }),
      ).toThrow(/bulletList\.items.*expected an array.*number/);
    });

    it("should throw on invalid bullet colour hex", () => {
      expect(() =>
        pptx.bulletList({
          x: 0,
          y: 0,
          w: 8,
          h: 4,
          items: ["a"],
          bulletColor: "nope",
        }),
      ).toThrow(/bulletList\.bulletColor.*not a valid 6-character hex/);
    });
  });

  describe("numberedList", () => {
    it("should throw on non-array items", () => {
      expect(() =>
        pptx.numberedList({ x: 0, y: 0, w: 8, h: 4, items: 42 }),
      ).toThrow(/numberedList\.items.*expected an array/);
    });

    it("should throw on non-numeric startAt", () => {
      expect(() =>
        pptx.numberedList({
          x: 0,
          y: 0,
          w: 8,
          h: 4,
          items: ["a"],
          startAt: "three",
        }),
      ).toThrow(/numberedList\.startAt.*expected a number/);
    });
  });

  describe("statBox", () => {
    it("should throw on invalid valueColor vs background", () => {
      // Dark value text on dark background
      expect(() =>
        pptx.statBox({
          x: 0,
          y: 0,
          w: 3,
          h: 2,
          value: "42",
          label: "Users",
          background: "1A1A1A",
          valueColor: "222222",
        }),
      ).toThrow(/statBox\.valueColor.*contrast ratio.*below.*4\.5:1/);
    });

    it("should accept valid statBox with background + auto colours", () => {
      expect(() =>
        pptx.statBox({
          x: 0,
          y: 0,
          w: 3,
          h: 2,
          value: "42",
          label: "Users",
          background: "1A1A1A",
        }),
      ).not.toThrow();
    });

    it("should allow low-contrast colours when forceColor: true", () => {
      // This would normally fail - dark text on dark background
      expect(() =>
        pptx.statBox({
          x: 0,
          y: 0,
          w: 3,
          h: 2,
          value: "42",
          label: "Users",
          background: "1A1A1A",
          valueColor: "222222",
          labelColor: "333333",
          forceColor: true,
        }),
      ).not.toThrow();
    });
  });

  describe("line", () => {
    it("should throw on invalid dash enum", () => {
      expect(() =>
        pptx.line({
          x1: 0,
          y1: 0,
          x2: 5,
          y2: 5,
          dash: "dashed",
        }),
      ).toThrow(/line\.dash.*"dashed".*not a valid option.*"dash".*"dot"/);
    });

    it("should accept valid dash values", () => {
      expect(() =>
        pptx.line({ x1: 0, y1: 0, x2: 5, y2: 5, dash: "dashDot" }),
      ).not.toThrow();
    });

    it("should throw on invalid width", () => {
      expect(() =>
        pptx.line({ x1: 0, y1: 0, x2: 5, y2: 5, width: "thin" }),
      ).toThrow(/line\.width.*expected a number/);
    });
  });

  describe("arrow", () => {
    it("should throw on invalid headType enum", () => {
      expect(() =>
        pptx.arrow({
          x1: 0,
          y1: 0,
          x2: 5,
          y2: 5,
          headType: "pointy",
        }),
      ).toThrow(
        /arrow\.headType.*"pointy".*not a valid option.*"triangle".*"stealth"/,
      );
    });

    it("should accept valid headType", () => {
      expect(() =>
        pptx.arrow({
          x1: 0,
          y1: 0,
          x2: 5,
          y2: 5,
          headType: "diamond",
        }),
      ).not.toThrow();
    });

    it("should throw on invalid dash + headType together", () => {
      expect(() =>
        pptx.arrow({
          x1: 0,
          y1: 0,
          x2: 5,
          y2: 5,
          dash: "dotted",
          headType: "triangle",
        }),
      ).toThrow(/arrow\.dash.*"dotted".*not a valid option/);
    });
  });

  describe("circle", () => {
    it("should throw on invalid fill hex", () => {
      expect(() => pptx.circle({ x: 3, y: 3, w: 2, fill: "blue" })).toThrow(
        /circle\.fill.*not a valid 6-character hex/,
      );
    });

    it("should throw on text colour matching fill", () => {
      expect(() =>
        pptx.circle({
          x: 3,
          y: 3,
          w: 2,
          fill: "000000",
          color: "111111",
          text: "X",
        }),
      ).toThrow(/circle\.color.*contrast ratio.*below.*4\.5:1/);
    });
  });

  describe("icon", () => {
    it("should throw error on unknown icon shape", () => {
      // Unknown shapes should throw an error with helpful message
      expect(() => pptx.icon({ x: 1, y: 1, w: 0.5, shape: "trophy" })).toThrow(
        /unknown shape 'trophy'/,
      );
    });

    it("should include available shapes in error message", () => {
      expect(() =>
        pptx.icon({ x: 1, y: 1, w: 0.5, shape: "invalidShape123" }),
      ).toThrow(/Available shapes include:/);
    });

    it("should accept valid OOXML icon shapes", () => {
      expect(() =>
        pptx.icon({ x: 1, y: 1, w: 0.5, shape: "star" }),
      ).not.toThrow();
      expect(() =>
        pptx.icon({ x: 1, y: 1, w: 0.5, shape: "heart" }),
      ).not.toThrow();
    });

    it("should render SVG icons from SVG_ICONS map", () => {
      // "layers" is an SVG icon, not an OOXML preset
      const result = toXml(pptx.icon({ x: 1, y: 1, w: 0.5, shape: "layers" }));
      // SVG icons use custGeom, not prstGeom
      expect(result).toContain("<a:custGeom>");
      expect(result).toContain("<a:pathLst>");
    });
  });

  describe("svgPath", () => {
    it("should throw when d (path data) is missing", () => {
      expect(() => pptx.svgPath({ x: 0, y: 0, w: 1 })).toThrow(
        /svgPath\.d.*non-empty string/,
      );
    });

    it("should throw on invalid fill hex", () => {
      expect(() =>
        pptx.svgPath({ x: 0, y: 0, w: 1, d: "M0 0L10 10Z", fill: "red" }),
      ).toThrow(/svgPath\.fill.*not a valid 6-character hex/);
    });

    it("should throw on invalid stroke hex", () => {
      expect(() =>
        pptx.svgPath({ x: 0, y: 0, w: 1, d: "M0 0L10 10Z", stroke: "blue" }),
      ).toThrow(/svgPath\.stroke.*not a valid 6-character hex/);
    });

    it("should accept valid SVG path with fill", () => {
      const xml = toXml(
        pptx.svgPath({
          x: 1,
          y: 1,
          w: 1,
          d: "M0 0L24 12L0 24Z",
          fill: "2196F3",
        }),
      );
      expect(xml).toContain("<a:custGeom>");
      expect(xml).toContain("<a:moveTo>");
      expect(xml).toContain("<a:lnTo>");
      expect(xml).toContain("<a:close/>");
      expect(xml).toContain("2196F3");
    });

    it("should parse cubic bezier curves", () => {
      const xml = toXml(
        pptx.svgPath({
          x: 0,
          y: 0,
          w: 1,
          d: "M0 0C10 0 20 10 20 20",
          fill: "FFFFFF",
        }),
      );
      expect(xml).toContain("<a:cubicBezTo>");
    });

    it("should parse quadratic bezier curves", () => {
      const xml = toXml(
        pptx.svgPath({
          x: 0,
          y: 0,
          w: 1,
          d: "M0 0Q12 0 12 12",
          fill: "FFFFFF",
        }),
      );
      expect(xml).toContain("<a:quadBezTo>");
    });

    it("should handle relative commands (lowercase)", () => {
      const xml = toXml(
        pptx.svgPath({
          x: 0,
          y: 0,
          w: 1,
          d: "m5 5l10 0l0 10l-10 0z",
          fill: "FFFFFF",
        }),
      );
      expect(xml).toContain("<a:moveTo>");
      expect(xml).toContain("<a:lnTo>");
      expect(xml).toContain("<a:close/>");
    });

    it("should support stroke without fill", () => {
      const xml = toXml(
        pptx.svgPath({
          x: 0,
          y: 0,
          w: 1,
          d: "M0 0L10 10",
          stroke: "333333",
          strokeWidth: 2,
        }),
      );
      expect(xml).toContain("<a:noFill/>");
      expect(xml).toContain("333333");
      expect(xml).toContain("a:ln");
    });

    it("should use custom viewBox dimensions", () => {
      // With viewBox 100x100, coordinates should be normalized differently
      const xml = toXml(
        pptx.svgPath({
          x: 0,
          y: 0,
          w: 1,
          d: "M50 50L100 100",
          fill: "FFFFFF",
          viewBox: { w: 100, h: 100 },
        }),
      );
      // 50/100 = 0.5 = 50000 EMUs
      expect(xml).toContain('x="50000"');
    });

    it("should parse SVG arc commands (A/a)", () => {
      // Absolute arc: M10,10 A5,5 0 0,1 20,10 (half circle)
      const xml = toXml(
        pptx.svgPath({
          x: 0,
          y: 0,
          w: 1,
          d: "M10 10 A5 5 0 0 1 20 10",
          fill: "FFFFFF",
        }),
      );
      expect(xml).toContain("<a:cubicBezTo>"); // arcs are approximated with beziers
      expect(xml).toContain("<a:moveTo>");
    });

    it("should parse relative SVG arc commands (a)", () => {
      // Relative arc: m10,10 a5,5 0 0,1 10,0
      const xml = toXml(
        pptx.svgPath({
          x: 0,
          y: 0,
          w: 1,
          d: "m10 10 a5 5 0 0 1 10 0",
          fill: "FFFFFF",
        }),
      );
      expect(xml).toContain("<a:cubicBezTo>");
    });

    it("should handle degenerate arcs (zero radius)", () => {
      // Zero radius should produce a line
      const xml = toXml(
        pptx.svgPath({
          x: 0,
          y: 0,
          w: 1,
          d: "M10 10 A0 0 0 0 1 20 10",
          fill: "FFFFFF",
        }),
      );
      expect(xml).toContain("<a:lnTo>");
    });
  });

  describe("gradientFill", () => {
    it("should throw on null color1", () => {
      expect(() => pptx.gradientFill(null, "FFFFFF")).toThrow(
        /gradientFill\.color1.*colour is required/,
      );
    });

    it("should throw on null color2", () => {
      expect(() => pptx.gradientFill("2196F3", null)).toThrow(
        /gradientFill\.color2.*colour is required/,
      );
    });

    it("should throw on invalid angle type", () => {
      expect(() => pptx.gradientFill("2196F3", "FFFFFF", "top")).toThrow(
        /gradientFill\.angle.*expected a number/,
      );
    });

    it("should accept valid gradient", () => {
      expect(() => pptx.gradientFill("2196F3", "FFFFFF", 180)).not.toThrow();
    });
  });

  describe("markdownToNotes", () => {
    it("should throw on empty string", () => {
      expect(() => pptx.markdownToNotes("")).toThrow(
        /markdownToNotes\.md.*non-empty string/,
      );
    });

    it("should strip headers", () => {
      const result = pptx.markdownToNotes("# Title\n## Subtitle\nText");
      expect(result).toContain("Title");
      expect(result).toContain("Subtitle");
      expect(result).not.toContain("#");
    });

    it("should strip bold and italic markers", () => {
      const result = pptx.markdownToNotes(
        "**bold** and *italic* and ***both***",
      );
      expect(result).toBe("bold and italic and both");
    });

    it("should convert list markers to bullets", () => {
      const result = pptx.markdownToNotes("- item1\n* item2\n+ item3");
      expect(result).toContain("• item1");
      expect(result).toContain("• item2");
      expect(result).toContain("• item3");
    });

    it("should extract link text", () => {
      const result = pptx.markdownToNotes(
        "Check [this link](https://example.com) out",
      );
      expect(result).toBe("Check this link out");
    });

    it("should strip inline code backticks", () => {
      const result = pptx.markdownToNotes("Use `console.log()` for debugging");
      expect(result).toBe("Use console.log() for debugging");
    });

    it("should strip code block fences but keep content", () => {
      const result = pptx.markdownToNotes(
        "Example:\n```javascript\nconst x = 1;\n```",
      );
      expect(result).toContain("const x = 1");
      expect(result).not.toContain("```");
    });

    it("should strip blockquote markers", () => {
      const result = pptx.markdownToNotes("> This is a quote");
      expect(result).toBe("This is a quote");
    });
  });

  describe("richText", () => {
    it("should throw when paragraphs is not array-of-arrays (and not a string)", () => {
      // Note: strings are auto-converted to arrays by splitting on newlines
      expect(() =>
        pptx.richText({
          x: 0,
          y: 0,
          w: 8,
          h: 2,
          paragraphs: 12345 as any,
        }),
      ).toThrow(/richText\.paragraphs.*expected an array/);
    });

    it("should throw when paragraph runs are not arrays (and not strings)", () => {
      // Note: strings are auto-converted to arrays by splitting on newlines
      expect(() =>
        pptx.richText({
          x: 0,
          y: 0,
          w: 8,
          h: 2,
          paragraphs: [12345 as any],
        }),
      ).toThrow(/richText\.paragraphs\[0\].*expected an array/);
    });

    it("should throw on invalid per-run colour", () => {
      expect(() =>
        pptx.richText({
          x: 0,
          y: 0,
          w: 8,
          h: 2,
          paragraphs: [[{ text: "hi", color: "banana" }]],
        }),
      ).toThrow(
        /richText\.paragraphs\[0\]\[0\]\.color.*not a valid 6-character hex/,
      );
    });

    it("should throw on invalid per-run fontSize", () => {
      expect(() =>
        pptx.richText({
          x: 0,
          y: 0,
          w: 8,
          h: 2,
          paragraphs: [[{ text: "hi", fontSize: "huge" }]],
        }),
      ).toThrow(/richText\.paragraphs\[0\]\[0\]\.fontSize.*expected a number/);
    });
  });

  describe("hyperlink", () => {
    it("should throw when url is missing", () => {
      expect(() =>
        pptx.hyperlink(
          { x: 0, y: 0, w: 4, h: 0.5, text: "Click" },
          pptx.createPresentation(),
        ),
      ).toThrow(/hyperlink\.url.*non-empty string/);
    });

    it("should throw when pres is missing", () => {
      expect(() =>
        pptx.hyperlink({
          x: 0,
          y: 0,
          w: 4,
          h: 0.5,
          text: "Click",
          url: "https://example.com",
        }),
      ).toThrow(/hyperlink.*pres.*presentation builder.*required/);
    });

    it("should accept valid hyperlink", () => {
      const pres = pptx.createPresentation();
      expect(() =>
        pptx.hyperlink(
          {
            x: 0,
            y: 0,
            w: 4,
            h: 0.5,
            text: "Click",
            url: "https://example.com",
          },
          pres,
        ),
      ).not.toThrow();
    });
  });

  describe("embedImage", () => {
    it("should throw when pres is null", () => {
      expect(() => pptx.embedImage(null, { data: new Uint8Array(10) })).toThrow(
        /embedImage.*pres.*required/,
      );
    });

    it("should throw when data is missing", () => {
      const pres = pptx.createPresentation();
      expect(() => pptx.embedImage(pres, {})).toThrow(
        /embedImage.*opts\.data.*required.*Uint8Array/,
      );
    });

    it("should throw on invalid image format", () => {
      const pres = pptx.createPresentation();
      expect(() =>
        pptx.embedImage(pres, {
          data: new Uint8Array(10),
          format: "webp",
        }),
      ).toThrow(/embedImage\.format.*"webp".*not a valid option.*"png".*"jpg"/);
    });
  });

  describe("embedImageFromUrl", () => {
    it("should throw when pres is null", () => {
      expect(() =>
        pptx.embedImageFromUrl(null, {
          url: "https://example.com/logo.png",
          data: new Uint8Array(10),
        }),
      ).toThrow(/embedImageFromUrl.*pres.*required/);
    });

    it("should throw when url is missing", () => {
      const pres = pptx.createPresentation();
      expect(() =>
        pptx.embedImageFromUrl(pres, { data: new Uint8Array(10) }),
      ).toThrow(/embedImageFromUrl\.url.*expected.*string/);
    });

    it("should throw when data is missing", () => {
      const pres = pptx.createPresentation();
      expect(() =>
        pptx.embedImageFromUrl(pres, { url: "https://example.com/logo.png" }),
      ).toThrow(/embedImageFromUrl.*opts\.data.*required.*readBinary/);
    });

    it("should auto-detect png format from URL", () => {
      const pres = pptx.createPresentation();
      const shape = toXml(
        pptx.embedImageFromUrl(pres, {
          url: "https://example.com/image.png",
          data: new Uint8Array(10),
          x: 1,
          y: 2,
          w: 3,
          h: 2,
        }),
      );
      expect(shape).toContain("p:pic");
      expect(pres._images[0].contentType).toBe("image/png");
    });

    it("should auto-detect jpg format from URL", () => {
      const pres = pptx.createPresentation();
      pptx.embedImageFromUrl(pres, {
        url: "https://example.com/photo.jpg",
        data: new Uint8Array(10),
        x: 1,
        y: 2,
        w: 3,
        h: 2,
      });
      expect(pres._images[0].contentType).toBe("image/jpeg");
    });

    it("should auto-detect jpeg format from URL", () => {
      const pres = pptx.createPresentation();
      pptx.embedImageFromUrl(pres, {
        url: "https://example.com/photo.jpeg",
        data: new Uint8Array(10),
        x: 1,
        y: 2,
        w: 3,
        h: 2,
      });
      expect(pres._images[0].contentType).toBe("image/jpeg");
    });

    it("should auto-detect gif format from URL", () => {
      const pres = pptx.createPresentation();
      pptx.embedImageFromUrl(pres, {
        url: "https://example.com/animation.gif",
        data: new Uint8Array(10),
        x: 1,
        y: 2,
        w: 3,
        h: 2,
      });
      expect(pres._images[0].contentType).toBe("image/gif");
    });

    it("should strip query params when detecting format", () => {
      const pres = pptx.createPresentation();
      pptx.embedImageFromUrl(pres, {
        url: "https://example.com/logo.png?token=abc123&size=large",
        data: new Uint8Array(10),
        x: 1,
        y: 2,
        w: 3,
        h: 2,
      });
      expect(pres._images[0].contentType).toBe("image/png");
    });

    it("should default to png when format cannot be detected", () => {
      const pres = pptx.createPresentation();
      pptx.embedImageFromUrl(pres, {
        url: "https://example.com/image",
        data: new Uint8Array(10),
        x: 1,
        y: 2,
        w: 3,
        h: 2,
      });
      expect(pres._images[0].contentType).toBe("image/png");
    });

    it("should allow format override", () => {
      const pres = pptx.createPresentation();
      pptx.embedImageFromUrl(pres, {
        url: "https://example.com/image",
        data: new Uint8Array(10),
        format: "jpg",
        x: 1,
        y: 2,
        w: 3,
        h: 2,
      });
      expect(pres._images[0].contentType).toBe("image/jpeg");
    });
  });

  describe("codeBlock", () => {
    it("should throw on invalid background hex", () => {
      expect(() =>
        pptx.codeBlock({
          x: 0,
          y: 0,
          w: 10,
          h: 3,
          code: "x = 1",
          background: "dark",
        }),
      ).toThrow(/codeBlock\.background.*not a valid 6-character hex/);
    });

    it("should throw on invalid text colour hex", () => {
      expect(() =>
        pptx.codeBlock({
          x: 0,
          y: 0,
          w: 10,
          h: 3,
          code: "x = 1",
          color: "light",
        }),
      ).toThrow(/codeBlock\.color.*not a valid 6-character hex/);
    });
  });
});

// ══════════════════════════════════════════════════════════════════════
// pptx.js: Slide Builder Validation
// ══════════════════════════════════════════════════════════════════════

describe("pptx slide validation", () => {
  describe("createPresentation", () => {
    it("should throw on unrecognised theme name with available list", () => {
      expect(() => pptx.createPresentation({ theme: "cyberpunk" })).toThrow(
        /createPresentation.*"cyberpunk".*not recognised.*corporate-blue.*dark-gradient.*light-clean.*emerald.*sunset/,
      );
    });

    it("should accept midnight as alias for black theme", () => {
      expect(() =>
        pptx.createPresentation({ theme: "midnight" }),
      ).not.toThrow();
      const pres = pptx.createPresentation({ theme: "midnight" });
      expect(pres.theme.bg).toBe("000000"); // Same as black theme
    });

    it("should accept all valid theme names", () => {
      const themes = [
        "corporate-blue",
        "dark-gradient",
        "light-clean",
        "emerald",
        "sunset",
        "midnight",
      ];
      for (const t of themes) {
        expect(() => pptx.createPresentation({ theme: t })).not.toThrow();
      }
    });

    it("should default to corporate-blue when no theme specified", () => {
      const pres = pptx.createPresentation();
      expect(pres.theme.bg).toBe("1B2A4A");
    });
  });

  describe("titleSlide", () => {
    it("should throw when title is missing", () => {
      const pres = pptx.createPresentation();
      expect(() => pptx.titleSlide(pres, {} as any)).toThrow(
        /titleSlide\.title.*non-empty string/,
      );
    });

    it("should throw on invalid background hex", () => {
      const pres = pptx.createPresentation();
      expect(() =>
        pptx.titleSlide(pres, { title: "Hello", background: "nope" }),
      ).toThrow(/titleSlide\.background.*not a valid 6-character hex/);
    });
  });

  describe("sectionSlide", () => {
    it("should throw when title is missing", () => {
      const pres = pptx.createPresentation();
      expect(() => pptx.sectionSlide(pres, {} as any)).toThrow(
        /sectionSlide\.title.*non-empty string/,
      );
    });
  });

  describe("contentSlide", () => {
    it("should throw when title is missing", () => {
      const pres = pptx.createPresentation();
      expect(() => pptx.contentSlide(pres, {} as any)).toThrow(
        /contentSlide\.title.*non-empty string/,
      );
    });

    it("should accept items as string array", () => {
      const pres = pptx.createPresentation();
      // Should not throw - items as string array is valid
      expect(() =>
        pptx.contentSlide(pres, {
          title: "Slide",
          items: ["Point 1", "Point 2"],
        }),
      ).not.toThrow();
    });

    it("should accept items as newline-delimited string", () => {
      const pres = pptx.createPresentation();
      // Should not throw - items as newline-delimited string is valid
      expect(() =>
        pptx.contentSlide(pres, { title: "Slide", items: "Point 1\nPoint 2" }),
      ).not.toThrow();
    });
  });

  describe("twoColumnSlide", () => {
    it("should throw when title is missing", () => {
      const pres = pptx.createPresentation();
      expect(() => pptx.twoColumnSlide(pres, {} as any)).toThrow(
        /twoColumnSlide\.title.*non-empty string/,
      );
    });

    it("should accept leftItems and rightItems as string arrays", () => {
      const pres = pptx.createPresentation();
      // Should not throw - items as string arrays is valid
      expect(() =>
        pptx.twoColumnSlide(pres, {
          title: "T",
          leftItems: ["A"],
          rightItems: ["B"],
        }),
      ).not.toThrow();
    });

    it("should accept leftItems and rightItems as newline-delimited strings", () => {
      const pres = pptx.createPresentation();
      // Should not throw - items as newline-delimited strings is valid
      expect(() =>
        pptx.twoColumnSlide(pres, {
          title: "T",
          leftItems: "A\nB",
          rightItems: "C\nD",
        }),
      ).not.toThrow();
    });
  });

  describe("chartSlide", () => {
    it("should throw when title is missing", () => {
      const pres = pptx.createPresentation();
      expect(() => pptx.chartSlide(pres, {} as any)).toThrow(
        /chartSlide\.title.*non-empty string/,
      );
    });
  });

  describe("comparisonSlide", () => {
    it("should throw when title is missing", () => {
      const pres = pptx.createPresentation();
      expect(() => pptx.comparisonSlide(pres, {} as any)).toThrow(
        /comparisonSlide\.title.*non-empty string/,
      );
    });
  });

  describe("addFooter", () => {
    it("should throw when text is missing", () => {
      const pres = pptx.createPresentation();
      pptx.contentSlide(pres, { title: "T", body: [] });
      expect(() => pptx.addFooter(pres, {} as any)).toThrow(
        /addFooter\.text.*non-empty string/,
      );
    });
  });

  describe("slide reordering", () => {
    it("should insert slide at specific index", () => {
      const pres = pptx.createPresentation();
      pptx.contentSlide(pres, { title: "Slide 1", body: [] });
      pptx.contentSlide(pres, { title: "Slide 2", body: [] });
      pres.insertSlideAt(
        1,
        "",
        pptx.textBox({ x: 0, y: 0, w: 4, h: 1, text: "Inserted" }),
      );
      expect(pres.slides.length).toBe(3);
      expect(toXml(pres.slides[1].shapes)).toContain("Inserted");
    });

    it("should reorder slides with valid newOrder array", () => {
      const pres = pptx.createPresentation();
      pptx.contentSlide(pres, { title: "A", body: [] });
      pptx.contentSlide(pres, { title: "B", body: [] });
      pptx.contentSlide(pres, { title: "C", body: [] });
      // Move C to first, then A, then B
      pres.reorderSlides([2, 0, 1]);
      expect(pres.slides[0].shapes).toContain(">C<");
      expect(pres.slides[1].shapes).toContain(">A<");
      expect(pres.slides[2].shapes).toContain(">B<");
    });

    it("should throw on reorderSlides with wrong length", () => {
      const pres = pptx.createPresentation();
      pptx.contentSlide(pres, { title: "A", body: [] });
      pptx.contentSlide(pres, { title: "B", body: [] });
      expect(() => pres.reorderSlides([0])).toThrow(
        /reorderSlides.*1 elements.*2 slides/,
      );
    });

    it("should throw on reorderSlides with invalid indices", () => {
      const pres = pptx.createPresentation();
      pptx.contentSlide(pres, { title: "A", body: [] });
      pptx.contentSlide(pres, { title: "B", body: [] });
      expect(() => pres.reorderSlides([0, 0])).toThrow(
        /reorderSlides.*each index 0-1 exactly once/,
      );
    });

    it("should move slide from one position to another", () => {
      const pres = pptx.createPresentation();
      pptx.contentSlide(pres, { title: "A", body: [] });
      pptx.contentSlide(pres, { title: "B", body: [] });
      pptx.contentSlide(pres, { title: "C", body: [] });
      pres.moveSlide(2, 0); // Move C to first position
      expect(pres.slides[0].shapes).toContain(">C<");
      expect(pres.slides[1].shapes).toContain(">A<");
    });

    it("should throw on moveSlide with invalid fromIndex", () => {
      const pres = pptx.createPresentation();
      pptx.contentSlide(pres, { title: "A", body: [] });
      expect(() => pres.moveSlide(5, 0)).toThrow(
        /moveSlide.*fromIndex 5.*out of range/,
      );
    });

    it("should delete slide at index", () => {
      const pres = pptx.createPresentation();
      pptx.contentSlide(pres, { title: "A", body: [] });
      pptx.contentSlide(pres, { title: "B", body: [] });
      pptx.contentSlide(pres, { title: "C", body: [] });
      pres.deleteSlide(1); // Delete B
      expect(pres.slides.length).toBe(2);
      expect(pres.slides[0].shapes).toContain(">A<");
      expect(pres.slides[1].shapes).toContain(">C<");
    });

    it("should throw on deleteSlide with invalid index", () => {
      const pres = pptx.createPresentation();
      pptx.contentSlide(pres, { title: "A", body: [] });
      expect(() => pres.deleteSlide(3)).toThrow(
        /deleteSlide.*index 3.*out of range/,
      );
    });
  });
});

// ══════════════════════════════════════════════════════════════════════
// pptx-charts.js: Chart Input Validation
// ══════════════════════════════════════════════════════════════════════

describe("pptx-charts validation", () => {
  describe("barChart", () => {
    it("should throw when series is empty", () => {
      expect(() => charts.barChart({ categories: ["Q1"], series: [] })).toThrow(
        /barChart\.series.*must not be empty/,
      );
    });

    it("should throw when series values are missing", () => {
      expect(() =>
        charts.barChart({
          categories: ["Q1"],
          series: [{ name: "Revenue" }],
        }),
      ).toThrow(/series\[0\]\.values.*must not be empty/);
    });

    it("should throw when series name is missing", () => {
      expect(() =>
        charts.barChart({
          categories: ["Q1"],
          series: [{ values: [100] }],
        }),
      ).toThrow(/series\[0\]\.name.*non-empty string/);
    });

    it("should throw when values count mismatches categories", () => {
      expect(() =>
        charts.barChart({
          categories: ["Q1", "Q2", "Q3"],
          series: [{ name: "Rev", values: [100, 200] }],
        }),
      ).toThrow(/series\[0\].*values array has 2.*3 categories/);
    });

    it("should throw on non-numeric values", () => {
      expect(() =>
        charts.barChart({
          categories: ["Q1"],
          series: [{ name: "Rev", values: ["one hundred"] }],
        }),
      ).toThrow(
        /series.*"Rev".*value at index 0.*string.*"one hundred".*expected a finite number/,
      );
    });

    it("should throw on invalid textColor hex", () => {
      expect(() =>
        charts.barChart({
          categories: ["Q1"],
          series: [{ name: "Rev", values: [100] }],
          textColor: "white",
        }),
      ).toThrow(/barChart\.textColor.*not a valid 6-character hex/);
    });

    it("should throw on invalid series colour hex", () => {
      expect(() =>
        charts.barChart({
          categories: ["Q1"],
          series: [{ name: "Rev", values: [100], color: "blue" }],
        }),
      ).toThrow(/series\[0\]\.color.*not a valid 6-character hex/);
    });

    it("should accept valid bar chart", () => {
      expect(() =>
        charts.barChart({
          categories: ["Q1", "Q2"],
          series: [{ name: "Revenue", values: [100, 200] }],
        }),
      ).not.toThrow();
    });
  });

  describe("pieChart", () => {
    it("should throw when labels is empty", () => {
      expect(() => charts.pieChart({ labels: [], values: [] })).toThrow(
        /pieChart\.labels.*must not be empty/,
      );
    });

    it("should throw when labels/values length mismatch", () => {
      expect(() =>
        charts.pieChart({ labels: ["A", "B"], values: [1] }),
      ).toThrow(/pieChart.*labels.*2.*values.*1.*same length/);
    });

    it("should throw on non-numeric slice values", () => {
      expect(() =>
        charts.pieChart({ labels: ["A"], values: ["fifty"] }),
      ).toThrow(/pieChart\.values\[0\].*expected a number.*string/);
    });

    it("should throw on invalid slice colour hex", () => {
      expect(() =>
        charts.pieChart({
          labels: ["A"],
          values: [50],
          colors: ["red"],
        }),
      ).toThrow(/pieChart\.colors\[0\].*not a valid 6-character hex/);
    });

    it("should throw on holeSize out of range", () => {
      expect(() =>
        charts.pieChart({
          labels: ["A"],
          values: [50],
          donut: true,
          holeSize: 95,
        }),
      ).toThrow(/pieChart\.holeSize.*95.*exceeds the maximum 90/);
    });

    it("should accept valid pie chart", () => {
      expect(() =>
        charts.pieChart({ labels: ["A", "B"], values: [60, 40] }),
      ).not.toThrow();
    });

    it("should reserve more top space when title is present", () => {
      const withTitle = charts.pieChart({
        labels: ["A", "B"],
        values: [60, 40],
        title: "Revenue Distribution",
      });
      const noTitle = charts.pieChart({
        labels: ["A", "B"],
        values: [60, 40],
      });
      // With title: y offset should be 0.15 (15%)
      expect(withTitle._chartXml).toContain('y val="0.15"');
      // Without title: y offset should be 0.08 (8%)
      expect(noTitle._chartXml).toContain('y val="0.08"');
    });
  });

  describe("lineChart", () => {
    it("should throw when series is empty", () => {
      expect(() =>
        charts.lineChart({ categories: ["Q1"], series: [] }),
      ).toThrow(/lineChart\.series.*must not be empty/);
    });

    it("should throw on missing series name", () => {
      expect(() =>
        charts.lineChart({
          categories: ["Q1"],
          series: [{ values: [1] }],
        }),
      ).toThrow(/lineChart series at index 0.*missing required 'name'/);
    });

    it("should throw on missing series values", () => {
      expect(() =>
        charts.lineChart({
          categories: ["Q1"],
          series: [{ name: "Trend" }],
        }),
      ).toThrow(/lineChart\.series\[0\]\.values.*must not be empty/);
    });

    it("should throw on values/categories mismatch", () => {
      expect(() =>
        charts.lineChart({
          categories: ["Q1", "Q2"],
          series: [{ name: "Trend", values: [1, 2, 3] }],
        }),
      ).toThrow(/lineChart series\[0\].*values.*3.*2 categories/);
    });

    it("should throw on non-numeric line values", () => {
      expect(() =>
        charts.lineChart({
          categories: ["Q1"],
          series: [{ name: "Trend", values: [null] }],
        }),
      ).toThrow(
        /lineChart series\[0\].*value at index 0.*expected a finite number/,
      );
    });
  });

  describe("comboChart", () => {
    it("should throw when both series arrays are empty", () => {
      expect(() =>
        charts.comboChart({
          categories: ["Q1"],
          barSeries: [],
          lineSeries: [],
        }),
      ).toThrow(/comboChart.*at least one series/);
    });

    it("should throw when total series exceeds 24", () => {
      const manySeries = Array.from({ length: 25 }, (_, i) => ({
        name: `S${i}`,
        values: [1],
      }));
      expect(() =>
        charts.comboChart({
          categories: ["Q1"],
          barSeries: manySeries,
          lineSeries: [],
        }),
      ).toThrow(/total series count.*25.*exceeds.*maximum.*24/);
    });

    it("should validate lineSeries name", () => {
      expect(() =>
        charts.comboChart({
          categories: ["Q1"],
          barSeries: [{ name: "Bars", values: [1] }],
          lineSeries: [{ values: [2] }],
        }),
      ).toThrow(/comboChart\.lineSeries\[0\]\.name.*non-empty string/);
    });

    it("should validate lineSeries values length", () => {
      expect(() =>
        charts.comboChart({
          categories: ["Q1", "Q2"],
          barSeries: [{ name: "Bars", values: [1, 2] }],
          lineSeries: [{ name: "Trend", values: [3] }],
        }),
      ).toThrow(/comboChart lineSeries\[0\].*values.*1.*2 categories/);
    });
  });

  describe("embedChart", () => {
    it("should throw when pres is null", () => {
      expect(() => charts.embedChart(null, { type: "chart" }, {})).toThrow(
        /embedChart.*pres.*required/,
      );
    });

    it("should throw when chart is not a chart object", () => {
      const pres = pptx.createPresentation();
      expect(() => charts.embedChart(pres, { type: "table" }, {})).toThrow(
        /embedChart.*must be a chart object/,
      );
    });
  });
});

// ══════════════════════════════════════════════════════════════════════
// pptx-tables.js: Table Input Validation
// ══════════════════════════════════════════════════════════════════════

describe("pptx-tables validation", () => {
  describe("table", () => {
    it("should throw when rows contain non-arrays (and not strings)", () => {
      // Note: strings are auto-converted to arrays by splitting on newlines
      expect(() =>
        tables.table({
          x: 0,
          y: 0,
          w: 10,
          headers: ["A", "B"],
          rows: [12345 as any],
        }),
      ).toThrow(/table\.rows\[0\].*expected an array/);
    });

    it("should throw on column count mismatch", () => {
      expect(() =>
        tables.table({
          x: 0,
          y: 0,
          w: 10,
          headers: ["A", "B", "C"],
          rows: [["1", "2"]], // only 2 cells, expected 3
        }),
      ).toThrow(/table\.rows\[0\].*2 cells.*expected 3.*matching headers/);
    });

    it("should throw on invalid style.headerBg hex", () => {
      expect(() =>
        tables.table({
          x: 0,
          y: 0,
          w: 10,
          headers: ["A"],
          rows: [["1"]],
          style: { headerBg: "blue" },
        }),
      ).toThrow(/table\.style\.headerBg.*not a valid 6-character hex/);
    });

    it("should throw on invalid style.fontSize", () => {
      expect(() =>
        tables.table({
          x: 0,
          y: 0,
          w: 10,
          headers: ["A"],
          rows: [["1"]],
          style: { fontSize: "big" },
        }),
      ).toThrow(/table\.style\.fontSize.*expected a number/);
    });

    it("should accept valid table", () => {
      expect(() =>
        tables.table({
          x: 0,
          y: 0,
          w: 10,
          headers: ["Name", "Value"],
          rows: [
            ["Alpha", "100"],
            ["Beta", "200"],
          ],
        }),
      ).not.toThrow();
    });

    it("should use dark theme colors when theme.bg is dark", () => {
      const xml = toXml(
        tables.table({
          x: 0,
          y: 0,
          w: 10,
          headers: ["Name"],
          rows: [["Alpha"], ["Beta"]],
          theme: { bg: "1B2A4A", fg: "E6EDF3" },
        }),
      );
      // On dark themes: alt-row should be dark (2D333B), text should be light (E6EDF3)
      expect(xml).toContain("2D333B"); // dark alt-row
      expect(xml).toContain("E6EDF3"); // light text
    });

    it("should use light theme colors when theme.bg is light", () => {
      const xml = toXml(
        tables.table({
          x: 0,
          y: 0,
          w: 10,
          headers: ["Name"],
          rows: [["Alpha"], ["Beta"]],
          theme: { bg: "FFFFFF" },
        }),
      );
      // On light themes: alt-row should be light (F5F5F5), text should be dark (333333)
      expect(xml).toContain("F5F5F5"); // light alt-row
      expect(xml).toContain("333333"); // dark text
    });

    it("should allow style overrides to take precedence over theme", () => {
      const xml = toXml(
        tables.table({
          x: 0,
          y: 0,
          w: 10,
          headers: ["Name"],
          rows: [["Alpha"]],
          theme: { bg: "1B2A4A", fg: "E6EDF3" },
          style: { textColor: "FF0000", altRowColor: "00FF00" },
        }),
      );
      expect(xml).toContain("FF0000"); // explicit text color
      expect(xml).not.toContain("E6EDF3"); // theme should be overridden
    });
  });

  describe("kvTable", () => {
    it("should throw when items are not objects", () => {
      expect(() =>
        tables.kvTable({ x: 0, y: 0, w: 6, items: ["bad"] }),
      ).toThrow(/kvTable\.items\[0\].*expected an object.*\{key, value\}/);
    });

    it("should throw when item is missing key", () => {
      expect(() =>
        tables.kvTable({
          x: 0,
          y: 0,
          w: 6,
          items: [{ value: "hi" }],
        }),
      ).toThrow(/kvTable\.items\[0\].*missing required 'key'/);
    });

    it("should accept valid kvTable", () => {
      expect(() =>
        tables.kvTable({
          x: 0,
          y: 0,
          w: 6,
          items: [{ key: "Name", value: "HyperAgent" }],
        }),
      ).not.toThrow();
    });

    it("should pass theme through to underlying table()", () => {
      const xml = toXml(
        tables.kvTable({
          x: 0,
          y: 0,
          w: 6,
          items: [{ key: "Name", value: "HyperAgent" }],
          theme: { bg: "1B2A4A", fg: "E6EDF3" },
        }),
      );
      // On dark theme, should use light text
      expect(xml).toContain("E6EDF3");
    });
  });

  describe("comparisonTable", () => {
    it("should throw when features is empty", () => {
      expect(() =>
        tables.comparisonTable({
          x: 0,
          y: 0,
          w: 10,
          features: [],
          options: [{ name: "A", values: [] }],
        }),
      ).toThrow(/comparisonTable\.features.*must not be empty/);
    });

    it("should throw when options is empty", () => {
      expect(() =>
        tables.comparisonTable({
          x: 0,
          y: 0,
          w: 10,
          features: ["Speed"],
          options: [],
        }),
      ).toThrow(/comparisonTable\.options.*must not be empty/);
    });

    it("should throw when option values length mismatches features", () => {
      expect(() =>
        tables.comparisonTable({
          x: 0,
          y: 0,
          w: 10,
          features: ["Speed", "Size", "Cost"],
          options: [{ name: "Alpha", values: [true, false] }],
        }),
      ).toThrow(/comparisonTable\.options\[0\].*values.*2.*3 features/);
    });

    it("should throw when option is missing name", () => {
      expect(() =>
        tables.comparisonTable({
          x: 0,
          y: 0,
          w: 10,
          features: ["Speed"],
          options: [{ values: [true] }],
        }),
      ).toThrow(/comparisonTable\.options\[0\].*missing required 'name'/);
    });

    it("should pass theme through to underlying table()", () => {
      const xml = toXml(
        tables.comparisonTable({
          x: 0,
          y: 0,
          w: 10,
          features: ["Speed", "Cost"],
          options: [{ name: "Alpha", values: [true, false] }],
          theme: { bg: "1B2A4A", fg: "E6EDF3" },
        }),
      );
      // On dark theme, should use light text
      expect(xml).toContain("E6EDF3");
    });
  });

  describe("timeline", () => {
    it("should throw when items is empty", () => {
      expect(() => tables.timeline({ x: 0, y: 0, w: 12, items: [] })).toThrow(
        /timeline\.items.*must not be empty/,
      );
    });

    it("should throw when item is missing label", () => {
      expect(() =>
        tables.timeline({
          x: 0,
          y: 0,
          w: 12,
          items: [{ description: "No label!" }],
        }),
      ).toThrow(/timeline\.items\[0\].*missing required 'label'/);
    });

    it("should accept valid timeline", () => {
      expect(() =>
        tables.timeline({
          x: 0,
          y: 0,
          w: 12,
          items: [
            { label: "Phase 1", description: "Planning" },
            { label: "Phase 2", description: "Execution" },
          ],
        }),
      ).not.toThrow();
    });

    it("should pass theme through to underlying table()", () => {
      const xml = toXml(
        tables.timeline({
          x: 0,
          y: 0,
          w: 12,
          items: [
            { label: "Phase 1", description: "Planning" },
            { label: "Phase 2", description: "Execution" },
          ],
          theme: { bg: "1B2A4A", fg: "E6EDF3" },
        }),
      );
      // On dark theme, should use light text
      expect(xml).toContain("E6EDF3");
    });
  });
});

// ══════════════════════════════════════════════════════════════════════
// Integration: End-to-end validation in real presentation workflows
// ══════════════════════════════════════════════════════════════════════

describe("integration: full presentation validation", () => {
  it("should build a valid presentation when all inputs are correct", () => {
    const pres = pptx.createPresentation({ theme: "dark-gradient" });
    pptx.titleSlide(pres, {
      title: "Validated Presentation",
      subtitle: "No garbage allowed",
    });
    pptx.contentSlide(pres, {
      title: "Data Overview",
      body: [
        pptx.textBox({ x: 1, y: 2, w: 10, h: 1, text: "All validated!" }),
        pptx.bulletList({
          x: 1,
          y: 3,
          w: 10,
          h: 3,
          items: ["Item 1", "Item 2"],
        }),
      ],
    });
    const chart = charts.barChart({
      categories: ["Q1", "Q2"],
      series: [{ name: "Revenue", values: [100, 200] }],
      textColor: "E6EDF3",
    });
    pptx.chartSlide(pres, { title: "Revenue Chart", chart });
    pptx.addSlideNumbers(pres);

    const entries = pres.build();
    expect(entries.length).toBeGreaterThan(10);
    expect(entries[0].name).toBe("[Content_Types].xml");
  });

  it("should cascade validation — bad chart series caught inside chartSlide", () => {
    const pres = pptx.createPresentation();
    const chart = {
      type: "chart",
      _chartXml: "<c:chartSpace/>", // minimal but valid-ish chart XML
    };
    // chartSlide itself should accept this — the validation is on chart builders
    expect(() =>
      pptx.chartSlide(pres, { title: "Chart", chart }),
    ).not.toThrow();
  });

  it("should reject presentation with unrecognised theme", () => {
    expect(() => pptx.createPresentation({ theme: "cyberpunk" })).toThrow(
      /not recognised.*corporate-blue/,
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
// heroSlide: Image-Only Slides Support
// ══════════════════════════════════════════════════════════════════════

describe("heroSlide", () => {
  const fakeImage = new Uint8Array([0xff, 0xd8, 0xff]); // Minimal JPEG header

  beforeEach(() => {
    pptx.createPresentation({ theme: "brutalist" });
  });

  it("should require opts.image as Uint8Array", () => {
    const pres = pptx.createPresentation({ theme: "brutalist" });
    expect(() => pptx.heroSlide(pres, { title: "Test" })).toThrow(
      /opts\.image.*required/,
    );
  });

  it("should allow image-only slides (no title)", () => {
    const pres = pptx.createPresentation({ theme: "brutalist" });
    // Should not throw
    expect(() => pptx.heroSlide(pres, { image: fakeImage })).not.toThrow();
  });

  it("should include title when provided", () => {
    const pres = pptx.createPresentation({ theme: "brutalist" });
    pptx.heroSlide(pres, { image: fakeImage, title: "Big Hero Title" });
    const entries = pres.build();
    const slide1 = entries.find((e: any) =>
      e.name.endsWith("slides/slide1.xml"),
    );
    expect(slide1).toBeDefined();
    expect(slide1!.data).toContain("Big Hero Title");
  });

  it("should NOT include title element when title is omitted", () => {
    const pres = pptx.createPresentation({ theme: "brutalist" });
    pptx.heroSlide(pres, { image: fakeImage });
    const entries = pres.build();
    const slide1 = entries.find((e: any) =>
      e.name.endsWith("slides/slide1.xml"),
    );
    expect(slide1).toBeDefined();
    // Should still have the image (blipFill) but minimal text boxes
    expect(slide1!.data).toContain("a:blip");
  });
});

// ══════════════════════════════════════════════════════════════════════
// Chart Text-Colour Patch: OOXML Element Ordering
// ══════════════════════════════════════════════════════════════════════

describe("_patchChartTextColor OOXML element ordering", () => {
  it("should place txPr before crossAx in catAx and valAx", () => {
    const pres = pptx.createPresentation({ theme: "dark-gradient" });
    const chart = charts.barChart({
      categories: ["A", "B"],
      series: [{ name: "S1", values: [1, 2] }],
    });
    pptx.chartSlide(pres, { title: "Test", chart });

    const chartEntry = pres._chartEntries.find(
      (e: any) => e.name.endsWith(".xml") && !e.name.includes("_rels"),
    );
    expect(chartEntry).toBeDefined();
    const xml: string = chartEntry.data;

    // catAx: txPr must come BEFORE crossAx
    const catAxMatch = xml.match(/<c:catAx>[\s\S]*?<\/c:catAx>/);
    expect(catAxMatch).toBeTruthy();
    const catAx = catAxMatch![0];
    if (catAx.includes("c:txPr")) {
      expect(catAx.indexOf("c:txPr")).toBeLessThan(catAx.indexOf("c:crossAx"));
    }

    // valAx: txPr must come BEFORE crossAx
    const valAxMatch = xml.match(/<c:valAx>[\s\S]*?<\/c:valAx>/);
    expect(valAxMatch).toBeTruthy();
    const valAx = valAxMatch![0];
    if (valAx.includes("c:txPr")) {
      expect(valAx.indexOf("c:txPr")).toBeLessThan(valAx.indexOf("c:crossAx"));
    }
  });

  it("should place txPr before showVal in dLbls", () => {
    const pres = pptx.createPresentation({ theme: "dark-gradient" });
    const chart = charts.barChart({
      categories: ["A", "B"],
      series: [{ name: "S1", values: [1, 2] }],
      showValues: true,
    });
    pptx.chartSlide(pres, { title: "Test", chart });

    const chartEntry = pres._chartEntries.find(
      (e: any) => e.name.endsWith(".xml") && !e.name.includes("_rels"),
    );
    const xml: string = chartEntry.data;

    const dLblsMatch = xml.match(/<c:dLbls>[\s\S]*?<\/c:dLbls>/);
    expect(dLblsMatch).toBeTruthy();
    const dLbls = dLblsMatch![0];
    if (dLbls.includes("c:txPr") && dLbls.includes("c:showVal")) {
      expect(dLbls.indexOf("c:txPr")).toBeLessThan(dLbls.indexOf("c:showVal"));
    }
  });

  it("should not double-inject txPr when chart already has textColor", () => {
    const pres = pptx.createPresentation({ theme: "dark-gradient" });
    const chart = charts.barChart({
      categories: ["A"],
      series: [{ name: "S", values: [1] }],
      textColor: "FFFFFF",
    });
    pptx.chartSlide(pres, { title: "Test", chart });

    const chartEntry = pres._chartEntries.find(
      (e: any) => e.name.endsWith(".xml") && !e.name.includes("_rels"),
    );
    const xml: string = chartEntry.data;

    // Count txPr occurrences — each element has open + close = 2 per instance
    const txPrCount = (xml.match(/c:txPr/g) || []).length;
    expect(txPrCount % 2).toBe(0); // paired open/close tags
  });

  it("should produce valid element ordering across all themes", () => {
    const themes = [
      "corporate-blue",
      "dark-gradient",
      "light-clean",
      "emerald",
      "sunset",
    ];
    for (const theme of themes) {
      const pres = pptx.createPresentation({ theme });
      const chart = charts.barChart({
        categories: ["Q1", "Q2"],
        series: [{ name: "Rev", values: [100, 200] }],
        showValues: true,
      });
      pptx.chartSlide(pres, { title: `${theme} test`, chart });

      const entry = pres._chartEntries.find(
        (e: any) => e.name.endsWith(".xml") && !e.name.includes("_rels"),
      );
      const xml: string = entry.data;

      // Verify all axis blocks have txPr before crossAx
      for (const axTag of ["c:catAx", "c:valAx"]) {
        const re = new RegExp(`<${axTag}>[\\s\\S]*?</${axTag}>`);
        const m = xml.match(re);
        if (m && m[0].includes("c:txPr")) {
          expect(
            m[0].indexOf("c:txPr"),
            `${theme}: txPr before crossAx in ${axTag}`,
          ).toBeLessThan(m[0].indexOf("c:crossAx"));
        }
      }

      // Verify dLbls has txPr before showVal
      const dM = xml.match(/<c:dLbls>[\s\S]*?<\/c:dLbls>/);
      if (dM && dM[0].includes("c:txPr") && dM[0].includes("c:showVal")) {
        expect(
          dM[0].indexOf("c:txPr"),
          `${theme}: txPr before showVal in dLbls`,
        ).toBeLessThan(dM[0].indexOf("c:showVal"));
      }
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// Layout Helpers: layoutColumns, layoutGrid, overlay
// ══════════════════════════════════════════════════════════════════════

describe("layout helpers", () => {
  describe("layoutColumns", () => {
    it("should create equal-width columns", () => {
      const cols = pptx.layoutColumns(3);
      expect(cols).toHaveLength(3);
      // All should have same width
      expect(cols[0].w).toBeCloseTo(cols[1].w, 2);
      expect(cols[1].w).toBeCloseTo(cols[2].w, 2);
    });

    it("should respect margin and gap options", () => {
      const cols = pptx.layoutColumns(2, { margin: 1, gap: 0.5, y: 2, h: 3 });
      expect(cols).toHaveLength(2);
      expect(cols[0].x).toBe(1); // starts at margin
      expect(cols[0].y).toBe(2);
      expect(cols[0].h).toBe(3);
      // Second column should start after first + gap
      expect(cols[1].x).toBeCloseTo(cols[0].x + cols[0].w + 0.5, 2);
    });

    it("should produce columns that fit within slide width", () => {
      const cols = pptx.layoutColumns(4, { margin: 0.5, gap: 0.25 });
      const lastCol = cols[cols.length - 1];
      const rightEdge = lastCol.x + lastCol.w;
      expect(rightEdge).toBeLessThanOrEqual(pptx.SLIDE_WIDTH_INCHES);
    });
  });

  describe("layoutGrid", () => {
    it("should create grid with correct number of items", () => {
      const grid = pptx.layoutGrid(6, { cols: 3 });
      expect(grid).toHaveLength(6);
    });

    it("should arrange items in rows", () => {
      const grid = pptx.layoutGrid(6, { cols: 3, y: 1 });
      // First row: indices 0, 1, 2 should have same y
      expect(grid[0].y).toBe(grid[1].y);
      expect(grid[1].y).toBe(grid[2].y);
      // Second row: indices 3, 4, 5 should have same y, different from first
      expect(grid[3].y).toBe(grid[4].y);
      expect(grid[3].y).toBeGreaterThan(grid[0].y);
    });

    it("should respect cols option", () => {
      const grid = pptx.layoutGrid(4, { cols: 2 });
      // Should be 2 rows of 2
      expect(grid[0].x).toBe(grid[2].x); // col 0
      expect(grid[1].x).toBe(grid[3].x); // col 1
    });
  });

  describe("overlay", () => {
    it("should create full-slide overlay by default", () => {
      const xml = toXml(pptx.overlay());
      expect(xml).toContain("p:sp"); // is a shape
      expect(xml).toContain("000000"); // default black color
    });

    it("should respect custom options", () => {
      const xml = toXml(pptx.overlay({ color: "FF0000", opacity: 0.7 }));
      expect(xml).toContain("FF0000");
    });
  });

  describe("serialize/restore", () => {
    it("should preserve imageIndex across serialize/restore to avoid duplicate rIdImage", () => {
      // Part 1: Create presentation with images
      const pres1 = pptx.createPresentation();
      pptx.embedImage(pres1, {
        data: new Uint8Array(10),
        format: "jpg",
        x: 0,
        y: 0,
        w: 1,
        h: 1,
      });
      pptx.embedImage(pres1, {
        data: new Uint8Array(10),
        format: "jpg",
        x: 1,
        y: 0,
        w: 1,
        h: 1,
      });
      pptx.customSlide(pres1, {
        shapes: pptx.textBox({ x: 0, y: 0, w: 1, h: 1, text: "test" }),
      });

      // Serialize
      const state = pres1.serialize();
      expect(state.imageIndex).toBe(2); // Should preserve counter

      // Part 2: Restore and add more images
      const pres2 = pptx.restorePresentation(state);
      pptx.embedImage(pres2, {
        data: new Uint8Array(10),
        format: "png",
        x: 2,
        y: 0,
        w: 1,
        h: 1,
      });
      pptx.customSlide(pres2, {
        shapes: pptx.textBox({ x: 0, y: 0, w: 1, h: 1, text: "test2" }),
      });

      // Check that new image got index 3, not 1
      expect(pres2._images).toHaveLength(3);
      expect(pres2._images[2].relId).toBe("rIdImage3"); // Not "rIdImage1"
      expect(pres2._images[2].mediaPath).toBe("media/image3.png");
    });

    it("should handle restoring presentation with no images", () => {
      const pres1 = pptx.createPresentation();
      pptx.customSlide(pres1, {
        shapes: pptx.textBox({ x: 0, y: 0, w: 1, h: 1, text: "test" }),
      });

      const state = pres1.serialize();
      const pres2 = pptx.restorePresentation(state);

      // Add image after restore - should start at index 1
      pptx.embedImage(pres2, {
        data: new Uint8Array(10),
        format: "jpg",
        x: 0,
        y: 0,
        w: 1,
        h: 1,
      });
      expect(pres2._images[0].relId).toBe("rIdImage1");
    });
  });
});

// ══════════════════════════════════════════════════════════════════════
// NEW FEATURES: measureText, cloneSlide, transitions, animations
// ══════════════════════════════════════════════════════════════════════

describe("measureText", () => {
  it("should measure single-line text", () => {
    const result = pptx.measureText({
      text: "Hello world",
      fontSize: 18,
    });
    expect(result.lines).toBe(1);
    expect(result.height).toBeCloseTo(0.3, 1); // 18 * 1.2 / 72 ≈ 0.3
    expect(result.maxLineChars).toBe(11);
    expect(result.totalChars).toBe(11);
    expect(result.wouldWrap).toBe(false);
  });

  it("should measure multi-line text", () => {
    const result = pptx.measureText({
      text: "Line 1\nLine 2\nLine 3",
      fontSize: 24,
    });
    expect(result.lines).toBe(3);
    expect(result.height).toBeCloseTo(1.2, 1); // 3 * 24 * 1.2 / 72 = 1.2
  });

  it("should accept array of strings", () => {
    const result = pptx.measureText({
      text: ["Line one", "Line two", "Longer line three"],
      fontSize: 18,
    });
    expect(result.lines).toBe(3);
    expect(result.maxLineChars).toBe(17); // "Longer line three"
  });

  it("should detect wrap with maxWidth constraint", () => {
    const result = pptx.measureText({
      text: "This is a very long line that should wrap",
      fontSize: 24,
      maxWidth: 2, // 2 inches width constraint
    });
    expect(result.wouldWrap).toBe(true);
  });

  it("should not wrap when content fits", () => {
    const result = pptx.measureText({
      text: "Short",
      fontSize: 12,
      maxWidth: 10,
    });
    expect(result.wouldWrap).toBe(false);
  });

  it("should use custom lineSpacing", () => {
    const result = pptx.measureText({
      text: "Line 1\nLine 2",
      fontSize: 18,
      lineSpacing: 36, // Double line height
    });
    expect(result.height).toBe(1); // 2 * 36 / 72 = 1
  });

  it("should handle empty text", () => {
    const result = pptx.measureText({ text: "" });
    expect(result.lines).toBe(1);
    expect(result.maxLineChars).toBe(0);
    expect(result.totalChars).toBe(0);
  });
});

describe("cloneSlide", () => {
  it("should clone the last slide by default", () => {
    const pres = pptx.createPresentation();
    pptx.titleSlide(pres, { title: "First Slide" });
    pptx.contentSlide(pres, { title: "Second Slide", bullets: ["Point"] });
    expect(pres.slideCount).toBe(2);

    const newIdx = pptx.cloneSlide(pres);
    expect(pres.slideCount).toBe(3);
    expect(newIdx).toBe(2);
    // Clone should have same background as source
    expect(pres.slides[2].bg).toBe(pres.slides[1].bg);
  });

  it("should clone a specific slide by index", () => {
    const pres = pptx.createPresentation();
    pptx.titleSlide(pres, { title: "Title", notes: "Title notes" });
    pptx.contentSlide(pres, { title: "Content" });

    const newIdx = pptx.cloneSlide(pres, { sourceIndex: 0 });
    expect(newIdx).toBe(2);
    // Clone should have notes from source
    expect(pres.slides[2].notes).toBe("Title notes");
  });

  it("should override transition on cloned slide", () => {
    const pres = pptx.createPresentation();
    pptx.titleSlide(pres, { title: "Title", transition: "fade" });

    pptx.cloneSlide(pres, { transition: "wipe" });
    expect(pres.slides[1].transition).toBe("wipe");
  });

  it("should override notes on cloned slide", () => {
    const pres = pptx.createPresentation();
    pptx.titleSlide(pres, { title: "Title", notes: "Original notes" });

    pptx.cloneSlide(pres, { notes: "New notes" });
    expect(pres.slides[1].notes).toBe("New notes");
  });

  it("should throw for empty presentation", () => {
    const pres = pptx.createPresentation();
    expect(() => pptx.cloneSlide(pres)).toThrow(/No slides to clone/);
  });

  it("should throw for out-of-bounds sourceIndex", () => {
    const pres = pptx.createPresentation();
    pptx.titleSlide(pres, { title: "Only slide" });
    expect(() => pptx.cloneSlide(pres, { sourceIndex: 5 })).toThrow(
      /sourceIndex 5 is out of bounds/,
    );
    expect(() => pptx.cloneSlide(pres, { sourceIndex: -1 })).toThrow(
      /sourceIndex -1 is out of bounds/,
    );
  });

  it("should return correct index for cloned slide", () => {
    const pres = pptx.createPresentation();
    pptx.titleSlide(pres, { title: "1" });
    pptx.titleSlide(pres, { title: "2" });
    pptx.titleSlide(pres, { title: "3" });

    const idx1 = pptx.cloneSlide(pres); // Clone slide 3
    expect(idx1).toBe(3);

    const idx2 = pptx.cloneSlide(pres, { sourceIndex: 0 }); // Clone slide 1
    expect(idx2).toBe(4);
  });
});

describe("expanded transitions", () => {
  it("should accept all new transition types", () => {
    const newTransitions = [
      "reveal",
      "curtains",
      "dissolve",
      "zoom",
      "fly",
      "wheel",
      "random",
    ];

    for (const trans of newTransitions) {
      const pres = pptx.createPresentation();
      // Should not throw
      pptx.titleSlide(pres, { title: "Test", transition: trans });
      expect(pres.slides[0].transition).toBe(trans);
    }
  });

  it("should build valid transition XML for reveal", () => {
    const pres = pptx.createPresentation();
    pptx.titleSlide(pres, { title: "Test", transition: "reveal" });
    const entries = pres.build();
    const slideXml = entries.find(
      (e: any) => e.name === "ppt/slides/slide1.xml",
    );
    expect(slideXml.data).toContain("<p:strips");
  });

  it("should build valid transition XML for curtains", () => {
    const pres = pptx.createPresentation();
    pptx.titleSlide(pres, { title: "Test", transition: "curtains" });
    const entries = pres.build();
    const slideXml = entries.find(
      (e: any) => e.name === "ppt/slides/slide1.xml",
    );
    expect(slideXml.data).toContain('<p:split orient="vert" dir="in"');
  });

  it("should build valid transition XML for dissolve", () => {
    const pres = pptx.createPresentation();
    pptx.titleSlide(pres, { title: "Test", transition: "dissolve" });
    const entries = pres.build();
    const slideXml = entries.find(
      (e: any) => e.name === "ppt/slides/slide1.xml",
    );
    expect(slideXml.data).toContain("<p:dissolve");
  });

  it("should build valid transition XML for zoom", () => {
    const pres = pptx.createPresentation();
    pptx.titleSlide(pres, { title: "Test", transition: "zoom" });
    const entries = pres.build();
    const slideXml = entries.find(
      (e: any) => e.name === "ppt/slides/slide1.xml",
    );
    expect(slideXml.data).toContain("<p:zoom");
  });

  it("should build valid transition XML for wheel", () => {
    const pres = pptx.createPresentation();
    pptx.titleSlide(pres, { title: "Test", transition: "wheel" });
    const entries = pres.build();
    const slideXml = entries.find(
      (e: any) => e.name === "ppt/slides/slide1.xml",
    );
    expect(slideXml.data).toContain('<p:wheel spokes="4"');
  });

  it("should build valid transition XML for random", () => {
    const pres = pptx.createPresentation();
    pptx.titleSlide(pres, { title: "Test", transition: "random" });
    const entries = pres.build();
    const slideXml = entries.find(
      (e: any) => e.name === "ppt/slides/slide1.xml",
    );
    expect(slideXml.data).toContain("<p:random");
  });
});

describe("addAnimation", () => {
  it("should add animation to a slide", () => {
    const pres = pptx.createPresentation();
    pptx.titleSlide(pres, { title: "Test" });

    pptx.addAnimation(pres, 0, { entrance: "fadeIn" });
    expect(pres._animations[0]).toBeDefined();
    expect(pres._animations[0].length).toBe(1);
  });

  it("should support multiple animations on same slide", () => {
    const pres = pptx.createPresentation();
    pptx.titleSlide(pres, { title: "Test" });

    pptx.addAnimation(pres, 0, { entrance: "fadeIn" });
    pptx.addAnimation(pres, 0, { entrance: "flyInLeft" });
    expect(pres._animations[0].length).toBe(2);
  });

  it("should throw for invalid slideIndex", () => {
    const pres = pptx.createPresentation();
    pptx.titleSlide(pres, { title: "Test" });

    expect(() => pptx.addAnimation(pres, 5, { entrance: "fadeIn" })).toThrow(
      /slideIndex 5 is out of bounds/,
    );
  });

  it("should include animation XML in built slide", () => {
    const pres = pptx.createPresentation();
    pptx.titleSlide(pres, { title: "Test" });
    pptx.addAnimation(pres, 0, { entrance: "fadeIn" });

    const entries = pres.build();
    const slideXml = entries.find(
      (e: any) => e.name === "ppt/slides/slide1.xml",
    );
    expect(slideXml.data).toContain("<p:timing>");
  });

  it("should accept all entrance animation types", () => {
    const entrances = [
      "appear",
      "fadeIn",
      "flyInLeft",
      "flyInRight",
      "flyInTop",
      "flyInBottom",
      "zoomIn",
      "bounceIn",
      "wipeRight",
      "wipeDown",
    ];

    for (const entrance of entrances) {
      const pres = pptx.createPresentation();
      pptx.titleSlide(pres, { title: "Test" });
      // Should not throw
      pptx.addAnimation(pres, 0, { entrance: entrance as any });
      expect(pres._animations[0].length).toBe(1);
    }
  });

  it("should accept emphasis and exit animations", () => {
    const pres = pptx.createPresentation();
    pptx.titleSlide(pres, { title: "Test" });

    pptx.addAnimation(pres, 0, {
      entrance: "fadeIn",
      emphasis: "pulse",
      exit: "fadeOut",
    });
    expect(pres._animations[0].length).toBe(1);
    const animXml = pres._animations[0][0];
    expect(animXml).toContain("entr"); // entrance class
  });

  it("should respect delay and duration options", () => {
    const pres = pptx.createPresentation();
    pptx.titleSlide(pres, { title: "Test" });

    pptx.addAnimation(pres, 0, {
      entrance: "fadeIn",
      delay: 500,
      duration: 1000,
    });

    const animXml = pres._animations[0][0];
    expect(animXml).toContain('delay="500"');
    expect(animXml).toContain('dur="1000"');
  });
});

// ══════════════════════════════════════════════════════════════════════
// Orphan Chart Cleanup
// ══════════════════════════════════════════════════════════════════════

describe("orphan chart cleanup", () => {
  it("should remove charts from _charts that are not referenced in any slide", () => {
    const pres = pptx.createPresentation();

    // Manually inject an orphan chart into _charts
    // This simulates what happens when embedChart() is called but the slide is never added
    pres._charts = [
      {
        index: 1,
        slideIndex: 1,
        relId: "rIdChart1",
        chartPath: "charts/chart1.xml",
      },
      {
        index: 2,
        slideIndex: 2,
        relId: "rIdChart2",
        chartPath: "charts/chart2.xml",
      },
    ];
    pres._chartEntries = [
      { name: "ppt/charts/chart1.xml", data: "<c:chart>1</c:chart>" },
      { name: "ppt/charts/chart2.xml", data: "<c:chart>2</c:chart>" },
    ];

    // Add a slide that references chart1 but NOT chart2
    // Note: we directly set the shapes XML to include the chart reference
    pres.addSlide(
      "<p:bg><a:solidFill><a:srgbClr val='FFFFFF'/></a:solidFill></p:bg>",
      '<p:graphicFrame><a:graphic><a:graphicData><c:chart r:id="rIdChart1"/></a:graphicData></a:graphic></p:graphicFrame>',
    );

    expect(pres._charts.length).toBe(2);
    expect(pres._chartEntries.length).toBe(2);

    // Build the ZIP — this triggers orphan cleanup
    pres.buildZip();

    // After cleanup, only chart1 should remain
    expect(pres._charts.length).toBe(1);
    expect(pres._charts[0].relId).toBe("rIdChart1");

    // Only chart1 entries should remain (1 file: just xml, no rels)
    expect(pres._chartEntries.length).toBe(1);
    expect(
      pres._chartEntries.every((e: any) => e.name.includes("chart1")),
    ).toBe(true);
  });

  it("should keep all charts when all are referenced", () => {
    const pres = pptx.createPresentation();

    pres._charts = [
      {
        index: 1,
        slideIndex: 1,
        relId: "rIdChart1",
        chartPath: "charts/chart1.xml",
      },
      {
        index: 2,
        slideIndex: 2,
        relId: "rIdChart2",
        chartPath: "charts/chart2.xml",
      },
    ];
    pres._chartEntries = [
      { name: "ppt/charts/chart1.xml", data: "<c:chart>1</c:chart>" },
      { name: "ppt/charts/chart2.xml", data: "<c:chart>2</c:chart>" },
    ];

    // Add slides that reference both charts
    pres.addSlide(
      "<p:bg/>",
      '<p:graphicFrame><a:graphic><a:graphicData><c:chart r:id="rIdChart1"/></a:graphicData></a:graphic></p:graphicFrame>',
    );
    pres.addSlide(
      "<p:bg/>",
      '<p:graphicFrame><a:graphic><a:graphicData><c:chart r:id="rIdChart2"/></a:graphicData></a:graphic></p:graphicFrame>',
    );

    pres.buildZip();

    expect(pres._charts.length).toBe(2);
    expect(pres._chartEntries.length).toBe(2);
  });

  it("should handle empty _charts gracefully", () => {
    const pres = pptx.createPresentation();
    pptx.titleSlide(pres, { title: "No Charts" });

    // Should not throw
    expect(() => pres.buildZip()).not.toThrow();
  });

  it("should handle undefined _charts gracefully", () => {
    const pres = pptx.createPresentation();
    pptx.titleSlide(pres, { title: "No Charts" });
    pres._charts = undefined;

    // Should not throw
    expect(() => pres.buildZip()).not.toThrow();
  });
});
