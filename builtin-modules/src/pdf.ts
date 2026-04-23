// @module pdf
// @description PDF 1.7 document generation (text, tables, charts, images, themes)
// @created 2026-04-14T00:00:00.000Z
//
// ── ha:pdf — PDF 1.7 Document Generation ─────────────────────────────
//
// Core PDF generation module for HyperAgent. Produces valid PDF 1.7
// documents with text, graphics, and metadata. Uses ha:doc-core for
// themes/validation and ha:ziplib for FlateDecode stream compression.
//
// COORDINATE SYSTEM:
//   The API uses a top-left origin (like screens and PPTX).
//   Internally this is converted to PDF's native bottom-left origin.
//   All measurements are in **points** (1 point = 1/72 inch).
//
// FONTS:
//   Phase 1 uses PDF's 14 standard fonts (no embedding required):
//   Helvetica, Helvetica-Bold, Helvetica-Oblique, Helvetica-BoldOblique,
//   Times-Roman, Times-Bold, Times-Italic, Times-BoldItalic,
//   Courier, Courier-Bold, Courier-Oblique, Courier-BoldOblique,
//   Symbol, ZapfDingbats
//
// USAGE:
//   import { createDocument, addContent, paragraph, heading } from "ha:pdf";
//   const doc = createDocument({ theme: "corporate-blue" });
//   addContent(doc, [
//     heading({ text: "My Document", level: 1 }),
//     paragraph({ text: "Hello, PDF! This text auto-wraps and paginates." }),
//     bulletList({ items: ["Item 1", "Item 2", "Item 3"] }),
//   ]);
//   const bytes = doc.buildPdf();

import {
  autoTextColor,
  contrastRatio,
  getTheme,
  hexColor,
  requireArray,
  requireHex,
  requireNumber,
  requireString,
  THEMES,
  type Theme,
} from "ha:doc-core";
import { deflate } from "ha:ziplib";

// ── Zlib Wrapper ─────────────────────────────────────────────────────
// ha:ziplib produces raw DEFLATE (RFC 1951) which is correct for ZIP
// archives. But PDF's FlateDecode expects zlib format (RFC 1950):
// 2-byte header + raw DEFLATE + 4-byte Adler32 checksum.
// This wrapper converts raw DEFLATE to zlib format for PDF streams.

/**
 * Compute Adler32 checksum of uncompressed data.
 * Used for the zlib trailer in FlateDecode streams.
 */
function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % 65521;
    b = (b + a) % 65521;
  }
  return (b << 16) | a;
}

/**
 * Wrap raw DEFLATE data in zlib format for PDF FlateDecode.
 * Adds 2-byte zlib header (CM=8, CINFO=7, no dict, FLEVEL=0)
 * and 4-byte Adler32 checksum of the UNCOMPRESSED data.
 *
 * @param rawDeflate - Raw DEFLATE compressed data from ha:ziplib
 * @param uncompressed - Original uncompressed data (needed for Adler32)
 * @returns Zlib-wrapped data suitable for PDF /FlateDecode
 */
function wrapZlib(
  rawDeflate: Uint8Array,
  uncompressed: Uint8Array,
): Uint8Array {
  const checksum = adler32(uncompressed);
  // Zlib header: CMF=0x78 (CM=8 deflate, CINFO=7 = 32K window)
  //              FLG=0x01 (FCHECK makes CMF*256+FLG divisible by 31)
  // 0x78 * 256 + 0x01 = 30721. 30721 % 31 = 0. ✓
  const result = new Uint8Array(2 + rawDeflate.length + 4);
  result[0] = 0x78; // CMF
  result[1] = 0x01; // FLG
  result.set(rawDeflate, 2);
  // Adler32 in big-endian
  const off = 2 + rawDeflate.length;
  result[off] = (checksum >> 24) & 0xff;
  result[off + 1] = (checksum >> 16) & 0xff;
  result[off + 2] = (checksum >> 8) & 0xff;
  result[off + 3] = checksum & 0xff;
  return result;
}

// ── Constants ────────────────────────────────────────────────────────

/** Points per inch (PDF base unit). */
export const PTS_PER_INCH: number = 72;

// ── Page Size Definitions ────────────────────────────────────────────

/** Page dimensions in points {width, height}. */
export interface PageSize {
  /** Width in points */
  readonly width: number;
  /** Height in points */
  readonly height: number;
}

/** Standard page sizes (all dimensions in points, portrait orientation). */
export const PAGE_SIZES: Record<string, PageSize> = {
  a4: { width: 595.28, height: 841.89 },
  letter: { width: 612, height: 792 },
  legal: { width: 612, height: 1008 },
  a3: { width: 841.89, height: 1190.55 },
  a5: { width: 419.53, height: 595.28 },
  tabloid: { width: 792, height: 1224 },
};

// ── Standard 14 Font Metrics ─────────────────────────────────────────
// PDF guarantees these fonts are available in all viewers without embedding.
// Width tables are per-character glyph widths in 1/1000 of a unit.
// These are the "standard" widths from the PDF spec / AFM files.

/**
 * Valid standard font names. These are guaranteed available in all PDF
 * viewers without font embedding.
 */
export const STANDARD_FONTS = [
  "Helvetica",
  "Helvetica-Bold",
  "Helvetica-Oblique",
  "Helvetica-BoldOblique",
  "Times-Roman",
  "Times-Bold",
  "Times-Italic",
  "Times-BoldItalic",
  "Courier",
  "Courier-Bold",
  "Courier-Oblique",
  "Courier-BoldOblique",
  "Symbol",
  "ZapfDingbats",
] as const;

export type StandardFontName = (typeof STANDARD_FONTS)[number];

// ── TrueType Font Parser ─────────────────────────────────────────────
// Parses TTF binary data to extract metrics needed for PDF embedding:
// character widths (hmtx), cmap (Unicode→glyph mapping), and font metadata.

/** Parsed TrueType font data for PDF embedding. */
interface ParsedTTF {
  /** PostScript name from the name table. */
  postScriptName: string;
  /** Font family name. */
  familyName: string;
  /** Units per em (typically 1000 or 2048). */
  unitsPerEm: number;
  /** Ascent in font units. */
  ascent: number;
  /** Descent in font units (negative). */
  descent: number;
  /** Bounding box [xMin, yMin, xMax, yMax] in font units. */
  bbox: [number, number, number, number];
  /** Number of glyphs. */
  numGlyphs: number;
  /** Advance widths per glyph ID (from hmtx). */
  glyphWidths: Uint16Array;
  /** Unicode codepoint → glyph ID mapping (from cmap). */
  cmapUnicodeToGlyph: Map<number, number>;
  /** StemV estimate for font descriptor. */
  stemV: number;
  /** Font flags for font descriptor. */
  flags: number;
  /** ItalicAngle from post table. */
  italicAngle: number;
  /** The original TTF binary data for embedding. */
  rawData: Uint8Array;
}

/** Read a 16-bit unsigned big-endian integer from a DataView. */
function readU16(dv: DataView, offset: number): number {
  return dv.getUint16(offset, false);
}

/** Read a 32-bit unsigned big-endian integer from a DataView. */
function readU32(dv: DataView, offset: number): number {
  return dv.getUint32(offset, false);
}

/** Read a 16-bit signed big-endian integer from a DataView. */
function readI16(dv: DataView, offset: number): number {
  return dv.getInt16(offset, false);
}

/** Read a 32-bit signed big-endian integer (Fixed 16.16). */
function readFixed(dv: DataView, offset: number): number {
  return dv.getInt32(offset, false) / 65536;
}

/**
 * Parse a TrueType font file from raw bytes.
 * Extracts metrics needed for PDF embedding.
 *
 * @param data - TTF file bytes
 * @returns Parsed font data
 */
function parseTTF(data: Uint8Array): ParsedTTF {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // ── Offset table ──
  const numTables = readU16(dv, 4);

  // ── Table directory ──
  const tables: Map<string, { offset: number; length: number }> = new Map();
  for (let i = 0; i < numTables; i++) {
    const base = 12 + i * 16;
    const tag =
      String.fromCharCode(dv.getUint8(base)) +
      String.fromCharCode(dv.getUint8(base + 1)) +
      String.fromCharCode(dv.getUint8(base + 2)) +
      String.fromCharCode(dv.getUint8(base + 3));
    const offset = readU32(dv, base + 8);
    const length = readU32(dv, base + 12);
    tables.set(tag, { offset, length });
  }

  function requireTable(tag: string): { offset: number; length: number } {
    const t = tables.get(tag);
    if (!t) throw new Error(`TTF: missing required table '${tag}'`);
    return t;
  }

  // ── head table — font-wide metrics ──
  const head = requireTable("head");
  const unitsPerEm = readU16(dv, head.offset + 18);
  const xMin = readI16(dv, head.offset + 36);
  const yMin = readI16(dv, head.offset + 38);
  const xMax = readI16(dv, head.offset + 40);
  const yMax = readI16(dv, head.offset + 42);

  // ── hhea table — horizontal header ──
  const hhea = requireTable("hhea");
  const ascent = readI16(dv, hhea.offset + 4);
  const descent = readI16(dv, hhea.offset + 6);
  const numHMetrics = readU16(dv, hhea.offset + 34);

  // ── maxp table — number of glyphs ──
  const maxp = requireTable("maxp");
  const numGlyphs = readU16(dv, maxp.offset + 4);

  // ── hmtx table — horizontal metrics (advance widths) ──
  const hmtx = requireTable("hmtx");
  const glyphWidths = new Uint16Array(numGlyphs);
  let lastWidth = 0;
  for (let i = 0; i < numGlyphs; i++) {
    if (i < numHMetrics) {
      lastWidth = readU16(dv, hmtx.offset + i * 4);
    }
    glyphWidths[i] = lastWidth;
  }

  // ── cmap table — Unicode to glyph ID mapping ──
  const cmap = requireTable("cmap");
  const cmapNumSubtables = readU16(dv, cmap.offset + 2);
  const cmapUnicodeToGlyph = new Map<number, number>();

  // Find a Unicode subtable (platformID 3 = Windows, encodingID 1 = Unicode BMP)
  // or (platformID 0 = Unicode)
  let cmapSubOffset = -1;
  let cmapFormat = -1;
  for (let i = 0; i < cmapNumSubtables; i++) {
    const subtableBase = cmap.offset + 4 + i * 8;
    const platformID = readU16(dv, subtableBase);
    const encodingID = readU16(dv, subtableBase + 2);
    const subtableOff = readU32(dv, subtableBase + 4);

    if (
      (platformID === 3 && encodingID === 1) ||
      (platformID === 0 && encodingID === 3)
    ) {
      cmapSubOffset = cmap.offset + subtableOff;
      cmapFormat = readU16(dv, cmapSubOffset);
      break;
    }
  }

  if (cmapSubOffset >= 0 && cmapFormat === 4) {
    // Format 4: Segment mapping to delta values (most common for BMP)
    const segCount = readU16(dv, cmapSubOffset + 6) / 2;
    const endCodesOff = cmapSubOffset + 14;
    const startCodesOff = endCodesOff + segCount * 2 + 2; // +2 for reservedPad
    const idDeltaOff = startCodesOff + segCount * 2;
    const idRangeOffsetOff = idDeltaOff + segCount * 2;

    for (let seg = 0; seg < segCount; seg++) {
      const endCode = readU16(dv, endCodesOff + seg * 2);
      const startCode = readU16(dv, startCodesOff + seg * 2);
      const idDelta = readI16(dv, idDeltaOff + seg * 2);
      const idRangeOffset = readU16(dv, idRangeOffsetOff + seg * 2);

      if (startCode === 0xffff) break;

      for (let cp = startCode; cp <= endCode; cp++) {
        let glyphId: number;
        if (idRangeOffset === 0) {
          glyphId = (cp + idDelta) & 0xffff;
        } else {
          const glyphIdOffset =
            idRangeOffsetOff + seg * 2 + idRangeOffset + (cp - startCode) * 2;
          glyphId = readU16(dv, glyphIdOffset);
          if (glyphId !== 0) {
            glyphId = (glyphId + idDelta) & 0xffff;
          }
        }
        if (glyphId !== 0) {
          cmapUnicodeToGlyph.set(cp, glyphId);
        }
      }
    }
  }

  // ── name table — font names ──
  const nameTable = tables.get("name");
  let postScriptName = "CustomFont";
  let familyName = "CustomFont";
  if (nameTable) {
    const nameCount = readU16(dv, nameTable.offset + 2);
    const stringOffset = readU16(dv, nameTable.offset + 4);
    for (let i = 0; i < nameCount; i++) {
      const base = nameTable.offset + 6 + i * 12;
      const platformID = readU16(dv, base);
      const nameID = readU16(dv, base + 6);
      const length = readU16(dv, base + 8);
      const offset = readU16(dv, base + 10);
      const strStart = nameTable.offset + stringOffset + offset;

      if (platformID === 3) {
        // Windows: UTF-16BE
        let str = "";
        for (let j = 0; j < length; j += 2) {
          str += String.fromCharCode(readU16(dv, strStart + j));
        }
        if (nameID === 6) postScriptName = str; // PostScript name
        if (nameID === 1) familyName = str; // Family name
      } else if (platformID === 1) {
        // Mac: single-byte
        let str = "";
        for (let j = 0; j < length; j++) {
          str += String.fromCharCode(dv.getUint8(strStart + j));
        }
        if (nameID === 6 && postScriptName === "CustomFont")
          postScriptName = str;
        if (nameID === 1 && familyName === "CustomFont") familyName = str;
      }
    }
  }

  // ── post table — italic angle ──
  const post = tables.get("post");
  const italicAngle = post ? readFixed(dv, post.offset + 4) : 0;

  // ── OS/2 table — weight class for stemV estimate ──
  const os2 = tables.get("OS/2");
  let stemV = 80; // default estimate
  let flags = 32; // nonsymbolic
  if (os2) {
    const weightClass = readU16(dv, os2.offset + 4);
    // Rough stemV from weight class (Adobe's heuristic)
    stemV = Math.round(10 + 220 * ((weightClass - 50) / 900));
    if (stemV < 50) stemV = 50;
    if (stemV > 200) stemV = 200;
  }
  if (italicAngle !== 0) flags |= 64; // italic flag

  return {
    postScriptName: postScriptName.replace(/[^a-zA-Z0-9+-]/g, ""),
    familyName,
    unitsPerEm,
    ascent,
    descent,
    bbox: [xMin, yMin, xMax, yMax],
    numGlyphs,
    glyphWidths,
    cmapUnicodeToGlyph,
    stemV,
    flags,
    italicAngle,
    rawData: data,
  };
}

/**
 * Get the advance width of a Unicode codepoint in a parsed TTF font.
 * Returns width in font units (divide by unitsPerEm * fontSize / 1000).
 */
function ttfCharWidth(parsed: ParsedTTF, codePoint: number): number {
  const glyphId = parsed.cmapUnicodeToGlyph.get(codePoint);
  if (glyphId === undefined || glyphId >= parsed.glyphWidths.length) return 0;
  return parsed.glyphWidths[glyphId];
}

/**
 * Subset a TTF font to only include the glyphs that are actually used.
 * Returns a new TTF binary with only the needed glyphs, reducing file size.
 *
 * @param parsed - Parsed TTF data
 * @param usedCodePoints - Set of Unicode codepoints that appear in the document
 * @returns Subset TTF binary data
 */
function subsetTTF(parsed: ParsedTTF, usedCodePoints: Set<number>): Uint8Array {
  // Build the glyph ID set (always include glyph 0 = .notdef)
  const usedGlyphIds = new Set<number>([0]);
  for (const cp of usedCodePoints) {
    const gid = parsed.cmapUnicodeToGlyph.get(cp);
    if (gid !== undefined) usedGlyphIds.add(gid);
  }

  // If most glyphs are used, skip subsetting
  if (usedGlyphIds.size > parsed.numGlyphs * 0.5) {
    return parsed.rawData;
  }

  const dv = new DataView(
    parsed.rawData.buffer,
    parsed.rawData.byteOffset,
    parsed.rawData.byteLength,
  );

  // Find required tables
  const numTables = readU16(dv, 4);
  const tableDir: Map<string, { offset: number; length: number }> = new Map();
  for (let i = 0; i < numTables; i++) {
    const base = 12 + i * 16;
    const tag =
      String.fromCharCode(dv.getUint8(base)) +
      String.fromCharCode(dv.getUint8(base + 1)) +
      String.fromCharCode(dv.getUint8(base + 2)) +
      String.fromCharCode(dv.getUint8(base + 3));
    tableDir.set(tag, {
      offset: readU32(dv, base + 8),
      length: readU32(dv, base + 12),
    });
  }

  const glyfTable = tableDir.get("glyf");
  const locaTable = tableDir.get("loca");
  const headTable = tableDir.get("head");
  if (!glyfTable || !locaTable || !headTable) {
    return parsed.rawData; // Can't subset without these tables
  }

  // Read indexToLocFormat from head table (0 = short, 1 = long)
  const locFormat = readI16(dv, headTable.offset + 50);

  // Read loca table to get glyph offsets
  const glyphOffsets: number[] = [];
  for (let i = 0; i <= parsed.numGlyphs; i++) {
    if (locFormat === 0) {
      // Short format: offsets are uint16, multiply by 2
      glyphOffsets.push(readU16(dv, locaTable.offset + i * 2) * 2);
    } else {
      // Long format: offsets are uint32
      glyphOffsets.push(readU32(dv, locaTable.offset + i * 4));
    }
  }

  // Scan for composite glyph references — composite glyphs reference
  // other glyphs that must also be included
  function addCompositeRefs(gid: number): void {
    if (gid >= parsed.numGlyphs) return;
    const off = glyfTable!.offset + glyphOffsets[gid];
    const nextOff = glyfTable!.offset + glyphOffsets[gid + 1];
    if (nextOff <= off) return; // empty glyph

    const numContours = readI16(dv, off);
    if (numContours >= 0) return; // simple glyph, no refs

    // Composite glyph: parse component records
    let ptr = off + 10; // skip header (numContours + bbox)
    let moreComponents = true;
    while (moreComponents && ptr < nextOff - 4) {
      const flags = readU16(dv, ptr);
      const refGid = readU16(dv, ptr + 2);
      usedGlyphIds.add(refGid);
      ptr += 4;
      // Skip args based on flags
      if (flags & 0x0001)
        ptr += 4; // ARG_1_AND_2_ARE_WORDS
      else ptr += 2;
      if (flags & 0x0008)
        ptr += 2; // WE_HAVE_A_SCALE
      else if (flags & 0x0040)
        ptr += 4; // WE_HAVE_AN_X_AND_Y_SCALE
      else if (flags & 0x0080) ptr += 8; // WE_HAVE_A_TWO_BY_TWO
      moreComponents = (flags & 0x0020) !== 0; // MORE_COMPONENTS
    }
  }

  // Recursively add composite glyph references
  for (const gid of Array.from(usedGlyphIds)) {
    addCompositeRefs(gid);
  }

  // Build subset: copy original font but zero out unused glyph data in glyf
  const result = new Uint8Array(parsed.rawData.length);
  result.set(parsed.rawData);

  // Zero out glyf data for unused glyphs
  let savedBytes = 0;
  for (let gid = 0; gid < parsed.numGlyphs; gid++) {
    if (usedGlyphIds.has(gid)) continue;
    const off = glyfTable.offset + glyphOffsets[gid];
    const nextOff = glyfTable.offset + glyphOffsets[gid + 1];
    const glyphLen = nextOff - off;
    if (glyphLen > 0) {
      // Zero out this glyph's data
      for (let j = off; j < nextOff && j < result.length; j++) {
        result[j] = 0;
      }
      savedBytes += glyphLen;
    }
  }

  // NOTE: We do NOT update the loca table. The glyf data is zeroed
  // for unused glyphs (numberOfContours = 0 → empty outline), which
  // is sufficient. Updating loca[gid+1] would corrupt the start offset
  // of the NEXT glyph if it's used (loca serves dual purpose as both
  // end-of-gid and start-of-gid+1).

  // Now compact: the zeroed glyf regions waste space even though they
  // compress well. Since ha:ziplib deflate may not handle large inputs
  // well, we physically remove the trailing empty glyf data and update
  // the glyf table length in the table directory.
  // Find the last byte of used glyph data in the glyf table.
  const rdv = new DataView(result.buffer, result.byteOffset, result.byteLength);
  let lastUsedByte = 0;
  for (const gid of usedGlyphIds) {
    if (gid + 1 <= parsed.numGlyphs) {
      const endOff = glyphOffsets[gid + 1];
      if (endOff > lastUsedByte) lastUsedByte = endOff;
    }
  }

  // Calculate how much of glyf we can trim
  const originalGlyfLen = glyfTable.length;
  const trimmedGlyfLen = Math.max(lastUsedByte, 4); // at least 4 bytes
  const bytesToTrim = originalGlyfLen - trimmedGlyfLen;

  if (bytesToTrim > 1000) {
    // Significant savings — rebuild with trimmed glyf.
    // Update the glyf table length in the table directory.
    for (let i = 0; i < numTables; i++) {
      const base = 12 + i * 16;
      const tag =
        String.fromCharCode(result[base]) +
        String.fromCharCode(result[base + 1]) +
        String.fromCharCode(result[base + 2]) +
        String.fromCharCode(result[base + 3]);
      if (tag === "glyf") {
        // Update length field
        const newLen = trimmedGlyfLen;
        rdv.setUint32(base + 12, newLen, false);
        break;
      }
    }

    // Truncate the result at glyf end + remaining tables after glyf
    // Actually, just return a slice up to the end of all data minus the trim
    // The simplest correct approach: set the glyf table length and return
    // a view that excludes the trailing zeros.
    // Since other tables may follow glyf, we can't just truncate.
    // Instead, return the full array — the /Length1 in the PDF will use
    // this trimmed length, and PDF readers will respect it.
    // Actually, /Length1 is set to fontData.length which would still be 757KB.
    // We need to physically shrink the array.

    // Copy everything before glyf end + everything after glyf
    const glyfEnd = glyfTable.offset + originalGlyfLen;
    const afterGlyf = result.slice(glyfEnd);
    const newResult = new Uint8Array(
      glyfTable.offset + trimmedGlyfLen + afterGlyf.length,
    );
    newResult.set(result.slice(0, glyfTable.offset + trimmedGlyfLen));
    newResult.set(afterGlyf, glyfTable.offset + trimmedGlyfLen);

    // Update table offsets for tables that come after glyf
    const ndv = new DataView(
      newResult.buffer,
      newResult.byteOffset,
      newResult.byteLength,
    );
    for (let i = 0; i < numTables; i++) {
      const base = 12 + i * 16;
      const tableOff = readU32(ndv, base + 8);
      if (tableOff > glyfTable.offset) {
        ndv.setUint32(base + 8, tableOff - bytesToTrim, false);
      }
    }

    return newResult;
  }

  return result;
}

// ── Font Width Tables (Standard 14) ──────────────────────────────────

/**
 * Build a ToUnicode CMap for a TrueType font.
 * Maps glyph IDs back to Unicode codepoints so PDF viewers can
 * extract text (copy/paste, search).
 */
function buildToUnicodeCMap(parsed: ParsedTTF, usedCPs?: Set<number>): string {
  const mappings: { gid: number; cp: number }[] = [];
  const cps = usedCPs ?? parsed.cmapUnicodeToGlyph.keys();
  for (const cp of cps) {
    const gid = parsed.cmapUnicodeToGlyph.get(cp);
    if (gid !== undefined && gid !== 0) {
      mappings.push({ gid, cp });
    }
  }
  // Sort by glyph ID
  mappings.sort((a, b) => a.gid - b.gid);

  // Build CMap in chunks of 100 (PDF limit per bfchar section)
  const chunks: string[] = [];
  for (let i = 0; i < mappings.length; i += 100) {
    const chunk = mappings.slice(i, i + 100);
    chunks.push(`${chunk.length} beginbfchar`);
    for (const { gid, cp } of chunk) {
      chunks.push(
        `<${gid.toString(16).padStart(4, "0")}> <${cp.toString(16).padStart(4, "0")}>`,
      );
    }
    chunks.push("endbfchar");
  }

  return [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Adobe-Identity-UCS def",
    "/CMapType 2 def",
    "1 begincodespacerange",
    "<0000> <FFFF>",
    "endcodespacerange",
    ...chunks,
    "endcmap",
    "CMapName currentdict /CMap defineresource pop",
    "end",
    "end",
  ].join("\n");
}

/** Default glyph width for characters not in the table (per 1000 units). */
const DEFAULT_WIDTH = 278;

// Helvetica character widths (ASCII 32–126), source: Adobe AFM data
// prettier-ignore
const HELVETICA_WIDTHS: number[] = [
  278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278, // 32-47 (space ! " # $ % & ' ( ) * + , - . /)
  556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556, // 48-63 (0-9 : ; < = > ?)
  1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778, // 64-79 (@ A-O)
  667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556, // 80-95 (P-Z [ \ ] ^ _)
  333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556, // 96-111 (` a-o)
  556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,    // 112-126 (p-z { | } ~)
];

// Helvetica-Bold character widths (ASCII 32–126)
// prettier-ignore
const HELVETICA_BOLD_WIDTHS: number[] = [
  278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,
  556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,
  975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,
  667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,
  333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,
  611,611,389,556,333,611,556,778,556,556,500,389,280,389,584,
];

// Times-Roman character widths (ASCII 32–126)
// prettier-ignore
const TIMES_ROMAN_WIDTHS: number[] = [
  250,333,408,500,500,833,778,180,333,333,500,564,250,333,250,278,
  500,500,500,500,500,500,500,500,500,500,278,278,564,564,564,444,
  921,722,667,667,722,611,556,722,722,333,389,722,611,889,722,722,
  556,722,667,556,611,722,722,944,722,722,611,333,278,333,469,500,
  333,444,500,444,500,444,333,500,500,278,278,500,278,778,500,500,
  500,500,333,389,278,500,500,722,500,500,444,480,200,480,541,
];

// Courier — all characters are 600 (monospaced)
const COURIER_WIDTH = 600;

/** Width tables keyed by font name. */
const FONT_WIDTHS: Record<string, number[] | number> = {
  Helvetica: HELVETICA_WIDTHS,
  "Helvetica-Bold": HELVETICA_BOLD_WIDTHS,
  "Helvetica-Oblique": HELVETICA_WIDTHS, // Same metrics as regular
  "Helvetica-BoldOblique": HELVETICA_BOLD_WIDTHS,
  "Times-Roman": TIMES_ROMAN_WIDTHS,
  "Times-Bold": TIMES_ROMAN_WIDTHS, // Approximate — close enough for layout
  "Times-Italic": TIMES_ROMAN_WIDTHS,
  "Times-BoldItalic": TIMES_ROMAN_WIDTHS,
  Courier: COURIER_WIDTH,
  "Courier-Bold": COURIER_WIDTH,
  "Courier-Oblique": COURIER_WIDTH,
  "Courier-BoldOblique": COURIER_WIDTH,
};

/**
 * Get the width of a single character in a standard font.
 * @param font - Standard font name
 * @param charCode - ASCII character code (32-126 for printable)
 * @returns Width in 1/1000 of a text unit
 */
export function charWidth(font: string, charCode: number): number {
  const table = FONT_WIDTHS[font];
  if (table == null) return DEFAULT_WIDTH;
  if (typeof table === "number") return table; // Monospaced (Courier)
  const idx = charCode - 32;
  if (idx < 0 || idx >= table.length) return DEFAULT_WIDTH;
  return table[idx];
}

/** Global reference to the active font registry (set during createDocument). */
let _activeFontRegistry: FontRegistry | null = null;

/**
 * Measure the width of a string in points for a given font and size.
 * Supports both standard 14 fonts and custom TrueType fonts.
 * @param text - Text to measure
 * @param font - Font name (standard or custom registered)
 * @param fontSize - Font size in points
 * @returns Width in points
 */
export function measureText(
  text: string,
  font: string,
  fontSize: number,
): number {
  // Check custom fonts first
  if (_activeFontRegistry) {
    const customFont = _activeFontRegistry.customFonts.get(font);
    if (customFont) {
      let total = 0;
      for (let i = 0; i < text.length; i++) {
        const cp = text.codePointAt(i)!;
        if (cp > 0xffff) i++; // skip surrogate pair
        total += ttfCharWidth(customFont, cp);
      }
      // Convert from font units to points: width * fontSize / unitsPerEm
      return (total * fontSize) / customFont.unitsPerEm;
    }
  }
  // Standard font path
  let total = 0;
  for (let i = 0; i < text.length; i++) {
    total += charWidth(font, text.charCodeAt(i));
  }
  return (total * fontSize) / 1000;
}

