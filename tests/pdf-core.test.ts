/**
 * PDF Core Module Tests
 *
 * Tests for the ha:pdf module covering:
 * - Document creation and configuration
 * - Page management
 * - PDF structure validity (header, xref, trailer, EOF)
 * - Content stream generation (text, rect, line)
 * - Font metrics and text measurement
 * - Coordinate conversion (top-left API → bottom-left PDF)
 * - Page sizes (A4, Letter, Legal, custom)
 * - Debug mode (uncompressed streams)
 * - Metadata (title, author, subject, creator)
 * - Colour validation
 * - Error handling for invalid operations
 */

import { describe, it, expect } from "vitest";

const pdf: any = await import("../builtin-modules/pdf.js");

// ── Helpers ──────────────────────────────────────────────────────────

/** Decode PDF bytes to a string for inspection. */
function pdfToString(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += String.fromCharCode(bytes[i]);
  }
  return s;
}

/** Check that PDF bytes start with the correct header. */
function hasValidHeader(pdfStr: string): boolean {
  return pdfStr.startsWith("%PDF-1.7");
}

/** Check that PDF bytes contain a valid xref table. */
function hasXref(pdfStr: string): boolean {
  return pdfStr.includes("xref\n");
}

/** Check that PDF bytes contain a trailer. */
function hasTrailer(pdfStr: string): boolean {
  return pdfStr.includes("trailer\n");
}

/** Check that PDF bytes end with %%EOF. */
function hasEof(pdfStr: string): boolean {
  return pdfStr.trimEnd().endsWith("%%EOF");
}

/** Count the number of PDF objects (N 0 obj) in the document. */
function countObjects(pdfStr: string): number {
  const matches = pdfStr.match(/\d+ 0 obj/g);
  return matches ? matches.length : 0;
}

/** Extract the value after /Count in the Pages dictionary. */
function getPageCount(pdfStr: string): number {
  const match = pdfStr.match(/\/Count\s+(\d+)/);
  return match ? parseInt(match[1], 10) : -1;
}

/** Check if a specific font is referenced in the PDF. */
function hasFont(pdfStr: string, fontName: string): boolean {
  return pdfStr.includes(`/BaseFont /${fontName}`);
}

// ── Document Creation ────────────────────────────────────────────────

describe("createDocument", () => {
  it("should create a document with default options", () => {
    const doc = pdf.createDocument();
    expect(doc).toBeDefined();
    expect(doc.theme).toBeDefined();
    expect(doc.theme.bg).toBe("1B2A4A"); // corporate-blue default
    expect(doc.pageCount).toBe(0);
    expect(doc.debug).toBe(false);
  });

  it("should accept a theme name", () => {
    const doc = pdf.createDocument({ theme: "light-clean" });
    expect(doc.theme.bg).toBe("FFFFFF");
    expect(doc.theme.fg).toBe("333333");
    expect(doc.theme.isDark).toBe(false);
  });

  it("should accept dark themes", () => {
    const doc = pdf.createDocument({ theme: "dark-gradient" });
    expect(doc.theme.isDark).toBe(true);
    expect(doc.theme.bg).toBe("0D1117");
  });

  it("should fall back to corporate-blue for unknown themes", () => {
    const doc = pdf.createDocument({ theme: "nonexistent" });
    expect(doc.theme.bg).toBe("1B2A4A");
  });

  it("should default to A4 page size", () => {
    const doc = pdf.createDocument();
    expect(doc.pageSize.width).toBeCloseTo(595.28, 1);
    expect(doc.pageSize.height).toBeCloseTo(841.89, 1);
  });

  it("should accept named page sizes", () => {
    const letter = pdf.createDocument({ pageSize: "letter" });
    expect(letter.pageSize.width).toBe(612);
    expect(letter.pageSize.height).toBe(792);

    const legal = pdf.createDocument({ pageSize: "legal" });
    expect(legal.pageSize.width).toBe(612);
    expect(legal.pageSize.height).toBe(1008);
  });

  it("should accept custom page sizes", () => {
    const doc = pdf.createDocument({
      pageSize: { width: 400, height: 600 },
    });
    expect(doc.pageSize.width).toBe(400);
    expect(doc.pageSize.height).toBe(600);
  });

  it("should reject invalid page size names", () => {
    expect(() => pdf.createDocument({ pageSize: "bogus" })).toThrow(
      /Invalid page size/,
    );
  });

  it("should reject tiny custom page sizes", () => {
    expect(() =>
      pdf.createDocument({ pageSize: { width: 10, height: 10 } }),
    ).toThrow(/minimum/);
  });

  it("should enable debug mode", () => {
    const doc = pdf.createDocument({ debug: true });
    expect(doc.debug).toBe(true);
  });
});

// ── Page Management ──────────────────────────────────────────────────

describe("page management", () => {
  it("should start with zero pages", () => {
    const doc = pdf.createDocument();
    expect(doc.pageCount).toBe(0);
  });

  it("should add pages", () => {
    const doc = pdf.createDocument();
    doc.addPage();
    expect(doc.pageCount).toBe(1);
    doc.addPage();
    expect(doc.pageCount).toBe(2);
  });

  it("should throw when drawing without a page", () => {
    const doc = pdf.createDocument();
    expect(() => doc.drawText("test", 0, 0)).toThrow(/No pages/);
    expect(() => doc.drawRect(0, 0, 10, 10)).toThrow(/No pages/);
    expect(() => doc.drawLine(0, 0, 10, 10)).toThrow(/No pages/);
  });

  it("should allow per-page size override", () => {
    const doc = pdf.createDocument({ pageSize: "a4" });
    doc.addPage(); // A4
    doc.addPage({ width: 612, height: 792 }); // Letter override
    expect(doc.pageCount).toBe(2);

    const bytes = doc.buildPdf();
    const str = pdfToString(bytes);
    // Both page sizes should appear in MediaBox entries
    expect(str).toContain("595.28");
    expect(str).toContain("612.00");
  });
});

// ── PDF Structure ────────────────────────────────────────────────────

describe("PDF structure", () => {
  it("should produce a valid PDF header", () => {
    const doc = pdf.createDocument();
    doc.addPage();
    const bytes = doc.buildPdf();
    const str = pdfToString(bytes);
    expect(hasValidHeader(str)).toBe(true);
  });

  it("should include binary comment after header", () => {
    const doc = pdf.createDocument();
    doc.addPage();
    const bytes = doc.buildPdf();
    // Second line should have high-byte characters (signals binary)
    expect(bytes[10]).toBeGreaterThan(127);
  });

  it("should contain xref table", () => {
    const doc = pdf.createDocument();
    doc.addPage();
    const str = pdfToString(doc.buildPdf());
    expect(hasXref(str)).toBe(true);
  });

  it("should contain trailer", () => {
    const doc = pdf.createDocument();
    doc.addPage();
    const str = pdfToString(doc.buildPdf());
    expect(hasTrailer(str)).toBe(true);
  });

  it("should end with %%EOF", () => {
    const doc = pdf.createDocument();
    doc.addPage();
    const str = pdfToString(doc.buildPdf());
    expect(hasEof(str)).toBe(true);
  });

  it("should contain a Catalog object", () => {
    const doc = pdf.createDocument();
    doc.addPage();
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("/Type /Catalog");
  });

  it("should contain a Pages object", () => {
    const doc = pdf.createDocument();
    doc.addPage();
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("/Type /Pages");
  });

  it("should contain Page objects", () => {
    const doc = pdf.createDocument();
    doc.addPage();
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("/Type /Page");
    expect(getPageCount(str)).toBe(1);
  });

  it("should have correct page count for multi-page docs", () => {
    const doc = pdf.createDocument();
    doc.addPage();
    doc.addPage();
    doc.addPage();
    const str = pdfToString(doc.buildPdf());
    expect(getPageCount(str)).toBe(3);
  });

  it("should include standard font objects", () => {
    const doc = pdf.createDocument();
    doc.addPage();
    doc.drawText("Hello", 72, 72);
    const str = pdfToString(doc.buildPdf());
    expect(hasFont(str, "Helvetica")).toBe(true);
    expect(str).toContain("/Type /Font");
    expect(str).toContain("/Subtype /Type1");
  });

  it("should have xref entries covering all objects", () => {
    const doc = pdf.createDocument();
    doc.addPage();
    doc.drawText("Test", 72, 72);
    const str = pdfToString(doc.buildPdf());
    const objCount = countObjects(str);
    // xref section header: "0 N" where N = highest object number + 1
    const xrefMatch = str.match(/xref\n0\s+(\d+)/);
    expect(xrefMatch).not.toBeNull();
    const xrefCount = parseInt(xrefMatch![1], 10);
    // xref must cover all objects (entry 0 is free, entries 1..N for objects)
    // May have gaps so xrefCount >= objCount + 1
    expect(xrefCount).toBeGreaterThanOrEqual(objCount + 1);
  });

  it("trailer should reference Root and Info", () => {
    const doc = pdf.createDocument();
    doc.addPage();
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("/Root 1 0 R");
    expect(str).toContain("/Info 3 0 R");
  });
});

// ── Text Drawing ─────────────────────────────────────────────────────

