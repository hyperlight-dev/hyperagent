/**
 * PDF Custom Font Tests (Phase 11)
 *
 * Tests for TrueType font parsing, embedding, and rendering.
 * Requires DejaVu Sans font (apt: fonts-dejavu-core).
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, writeFileSync, unlinkSync } from "fs";
import { execSync } from "child_process";

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

/** Load DejaVu Sans font if available, skip test if not. */
function loadDejaVu(): Uint8Array {
  const paths = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans.ttf",
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      return new Uint8Array(readFileSync(p));
    }
  }
  throw new Error("DejaVu Sans not found — install fonts-dejavu-core");
}

// ── TTF Parser Tests ─────────────────────────────────────────────────

describe("TTF parser (parseTTF)", () => {
  it("should parse DejaVu Sans font tables", () => {
    const data = loadDejaVu();
    // parseTTF is internal — we test it via registerCustomFont
    const doc = pdf.createDocument({ debug: true });
    // Should not throw
    pdf.registerCustomFont(doc, { name: "DejaVu", data });
  });

  it("should reject non-TTF data", () => {
    const doc = pdf.createDocument({ debug: true });
    expect(() =>
      pdf.registerCustomFont(doc, {
        name: "Bad",
        data: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
      }),
    ).toThrow();
  });

  it("should reject empty data", () => {
    const doc = pdf.createDocument({ debug: true });
    expect(() =>
      pdf.registerCustomFont(doc, { name: "Empty", data: new Uint8Array(0) }),
    ).toThrow(/data/);
  });
});

// ── Font Registration Tests ──────────────────────────────────────────

describe("registerCustomFont", () => {
  it("should register a custom font and make it usable", () => {
    const data = loadDejaVu();
    const doc = pdf.createDocument({ debug: true });
    pdf.registerCustomFont(doc, { name: "DejaVu", data });

    // Should be able to use the font in drawText
    doc.addPage();
    doc.drawText("Hello custom font", 72, 72, {
      font: "DejaVu",
      fontSize: 12,
    });

    const bytes = doc.buildPdf();
    const str = pdfToString(bytes);
    expect(str).toContain("/Type /Font");
    expect(str).toContain("/Subtype /Type0");
    expect(str).toContain("/CIDFontType2");
    expect(str).toContain("/FontDescriptor");
    expect(str).toContain("/FontFile2");
    expect(str).toContain("beginbfchar"); // ToUnicode CMap
  });

  it("should measure text correctly with custom font", () => {
    const data = loadDejaVu();
    const doc = pdf.createDocument({ debug: true });
    pdf.registerCustomFont(doc, { name: "DejaVu", data });

    const width = pdf.measureText("Hello", "DejaVu", 12);
    expect(width).toBeGreaterThan(0);
    expect(width).toBeLessThan(100); // sanity check
  });

  it("should render text as hex glyph IDs", () => {
    const data = loadDejaVu();
    const doc = pdf.createDocument({ debug: true });
    pdf.registerCustomFont(doc, { name: "DejaVu", data });

    doc.addPage();
    doc.drawText("AB", 72, 72, { font: "DejaVu", fontSize: 12 });

    const bytes = doc.buildPdf();
    const str = pdfToString(bytes);
    // Should contain hex-encoded glyph IDs, not (AB) Tj
    expect(str).toContain("> Tj"); // hex string ending
    expect(str).not.toContain("(AB) Tj"); // NOT WinAnsi
  });
});

// ── Flow Layout with Custom Fonts ────────────────────────────────────