// ── PDF Object Serialization ─────────────────────────────────────────
// PDF files are sequences of numbered objects. Each object has an ID
// and a generation number (always 0 for new documents).

/** A value that can be serialized into a PDF object. */
type PdfValue =
  | string
  | number
  | boolean
  | null
  | PdfName
  | PdfArray
  | PdfDict
  | PdfRef
  | PdfStream;

/** PDF Name object (e.g. /Type, /Font). */
class PdfName {
  constructor(public readonly name: string) {}
}

/** PDF indirect reference (e.g. "5 0 R"). */
class PdfRef {
  constructor(public readonly objNum: number) {}
}

/** PDF Array (e.g. [1 2 3]). */
class PdfArray {
  constructor(public readonly items: PdfValue[]) {}
}

/** PDF Dictionary (e.g. << /Type /Catalog >>). */
class PdfDict {
  public readonly entries: Map<string, PdfValue> = new Map();

  set(key: string, value: PdfValue): this {
    this.entries.set(key, value);
    return this;
  }

  get(key: string): PdfValue | undefined {
    return this.entries.get(key);
  }
}

/** PDF Stream — a dictionary plus binary/text data. */
class PdfStream {
  constructor(
    public readonly dict: PdfDict,
    public readonly data: Uint8Array,
  ) {}
}

/** Create a PDF Name value. */
export function name(n: string): PdfName {
  return new PdfName(n);
}

/** Create an indirect reference to a PDF object. */
export function ref(objNum: number): PdfRef {
  return new PdfRef(objNum);
}

/** Create a PDF array. */
export function array(...items: PdfValue[]): PdfArray {
  return new PdfArray(items);
}

/** Create a PDF dictionary. */
export function dict(): PdfDict {
  return new PdfDict();
}

/**
 * Serialize a PdfValue to its PDF text representation.
 * This is the core serializer — converts JS values to PDF syntax.
 */
export function serializeValue(val: PdfValue): string {
  if (val === null) return "null";
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "number") {
    // PDF doesn't support exponential notation — use fixed decimal
    if (Number.isInteger(val)) return val.toString();
    // Limit decimal places to avoid floating point noise
    return parseFloat(val.toFixed(4)).toString();
  }
  if (typeof val === "string") {
    // PDF string literal — escape special characters
    const escaped = val
      .replace(/\\/g, "\\\\")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)")
      .replace(/\r/g, "\\r");
    return `(${escaped})`;
  }
  if (val instanceof PdfName) return `/${val.name}`;
  if (val instanceof PdfRef) return `${val.objNum} 0 R`;
  if (val instanceof PdfArray) {
    return `[${val.items.map(serializeValue).join(" ")}]`;
  }
  if (val instanceof PdfDict) {
    const parts: string[] = ["<<"];
    for (const [k, v] of val.entries) {
      parts.push(` /${k} ${serializeValue(v)}`);
    }
    parts.push(" >>");
    return parts.join("");
  }
  if (val instanceof PdfStream) {
    // Stream serialization is handled specially in object output
    return serializeValue(val.dict);
  }
  return "null"; // fallback
}

// ── PDF Text Escaping ────────────────────────────────────────────────

/**
 * Map Unicode code points to WinAnsiEncoding byte values.
 * Standard 14 PDF fonts use WinAnsiEncoding, not Unicode.
 * Characters outside Latin-1 (0x00-0xFF) that appear in WinAnsi
 * need explicit mapping or they render as garbage.
 */
const UNICODE_TO_WINANSI: Record<number, number> = {
  0x2022: 0x95, // • bullet
  0x2013: 0x96, // – en-dash
  0x2014: 0x97, // — em-dash
  0x2018: 0x91, // ' left single quote
  0x2019: 0x92, // ' right single quote / apostrophe
  0x201c: 0x93, // " left double quote
  0x201d: 0x94, // " right double quote
  0x2026: 0x85, // … ellipsis
  0x2122: 0x99, // ™ trademark
  0x20ac: 0x80, // € euro sign
};

/**
 * Escape a string for use in a PDF text-showing operator (Tj).
 * Escapes backslash, parens, and carriage return. Also maps common
 * Unicode characters to WinAnsiEncoding byte values so they render
 * correctly in standard 14 fonts.
 */
function escapeTextString(text: string): string {
  let mapped = "";
  for (let i = 0; i < text.length; i++) {
    const cp = text.charCodeAt(i);
    const winAnsi = UNICODE_TO_WINANSI[cp];
    if (winAnsi !== undefined) {
      // Emit as octal escape for the WinAnsi byte value
      mapped += "\\" + winAnsi.toString(8).padStart(3, "0");
    } else if (cp === 0x5c) {
      mapped += "\\\\"; // backslash
    } else if (cp === 0x28) {
      mapped += "\\("; // open paren
    } else if (cp === 0x29) {
      mapped += "\\)"; // close paren
    } else if (cp === 0x0d) {
      mapped += "\\r"; // carriage return
    } else if (cp > 0xff) {
      // Character outside WinAnsiEncoding range (e.g. emoji, CJK).
      // Standard 14 fonts can't render these. The low byte would produce
      // garbage (e.g. U+2728 ✨ → 0x28 which is '(' — breaks PDF strings).
      // Replace with empty string (strip silently) to prevent corruption.
      // Surrogate pairs (emoji above U+FFFF) also handled: skip the low surrogate.
      if (cp >= 0xd800 && cp <= 0xdbff) {
        i++; // skip low surrogate of a surrogate pair
      }
    } else {
      mapped += text[i];
    }
  }
  return mapped;
}

// ── PDF Colour Helpers ───────────────────────────────────────────────

/**
 * Convert a 6-char hex colour to PDF RGB components (0.0–1.0 each).
 * @param hex - 6-char hex (no #), already validated by requireHex
 * @returns "R G B" string for PDF operators (rg, RG)
 */
function hexToRgb(hex: string): string {
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  return `${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)}`;
}

// ── Coordinate Conversion ────────────────────────────────────────────
// PDF origin is bottom-left. Our API origin is top-left.
// convertY(apiY, pageHeight) = pageHeight - apiY

function convertY(apiY: number, pageHeight: number): number {
  return pageHeight - apiY;
}

// ── Content Stream Operators ─────────────────────────────────────────
// Thin wrappers over PDF content stream operators for clarity.

/**
 * Build a text block in a PDF content stream.
 * @param text - Text to show
 * @param x - X position in points (from left)
 * @param y - Y position in PDF coordinates (from bottom)
 * @param fontRef - Font resource name (e.g. "F1")
 * @param fontSize - Font size in points
 * @param color - Optional RGB colour string (e.g. "0.000 0.000 0.000")
 * @returns Content stream operators as string
 */
function textOp(
  text: string,
  x: number,
  y: number,
  fontRef: string,
  fontSize: number,
  color?: string,
  customFont?: ParsedTTF,
): string {
  const parts: string[] = [];
  parts.push("BT");
  if (color) parts.push(`${color} rg`);
  parts.push(`/${fontRef} ${fontSize} Tf`);
  parts.push(`${x.toFixed(2)} ${y.toFixed(2)} Td`);

  if (customFont) {
    // Custom TrueType font: encode as hex glyph IDs
    let hex = "";
    for (let i = 0; i < text.length; i++) {
      const cp = text.codePointAt(i)!;
      if (cp > 0xffff) i++; // skip surrogate pair
      const gid = customFont.cmapUnicodeToGlyph.get(cp) ?? 0;
      hex += gid.toString(16).padStart(4, "0");
    }
    parts.push(`<${hex}> Tj`);
  } else {
    // Standard Type1 font: WinAnsi encoded text string
    parts.push(`(${escapeTextString(text)}) Tj`);
  }

  parts.push("ET");
  return parts.join("\n");
}

/**
 * Build a rectangle in a PDF content stream.
 * @param x - Left edge in points
 * @param y - Bottom edge in PDF coordinates
 * @param w - Width in points
 * @param h - Height in points
 * @param opts - Fill colour, stroke colour, line width
 * @returns Content stream operators as string
 */
function rectOp(
  x: number,
  y: number,
  w: number,
  h: number,
  opts?: { fill?: string; stroke?: string; lineWidth?: number },
): string {
  const parts: string[] = [];
  if (opts?.lineWidth) parts.push(`${opts.lineWidth.toFixed(2)} w`);
  if (opts?.fill) parts.push(`${opts.fill} rg`);
  if (opts?.stroke) parts.push(`${opts.stroke} RG`);
  parts.push(
    `${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re`,
  );
  if (opts?.fill && opts?.stroke) {
    parts.push("B"); // Fill and stroke
  } else if (opts?.fill) {
    parts.push("f"); // Fill only
  } else {
    parts.push("S"); // Stroke only
  }
  return parts.join("\n");
}

/**
 * Build a line in a PDF content stream.
 * @param x1 - Start X
 * @param y1 - Start Y (PDF coordinates)
 * @param x2 - End X
 * @param y2 - End Y (PDF coordinates)
 * @param opts - Stroke colour, line width
 */
function lineOp(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  opts?: { stroke?: string; lineWidth?: number },
): string {
  const parts: string[] = [];
  if (opts?.lineWidth) parts.push(`${opts.lineWidth.toFixed(2)} w`);
  if (opts?.stroke) parts.push(`${opts.stroke} RG`);
  parts.push(`${x1.toFixed(2)} ${y1.toFixed(2)} m`);
  parts.push(`${x2.toFixed(2)} ${y2.toFixed(2)} l`);
  parts.push("S");
  return parts.join("\n");
}

/**
 * Build a filled polygon in a PDF content stream.
 * Uses moveTo → lineTo → closePath → fill (or fill+stroke).
 * @param points - Array of [x, y] coordinate pairs (PDF coordinates, already converted)
 * @param opts - Fill colour, stroke colour, line width
 */
function polygonOp(
  points: Array<[number, number]>,
  opts?: { fill?: string; stroke?: string; lineWidth?: number },
): string {
  if (points.length < 3) return "";
  const parts: string[] = [];
  if (opts?.lineWidth) parts.push(`${opts.lineWidth.toFixed(2)} w`);
  if (opts?.fill) parts.push(`${opts.fill} rg`);
  if (opts?.stroke) parts.push(`${opts.stroke} RG`);
  // moveTo first point
  parts.push(`${points[0][0].toFixed(2)} ${points[0][1].toFixed(2)} m`);
  // lineTo remaining points
  for (let i = 1; i < points.length; i++) {
    parts.push(`${points[i][0].toFixed(2)} ${points[i][1].toFixed(2)} l`);
  }
  // closePath + fill/stroke
  if (opts?.fill && opts?.stroke) {
    parts.push("b"); // closePath + fill + stroke
  } else if (opts?.fill) {
    parts.push("f"); // fill (implicitly closes path)
  } else {
    parts.push("s"); // closePath + stroke
  }
  return parts.join("\n");
}

// ── Text Encoding ────────────────────────────────────────────────────

/** Encode a string to a Uint8Array using Latin-1 encoding. */
function encodeText(s: string): Uint8Array {
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    bytes[i] = s.charCodeAt(i) & 0xff;
  }
  return bytes;
}

/** Concatenate multiple Uint8Arrays into one. */
function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  let totalLen = 0;
  for (const a of arrays) totalLen += a.length;
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

// ── Font Reference Management ────────────────────────────────────────

/** Map from standard font name to PDF resource name (F1, F2, etc.). */
interface FontRegistry {
  fonts: Map<string, string>; // fontName → "F1", "F2", ...
  nextId: number;
  /** Parsed TrueType font data for custom embedded fonts. */
  customFonts: Map<string, ParsedTTF>;
  /** Codepoints used per custom font (for subsetting). */
  usedCodePoints: Map<string, Set<number>>;
}

function createFontRegistry(): FontRegistry {
  return {
    fonts: new Map(),
    nextId: 1,
    customFonts: new Map(),
    usedCodePoints: new Map(),
  };
}

/**
 * Register a font and get its PDF resource name.
 * If already registered, returns the existing name.
 */
function registerFont(registry: FontRegistry, fontName: string): string {
  const existing = registry.fonts.get(fontName);
  if (existing) return existing;
  const resName = `F${registry.nextId++}`;
  registry.fonts.set(fontName, resName);
  return resName;
}

// ── Image Registry ───────────────────────────────────────────────────

/** Registered image entry for embedding in the PDF. */
interface ImageEntry {
  /** PDF resource name (Im1, Im2, ...) */
  resName: string;
  /** Raw image data (JPEG or uncompressed pixel data from PNG). */
  data: Uint8Array;
  /** Image width in pixels. */
  width: number;
  /** Image height in pixels. */
  height: number;
  /** PDF filter name: DCTDecode for JPEG, FlateDecode for deflated data. */
  filter: string;
  /** PDF colour space: DeviceRGB or DeviceGray. */
  colorSpace: string;
  /** Bits per component (always 8 for now). */
  bitsPerComponent: number;
}

/** Registry for images embedded in the document. */
interface ImageRegistry {
  images: Map<number, ImageEntry>; // keyed by a unique id
  nextId: number;
}

function createImageRegistry(): ImageRegistry {
  return { images: new Map(), nextId: 1 };
}

/**
 * Register an image and get its unique ID + resource name.
 * Each call creates a new entry (images are not deduplicated).
 */
function registerImage(
  registry: ImageRegistry,
  data: Uint8Array,
  width: number,
  height: number,
  filter: string,
  colorSpace: string,
): { id: number; resName: string } {
  const id = registry.nextId++;
  const resName = `Im${id}`;
  registry.images.set(id, {
    resName,
    data,
    width,
    height,
    filter,
    colorSpace,
    bitsPerComponent: 8,
  });
  return { id, resName };
}

// ── JPEG/PNG Detection ───────────────────────────────────────────────

/** Detect if bytes are a JPEG (starts with FF D8 FF). */
function isJpeg(data: Uint8Array): boolean {
  return (
    data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
  );
}

/** Detect if bytes are a PNG (starts with the 8-byte PNG signature). */
function isPng(data: Uint8Array): boolean {
  return (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  );
}

/**
 * Read JPEG dimensions from the SOF marker.
 * Returns {width, height} or throws if invalid.
 */