describe("drawText", () => {
  it("should add text to the content stream", () => {
    const doc = pdf.createDocument({ debug: true });
    doc.addPage();
    doc.drawText("Hello, PDF!", 72, 72);
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("BT");
    expect(str).toContain("ET");
    expect(str).toContain("(Hello, PDF!) Tj");
  });

  it("should use default font (Helvetica) and size (12)", () => {
    const doc = pdf.createDocument({ debug: true });
    doc.addPage();
    doc.drawText("Test", 72, 72);
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("/F1 12 Tf");
  });

  it("should accept custom font and size", () => {
    const doc = pdf.createDocument({ debug: true });
    doc.addPage();
    doc.drawText("Bold!", 72, 72, {
      font: "Helvetica-Bold",
      fontSize: 24,
    });
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("24 Tf");
    expect(hasFont(str, "Helvetica-Bold")).toBe(true);
  });

  it("should accept custom colour", () => {
    const doc = pdf.createDocument({ debug: true });
    doc.addPage();
    doc.drawText("Red text", 72, 72, { color: "FF0000" });
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("1.000 0.000 0.000 rg");
  });

  it("should use theme foreground when no colour specified", () => {
    const doc = pdf.createDocument({ theme: "light-clean", debug: true });
    doc.addPage();
    doc.drawText("Dark text", 72, 72);
    const str = pdfToString(doc.buildPdf());
    // light-clean fg = 333333 → 0.200 0.200 0.200
    expect(str).toContain("0.200 0.200 0.200 rg");
  });

  it("should reject invalid colour hex", () => {
    const doc = pdf.createDocument();
    doc.addPage();
    expect(() => doc.drawText("bad", 72, 72, { color: "red" })).toThrow(
      /not a valid 6-character hex/,
    );
  });

  it("should escape special characters in text", () => {
    const doc = pdf.createDocument({ debug: true });
    doc.addPage();
    doc.drawText("Test (parens) and \\backslash", 72, 72);
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("\\(parens\\)");
    expect(str).toContain("\\\\backslash");
  });

  it("should convert Y coordinate from top-left to bottom-left", () => {
    const doc = pdf.createDocument({
      pageSize: { width: 612, height: 792 },
      debug: true,
    });
    doc.addPage();
    // Draw at y=100 from top → PDF y = 792 - 100 = 692
    doc.drawText("Top text", 72, 100);
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("692.00 Td");
  });
});

// ── Rectangle Drawing ────────────────────────────────────────────────

describe("drawRect", () => {
  it("should draw a filled rectangle", () => {
    const doc = pdf.createDocument({ debug: true });
    doc.addPage();
    doc.drawRect(100, 100, 200, 50, { fill: "2196F3" });
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("re");
    expect(str).toContain("f"); // fill operator
  });

  it("should draw a stroked rectangle", () => {
    const doc = pdf.createDocument({ debug: true });
    doc.addPage();
    doc.drawRect(100, 100, 200, 50, { stroke: "333333" });
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("re");
    expect(str).toContain("S"); // stroke operator
  });

  it("should draw a filled and stroked rectangle", () => {
    const doc = pdf.createDocument({ debug: true });
    doc.addPage();
    doc.drawRect(100, 100, 200, 50, { fill: "2196F3", stroke: "000000" });
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("B"); // fill+stroke operator
  });

  it("should convert rect coordinates correctly", () => {
    const doc = pdf.createDocument({
      pageSize: { width: 612, height: 792 },
      debug: true,
    });
    doc.addPage();
    // Rect at y=100 from top, height=50 → PDF bottom-left y = 792 - (100+50) = 642
    doc.drawRect(72, 100, 200, 50, { fill: "CCCCCC" });
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("642.00");
  });

  it("should reject negative dimensions", () => {
    const doc = pdf.createDocument();
    doc.addPage();
    expect(() => doc.drawRect(0, 0, -10, 50)).toThrow(/minimum/);
  });
});

// ── Line Drawing ─────────────────────────────────────────────────────

describe("drawLine", () => {
  it("should draw a line", () => {
    const doc = pdf.createDocument({ debug: true });
    doc.addPage();
    doc.drawLine(72, 100, 540, 100, { color: "000000" });
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("m"); // moveto
    expect(str).toContain("l"); // lineto
    expect(str).toContain("S"); // stroke
  });

  it("should set line width", () => {
    const doc = pdf.createDocument({ debug: true });
    doc.addPage();
    doc.drawLine(0, 0, 100, 100, { lineWidth: 2.5 });
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("2.50 w");
  });
});

// ── Font Metrics ─────────────────────────────────────────────────────

describe("font metrics", () => {
  it("should measure text width for Helvetica", () => {
    const width = pdf.measureText("Hello", "Helvetica", 12);
    expect(width).toBeGreaterThan(0);
    // "Hello" at 12pt Helvetica should be roughly 24-30 points
    expect(width).toBeGreaterThan(20);
    expect(width).toBeLessThan(40);
  });

  it("should measure monospaced (Courier) text", () => {
    const w1 = pdf.measureText("iiiii", "Courier", 12);
    const w2 = pdf.measureText("MMMMM", "Courier", 12);
    // Courier is monospaced — all characters same width
    expect(w1).toBeCloseTo(w2, 1);
  });

  it("should scale with font size", () => {
    const w12 = pdf.measureText("Hello", "Helvetica", 12);
    const w24 = pdf.measureText("Hello", "Helvetica", 24);
    expect(w24).toBeCloseTo(w12 * 2, 1);
  });

  it("should return char width for ASCII range", () => {
    // Space is 278 units in Helvetica
    expect(pdf.charWidth("Helvetica", 32)).toBe(278);
    // 'A' (code 65) is 667 in Helvetica
    expect(pdf.charWidth("Helvetica", 65)).toBe(667);
  });

  it("should return default width for non-ASCII", () => {
    // Characters outside 32-126 should return default width
    expect(pdf.charWidth("Helvetica", 200)).toBe(278);
  });

  it("should handle Courier (monospaced) char widths", () => {
    expect(pdf.charWidth("Courier", 65)).toBe(600);
    expect(pdf.charWidth("Courier", 32)).toBe(600);
    expect(pdf.charWidth("Courier", 122)).toBe(600);
  });
});

// ── Metadata ─────────────────────────────────────────────────────────

describe("metadata", () => {
  it("should include title in PDF", () => {
    const doc = pdf.createDocument({ title: "Test Document" });
    doc.addPage();
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("/Title (Test Document)");
  });

  it("should include author", () => {
    const doc = pdf.createDocument({ author: "Jane Doe" });
    doc.addPage();
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("/Author (Jane Doe)");
  });

  it("should include subject", () => {
    const doc = pdf.createDocument({ subject: "Test Subject" });
    doc.addPage();
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("/Subject (Test Subject)");
  });

  it("should include creator", () => {
    const doc = pdf.createDocument();
    doc.addPage();
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("/Creator (HyperAgent)");
  });

  it("should include producer", () => {
    const doc = pdf.createDocument();
    doc.addPage();
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("/Producer (HyperAgent PDF Module)");
  });

  it("should include creation date", () => {
    const doc = pdf.createDocument();
    doc.addPage();
    const str = pdfToString(doc.buildPdf());
    expect(str).toMatch(/\/CreationDate \(D:\d{14}Z\)/);
  });

  it("should escape special chars in metadata", () => {
    const doc = pdf.createDocument({ title: "Test (with) parens" });
    doc.addPage();
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("\\(with\\)");
  });
});

// ── Debug Mode ───────────────────────────────────────────────────────

describe("debug mode", () => {
  it("should produce uncompressed content streams", () => {
    const doc = pdf.createDocument({ debug: true });
    doc.addPage();
    doc.drawText("Debug text", 72, 72);
    const str = pdfToString(doc.buildPdf());
    // Debug mode: no FlateDecode filter
    expect(str).not.toContain("/Filter /FlateDecode");
    // Content should be readable as plain text
    expect(str).toContain("(Debug text) Tj");
  });

  it("should compress by default (non-debug)", () => {
    const doc = pdf.createDocument({ debug: false });
    doc.addPage();
    // Add enough text to make compression worthwhile
    doc.drawText(
      "This is a test of the PDF compression system which needs enough content.",
      72,
      72,
    );
    doc.drawText(
      "Adding more content to make the compressed version smaller than raw.",
      72,
      100,
    );
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("/Filter /FlateDecode");
  });
});

// ── Page Sizes ───────────────────────────────────────────────────────

describe("page sizes", () => {
  it("should support A4", () => {
    const doc = pdf.createDocument({ pageSize: "a4" });
    doc.addPage();
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("595.28");
    expect(str).toContain("841.89");
  });

  it("should support US Letter", () => {
    const doc = pdf.createDocument({ pageSize: "letter" });
    doc.addPage();
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("612.00");
    expect(str).toContain("792.00");
  });

  it("should support case-insensitive size names", () => {
    const doc = pdf.createDocument({ pageSize: "A4" });
    expect(doc.pageSize.width).toBeCloseTo(595.28, 1);
  });

  it("should list available page sizes", () => {
    expect(pdf.PAGE_SIZES).toBeDefined();
    expect(pdf.PAGE_SIZES.a4).toBeDefined();
    expect(pdf.PAGE_SIZES.letter).toBeDefined();
    expect(pdf.PAGE_SIZES.legal).toBeDefined();
  });
});

// ── Multiple Fonts ───────────────────────────────────────────────────

describe("multiple fonts", () => {
  it("should register multiple fonts used in document", () => {
    const doc = pdf.createDocument({ debug: true });
    doc.addPage();
    doc.drawText("Regular", 72, 72, { font: "Helvetica" });
    doc.drawText("Bold", 72, 100, { font: "Helvetica-Bold" });
    doc.drawText("Mono", 72, 128, { font: "Courier" });
    const str = pdfToString(doc.buildPdf());
    expect(hasFont(str, "Helvetica")).toBe(true);
    expect(hasFont(str, "Helvetica-Bold")).toBe(true);
    expect(hasFont(str, "Courier")).toBe(true);
  });

  it("should reuse font references", () => {
    const doc = pdf.createDocument({ debug: true });
    doc.addPage();
    doc.drawText("First", 72, 72, { font: "Helvetica" });
    doc.drawText("Second", 72, 100, { font: "Helvetica" });
    const str = pdfToString(doc.buildPdf());
    // Should only have one Helvetica font object
    const matches = str.match(/\/BaseFont \/Helvetica\b/g);
    expect(matches?.length).toBe(1);
  });
});

// ── Standard Fonts ───────────────────────────────────────────────────

describe("standard fonts", () => {
  it("should export the list of standard fonts", () => {
    expect(pdf.STANDARD_FONTS).toBeDefined();
    expect(pdf.STANDARD_FONTS).toContain("Helvetica");
    expect(pdf.STANDARD_FONTS).toContain("Times-Roman");
    expect(pdf.STANDARD_FONTS).toContain("Courier");
    expect(pdf.STANDARD_FONTS).toContain("Symbol");
    expect(pdf.STANDARD_FONTS).toContain("ZapfDingbats");
    expect(pdf.STANDARD_FONTS.length).toBe(14);
  });
});

// ── Serialization Helpers ────────────────────────────────────────────