describe("custom fonts in flow layout", () => {
  it("should work with paragraph()", () => {
    const data = loadDejaVu();
    const doc = pdf.createDocument({ debug: true });
    pdf.registerCustomFont(doc, { name: "DejaVu", data });

    doc.addPage();
    pdf.addContent(doc, [
      pdf.paragraph({ text: "Custom font paragraph", font: "DejaVu" }),
    ]);

    const bytes = doc.buildPdf();
    expect(bytes.length).toBeGreaterThan(1000); // has embedded font
  });

  it("should work with heading()", () => {
    const data = loadDejaVu();
    const doc = pdf.createDocument({ debug: true });
    pdf.registerCustomFont(doc, { name: "DejaVu", data });

    doc.addPage();
    // headings use Helvetica-Bold by default but let's make sure
    // the doc works when a custom font is registered
    pdf.addContent(doc, [
      pdf.heading({ text: "Section Title" }),
      pdf.paragraph({ text: "Body text in custom font", font: "DejaVu" }),
    ]);

    const bytes = doc.buildPdf();
    const str = pdfToString(bytes);
    expect(str).toContain("/Subtype /Type0"); // custom font embedded
    expect(str).toContain("/Subtype /Type1"); // standard font also present
  });
});

// ── Unicode Support ──────────────────────────────────────────────────

describe("Unicode with custom fonts", () => {
  it("should handle characters outside WinAnsi encoding", () => {
    const data = loadDejaVu();
    const doc = pdf.createDocument({ debug: true });
    pdf.registerCustomFont(doc, { name: "DejaVu", data });

    doc.addPage();
    // Cyrillic text — impossible with standard 14 fonts
    doc.drawText("Привет мир", 72, 72, {
      font: "DejaVu",
      fontSize: 12,
    });

    const bytes = doc.buildPdf();
    const str = pdfToString(bytes);
    // Should have hex glyph IDs, not garbled text
    expect(str).toContain("> Tj");
    expect(str).toContain("/ToUnicode"); // for text extraction
  });

  it("should handle extended Latin (Polish, Czech)", () => {
    const data = loadDejaVu();
    const doc = pdf.createDocument({ debug: true });
    pdf.registerCustomFont(doc, { name: "DejaVu", data });

    doc.addPage();
    doc.drawText("łódź ščř", 72, 72, {
      font: "DejaVu",
      fontSize: 12,
    });

    const bytes = doc.buildPdf();
    expect(bytes.length).toBeGreaterThan(500);
  });

  it("should measure Unicode text width correctly", () => {
    const data = loadDejaVu();
    const doc = pdf.createDocument({ debug: true });
    pdf.registerCustomFont(doc, { name: "DejaVu", data });

    const latin = pdf.measureText("Hello", "DejaVu", 12);
    const cyrillic = pdf.measureText("Привет", "DejaVu", 12);

    expect(latin).toBeGreaterThan(0);
    expect(cyrillic).toBeGreaterThan(0);
    // Both should be reasonable widths
    expect(latin).toBeLessThan(100);
    expect(cyrillic).toBeLessThan(100);
  });
});

// ── PDF Structure Validity ───────────────────────────────────────────