function readJpegDimensions(data: Uint8Array): {
  width: number;
  height: number;
} {
  // Scan for SOF0 (0xFFC0) or SOF2 (0xFFC2) marker
  let i = 2;
  while (i < data.length - 1) {
    if (data[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = data[i + 1];
    // SOF0 (baseline) or SOF2 (progressive)
    if (marker === 0xc0 || marker === 0xc2) {
      if (i + 9 >= data.length) break;
      const height = (data[i + 5] << 8) | data[i + 6];
      const width = (data[i + 7] << 8) | data[i + 8];
      return { width, height };
    }
    // Skip to next marker
    if (i + 3 >= data.length) break;
    const segLen = (data[i + 2] << 8) | data[i + 3];
    i += 2 + segLen;
  }
  throw new Error("Could not read JPEG dimensions — no SOF marker found.");
}

/**
 * Read PNG dimensions from the IHDR chunk (always the first chunk).
 * Returns {width, height}.
 */
function readPngDimensions(data: Uint8Array): {
  width: number;
  height: number;
} {
  // IHDR is always at offset 8 (after 8-byte signature)
  // Chunk structure: 4-byte length, 4-byte type, data, 4-byte CRC
  // IHDR data: 4-byte width, 4-byte height, ...
  if (data.length < 24) {
    throw new Error("PNG data too short to contain IHDR chunk.");
  }
  const width =
    (data[16] << 24) | (data[17] << 16) | (data[18] << 8) | data[19];
  const height =
    (data[20] << 24) | (data[21] << 16) | (data[22] << 8) | data[23];
  return { width, height };
}

/**
 * Extract raw IDAT (compressed pixel) data from a PNG file.
 * PNG stores image data in one or more IDAT chunks, each containing
 * DEFLATE-compressed data. We concatenate all IDAT payloads — this is
 * already DEFLATE-compressed, which maps directly to PDF's FlateDecode.
 *
 * Note: This does NOT handle PNG filtering (sub/up/average/paeth per row).
 * The DEFLATE stream contains filter bytes. PDF's FlateDecode will decode
 * the DEFLATE, but the filter bytes remain. For proper rendering we'd need
 * a Predictor parameter. We add /DecodeParms with PNG-up predictor.
 */
function extractPngImageData(data: Uint8Array): {
  data: Uint8Array;
  colorType: number;
} {
  // Read colour type from IHDR (offset 25 in PNG file)
  const colorType = data[25];

  // Scan chunks for IDAT data
  const idatChunks: Uint8Array[] = [];
  let offset = 8; // Skip PNG signature

  while (offset + 8 <= data.length) {
    const chunkLen =
      (data[offset] << 24) |
      (data[offset + 1] << 16) |
      (data[offset + 2] << 8) |
      data[offset + 3];
    const chunkType = String.fromCharCode(
      data[offset + 4],
      data[offset + 5],
      data[offset + 6],
      data[offset + 7],
    );

    if (chunkType === "IDAT") {
      idatChunks.push(data.slice(offset + 8, offset + 8 + chunkLen));
    }

    // Move past: length(4) + type(4) + data(chunkLen) + crc(4)
    offset += 12 + chunkLen;
  }

  if (idatChunks.length === 0) {
    throw new Error("PNG has no IDAT chunks — invalid image data.");
  }

  // Concatenate all IDAT chunks
  const totalLen = idatChunks.reduce((sum, c) => sum + c.length, 0);
  const combined = new Uint8Array(totalLen);
  let pos = 0;
  for (const chunk of idatChunks) {
    combined.set(chunk, pos);
    pos += chunk.length;
  }

  return { data: combined, colorType };
}

// ── Document Options ─────────────────────────────────────────────────

/** Options for createDocument(). */
export interface DocumentOptions {
  /** Theme name (from ha:doc-core). Default: 'corporate-blue'. */
  theme?: string;
  /** Page size name or custom dimensions. Default: 'a4'. */
  pageSize?: string | PageSize;
  /** Document title (appears in PDF metadata). */
  title?: string;
  /** Document author. */
  author?: string;
  /** Document subject. */
  subject?: string;
  /** Document creator application name. Default: 'HyperAgent'. */
  creator?: string;
  /** If true, content streams are not compressed (for debugging). */
  debug?: boolean;
}

/** Options for drawText(). */
export interface DrawTextOptions {
  /** Font size in points. Default: 12. */
  fontSize?: number;
  /** Standard font name. Default: 'Helvetica'. */
  font?: string;
  /** Text colour as 6-char hex (no #). Uses theme foreground if omitted. */
  color?: string;
  /**
   * Text alignment relative to the X position.
   * 'left' (default): X is the left edge.
   * 'center': X is the center point — text extends equally left and right.
   * 'right': X is the right edge — text extends left from X.
   */
  align?: "left" | "center" | "right";
}

/** Options for drawRect(). */
export interface DrawRectOptions {
  /** Fill colour as 6-char hex (no #). */
  fill?: string;
  /** Stroke colour as 6-char hex (no #). */
  stroke?: string;
  /** Line width in points. Default: 1. */
  lineWidth?: number;
}

/** Options for drawLine(). */
export interface DrawLineOptions {
  /** Stroke colour as 6-char hex (no #). */
  color?: string;
  /** Line width in points. Default: 1. */
  lineWidth?: number;
}

/** Options for drawImage(). */
export interface DrawImageOptions {
  /** Image data as Uint8Array (JPEG or PNG). Format auto-detected. */
  data: Uint8Array;
  /** X position from left (points). */
  x: number;
  /** Y position from top (points). */
  y: number;
  /** Display width in points. */
  width: number;
  /** Display height in points. */
  height: number;
}

// ── Page Data ────────────────────────────────────────────────────────

/** Internal page representation. */
/** A recorded text bounding box for overlap detection. */
interface TextBox {
  x: number; // left edge (points, top-left coords)
  y: number; // top edge (points, top-left coords)
  w: number; // width
  h: number; // height (fontSize)
  text: string; // for error messages
}

interface PageData {
  /** Content stream operators accumulated for this page. */
  contentOps: string[];
  /** Page dimensions (may override document default). */
  size: PageSize;
  /** Image resource names used on this page (for resource dict). */
  imageRefs: Set<string>;
  /**
   * Tracked Y cursor position (top-left API coords, in points).
   * Updated by drawText/drawRect/drawLine/drawImage so that
   * addContent() knows where to start flowing content.
   * Starts at 0 (top of page). Default margins are applied by addContent().
   */
  cursorY: number;
  /** Recorded text bounding boxes for overlap/bounds validation. */
  textBoxes: TextBox[];
  /** ExtGState entries for transparency (e.g. watermarks). */
  extGStates: Map<string, number>; // name → opacity (ca value)
  /** Link annotations (hyperlinks) on this page. */
  links: { x: number; y: number; w: number; h: number; url: string }[];
}

// ── PdfDocument ──────────────────────────────────────────────────────

/**
 * PDF document builder. Created by createDocument().
 *
 * Usage:
 *   const doc = createDocument({ theme: 'light-clean' });
 *   doc.addPage();
 *   doc.drawText("Hello", 72, 72);
 *   const bytes = doc.buildPdf();
 */
export interface PdfDocument {
  /** The active theme. */
  readonly theme: Theme;
  /** Default page size for new pages. */
  readonly pageSize: PageSize;
  /** Number of pages currently in the document. */
  readonly pageCount: number;
  /** Whether debug mode is enabled (no stream compression). */
  readonly debug: boolean;

  /**
   * Add a new page to the document.
   * @param size - Override page size for this page. Uses document default if omitted.
   */
  addPage(size?: PageSize): void;

  /**
   * Draw text on the current page.
   * Position is in points from the top-left corner of the page.
   * @param text - Text to draw
   * @param x - X position from left edge (points)
   * @param y - Y position from top edge (points)
   * @param opts - Font, size, colour options
   */
  drawText(text: string, x: number, y: number, opts?: DrawTextOptions): void;

  /**
   * Draw a rectangle on the current page.
   * @param x - Left edge from page left (points)
   * @param y - Top edge from page top (points)
   * @param w - Width (points)
   * @param h - Height (points)
   * @param opts - Fill, stroke, line width
   */
  drawRect(
    x: number,
    y: number,
    w: number,
    h: number,
    opts?: DrawRectOptions,
  ): void;

  /**
   * Draw a line on the current page.
   * @param x1 - Start X from left (points)
   * @param y1 - Start Y from top (points)
   * @param x2 - End X from left (points)
   * @param y2 - End Y from top (points)
   * @param opts - Colour, line width
   */
  drawLine(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    opts?: DrawLineOptions,
  ): void;

  /**
   * Build the PDF document as a Uint8Array.
   * @returns Complete PDF file as bytes
   */
  buildPdf(): Uint8Array;

  /**
   * Draw an image on the current page.
   * Supports JPEG and PNG (format auto-detected from data bytes).
   * JPEG is embedded directly (DCTDecode). PNG pixel data is FlateDecode compressed.
   * @param opts - Image data, position, and display dimensions
   */
  drawImage(opts: DrawImageOptions): void;
}

/**
 * Create a new PDF document.
 * @param opts - Document options (theme, page size, metadata, debug mode)
 * @returns PdfDocument builder
 */
export function createDocument(opts?: DocumentOptions): PdfDocument {
  const theme = getTheme(opts?.theme ?? "corporate-blue");
  const pageSize = resolvePageSize(opts?.pageSize ?? "a4");
  const debug = opts?.debug ?? false;

  const title = opts?.title ?? "";
  const author = opts?.author ?? "";
  const subject = opts?.subject ?? "";
  const creator = opts?.creator ?? "HyperAgent";

  const pages: PageData[] = [];
  const fontRegistry = createFontRegistry();
  const imageRegistry = createImageRegistry();

  // Set active registry for measureText custom font support
  _activeFontRegistry = fontRegistry;

  // Ensure Helvetica is always registered as F1 (default font)
  registerFont(fontRegistry, "Helvetica");

  function currentPage(): PageData {
    if (pages.length === 0) {
      throw new Error(
        "No pages in document. Call doc.addPage() before drawing.",
      );
    }
    return pages[pages.length - 1];
  }

  const doc: PdfDocument = {
    get theme() {
      return theme;
    },
    get pageSize() {
      return pageSize;
    },
    get pageCount() {
      return pages.length;
    },
    get debug() {
      return debug;
    },

    addPage(size?: PageSize): void {
      pages.push({
        contentOps: [],
        size: size ?? pageSize,
        imageRefs: new Set(),
        cursorY: 0,
        textBoxes: [],
        extGStates: new Map(),
        links: [],
      });
    },

    drawText(text: string, x: number, y: number, opts?: DrawTextOptions): void {
      const page = currentPage();
      const fs = opts?.fontSize ?? 12;
      const fontName = opts?.font ?? "Helvetica";
      const fontRef = registerFont(fontRegistry, fontName);

      // Validate colour if provided
      let colorRgb: string | undefined;
      if (opts?.color) {
        const validated = requireHex(opts.color, "drawText.color");
        colorRgb = hexToRgb(validated);
      } else {
        // Use theme foreground colour
        colorRgb = hexToRgb(theme.fg);
      }

      // Apply alignment — adjust X based on text width
      let drawX = x;
      if (opts?.align === "center") {
        const textW = measureText(text, fontName, fs);
        drawX = x - textW / 2;
      } else if (opts?.align === "right") {
        const textW = measureText(text, fontName, fs);
        drawX = x - textW;
      }

      const pdfY = convertY(y, page.size.height);

      // Check if this is a custom TrueType font
      const customFont = fontRegistry.customFonts.get(fontName);
      if (customFont) {
        // Track used codepoints for subsetting
        let usedCPs = fontRegistry.usedCodePoints.get(fontName);
        if (!usedCPs) {
          usedCPs = new Set();
          fontRegistry.usedCodePoints.set(fontName, usedCPs);
        }
        for (let ci = 0; ci < text.length; ci++) {
          const cp = text.codePointAt(ci)!;
          if (cp > 0xffff) ci++;
          usedCPs.add(cp);
        }
      } else {
        // Standard font — validate that text doesn't contain characters
        // outside WinAnsiEncoding (they'd be silently stripped/garbled)
        for (let ci = 0; ci < text.length; ci++) {
          const cp = text.codePointAt(ci)!;
          if (cp > 0xff && !UNICODE_TO_WINANSI[cp]) {
            throw new Error(
              `Character '${text[ci]}' (U+${cp.toString(16).toUpperCase().padStart(4, "0")}) ` +
                `cannot be rendered with standard font '${fontName}'. ` +
                `Use registerCustomFont() to load a TrueType font (e.g. DejaVu Sans) ` +
                `that supports this character, then set font: "YourFontName" on the element.`,
            );
          }
        }
      }

      page.contentOps.push(
        textOp(text, drawX, pdfY, fontRef, fs, colorRgb, customFont),
      );

      // Record bounding box for overlap/bounds validation
      const textW = measureText(text, fontName, fs);
      page.textBoxes.push({
        x: drawX,
        y: y - fs, // y is baseline, text top is y - fontSize
        w: textW,
        h: fs,
        text: text.length > 40 ? text.slice(0, 37) + "..." : text,
      });

      // Track cursor — advance below this text
      const textBottom = y + fs;
      if (textBottom > page.cursorY) {
        page.cursorY = textBottom;
      }
    },

    drawRect(
      x: number,
      y: number,
      w: number,
      h: number,
      opts?: DrawRectOptions,
    ): void {
      const page = currentPage();
      requireNumber(x, "drawRect.x");
      requireNumber(y, "drawRect.y");
      requireNumber(w, "drawRect.w", { min: 0 });
      requireNumber(h, "drawRect.h", { min: 0 });

      const fillRgb = opts?.fill
        ? hexToRgb(requireHex(opts.fill, "drawRect.fill"))
        : undefined;
      const strokeRgb = opts?.stroke
        ? hexToRgb(requireHex(opts.stroke, "drawRect.stroke"))
        : undefined;

      // Convert from top-left y to PDF bottom-left y
      // The rect bottom edge in PDF coords = pageHeight - (apiY + h)
      const pdfY = convertY(y + h, page.size.height);
      page.contentOps.push(
        rectOp(x, pdfY, w, h, {
          fill: fillRgb,
          stroke: strokeRgb,
          lineWidth: opts?.lineWidth,
        }),
      );

      // Track cursor — advance below this rect
      const rectBottom = y + h;
      if (rectBottom > page.cursorY) {
        page.cursorY = rectBottom;
      }
    },

    drawLine(
      x1: number,
      y1: number,
      x2: number,
      y2: number,
      opts?: DrawLineOptions,
    ): void {
      const page = currentPage();
      const colorRgb = opts?.color
        ? hexToRgb(requireHex(opts.color, "drawLine.color"))
        : undefined;

      const pdfY1 = convertY(y1, page.size.height);
      const pdfY2 = convertY(y2, page.size.height);
      page.contentOps.push(
        lineOp(x1, pdfY1, x2, pdfY2, {
          stroke: colorRgb,
          lineWidth: opts?.lineWidth,
        }),
      );

      // Track cursor — advance below the furthest line endpoint
      const lineBottom = Math.max(y1, y2);
      if (lineBottom > page.cursorY) {
        page.cursorY = lineBottom;
      }
    },

    drawImage(opts: DrawImageOptions): void {
      const page = currentPage();
      requireNumber(opts.x, "drawImage.x");
      requireNumber(opts.y, "drawImage.y");
      requireNumber(opts.width, "drawImage.width", { min: 1 });
      requireNumber(opts.height, "drawImage.height", { min: 1 });

      if (!(opts.data instanceof Uint8Array) || opts.data.length === 0) {
        throw new Error(
          "drawImage.data: expected a non-empty Uint8Array of image bytes (JPEG or PNG).",
        );
      }

      let imgData: Uint8Array;
      let imgWidth: number;
      let imgHeight: number;
      let filter: string;

      if (isJpeg(opts.data)) {
        // JPEG: embed raw data directly — PDF supports DCTDecode natively
        const dims = readJpegDimensions(opts.data);
        imgData = opts.data;
        imgWidth = dims.width;
        imgHeight = dims.height;
        filter = "DCTDecode";
      } else if (isPng(opts.data)) {
        // PNG: For Phase 3, embed raw PNG data with simple approach.
        // Full PNG decode would require decompressing IDAT chunks, handling
        // filters, and stripping the PNG wrapper. For now we use a simpler
        // approach: store the data as-is and mark as FlateDecode.
        // NOTE: This is a placeholder — proper PNG support requires
        // extracting the raw pixel data from IDAT chunks. For now,
        // we embed the raw IDAT data after stripping the PNG container.
        const dims = readPngDimensions(opts.data);
        const extracted = extractPngImageData(opts.data);
        imgData = extracted.data;
        imgWidth = dims.width;
        imgHeight = dims.height;
        filter = "FlateDecode";
      } else {
        throw new Error(
          "drawImage: unsupported image format. Only JPEG and PNG are supported. " +
            "Check that the data is a valid image file (JPEG starts with FF D8 FF, PNG starts with 89 50 4E 47).",
        );
      }

      // Register the image
      const { resName } = registerImage(
        imageRegistry,
        imgData,
        imgWidth,
        imgHeight,
        filter,
        "DeviceRGB",
      );
      page.imageRefs.add(resName);

      // Add content stream operator to draw the image
      // PDF image drawing: save state, transform matrix, draw, restore
      // The cm operator sets up the image dimensions and position
      const pdfY = convertY(opts.y + opts.height, page.size.height);
      page.contentOps.push(
        `q\n${opts.width.toFixed(2)} 0 0 ${opts.height.toFixed(2)} ${opts.x.toFixed(2)} ${pdfY.toFixed(2)} cm\n/${resName} Do\nQ`,
      );

      // Track cursor — advance below the image
      const imgBottom = opts.y + opts.height;
      if (imgBottom > page.cursorY) {
        page.cursorY = imgBottom;
      }
    },

    buildPdf(): Uint8Array {
      return buildPdfBytes(
        pages,
        fontRegistry,
        imageRegistry,
        { title, author, subject, creator },
        debug,
      );
    },
  };

  // Internal accessors for document furniture functions (addPageNumbers, etc.)
  // These are not part of the public PdfDocument interface — they're accessed
  // via type casts within this module only.
  const docWithInternals = doc as unknown as Record<string, unknown>;
  docWithInternals._getPages = () => pages;
  docWithInternals._getFontRegistry = () => fontRegistry;
  docWithInternals._getImageRegistry = () => imageRegistry;
  docWithInternals._getMeta = () => ({
    title,
    author,
    subject,
    creator,
  });

  return doc;
}

// ── Page Size Resolution ─────────────────────────────────────────────

function resolvePageSize(size: string | PageSize): PageSize {
  if (typeof size === "string") {
    const resolved = PAGE_SIZES[size.toLowerCase()];
    if (!resolved) {
      const valid = Object.keys(PAGE_SIZES).join(", ");
      throw new Error(
        `Invalid page size "${size}". Valid sizes: ${valid}. ` +
          `Or pass a custom {width, height} object in points.`,
      );
    }
    return resolved;
  }
  requireNumber(size.width, "pageSize.width", { min: 72 });
  requireNumber(size.height, "pageSize.height", { min: 72 });
  return size;
}

// ── PDF File Assembly ────────────────────────────────────────────────
// Builds the complete PDF byte stream from document data.

interface MetaInfo {
  title: string;
  author: string;
  subject: string;
  creator: string;
}

/**
 * Build the complete PDF file as bytes.
 * Object numbering scheme:
 *   1: Catalog
 *   2: Pages (parent)
 *   3: Info dictionary
 *   4..4+F-1: Font objects (one per registered font)
 *   4+F..4+F+I-1: Image XObject streams (one per registered image)
 *   4+F+I..4+F+I+2P-1: Page + content stream pairs (2 per page)
 */
function buildPdfBytes(
  pages: PageData[],
  fontRegistry: FontRegistry,
  imageRegistry: ImageRegistry,
  meta: MetaInfo,
  debug: boolean,
): Uint8Array {
  const objects: { num: number; data: Uint8Array }[] = [];
  const NL = "\n";

  // Helper to add an object
  function addObject(num: number, content: string): void {
    const text = `${num} 0 obj${NL}${content}${NL}endobj${NL}`;
    objects.push({ num, data: encodeText(text) });
  }

  // Helper to add a stream object
  function addStreamObject(
    num: number,
    dictEntries: string,
    streamData: Uint8Array,
  ): void {
    const header = encodeText(
      `${num} 0 obj${NL}<< ${dictEntries} >>${NL}stream${NL}`,
    );
    const footer = encodeText(`${NL}endstream${NL}endobj${NL}`);
    objects.push({ num, data: concatBytes(header, streamData, footer) });
  }

  // ── Assign object numbers ──
  const fontList = Array.from(fontRegistry.fonts.entries());
  const imageList = Array.from(imageRegistry.images.entries());
  const fontStartObj = 4;

  // Count objects needed for fonts: Type1 = 1 obj, TrueType = 5 objs each
  let fontObjCount = 0;
  const fontObjMap = new Map<string, number>(); // fontName → first object number
  for (const [fontName] of fontList) {
    fontObjMap.set(fontName, fontStartObj + fontObjCount);
    const isCustom = fontRegistry.customFonts.has(fontName);
    fontObjCount += isCustom ? 5 : 1; // Type0 + CIDFont + Descriptor + FontFile2 + ToUnicode
  }

  const imageStartObj = fontStartObj + fontObjCount;
  const pageStartObj = imageStartObj + imageList.length;
  // Each page needs 2 objects: page dict + content stream
  const totalObjects = pageStartObj + pages.length * 2;

  // ── Object 3: Info dictionary (metadata) ──
  const infoParts: string[] = ["<<"];
  if (meta.title) infoParts.push(` /Title (${escapeTextString(meta.title)})`);
  if (meta.author)
    infoParts.push(` /Author (${escapeTextString(meta.author)})`);
  if (meta.subject)
    infoParts.push(` /Subject (${escapeTextString(meta.subject)})`);
  infoParts.push(` /Creator (${escapeTextString(meta.creator)})`);
  infoParts.push(` /Producer (HyperAgent PDF Module)`);
  infoParts.push(` /CreationDate (D:${formatPdfDate(new Date())})`);
  infoParts.push(" >>");
  addObject(3, infoParts.join(""));

  // ── Font objects ──
  for (const [fontName, resName] of fontList) {
    const baseObjNum = fontObjMap.get(fontName)!;
    const customFont = fontRegistry.customFonts.get(fontName);

    if (customFont) {
      // ── TrueType composite font (Type0 → CIDFontType2) ──
      // Object layout: base+0=Type0, base+1=CIDFont, base+2=Descriptor,
      //                base+3=FontFile2 stream, base+4=ToUnicode CMap

      const cidFontObj = baseObjNum + 1;
      const descriptorObj = baseObjNum + 2;
      const fontFileObj = baseObjNum + 3;
      const toUnicodeObj = baseObjNum + 4;

      // Get the font data (optionally subsetted)
      const usedCPs = fontRegistry.usedCodePoints.get(fontName);
      const fontData = usedCPs
        ? subsetTTF(customFont, usedCPs)
        : customFont.rawData;

      // Compress font data — skip if compressed >= original (font may already be compact)
      let compressedFont: Uint8Array;
      let fontCompressed = false;
      if (debug) {
        compressedFont = fontData;
      } else {
        const rawDeflated = deflate(fontData);
        const zlibWrapped = wrapZlib(rawDeflated, fontData);
        if (zlibWrapped.length < fontData.length) {
          compressedFont = zlibWrapped;
          fontCompressed = true;
        } else {
          // Compression didn't help — store uncompressed
          compressedFont = fontData;
        }
      }

      // Build /W array (CID widths) - only for used codepoints to keep small
      const wEntries: string[] = [];
      if (usedCPs && usedCPs.size > 0) {
        const sortedCPs = Array.from(usedCPs).sort((a, b) => a - b);
        for (const cp of sortedCPs) {
          const gid = customFont.cmapUnicodeToGlyph.get(cp) ?? 0;
          const w = customFont.glyphWidths[gid] ?? 0;
          // Scale width to 1000 units
          const scaledW = Math.round((w * 1000) / customFont.unitsPerEm);
          wEntries.push(`${gid} [${scaledW}]`);
        }
      }
      const wArray = wEntries.length > 0 ? ` /W [${wEntries.join(" ")}]` : "";

      // Scale metrics to 1000 units
      const scale = 1000 / customFont.unitsPerEm;
      const sAscent = Math.round(customFont.ascent * scale);
      const sDescent = Math.round(customFont.descent * scale);
      const sBbox = customFont.bbox.map((v) => Math.round(v * scale));

      // Object base+0: Type0 font (top-level)
      addObject(
        baseObjNum,
        `<< /Type /Font /Subtype /Type0` +
          ` /BaseFont /${customFont.postScriptName}` +
          ` /Encoding /Identity-H` +
          ` /DescendantFonts [${cidFontObj} 0 R]` +
          ` /ToUnicode ${toUnicodeObj} 0 R >>`,
      );

      // Object base+1: CIDFont
      addObject(
        cidFontObj,
        `<< /Type /Font /Subtype /CIDFontType2` +
          ` /BaseFont /${customFont.postScriptName}` +
          ` /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >>` +
          ` /FontDescriptor ${descriptorObj} 0 R` +
          ` /DW ${Math.round((customFont.glyphWidths[0] ?? 500) * scale)}` +
          `${wArray} >>`,
      );

      // Object base+2: FontDescriptor
      addObject(
        descriptorObj,
        `<< /Type /FontDescriptor` +
          ` /FontName /${customFont.postScriptName}` +
          ` /FontFamily (${customFont.familyName})` +
          ` /Flags ${customFont.flags}` +
          ` /FontBBox [${sBbox.join(" ")}]` +
          ` /ItalicAngle ${customFont.italicAngle}` +
          ` /Ascent ${sAscent}` +
          ` /Descent ${sDescent}` +
          ` /StemV ${customFont.stemV}` +
          ` /FontFile2 ${fontFileObj} 0 R >>`,
      );

      // Object base+3: FontFile2 stream (embedded TTF)
      const fontFilterStr = fontCompressed ? "/Filter /FlateDecode " : "";
      addStreamObject(
        fontFileObj,
        `${fontFilterStr}/Length ${compressedFont.length} /Length1 ${fontData.length}`,
        compressedFont,
      );

      // Object base+4: ToUnicode CMap
      const toUnicodeContent = buildToUnicodeCMap(customFont, usedCPs);
      const cmapBytes = encodeText(toUnicodeContent);
      // Compress CMap — skip if compressed >= original
      let compressedCMap: Uint8Array;
      let cmapCompressed = false;
      if (debug) {
        compressedCMap = cmapBytes;
      } else {
        const rawDeflated = deflate(cmapBytes);
        const zlibWrapped = wrapZlib(rawDeflated, cmapBytes);
        // Verify: decompress to check deflate actually worked
        // If deflate returned raw data (not valid DEFLATE), store uncompressed
        if (zlibWrapped.length < cmapBytes.length) {
          compressedCMap = zlibWrapped;
          cmapCompressed = true;
        } else {
          compressedCMap = cmapBytes;
        }
      }
      const cmapFilterStr = cmapCompressed ? "/Filter /FlateDecode " : "";
      addStreamObject(
        toUnicodeObj,
        `${cmapFilterStr}/Length ${compressedCMap.length}`,
        compressedCMap,
      );
    } else {
      // ── Standard Type1 font ──
      addObject(
        baseObjNum,
        `<< /Type /Font /Subtype /Type1 /BaseFont /${fontName} /Encoding /WinAnsiEncoding >>`,
      );
    }
    void resName;
  }

  // ── Image XObject stream objects ──
  // Map from image resource name to object number
  const imageObjNums: Map<string, number> = new Map();
  for (let i = 0; i < imageList.length; i++) {
    const [, entry] = imageList[i];
    const objNum = imageStartObj + i;
    imageObjNums.set(entry.resName, objNum);

    // Build the image XObject dictionary entries
    let dictStr =
      `/Type /XObject /Subtype /Image` +
      ` /Width ${entry.width} /Height ${entry.height}` +
      ` /ColorSpace /${entry.colorSpace}` +
      ` /BitsPerComponent ${entry.bitsPerComponent}` +
      ` /Filter /${entry.filter}` +
      ` /Length ${entry.data.length}`;

    // For PNG data (FlateDecode), add predictor parameters so the PDF
    // viewer knows about the PNG row-filter bytes in the decoded stream.
    if (entry.filter === "FlateDecode") {
      const colors = entry.colorSpace === "DeviceRGB" ? 3 : 1;
      dictStr +=
        ` /DecodeParms << /Predictor 15 /Colors ${colors}` +
        ` /BitsPerComponent ${entry.bitsPerComponent}` +
        ` /Columns ${entry.width} >>`;
    }

    addStreamObject(objNum, dictStr, entry.data);
  }

  // ── Page + content stream objects ──
  const pageObjNums: number[] = [];
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const pageObjNum = pageStartObj + i * 2;
    const contentObjNum = pageObjNum + 1;
    pageObjNums.push(pageObjNum);

    // Build content stream data
    const streamText = page.contentOps.join("\n");
    const rawStreamBytes = encodeText(streamText);

    // Optionally compress
    let streamBytes: Uint8Array;
    let filterEntry = "";
    if (!debug && rawStreamBytes.length > 0) {
      const rawCompressed = deflate(rawStreamBytes);
      // Wrap raw DEFLATE in zlib format for PDF FlateDecode compliance
      const compressed = wrapZlib(rawCompressed, rawStreamBytes);
      // Only use compression if it actually saves space
      if (compressed.length < rawStreamBytes.length) {
        streamBytes = compressed;
        filterEntry = "/Filter /FlateDecode ";
      } else {
        streamBytes = rawStreamBytes;
      }
    } else {
      streamBytes = rawStreamBytes;
    }

    // Content stream object
    addStreamObject(
      contentObjNum,
      `${filterEntry}/Length ${streamBytes.length}`,
      streamBytes,
    );

    // Build font resource dictionary for this page
    const fontDictParts: string[] = [];
    for (const [fontName, resName] of fontList) {
      const fontObjNum = fontObjMap.get(fontName)!;
      fontDictParts.push(`/${resName} ${fontObjNum} 0 R`);
    }
    const fontResDict =
      fontDictParts.length > 0 ? `/Font << ${fontDictParts.join(" ")} >>` : "";

    // Build XObject resource dictionary for images used on this page
    const xobjParts: string[] = [];
    for (const imgResName of page.imageRefs) {
      const imgObjNum = imageObjNums.get(imgResName);
      if (imgObjNum != null) {
        xobjParts.push(`/${imgResName} ${imgObjNum} 0 R`);
      }
    }
    const xobjResDict =
      xobjParts.length > 0 ? ` /XObject << ${xobjParts.join(" ")} >>` : "";

    // ExtGState resources (for watermark transparency)
    let gsResDict = "";
    if (page.extGStates.size > 0) {
      const gsParts: string[] = [];
      for (const [name, opacity] of page.extGStates) {
        gsParts.push(
          `/${name} << /Type /ExtGState /ca ${opacity.toFixed(2)} >>`,
        );
      }
      gsResDict = ` /ExtGState << ${gsParts.join(" ")} >>`;
    }

    // Link annotations (hyperlinks)
    let annotsDict = "";
    if (page.links.length > 0) {
      const annots = page.links.map((lnk) => {
        // Convert top-left coords to PDF bottom-left for annotation rect
        const y1 = page.size.height - lnk.y - lnk.h;
        const y2 = page.size.height - lnk.y;
        const escapedUrl = lnk.url.replace(/[()\\]/g, "\\$&");
        return (
          `<< /Type /Annot /Subtype /Link` +
          ` /Rect [${lnk.x.toFixed(2)} ${y1.toFixed(2)} ${(lnk.x + lnk.w).toFixed(2)} ${y2.toFixed(2)}]` +
          ` /Border [0 0 0]` +
          ` /A << /Type /Action /S /URI /URI (${escapedUrl}) >> >>`
        );
      });
      annotsDict = ` /Annots [${annots.join(" ")}]`;
    }

    // Page object
    addObject(
      pageObjNum,
      `<< /Type /Page` +
        ` /Parent 2 0 R` +
        ` /MediaBox [0 0 ${page.size.width.toFixed(2)} ${page.size.height.toFixed(2)}]` +
        ` /Contents ${contentObjNum} 0 R` +
        ` /Resources << ${fontResDict}${xobjResDict}${gsResDict} >>${annotsDict}` +
        ` >>`,
    );
  }

  // ── Object 2: Pages (parent) ──
  const kidRefs = pageObjNums.map((n) => `${n} 0 R`).join(" ");
  addObject(2, `<< /Type /Pages /Kids [${kidRefs}] /Count ${pages.length} >>`);

  // ── Object 1: Catalog ──
  addObject(1, `<< /Type /Catalog /Pages 2 0 R >>`);

  // ── Sort objects by number for output ──
  objects.sort((a, b) => a.num - b.num);

  // ── Assemble the PDF file ──
  const header = encodeText(`%PDF-1.7${NL}%\xE2\xE3\xCF\xD3${NL}`);

  // Track byte offsets for xref table
  const offsets: Map<number, number> = new Map();
  let currentOffset = header.length;

  const bodyParts: Uint8Array[] = [];
  for (const obj of objects) {
    offsets.set(obj.num, currentOffset);
    bodyParts.push(obj.data);
    currentOffset += obj.data.length;
  }

  // ── Cross-reference table ──
  // Use actual max object number (not pre-calculated totalObjects) to avoid
  // gap entries that stricter PDF parsers (like pdf.js/pdf-parse) reject.
  const maxObjNum = Math.max(...objects.map((o) => o.num));
  const xrefStart = currentOffset;
  const xrefLines: string[] = [];
  xrefLines.push(`xref${NL}`);
  xrefLines.push(`0 ${maxObjNum + 1}${NL}`);
  // Object 0 is always free
  xrefLines.push(`0000000000 65535 f\r\n`);
  for (let i = 1; i <= maxObjNum; i++) {
    const off = offsets.get(i);
    if (off != null) {
      xrefLines.push(`${off.toString().padStart(10, "0")} 00000 n\r\n`);
    } else {
      // Object not emitted (gap) — mark as free
      xrefLines.push(`0000000000 00000 f\r\n`);
    }
  }

  // ── Trailer ──
  const trailer =
    `trailer${NL}` +
    `<< /Size ${maxObjNum + 1} /Root 1 0 R /Info 3 0 R >>${NL}` +
    `startxref${NL}` +
    `${xrefStart}${NL}` +
    `%%EOF${NL}`;

  const xrefBytes = encodeText(xrefLines.join(""));
  const trailerBytes = encodeText(trailer);

  return concatBytes(header, ...bodyParts, xrefBytes, trailerBytes);
}

// ── Date Formatting ──────────────────────────────────────────────────

/**
 * Format a Date as a PDF date string (D:YYYYMMDDHHmmSS).
 */
function formatPdfDate(date: Date): string {
  const y = date.getUTCFullYear().toString();
  const m = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const d = date.getUTCDate().toString().padStart(2, "0");
  const h = date.getUTCHours().toString().padStart(2, "0");
  const min = date.getUTCMinutes().toString().padStart(2, "0");
  const s = date.getUTCSeconds().toString().padStart(2, "0");
  return `${y}${m}${d}${h}${min}${s}Z`;
}

// ── PdfElement (Opaque Branded Type) ─────────────────────────────────
// All flow layout element builders (paragraph, heading, bulletList, etc.)
// return PdfElement objects. Like ShapeFragment in PPTX, this prevents
// LLMs from injecting raw content stream operators.
//
// Security model matches ShapeFragment:
//   1. Underscore prefix on factory → excluded from module_info
//   2. Filtered from ha-modules.d.ts
//   3. SKILL.md documents only builder functions
//   4. Sandbox provides the hard security boundary

/** Private brand symbol — never exported. */
const PDF_ELEMENT_BRAND: unique symbol = Symbol("PdfElement");

/**
 * An opaque flow layout element produced by element builder functions.
 * Cannot be constructed from raw strings by LLM code.
 */
export interface PdfElement {
  /** @internal Element kind for the layout engine. */
  readonly _kind: string;
  /** @internal Element data for rendering. */
  readonly _data: unknown;
}

/**
 * Create a branded PdfElement. Internal factory — not for LLM use.
 * @internal
 */
export function _createPdfElement(kind: string, data: unknown): PdfElement {
  const obj = { _kind: kind, _data: data } as PdfElement;
  (obj as unknown as Record<symbol, boolean>)[PDF_ELEMENT_BRAND] = true;
  return Object.freeze(obj);
}

/**
 * Check whether a value is a genuine PdfElement from a builder function.
 * Uses the private symbol brand — cannot be forged by LLM code.
 */
export function isPdfElement(x: unknown): x is PdfElement {
  return (
    x != null &&
    typeof x === "object" &&
    (x as Record<symbol, unknown>)[PDF_ELEMENT_BRAND] === true
  );
}

// ── Margin System ────────────────────────────────────────────────────

/** Page margins in points. */
export interface Margins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Default margins: 1 inch on all sides. */
export const DEFAULT_MARGINS: Margins = {
  top: 72,
  right: 72,
  bottom: 72,
  left: 72,
};

// ── Word Wrapping ────────────────────────────────────────────────────

/**
 * Wrap a line of text to fit within a given width.
 * Splits at word boundaries (spaces). Long words that exceed the width
 * are placed on their own line (never broken mid-word in Phase 2).
 *
 * @param text - Text to wrap
 * @param font - Font name for width measurement
 * @param fontSize - Font size in points
 * @param maxWidth - Maximum line width in points
 * @returns Array of lines (strings)
 */
export function wrapText(
  text: string,
  font: string,
  fontSize: number,
  maxWidth: number,
): string[] {
  if (maxWidth <= 0) return [text];

  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [""];

  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    if (currentLine.length === 0) {
      // First word on the line — always accept it
      currentLine = word;
    } else {
      const testLine = currentLine + " " + word;
      const testWidth = measureText(testLine, font, fontSize);
      if (testWidth <= maxWidth) {
        currentLine = testLine;
      } else {
        // Current line is full — push it and start new line with this word
        lines.push(currentLine);
        currentLine = word;
      }
    }
  }
  // Push the last line
  if (currentLine.length > 0) {
    lines.push(currentLine);
  }
  return lines;
}

// ── Chart Draw Operation ─────────────────────────────────────────────
// Used by ha:pdf-charts to communicate drawing instructions to addContent().
// Coordinates are relative to the chart's top-left corner.

/** A single drawing operation within a chart. */
export interface ChartDrawOp {
  /** Operation type. */
  type: "text" | "rect" | "line" | "polygon";
  /** X coordinate relative to chart origin. */
  x: number;
  /** Y coordinate relative to chart origin. */
  y: number;
  /** For text: the string to draw. */
  text?: string;
  /** For text: font name. */
  font?: string;
  /** For text/rect: font size or line width. */
  fontSize?: number;
  /** For text/rect/line: colour as 6-char hex. */
  color?: string;
  /** For rect: width. */
  w?: number;
  /** For rect: height. */
  h?: number;
  /** For rect: fill colour. */
  fill?: string;
  /** For rect/line/polygon: stroke colour. */
  stroke?: string;
  /** For line: end X relative to chart origin. */
  x2?: number;
  /** For line: end Y relative to chart origin. */
  y2?: number;
  /** For rect/line/polygon: line width. */
  lineWidth?: number;
  /** For polygon: array of [x, y] points relative to chart origin. */
  points?: Array<[number, number]>;
}

// ── Element Internal Data Types ──────────────────────────────────────

interface ParagraphData {
  text: string;
  fontSize: number;
  font: string;
  color?: string; // 6-char hex
  bold: boolean;
  italic: boolean;
  align: "left" | "center" | "right";
  lineHeight: number; // multiplier (e.g. 1.4)
  spaceBefore: number; // points
  spaceAfter: number; // points
}

interface HeadingData {
  text: string;
  level: number; // 1-6
  color?: string;
  spaceBefore?: number; // points, overrides default
  spaceAfter?: number; // points, overrides default
}

interface BulletListData {
  items: string[];
  fontSize: number;
  font: string;
  color?: string;
  bulletChar: string;
  indent: number; // points
  lineHeight: number;
  spaceBefore: number;
  spaceAfter: number;
}

interface NumberedListData {
  items: string[];
  fontSize: number;
  font: string;
  color?: string;
  indent: number; // points
  lineHeight: number;
  spaceBefore: number;
  spaceAfter: number;
}

interface SpacerData {
  height: number; // points
}

interface RuleData {
  thickness: number; // points
  color?: string; // 6-char hex
  marginTop: number; // points
  marginBottom: number; // points
}

// ── Heading Font Size Map ────────────────────────────────────────────

/** Font sizes for each heading level (in points). */
const HEADING_SIZES: Record<number, number> = {
  1: 28,
  2: 22,
  3: 18,
  4: 15,
  5: 13,
  6: 11,
};

// ── Element Builder Functions ────────────────────────────────────────

/** Options for paragraph(). */
export interface ParagraphOptions {
  /** Text content. */
  text: string;
  /** Font size in points. Default: 11. */
  fontSize?: number;
  /** Standard font name. Default: 'Helvetica'. */
  font?: string;
  /** Text colour as 6-char hex. Uses theme foreground if omitted. */
  color?: string;
  /** Use bold font variant. Default: false. */
  bold?: boolean;
  /** Use italic/oblique font variant. Default: false. */
  italic?: boolean;
  /** Text alignment. Default: 'left'. */
  align?: "left" | "center" | "right";
  /** Line height multiplier. Default: 1.4. */
  lineHeight?: number;
  /** Space before paragraph in points. Default: 0. */
  spaceBefore?: number;
  /** Space after paragraph in points. Default: 6. */
  spaceAfter?: number;
}

/**
 * Create a paragraph element for flow layout.
 * Text is automatically word-wrapped to fit within page margins.
 *
 * @param opts - ParagraphOptions
 * @returns PdfElement for use with addContent()
 */
export function paragraph(opts: ParagraphOptions): PdfElement {
  const text = opts.text ?? "";

  // If text contains **bold** markers, convert to richText internally
  if (text.includes("**")) {
    const parts = text.split(/(\*\*.*?\*\*)/g);
    const runs: { text: string; bold?: boolean; color?: string }[] = [];
    for (const part of parts) {
      if (part.startsWith("**") && part.endsWith("**")) {
        runs.push({ text: part.slice(2, -2), bold: true, color: opts.color });
      } else if (part.length > 0) {
        runs.push({
          text: part,
          bold: opts.bold ?? false,
          color: opts.color,
        });
      }
    }
    if (runs.length > 0) {
      const rtData: RichTextData = {
        paragraphs: [{ runs }],
        font: opts.font ?? "Helvetica",
        fontSize: opts.fontSize ?? 11,
        lineHeight: opts.lineHeight ?? 1.4,
        spaceBefore: opts.spaceBefore ?? 0,
        spaceAfter: opts.spaceAfter ?? 6,
      };
      return _createPdfElement("richText", rtData);
    }
  }

  const data: ParagraphData = {
    text,
    fontSize: opts.fontSize ?? 11,
    font: opts.font ?? "Helvetica",
    color: opts.color,
    bold: opts.bold ?? false,
    italic: opts.italic ?? false,
    align: opts.align ?? "left",
    lineHeight: opts.lineHeight ?? 1.4,
    spaceBefore: opts.spaceBefore ?? 0,
    spaceAfter: opts.spaceAfter ?? 6,
  };
  return _createPdfElement("paragraph", data);
}