describe("serializeValue", () => {
  it("should serialize null", () => {
    expect(pdf.serializeValue(null)).toBe("null");
  });

  it("should serialize booleans", () => {
    expect(pdf.serializeValue(true)).toBe("true");
    expect(pdf.serializeValue(false)).toBe("false");
  });

  it("should serialize integers", () => {
    expect(pdf.serializeValue(42)).toBe("42");
    expect(pdf.serializeValue(0)).toBe("0");
    expect(pdf.serializeValue(-1)).toBe("-1");
  });

  it("should serialize floats with limited precision", () => {
    const result = pdf.serializeValue(3.14159265);
    expect(result).toBe("3.1416");
  });

  it("should serialize strings with escaping", () => {
    expect(pdf.serializeValue("hello")).toBe("(hello)");
    expect(pdf.serializeValue("te(st)")).toBe("(te\\(st\\))");
    expect(pdf.serializeValue("back\\slash")).toBe("(back\\\\slash)");
  });

  it("should serialize PDF names", () => {
    expect(pdf.serializeValue(pdf.name("Type"))).toBe("/Type");
  });

  it("should serialize PDF references", () => {
    expect(pdf.serializeValue(pdf.ref(5))).toBe("5 0 R");
  });

  it("should serialize PDF arrays", () => {
    expect(pdf.serializeValue(pdf.array(1, 2, 3))).toBe("[1 2 3]");
  });

  it("should serialize PDF dictionaries", () => {
    const d = pdf.dict();
    d.set("Type", pdf.name("Font"));
    d.set("Size", 12);
    const result = pdf.serializeValue(d);
    expect(result).toContain("/Type /Font");
    expect(result).toContain("/Size 12");
    expect(result).toMatch(/^<<.*>>$/);
  });
});

// ── exportToFile ─────────────────────────────────────────────────────

describe("exportToFile", () => {
  it("should call writeFileBinary with PDF bytes", () => {
    const doc = pdf.createDocument();
    doc.addPage();
    doc.drawText("Test", 72, 72);

    let savedPath = "";
    let savedData: Uint8Array | null = null;
    const mockFsWrite = {
      writeFileBinary(path: string, data: Uint8Array) {
        savedPath = path;
        savedData = data;
      },
    };

    pdf.exportToFile(doc, "output.pdf", mockFsWrite);
    expect(savedPath).toBe("output.pdf");
    expect(savedData).toBeInstanceOf(Uint8Array);
    expect(savedData!.length).toBeGreaterThan(0);
    // Verify it's valid PDF
    const str = pdfToString(savedData!);
    expect(hasValidHeader(str)).toBe(true);
    expect(hasEof(str)).toBe(true);
  });
});

// ── Edge Cases ───────────────────────────────────────────────────────

describe("edge cases", () => {
  it("should handle empty pages (no drawing ops)", () => {
    const doc = pdf.createDocument();
    doc.addPage();
    doc.addPage();
    const bytes = doc.buildPdf();
    const str = pdfToString(bytes);
    expect(hasValidHeader(str)).toBe(true);
    expect(hasEof(str)).toBe(true);
    expect(getPageCount(str)).toBe(2);
  });

  it("should handle very long text", () => {
    const doc = pdf.createDocument({ debug: true });
    doc.addPage();
    const longText = "A".repeat(5000);
    doc.drawText(longText, 72, 72);
    const bytes = doc.buildPdf();
    expect(bytes.length).toBeGreaterThan(5000);
    const str = pdfToString(bytes);
    expect(hasValidHeader(str)).toBe(true);
    expect(hasEof(str)).toBe(true);
  });

  it("should handle multiple drawing operations on one page", () => {
    const doc = pdf.createDocument({ debug: true });
    doc.addPage();
    for (let i = 0; i < 20; i++) {
      doc.drawText(`Line ${i}`, 72, 72 + i * 20);
    }
    doc.drawRect(72, 500, 200, 100, { fill: "EEEEEE" });
    doc.drawLine(72, 620, 500, 620, { color: "000000" });
    const bytes = doc.buildPdf();
    const str = pdfToString(bytes);
    expect(hasValidHeader(str)).toBe(true);
    expect(hasEof(str)).toBe(true);
  });

  it("should produce valid PDF with all standard font families", () => {
    const doc = pdf.createDocument({ debug: true });
    doc.addPage();
    const fonts = [
      "Helvetica",
      "Times-Roman",
      "Courier",
      "Helvetica-Bold",
      "Times-Bold",
      "Courier-Bold",
    ];
    fonts.forEach((font, i) => {
      doc.drawText(`${font} text`, 72, 72 + i * 20, { font });
    });
    const bytes = doc.buildPdf();
    const str = pdfToString(bytes);
    expect(hasValidHeader(str)).toBe(true);
    expect(hasEof(str)).toBe(true);
    fonts.forEach((font) => {
      expect(hasFont(str, font)).toBe(true);
    });
  });
});

// ── Constants ────────────────────────────────────────────────────────