describe("embedded font PDF structure", () => {
  it("should produce a valid PDF with embedded font", () => {
    const data = loadDejaVu();
    const doc = pdf.createDocument({ debug: true });
    pdf.registerCustomFont(doc, { name: "DejaVu", data });

    doc.addPage();
    doc.drawText("Test", 72, 72, { font: "DejaVu", fontSize: 12 });

    const bytes = doc.buildPdf();
    const str = pdfToString(bytes);

    // Valid PDF structure
    expect(str.startsWith("%PDF-1.7")).toBe(true);
    expect(str.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(str).toContain("xref");
    expect(str).toContain("trailer");

    // Font embedding objects
    expect(str).toContain("/FontFile2"); // TTF stream reference
    expect(str).toContain("/CIDSystemInfo"); // CID font info
    expect(str).toContain("/Encoding /Identity-H"); // Unicode encoding
    expect(str).toContain("beginbfchar"); // ToUnicode mappings
  });

  it("should include font descriptor with metrics", () => {
    const data = loadDejaVu();
    const doc = pdf.createDocument({ debug: true });
    pdf.registerCustomFont(doc, { name: "DejaVu", data });

    doc.addPage();
    doc.drawText("X", 72, 72, { font: "DejaVu", fontSize: 12 });

    const bytes = doc.buildPdf();
    const str = pdfToString(bytes);

    expect(str).toContain("/FontDescriptor");
    expect(str).toContain("/Ascent");
    expect(str).toContain("/Descent");
    expect(str).toContain("/FontBBox");
    expect(str).toContain("/StemV");
  });

  it("should handle mixed standard + custom fonts in one document", () => {
    const data = loadDejaVu();
    const doc = pdf.createDocument({ debug: true });
    pdf.registerCustomFont(doc, { name: "DejaVu", data });

    doc.addPage();
    doc.drawText("Standard Helvetica", 72, 100, {
      font: "Helvetica",
      fontSize: 12,
    });
    doc.drawText("Custom DejaVu", 72, 120, {
      font: "DejaVu",
      fontSize: 12,
    });

    const bytes = doc.buildPdf();
    const str = pdfToString(bytes);

    // Both font types present
    expect(str).toContain("/Subtype /Type1"); // Helvetica
    expect(str).toContain("/Subtype /Type0"); // DejaVu
  });
});

// ── Subsetting (Phase 11b) ───────────────────────────────────────────

describe("font subsetting", () => {
  it("should track used codepoints", () => {
    const data = loadDejaVu();
    const doc = pdf.createDocument({ debug: true });
    pdf.registerCustomFont(doc, { name: "DejaVu", data });

    doc.addPage();
    doc.drawText("AB", 72, 72, { font: "DejaVu", fontSize: 12 });
    doc.drawText("CD", 72, 100, { font: "DejaVu", fontSize: 12 });

    // The document should have tracked codepoints A, B, C, D
    // We can verify by building the PDF and checking the /W array
    const bytes = doc.buildPdf();
    const str = pdfToString(bytes);
    // W array should have entries for the used glyphs
    expect(str).toContain("/W [");
  });
});

// ── pdftotext Verification ───────────────────────────────────────────

describe("custom font text extraction", () => {
  it("should render custom font text that pdftotext can extract", () => {
    const data = loadDejaVu();
    // Use debug: true for uncompressed streams (easier to verify)
    const doc = pdf.createDocument({ debug: true });
    pdf.registerCustomFont(doc, { name: "DJ", data });

    doc.addPage();
    doc.drawText("Hello World", 72, 100, { font: "DJ", fontSize: 14 });

    const bytes = doc.buildPdf();
    const tmpPath = "/tmp/test-custom-font.pdf";
    writeFileSync(tmpPath, bytes);

    try {
      const extracted = execSync(`pdftotext ${tmpPath} -`).toString().trim();
      // pdftotext uses the ToUnicode CMap to extract text
      // If CMap is correct, we get the original text back
      expect(extracted).toContain("Hello");
    } finally {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
    }
  });

  it("should work with compressed streams (non-debug mode)", () => {
    const data = loadDejaVu();
    // Non-debug = compressed streams
    const doc = pdf.createDocument();
    pdf.registerCustomFont(doc, { name: "DJ", data });

    doc.addPage();
    doc.drawText("Test compressed", 72, 100, { font: "DJ", fontSize: 14 });

    const bytes = doc.buildPdf();
    const tmpPath = "/tmp/test-custom-font-compressed.pdf";
    writeFileSync(tmpPath, bytes);

    try {
      // qpdf should pass (no stream errors)
      const qpdfResult = execSync(`qpdf --check ${tmpPath} 2>&1`).toString();
      expect(qpdfResult).toContain("No syntax or stream encoding errors");

      // pdftoppm should render (check file exists and has size)
      execSync(
        `pdftoppm -png -r 100 -singlefile ${tmpPath} /tmp/test-font-page`,
      );
      const pngStat = readFileSync("/tmp/test-font-page.png");
      expect(pngStat.length).toBeGreaterThan(1000); // should be a real image
    } finally {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
      try {
        unlinkSync("/tmp/test-font-page.png");
      } catch {
        /* ignore */
      }
    }
  });
});