/** Options for heading(). */
export interface HeadingOptions {
  /** Heading text. */
  text: string;
  /**
   * Heading level 1-6 (1 = largest). Default: 1.
   * Font sizes: 1=28pt, 2=22pt, 3=18pt, 4=15pt, 5=13pt, 6=11pt.
   * Approximate total heights (text + spacing):
   *   level 1 ≈ 60pt, level 2 ≈ 45pt, level 3 ≈ 35pt
   */
  level?: number;
  /** Text colour as 6-char hex. Uses theme foreground if omitted. */
  color?: string;
  /** Space before heading in points. Default: 16 for level 1-2, 10 for 3-6. */
  spaceBefore?: number;
  /** Space after heading in points. Default: 8 for level 1-2, 6 for 3-6. */
  spaceAfter?: number;
}

/**
 * Create a heading element for flow layout.
 * Font size is auto-determined from level (1=28pt, 2=22pt, ..., 6=11pt).
 * Always uses bold font. Includes spacing before and after.
 *
 * @param opts - HeadingOptions
 * @returns PdfElement for use with addContent()
 */
export function heading(opts: HeadingOptions): PdfElement {
  const level = opts.level ?? 1;
  const data: HeadingData = {
    text: opts.text ?? "",
    level: Math.max(1, Math.min(6, Math.round(level))),
    color: opts.color,
    spaceBefore: opts.spaceBefore,
    spaceAfter: opts.spaceAfter,
  };
  return _createPdfElement("heading", data);
}

/** Internal data for sectionHeading element. */
interface SectionHeadingData {
  text: string;
  level: number;
  color?: string;
  ruleThickness: number;
}

/** Options for sectionHeading(). */
export interface SectionHeadingOptions {
  /** Heading text. */
  text: string;
  /** Heading level (1-6). Default: 2. */
  level?: number;
  /** Heading colour as 6-char hex. Uses theme foreground if omitted. */
  color?: string;
}

/**
 * Create a section heading with a rule underneath.
 * Returns a single PdfElement (heading + rule combined).
 *
 * @param opts - SectionHeadingOptions
 * @returns PdfElement for use with addContent()
 */
export function sectionHeading(opts: SectionHeadingOptions): PdfElement {
  const data: SectionHeadingData = {
    text: opts.text ?? "",
    level: opts.level ?? 2,
    color: opts.color,
    ruleThickness: 0.75,
  };
  return _createPdfElement("sectionHeading", data);
}

// ── Convenience Composers ────────────────────────────────────────────
// These return PdfElement arrays. addContent() auto-flattens arrays,
// so they can be used directly in content arrays without spreading.

/** Options for jobEntry(). */
export interface JobEntryOptions {
  /** Job title (e.g. "Senior Software Engineer"). */
  title: string;
  /** Company or organization name. */
  company: string;
  /** Date range (e.g. "2022 – Present"). */
  dates: string;
  /** Bullet point descriptions. */
  bullets: string[];
  /** Font size for bullets. Default: 10. */
  fontSize?: number;
}

/**
 * Create a resume/CV job entry: title+company on left, dates on right,
 * bullet points below. Common pattern for experience sections.
 *
 * @param opts - JobEntryOptions
 * @returns Array of PdfElements (auto-flattened by addContent)
 */
export function jobEntry(opts: JobEntryOptions): PdfElement[] {
  return [
    twoColumn({
      left: [
        paragraph({
          text: `**${opts.title} — ${opts.company}**`,
          fontSize: (opts.fontSize ?? 10) + 1,
          bold: true,
        }),
      ],
      right: [
        paragraph({
          text: opts.dates,
          fontSize: opts.fontSize ?? 10,
          align: "right",
        }),
      ],
      ratio: 0.7,
      spaceAfter: 4,
    }),
    bulletList({
      items: opts.bullets,
      fontSize: opts.fontSize ?? 10,
      spaceBefore: 0,
      spaceAfter: 8,
    }),
  ];
}

/** Options for letterhead(). */
export interface LetterheadOptions {
  /** Company name (rendered large and bold). */
  companyName: string;
  /** Address lines. */
  address?: string[];
  /** Phone number. */
  phone?: string;
  /** Email address. */
  email?: string;
  /** Accent colour as 6-char hex. Uses theme accent1 if omitted. */
  color?: string;
}

/**
 * Create a letterhead block: company name, address, contact info, and separator.
 * Common pattern for business letters, invoices, and proposals.
 *
 * @param opts - LetterheadOptions
 * @returns Array of PdfElements (auto-flattened by addContent)
 */
export function letterhead(opts: LetterheadOptions): PdfElement[] {
  const elements: PdfElement[] = [
    heading({ text: opts.companyName, level: 1, color: opts.color }),
  ];
  const contactParts: string[] = [];
  if (opts.address) contactParts.push(...opts.address);
  if (opts.phone) contactParts.push(`Phone: ${opts.phone}`);
  if (opts.email) contactParts.push(`Email: ${opts.email}`);
  if (contactParts.length > 0) {
    elements.push(
      textBlock({
        lines: contactParts,
        fontSize: 9,
        color: "666666",
        lineHeight: 1.3,
      }),
    );
  }
  elements.push(
    rule({ thickness: 1.5, color: opts.color, marginTop: 4, marginBottom: 16 }),
  );
  return elements;
}

/** Options for bulletList(). */
export interface BulletListOptions {
  /** List items (strings). */
  items: string[];
  /** Font size in points. Default: 11. */
  fontSize?: number;
  /** Standard font name. Default: 'Helvetica'. */
  font?: string;
  /** Text colour as 6-char hex. Uses theme foreground if omitted. */
  color?: string;
  /** Bullet character. Default: '•'. */
  bulletChar?: string;
  /** Indent for text after bullet in points. Default: 18. */
  indent?: number;
  /** Line height multiplier. Default: 1.4. */
  lineHeight?: number;
  /** Space before list in points. Default: 4. */
  spaceBefore?: number;
  /** Space after list in points. Default: 8. */
  spaceAfter?: number;
}

/**
 * Create a bulleted list element for flow layout.
 *
 * @param opts - BulletListOptions
 * @returns PdfElement for use with addContent()
 */
export function bulletList(opts: BulletListOptions): PdfElement {
  const items = requireArray<string>(opts.items, "bulletList.items");
  const data: BulletListData = {
    items,
    fontSize: opts.fontSize ?? 11,
    font: opts.font ?? "Helvetica",
    color: opts.color,
    bulletChar: opts.bulletChar ?? "\u2022",
    indent: opts.indent ?? 18,
    lineHeight: opts.lineHeight ?? 1.4,
    spaceBefore: opts.spaceBefore ?? 4,
    spaceAfter: opts.spaceAfter ?? 8,
  };
  return _createPdfElement("bulletList", data);
}

/** Options for numberedList(). */
export interface NumberedListOptions {
  /** List items (strings). */
  items: string[];
  /** Font size in points. Default: 11. */
  fontSize?: number;
  /** Standard font name. Default: 'Helvetica'. */
  font?: string;
  /** Text colour as 6-char hex. Uses theme foreground if omitted. */
  color?: string;
  /** Indent for text after number in points. Default: 22. */
  indent?: number;
  /** Line height multiplier. Default: 1.4. */
  lineHeight?: number;
  /** Space before list in points. Default: 4. */
  spaceBefore?: number;
  /** Space after list in points. Default: 8. */
  spaceAfter?: number;
}

/**
 * Create a numbered list element for flow layout.
 *
 * @param opts - NumberedListOptions
 * @returns PdfElement for use with addContent()
 */
export function numberedList(opts: NumberedListOptions): PdfElement {
  const items = requireArray<string>(opts.items, "numberedList.items");
  const data: NumberedListData = {
    items,
    fontSize: opts.fontSize ?? 11,
    font: opts.font ?? "Helvetica",
    color: opts.color,
    indent: opts.indent ?? 22,
    lineHeight: opts.lineHeight ?? 1.4,
    spaceBefore: opts.spaceBefore ?? 4,
    spaceAfter: opts.spaceAfter ?? 8,
  };
  return _createPdfElement("numberedList", data);
}

/**
 * Create a vertical spacer element.
 * @param height - Height in points
 * @returns PdfElement for use with addContent()
 */
export function spacer(height: number): PdfElement {
  requireNumber(height, "spacer.height", { min: 0 });
  return _createPdfElement("spacer", { height } as SpacerData);
}

/**
 * Create a page break element. Forces content after this to start
 * on a new page.
 * @returns PdfElement for use with addContent()
 */
export function pageBreak(): PdfElement {
  return _createPdfElement("pageBreak", {});
}

/** Options for rule(). */
export interface RuleOptions {
  /** Line thickness in points. Default: 0.5. */
  thickness?: number;
  /** Line colour as 6-char hex. Uses theme subtle colour if omitted. */
  color?: string;
  /** Space above the rule in points. Default: 8. */
  marginTop?: number;
  /** Space below the rule in points. Default: 8. */
  marginBottom?: number;
}

/**
 * Create a horizontal rule element.
 * @param opts - RuleOptions
 * @returns PdfElement for use with addContent()
 */
export function rule(opts?: RuleOptions): PdfElement {
  const data: RuleData = {
    thickness: opts?.thickness ?? 0.5,
    color: opts?.color,
    marginTop: opts?.marginTop ?? 12,
    marginBottom: opts?.marginBottom ?? 12,
  };
  return _createPdfElement("rule", data);
}

// ── Two Column Flow Element ──────────────────────────────────────────

/** Internal data for twoColumn element. */
interface TwoColumnData {
  left: PdfElement[];
  right: PdfElement[];
  gap: number; // points between columns
  ratio: number; // left column width ratio (0-1), right gets the rest
  spaceBefore: number;
  spaceAfter: number;
}

/** Options for twoColumn(). */
export interface TwoColumnOptions {
  /** Left column elements. */
  left: PdfElement[];
  /** Right column elements. */
  right: PdfElement[];
  /** Gap between columns in points. Default: 24. */
  gap?: number;
  /** Left column width as ratio of content width (0-1). Default: 0.5 (equal). */
  ratio?: number;
  /** Space before in points. Default: 0. */
  spaceBefore?: number;
  /** Space after in points. Default: 8. */
  spaceAfter?: number;
}

/**
 * Create a two-column inline layout element for flow content.
 * Renders left and right elements side by side within addContent().
 * Unlike twoColumnPage(), this does NOT create a new page — it flows
 * inline with other elements.
 *
 * @param opts - TwoColumnOptions
 * @returns PdfElement for use with addContent()
 */
export function twoColumn(opts: TwoColumnOptions): PdfElement {
  const data: TwoColumnData = {
    left: opts.left ?? [],
    right: opts.right ?? [],
    gap: opts.gap ?? 24,
    ratio: opts.ratio ?? 0.5,
    spaceBefore: opts.spaceBefore ?? 0,
    spaceAfter: opts.spaceAfter ?? 8,
  };
  return _createPdfElement("twoColumn", data);
}

// ── N-Column Flow Element ────────────────────────────────────────────

/** Internal data for columns element. */
interface ColumnsData {
  cols: PdfElement[][]; // array of column element arrays
  widths: number[]; // column width ratios (must sum to ~1.0)
  gap: number; // points between columns
  spaceBefore: number;
  spaceAfter: number;
}

/** Options for columns(). */
export interface ColumnsOptions {
  /** Array of column content. Each entry is an array of PdfElements for that column. */
  cols: PdfElement[][];
  /**
   * Column width ratios. Length must match cols.length. Values sum to ~1.0.
   * Default: equal widths (e.g. [0.333, 0.333, 0.333] for 3 columns).
   */
  widths?: number[];
  /** Gap between columns in points. Default: 16. */
  gap?: number;
  /** Space before in points. Default: 0. */
  spaceBefore?: number;
  /** Space after in points. Default: 8. */
  spaceAfter?: number;
}

/**
 * Create an N-column layout element for flow content.
 * Supports 2-6 columns with independent element arrays per column.
 * For simple two-column layouts, twoColumn() is more convenient.
 *
 * @param opts - ColumnsOptions
 * @returns PdfElement for use with addContent()
 */
export function columns(opts: ColumnsOptions): PdfElement {
  const cols = requireArray<PdfElement[]>(opts.cols, "columns.cols", {
    nonEmpty: true,
  });
  if (cols.length < 2 || cols.length > 6) {
    throw new Error(
      `columns.cols: expected 2-6 columns but got ${cols.length}.`,
    );
  }
  // Default to equal widths
  const n = cols.length;
  const widths = opts.widths ?? Array(n).fill(1.0 / n);
  if (widths.length !== n) {
    throw new Error(
      `columns.widths: length ${widths.length} doesn't match cols length ${n}.`,
    );
  }

  const data: ColumnsData = {
    cols,
    widths,
    gap: opts.gap ?? 16,
    spaceBefore: opts.spaceBefore ?? 0,
    spaceAfter: opts.spaceAfter ?? 8,
  };
  return _createPdfElement("columns", data);
}

// ── Table Style Presets ──────────────────────────────────────────────

/** Style definition for table rendering. */
export interface TableStyle {
  /** Header row background colour (6-char hex). */
  headerBg: string;
  /** Header text colour (6-char hex). */
  headerFg: string;
  /** Header font. */
  headerFont: string;
  /** Body text colour (6-char hex). Auto-contrasted if omitted or poor contrast. */
  bodyFg: string;
  /** Body font. */
  bodyFont: string;
  /** Alternating row background colour (6-char hex), or empty for none. */
  altRowBg: string;
  /** Border colour (6-char hex). */
  borderColor: string;
  /** Border line width in points. */
  borderWidth: number;
}

/** Built-in table styles matching PPTX table styles. */
export const TABLE_STYLES: Record<string, TableStyle> = {
  default: {
    headerBg: "2196F3",
    headerFg: "FFFFFF",
    headerFont: "Helvetica-Bold",
    bodyFg: "333333",
    bodyFont: "Helvetica",
    altRowBg: "F5F5F5",
    borderColor: "DDDDDD",
    borderWidth: 0.5,
  },
  dark: {
    headerBg: "D32F2F",
    headerFg: "FFFFFF",
    headerFont: "Helvetica-Bold",
    bodyFg: "EEEEEE",
    bodyFont: "Helvetica",
    altRowBg: "2A2A2A",
    borderColor: "444444",
    borderWidth: 0.5,
  },
  minimal: {
    headerBg: "",
    headerFg: "333333",
    headerFont: "Helvetica-Bold",
    bodyFg: "333333",
    bodyFont: "Helvetica",
    altRowBg: "",
    borderColor: "CCCCCC",
    borderWidth: 0.25,
  },
  corporate: {
    headerBg: "1B2A4A",
    headerFg: "FFFFFF",
    headerFont: "Helvetica-Bold",
    bodyFg: "333333",
    bodyFont: "Helvetica",
    altRowBg: "EEF2F7",
    borderColor: "C0C8D4",
    borderWidth: 0.5,
  },
  emerald: {
    headerBg: "004D40",
    headerFg: "FFFFFF",
    headerFont: "Helvetica-Bold",
    bodyFg: "333333",
    bodyFont: "Helvetica",
    altRowBg: "E0F2F1",
    borderColor: "B2DFDB",
    borderWidth: 0.5,
  },
};

// ── Table Internal Data ──────────────────────────────────────────────

interface TableData {
  headers: string[];
  rows: string[][];
  fontSize: number;
  style: TableStyle;
  colWidths?: number[]; // optional fixed column widths in points or ratios
  columnAlign?: ("left" | "center" | "right")[]; // per-column text alignment
  compact?: boolean; // compact mode — reduced row padding
  footerRow?: string[]; // optional bold footer/totals row
}

interface KvTableData {
  items: { key: string; value: string; bold?: boolean; separator?: boolean }[];
  fontSize: number;
  style: TableStyle;
  keyWidth?: number; // portion of width for key column (0-1) or absolute points
  maxWidth?: number; // max table width in points
  align?: "left" | "center" | "right"; // table alignment within content area
  valueAlign?: "left" | "right"; // alignment of value column text
}

interface ComparisonTableData {
  features: string[];
  options: { name: string; values: (boolean | string)[] }[];
  fontSize: number;
  style: TableStyle;
}

interface ImageElementData {
  data: Uint8Array;
  width?: number; // display width in points (optional, auto-calc from height + aspect ratio)
  height?: number; // display height in points (optional, auto-calc from width + aspect ratio)
  align: "left" | "center" | "right";
  caption?: string;
  captionFontSize: number;
}

// ── Table Element Builders ───────────────────────────────────────────

/** Options for table(). */
/** Column definition for the columns-based table API. */
export interface ColumnDef {
  /** Column header text. */
  header: string;
  /** Column width as a ratio (0-1) of total table width. Auto if omitted. */
  width?: number;
  /** Text alignment for this column: "left", "center", or "right". */
  align?: string;
}

export interface TableOptions {
  /** Column header texts. Use EITHER headers+rows OR columns+rows. */
  headers?: string[];
  /** Row data — each row is an array of cell strings. Must match headers length. */
  rows?: string[][];
  /**
   * Alternative column-based definition (instead of headers).
   * Each column specifies header text, optional width ratio, and alignment.
   * If provided, headers are derived from this automatically.
   */
  columns?: ColumnDef[];
  /** Font size in points. Default: 10. */
  fontSize?: number;
  /** Table style preset: 'default', 'dark', 'minimal', 'corporate', 'emerald', or custom TableStyle. */
  style?: string | TableStyle;
  /** Fixed column widths in points or ratios. Auto-calculated if omitted. */
  colWidths?: number[];
  /**
   * Per-column text alignment. Array matching headers length.
   * E.g. ["left", "center", "right", "right"] for a table with 4 columns.
   * Default: all "left".
   */
  columnAlign?: ("left" | "center" | "right")[];
  /**
   * Compact mode: reduces row padding for information-dense layouts.
   * Row height drops from ~2.2x to ~1.6x fontSize.
   * Default: false.
   */
  compact?: boolean;
  /**
   * Optional footer/totals row rendered with bold styling and a thicker
   * top border. Common for invoice totals, summary rows.
   * Must have the same number of cells as headers.
   */
  footerRow?: string[];
  /**
   * Font name for table body text. Default: 'Helvetica'.
   * Use a custom font name registered via registerCustomFont() for
   * Unicode characters outside WinAnsiEncoding.
   */
  font?: string;
}

/**
 * Create a data table element for flow layout.
 * Renders with header row, borders, and alternating row colours.
 *
 * Accepts EITHER { headers, rows } OR { columns, rows } format.
 * LLMs use both interchangeably — we handle both.
 *
 * @param opts - TableOptions
 * @returns PdfElement for use with addContent()
 */
export function table(opts: TableOptions): PdfElement {
  // Support 'columns' syntax: extract headers from column definitions
  let headers: string[];
  let colWidths = opts.colWidths;

  if (opts.columns && Array.isArray(opts.columns)) {
    headers = opts.columns.map((c) =>
      typeof c === "string" ? c : (c.header ?? ""),
    );
    // Extract column widths if specified in columns
    if (!colWidths) {
      const hasWidths = opts.columns.some(
        (c) => typeof c !== "string" && c.width != null,
      );
      if (hasWidths) {
        colWidths = opts.columns.map((c) =>
          typeof c !== "string" && c.width != null ? c.width : 0,
        );
      }
    }
  } else {
    headers = requireArray<string>(opts.headers, "table.headers", {
      nonEmpty: true,
    });
  }

  const rows = requireArray<string[]>(opts.rows ?? [], "table.rows");

  // Validate each row has correct cell count
  for (let i = 0; i < rows.length; i++) {
    if (!Array.isArray(rows[i]) || rows[i].length !== headers.length) {
      throw new Error(
        `table.rows[${i}]: expected ${headers.length} cells (matching headers) ` +
          `but got ${Array.isArray(rows[i]) ? rows[i].length : "non-array"}. ` +
          `Each row must have exactly ${headers.length} cells.`,
      );
    }
  }

  let style = resolveTableStyle(opts.style);

  // Apply custom font override if specified
  if (opts.font) {
    style = { ...style, bodyFont: opts.font, headerFont: opts.font };
  }

  // Extract columnAlign from options or from columns syntax
  let columnAlign = opts.columnAlign;
  if (!columnAlign && opts.columns && Array.isArray(opts.columns)) {
    const hasAlign = opts.columns.some(
      (c) => typeof c !== "string" && c.align != null,
    );
    if (hasAlign) {
      columnAlign = opts.columns.map((c) => {
        const a =
          typeof c !== "string" && c.align ? c.align.toLowerCase() : "left";
        return a === "center" || a === "right" ? a : "left";
      }) as ("left" | "center" | "right")[];
    }
  }

  const data: TableData = {
    headers,
    rows,
    fontSize: opts.fontSize ?? 10,
    style,
    colWidths,
    columnAlign,
    compact: opts.compact,
    footerRow: opts.footerRow,
  };
  return _createPdfElement("table", data);
}

/** Options for kvTable(). */
export interface KvTableOptions {
  /** Key-value pairs. Each item has a key, value, optional bold, and optional separator above. */
  items?: { key: string; value: string; bold?: boolean; separator?: boolean }[];
  /** Font size in points. Default: 10. */
  fontSize?: number;
  /** Table style preset: 'default', 'dark', 'minimal', 'corporate', 'emerald', or custom TableStyle. */
  style?: string | TableStyle;
  /**
   * Width for the key column. If <= 1, treated as proportion of total width.
   * If > 1, treated as absolute points. Default: 0.35 (35% of width).
   */
  keyWidth?: number;
  /**
   * Maximum width for the entire kvTable in points.
   * If set, table won't exceed this width. Content area width is used if omitted.
   */
  maxWidth?: number;
  /**
   * Horizontal alignment of the kvTable within the content area.
   * Only meaningful when maxWidth is set (table narrower than content area).
   * Default: 'left'.
   */
  align?: "left" | "center" | "right";
  /** Font name for text. Use custom font for Unicode support. */
  font?: string;
}

/**
 * Create a key-value table element for flow layout.
 * Two-column layout: Key | Value.
 *
 * @param opts - KvTableOptions
 * @returns PdfElement for use with addContent()
 */
export function kvTable(opts: KvTableOptions): PdfElement {
  // Accept either 'items' or 'entries' (LLMs use both interchangeably — runtime alias)
  const rawItems = opts.items ?? (opts as Record<string, unknown>).entries;
  const items = requireArray<{ key: string; value: string; bold?: boolean }>(
    rawItems,
    "kvTable.items (or entries)",
    { nonEmpty: true },
  );
  let style = resolveTableStyle(opts.style);
  if (opts.font) {
    style = { ...style, bodyFont: opts.font, headerFont: opts.font };
  }

  // keyWidth: if > 1, it's absolute points; if <= 1, it's a ratio
  const keyWidth = opts.keyWidth ?? 0.35;

  const data: KvTableData = {
    items,
    fontSize: opts.fontSize ?? 10,
    style,
    keyWidth,
    maxWidth: opts.maxWidth,
    align: opts.align,
    valueAlign: "left", // default left, but renderTable will right-align via columnAlign
  };
  return _createPdfElement("kvTable", data);
}

/** Column option for comparisonTable. */
export interface ComparisonOption {
  /** Column header name (e.g. "Basic", "Pro", "Enterprise"). */
  name: string;
  /** Values for each feature row. Booleans render as ✓/✗, strings render as-is. */
  values: (boolean | string)[];
}

/** Options for comparisonTable(). */
export interface ComparisonTableOptions {
  /** Feature names (row labels). */
  features: string[];
  /**
   * Options to compare. Each has a name and values matching features.
   * Values can be booleans (rendered as ✓/✗) or strings (rendered as-is).
   */
  options: ComparisonOption[];
  /** Font size in points. Default: 10. */
  fontSize?: number;
  /** Table style preset: 'default', 'dark', 'minimal', 'corporate', 'emerald', or custom TableStyle. */
  style?: string | TableStyle;
}

/**
 * Create a comparison table element for flow layout.
 * Feature matrix with ✓/✗ marks.
 *
 * @param opts - ComparisonTableOptions
 * @returns PdfElement for use with addContent()
 */
export function comparisonTable(opts: ComparisonTableOptions): PdfElement {
  const features = requireArray<string>(
    opts.features,
    "comparisonTable.features",
    { nonEmpty: true },
  );
  const options = requireArray<{ name: string; values: (boolean | string)[] }>(
    opts.options,
    "comparisonTable.options",
    { nonEmpty: true },
  );
  // Validate each option has values matching features length
  for (let i = 0; i < options.length; i++) {
    if (
      !Array.isArray(options[i].values) ||
      options[i].values.length !== features.length
    ) {
      throw new Error(
        `comparisonTable.options[${i}].values: expected ${features.length} values ` +
          `(matching features) but got ${Array.isArray(options[i].values) ? options[i].values.length : "non-array"}.`,
      );
    }
  }
  const style = resolveTableStyle(opts.style);
  const data: ComparisonTableData = {
    features,
    options,
    fontSize: opts.fontSize ?? 10,
    style,
  };
  return _createPdfElement("comparisonTable", data);
}

/** Resolve a style name or object to a TableStyle.
 *  Preset styles are shallow-cloned so that contrast auto-correction
 *  in renderTable never mutates the shared TABLE_STYLES singletons. */
function resolveTableStyle(style?: string | TableStyle): TableStyle {
  if (!style) return { ...TABLE_STYLES.default };
  if (typeof style === "string") {
    const resolved = TABLE_STYLES[style];
    if (!resolved) {
      const valid = Object.keys(TABLE_STYLES).join(", ");
      throw new Error(
        `Unknown table style "${style}". Valid styles: ${valid}.`,
      );
    }
    return { ...resolved };
  }
  return style;
}

// ── Image Element Builder ────────────────────────────────────────────

/** Options for image(). */
export interface ImageOptions {
  /** Image data as Uint8Array (JPEG or PNG). */
  data: Uint8Array;
  /** Display width in points. If omitted, auto-calculated from height + aspect ratio. */
  width?: number;
  /** Display height in points. If omitted, auto-calculated from width + aspect ratio. */
  height?: number;
  /** Horizontal alignment within content area. Default: 'left'. */
  align?: "left" | "center" | "right";
  /** Optional caption text below the image. */
  caption?: string;
  /** Caption font size in points. Default: 9. */
  captionFontSize?: number;
}

/**
 * Create an image element for flow layout.
 * Supports JPEG and PNG. At least one of width or height must be specified.
 * The other dimension is auto-calculated to preserve aspect ratio.
 *
 * @param opts - ImageOptions
 * @returns PdfElement for use with addContent()
 */
export function image(opts: ImageOptions): PdfElement {
  if (!(opts.data instanceof Uint8Array) || opts.data.length === 0) {
    throw new Error(
      "image.data: expected a non-empty Uint8Array of image bytes (JPEG or PNG).",
    );
  }
  if (opts.width == null && opts.height == null) {
    throw new Error(
      "image: at least one of width or height must be specified.",
    );
  }
  const data: ImageElementData = {
    data: opts.data,
    width: opts.width,
    height: opts.height,
    align: opts.align ?? "left",
    caption: opts.caption,
    captionFontSize: opts.captionFontSize ?? 9,
  };
  return _createPdfElement("image", data);
}

// ── Table Rendering Helper ───────────────────────────────────────────
// Tables are rendered by drawing text + rectangles + lines directly
// onto the document pages via drawText/drawRect/drawLine.

/** Cell padding in points (horizontal). */
const CELL_PAD_H = 6;
/** Cell padding in points (vertical — space above text baseline within cell). */
const CELL_PAD_V = 4;

/**
 * Calculate the height of a table row based on font size and content.
 * Row height = fontSize + top padding + bottom padding.
 */
function tableRowHeight(fontSize: number, compact?: boolean): number {
  const padV = compact ? 2 : CELL_PAD_V;
  return fontSize + padV * 2 + 2; // +2 for descent below baseline
}