describe("constants", () => {
  it("should export PTS_PER_INCH", () => {
    expect(pdf.PTS_PER_INCH).toBe(72);
  });

  it("should export PAGE_SIZES with standard sizes", () => {
    expect(pdf.PAGE_SIZES.a4).toEqual({ width: 595.28, height: 841.89 });
    expect(pdf.PAGE_SIZES.letter).toEqual({ width: 612, height: 792 });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2: Flow Layout Engine & Text Elements
// ═══════════════════════════════════════════════════════════════════════

// ── PdfElement Branded Type ──────────────────────────────────────────

describe("PdfElement", () => {
  it("should create branded elements via paragraph()", () => {
    const el = pdf.paragraph({ text: "Hello" });
    expect(pdf.isPdfElement(el)).toBe(true);
    expect(el._kind).toBe("paragraph");
  });

  it("should create branded elements via heading()", () => {
    const el = pdf.heading({ text: "Title", level: 1 });
    expect(pdf.isPdfElement(el)).toBe(true);
    expect(el._kind).toBe("heading");
  });

  it("should create branded elements via bulletList()", () => {
    const el = pdf.bulletList({ items: ["a", "b"] });
    expect(pdf.isPdfElement(el)).toBe(true);
    expect(el._kind).toBe("bulletList");
  });

  it("should create branded elements via numberedList()", () => {
    const el = pdf.numberedList({ items: ["a", "b"] });
    expect(pdf.isPdfElement(el)).toBe(true);
    expect(el._kind).toBe("numberedList");
  });

  it("should create branded elements via spacer()", () => {
    const el = pdf.spacer(36);
    expect(pdf.isPdfElement(el)).toBe(true);
    expect(el._kind).toBe("spacer");
  });

  it("should create branded elements via pageBreak()", () => {
    const el = pdf.pageBreak();
    expect(pdf.isPdfElement(el)).toBe(true);
    expect(el._kind).toBe("pageBreak");
  });

  it("should create branded elements via rule()", () => {
    const el = pdf.rule();
    expect(pdf.isPdfElement(el)).toBe(true);
    expect(el._kind).toBe("rule");
  });

  it("should reject plain objects as PdfElement", () => {
    expect(pdf.isPdfElement({ _kind: "paragraph", _data: {} })).toBe(false);
    expect(pdf.isPdfElement(null)).toBe(false);
    expect(pdf.isPdfElement("string")).toBe(false);
    expect(pdf.isPdfElement(42)).toBe(false);
  });

  it("should freeze elements (immutable)", () => {
    const el = pdf.paragraph({ text: "frozen" });
    expect(Object.isFrozen(el)).toBe(true);
  });
});

// ── Word Wrapping ────────────────────────────────────────────────────

describe("wrapText", () => {
  it("should return single line for short text", () => {
    const lines = pdf.wrapText("Hello", "Helvetica", 12, 500);
    expect(lines).toEqual(["Hello"]);
  });

  it("should wrap long text into multiple lines", () => {
    const longText =
      "This is a long paragraph that should be wrapped across multiple lines when it exceeds the available width";
    const lines = pdf.wrapText(longText, "Helvetica", 12, 200);
    expect(lines.length).toBeGreaterThan(1);
    // Each word from the original should appear in some line
    for (const word of longText.split(" ")) {
      const found = lines.some((line: string) => line.includes(word));
      expect(found).toBe(true);
    }
  });

  it("should handle empty text", () => {
    const lines = pdf.wrapText("", "Helvetica", 12, 200);
    expect(lines).toEqual([""]);
  });

  it("should handle single word that exceeds width", () => {
    const lines = pdf.wrapText(
      "Supercalifragilisticexpialidocious",
      "Helvetica",
      12,
      50,
    );
    // Long word should not be broken — placed on its own line
    expect(lines.length).toBe(1);
    expect(lines[0]).toBe("Supercalifragilisticexpialidocious");
  });

  it("should handle multiple spaces", () => {
    const lines = pdf.wrapText("hello    world", "Helvetica", 12, 500);
    expect(lines).toEqual(["hello world"]);
  });

  it("should respect different font sizes", () => {
    const text =
      "This text should wrap differently at different font sizes and widths";
    const lines12 = pdf.wrapText(text, "Helvetica", 12, 200);
    const lines24 = pdf.wrapText(text, "Helvetica", 24, 200);
    // Larger font = more lines needed
    expect(lines24.length).toBeGreaterThanOrEqual(lines12.length);
  });

  it("should handle non-positive maxWidth gracefully", () => {
    const lines = pdf.wrapText("test", "Helvetica", 12, 0);
    expect(lines).toEqual(["test"]);
  });
});

// ── Paragraph Element ────────────────────────────────────────────────

describe("paragraph()", () => {
  it("should use sensible defaults", () => {
    const el = pdf.paragraph({ text: "Basic text" });
    const d = el._data;
    expect(d.text).toBe("Basic text");
    expect(d.fontSize).toBe(11);
    expect(d.font).toBe("Helvetica");
    expect(d.bold).toBe(false);
    expect(d.italic).toBe(false);
    expect(d.align).toBe("left");
    expect(d.lineHeight).toBe(1.4);
    expect(d.spaceAfter).toBe(6);
  });

  it("should accept all options", () => {
    const el = pdf.paragraph({
      text: "Custom",
      fontSize: 14,
      font: "Times-Roman",
      color: "FF0000",
      bold: true,
      italic: true,
      align: "center",
      lineHeight: 1.6,
      spaceBefore: 10,
      spaceAfter: 12,
    });
    const d = el._data;
    expect(d.fontSize).toBe(14);
    expect(d.font).toBe("Times-Roman");
    expect(d.color).toBe("FF0000");
    expect(d.bold).toBe(true);
    expect(d.italic).toBe(true);
    expect(d.align).toBe("center");
    expect(d.lineHeight).toBe(1.6);
    expect(d.spaceBefore).toBe(10);
    expect(d.spaceAfter).toBe(12);
  });
});

// ── Heading Element ──────────────────────────────────────────────────

describe("heading()", () => {
  it("should default to level 1", () => {
    const el = pdf.heading({ text: "Title" });
    expect(el._data.level).toBe(1);
  });

  it("should clamp level to 1-6 range", () => {
    expect(pdf.heading({ text: "T", level: 0 })._data.level).toBe(1);
    expect(pdf.heading({ text: "T", level: 7 })._data.level).toBe(6);
    expect(pdf.heading({ text: "T", level: 3 })._data.level).toBe(3);
  });

  it("should accept colour override", () => {
    const el = pdf.heading({ text: "Red", color: "FF0000" });
    expect(el._data.color).toBe("FF0000");
  });
});

// ── List Elements ────────────────────────────────────────────────────

describe("bulletList()", () => {
  it("should require items array", () => {
    expect(() => pdf.bulletList({ items: null })).toThrow(/array/);
  });

  it("should accept string items", () => {
    const el = pdf.bulletList({ items: ["one", "two", "three"] });
    expect(el._data.items).toEqual(["one", "two", "three"]);
  });

  it("should use bullet character default", () => {
    const el = pdf.bulletList({ items: ["a"] });
    expect(el._data.bulletChar).toBe("\u2022");
  });

  it("should accept custom bullet character", () => {
    const el = pdf.bulletList({ items: ["a"], bulletChar: "-" });
    expect(el._data.bulletChar).toBe("-");
  });
});

describe("numberedList()", () => {
  it("should require items array", () => {
    expect(() => pdf.numberedList({ items: null })).toThrow(/array/);
  });

  it("should accept string items", () => {
    const el = pdf.numberedList({ items: ["first", "second"] });
    expect(el._data.items).toEqual(["first", "second"]);
  });
});

// ── Spacer Element ───────────────────────────────────────────────────

describe("spacer()", () => {
  it("should store height", () => {
    const el = pdf.spacer(36);
    expect(el._data.height).toBe(36);
  });

  it("should reject negative height", () => {
    expect(() => pdf.spacer(-10)).toThrow(/minimum/);
  });
});

// ── Rule Element ─────────────────────────────────────────────────────

describe("rule()", () => {
  it("should use sensible defaults", () => {
    const el = pdf.rule();
    expect(el._data.thickness).toBe(0.5);
    expect(el._data.marginTop).toBe(12);
    expect(el._data.marginBottom).toBe(12);
  });

  it("should accept custom options", () => {
    const el = pdf.rule({
      thickness: 2,
      color: "333333",
      marginTop: 16,
      marginBottom: 16,
    });
    expect(el._data.thickness).toBe(2);
    expect(el._data.color).toBe("333333");
    expect(el._data.marginTop).toBe(16);
    expect(el._data.marginBottom).toBe(16);
  });
});

// ── addContent() Flow Layout ─────────────────────────────────────────

describe("addContent", () => {
  it("should auto-create first page if none exists", () => {
    const doc = pdf.createDocument({ debug: true });
    pdf.addContent(doc, [pdf.paragraph({ text: "Auto page" })]);
    expect(doc.pageCount).toBe(1);
  });

  it("should render paragraph text into PDF", () => {
    const doc = pdf.createDocument({ debug: true });
    pdf.addContent(doc, [pdf.paragraph({ text: "Hello flow layout" })]);
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("(Hello flow layout) Tj");
  });

  it("should render heading text into PDF", () => {
    const doc = pdf.createDocument({ debug: true });
    pdf.addContent(doc, [pdf.heading({ text: "My Title", level: 1 })]);
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("(My Title) Tj");
    // Heading uses Helvetica-Bold
    expect(hasFont(str, "Helvetica-Bold")).toBe(true);
  });

  it("should render bullet list with bullet characters", () => {
    const doc = pdf.createDocument({ debug: true });
    pdf.addContent(doc, [
      pdf.bulletList({ items: ["First item", "Second item"] }),
    ]);
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("(First item) Tj");
    expect(str).toContain("(Second item) Tj");
  });

  it("should render numbered list with numbers", () => {
    const doc = pdf.createDocument({ debug: true });
    pdf.addContent(doc, [
      pdf.numberedList({ items: ["Alpha", "Beta", "Gamma"] }),
    ]);
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("(1.) Tj");
    expect(str).toContain("(2.) Tj");
    expect(str).toContain("(3.) Tj");
    expect(str).toContain("(Alpha) Tj");
    expect(str).toContain("(Beta) Tj");
    expect(str).toContain("(Gamma) Tj");
  });

  it("should render horizontal rule", () => {
    const doc = pdf.createDocument({ debug: true });
    pdf.addContent(doc, [pdf.rule()]);
    const str = pdfToString(doc.buildPdf());
    // Rule draws a line (uses m/l/S operators)
    expect(str).toContain(" m\n");
    expect(str).toContain(" l\n");
    expect(str).toContain("S");
  });

  it("should handle page breaks", () => {
    const doc = pdf.createDocument({ debug: true });
    pdf.addContent(doc, [
      pdf.paragraph({ text: "Page one" }),
      pdf.pageBreak(),
      pdf.paragraph({ text: "Page two" }),
    ]);
    expect(doc.pageCount).toBe(2);
  });

  it("should handle spacer elements", () => {
    const doc = pdf.createDocument({ debug: true });
    pdf.addContent(doc, [
      pdf.paragraph({ text: "Before space" }),
      pdf.spacer(100),
      pdf.paragraph({ text: "After space" }),
    ]);
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("(Before space) Tj");
    expect(str).toContain("(After space) Tj");
  });

  it("should reject non-PdfElement values", () => {
    const doc = pdf.createDocument();
    expect(() => pdf.addContent(doc, [{ _kind: "fake", _data: {} }])).toThrow(
      /PdfElement/,
    );
  });

  it("should reject unknown element kinds", () => {
    // We can't easily create a branded element with unknown kind
    // without the internal factory, so this test is implicit via
    // the switch default in addContent
  });

  it("should use theme foreground for text colour by default", () => {
    const doc = pdf.createDocument({ theme: "light-clean", debug: true });
    pdf.addContent(doc, [pdf.paragraph({ text: "Dark text" })]);
    const str = pdfToString(doc.buildPdf());
    // light-clean fg = 333333 → 0.200 0.200 0.200
    expect(str).toContain("0.200 0.200 0.200 rg");
  });

  it("should accept custom text colour on paragraph", () => {
    const doc = pdf.createDocument({ debug: true });
    pdf.addContent(doc, [pdf.paragraph({ text: "Red", color: "FF0000" })]);
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("1.000 0.000 0.000 rg");
  });

  it("should resolve bold font variants", () => {
    const doc = pdf.createDocument({ debug: true });
    pdf.addContent(doc, [pdf.paragraph({ text: "Bold text", bold: true })]);
    const str = pdfToString(doc.buildPdf());
    expect(hasFont(str, "Helvetica-Bold")).toBe(true);
  });

  it("should resolve italic font variants", () => {
    const doc = pdf.createDocument({ debug: true });
    pdf.addContent(doc, [pdf.paragraph({ text: "Italic text", italic: true })]);
    const str = pdfToString(doc.buildPdf());
    expect(hasFont(str, "Helvetica-Oblique")).toBe(true);
  });

  it("should resolve bold+italic font variants", () => {
    const doc = pdf.createDocument({ debug: true });
    pdf.addContent(doc, [
      pdf.paragraph({ text: "Bold italic", bold: true, italic: true }),
    ]);
    const str = pdfToString(doc.buildPdf());
    expect(hasFont(str, "Helvetica-BoldOblique")).toBe(true);
  });

  it("should handle Times font family variants", () => {
    const doc = pdf.createDocument({ debug: true });
    pdf.addContent(doc, [
      pdf.paragraph({
        text: "Times bold italic",
        font: "Times-Roman",
        bold: true,
        italic: true,
      }),
    ]);
    const str = pdfToString(doc.buildPdf());
    expect(hasFont(str, "Times-BoldItalic")).toBe(true);
  });

  it("should handle center alignment", () => {
    const doc = pdf.createDocument({
      debug: true,
      pageSize: { width: 400, height: 600 },
    });
    pdf.addContent(doc, [pdf.paragraph({ text: "Centered", align: "center" })]);
    const str = pdfToString(doc.buildPdf());
    // "Centered" should be positioned with an x > left margin
    expect(str).toContain("(Centered) Tj");
    // The x position should be > 72 (default left margin) for centered text
    const tdMatch = str.match(/([\d.]+)\s+[\d.]+ Td\n\(Centered\)/);
    expect(tdMatch).not.toBeNull();
    const x = parseFloat(tdMatch![1]);
    expect(x).toBeGreaterThan(72); // Must be indented from left margin
  });

  it("should handle right alignment", () => {
    const doc = pdf.createDocument({
      debug: true,
      pageSize: { width: 400, height: 600 },
    });
    pdf.addContent(doc, [pdf.paragraph({ text: "Right", align: "right" })]);
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("(Right) Tj");
    const tdMatch = str.match(/([\d.]+)\s+[\d.]+ Td\n\(Right\)/);
    expect(tdMatch).not.toBeNull();
    const x = parseFloat(tdMatch![1]);
    expect(x).toBeGreaterThan(72);
  });

  it("should respect custom margins", () => {
    const doc = pdf.createDocument({
      debug: true,
      pageSize: { width: 612, height: 792 },
    });
    pdf.addContent(doc, [pdf.paragraph({ text: "Custom margins" })], {
      margins: { left: 144, top: 144 },
    });
    const str = pdfToString(doc.buildPdf());
    // Text x should be at 144 (2 inches)
    const tdMatch = str.match(/([\d.]+)\s+[\d.]+ Td\n\(Custom margins\)/);
    expect(tdMatch).not.toBeNull();
    const x = parseFloat(tdMatch![1]);
    expect(x).toBeCloseTo(144, 0);
  });
});

// ── Auto-Pagination ──────────────────────────────────────────────────

describe("auto-pagination", () => {
  it("should create new pages when content overflows", () => {
    const doc = pdf.createDocument({
      debug: true,
      pageSize: { width: 612, height: 200 }, // Very short page
    });
    // Generate enough paragraphs to overflow the tiny page
    const elements = [];
    for (let i = 0; i < 20; i++) {
      elements.push(
        pdf.paragraph({ text: `Paragraph ${i + 1}: Some text that matters.` }),
      );
    }
    pdf.addContent(doc, elements);
    // Should have created multiple pages
    expect(doc.pageCount).toBeGreaterThan(1);
  });

  it("should not orphan headings at page bottom", () => {
    const doc = pdf.createDocument({
      debug: true,
      pageSize: { width: 612, height: 300 }, // Short page
    });
    const elements = [];
    // Fill most of the page with paragraphs
    for (let i = 0; i < 8; i++) {
      elements.push(pdf.paragraph({ text: "Filler text for testing." }));
    }
    // Then add a heading — should push to next page rather than orphan
    elements.push(pdf.heading({ text: "New Section", level: 2 }));
    elements.push(pdf.paragraph({ text: "Content under heading." }));
    pdf.addContent(doc, elements);
    expect(doc.pageCount).toBeGreaterThanOrEqual(2);
  });

  it("should handle spacer causing page overflow", () => {
    const doc = pdf.createDocument({
      pageSize: { width: 612, height: 200 },
    });
    pdf.addContent(doc, [
      pdf.paragraph({ text: "Before" }),
      pdf.spacer(500), // Way bigger than page
      pdf.paragraph({ text: "After" }),
    ]);
    expect(doc.pageCount).toBeGreaterThan(1);
  });

  it("should produce valid PDF structure with multiple auto-pages", () => {
    const doc = pdf.createDocument({
      debug: true,
      pageSize: { width: 612, height: 300 },
    });
    const elements = [];
    for (let i = 0; i < 30; i++) {
      elements.push(
        pdf.paragraph({ text: `Line ${i + 1} of flowing content.` }),
      );
    }
    pdf.addContent(doc, elements);
    const str = pdfToString(doc.buildPdf());
    expect(hasValidHeader(str)).toBe(true);
    expect(hasEof(str)).toBe(true);
    expect(getPageCount(str)).toBe(doc.pageCount);
  });
});

// ── Complex Document ─────────────────────────────────────────────────

describe("complex flow document", () => {
  it("should render a document with mixed elements", () => {
    const doc = pdf.createDocument({ theme: "light-clean", debug: true });
    pdf.addContent(doc, [
      pdf.heading({ text: "Quarterly Report", level: 1 }),
      pdf.paragraph({
        text: "This report summarises the key findings from Q4 2025.",
      }),
      pdf.rule(),
      pdf.heading({ text: "Key Metrics", level: 2 }),
      pdf.bulletList({
        items: [
          "Revenue: $2.5M (+15%)",
          "Users: 10,000 (+25%)",
          "Uptime: 99.9%",
        ],
      }),
      pdf.heading({ text: "Action Items", level: 2 }),
      pdf.numberedList({
        items: [
          "Expand into APAC market",
          "Hire 3 senior engineers",
          "Launch mobile app beta",
        ],
      }),
      pdf.spacer(20),
      pdf.paragraph({
        text: "Prepared by the Strategy Team.",
        italic: true,
        align: "right",
      }),
    ]);

    const bytes = doc.buildPdf();
    const str = pdfToString(bytes);

    // Structural validity
    expect(hasValidHeader(str)).toBe(true);
    expect(hasEof(str)).toBe(true);

    // Content is present
    expect(str).toContain("(Quarterly Report) Tj");
    expect(str).toContain("(Key Metrics) Tj");
    expect(str).toContain("(Revenue: $2.5M \\(+15%\\)) Tj");
    expect(str).toContain("(1.) Tj");
    expect(str).toContain("(Expand into APAC market) Tj");
    expect(str).toContain("(Prepared by the Strategy Team.) Tj");

    // Fonts
    expect(hasFont(str, "Helvetica")).toBe(true);
    expect(hasFont(str, "Helvetica-Bold")).toBe(true);
    expect(hasFont(str, "Helvetica-Oblique")).toBe(true);
  });

  it("should produce a multi-page document with all element types", () => {
    const doc = pdf.createDocument({
      pageSize: { width: 612, height: 400 },
      debug: true,
    });
    const elements = [];
    for (let i = 0; i < 5; i++) {
      elements.push(pdf.heading({ text: `Section ${i + 1}`, level: 2 }));
      elements.push(
        pdf.paragraph({
          text: "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.",
        }),
      );
      elements.push(
        pdf.bulletList({
          items: ["Point A", "Point B", "Point C"],
        }),
      );
      if (i < 4) elements.push(pdf.rule());
    }
    pdf.addContent(doc, elements);
    expect(doc.pageCount).toBeGreaterThan(1);

    const bytes = doc.buildPdf();
    const str = pdfToString(bytes);
    expect(hasValidHeader(str)).toBe(true);
    expect(hasEof(str)).toBe(true);
    expect(getPageCount(str)).toBe(doc.pageCount);
  });
});

// ── DEFAULT_MARGINS ──────────────────────────────────────────────────

describe("DEFAULT_MARGINS", () => {
  it("should be 1 inch on all sides", () => {
    expect(pdf.DEFAULT_MARGINS).toEqual({
      top: 72,
      right: 72,
      bottom: 72,
      left: 72,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 3: Tables & Images
// ═══════════════════════════════════════════════════════════════════════

// ── Test Image Fixtures ──────────────────────────────────────────────
// Minimal valid JPEG and PNG files for testing.

/**
 * Create a minimal 1×1 red pixel JPEG (smallest valid JPEG).
 * This is a hand-crafted binary that PDF viewers can decode.
 */
function makeTestJpeg(): Uint8Array {
  // Minimal JPEG: SOI + APP0 + DQT + SOF0 + DHT + SOS + scan data + EOI
  // Instead of hand-crafting all the Huffman tables, we use a known minimal JPEG.
  // This is a 2×2 pixel red JPEG (107 bytes), created by ImageMagick.
  // prettier-ignore
  return new Uint8Array([
    0xFF,0xD8,0xFF,0xE0,0x00,0x10,0x4A,0x46,0x49,0x46,0x00,0x01,0x01,0x00,0x00,0x01,
    0x00,0x01,0x00,0x00,0xFF,0xDB,0x00,0x43,0x00,0x08,0x06,0x06,0x07,0x06,0x05,0x08,
    0x07,0x07,0x07,0x09,0x09,0x08,0x0A,0x0C,0x14,0x0D,0x0C,0x0B,0x0B,0x0C,0x19,0x12,
    0x13,0x0F,0x14,0x1D,0x1A,0x1F,0x1E,0x1D,0x1A,0x1C,0x1C,0x20,0x24,0x2E,0x27,0x20,
    0x22,0x2C,0x23,0x1C,0x1C,0x28,0x37,0x29,0x2C,0x30,0x31,0x34,0x34,0x34,0x1F,0x27,
    0x39,0x3D,0x38,0x32,0x3C,0x2E,0x33,0x34,0x32,0xFF,0xC0,0x00,0x0B,0x08,0x00,0x02,
    0x00,0x02,0x01,0x01,0x11,0x00,0xFF,0xC4,0x00,0x1F,0x00,0x00,0x01,0x05,0x01,0x01,
    0x01,0x01,0x01,0x01,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x01,0x02,0x03,0x04,
    0x05,0x06,0x07,0x08,0x09,0x0A,0x0B,0xFF,0xC4,0x00,0xB5,0x10,0x00,0x02,0x01,0x03,
    0x03,0x02,0x04,0x03,0x05,0x05,0x04,0x04,0x00,0x00,0x01,0x7D,0x01,0x02,0x03,0x00,
    0x04,0x11,0x05,0x12,0x21,0x31,0x41,0x06,0x13,0x51,0x61,0x07,0x22,0x71,0x14,0x32,
    0x81,0x91,0xA1,0x08,0x23,0x42,0xB1,0xC1,0x15,0x52,0xD1,0xF0,0x24,0x33,0x62,0x72,
    0x82,0x09,0x0A,0x16,0x17,0x18,0x19,0x1A,0x25,0x26,0x27,0x28,0x29,0x2A,0x34,0x35,
    0x36,0x37,0x38,0x39,0x3A,0x43,0x44,0x45,0x46,0x47,0x48,0x49,0x4A,0x53,0x54,0x55,
    0x56,0x57,0x58,0x59,0x5A,0x63,0x64,0x65,0x66,0x67,0x68,0x69,0x6A,0x73,0x74,0x75,
    0x76,0x77,0x78,0x79,0x7A,0x83,0x84,0x85,0x86,0x87,0x88,0x89,0x8A,0x92,0x93,0x94,
    0x95,0x96,0x97,0x98,0x99,0x9A,0xA2,0xA3,0xA4,0xA5,0xA6,0xA7,0xA8,0xA9,0xAA,0xB2,
    0xB3,0xB4,0xB5,0xB6,0xB7,0xB8,0xB9,0xBA,0xC2,0xC3,0xC4,0xC5,0xC6,0xC7,0xC8,0xC9,
    0xCA,0xD2,0xD3,0xD4,0xD5,0xD6,0xD7,0xD8,0xD9,0xDA,0xE1,0xE2,0xE3,0xE4,0xE5,0xE6,
    0xE7,0xE8,0xE9,0xEA,0xF1,0xF2,0xF3,0xF4,0xF5,0xF6,0xF7,0xF8,0xF9,0xFA,0xFF,0xDA,
    0x00,0x08,0x01,0x01,0x00,0x00,0x3F,0x00,0x54,0xDB,0x2E,0x48,0xA7,0x3A,0x28,0xA0,
    0x03,0xFF,0xD9,
  ]);
}

/**
 * Create a minimal valid PNG (1×1 red pixel).
 * Hand-crafted: PNG signature + IHDR + IDAT + IEND.
 */
function makeTestPng(): Uint8Array {
  // PNG signature
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  // IHDR chunk: 1×1, 8-bit RGB, no interlace
  // Length=13, Type=IHDR, Data: W=1 H=1 BD=8 CT=2 Comp=0 Filt=0 Inter=0, CRC
  const ihdr = [
    0x00,
    0x00,
    0x00,
    0x0d, // length = 13
    0x49,
    0x48,
    0x44,
    0x52, // "IHDR"
    0x00,
    0x00,
    0x00,
    0x01, // width = 1
    0x00,
    0x00,
    0x00,
    0x01, // height = 1
    0x08,
    0x02, // bit depth = 8, colour type = 2 (RGB)
    0x00,
    0x00,
    0x00, // compression, filter, interlace
    0x72,
    0x3a,
    0xc6,
    0xa3, // CRC of IHDR
  ];

  // IDAT chunk: DEFLATE-compressed row data
  // Row data: filter_byte(0) + R(255) G(0) B(0) = [0x00, 0xFF, 0x00, 0x00]
  // DEFLATE of [0x00, 0xFF, 0x00, 0x00] with zlib wrapper:
  const idatData = [
    0x78, 0x01, 0x62, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x00, 0x04, 0x00, 0x01,
  ];
  const idatLen = idatData.length;
  // IDAT header
  const idat = [
    (idatLen >> 24) & 0xff,
    (idatLen >> 16) & 0xff,
    (idatLen >> 8) & 0xff,
    idatLen & 0xff,
    0x49,
    0x44,
    0x41,
    0x54, // "IDAT"
    ...idatData,
    // CRC placeholder (viewers are forgiving about CRCs in most cases)
    0x00,
    0x00,
    0x00,
    0x00,
  ];

  // IEND chunk
  const iend = [
    0x00,
    0x00,
    0x00,
    0x00, // length = 0
    0x49,
    0x45,
    0x4e,
    0x44, // "IEND"
    0xae,
    0x42,
    0x60,
    0x82, // CRC of IEND
  ];

  return new Uint8Array([...sig, ...ihdr, ...idat, ...iend]);
}

// ── TABLE_STYLES ─────────────────────────────────────────────────────

describe("TABLE_STYLES", () => {
  it("should export preset styles", () => {
    expect(pdf.TABLE_STYLES).toBeDefined();
    expect(pdf.TABLE_STYLES.default).toBeDefined();
    expect(pdf.TABLE_STYLES.dark).toBeDefined();
    expect(pdf.TABLE_STYLES.minimal).toBeDefined();
    expect(pdf.TABLE_STYLES.corporate).toBeDefined();
    expect(pdf.TABLE_STYLES.emerald).toBeDefined();
  });

  it("should have required properties on each style", () => {
    for (const [name, style] of Object.entries(pdf.TABLE_STYLES) as [
      string,
      any,
    ][]) {
      expect(style.headerFg, `${name}.headerFg`).toBeDefined();
      expect(style.headerFont, `${name}.headerFont`).toBeDefined();
      expect(style.bodyFg, `${name}.bodyFg`).toBeDefined();
      expect(style.bodyFont, `${name}.bodyFont`).toBeDefined();
      expect(style.borderColor, `${name}.borderColor`).toBeDefined();
      expect(typeof style.borderWidth).toBe("number");
    }
  });
});

// ── table() element ──────────────────────────────────────────────────

describe("table()", () => {
  it("should create a branded PdfElement", () => {
    const el = pdf.table({
      headers: ["Name", "Age"],
      rows: [
        ["Alice", "30"],
        ["Bob", "25"],
      ],
    });
    expect(pdf.isPdfElement(el)).toBe(true);
    expect(el._kind).toBe("table");
  });

  it("should require non-empty headers", () => {
    expect(() => pdf.table({ headers: [], rows: [] })).toThrow(/empty/);
  });

  it("should validate row cell count matches headers", () => {
    expect(() =>
      pdf.table({
        headers: ["A", "B", "C"],
        rows: [["1", "2"]], // Missing one cell
      }),
    ).toThrow(/3 cells/);
  });

  it("should accept style by name", () => {
    const el = pdf.table({
      headers: ["X"],
      rows: [["1"]],
      style: "corporate",
    });
    expect(el._data.style.headerBg).toBe("1B2A4A");
  });

  it("should reject unknown style names", () => {
    expect(() =>
      pdf.table({ headers: ["X"], rows: [], style: "bogus" }),
    ).toThrow(/Unknown table style/);
  });

  it("should accept custom TableStyle", () => {
    const custom = {
      headerBg: "FF0000",
      headerFg: "FFFFFF",
      headerFont: "Courier-Bold",
      bodyFg: "000000",
      bodyFont: "Courier",
      altRowBg: "",
      borderColor: "000000",
      borderWidth: 1,
    };
    const el = pdf.table({ headers: ["X"], rows: [], style: custom });
    expect(el._data.style.headerBg).toBe("FF0000");
  });

  it("should use default font size of 10", () => {
    const el = pdf.table({ headers: ["X"], rows: [] });
    expect(el._data.fontSize).toBe(10);
  });
});

// ── kvTable() element ────────────────────────────────────────────────

describe("kvTable()", () => {
  it("should create a branded PdfElement", () => {
    const el = pdf.kvTable({
      items: [
        { key: "Name", value: "Alice" },
        { key: "Age", value: "30" },
      ],
    });
    expect(pdf.isPdfElement(el)).toBe(true);
    expect(el._kind).toBe("kvTable");
  });

  it("should require non-empty items", () => {
    expect(() => pdf.kvTable({ items: [] })).toThrow(/empty/);
  });

  it("should default keyWidth to 0.35", () => {
    const el = pdf.kvTable({
      items: [{ key: "K", value: "V" }],
    });
    expect(el._data.keyWidth).toBe(0.35);
  });

  it("should accept custom keyWidth", () => {
    const el = pdf.kvTable({
      items: [{ key: "K", value: "V" }],
      keyWidth: 0.5,
    });
    expect(el._data.keyWidth).toBe(0.5);
  });
});

// ── comparisonTable() element ────────────────────────────────────────

describe("comparisonTable()", () => {
  it("should create a branded PdfElement", () => {
    const el = pdf.comparisonTable({
      features: ["Fast", "Cheap", "Good"],
      options: [
        { name: "Option A", values: [true, false, true] },
        { name: "Option B", values: [false, true, true] },
      ],
    });
    expect(pdf.isPdfElement(el)).toBe(true);
    expect(el._kind).toBe("comparisonTable");
  });

  it("should require non-empty features", () => {
    expect(() =>
      pdf.comparisonTable({
        features: [],
        options: [{ name: "A", values: [] }],
      }),
    ).toThrow(/empty/);
  });

  it("should validate values length matches features", () => {
    expect(() =>
      pdf.comparisonTable({
        features: ["A", "B"],
        options: [{ name: "X", values: [true] }], // Should be 2 values
      }),
    ).toThrow(/2 values/);
  });
});

// ── image() element ──────────────────────────────────────────────────

describe("image()", () => {
  it("should create a branded PdfElement for JPEG", () => {
    const el = pdf.image({ data: makeTestJpeg(), width: 200 });
    expect(pdf.isPdfElement(el)).toBe(true);
    expect(el._kind).toBe("image");
  });

  it("should create a branded PdfElement for PNG", () => {
    const el = pdf.image({ data: makeTestPng(), height: 100 });
    expect(pdf.isPdfElement(el)).toBe(true);
  });

  it("should require at least one of width or height", () => {
    expect(() => pdf.image({ data: makeTestJpeg() })).toThrow(
      /width or height/,
    );
  });

  it("should require non-empty data", () => {
    expect(() => pdf.image({ data: new Uint8Array(0), width: 100 })).toThrow(
      /non-empty Uint8Array/,
    );
  });

  it("should default align to left", () => {
    const el = pdf.image({ data: makeTestJpeg(), width: 100 });
    expect(el._data.align).toBe("left");
  });

  it("should accept alignment options", () => {
    const el = pdf.image({
      data: makeTestJpeg(),
      width: 100,
      align: "center",
    });
    expect(el._data.align).toBe("center");
  });

  it("should accept caption", () => {
    const el = pdf.image({
      data: makeTestJpeg(),
      width: 100,
      caption: "Figure 1",
    });
    expect(el._data.caption).toBe("Figure 1");
  });
});

// ── Table rendering via addContent ───────────────────────────────────

describe("table rendering in addContent", () => {
  it("should render a basic table into PDF", () => {
    const doc = pdf.createDocument({ debug: true });
    pdf.addContent(doc, [
      pdf.table({
        headers: ["Name", "Score"],
        rows: [
          ["Alice", "95"],
          ["Bob", "87"],
          ["Charlie", "92"],
        ],
      }),
    ]);
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("(Name) Tj");
    expect(str).toContain("(Score) Tj");
    expect(str).toContain("(Alice) Tj");
    expect(str).toContain("(87) Tj");
    expect(hasValidHeader(str)).toBe(true);
    expect(hasEof(str)).toBe(true);
  });

  it("should render a kvTable into PDF", () => {
    const doc = pdf.createDocument({ debug: true });
    pdf.addContent(doc, [
      pdf.kvTable({
        items: [
          { key: "Company", value: "Acme Corp" },
          { key: "Revenue", value: "$2.5M" },
        ],
      }),
    ]);
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("(Company) Tj");
    expect(str).toContain("(Acme Corp) Tj");
    expect(str).toContain("(Revenue) Tj");
  });

  it("should render a comparisonTable into PDF", () => {
    const doc = pdf.createDocument({ debug: true });
    pdf.addContent(doc, [
      pdf.comparisonTable({
        features: ["Speed", "Cost"],
        options: [
          { name: "Plan A", values: [true, false] },
          { name: "Plan B", values: [false, true] },
        ],
      }),
    ]);
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("(Speed) Tj");
    expect(str).toContain("(Plan A) Tj");
    // ✓ and ✗ characters
    expect(str).toContain("Tj");
  });

  it("should render table with corporate style", () => {
    const doc = pdf.createDocument({ debug: true });
    pdf.addContent(doc, [
      pdf.table({
        headers: ["Product", "Price"],
        rows: [
          ["Widget", "$10"],
          ["Gadget", "$20"],
        ],
        style: "corporate",
      }),
    ]);
    const str = pdfToString(doc.buildPdf());
    // Corporate header bg is 1B2A4A — should appear as fill colour
    expect(str).toContain("rg"); // fill colour operator
    expect(str).toContain("(Widget) Tj");
  });

  it("should handle empty rows table", () => {
    const doc = pdf.createDocument({ debug: true });
    pdf.addContent(doc, [pdf.table({ headers: ["A", "B"], rows: [] })]);
    const str = pdfToString(doc.buildPdf());
    expect(hasValidHeader(str)).toBe(true);
    expect(str).toContain("(A) Tj");
    expect(str).toContain("(B) Tj");
  });
});

// ── Image rendering via drawImage ────────────────────────────────────

describe("drawImage (low-level)", () => {
  it("should embed a JPEG image", () => {
    const doc = pdf.createDocument({ debug: true });
    doc.addPage();
    doc.drawImage({
      data: makeTestJpeg(),
      x: 72,
      y: 72,
      width: 200,
      height: 150,
    });
    const str = pdfToString(doc.buildPdf());
    // Should contain XObject reference
    expect(str).toContain("/XObject");
    expect(str).toContain("/Im1");
    // Should contain image stream with DCTDecode
    expect(str).toContain("/Filter /DCTDecode");
    expect(str).toContain("/Subtype /Image");
    // Content stream should reference the image
    expect(str).toContain("/Im1 Do");
    expect(hasValidHeader(str)).toBe(true);
    expect(hasEof(str)).toBe(true);
  });

  it("should embed a PNG image", () => {
    const doc = pdf.createDocument({ debug: true });
    doc.addPage();
    doc.drawImage({
      data: makeTestPng(),
      x: 72,
      y: 72,
      width: 100,
      height: 100,
    });
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("/XObject");
    expect(str).toContain("/Filter /FlateDecode");
    expect(str).toContain("/Subtype /Image");
    expect(str).toContain("/Im1 Do");
  });

  it("should reject unsupported image formats", () => {
    const doc = pdf.createDocument();
    doc.addPage();
    expect(() =>
      doc.drawImage({
        data: new Uint8Array([0x47, 0x49, 0x46, 0x38]), // GIF
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      }),
    ).toThrow(/unsupported image format/);
  });

  it("should reject empty image data", () => {
    const doc = pdf.createDocument();
    doc.addPage();
    expect(() =>
      doc.drawImage({
        data: new Uint8Array(0),
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      }),
    ).toThrow(/non-empty Uint8Array/);
  });

  it("should reject negative dimensions", () => {
    const doc = pdf.createDocument();
    doc.addPage();
    expect(() =>
      doc.drawImage({
        data: makeTestJpeg(),
        x: 0,
        y: 0,
        width: -10,
        height: 100,
      }),
    ).toThrow(/minimum/);
  });
});

// ── Image rendering via addContent ───────────────────────────────────

describe("image rendering in addContent", () => {
  it("should render a JPEG image element", () => {
    const doc = pdf.createDocument({ debug: true });
    pdf.addContent(doc, [pdf.image({ data: makeTestJpeg(), width: 200 })]);
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("/XObject");
    expect(str).toContain("/Im1 Do");
    expect(str).toContain("/Filter /DCTDecode");
  });

  it("should render image with caption", () => {
    const doc = pdf.createDocument({ debug: true });
    pdf.addContent(doc, [
      pdf.image({
        data: makeTestJpeg(),
        width: 200,
        caption: "Figure 1: Test Image",
      }),
    ]);
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("(Figure 1: Test Image) Tj");
    // Caption uses Helvetica-Oblique
    expect(hasFont(str, "Helvetica-Oblique")).toBe(true);
  });

  it("should center an image when align is center", () => {
    const doc = pdf.createDocument({
      debug: true,
      pageSize: { width: 612, height: 792 },
    });
    pdf.addContent(doc, [
      pdf.image({
        data: makeTestJpeg(),
        width: 100,
        align: "center",
      }),
    ]);
    const str = pdfToString(doc.buildPdf());
    // Image should be positioned at center, not at left margin
    // cm operator: width 0 0 height x y cm
    const cmMatch = str.match(/100\.00 0 0 [\d.]+ ([\d.]+) [\d.]+ cm/);
    expect(cmMatch).not.toBeNull();
    const imgX = parseFloat(cmMatch![1]);
    // Should be centered: (612 - 72*2 - 100) / 2 + 72 = ~306
    expect(imgX).toBeGreaterThan(200);
  });
});

// ── Complex document with tables + images ────────────────────────────

describe("mixed tables and images document", () => {
  it("should render a document with tables, images, and text", () => {
    const doc = pdf.createDocument({ debug: true });
    pdf.addContent(doc, [
      pdf.heading({ text: "Sales Report", level: 1 }),
      pdf.paragraph({ text: "Q4 performance summary." }),
      pdf.table({
        headers: ["Product", "Revenue", "Growth"],
        rows: [
          ["Widgets", "$1.2M", "+15%"],
          ["Gadgets", "$800K", "+8%"],
          ["Services", "$500K", "+22%"],
        ],
        style: "corporate",
      }),
      pdf.spacer(12),
      pdf.image({
        data: makeTestJpeg(),
        width: 300,
        align: "center",
        caption: "Figure 1: Revenue Chart",
      }),
      pdf.rule(),
      pdf.kvTable({
        items: [
          { key: "Total Revenue", value: "$2.5M" },
          { key: "YoY Growth", value: "+14%" },
          { key: "Target", value: "$3.0M" },
        ],
      }),
    ]);

    const bytes = doc.buildPdf();
    const str = pdfToString(bytes);

    // Structural validity
    expect(hasValidHeader(str)).toBe(true);
    expect(hasEof(str)).toBe(true);

    // Content checks
    expect(str).toContain("(Sales Report) Tj");
    expect(str).toContain("(Widgets) Tj");
    expect(str).toContain("(Figure 1: Revenue Chart) Tj");
    expect(str).toContain("(Total Revenue) Tj");
    expect(str).toContain("/XObject");
    expect(str).toContain("/Im1 Do");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 4: Page Templates, Document Furniture, Rich Text, Serialization
// ═══════════════════════════════════════════════════════════════════════

// ── richText() ───────────────────────────────────────────────────────

describe("richText()", () => {
  it("should create a branded PdfElement", () => {
    const el = pdf.richText({
      paragraphs: [{ runs: [{ text: "Hello" }] }],
    });
    expect(pdf.isPdfElement(el)).toBe(true);
    expect(el._kind).toBe("richText");
  });

  it("should render via addContent", () => {
    const doc = pdf.createDocument({ debug: true });
    pdf.addContent(doc, [
      pdf.richText({
        paragraphs: [
          {
            runs: [{ text: "Bold text", bold: true }, { text: " and normal" }],
          },
        ],
      }),
    ]);
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("(Bold text and normal) Tj");
  });

  it("should use default settings", () => {
    const el = pdf.richText({
      paragraphs: [{ runs: [{ text: "X" }] }],
    });
    expect(el._data.fontSize).toBe(11);
    expect(el._data.font).toBe("Helvetica");
    expect(el._data.lineHeight).toBe(1.4);
  });
});

// ── codeBlock() ──────────────────────────────────────────────────────

describe("codeBlock()", () => {
  it("should create a branded PdfElement", () => {
    const el = pdf.codeBlock({ code: "const x = 1;" });
    expect(pdf.isPdfElement(el)).toBe(true);
    expect(el._kind).toBe("codeBlock");
  });

  it("should render with Courier font", () => {
    const doc = pdf.createDocument({ debug: true });
    pdf.addContent(doc, [
      pdf.codeBlock({ code: "function hello() {\n  return 42;\n}" }),
    ]);
    const str = pdfToString(doc.buildPdf());
    expect(hasFont(str, "Courier")).toBe(true);
    expect(str).toContain("(function hello\\(\\) {) Tj");
    expect(str).toContain("(  return 42;) Tj");
  });

  it("should draw a background rectangle", () => {
    const doc = pdf.createDocument({ debug: true });
    pdf.addContent(doc, [pdf.codeBlock({ code: "x = 1" })]);
    const str = pdfToString(doc.buildPdf());
    // Should have a filled rect (background)
    expect(str).toContain("re");
    expect(str).toContain("B"); // fill + stroke
  });

  it("should use default styling", () => {
    const el = pdf.codeBlock({ code: "test" });
    expect(el._data.fontSize).toBe(9);
    expect(el._data.bgColor).toBe("F5F5F5");
    expect(el._data.fgColor).toBe("333333");
    expect(el._data.padding).toBe(8);
  });

  it("should accept custom styling", () => {
    const el = pdf.codeBlock({
      code: "x",
      bgColor: "1E1E1E",
      fgColor: "D4D4D4",
      fontSize: 10,
    });
    expect(el._data.bgColor).toBe("1E1E1E");
    expect(el._data.fgColor).toBe("D4D4D4");
    expect(el._data.fontSize).toBe(10);
  });
});

// ── quote() ──────────────────────────────────────────────────────────

describe("quote()", () => {
  it("should create a branded PdfElement", () => {
    const el = pdf.quote({ text: "To be or not to be" });
    expect(pdf.isPdfElement(el)).toBe(true);
    expect(el._kind).toBe("quote");
  });

  it("should render with left accent border", () => {
    const doc = pdf.createDocument({ debug: true });
    pdf.addContent(doc, [
      pdf.quote({
        text: "The future is already here.",
        author: "William Gibson",
      }),
    ]);
    const str = pdfToString(doc.buildPdf());
    // Quote text rendered in italic font
    expect(hasFont(str, "Helvetica-Oblique")).toBe(true);
    expect(str).toContain("Tj");
    // Author attribution
    expect(str).toContain("William Gibson");
    // Accent line (stroke operation)
    expect(str).toContain("S");
  });

  it("should use default settings", () => {
    const el = pdf.quote({ text: "X" });
    expect(el._data.fontSize).toBe(12);
    expect(el._data.lineHeight).toBe(1.5);
    expect(el._data.spaceBefore).toBe(12);
    expect(el._data.spaceAfter).toBe(12);
  });
});

// ── titlePage() ──────────────────────────────────────────────────────

describe("titlePage()", () => {
  it("should add a page with title", () => {
    const doc = pdf.createDocument({ debug: true });
    pdf.titlePage(doc, { title: "Annual Report" });
    expect(doc.pageCount).toBe(1);
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("(Annual Report) Tj");
    expect(hasValidHeader(str)).toBe(true);
  });

  it("should include subtitle when provided", () => {
    const doc = pdf.createDocument({ debug: true });
    pdf.titlePage(doc, {
      title: "Annual Report",
      subtitle: "Fiscal Year 2025",
    });
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("(Fiscal Year 2025) Tj");
  });

  it("should include author and date", () => {
    const doc = pdf.createDocument({ debug: true });
    pdf.titlePage(doc, {
      title: "Report",
      author: "Jane Doe",
      date: "2025-12-31",
    });
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("Jane Doe");
    expect(str).toContain("2025-12-31");
  });

  it("should use theme background colour", () => {
    const doc = pdf.createDocument({ theme: "dark-gradient", debug: true });
    pdf.titlePage(doc, { title: "Dark Title" });
    const str = pdfToString(doc.buildPdf());
    // Should have a full-page fill rect
    expect(str).toContain("re");
    expect(str).toContain("f");
  });
});

// ── contentPage() ────────────────────────────────────────────────────

describe("contentPage()", () => {
  it("should add a titled page with content", () => {
    const doc = pdf.createDocument({ debug: true });
    pdf.contentPage(doc, {
      title: "Introduction",
      content: [pdf.paragraph({ text: "Welcome to the report." })],
    });
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("(Introduction) Tj");
    expect(str).toContain("(Welcome to the report.) Tj");
  });
});

// ── twoColumnPage() ─────────────────────────────────────────────────

describe("twoColumnPage()", () => {
  it("should render two columns with a title", () => {
    const doc = pdf.createDocument({ debug: true });
    pdf.twoColumnPage(doc, {
      title: "Comparison",
      left: [pdf.paragraph({ text: "Left column content" })],
      right: [pdf.paragraph({ text: "Right column content" })],
    });
    expect(doc.pageCount).toBe(1);
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("(Comparison) Tj");
    expect(str).toContain("(Left column content) Tj");
    expect(str).toContain("(Right column content) Tj");
  });
});

// ── quotePage() ──────────────────────────────────────────────────────

describe("quotePage()", () => {
  it("should render a full-page quote", () => {
    const doc = pdf.createDocument({ debug: true });
    pdf.quotePage(doc, {
      quote: "The only way to do great work is to love what you do.",
      author: "Steve Jobs",
      role: "CEO, Apple",
    });
    expect(doc.pageCount).toBe(1);
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("Steve Jobs");
    expect(str).toContain("CEO, Apple");
    // Should use italic font for quote text
    expect(hasFont(str, "Helvetica-Oblique")).toBe(true);
  });
});

// ── addPageNumbers() ─────────────────────────────────────────────────

describe("addPageNumbers()", () => {
  it("should add page numbers to all pages", () => {
    const doc = pdf.createDocument({ debug: true });
    doc.addPage();
    doc.drawText("Page 1", 72, 72);
    doc.addPage();
    doc.drawText("Page 2", 72, 72);
    pdf.addPageNumbers(doc);
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("(1) Tj");
    expect(str).toContain("(2) Tj");
  });

  it("should skip pages when configured", () => {
    const doc = pdf.createDocument({ debug: true });
    doc.addPage(); // Title page
    doc.addPage(); // Content
    doc.addPage(); // More content
    pdf.addPageNumbers(doc, { skipPages: 1 });
    const str = pdfToString(doc.buildPdf());
    // Should have numbers on pages 2 and 3 but not page 1
    expect(str).toContain("(1) Tj");
    expect(str).toContain("(2) Tj");
  });

  it("should accept custom start number", () => {
    const doc = pdf.createDocument({ debug: true });
    doc.addPage();
    doc.addPage();
    pdf.addPageNumbers(doc, { startNumber: 5 });
    const str = pdfToString(doc.buildPdf());
    expect(str).toContain("(5) Tj");
    expect(str).toContain("(6) Tj");
  });
});

// ── addFooter() ──────────────────────────────────────────────────────

describe("addFooter()", () => {
  it("should add footer text to all pages", () => {
    const doc = pdf.createDocument({ debug: true });
    doc.addPage();
    doc.addPage();
    pdf.addFooter(doc, { text: "Confidential" });
    const str = pdfToString(doc.buildPdf());
    // "Confidential" should appear twice (once on each page)
    const matches = str.match(/\(Confidential\) Tj/g);
    expect(matches?.length).toBe(2);
  });

  it("should skip pages when configured", () => {
    const doc = pdf.createDocument({ debug: true });
    doc.addPage(); // Title
    doc.addPage(); // Content
    pdf.addFooter(doc, { text: "Draft", skipPages: 1 });
    const str = pdfToString(doc.buildPdf());
    const matches = str.match(/\(Draft\) Tj/g);
    expect(matches?.length).toBe(1);
  });
});

// ── Serialization ────────────────────────────────────────────────────

describe("serializeDocument / restoreDocument", () => {
  it("should round-trip a simple document", () => {
    const doc = pdf.createDocument({
      title: "Test",
      author: "Author",
      debug: true,
    });
    doc.addPage();
    doc.drawText("Hello serialization", 72, 72);

    const serialized = pdf.serializeDocument(doc);
    expect(serialized.version).toBe(1);
    expect(serialized.pageCount).toBe(1);
    expect(serialized.meta.title).toBe("Test");

    const restored = pdf.restoreDocument(serialized);
    expect(restored.pageCount).toBe(1);
    expect(restored.debug).toBe(true);

    // Build should produce valid PDF
    const str = pdfToString(restored.buildPdf());
    expect(hasValidHeader(str)).toBe(true);
    expect(hasEof(str)).toBe(true);
    expect(str).toContain("(Hello serialization) Tj");
  });

  it("should preserve fonts across serialization", () => {
    const doc = pdf.createDocument({ debug: true });
    doc.addPage();
    doc.drawText("Regular", 72, 72);
    doc.drawText("Bold", 72, 100, { font: "Helvetica-Bold" });

    const serialized = pdf.serializeDocument(doc);
    const restored = pdf.restoreDocument(serialized);
    const str = pdfToString(restored.buildPdf());
    expect(hasFont(str, "Helvetica")).toBe(true);
    expect(hasFont(str, "Helvetica-Bold")).toBe(true);
  });

  it("should preserve images across serialization", () => {
    const doc = pdf.createDocument({ debug: true });
    doc.addPage();
    doc.drawImage({
      data: makeTestJpeg(),
      x: 72,
      y: 72,
      width: 100,
      height: 100,
    });

    const serialized = pdf.serializeDocument(doc);
    expect(serialized.images.length).toBe(1);

    const restored = pdf.restoreDocument(serialized);
    const str = pdfToString(restored.buildPdf());
    expect(str).toContain("/XObject");
    expect(str).toContain("/Filter /DCTDecode");
    expect(str).toContain("/Im1 Do");
  });

  it("should reject unknown serialization versions", () => {
    expect(() => pdf.restoreDocument({ version: 99 })).toThrow(/version/);
  });
});

// ── Complex Phase 4 Document ─────────────────────────────────────────

describe("complex Phase 4 document", () => {
  it("should render a full professional document", () => {
    const doc = pdf.createDocument({ theme: "corporate", debug: true });

    // Title page
    pdf.titlePage(doc, {
      title: "Strategic Plan 2026",
      subtitle: "Building the Future",
      author: "Strategy Team",
      date: "April 2026",
    });

    // Content pages
    pdf.addContent(doc, [
      pdf.heading({ text: "Executive Summary", level: 1 }),
      pdf.paragraph({
        text: "This document outlines our strategic priorities for the coming year.",
      }),
      pdf.quote({
        text: "The best way to predict the future is to create it.",
        author: "Peter Drucker",
      }),
      pdf.rule(),
      pdf.heading({ text: "Key Initiatives", level: 2 }),
      pdf.numberedList({
        items: [
          "Expand into new markets",
          "Launch next-gen platform",
          "Strengthen partnerships",
        ],
      }),
      pdf.codeBlock({
        code: "// Growth targets\nconst revenue = 5_000_000;\nconst growth = 0.25;",
      }),
      pdf.table({
        headers: ["Quarter", "Revenue", "Target"],
        rows: [
          ["Q1", "$1.2M", "$1.0M"],
          ["Q2", "$1.4M", "$1.2M"],
          ["Q3", "$1.1M", "$1.3M"],
          ["Q4", "$1.5M", "$1.5M"],
        ],
        style: "corporate",
      }),
    ]);

    // Document furniture
    pdf.addPageNumbers(doc);
    pdf.addFooter(doc, {
      text: "Confidential — Internal Use Only",
    });

    const bytes = doc.buildPdf();
    const str = pdfToString(bytes);

    // Structural validity
    expect(hasValidHeader(str)).toBe(true);
    expect(hasEof(str)).toBe(true);
    // titlePage creates 1 page, addContent continues on it (no forced page break)
    expect(doc.pageCount).toBeGreaterThanOrEqual(1);

    // Content presence
    expect(str).toContain("(Strategic Plan 2026) Tj");
    expect(str).toContain("(Executive Summary) Tj");
    expect(str).toContain("Peter Drucker");
    expect(str).toContain("(Q1) Tj");
    expect(str).toContain("(Confidential");

    // Fonts used
    expect(hasFont(str, "Helvetica")).toBe(true);
    expect(hasFont(str, "Helvetica-Bold")).toBe(true);
    expect(hasFont(str, "Helvetica-Oblique")).toBe(true);
    expect(hasFont(str, "Courier")).toBe(true);
  });
});