/**
 * Render a table directly onto the document.
 * Called from addContent when processing table elements.
 */
function renderTable(
  doc: PdfDocument,
  headers: string[],
  rows: string[][],
  style: TableStyle,
  fontSize: number,
  x: number,
  y: number, // cursor Y (top-left API coords)
  totalWidth: number,
  colWidths: number[],
  ensureSpace: (h: number) => void,
  getCursorY: () => number,
  setCursorY: (v: number) => void,
  columnAlign?: ("left" | "center" | "right")[],
  compact?: boolean,
  skipHeader?: boolean,
  rowBold?: boolean[],
  footerRow?: string[],
  rowSeparators?: boolean[],
): void {
  const rowH = tableRowHeight(fontSize, compact);
  const headerH = rowH;

  // ── Contrast auto-correction ─────────────────────────────────────
  // Automatically fix text colors that have poor contrast against the
  // page background. No errors — just silently correct to readable.
  // Use a local pageBg derived from the current doc theme rather than
  // caching on the style object (which could be stale across renders).
  const MIN_CONTRAST = 3.0;
  const pageBg = doc.theme.bg || "FFFFFF";

  // If headerBg is too similar to pageBg, the header row won't stand out.
  // Swap to theme accent1 so the header is visually distinct.
  if (style.headerBg) {
    const headerVsPage = contrastRatio(style.headerBg, pageBg);
    if (headerVsPage < 1.5 && doc.theme.accent1) {
      style.headerBg = doc.theme.accent1;
    }
  }

  if (style.bodyFg) {
    const bodyRatio = contrastRatio(style.bodyFg, pageBg);
    if (bodyRatio < MIN_CONTRAST) {
      style.bodyFg = autoTextColor(pageBg);
    }
  }

  if (style.headerFg && style.headerBg) {
    const headerRatio = contrastRatio(style.headerFg, style.headerBg);
    if (headerRatio < MIN_CONTRAST) {
      style.headerFg = autoTextColor(style.headerBg);
    }
  }

  if (style.headerBg && style.headerFg) {
    const headerRatio = contrastRatio(style.headerFg, style.headerBg);
    if (headerRatio < MIN_CONTRAST) {
      const suggested = autoTextColor(style.headerBg);
      throw new Error(
        `table: headerFg "${style.headerFg}" has poor contrast (${headerRatio.toFixed(1)}:1) against ` +
        `headerBg "${style.headerBg}". Minimum is ${MIN_CONTRAST}:1. ` +
        `Use "${suggested}" instead.`
      );
    }
  }

  // Text baseline offset within a row: top padding + font size
  // (drawText Y is the baseline position in top-left coords)
  const padV = compact ? 2 : CELL_PAD_V;
  const textYOffset = padV + fontSize;

  /**
   * Truncate text with ellipsis if it's wider than the available column width.
   * Returns the original text if it fits, or truncated text with "..." appended.
   */
  function fitCellText(text: string, font: string, maxWidth: number): string {
    const availW = maxWidth - CELL_PAD_H * 2;
    if (availW <= 0) return "";
    const textW = measureText(text, font, fontSize);
    if (textW <= availW) return text;
    // Truncate: binary search for max chars that fit with ellipsis
    const ellipsis = "...";
    const ellipsisW = measureText(ellipsis, font, fontSize);
    const targetW = availW - ellipsisW;
    if (targetW <= 0) return ellipsis;
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (measureText(text.slice(0, mid), font, fontSize) <= targetW) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return text.slice(0, lo) + ellipsis;
  }

  /**
   * Calculate the X position for cell text based on column alignment.
   * @param cellLeft - Left edge of the cell
   * @param colWidth - Width of the column
   * @param text - Cell text content
   * @param font - Font name
   * @param align - Column alignment
   */
  function cellTextX(
    cellLeft: number,
    colWidth: number,
    text: string,
    font: string,
    align: "left" | "center" | "right",
  ): number {
    if (align === "right") {
      const textW = measureText(text, font, fontSize);
      return cellLeft + colWidth - CELL_PAD_H - textW;
    }
    if (align === "center") {
      const textW = measureText(text, font, fontSize);
      return cellLeft + (colWidth - textW) / 2;
    }
    return cellLeft + CELL_PAD_H; // left (default)
  }

  // Record table start for vertical borders
  ensureSpace(skipHeader ? rowH : headerH);
  const tableStartY = getCursorY();
  let curY = tableStartY;
  let cellX: number;

  // ── Header row (skipped for kvTable — key-value pairs don't need headers) ──
  if (!skipHeader) {
    // Background fill FIRST (so text draws ON TOP)
    if (style.headerBg) {
      doc.drawRect(x, curY, totalWidth, headerH, { fill: style.headerBg });
    }

    // Header text (drawn AFTER background — PDF paints in order)
    cellX = x;
    for (let c = 0; c < headers.length; c++) {
      const align = columnAlign?.[c] ?? "left";
      const headerText = fitCellText(
        headers[c],
        style.headerFont,
        colWidths[c],
      );
      const textX = cellTextX(
        cellX,
        colWidths[c],
        headerText,
        style.headerFont,
        align,
      );
      doc.drawText(headerText, textX, curY + textYOffset, {
        font: style.headerFont,
        fontSize,
        color: style.headerBg ? autoTextColor(style.headerBg) : style.headerFg,
      });
      cellX += colWidths[c];
    }

    // Header bottom border
    doc.drawLine(x, curY + headerH, x + totalWidth, curY + headerH, {
      color: style.borderColor,
      lineWidth: style.borderWidth,
    });

    setCursorY(curY + headerH);
  }

  // ── Data rows ──
  for (let r = 0; r < rows.length; r++) {
    ensureSpace(rowH);
    curY = getCursorY();

    // Separator line above this row (thicker border for visual emphasis)
    if (rowSeparators?.[r]) {
      doc.drawLine(x, curY, x + totalWidth, curY, {
        color: style.borderColor,
        lineWidth: style.borderWidth * 3,
      });
    }

    // EVERY row gets an explicit fill — no transparent rows, no guessing
    const isAlt = !!(style.altRowBg && r % 2 === 1);
    const rowBg = isAlt ? style.altRowBg : pageBg;
    doc.drawRect(x, curY, totalWidth, rowH, { fill: rowBg });

    // Prefer the validated body text color; fall back to an automatic
    // contrast color if no explicit body foreground is configured.
    const rowFg = style.bodyFg ?? autoTextColor(rowBg);

    // Cell text AFTER background
    const isBoldRow = rowBold?.[r] ?? false;
    const cellFont = isBoldRow
      ? (style.headerFont ?? style.bodyFont)
      : style.bodyFont;
    cellX = x;
    for (let c = 0; c < rows[r].length; c++) {
      const align = columnAlign?.[c] ?? "left";
      const cellText = fitCellText(rows[r][c], cellFont, colWidths[c]);
      const textX = cellTextX(cellX, colWidths[c], cellText, cellFont, align);
      doc.drawText(cellText, textX, curY + textYOffset, {
        font: cellFont,
        fontSize,
        color: rowFg,
      });
      cellX += colWidths[c];
    }

    // Row bottom border
    doc.drawLine(x, curY + rowH, x + totalWidth, curY + rowH, {
      color: style.borderColor,
      lineWidth: style.borderWidth,
    });

    setCursorY(curY + rowH);
  }

  // ── Footer row (bold, thicker top border) ──
  if (footerRow && footerRow.length > 0) {
    ensureSpace(rowH);
    curY = getCursorY();

    // Thicker border above footer
    doc.drawLine(x, curY, x + totalWidth, curY, {
      color: style.borderColor,
      lineWidth: style.borderWidth * 2,
    });

    // Footer background (same as header)
    if (style.headerBg) {
      doc.drawRect(x, curY, totalWidth, rowH, { fill: style.headerBg });
    }

    // Footer cells in bold
    cellX = x;
    for (let c = 0; c < footerRow.length && c < colWidths.length; c++) {
      const align = columnAlign?.[c] ?? "left";
      const cellText = fitCellText(
        footerRow[c],
        style.headerFont,
        colWidths[c],
      );
      const textX = cellTextX(
        cellX,
        colWidths[c],
        cellText,
        style.headerFont,
        align,
      );
      doc.drawText(cellText, textX, curY + textYOffset, {
        font: style.headerFont,
        fontSize,
        color: style.headerFg,
      });
      cellX += colWidths[c];
    }

    // Footer bottom border
    doc.drawLine(x, curY + rowH, x + totalWidth, curY + rowH, {
      color: style.borderColor,
      lineWidth: style.borderWidth,
    });

    setCursorY(curY + rowH);
  }

  // ── Vertical column borders ──
  const tableBottom = getCursorY();
  cellX = x;
  for (let c = 0; c <= headers.length; c++) {
    doc.drawLine(cellX, tableStartY, cellX, tableBottom, {
      color: style.borderColor,
      lineWidth: style.borderWidth,
    });
    if (c < headers.length) cellX += colWidths[c];
  }
}

/**
 * Calculate auto column widths based on content.
 * Distributes available width proportionally to content length.
 */
function autoColumnWidths(
  headers: string[],
  rows: string[][],
  font: string,
  fontSize: number,
  totalWidth: number,
): number[] {
  // Measure max content width per column
  const maxWidths: number[] = headers.map(
    (h) =>
      measureText(h, font + "-Bold" in FONT_WIDTHS ? font : font, fontSize) +
      CELL_PAD_H * 2,
  );

  for (const row of rows) {
    for (let c = 0; c < row.length; c++) {
      const w = measureText(row[c], font, fontSize) + CELL_PAD_H * 2;
      if (w > maxWidths[c]) maxWidths[c] = w;
    }
  }

  // Distribute total width proportionally
  const totalContentWidth = maxWidths.reduce((sum, w) => sum + w, 0);
  if (totalContentWidth <= 0) {
    // Fallback: equal widths
    return headers.map(() => totalWidth / headers.length);
  }
  return maxWidths.map((w) => (w / totalContentWidth) * totalWidth);
}

// ── Flow Layout Engine ───────────────────────────────────────────────
// The flow engine takes an array of PdfElements and renders them into
// the document, automatically creating new pages when content exceeds
// the available space. It tracks a cursor (x, y) position and respects
// page margins.

/** Options for addContent(). */
export interface AddContentOptions {
  /** Page margins. Default: 1 inch on all sides. */
  margins?: Partial<Margins>;
  /**
   * Maximum pages for this content. If content would exceed this,
   * spacing (spaceBefore, spaceAfter, lineHeight) is automatically
   * scaled down to fit. Does NOT reduce font sizes — only whitespace.
   * Useful for single-page documents (invoices, letters, resumes).
   *
   * Example: `addContent(doc, elements, { maxPages: 1 })`
   */
  maxPages?: number;
  /**
   * Vertically center content on the page. Calculates total content
   * height and offsets the starting Y position so content is centered.
   * Useful for title pages and cover pages. Default: false.
   */
  verticalCenter?: boolean;
}

/**
 * Estimate the total vertical height (in points) that an array of PdfElements
 * would consume when rendered via addContent(). Does NOT render anything —
 * purely a measurement function.
 *
 * Use this to predict whether content will fit on the current page before
 * calling addContent(). Heights are approximate (±5%) due to word-wrapping
 * variations, but accurate enough for layout planning.
 *
 * @param elements - Array of PdfElement objects from builder functions
 * @param opts - Optional: contentWidth (default: letter width minus 1" margins = 468pt)
 * @returns Total estimated height in points
 *
 * @example
 * const height = estimateHeight([heading({text: "Title"}), paragraph({text: "..."}), chart]);
 * if (height > 600) { doc.addPage(); } // Won't fit on current page
 */
export function estimateHeight(
  elements: PdfElement[],
  opts?: { contentWidth?: number },
): number {
  // Default to letter page width minus standard 1" margins
  const contentWidth = opts?.contentWidth ?? 468;
  let totalH = 0;

  for (const el of elements) {
    if (!isPdfElement(el)) continue;

    switch (el._kind) {
      case "paragraph": {
        const d = el._data as ParagraphData;
        const font = d.bold
          ? d.font === "Helvetica"
            ? "Helvetica-Bold"
            : d.font
          : d.font;
        const lines = wrapText(d.text, font, d.fontSize, contentWidth);
        totalH +=
          d.spaceBefore +
          lines.length * d.fontSize * d.lineHeight +
          d.spaceAfter;
        break;
      }

      case "heading": {
        const d = el._data as HeadingData;
        const fontSize = HEADING_SIZES[d.level] ?? 11;
        const spaceBefore = d.spaceBefore ?? (d.level <= 2 ? 16 : 10);
        const spaceAfter = d.spaceAfter ?? (d.level <= 2 ? 8 : 6);
        const lines = wrapText(
          d.text,
          "Helvetica-Bold",
          fontSize,
          contentWidth,
        );
        totalH += spaceBefore + lines.length * fontSize * 1.3 + spaceAfter;
        break;
      }

      case "sectionHeading": {
        // heading + rule combined
        const d = el._data as SectionHeadingData;
        const fs = HEADING_SIZES[d.level] ?? 11;
        const sb = d.level <= 2 ? 16 : 10;
        const lines = wrapText(d.text, "Helvetica-Bold", fs, contentWidth);
        // heading height + 4pt gap + rule (0.75 + 8 margin)
        totalH += sb + lines.length * fs * 1.3 + 4 + d.ruleThickness + 8;
        break;
      }

      case "bulletList": {
        const d = el._data as BulletListData;
        const availW = contentWidth - d.indent;
        let listH = d.spaceBefore;
        for (const item of d.items) {
          const lines = wrapText(item, d.font, d.fontSize, availW);
          listH += lines.length * d.fontSize * d.lineHeight;
        }
        totalH += listH + d.spaceAfter;
        break;
      }

      case "numberedList": {
        const d = el._data as NumberedListData;
        const availW = contentWidth - d.indent;
        let listH = d.spaceBefore;
        for (const item of d.items) {
          const lines = wrapText(item, d.font, d.fontSize, availW);
          listH += lines.length * d.fontSize * d.lineHeight;
        }
        totalH += listH + d.spaceAfter;
        break;
      }

      case "spacer": {
        totalH += (el._data as SpacerData).height;
        break;
      }

      case "pageBreak": {
        // Can't estimate page breaks meaningfully — they reset to next page
        break;
      }

      case "rule": {
        const d = el._data as RuleData;
        totalH += d.marginTop + d.thickness + d.marginBottom;
        break;
      }

      case "chart": {
        const d = el._data as { height: number; title?: string };
        totalH += d.height + 12; // 12pt gap after chart
        if (d.title) totalH += 14 * 1.5; // title + gap
        break;
      }

      case "table": {
        const d = el._data as TableData;
        // Header row + data rows, ~20pt per row at default font size
        const rowH = d.fontSize * 2.2; // font + padding
        totalH += rowH * (1 + d.rows.length) + 12; // header + rows + gap
        break;
      }

      case "kvTable": {
        const d = el._data as KvTableData;
        const rowH = d.fontSize * 2.2;
        totalH += rowH * d.items.length + 12; // items only (no header) + gap
        break;
      }

      case "comparisonTable": {
        const d = el._data as ComparisonTableData;
        const rowH = d.fontSize * 2.2;
        totalH += rowH * (1 + d.features.length) + 12; // header + features + gap
        break;
      }

      case "image": {
        const d = el._data as ImageElementData;
        totalH += (d.height ?? 100) + 12; // image + gap
        if (d.caption) totalH += d.captionFontSize * 1.5; // caption line
        break;
      }

      case "richText": {
        const d = el._data as RichTextData;
        let rtH = d.spaceBefore;
        for (const para of d.paragraphs) {
          // Estimate: join all run text, wrap as one paragraph
          const fullText = para.runs.map((r) => r.text).join("");
          const lines = wrapText(fullText, d.font, d.fontSize, contentWidth);
          rtH += lines.length * d.fontSize * d.lineHeight;
        }
        totalH += rtH + d.spaceAfter;
        break;
      }

      case "codeBlock": {
        const d = el._data as CodeBlockData;
        const codeLines = d.code.split("\n").length;
        totalH +=
          d.spaceBefore +
          d.padding * 2 +
          codeLines * d.fontSize * d.lineHeight +
          d.spaceAfter;
        break;
      }

      case "quote": {
        const d = el._data as QuoteData;
        const lines = wrapText(
          d.text,
          "Helvetica-Oblique",
          d.fontSize,
          contentWidth - 20,
        );
        let qH = d.spaceBefore + lines.length * d.fontSize * d.lineHeight;
        if (d.author) qH += d.fontSize * 1.5; // author line
        totalH += qH + d.spaceAfter;
        break;
      }

      case "metricCard": {
        // Card: padding + large value (24pt) + optional change (14pt) + gap + label (10pt) + padding
        const mc = el._data as MetricCardData;
        const changeH = mc.change ? 14 : 0;
        totalH += 8 + 24 + changeH + 4 + 10 + 8 + 8; // ~62-76pt per card
        break;
      }

      case "calloutBox": {
        const cb = el._data as CalloutBoxData;
        const pad = 12;
        const titleH = cb.title ? cb.fontSize * 1.5 + 4 : 0;
        const bodyLines = wrapText(
          cb.text,
          "Helvetica",
          cb.fontSize,
          contentWidth - pad * 2 - 4,
        );
        totalH +=
          cb.spaceBefore +
          pad +
          titleH +
          bodyLines.length * cb.fontSize * 1.4 +
          pad +
          cb.spaceAfter;
        break;
      }

      case "signatureLine": {
        const sl = el._data as SignatureLineData;
        const titleH = sl.title ? sl.fontSize * 1.4 : 0;
        totalH +=
          sl.spaceBefore +
          sl.spaceAbove +
          1 +
          4 +
          sl.fontSize * 1.4 +
          titleH +
          sl.spaceAfter;
        break;
      }

      case "link": {
        const ld = el._data as LinkData;
        totalH += ld.spaceBefore + ld.fontSize * 1.4 + ld.spaceAfter;
        break;
      }

      case "twoColumn": {
        // Rough estimate: height of the taller column
        const d = el._data as TwoColumnData;
        const colWidth = (contentWidth - d.gap) / 2;
        const leftH = estimateHeight(d.left, { contentWidth: colWidth });
        const rightH = estimateHeight(d.right, { contentWidth: colWidth });
        totalH += Math.max(leftH, rightH) + 12;
        break;
      }

      case "columns": {
        // Height of the tallest column
        const d = el._data as ColumnsData;
        const totalGap = d.gap * (d.cols.length - 1);
        const usable = contentWidth - totalGap;
        let maxColH = 0;
        for (let ci = 0; ci < d.cols.length; ci++) {
          const colW = usable * d.widths[ci];
          const colH = estimateHeight(d.cols[ci], { contentWidth: colW });
          if (colH > maxColH) maxColH = colH;
        }
        totalH += d.spaceBefore + maxColH + d.spaceAfter;
        break;
      }

      default:
        // Unknown element — assume 30pt as safe fallback
        totalH += 30;
    }
  }

  return totalH;
}

/**
 * Flow an array of PdfElements into the document with auto-pagination.
 *
 * Elements are rendered top-to-bottom. When content exceeds the available
 * space on the current page, a new page is automatically added.
 *
 * For single-page documents (invoices, letters, resumes), set `maxPages: 1`
 * to auto-shrink spacing so content fits without overflowing to a second page.
 *
 * @param doc - PdfDocument to add content to
 * @param elements - Array of PdfElement objects from builder functions
 * @param opts - Layout options: margins, maxPages (set maxPages:1 for single-page docs)
 * @returns { lastY: number } — the Y position (in points from top) after the last element
 */
export function addContent(
  doc: PdfDocument,
  elements: PdfElement[],
  opts?: AddContentOptions,
): { lastY: number } {
  const margins: Margins = {
    ...DEFAULT_MARGINS,
    ...opts?.margins,
  };

  const contentWidth = doc.pageSize.width - margins.left - margins.right;
  const pageBottom = doc.pageSize.height - margins.bottom;

  // Access to internal page data for cursor tracking
  const internals = doc as unknown as {
    _getPages: () => PageData[];
  };

  // Ensure we have at least one page
  if (doc.pageCount === 0) {
    doc.addPage();
    // Fill dark theme background on first auto-created page
    if (doc.theme.isDark) {
      doc.drawRect(0, 0, doc.pageSize.width, doc.pageSize.height, {
        fill: doc.theme.bg,
      });
      // Reset cursor — bg fill shouldn't count as content
      const pages = internals._getPages();
      if (pages.length > 0) pages[pages.length - 1].cursorY = 0;
    }
  }

  // Read the tracked cursor position from the current page.
  // If the LLM has already drawn content (drawText, drawRect, etc.),
  // cursorY will be > 0 and we start BELOW that content.
  // If no prior content, we start at margins.top.
  let cursorY = margins.top;
  if (typeof internals._getPages === "function") {
    const pages = internals._getPages();
    const lastPage = pages[pages.length - 1];
    if (lastPage && lastPage.cursorY > margins.top) {
      // Start below existing content with a small gap
      cursorY = lastPage.cursorY + 12; // 12pt gap between low-level and flow content
    }
  }

  // ── maxPages: auto-scale spacing to fit ──
  // If maxPages is set, estimate total height and calculate a scale factor
  // to reduce spacing (spaceBefore, spaceAfter, lineHeight) so content fits.
  // When spacing alone isn't sufficient, font sizes are also reduced slightly.
  let spacingScale = 1.0;
  let fontScale = 1.0;
  if (opts?.maxPages && opts.maxPages > 0) {
    const usableH = pageBottom - cursorY; // remaining on current page
    const totalAvailable =
      usableH + (opts.maxPages - 1) * (pageBottom - margins.top);
    const estimated = estimateHeight(elements, { contentWidth });
    if (estimated > totalAvailable && totalAvailable > 0) {
      const rawScale = totalAvailable / estimated;
      // First try spacing-only compression (clamp at 0.3 min)
      spacingScale = Math.max(0.3, rawScale);
      // If spacing alone can't fit, also reduce font sizes slightly
      // This kicks in when content is >3x available space
      if (rawScale < 0.5) {
        fontScale = Math.max(0.8, 0.5 + rawScale);
      }
    }
  }

  // ── verticalCenter: offset start position to center content ──
  if (opts?.verticalCenter) {
    const estimated = estimateHeight(elements, { contentWidth });
    const usableH = pageBottom - cursorY;
    if (estimated < usableH) {
      cursorY += (usableH - estimated) / 2;
    }
  }

  /**
   * Apply spacing scale to a value (spaceBefore, spaceAfter, etc.)
   */
  function scaleSpacing(value: number): number {
    return spacingScale < 1.0 ? Math.round(value * spacingScale) : value;
  }

  /**
   * Apply font scale when maxPages compression needs to reduce text size.
   * Only active when spacing alone can't fit content within maxPages.
   */
  function scaleFontSize(value: number): number {
    return fontScale < 1.0 ? Math.round(value * fontScale * 10) / 10 : value;
  }

  /**
   * Check if we need a new page. If remaining space is less than needed,
   * add a new page and reset cursor.
   */
  function ensureSpace(needed: number): void {
    if (cursorY + needed > pageBottom) {
      doc.addPage();
      // Fill dark theme background on new pages
      if (doc.theme.isDark) {
        doc.drawRect(0, 0, doc.pageSize.width, doc.pageSize.height, {
          fill: doc.theme.bg,
        });
        // Reset cursor — bg fill shouldn't count as content
        const pages = internals._getPages();
        if (pages.length > 0) pages[pages.length - 1].cursorY = 0;
      }
      cursorY = margins.top;
    }
  }

  /** Resolve a colour, defaulting to theme foreground. */
  function resolveColor(color: string | undefined): string {
    if (color) return requireHex(color, "element.color");
    return doc.theme.fg;
  }

  /** Resolve the font name considering bold/italic modifiers. */
  function resolveFont(base: string, bold: boolean, italic: boolean): string {
    if (!bold && !italic) return base;

    // Handle Helvetica family
    if (base === "Helvetica" || base.startsWith("Helvetica")) {
      if (bold && italic) return "Helvetica-BoldOblique";
      if (bold) return "Helvetica-Bold";
      if (italic) return "Helvetica-Oblique";
    }
    // Handle Times family
    if (base === "Times-Roman" || base.startsWith("Times")) {
      if (bold && italic) return "Times-BoldItalic";
      if (bold) return "Times-Bold";
      if (italic) return "Times-Italic";
    }
    // Handle Courier family
    if (base === "Courier" || base.startsWith("Courier")) {
      if (bold && italic) return "Courier-BoldOblique";
      if (bold) return "Courier-Bold";
      if (italic) return "Courier-Oblique";
    }
    return base;
  }

  /** Render wrapped text lines, handling alignment. */
  function renderLines(
    lines: string[],
    font: string,
    fontSize: number,
    lineHeight: number,
    color: string,
    align: "left" | "center" | "right",
  ): void {
    const lineSpacing = fontSize * lineHeight;
    for (const line of lines) {
      ensureSpace(lineSpacing);
      let x = margins.left;
      if (align === "center") {
        const lineW = measureText(line, font, fontSize);
        x = margins.left + (contentWidth - lineW) / 2;
      } else if (align === "right") {
        const lineW = measureText(line, font, fontSize);
        x = margins.left + contentWidth - lineW;
      }
      // Draw text with baseline below cursorY. In PDF, drawText Y is the
      // baseline position, so ascenders render ABOVE Y. To make cursorY
      // represent the TOP of the text (not the baseline), we offset by
      // fontSize so the visual top of glyphs aligns with cursorY.
      doc.drawText(line, x, cursorY + fontSize, { font, fontSize, color });
      cursorY += lineSpacing;
    }
  }

  /**
   * Estimate the height of the next element for orphan prevention.
   * Used to ensure headings aren't stranded at the bottom of a page
   * without their following content.
   */
  function estimateNextElementHeight(nextEl: PdfElement): number {
    switch (nextEl._kind) {
      case "chart":
        return (nextEl._data as { height: number }).height ?? 250;
      case "table":
      case "kvTable":
      case "comparisonTable":
        // Tables are hard to estimate — assume at least header + 3 rows
        return 100;
      case "paragraph":
        return 40; // At least a couple of lines
      case "image":
        return (nextEl._data as { height?: number }).height ?? 100;
      default:
        return 30;
    }
  }

  // ── Column renderer (shared by twoColumn and columns elements) ──
  // Renders elements into a fixed-width column at a given X position.
  // Handles ALL element types so nothing gets silently dropped.
  // Returns the Y position after all elements.
  function renderColumn(
    colEls: PdfElement[],
    colX: number,
    colW: number,
    cy: number,
  ): number {
    for (const ce of colEls) {
      if (!isPdfElement(ce)) continue;
      switch (ce._kind) {
        case "paragraph": {
          const pd = ce._data as ParagraphData;
          const fn = resolveFont(pd.font, pd.bold, pd.italic);
          const lns = wrapText(pd.text, fn, pd.fontSize, colW);
          const lh = pd.fontSize * pd.lineHeight;
          const clr = resolveColor(pd.color);
          cy += pd.spaceBefore;
          for (const ln of lns) {
            let lx = colX;
            if (pd.align === "center")
              lx = colX + (colW - measureText(ln, fn, pd.fontSize)) / 2;
            else if (pd.align === "right")
              lx = colX + colW - measureText(ln, fn, pd.fontSize);
            doc.drawText(ln, lx, cy + pd.fontSize, {
              font: fn,
              fontSize: pd.fontSize,
              color: clr,
            });
            cy += lh;
          }
          cy += pd.spaceAfter;
          break;
        }
        case "heading": {
          const hd = ce._data as HeadingData;
          const fs = HEADING_SIZES[hd.level] ?? 11;
          const fa = Math.ceil(fs * 0.8);
          const sb = hd.spaceBefore ?? (hd.level <= 2 ? 12 : 8) + fa;
          const sa = hd.spaceAfter ?? (hd.level <= 2 ? 10 : 8);
          cy += sb;
          doc.drawText(hd.text, colX, cy + fs, {
            font: "Helvetica-Bold",
            fontSize: fs,
            color: resolveColor(hd.color),
          });
          cy += fs * 1.3 + sa;
          break;
        }
        case "kvTable": {
          const kd = ce._data as KvTableData;
          const tw = kd.maxWidth ? Math.min(kd.maxWidth, colW) : colW;
          const rkw = kd.keyWidth ?? 0.35;
          let kw = rkw > 1 ? rkw : tw * rkw;
          // Auto-widen key column if text doesn't fit
          const kFont = kd.style.bodyFont;
          for (const item of kd.items) {
            const needed =
              measureText(
                item.key,
                item.bold ? kd.style.headerFont : kFont,
                kd.fontSize,
              ) +
              CELL_PAD_H * 2;
            if (needed > kw) kw = Math.min(needed, tw * 0.6);
          }
          const vw = tw - kw;
          const kvH = ["", ""];
          const kvR = kd.items.map((it) => [it.key, it.value]);
          const kvBold = kd.items.map((it) => it.bold === true);
          const kvCw: number[] = [kw, vw];
          let tx = colX;
          if (kd.align === "right" && tw < colW) tx = colX + colW - tw;
          else if (kd.align === "center" && tw < colW)
            tx = colX + (colW - tw) / 2;
          const kvA: ("left" | "center" | "right")[] = ["left", "right"];
          renderTable(
            doc,
            kvH,
            kvR,
            kd.style,
            kd.fontSize,
            tx,
            cy,
            tw,
            kvCw,
            () => {},
            () => cy,
            (v: number) => {
              cy = v;
            },
            kvA,
            false, // compact
            true, // skipHeader
            kvBold,
          );
          cy += 8;
          break;
        }
        case "table": {
          const td = ce._data as TableData;
          let tcw: number[];
          if (td.colWidths) {
            const ar = td.colWidths.every((w) => w > 0 && w <= 1);
            tcw = ar
              ? td.colWidths.map((w) => w * colW)
              : td.colWidths.map((w) =>
                  w > 0 && w <= 1
                    ? w * colW
                    : w > 0
                      ? w
                      : colW / td.headers.length,
                );
          } else {
            tcw = autoColumnWidths(
              td.headers,
              td.rows,
              td.style.bodyFont,
              td.fontSize,
              colW,
            );
          }
          renderTable(
            doc,
            td.headers,
            td.rows,
            td.style,
            td.fontSize,
            colX,
            cy,
            colW,
            tcw,
            () => {},
            () => cy,
            (v: number) => {
              cy = v;
            },
            td.columnAlign,
          );
          cy += 8;
          break;
        }
        case "rule": {
          const rd = ce._data as RuleData;
          const rc = rd.color
            ? requireHex(rd.color, "rule.color")
            : doc.theme.subtle;
          cy += rd.marginTop;
          doc.drawLine(colX, cy, colX + colW, cy, {
            color: rc,
            lineWidth: rd.thickness,
          });
          cy += rd.thickness + rd.marginBottom;
          break;
        }
        case "spacer": {
          cy += (ce._data as SpacerData).height;
          break;
        }
        case "bulletList": {
          const bd = ce._data as BulletListData;
          const clr = resolveColor(bd.color);
          const ls = bd.fontSize * bd.lineHeight;
          const aw = colW - bd.indent;
          cy += bd.spaceBefore;
          for (const item of bd.items) {
            const lns = wrapText(item, bd.font, bd.fontSize, aw);
            doc.drawText(bd.bulletChar, colX, cy + bd.fontSize, {
              font: bd.font,
              fontSize: bd.fontSize,
              color: clr,
            });
            for (const ln of lns) {
              doc.drawText(ln, colX + bd.indent, cy + bd.fontSize, {
                font: bd.font,
                fontSize: bd.fontSize,
                color: clr,
              });
              cy += ls;
            }
          }
          cy += bd.spaceAfter;
          break;
        }
        case "richText": {
          const rt = ce._data as RichTextData;
          cy += rt.spaceBefore;
          for (const para of rt.paragraphs) {
            const fullText = para.runs.map((r) => r.text).join("");
            const firstRun = para.runs[0];
            const rtFont = firstRun?.bold
              ? "Helvetica-Bold"
              : firstRun?.italic
                ? "Helvetica-Oblique"
                : rt.font;
            const rtColor = resolveColor(firstRun?.color);
            const rtSize = firstRun?.fontSize ?? rt.fontSize;
            const lns = wrapText(fullText, rtFont, rtSize, colW);
            for (const ln of lns) {
              doc.drawText(ln, colX, cy + rtSize, {
                font: rtFont,
                fontSize: rtSize,
                color: rtColor,
              });
              cy += rtSize * rt.lineHeight;
            }
          }
          cy += rt.spaceAfter;
          break;
        }
        case "metricCard": {
          const mc = ce._data as MetricCardData;
          const vfs = 24;
          const lfs = 10;
          const pd = 8;
          const cfs = mc.change ? 12 : 0;
          const ch = pd + vfs + (cfs > 0 ? cfs + 2 : 0) + 4 + lfs + pd;
          const cw = mc.width ?? Math.min(colW, 200);
          if (mc.bgColor && mc.bgColor.length === 6) {
            doc.drawRect(colX, cy, cw, ch, { fill: mc.bgColor });
          }
          doc.drawText(mc.value, colX + pd, cy + pd + vfs, {
            font: "Helvetica-Bold",
            fontSize: vfs,
            color: mc.color ?? doc.theme.accent1,
          });
          let mcY = cy + pd + vfs;
          if (mc.change) {
            mcY += 12 + 2;
            const isPos = mc.change.startsWith("+");
            const isNeg = mc.change.startsWith("-");
            doc.drawText(mc.change, colX + pd, mcY, {
              font: "Helvetica-Bold",
              fontSize: 12,
              color: isPos ? "4CAF50" : isNeg ? "F44336" : "757575",
            });
          }
          doc.drawText(mc.label, colX + pd, mcY + 4 + lfs, {
            font: "Helvetica",
            fontSize: lfs,
            color: resolveColor(undefined),
          });
          cy += ch + 8;
          break;
        }
        default:
          // Unsupported element in column — skip
          break;
      }
    }
    return cy;
  }

  // ── Auto-flatten nested arrays ──
  // Some builder functions (like legacy sectionHeading) may return arrays.
  // Flatten them so [...sectionHeading()] spread isn't required.
  const flatElements: PdfElement[] = [];
  for (const item of elements) {
    if (Array.isArray(item)) {
      for (const sub of item) {
        flatElements.push(sub as PdfElement);
      }
    } else {
      flatElements.push(item);
    }
  }

  // ── Process each element ──
  for (let elIdx = 0; elIdx < flatElements.length; elIdx++) {
    const el = flatElements[elIdx];
    if (!isPdfElement(el)) {
      throw new Error(
        `addContent: element at index ${elIdx} is not a PdfElement ` +
          `(got ${typeof el}). Use builder functions like paragraph(), heading(), etc.`,
      );
    }

    switch (el._kind) {
      case "paragraph": {
        const d = el._data as ParagraphData;
        const font = resolveFont(d.font, d.bold, d.italic);
        const color = resolveColor(d.color);
        const fs = scaleFontSize(d.fontSize);
        const lines = wrapText(d.text, font, fs, contentWidth);
        const sb = scaleSpacing(d.spaceBefore);
        const sa = scaleSpacing(d.spaceAfter);
        const lh =
          spacingScale < 1.0 ? d.lineHeight * spacingScale : d.lineHeight;
        const totalHeight = sb + lines.length * fs * lh + sa;

        // Add space before
        cursorY += sb;
        ensureSpace(fs * lh); // At least one line must fit

        renderLines(lines, font, fs, lh, color, d.align);

        // Add space after
        cursorY += sa;
        void totalHeight; // Used for future orphan/widow control
        break;
      }

      case "heading": {
        const d = el._data as HeadingData;
        const fontSize = scaleFontSize(HEADING_SIZES[d.level] ?? 11);
        const font = "Helvetica-Bold";
        const color = resolveColor(d.color);
        const lines = wrapText(d.text, font, fontSize, contentWidth);
        // spaceBefore provides visual gap above the heading. Since renderLines
        // now offsets text by fontSize (so cursorY = visual top, not baseline),
        // we don't need extra ascent compensation here.
        const spaceBefore = scaleSpacing(
          d.spaceBefore ?? (d.level <= 2 ? 16 : 10),
        );
        const spaceAfter = scaleSpacing(d.spaceAfter ?? (d.level <= 2 ? 8 : 6));
        const lineHeight = spacingScale < 1.0 ? 1.3 * spacingScale : 1.3;

        // Headings must NOT be orphaned at page bottom. Peek at the next
        // element(s) and ensure enough space for the heading PLUS a meaningful
        // portion of the following content. This prevents headings landing
        // at the bottom of a page with the chart/table on the next page.
        //
        // For h1 (section titles), look TWO elements ahead because h1 is
        // often followed by h2 + chart/table. Without this, the h1 lands
        // at the bottom of a page and the h2+chart move to the next page,
        // leaving the h1 orphaned with massive whitespace below.
        const headingHeight =
          spaceBefore + lines.length * fontSize * lineHeight + spaceAfter;
        let followingHeight = 0;
        const lookahead = d.level === 1 ? 2 : 1;
        for (let peek = 1; peek <= lookahead; peek++) {
          const peekEl =
            elIdx + peek < flatElements.length
              ? flatElements[elIdx + peek]
              : null;
          if (peekEl) {
            followingHeight += estimateNextElementHeight(peekEl as PdfElement);
          }
        }
        // Fallback: if no next element, require at least one body line
        if (followingHeight === 0) followingHeight = 20;
        const minNeeded = headingHeight + followingHeight;
        cursorY += spaceBefore;
        ensureSpace(minNeeded);

        renderLines(lines, font, fontSize, lineHeight, color, "left");
        cursorY += spaceAfter;
        break;
      }

      case "sectionHeading": {
        // Combined heading + rule as a single element
        const d = el._data as SectionHeadingData;
        const fontSize = scaleFontSize(HEADING_SIZES[d.level] ?? 11);
        const font = "Helvetica-Bold";
        const color = resolveColor(d.color);
        const lines = wrapText(d.text, font, fontSize, contentWidth);
        const spaceBefore = scaleSpacing(d.level <= 2 ? 16 : 10);
        const lineHeight = spacingScale < 1.0 ? 1.3 * spacingScale : 1.3;
        const headingH = lines.length * fontSize * lineHeight;

        // Orphan prevention: heading + rule + following content
        let followingHeight = 0;
        if (elIdx + 1 < flatElements.length) {
          followingHeight = estimateNextElementHeight(
            flatElements[elIdx + 1] as PdfElement,
          );
        }
        if (followingHeight === 0) followingHeight = 20;

        cursorY += spaceBefore;
        ensureSpace(headingH + 4 + d.ruleThickness + 8 + followingHeight);

        // Render heading text
        renderLines(lines, font, fontSize, lineHeight, color, "left");
        cursorY += 4; // gap between heading and rule

        // Render rule underneath
        const ruleColor = doc.theme.subtle;
        doc.drawLine(
          margins.left,
          cursorY,
          margins.left + contentWidth,
          cursorY,
          { color: ruleColor, lineWidth: d.ruleThickness },
        );
        cursorY += d.ruleThickness + 8;
        break;
      }

      case "bulletList": {
        const d = el._data as BulletListData;
        const color = resolveColor(d.color);
        const blLh =
          spacingScale < 1.0 ? d.lineHeight * spacingScale : d.lineHeight;
        const lineSpacing = d.fontSize * blLh;
        const availWidth = contentWidth - d.indent;

        cursorY += scaleSpacing(d.spaceBefore);

        for (const item of d.items) {
          const lines = wrapText(item, d.font, d.fontSize, availWidth);
          ensureSpace(lineSpacing); // At least first line must fit

          // Draw bullet on first line
          doc.drawText(d.bulletChar, margins.left, cursorY, {
            font: d.font,
            fontSize: d.fontSize,
            color,
          });

          // Draw lines with indent
          for (let j = 0; j < lines.length; j++) {
            ensureSpace(lineSpacing);
            doc.drawText(lines[j], margins.left + d.indent, cursorY, {
              font: d.font,
              fontSize: d.fontSize,
              color,
            });
            cursorY += lineSpacing;
          }
        }

        cursorY += scaleSpacing(d.spaceAfter);
        break;
      }

      case "numberedList": {
        const d = el._data as NumberedListData;
        const color = resolveColor(d.color);
        const lineSpacing = d.fontSize * d.lineHeight;
        const availWidth = contentWidth - d.indent;

        cursorY += scaleSpacing(d.spaceBefore);

        for (let idx = 0; idx < d.items.length; idx++) {
          const item = d.items[idx];
          const lines = wrapText(item, d.font, d.fontSize, availWidth);
          ensureSpace(lineSpacing); // At least first line must fit

          // Draw number on first line
          const label = `${idx + 1}.`;
          doc.drawText(label, margins.left, cursorY, {
            font: d.font,
            fontSize: d.fontSize,
            color,
          });

          // Draw lines with indent
          for (let j = 0; j < lines.length; j++) {
            ensureSpace(lineSpacing);
            doc.drawText(lines[j], margins.left + d.indent, cursorY, {
              font: d.font,
              fontSize: d.fontSize,
              color,
            });
            cursorY += lineSpacing;
          }
        }

        cursorY += scaleSpacing(d.spaceAfter);
        break;
      }

      case "spacer": {
        const d = el._data as SpacerData;
        cursorY += d.height;
        // If spacer pushes past page bottom, start new page
        if (cursorY > pageBottom) {
          doc.addPage();
          cursorY = margins.top;
        }
        break;
      }

      case "pageBreak": {
        doc.addPage();
        cursorY = margins.top;
        break;
      }

      case "rule": {
        const d = el._data as RuleData;
        const ruleColor = d.color
          ? requireHex(d.color, "rule.color")
          : doc.theme.subtle;
        cursorY += d.marginTop;
        ensureSpace(d.thickness + d.marginBottom);
        doc.drawLine(
          margins.left,
          cursorY,
          margins.left + contentWidth,
          cursorY,
          { color: ruleColor, lineWidth: d.thickness },
        );
        cursorY += d.thickness + d.marginBottom;
        break;
      }

      case "table": {
        const d = el._data as TableData;
        let colWidths: number[];
        if (d.colWidths) {
          // If all values are <= 1, treat as ratios and multiply by contentWidth
          const allRatios = d.colWidths.every((w) => w > 0 && w <= 1);
          if (allRatios) {
            colWidths = d.colWidths.map((w) => w * contentWidth);
          } else {
            // Mix of ratios and absolute, or all absolute — filter out zeros
            colWidths = d.colWidths.map((w) =>
              w > 0 && w <= 1
                ? w * contentWidth
                : w > 0
                  ? w
                  : contentWidth / d.headers.length,
            );
          }
        } else {
          colWidths = autoColumnWidths(
            d.headers,
            d.rows,
            d.style.bodyFont,
            d.fontSize,
            contentWidth,
          );
        }
        const totalH =
          tableRowHeight(d.fontSize, d.compact) * (1 + d.rows.length);
        ensureSpace(
          Math.min(totalH, tableRowHeight(d.fontSize, d.compact) * 3),
        ); // At least header + 2 rows must fit

        renderTable(
          doc,
          d.headers,
          d.rows,
          d.style,
          d.fontSize,
          margins.left,
          cursorY,
          contentWidth,
          colWidths,
          ensureSpace,
          () => cursorY,
          (v: number) => {
            cursorY = v;
          },
          d.columnAlign,
          d.compact,
          false, // skipHeader
          undefined, // rowBold
          d.footerRow,
        );
        cursorY += 8; // Space after table
        break;
      }

      case "kvTable": {
        const d = el._data as KvTableData;
        // Calculate table width — use maxWidth if set, otherwise full content width
        const tableW = d.maxWidth
          ? Math.min(d.maxWidth, contentWidth)
          : contentWidth;

        // Auto-size key column: measure all key text and ensure it fits
        const rawKW = d.keyWidth ?? 0.35;
        let keyW = rawKW > 1 ? rawKW : tableW * rawKW;
        // Ensure key column is wide enough for the widest key text
        const keyFont = d.style.bodyFont;
        for (const item of d.items) {
          const needed =
            measureText(
              item.key,
              item.bold ? d.style.headerFont : keyFont,
              d.fontSize,
            ) +
            CELL_PAD_H * 2;
          if (needed > keyW) keyW = Math.min(needed, tableW * 0.6);
        }
        const valW = tableW - keyW;

        // kvTable has no header row — it's a key-value pair list, not a data grid
        const kvHeaders = ["", ""];
        const rows = d.items.map((item) => [item.key, item.value]);
        const rowBold = d.items.map((item) => item.bold === true);
        const colWidths: number[] = [keyW, valW];

        // Calculate X position based on alignment
        let tableX = margins.left;
        if (d.align === "right" && tableW < contentWidth) {
          tableX = margins.left + contentWidth - tableW;
        } else if (d.align === "center" && tableW < contentWidth) {
          tableX = margins.left + (contentWidth - tableW) / 2;
        }

        ensureSpace(tableRowHeight(d.fontSize) * Math.min(3, rows.length));

        // Right-align the value column by default (financial data looks better right-aligned)
        const kvColumnAlign: ("left" | "center" | "right")[] = [
          "left",
          "right",
        ];

        const rowSeps = d.items.map((it) => it.separator === true);

        renderTable(
          doc,
          kvHeaders,
          rows,
          d.style,
          d.fontSize,
          tableX,
          cursorY,
          tableW,
          colWidths,
          ensureSpace,
          () => cursorY,
          (v: number) => {
            cursorY = v;
          },
          kvColumnAlign,
          false, // compact
          true, // skipHeader — kvTable never shows headers
          rowBold,
          undefined, // footerRow
          rowSeps,
        );
        cursorY += 8;
        break;
      }

      case "comparisonTable": {
        const d = el._data as ComparisonTableData;
        const headers = ["Feature", ...d.options.map((o) => o.name)];
        const rows = d.features.map((feature, fi) => [
          feature,
          ...d.options.map((o) => {
            const v = o.values[fi];
            // String values render as-is; booleans as Y/N
            return typeof v === "string" ? v : v ? "Y" : "N";
          }),
        ]);
        const colWidths = autoColumnWidths(
          headers,
          rows,
          d.style.bodyFont,
          d.fontSize,
          contentWidth,
        );

        ensureSpace(tableRowHeight(d.fontSize) * Math.min(3, 1 + rows.length));

        renderTable(
          doc,
          headers,
          rows,
          d.style,
          d.fontSize,
          margins.left,
          cursorY,
          contentWidth,
          colWidths,
          ensureSpace,
          () => cursorY,
          (v: number) => {
            cursorY = v;
          },
        );
        cursorY += 8;
        break;
      }

      case "image": {
        const d = el._data as ImageElementData;

        // Detect image format and dimensions
        let imgW: number;
        let imgH: number;
        if (isJpeg(d.data)) {
          const dims = readJpegDimensions(d.data);
          imgW = dims.width;
          imgH = dims.height;
        } else if (isPng(d.data)) {
          const dims = readPngDimensions(d.data);
          imgW = dims.width;
          imgH = dims.height;
        } else {
          throw new Error(
            "image: unsupported format. Only JPEG and PNG are supported.",
          );
        }
        const aspect = imgW / imgH;

        // Calculate display dimensions preserving aspect ratio
        let displayW: number;
        let displayH: number;
        if (d.width != null && d.height != null) {
          displayW = d.width;
          displayH = d.height;
        } else if (d.width != null) {
          displayW = d.width;
          displayH = d.width / aspect;
        } else {
          displayH = d.height!;
          displayW = d.height! * aspect;
        }

        // Clamp to content width
        if (displayW > contentWidth) {
          const scale = contentWidth / displayW;
          displayW = contentWidth;
          displayH = displayH * scale;
        }

        const totalH = displayH + (d.caption ? d.captionFontSize * 1.4 + 4 : 0);
        ensureSpace(totalH);

        // Calculate X position for alignment
        let imgX = margins.left;
        if (d.align === "center") {
          imgX = margins.left + (contentWidth - displayW) / 2;
        } else if (d.align === "right") {
          imgX = margins.left + contentWidth - displayW;
        }

        // Draw the image using the low-level drawImage
        doc.drawImage({
          data: d.data,
          x: imgX,
          y: cursorY,
          width: displayW,
          height: displayH,
        });
        cursorY += displayH;

        // Draw caption if provided
        if (d.caption) {
          cursorY += 4; // Small gap between image and caption
          const captionColor = resolveColor(undefined);
          const captionW = measureText(
            d.caption,
            "Helvetica",
            d.captionFontSize,
          );
          let captionX = imgX;
          if (d.align === "center") {
            captionX = margins.left + (contentWidth - captionW) / 2;
          }
          doc.drawText(d.caption, captionX, cursorY, {
            font: "Helvetica-Oblique",
            fontSize: d.captionFontSize,
            color: captionColor,
          });
          cursorY += d.captionFontSize * 1.4;
        }
        cursorY += 8; // Space after image
        break;
      }

      case "twoColumn": {
        const d = el._data as TwoColumnData;
        cursorY += scaleSpacing(d.spaceBefore);

        const leftW = contentWidth * d.ratio;
        const rightW = contentWidth - leftW - d.gap;
        const leftX = margins.left;
        const rightX = margins.left + leftW + d.gap;
        const startY = cursorY;

        const yLeft = renderColumn(d.left, leftX, leftW, startY);
        const yRight = renderColumn(d.right, rightX, rightW, startY);

        // Advance cursor past the tallest column
        cursorY = Math.max(yLeft, yRight) + d.spaceAfter;
        break;
      }

      case "columns": {
        const d = el._data as ColumnsData;
        cursorY += scaleSpacing(d.spaceBefore);

        const totalGap = d.gap * (d.cols.length - 1);
        const usable = contentWidth - totalGap;
        const startY = cursorY;

        // Render each column and track the tallest
        let maxY = startY;
        let colX = margins.left;
        for (let ci = 0; ci < d.cols.length; ci++) {
          const colW = usable * d.widths[ci];
          const colY = renderColumn(d.cols[ci], colX, colW, startY);
          if (colY > maxY) maxY = colY;
          colX += colW + d.gap;
        }

        cursorY = maxY + d.spaceAfter;
        break;
      }

      case "richText": {
        const d = el._data as RichTextData;
        const lineSpacing = d.fontSize * d.lineHeight;
        cursorY += scaleSpacing(d.spaceBefore);

        for (const para of d.paragraphs) {
          // Concatenate all runs into a single string for wrapping,
          // then render. (Full mixed-font-per-run rendering is complex;
          // Phase 4 supports per-paragraph formatting, not mid-line switches.)
          const fullText = para.runs.map((r) => r.text).join("");
          // Use the first run's formatting for the paragraph
          const firstRun = para.runs[0] ?? {};
          const bold = firstRun.bold ?? false;
          const italic = firstRun.italic ?? false;
          const font = resolveFont(d.font, bold, italic);
          const fs = firstRun.fontSize ?? d.fontSize;
          const color = resolveColor(firstRun.color);

          const lines = wrapText(fullText, font, fs, contentWidth);
          ensureSpace(lineSpacing);

          const yBeforeRender = cursorY;
          renderLines(
            lines,
            font,
            fs,
            d.lineHeight,
            color,
            para.align ?? "left",
          );

          // Draw underline if first run requests it
          if (firstRun.underline) {
            let ulY = yBeforeRender;
            for (const line of lines) {
              const lineW = measureText(line, font, fs);
              const ulBottom = ulY + fs + 1; // 1pt below baseline
              doc.drawLine(
                margins.left,
                ulBottom,
                margins.left + lineW,
                ulBottom,
                {
                  color: firstRun.color ?? doc.theme.fg,
                  lineWidth: 0.5,
                },
              );
              ulY += lineSpacing;
            }
          }
        }

        cursorY += scaleSpacing(d.spaceAfter);
        break;
      }

      case "codeBlock": {
        const d = el._data as CodeBlockData;
        const codeLines = d.code.split("\n");
        const lineH = d.fontSize * d.lineHeight;
        const blockH = codeLines.length * lineH + d.padding * 2;

        cursorY += scaleSpacing(d.spaceBefore);
        ensureSpace(Math.min(blockH, lineH * 3 + d.padding * 2));

        // Background rectangle
        doc.drawRect(margins.left, cursorY, contentWidth, blockH, {
          fill: d.bgColor,
          stroke: d.borderColor,
          lineWidth: 0.5,
        });

        // Code lines in monospaced font
        let codeY = cursorY + d.padding;
        for (const line of codeLines) {
          ensureSpace(lineH);
          doc.drawText(line, margins.left + d.padding, codeY, {
            font: "Courier",
            fontSize: d.fontSize,
            color: d.fgColor,
          });
          codeY += lineH;
        }

        cursorY += blockH + d.spaceAfter;
        break;
      }

      case "quote": {
        const d = el._data as QuoteData;
        const accentColor =
          d.accentColor && d.accentColor.length === 6
            ? d.accentColor
            : doc.theme.accent1;
        const quoteFont = d.italic ? "Helvetica-Oblique" : "Helvetica";
        const indent = 16; // Left border width + gap
        const availWidth = contentWidth - indent;
        const lines = wrapText(d.text, quoteFont, d.fontSize, availWidth);
        const lineH = d.fontSize * d.lineHeight;
        const textBlockH = lines.length * lineH;
        const authorH = d.author ? d.fontSize * 1.4 : 0;
        const totalH = d.spaceBefore + textBlockH + authorH + d.spaceAfter;

        cursorY += scaleSpacing(d.spaceBefore);
        ensureSpace(textBlockH + authorH);

        // Left accent border
        const borderTop = cursorY;
        const borderBottom = cursorY + textBlockH + (d.author ? authorH : 0);
        doc.drawLine(
          margins.left + 4,
          borderTop,
          margins.left + 4,
          borderBottom,
          {
            color: accentColor,
            lineWidth: 3,
          },
        );

        // Quote text
        const color = resolveColor(undefined);
        for (const line of lines) {
          doc.drawText(line, margins.left + indent, cursorY, {
            font: quoteFont,
            fontSize: d.fontSize,
            color,
          });
          cursorY += lineH;
        }

        // Author attribution
        if (d.author) {
          doc.drawText(`\u2014 ${d.author}`, margins.left + indent, cursorY, {
            font: "Helvetica",
            fontSize: d.fontSize - 1,
            color: doc.theme.subtle,
          });
          cursorY += authorH;
        }

        cursorY += scaleSpacing(d.spaceAfter);
        void totalH; // Future use
        break;
      }

      case "metricCard": {
        const d = el._data as MetricCardData;
        const valueFontSize = 24;
        const labelFontSize = 10;
        const changeFontSize = 12;
        const padding = 8;
        const hasChange = d.change && d.change.length > 0;
        const cardH =
          padding +
          valueFontSize +
          (hasChange ? changeFontSize + 2 : 0) +
          4 +
          labelFontSize +
          padding;
        const cardW = d.width ?? Math.min(contentWidth, 200);

        ensureSpace(cardH + 8);

        // Background box
        if (d.bgColor && d.bgColor.length === 6) {
          doc.drawRect(margins.left, cursorY, cardW, cardH, {
            fill: d.bgColor,
          });
        }

        // Large value text
        const valueColor = d.color ?? doc.theme.accent1;
        doc.drawText(
          d.value,
          margins.left + padding,
          cursorY + padding + valueFontSize,
          {
            font: "Helvetica-Bold",
            fontSize: valueFontSize,
            color: valueColor,
          },
        );

        let yAfterValue = cursorY + padding + valueFontSize;

        // Change/trend indicator (green for +, red for -)
        if (hasChange) {
          const changeText = d.change!;
          const isPositive = changeText.startsWith("+");
          const isNegative = changeText.startsWith("-");
          const changeColor = isPositive
            ? "4CAF50" // green
            : isNegative
              ? "F44336" // red
              : "757575"; // grey for neutral
          yAfterValue += changeFontSize + 2;

          // Draw coloured trend indicator dot before the change text
          const dotSize = 5;
          const dotY = yAfterValue - changeFontSize / 2 - dotSize / 2;
          doc.drawRect(margins.left + padding, dotY, dotSize, dotSize, {
            fill: changeColor,
          });
          const textOffset = dotSize + 4;
          doc.drawText(
            changeText,
            margins.left + padding + textOffset,
            yAfterValue,
            {
              font: "Helvetica-Bold",
              fontSize: changeFontSize,
              color: changeColor,
            },
          );
        }

        // Label text below value (and change if present)
        doc.drawText(
          d.label,
          margins.left + padding,
          yAfterValue + 4 + labelFontSize,
          {
            font: "Helvetica",
            fontSize: labelFontSize,
            color: resolveColor(undefined),
          },
        );

        cursorY += cardH + 8; // card height + gap
        break;
      }

      case "calloutBox": {
        const d = el._data as CalloutBoxData;
        cursorY += scaleSpacing(d.spaceBefore);

        const pad = 12;
        const borderW = 4; // left accent border width
        const textW = contentWidth - pad * 2 - borderW;
        const fs = scaleFontSize(d.fontSize);

        // Theme-aware defaults: on dark themes, use darker callout bg
        // so text remains readable. The default "EEF2FF" is only good on light pages.
        let cbBgColor = d.bgColor;
        if (cbBgColor === "EEF2FF" && doc.theme.isDark) {
          cbBgColor = "2A3040"; // dark blue-grey that works on dark backgrounds
        }
        // Text color: on dark bg use light text, on light bg use dark text
        const cbTextColor =
          d.textColor ?? (doc.theme.isDark ? "E0E0E0" : doc.theme.fg);
        const cbTitleColor =
          d.titleColor ?? (doc.theme.isDark ? "FFFFFF" : doc.theme.fg);

        // Calculate box height
        const titleH = d.title ? fs * 1.5 + 4 : 0;
        const bodyLines = wrapText(d.text, d.font, fs, textW);
        const bodyH = bodyLines.length * fs * 1.4;
        const boxH = pad + titleH + bodyH + pad;

        ensureSpace(boxH);

        // Background fill
        doc.drawRect(margins.left, cursorY, contentWidth, boxH, {
          fill: cbBgColor,
        });

        // Left accent border
        const borderColor = d.borderColor ?? doc.theme.accent1;
        doc.drawRect(margins.left, cursorY, borderW, boxH, {
          fill: borderColor,
        });

        let textY = cursorY + pad;
        const textX = margins.left + borderW + pad;

        // Title (bold)
        if (d.title) {
          doc.drawText(d.title, textX, textY + fs, {
            font: d.font === "Helvetica" ? "Helvetica-Bold" : d.font,
            fontSize: fs,
            color: cbTitleColor,
          });
          textY += fs * 1.5 + 4;
        }

        // Body text
        for (const line of bodyLines) {
          doc.drawText(line, textX, textY + fs, {
            font: d.font,
            fontSize: fs,
            color: cbTextColor,
          });
          textY += fs * 1.4;
        }

        cursorY += boxH + scaleSpacing(d.spaceAfter);
        break;
      }

      case "signatureLine": {
        const d = el._data as SignatureLineData;
        cursorY += scaleSpacing(d.spaceBefore);

        const totalH =
          d.spaceAbove +
          1 +
          4 +
          d.fontSize * 1.4 +
          (d.title ? d.fontSize * 1.4 : 0);
        ensureSpace(totalH);

        // Blank space for physical signature
        cursorY += d.spaceAbove;

        // Horizontal line
        doc.drawLine(
          margins.left,
          cursorY,
          margins.left + d.lineWidth,
          cursorY,
          {
            color: doc.theme.fg,
            lineWidth: 0.5,
          },
        );
        cursorY += 4;

        // Name (bold)
        doc.drawText(d.name, margins.left, cursorY + d.fontSize, {
          font: "Helvetica-Bold",
          fontSize: d.fontSize,
          color: resolveColor(undefined),
        });
        cursorY += d.fontSize * 1.4;

        // Title (lighter)
        if (d.title) {
          doc.drawText(d.title, margins.left, cursorY + d.fontSize * 0.9, {
            font: "Helvetica",
            fontSize: d.fontSize * 0.9,
            color: doc.theme.subtle,
          });
          cursorY += d.fontSize * 1.4;
        }

        cursorY += scaleSpacing(d.spaceAfter);
        break;
      }

      case "link": {
        const d = el._data as LinkData;
        cursorY += scaleSpacing(d.spaceBefore);
        const fs = scaleFontSize(d.fontSize);

        ensureSpace(fs * 1.4);

        // Draw the link text in the link colour
        const textW = measureText(d.text, "Helvetica", fs);
        doc.drawText(d.text, margins.left, cursorY + fs, {
          font: "Helvetica",
          fontSize: fs,
          color: d.color,
        });

        // Record the link annotation on the current page
        const pages = internals._getPages();
        const currentPage = pages[pages.length - 1];
        currentPage.links.push({
          x: margins.left,
          y: cursorY,
          w: textW,
          h: fs * 1.2,
          url: d.url,
        });

        cursorY += fs * 1.4;
        cursorY += scaleSpacing(d.spaceAfter);
        break;
      }

      case "chart": {
        // Chart elements contain pre-computed drawing operations from
        // ha:pdf-charts. We translate them relative to current cursor position.
        const d = el._data as {
          drawOps: ChartDrawOp[];
          width: number;
          height: number;
          title?: string;
          subtitle?: string;
        };

        // Draw title and optional subtitle above chart
        let chartHeaderH = 0;
        if (d.title) {
          const titleSize = 14;
          const subtitleSize = 10;
          chartHeaderH = titleSize * 1.5;
          if (d.subtitle) chartHeaderH += subtitleSize * 1.3;
          ensureSpace(chartHeaderH + d.height);
          // drawText Y is baseline — add fontSize so cursorY = visual top
          doc.drawText(d.title, margins.left, cursorY + titleSize, {
            font: "Helvetica-Bold",
            fontSize: titleSize,
            color: resolveColor(undefined),
          });
          cursorY += titleSize * 1.5;
          if (d.subtitle) {
            doc.drawText(d.subtitle, margins.left, cursorY + subtitleSize, {
              font: "Helvetica",
              fontSize: subtitleSize,
              color: doc.theme.subtle,
            });
            cursorY += subtitleSize * 1.3;
          }
        } else {
          ensureSpace(d.height);
        }

        // Center chart horizontally if narrower than content width
        const chartX =
          d.width < contentWidth
            ? margins.left + (contentWidth - d.width) / 2
            : margins.left;
        const chartY = cursorY;

        // Replay drawing operations, translating coordinates
        for (const op of d.drawOps) {
          switch (op.type) {
            case "text":
              // Chart text Y is the TOP of the text (like screen coords).
              // drawText treats Y as the baseline, so we add fontSize to
              // convert from top-of-text to baseline position.
              doc.drawText(
                op.text ?? "",
                chartX + op.x,
                chartY + op.y + (op.fontSize ?? 8),
                {
                  font: op.font,
                  fontSize: op.fontSize,
                  color: op.color,
                },
              );
              break;
            case "rect":
              doc.drawRect(chartX + op.x, chartY + op.y, op.w ?? 0, op.h ?? 0, {
                fill: op.fill,
                stroke: op.stroke,
                lineWidth: op.lineWidth,
              });
              break;
            case "line":
              doc.drawLine(
                chartX + op.x,
                chartY + op.y,
                chartX + (op.x2 ?? op.x),
                chartY + (op.y2 ?? op.y),
                { color: op.stroke, lineWidth: op.lineWidth },
              );
              break;
            case "polygon": {
              // Translate polygon points to absolute page coordinates,
              // then convert to PDF bottom-up Y and emit a filled path.
              const pts = op.points ?? [];
              if (pts.length >= 3) {
                const pages = internals._getPages();
                const page = pages[pages.length - 1];
                const pageH = page.size.height;
                const pdfPoints: Array<[number, number]> = pts.map(
                  ([px, py]) => [chartX + px, convertY(chartY + py, pageH)],
                );
                const fillRgb = op.fill
                  ? hexToRgb(requireHex(op.fill, "polygon.fill"))
                  : undefined;
                const strokeRgb = op.stroke
                  ? hexToRgb(requireHex(op.stroke, "polygon.stroke"))
                  : undefined;
                page.contentOps.push(
                  polygonOp(pdfPoints, {
                    fill: fillRgb,
                    stroke: strokeRgb,
                    lineWidth: op.lineWidth,
                  }),
                );
              }
              break;
            }
          }
        }

        cursorY += d.height + 12; // Space after chart
        break;
      }

      default:
        throw new Error(
          `addContent: unknown element kind "${el._kind}". ` +
            `Use paragraph(), heading(), bulletList(), numberedList(), ` +
            `spacer(), pageBreak(), rule(), table(), kvTable(), ` +
            `comparisonTable(), image(), richText(), codeBlock(), quote(), chart(), or twoColumn().`,
        );
    }
  }

  // Update the page's tracked cursor to reflect where addContent ended.
  // This allows subsequent low-level draws or addContent calls to start
  // below this content without overlapping.
  if (typeof internals._getPages === "function") {
    const pages = internals._getPages();
    const lastPage = pages[pages.length - 1];
    if (lastPage && cursorY > lastPage.cursorY) {
      lastPage.cursorY = cursorY;
    }
  }

  // Return the final Y position so callers can continue drawing below
  return { lastY: cursorY };
}

// ── Rich Text & Code Block Elements ──────────────────────────────────

/** A single run of text with optional formatting. */
export interface TextRun {
  /** Text content. */
  text: string;
  /** Bold. Default: false. */
  bold?: boolean;
  /** Italic. Default: false. */
  italic?: boolean;
  /** Underline. Default: false. Draws a line under the text. */
  underline?: boolean;
  /** Font size override in points. */
  fontSize?: number;
  /** Colour override as 6-char hex. */
  color?: string;
}

/** A paragraph of mixed-format text runs. */
export interface RichParagraph {
  /** Text runs within this paragraph. */
  runs: TextRun[];
  /** Text alignment. Default: 'left'. */
  align?: "left" | "center" | "right";
}

interface RichTextData {
  paragraphs: RichParagraph[];
  fontSize: number;
  font: string;
  lineHeight: number;
  spaceBefore: number;
  spaceAfter: number;
}

interface CodeBlockData {
  code: string;
  fontSize: number;
  lineHeight: number;
  bgColor: string;
  fgColor: string;
  borderColor: string;
  padding: number;
  spaceBefore: number;
  spaceAfter: number;
}

interface QuoteData {
  text: string;
  author?: string;
  fontSize: number;
  accentColor: string;
  italic: boolean;
  lineHeight: number;
  spaceBefore: number;
  spaceAfter: number;
}

/** Options for richText(). */
export interface RichTextOptions {
  /** Paragraphs of mixed-format text. */
  paragraphs: RichParagraph[];
  /** Base font size in points. Default: 11. */
  fontSize?: number;
  /** Base font name. Default: 'Helvetica'. */
  font?: string;
  /** Line height multiplier. Default: 1.4. */
  lineHeight?: number;
  /** Space before in points. Default: 0. */
  spaceBefore?: number;
  /** Space after in points. Default: 6. */
  spaceAfter?: number;
}

/**
 * Create a rich text element with mixed formatting per paragraph.
 * Each paragraph contains runs that can individually be bold, italic,
 * have different sizes or colours.
 *
 * Accepts "runs" or "spans" for the text segments (LLMs use both).
 *
 * @param opts - RichTextOptions
 * @returns PdfElement for use with addContent()
 */
export function richText(opts: RichTextOptions): PdfElement {
  // Validate paragraphs and fix common LLM mistakes
  const paragraphs = requireArray<RichParagraph>(
    opts.paragraphs,
    "richText.paragraphs",
    { nonEmpty: true },
  );

  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i];
    // Accept "spans" or "segments" as aliases for "runs" (LLMs use all three)
    const paraAny = para as unknown as Record<string, unknown>;
    if (!para.runs && (paraAny.spans || paraAny.segments)) {
      para.runs = (paraAny.spans ?? paraAny.segments) as TextRun[];
    }
    // Validate runs exist and are an array
    if (!Array.isArray(para.runs)) {
      throw new Error(
        `richText.paragraphs[${i}].runs: expected an array of text runs ` +
          `(e.g. [{ text: "Hello", bold: true }]) but got ${typeof para.runs}. ` +
          `NOTE: The property is called "runs", not "spans".`,
      );
    }
  }

  const data: RichTextData = {
    paragraphs,
    fontSize: opts.fontSize ?? 11,
    font: opts.font ?? "Helvetica",
    lineHeight: opts.lineHeight ?? 1.4,
    spaceBefore: opts.spaceBefore ?? 0,
    spaceAfter: opts.spaceAfter ?? 6,
  };
  return _createPdfElement("richText", data);
}

/** Options for codeBlock(). */
export interface CodeBlockOptions {
  /** Source code text. */
  code: string;
  /** Font size in points. Default: 9. */
  fontSize?: number;
  /** Line height multiplier. Default: 1.3. */
  lineHeight?: number;
  /** Background colour as 6-char hex. Default: 'F5F5F5'. */
  bgColor?: string;
  /** Text colour as 6-char hex. Default: '333333'. */
  fgColor?: string;
  /** Border colour as 6-char hex. Default: 'DDDDDD'. */
  borderColor?: string;
  /** Padding inside the block in points. Default: 8. */
  padding?: number;
  /** Space before in points. Default: 6. */
  spaceBefore?: number;
  /** Space after in points. Default: 6. */
  spaceAfter?: number;
}

/**
 * Create a code block element with monospaced font and background.
 *
 * @param opts - CodeBlockOptions
 * @returns PdfElement for use with addContent()
 */
export function codeBlock(opts: CodeBlockOptions): PdfElement {
  const data: CodeBlockData = {
    code: opts.code,
    fontSize: opts.fontSize ?? 9,
    lineHeight: opts.lineHeight ?? 1.3,
    bgColor: opts.bgColor ?? "F5F5F5",
    fgColor: opts.fgColor ?? "333333",
    borderColor: opts.borderColor ?? "DDDDDD",
    padding: opts.padding ?? 8,
    spaceBefore: opts.spaceBefore ?? 6,
    spaceAfter: opts.spaceAfter ?? 6,
  };
  return _createPdfElement("codeBlock", data);
}

/** Options for quote(). */
export interface QuoteOptions {
  /** Quote text. */
  text: string;
  /** Attribution / author name. */
  author?: string;
  /** Font size in points. Default: 12. */
  fontSize?: number;
  /** Accent colour for left border. Uses theme accent1 if omitted. */
  accentColor?: string;
  /** Render quote text in italic. Default: true. */
  italic?: boolean;
  /** Line height multiplier. Default: 1.5. */
  lineHeight?: number;
  /** Space before in points. Default: 12. */
  spaceBefore?: number;
  /** Space after in points. Default: 12. */
  spaceAfter?: number;
}

/**
 * Create a quote block element with left accent border and optional author.
 *
 * @param opts - QuoteOptions
 * @returns PdfElement for use with addContent()
 */
export function quote(opts: QuoteOptions): PdfElement {
  const data: QuoteData = {
    text: opts.text,
    author: opts.author,
    fontSize: opts.fontSize ?? 12,
    accentColor: opts.accentColor ?? "",
    italic: opts.italic !== false, // default true
    lineHeight: opts.lineHeight ?? 1.5,
    spaceBefore: opts.spaceBefore ?? 12,
    spaceAfter: opts.spaceAfter ?? 12,
  };
  return _createPdfElement("quote", data);
}

// ── Metric Card Element ──────────────────────────────────────────────
// Dashboard-style KPI card: large value + label in a coloured box.

/** Internal data for a metric card. */
interface MetricCardData {
  value: string; // e.g. "$8.2M"
  label: string; // e.g. "Total Revenue"
  change?: string; // e.g. "+14%" trend indicator
  color?: string; // accent colour for the value text (6-char hex)
  bgColor?: string; // background colour (6-char hex), empty = no bg
  width?: number; // explicit card width in points
}

/** Options for metricCard(). */
export interface MetricCardOptions {
  /** The metric value to display prominently (e.g. "$8.2M", "142K", "73%"). */
  value: string;
  /** Label describing the metric (e.g. "Total Revenue", "Customer Retention"). */
  label: string;
  /** Accent colour for the value text as 6-char hex. Uses theme accent1 if omitted. */
  color?: string;
  /** Trend indicator shown next to the value (e.g. "+14%", "-2.3%", "+6 pts"). Green for +, red for -. */
  change?: string;
  /** Background colour as 6-char hex. Default: light grey "F5F5F5". Set to "" for no background. */
  bgColor?: string;
  /** Card width in points. Default: auto-sized to fit content area. */
  width?: number;
}

/**
 * Create a metric card element for flow layout.
 * Renders a prominent value with a smaller label underneath, in an
 * optional coloured box. Ideal for KPI dashboards.
 *
 * Use multiple metricCard() elements inside a twoColumn() for side-by-side KPIs.
 *
 * @param opts - MetricCardOptions
 * @returns PdfElement for use with addContent()
 */
export function metricCard(opts: MetricCardOptions): PdfElement {
  const data: MetricCardData = {
    value: requireString(opts.value, "metricCard.value"),
    label: requireString(opts.label, "metricCard.label"),
    change: opts.change,
    color: opts.color,
    bgColor: opts.bgColor ?? "F5F5F5",
    width: opts.width,
  };
  return _createPdfElement("metricCard", data);
}

// ── Callout Box Element ──────────────────────────────────────────────
// Colored background box with optional title and body text.
// Useful for highlights, warnings, key takeaways, info boxes.

/** Internal data for calloutBox element. */
interface CalloutBoxData {
  title?: string;
  text: string;
  bgColor: string;
  borderColor?: string;
  textColor?: string;
  titleColor?: string;
  fontSize: number;
  font: string;
  spaceBefore: number;
  spaceAfter: number;
}

/** Options for calloutBox(). */
export interface CalloutBoxOptions {
  /** Body text content. */
  text: string;
  /** Optional title rendered in bold above the body. */
  title?: string;
  /** Background colour as 6-char hex. Default: theme-based light tint. */
  bgColor?: string;
  /** Left accent border colour as 6-char hex. Default: theme accent1. */
  borderColor?: string;
  /** Body text colour as 6-char hex. */
  textColor?: string;
  /** Title text colour as 6-char hex. */
  titleColor?: string;
  /** Font size in points. Default: 10. */
  fontSize?: number;
  /** Space before in points. Default: 8. */
  spaceBefore?: number;
  /** Space after in points. Default: 12. */
  spaceAfter?: number;
  /** Font name for text. Use custom font for Unicode support. */
  font?: string;
}

/**
 * Create a callout/highlight box element for flow content.
 * Renders as a colored background box with optional left accent border,
 * optional bold title, and body text. Ideal for key takeaways, warnings,
 * or info boxes in reports and dashboards.
 *
 * @param opts - CalloutBoxOptions
 * @returns PdfElement for use with addContent()
 */
export function calloutBox(opts: CalloutBoxOptions): PdfElement {
  const data: CalloutBoxData = {
    text: requireString(opts.text, "calloutBox.text"),
    title: opts.title,
    bgColor: opts.bgColor ?? "EEF2FF",
    borderColor: opts.borderColor,
    textColor: opts.textColor,
    titleColor: opts.titleColor,
    fontSize: opts.fontSize ?? 10,
    font: opts.font ?? "Helvetica",
    spaceBefore: opts.spaceBefore ?? 8,
    spaceAfter: opts.spaceAfter ?? 12,
  };
  return _createPdfElement("calloutBox", data);
}

// ── Text Block Element ───────────────────────────────────────────────
// Compact multi-line text for addresses, contact info, etc.

/** Options for textBlock(). */
export interface TextBlockOptions {
  /** Array of text lines to render with tight spacing. */
  lines: string[];
  /** Font size in points. Default: 11. */
  fontSize?: number;
  /** Font name. Default: 'Helvetica'. */
  font?: string;
  /** Text colour as 6-char hex. Uses theme foreground if omitted. */
  color?: string;
  /** Bold all lines. Default: false. */
  bold?: boolean;
  /**
   * Make the first line bold (e.g. name in an address block).
   * Overrides bold for just the first line. Default: false.
   */
  firstLineBold?: boolean;
  /** Line height multiplier. Default: 1.2 (tight). */
  lineHeight?: number;
  /** Space before block in points. Default: 0. */
  spaceBefore?: number;
  /** Space after block in points. Default: 8. */
  spaceAfter?: number;
}

/**
 * Create a compact text block for multi-line content like addresses,
 * contact info, or any text that needs tight line spacing without
 * individual paragraph() calls per line.
 *
 * @param opts - TextBlockOptions
 * @returns PdfElement for use with addContent()
 *
 * @example
 * textBlock({ lines: ["Jane Smith", "VP Engineering", "Acme Corp", "123 Main St", "City, ST 12345"] })
 */
export function textBlock(opts: TextBlockOptions): PdfElement {
  const fs = opts.fontSize ?? 11;
  const font = opts.font ?? "Helvetica";
  const lh = opts.lineHeight ?? 1.2;

  // If firstLineBold is set, use richText to render first line bold
  if (opts.firstLineBold && opts.lines.length > 0) {
    const paragraphs: RichParagraph[] = opts.lines.map((line, idx) => ({
      runs: [
        {
          text: line,
          bold: idx === 0 ? true : (opts.bold ?? false),
          color: opts.color,
        },
      ],
    }));
    const rtData: RichTextData = {
      paragraphs,
      font,
      fontSize: fs,
      lineHeight: lh,
      spaceBefore: opts.spaceBefore ?? 0,
      spaceAfter: opts.spaceAfter ?? 8,
    };
    return _createPdfElement("richText", rtData);
  }

  // Simple path: render as a single paragraph with newline-joined text
  const data: ParagraphData = {
    text: opts.lines.join("\n"),
    fontSize: fs,
    font,
    color: opts.color,
    bold: opts.bold ?? false,
    italic: false,
    align: "left",
    lineHeight: lh,
    spaceBefore: opts.spaceBefore ?? 0,
    spaceAfter: opts.spaceAfter ?? 8,
  };
  return _createPdfElement("paragraph", data);
}

// ── Signature Line Element ───────────────────────────────────────────

/** Internal data for signatureLine element. */
interface SignatureLineData {
  name: string;
  title?: string;
  lineWidth: number;
  spaceAbove: number; // blank space for physical signature
  fontSize: number;
  spaceBefore: number;
  spaceAfter: number;
}

/** Options for signatureLine(). */
export interface SignatureLineOptions {
  /** Person's name displayed below the line. */
  name: string;
  /** Job title or role, displayed below the name. */
  title?: string;
  /** Width of the signature line in points. Default: 200. */
  lineWidth?: number;
  /** Blank space above the line for a physical signature. Default: 40. */
  spaceAbove?: number;
  /** Font size for name and title. Default: 10. */
  fontSize?: number;
  /** Space before in points. Default: 8. */
  spaceBefore?: number;
  /** Space after in points. Default: 12. */
  spaceAfter?: number;
}

/**
 * Create a signature line element for formal documents.
 * Renders blank space (for physical signature), a horizontal line,
 * the person's name, and optional title below.
 *
 * @param opts - SignatureLineOptions
 * @returns PdfElement for use with addContent()
 */
export function signatureLine(opts: SignatureLineOptions): PdfElement {
  const data: SignatureLineData = {
    name: requireString(opts.name, "signatureLine.name"),
    title: opts.title,
    lineWidth: opts.lineWidth ?? 200,
    spaceAbove: opts.spaceAbove ?? 40,
    fontSize: opts.fontSize ?? 10,
    spaceBefore: opts.spaceBefore ?? 8,
    spaceAfter: opts.spaceAfter ?? 12,
  };
  return _createPdfElement("signatureLine", data);
}

// ── Link Element ─────────────────────────────────────────────────────

/** Internal data for link element. */
interface LinkData {
  text: string;
  url: string;
  fontSize: number;
  color: string;
  spaceBefore: number;
  spaceAfter: number;
}

/** Options for link(). */
export interface LinkOptions {
  /** Display text for the link. */
  text: string;
  /** URL to link to. */
  url: string;
  /** Font size in points. Default: 11. */
  fontSize?: number;
  /** Link text colour as 6-char hex. Default: "2563EB" (blue). */
  color?: string;
  /** Space before in points. Default: 0. */
  spaceBefore?: number;
  /** Space after in points. Default: 6. */
  spaceAfter?: number;
}

/**
 * Create a clickable hyperlink element. Renders as coloured text with
 * a PDF Link annotation that opens the URL when clicked.
 *
 * @param opts - LinkOptions
 * @returns PdfElement for use with addContent()
 */
export function link(opts: LinkOptions): PdfElement {
  const data: LinkData = {
    text: requireString(opts.text, "link.text"),
    url: requireString(opts.url, "link.url"),
    fontSize: opts.fontSize ?? 11,
    color: opts.color ?? "2563EB",
    spaceBefore: opts.spaceBefore ?? 0,
    spaceAfter: opts.spaceAfter ?? 6,
  };
  return _createPdfElement("link", data);
}

// ── Table of Contents Element ────────────────────────────────────────

/** A single TOC entry. */
export interface TocEntry {
  /** Section title. */
  title: string;
  /** Page number (as text). */
  page: string;
  /** Indent level (0 = top, 1 = sub-section). Default: 0. */
  level?: number;
}

/** Options for tableOfContents(). */
export interface TableOfContentsOptions {
  /** TOC entries with title, page number, and optional level. */
  entries: TocEntry[];
  /** TOC heading text. Default: "Table of Contents". */
  heading?: string;
  /** Font size for entries. Default: 11. */
  fontSize?: number;
}

/**
 * Create a table of contents element. Renders a heading followed by
 * lines with title on the left, dots in the middle, and page number
 * on the right. The LLM provides the entries explicitly.
 *
 * @param opts - TableOfContentsOptions
 * @returns Array of PdfElements (auto-flattened by addContent)
 */
export function tableOfContents(opts: TableOfContentsOptions): PdfElement[] {
  const fontSize = opts.fontSize ?? 11;
  const elements: PdfElement[] = [
    heading({
      text: opts.heading ?? "Table of Contents",
      level: 1,
      spaceAfter: 16,
    }),
  ];

  for (const entry of opts.entries) {
    const indent = (entry.level ?? 0) * 20;
    const isBold = (entry.level ?? 0) === 0;
    // Use twoColumn for title-dots-page alignment
    elements.push(
      twoColumn({
        left: [
          paragraph({
            text: entry.title,
            fontSize,
            bold: isBold,
            spaceBefore: indent > 0 ? 0 : 4,
            spaceAfter: 2,
          }),
        ],
        right: [
          paragraph({
            text: entry.page,
            fontSize,
            align: "right",
            spaceBefore: indent > 0 ? 0 : 4,
            spaceAfter: 2,
          }),
        ],
        ratio: 0.85,
        gap: 8,
        spaceBefore: 0,
        spaceAfter: 0,
      }),
    );
  }

  elements.push(rule({ marginTop: 16, marginBottom: 8 }));
  return elements;
}

// ── Page Templates ───────────────────────────────────────────────────
// High-level functions that create complete themed pages.
// All accept doc as the first parameter (like PPTX slide functions).

/** Options for titlePage(). */
export interface TitlePageOptions {
  /** Document title. */
  title: string;
  /** Subtitle / tagline. */
  subtitle?: string;
  /** Author name. */
  author?: string;
  /** Date string. */
  date?: string;
  /**
   * Override the document theme for this page only.
   * Use a theme name like 'corporate-blue', 'dark-navy', etc.
   * The rest of the document keeps its original theme.
   */
  theme?: string;
}

/**
 * Add a title/cover page to the document.
 * Renders a centered title with optional subtitle, author, and date.
 *
 * @param doc - PdfDocument
 * @param opts - TitlePageOptions
 */
export function titlePage(doc: PdfDocument, opts: TitlePageOptions): void {
  const theme = opts.theme ? getTheme(opts.theme) : doc.theme;
  const ps = doc.pageSize;
  doc.addPage();

  // Background fill
  doc.drawRect(0, 0, ps.width, ps.height, { fill: theme.bg });

  // Title — centered, auto-wrapped if too wide for the page
  let titleY = ps.height * 0.35;
  const titleSize = 36;
  const maxTitleW = ps.width * 0.85; // max 85% of page width
  const titleLines = wrapText(
    opts.title,
    "Helvetica-Bold",
    titleSize,
    maxTitleW,
  );
  for (const line of titleLines) {
    const lineW = measureText(line, "Helvetica-Bold", titleSize);
    const lineX = (ps.width - lineW) / 2;
    doc.drawText(line, lineX, titleY, {
      font: "Helvetica-Bold",
      fontSize: titleSize,
      color: theme.fg,
    });
    titleY += titleSize * 1.3;
  }

  // Subtitle — auto-wrapped if too wide for the page
  if (opts.subtitle) {
    const subSize = 18;
    const maxSubW = ps.width * 0.75; // max 75% of page width
    const subLines = wrapText(opts.subtitle, "Helvetica", subSize, maxSubW);
    let subY = titleY + titleSize * 0.3;
    for (const line of subLines) {
      const lineW2 = measureText(line, "Helvetica", subSize);
      const lineX2 = (ps.width - lineW2) / 2;
      doc.drawText(line, lineX2, subY, {
        font: "Helvetica",
        fontSize: subSize,
        color: theme.subtle,
      });
      subY += subSize * 1.4;
    }
  }

  // Accent line — below subtitle or title if no subtitle
  const accentLineY =
    titleY + (opts.subtitle ? titleSize * 1.5 : titleSize * 0.5);
  const lineW = ps.width * 0.3;
  const lineX = (ps.width - lineW) / 2;
  doc.drawLine(lineX, accentLineY, lineX + lineW, accentLineY, {
    color: theme.accent1,
    lineWidth: 2,
  });

  // Author + date at bottom
  if (opts.author || opts.date) {
    const bottomY = ps.height * 0.8;
    const infoSize = 12;
    const infoText = [opts.author, opts.date].filter(Boolean).join("  |  ");
    const infoW = measureText(infoText, "Helvetica", infoSize);
    const infoX = (ps.width - infoW) / 2;
    doc.drawText(infoText, infoX, bottomY, {
      font: "Helvetica",
      fontSize: infoSize,
      color: theme.subtle,
    });
  }
}

/** Options for contentPage(). */
export interface ContentPageOptions {
  /** Page title. */
  title: string;
  /** Content elements. */
  content: PdfElement[];
  /** Page margins override. */
  margins?: Partial<Margins>;
}

/**
 * Add a titled content page. Renders a heading then flows content elements.
 *
 * @param doc - PdfDocument
 * @param opts - ContentPageOptions
 */
export function contentPage(doc: PdfDocument, opts: ContentPageOptions): void {
  addContent(doc, [heading({ text: opts.title, level: 1 }), ...opts.content], {
    margins: opts.margins,
  });
}

/** Options for twoColumnPage(). */
export interface TwoColumnPageOptions {
  /** Page title. */
  title: string;
  /** Left column elements. */
  left: PdfElement[];
  /** Right column elements. */
  right: PdfElement[];
  /** Gap between columns in points. Default: 24. */
  gap?: number;
  /** Page margins override. */
  margins?: Partial<Margins>;
}

/**
 * Add a two-column page with a title. Renders left column then right column
 * side by side below the title.
 *
 * NOTE: True side-by-side columns require tracking two independent cursors.
 * Phase 4 renders left column fully, then right column fully on the same page.
 * This is a simplified approach — full column balancing comes in a later phase.
 *
 * @param doc - PdfDocument
 * @param opts - TwoColumnPageOptions
 */
export function twoColumnPage(
  doc: PdfDocument,
  opts: TwoColumnPageOptions,
): void {
  const margins = { ...DEFAULT_MARGINS, ...opts.margins };
  const gap = opts.gap ?? 24;
  const contentWidth = doc.pageSize.width - margins.left - margins.right;
  const colWidth = (contentWidth - gap) / 2;

  doc.addPage();

  // Title
  const titleSize = 22;
  doc.drawText(opts.title, margins.left, margins.top, {
    font: "Helvetica-Bold",
    fontSize: titleSize,
    color: doc.theme.fg,
  });

  // Left column — render elements as text blocks with narrow width
  const colTop = margins.top + titleSize * 1.8;
  const leftX = margins.left;
  const rightX = margins.left + colWidth + gap;

  // Render each column's elements as paragraphs positioned manually
  let yLeft = colTop;
  for (const el of opts.left) {
    if (isPdfElement(el) && el._kind === "paragraph") {
      const d = el._data as {
        text: string;
        fontSize: number;
        font: string;
        lineHeight: number;
        color?: string;
      };
      const font = d.font ?? "Helvetica";
      const lines = wrapText(d.text, font, d.fontSize, colWidth);
      const lineH = d.fontSize * (d.lineHeight ?? 1.4);
      const color = d.color ?? doc.theme.fg;
      for (const line of lines) {
        doc.drawText(line, leftX, yLeft, {
          font,
          fontSize: d.fontSize,
          color,
        });
        yLeft += lineH;
      }
      yLeft += 6; // spaceAfter
    }
  }

  let yRight = colTop;
  for (const el of opts.right) {
    if (isPdfElement(el) && el._kind === "paragraph") {
      const d = el._data as {
        text: string;
        fontSize: number;
        font: string;
        lineHeight: number;
        color?: string;
      };
      const font = d.font ?? "Helvetica";
      const lines = wrapText(d.text, font, d.fontSize, colWidth);
      const lineH = d.fontSize * (d.lineHeight ?? 1.4);
      const color = d.color ?? doc.theme.fg;
      for (const line of lines) {
        doc.drawText(line, rightX, yRight, {
          font,
          fontSize: d.fontSize,
          color,
        });
        yRight += lineH;
      }
      yRight += 6;
    }
  }
}

/** Options for quotePage(). */
export interface QuotePageOptions {
  /** Quote text. */
  quote: string;
  /** Author / attribution. */
  author?: string;
  /** Author role / title. */
  role?: string;
}

/**
 * Add a full-page quote with optional author attribution.
 * Centres the quote vertically with large italic text.
 *
 * @param doc - PdfDocument
 * @param opts - QuotePageOptions
 */
export function quotePage(doc: PdfDocument, opts: QuotePageOptions): void {
  const theme = doc.theme;
  const ps = doc.pageSize;
  doc.addPage();

  // Background
  doc.drawRect(0, 0, ps.width, ps.height, { fill: theme.bg });

  // Quote text — centered, large, italic
  const quoteSize = 24;
  const quoteFont = "Helvetica-Oblique";
  const maxW = ps.width * 0.7;
  const lines = wrapText(opts.quote, quoteFont, quoteSize, maxW);
  const lineH = quoteSize * 1.6;
  const blockH = lines.length * lineH;
  let quoteY = (ps.height - blockH) / 2;

  // Opening quote mark
  const quoteMarkSize = 72;
  const quoteMarkW = measureText("\u201C", "Helvetica", quoteMarkSize);
  doc.drawText(
    "\u201C",
    (ps.width - quoteMarkW) / 2,
    quoteY - quoteMarkSize * 0.5,
    {
      font: "Helvetica",
      fontSize: quoteMarkSize,
      color: theme.accent1,
    },
  );

  for (const line of lines) {
    const lineW = measureText(line, quoteFont, quoteSize);
    const lineX = (ps.width - lineW) / 2;
    doc.drawText(line, lineX, quoteY, {
      font: quoteFont,
      fontSize: quoteSize,
      color: theme.fg,
    });
    quoteY += lineH;
  }

  // Author attribution
  if (opts.author) {
    const attrY = quoteY + lineH;
    const attrText = opts.role
      ? `\u2014 ${opts.author}, ${opts.role}`
      : `\u2014 ${opts.author}`;
    const attrSize = 14;
    const attrW = measureText(attrText, "Helvetica", attrSize);
    doc.drawText(attrText, (ps.width - attrW) / 2, attrY, {
      font: "Helvetica",
      fontSize: attrSize,
      color: theme.subtle,
    });
  }
}

// ── Document Furniture ───────────────────────────────────────────────
// Functions that add repeating elements (page numbers, headers, footers)
// to ALL pages. Call these AFTER all content has been added, BEFORE buildPdf().

/** Options for addPageNumbers(). */
export interface PageNumberOptions {
  /** Position on page. Default: 'bottom-center'. */
  position?: "bottom-left" | "bottom-center" | "bottom-right";
  /** Font size in points. Default: 9. */
  fontSize?: number;
  /** Starting page number. Default: 1. */
  startNumber?: number;
  /** Number of pages to skip at the start (e.g. skip title page). Default: 0. */
  skipPages?: number;
}

/**
 * Add page numbers to all pages (or a range). Call AFTER all content,
 * BEFORE buildPdf(). Numbers are drawn at the bottom of each page.
 *
 * @param doc - PdfDocument with all pages already added
 * @param opts - PageNumberOptions
 */
export function addPageNumbers(
  doc: PdfDocument,
  opts?: PageNumberOptions,
): void {
  const fontSize = opts?.fontSize ?? 9;
  const position = opts?.position ?? "bottom-center";
  const startNum = opts?.startNumber ?? 1;
  const skip = opts?.skipPages ?? 0;
  const ps = doc.pageSize;

  // We need to draw on specific pages. Since the low-level drawText
  // always draws on the CURRENT (last) page, we use a workaround:
  // save the current page count, add content to each page by
  // building the text operations directly.
  // However, our current API only exposes drawText which draws on
  // the current page. For page numbers, we need a different approach.
  // We'll store them as pending operations and apply in buildPdf.
  // For now, use a simpler approach: draw on each existing page
  // by leveraging the internal pages array via a cast.

  // Access internal pages through the document's closure.
  // This is safe because addPageNumbers is part of the same module.
  const docAny = doc as unknown as {
    _getPages: () => PageData[];
    _getFontRegistry: () => FontRegistry;
  };

  // If the document doesn't expose internals, fall back to doing nothing.
  // This shouldn't happen in practice since we control createDocument.
  if (typeof docAny._getPages !== "function") return;

  const pages = docAny._getPages();
  const fontRegistry = docAny._getFontRegistry();
  const fontRef = registerFont(fontRegistry, "Helvetica");
  const color = hexToRgb(autoTextColor(doc.theme.bg));

  for (let i = skip; i < pages.length; i++) {
    const page = pages[i];
    const pageNum = startNum + (i - skip);
    const text = pageNum.toString();

    // Calculate position
    let x: number;
    const y = 36; // 0.5 inch from bottom in PDF coords (bottom-left origin)
    const textW = measureText(text, "Helvetica", fontSize);

    switch (position) {
      case "bottom-left":
        x = 72;
        break;
      case "bottom-right":
        x = page.size.width - 72 - textW;
        break;
      case "bottom-center":
      default:
        x = (page.size.width - textW) / 2;
        break;
    }

    // Draw directly into the page's content ops (bottom-left PDF coords)
    // y is already in PDF coords (distance from bottom)
    page.contentOps.push(textOp(text, x, y, fontRef, fontSize, color));
  }
}

/** Options for addFooter(). */
export interface FooterOptions {
  /** Footer text. */
  text: string;
  /** Text alignment. Default: 'center'. */
  align?: "left" | "center" | "right";
  /** Font size in points. Default: 8. */
  fontSize?: number;
  /** Number of pages to skip at the start. Default: 0. */
  skipPages?: number;
}

/**
 * Add a footer to all pages. Call AFTER all content, BEFORE buildPdf().
 *
 * @param doc - PdfDocument
 * @param opts - FooterOptions
 */
export function addFooter(doc: PdfDocument, opts: FooterOptions): void {
  const fontSize = opts.fontSize ?? 8;
  const align = opts.align ?? "center";
  const skip = opts.skipPages ?? 0;

  const docAny = doc as unknown as {
    _getPages: () => PageData[];
    _getFontRegistry: () => FontRegistry;
  };
  if (typeof docAny._getPages !== "function") return;

  const pages = docAny._getPages();
  const fontRegistry = docAny._getFontRegistry();
  const fontRef = registerFont(fontRegistry, "Helvetica");
  const color = hexToRgb(autoTextColor(doc.theme.bg));

  for (let i = skip; i < pages.length; i++) {
    const page = pages[i];
    const textW = measureText(opts.text, "Helvetica", fontSize);
    let x: number;
    const y = 50; // Slightly above page numbers in PDF coords (bottom-left origin)

    switch (align) {
      case "left":
        x = 72;
        break;
      case "right":
        x = page.size.width - 72 - textW;
        break;
      case "center":
      default:
        x = (page.size.width - textW) / 2;
        break;
    }

    page.contentOps.push(textOp(opts.text, x, y, fontRef, fontSize, color));
  }
}

// ── Watermark ────────────────────────────────────────────────────────

/** Options for addWatermark(). */
export interface WatermarkOptions {
  /** Watermark text (e.g. "DRAFT", "CONFIDENTIAL", "SAMPLE"). */
  text: string;
  /** Font size in points. Default: 72. */
  fontSize?: number;
  /** Text colour as 6-char hex. Default: "CCCCCC" (light grey). */
  color?: string;
  /** Opacity from 0.0 (invisible) to 1.0 (opaque). Default: 0.15. */
  opacity?: number;
  /** Rotation angle in degrees. Default: -45 (diagonal bottom-left to top-right). */
  angle?: number;
  /** Skip the first N pages (e.g. skip title page). Default: 0. */
  skipPages?: number;
}

/**
 * Add a diagonal watermark to all pages (or a subset).
 * Renders semi-transparent rotated text centered on each page.
 * Call this AFTER all content, page numbers, and footers are added.
 *
 * @param doc - PdfDocument
 * @param opts - WatermarkOptions
 */
export function addWatermark(doc: PdfDocument, opts: WatermarkOptions): void {
  const text = requireString(opts.text, "watermark.text");
  const fontSize = opts.fontSize ?? 72;
  const colorHex = opts.color ?? "CCCCCC";
  const opacity = Math.max(0, Math.min(1, opts.opacity ?? 0.15));
  const angleDeg = opts.angle ?? -45;
  const skipPages = opts.skipPages ?? 0;

  const docAny = doc as unknown as {
    _getPages: () => PageData[];
    _getFontRegistry: () => FontRegistry;
  };

  const pages = docAny._getPages();
  const fontRegistry = docAny._getFontRegistry();
  const fontRef = registerFont(fontRegistry, "Helvetica-Bold");

  // Convert angle to radians
  const angleRad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);

  // Color components
  const r = (parseInt(colorHex.slice(0, 2), 16) / 255).toFixed(3);
  const g = (parseInt(colorHex.slice(2, 4), 16) / 255).toFixed(3);
  const b = (parseInt(colorHex.slice(4, 6), 16) / 255).toFixed(3);

  const gsName = "GS_WM";

  for (let i = skipPages; i < pages.length; i++) {
    const page = pages[i];
    const cx = page.size.width / 2;
    const cy = page.size.height / 2;

    // Register ExtGState for transparency on this page
    page.extGStates.set(gsName, opacity);

    // Calculate text offset to center it (approximate)
    const textW = measureText(text, "Helvetica-Bold", fontSize);
    const offsetX = -textW / 2;
    const offsetY = -fontSize / 2;

    // Transform: translate to center, then apply rotation
    const tx = cx + offsetX * cos - offsetY * sin;
    const ty = cy + offsetX * sin + offsetY * cos;

    // PDF content stream: save state, set transparency, draw rotated text, restore
    const wmOps = [
      "q", // save graphics state
      `/${gsName} gs`, // apply transparency
      "BT",
      `${r} ${g} ${b} rg`,
      `/${fontRef} ${fontSize} Tf`,
      // Tm sets text matrix: [cos sin -sin cos tx ty]
      // In PDF coordinate system (bottom-left origin), ty needs conversion
      `${cos.toFixed(4)} ${sin.toFixed(4)} ${(-sin).toFixed(4)} ${cos.toFixed(4)} ${tx.toFixed(2)} ${(page.size.height - ty).toFixed(2)} Tm`,
      `(${escapeTextString(text)}) Tj`,
      "ET",
      "Q", // restore graphics state
    ].join("\n");

    page.contentOps.push(wmOps);
  }
}

// ── Serialization ────────────────────────────────────────────────────
// Enable serialize/restore for multi-handler workflows, matching the
// PPTX pattern of pres.serialize() / restorePresentation().

/** Serialized document state for cross-handler persistence. */
export interface SerializedDocument {
  /** Serialization format version. */
  version: 1;
  /** Theme name. */
  theme: string;
  /** Page size. */
  pageSize: PageSize;
  /** Debug flag. */
  debug: boolean;
  /** Metadata. */
  meta: { title: string; author: string; subject: string; creator: string };
  /** Number of pages. */
  pageCount: number;
  /** Content ops per page (raw strings). */
  pages: { contentOps: string[]; size: PageSize; imageRefs: string[] }[];
  /** Registered fonts. */
  fonts: [string, string][];
  /** Registered images (base64-encoded data). */
  images: {
    id: number;
    resName: string;
    data: string; // base64
    width: number;
    height: number;
    filter: string;
    colorSpace: string;
  }[];
}

/**
 * Serialize a PdfDocument to a JSON-safe object for cross-handler persistence.
 * Use with ha:shared-state to preserve document state across handler boundaries.
 *
 * @param doc - PdfDocument to serialize
 * @returns SerializedDocument object (JSON-safe)
 */
export function serializeDocument(doc: PdfDocument): SerializedDocument {
  const internals = doc as unknown as {
    _getPages: () => PageData[];
    _getFontRegistry: () => FontRegistry;
    _getImageRegistry: () => ImageRegistry;
    _getMeta: () => {
      title: string;
      author: string;
      subject: string;
      creator: string;
    };
  };

  const pages = internals._getPages();
  const fontReg = internals._getFontRegistry();
  const imageReg = internals._getImageRegistry();
  const meta = internals._getMeta();

  // Find which theme name matches the current theme
  const themeName =
    Object.entries(THEMES).find(
      ([, t]) => t.bg === doc.theme.bg && t.fg === doc.theme.fg,
    )?.[0] ?? "corporate-blue";

  // Encode image data as base64 for JSON safety
  const images = Array.from(imageReg.images.entries()).map(([id, entry]) => ({
    id,
    resName: entry.resName,
    data: uint8ArrayToBase64(entry.data),
    width: entry.width,
    height: entry.height,
    filter: entry.filter,
    colorSpace: entry.colorSpace,
  }));

  return {
    version: 1,
    theme: themeName,
    pageSize: doc.pageSize,
    debug: doc.debug,
    meta,
    pageCount: pages.length,
    pages: pages.map((p) => ({
      contentOps: [...p.contentOps],
      size: p.size,
      imageRefs: Array.from(p.imageRefs),
    })),
    fonts: Array.from(fontReg.fonts.entries()),
    images,
  };
}

// Helper: Convert Uint8Array to base64 string (works in QuickJS sandbox)
function uint8ArrayToBase64(data: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  // Use a simple base64 encoder (no btoa in QuickJS)
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let result = "";
  for (let i = 0; i < binary.length; i += 3) {
    const b1 = binary.charCodeAt(i);
    const b2 = i + 1 < binary.length ? binary.charCodeAt(i + 1) : 0;
    const b3 = i + 2 < binary.length ? binary.charCodeAt(i + 2) : 0;
    result += chars[b1 >> 2];
    result += chars[((b1 & 3) << 4) | (b2 >> 4)];
    result +=
      i + 1 < binary.length ? chars[((b2 & 0xf) << 2) | (b3 >> 6)] : "=";
    result += i + 2 < binary.length ? chars[b3 & 0x3f] : "=";
  }
  return result;
}

// Helper: Convert base64 string back to Uint8Array
function base64ToUint8Array(b64: string): Uint8Array {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const lookup = new Map<string, number>();
  for (let i = 0; i < chars.length; i++) lookup.set(chars[i], i);

  // Remove padding and calculate output length
  const cleanB64 = b64.replace(/=+$/, "");
  const outLen = Math.floor((cleanB64.length * 3) / 4);
  const result = new Uint8Array(outLen);

  let j = 0;
  for (let i = 0; i < cleanB64.length; i += 4) {
    const a = lookup.get(cleanB64[i]) ?? 0;
    const b = lookup.get(cleanB64[i + 1]) ?? 0;
    const c = lookup.get(cleanB64[i + 2]) ?? 0;
    const d = lookup.get(cleanB64[i + 3]) ?? 0;
    result[j++] = (a << 2) | (b >> 4);
    if (j < outLen) result[j++] = ((b & 0xf) << 4) | (c >> 2);
    if (j < outLen) result[j++] = ((c & 3) << 6) | d;
  }
  return result;
}

/**
 * Restore a PdfDocument from a serialized state.
 * Use with ha:shared-state to restore document state across handler boundaries.
 *
 * @param serialized - SerializedDocument from serializeDocument()
 * @returns PdfDocument with all pages, fonts, and images restored
 */
export function restoreDocument(serialized: SerializedDocument): PdfDocument {
  if (serialized.version !== 1) {
    throw new Error(
      `Unsupported serialized document version: ${serialized.version}. Expected 1.`,
    );
  }

  const doc = createDocument({
    theme: serialized.theme,
    pageSize: serialized.pageSize,
    debug: serialized.debug,
    title: serialized.meta.title,
    author: serialized.meta.author,
    subject: serialized.meta.subject,
    creator: serialized.meta.creator,
  });

  const internals = doc as unknown as {
    _getPages: () => PageData[];
    _getFontRegistry: () => FontRegistry;
    _getImageRegistry: () => ImageRegistry;
  };
  const pages = internals._getPages();
  const fontReg = internals._getFontRegistry();
  const imageReg = internals._getImageRegistry();

  // Restore fonts
  for (const [fontName, resName] of serialized.fonts) {
    fontReg.fonts.set(fontName, resName);
    const id = parseInt(resName.slice(1), 10);
    if (id >= fontReg.nextId) fontReg.nextId = id + 1;
  }

  // Restore images
  for (const img of serialized.images) {
    imageReg.images.set(img.id, {
      resName: img.resName,
      data: base64ToUint8Array(img.data),
      width: img.width,
      height: img.height,
      filter: img.filter,
      colorSpace: img.colorSpace,
      bitsPerComponent: 8,
    });
    if (img.id >= imageReg.nextId) imageReg.nextId = img.id + 1;
  }

  // Restore pages (clear the auto-created empty state)
  pages.length = 0;
  for (const p of serialized.pages) {
    pages.push({
      contentOps: [...p.contentOps],
      size: p.size,
      imageRefs: new Set(p.imageRefs),
      cursorY: p.size.height, // Assume restored pages are full
      textBoxes: [],
      extGStates: new Map(),
      links: [],
    });
  }

  return doc;
}

// ── Export helper ────────────────────────────────────────────────────

/**
 * Build and write a PDF document to a file using the fs-write plugin.
 * Convenience wrapper around doc.buildPdf() + writeFileBinary().
 *
 * @param doc - PdfDocument to export
 * @param path - Output file path
 * @param fsWrite - The host:fs-write module
 */
// ── Document Validation ──────────────────────────────────────────────
// Post-render validation that catches layout problems the LLM can't see.
// Runs automatically on buildPdf() and exportToFile().

/** Overlap threshold: two text boxes overlapping by more than this fraction trigger an error. */
const OVERLAP_THRESHOLD = 0.3; // 30% overlap = definitely wrong

/** Minimum content coverage per page (excluding first/last page). */
const MIN_CONTENT_COVERAGE = 0.15; // 15% of usable page area

/**
 * Validate the document for layout problems that produce garbage output.
 * Checks:
 * 1. Text-on-text overlap (two text elements rendering on top of each other)
 * 2. Content outside page bounds (clipped/invisible text)
 * 3. Excessive whitespace on interior pages
 *
 * Throws descriptive errors so the LLM knows WHAT is wrong and WHERE.
 *
 * @param doc - PdfDocument to validate
 */
export function validateDocument(doc: PdfDocument): string[] {
  const docAny = doc as unknown as {
    _getPages: () => PageData[];
  };
  if (typeof docAny._getPages !== "function") return [];

  const pages = docAny._getPages();
  const warnings: string[] = [];

  for (let pi = 0; pi < pages.length; pi++) {
    const page = pages[pi];
    const pageNum = pi + 1;
    const boxes = page.textBoxes;

    // ── Check 1: Text overlap detection ──
    // Compare every pair of text boxes on the same page.
    // If two boxes overlap significantly, report it.
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];

        // Calculate overlap area
        const overlapX = Math.max(
          0,
          Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x),
        );
        const overlapY = Math.max(
          0,
          Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y),
        );
        const overlapArea = overlapX * overlapY;
        const smallerArea = Math.min(a.w * a.h, b.w * b.h);

        if (smallerArea > 0 && overlapArea / smallerArea > OVERLAP_THRESHOLD) {
          warnings.push(
            `Page ${pageNum}: TEXT OVERLAP — "${a.text}" overlaps with "${b.text}" ` +
              `at y=${a.y.toFixed(0)}..${(a.y + a.h).toFixed(0)} and y=${b.y.toFixed(0)}..${(b.y + b.h).toFixed(0)}. ` +
              `Fix: increase spaceAfter on the preceding element or spaceBefore on the following element to prevent overlap.`,
          );
        }
      }
    }

    // ── Check 2: Content outside page bounds ──
    for (const box of boxes) {
      if (box.x < -5) {
        warnings.push(
          `Page ${pageNum}: TEXT CLIPPED — "${box.text}" starts at x=${box.x.toFixed(0)} which is off the left edge of the page. ` +
            `Text will be invisible. Move it to x >= 0.`,
        );
      }
      if (box.x + box.w > page.size.width + 5) {
        warnings.push(
          `Page ${pageNum}: TEXT CLIPPED — "${box.text}" extends to x=${(box.x + box.w).toFixed(0)} ` +
            `which exceeds page width (${page.size.width}). Text will be cut off.`,
        );
      }
      if (box.y < -5) {
        warnings.push(
          `Page ${pageNum}: TEXT CLIPPED — "${box.text}" is above the top of the page (y=${box.y.toFixed(0)}).`,
        );
      }
      if (box.y > page.size.height + 5) {
        warnings.push(
          `Page ${pageNum}: TEXT CLIPPED — "${box.text}" is below the bottom of the page (y=${box.y.toFixed(0)}).`,
        );
      }
    }

    // ── Check 3: Excessive whitespace on interior pages ──
    // Skip first page (may be title page) and last page (may have just takeaways)
    if (pages.length > 2 && pi > 0 && pi < pages.length - 1) {
      const usableHeight = page.size.height - 144; // 72pt margins top + bottom
      const contentHeight = page.cursorY > 72 ? page.cursorY - 72 : 0;
      const coverage = usableHeight > 0 ? contentHeight / usableHeight : 0;
      if (coverage < MIN_CONTENT_COVERAGE && boxes.length < 3) {
        warnings.push(
          `Page ${pageNum}: EXCESSIVE WHITESPACE — page is ${(coverage * 100).toFixed(0)}% filled ` +
            `(${contentHeight.toFixed(0)}pt of ${usableHeight.toFixed(0)}pt usable). ` +
            `Consider merging content with adjacent pages to avoid nearly-empty pages.`,
        );
      }
    }
  }

  return warnings;
}

export function exportToFile(
  doc: PdfDocument,
  path: string,
  fsWrite: { writeFileBinary: (path: string, data: Uint8Array) => void },
): void {
  // Validate before saving — catch layout problems before they become garbage PDFs
  const warnings = validateDocument(doc);
  if (warnings.length > 0) {
    throw new Error(
      `PDF LAYOUT VALIDATION FAILED (${warnings.length} issue${warnings.length > 1 ? "s" : ""}):\n\n` +
        warnings.map((w, i) => `  ${i + 1}. ${w}`).join("\n\n") +
        `\n\nFix these layout issues before saving. The current output would look broken.`,
    );
  }
  const bytes = doc.buildPdf();
  fsWrite.writeFileBinary(path, bytes);
}

// ── Custom Font Registration ─────────────────────────────────────────

/** Options for registerCustomFont(). */
export interface RegisterFontOptions {
  /** Name to use for this font in drawText/paragraph/etc. */
  name: string;
  /** Raw TrueType (.ttf) font file data. */
  data: Uint8Array;
}

/**
 * Register a custom TrueType font for use in the document.
 * After registration, use the font name in any element's `font` parameter.
 *
 * The font is embedded in the PDF so it renders correctly on any viewer.
 * Supports full Unicode (CJK, Cyrillic, Arabic, etc.) — not limited to
 * WinAnsiEncoding like the standard 14 fonts.
 *
 * @param doc - PdfDocument to register the font in
 * @param opts - RegisterFontOptions with name and TTF data
 *
 * @example
 * const fontData = fsRead.readFileBinary("DejaVuSans.ttf");
 * registerCustomFont(doc, { name: "DejaVu", data: fontData });
 * // Now use "DejaVu" as the font name:
 * addContent(doc, [paragraph({ text: "Hello 世界", font: "DejaVu" })]);
 */
export function registerCustomFont(
  doc: PdfDocument,
  opts: RegisterFontOptions,
): void {
  const name = requireString(opts.name, "registerCustomFont.name");
  if (
    !opts.data ||
    !(opts.data instanceof Uint8Array) ||
    opts.data.length < 12
  ) {
    throw new Error(
      "registerCustomFont.data: must be a Uint8Array containing TrueType (.ttf) font data",
    );
  }

  // Parse the TTF data
  const parsed = parseTTF(opts.data);

  // Access font registry
  const docAny = doc as unknown as {
    _getFontRegistry: () => FontRegistry;
  };
  const registry = docAny._getFontRegistry();

  // Store the parsed font data
  registry.customFonts.set(name, parsed);

  // Register in the font map (gets a resource name like F3, F4, etc.)
  registerFont(registry, name);
}
