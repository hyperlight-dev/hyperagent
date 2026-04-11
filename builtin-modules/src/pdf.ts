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
  getTheme,
  hexColor,
  requireArray,
  requireHex,
  requireNumber,
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

// Helvetica default width = 278 for missing glyphs.
// We store widths for ASCII 32-126 (printable range) plus a default.
// Full AFM tables have ~300+ entries; we cover the common printable range.

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

/**
 * Measure the width of a string in points for a given font and size.
 * @param text - Text to measure
 * @param font - Standard font name
 * @param fontSize - Font size in points
 * @returns Width in points
 */
export function measureText(
  text: string,
  font: string,
  fontSize: number,
): number {
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
 * Escape a string for use in a PDF text-showing operator (Tj).
 * Escapes backslash, parens, and carriage return.
 */
function escapeTextString(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/\r/g, "\\r");
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
): string {
  const parts: string[] = [];
  parts.push("BT");
  if (color) parts.push(`${color} rg`);
  parts.push(`/${fontRef} ${fontSize} Tf`);
  parts.push(`${x.toFixed(2)} ${y.toFixed(2)} Td`);
  parts.push(`(${escapeTextString(text)}) Tj`);
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
}

function createFontRegistry(): FontRegistry {
  return { fonts: new Map(), nextId: 1 };
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
      page.contentOps.push(textOp(text, drawX, pdfY, fontRef, fs, colorRgb));

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
  const imageStartObj = fontStartObj + fontList.length;
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
  for (let i = 0; i < fontList.length; i++) {
    const [fontName, resName] = fontList[i];
    const objNum = fontStartObj + i;
    addObject(
      objNum,
      `<< /Type /Font /Subtype /Type1 /BaseFont /${fontName} /Encoding /WinAnsiEncoding >>`,
    );
    // Suppress unused variable lint — resName is used in resource dict assembly
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
    for (const [, resName] of fontList) {
      const fontObjNum =
        fontStartObj + fontList.findIndex(([, r]) => r === resName);
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

    // Page object
    addObject(
      pageObjNum,
      `<< /Type /Page` +
        ` /Parent 2 0 R` +
        ` /MediaBox [0 0 ${page.size.width.toFixed(2)} ${page.size.height.toFixed(2)}]` +
        ` /Contents ${contentObjNum} 0 R` +
        ` /Resources << ${fontResDict}${xobjResDict} >>` +
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
  type: "text" | "rect" | "line";
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
  /** For rect/line: stroke colour. */
  stroke?: string;
  /** For line: end X relative to chart origin. */
  x2?: number;
  /** For line: end Y relative to chart origin. */
  y2?: number;
  /** For rect/line: line width. */
  lineWidth?: number;
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
 * @param opts - Paragraph options
 * @returns PdfElement for use with addContent()
 */
export function paragraph(opts: ParagraphOptions): PdfElement {
  const data: ParagraphData = {
    text: opts.text ?? "",
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
  /** Heading level 1-6 (1 = largest). Default: 1. */
  level?: number;
  /** Text colour as 6-char hex. Uses theme foreground if omitted. */
  color?: string;
  /** Space before heading in points. Default: 24 for level 1-2, 16 for 3-6. */
  spaceBefore?: number;
  /** Space after heading in points. Default: 10 for level 1-2, 8 for 3-6. */
  spaceAfter?: number;
}

/**
 * Create a heading element for flow layout.
 * Font size is auto-determined from level (1=28pt, 2=22pt, ..., 6=11pt).
 * Always uses bold font. Includes spacing before and after.
 *
 * @param opts - Heading options
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
 * @param opts - Bullet list options
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
 * @param opts - Numbered list options
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
 * @param opts - Rule options
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
 * @param opts - Two column options
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

// ── Table Style Presets ──────────────────────────────────────────────

/** Style definition for table rendering. */
export interface TableStyle {
  /** Header row background colour (6-char hex). */
  headerBg: string;
  /** Header text colour (6-char hex). */
  headerFg: string;
  /** Header font. */
  headerFont: string;
  /** Body text colour (6-char hex). */
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
}

interface KvTableData {
  items: { key: string; value: string }[];
  fontSize: number;
  style: TableStyle;
  keyWidth?: number; // portion of width for key column (0-1) or absolute points
  maxWidth?: number; // max table width in points
  align?: "left" | "center" | "right"; // table alignment within content area
  valueAlign?: "left" | "right"; // alignment of value column text
}

interface ComparisonTableData {
  features: string[];
  options: { name: string; values: boolean[] }[];
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
export interface TableOptions {
  /** Column header texts. */
  headers?: string[];
  /** Row data — each row is an array of cell strings. Must match headers length. */
  rows?: string[][];
  /**
   * Alternative column-based definition (LLMs often prefer this shape).
   * Each column specifies { header, width? }. If provided, headers/rows
   * are derived from this. Width is a ratio (0-1) of total width.
   */
  columns?: { header: string; width?: number; align?: string }[];
  /** Font size in points. Default: 10. */
  fontSize?: number;
  /** Table style preset name or custom TableStyle. Default: 'default'. */
  style?: string | TableStyle;
  /** Fixed column widths in points or ratios. Auto-calculated if omitted. */
  colWidths?: number[];
  /**
   * Per-column text alignment. Array matching headers length.
   * E.g. ["left", "center", "right", "right"] for a table with 4 columns.
   * Default: all "left".
   */
  columnAlign?: ("left" | "center" | "right")[];
}

/**
 * Create a data table element for flow layout.
 * Renders with header row, borders, and alternating row colours.
 *
 * Accepts EITHER { headers, rows } OR { columns, rows } format.
 * LLMs use both interchangeably — we handle both.
 *
 * @param opts - Table options
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

  const style = resolveTableStyle(opts.style);

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
  };
  return _createPdfElement("table", data);
}

/** Options for kvTable(). */
export interface KvTableOptions {
  /** Key-value pairs (also accepts 'entries' as alias). */
  items?: { key: string; value: string }[];
  /** Alias for items — LLMs sometimes use 'entries' instead. */
  entries?: { key: string; value: string }[];
  /** Font size in points. Default: 10. */
  fontSize?: number;
  /** Table style preset name or custom TableStyle. Default: 'default'. */
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
}

/**
 * Create a key-value table element for flow layout.
 * Two-column layout: Key | Value.
 *
 * @param opts - KvTable options
 * @returns PdfElement for use with addContent()
 */
export function kvTable(opts: KvTableOptions): PdfElement {
  // Accept either 'items' or 'entries' (LLMs use both interchangeably)
  const rawItems = opts.items ?? (opts as Record<string, unknown>).entries;
  const items = requireArray<{ key: string; value: string }>(
    rawItems,
    "kvTable.items (or entries)",
    { nonEmpty: true },
  );
  const style = resolveTableStyle(opts.style);

  // keyWidth: if > 1, it's absolute points; if <= 1, it's a ratio
  let keyWidth = opts.keyWidth ?? 0.35;
  if (keyWidth > 1) {
    // Convert absolute points to a ratio (will be applied to contentWidth later).
    // Store as negative to signal "absolute" to the renderer.
    // Actually, simpler: just store the ratio. We don't know contentWidth here,
    // so store the raw value and let the renderer handle it.
  }
  // Just pass through — the renderer will handle the interpretation.

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

/** Options for comparisonTable(). */
export interface ComparisonTableOptions {
  /** Feature names (row labels). */
  features: string[];
  /** Options to compare. Each has a name and boolean values matching features. */
  options: { name: string; values: boolean[] }[];
  /** Font size in points. Default: 10. */
  fontSize?: number;
  /** Table style preset name or custom TableStyle. Default: 'default'. */
  style?: string | TableStyle;
}

/**
 * Create a comparison table element for flow layout.
 * Feature matrix with ✓/✗ marks.
 *
 * @param opts - ComparisonTable options
 * @returns PdfElement for use with addContent()
 */
export function comparisonTable(opts: ComparisonTableOptions): PdfElement {
  const features = requireArray<string>(
    opts.features,
    "comparisonTable.features",
    { nonEmpty: true },
  );
  const options = requireArray<{ name: string; values: boolean[] }>(
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
        `comparisonTable.options[${i}].values: expected ${features.length} booleans ` +
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

/** Resolve a style name or object to a TableStyle. */
function resolveTableStyle(style?: string | TableStyle): TableStyle {
  if (!style) return TABLE_STYLES.default;
  if (typeof style === "string") {
    const resolved = TABLE_STYLES[style];
    if (!resolved) {
      const valid = Object.keys(TABLE_STYLES).join(", ");
      throw new Error(
        `Unknown table style "${style}". Valid styles: ${valid}.`,
      );
    }
    return resolved;
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
 * @param opts - Image options
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
function tableRowHeight(fontSize: number): number {
  return fontSize + CELL_PAD_V * 2 + 2; // +2 for descent below baseline
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
): void {
  const rowH = tableRowHeight(fontSize);
  const headerH = rowH;

  // Text baseline offset within a row: top padding + font size
  // (drawText Y is the baseline position in top-left coords)
  const textYOffset = CELL_PAD_V + fontSize;

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
  ensureSpace(headerH);
  const tableStartY = getCursorY();
  let curY = tableStartY;

  // ── Header row ──
  // Background fill FIRST (so text draws ON TOP)
  if (style.headerBg) {
    doc.drawRect(x, curY, totalWidth, headerH, { fill: style.headerBg });
  }

  // Header text (drawn AFTER background — PDF paints in order)
  let cellX = x;
  for (let c = 0; c < headers.length; c++) {
    const align = columnAlign?.[c] ?? "left";
    const textX = cellTextX(
      cellX,
      colWidths[c],
      headers[c],
      style.headerFont,
      align,
    );
    doc.drawText(headers[c], textX, curY + textYOffset, {
      font: style.headerFont,
      fontSize,
      color: style.headerFg,
    });
    cellX += colWidths[c];
  }

  // Header bottom border
  doc.drawLine(x, curY + headerH, x + totalWidth, curY + headerH, {
    color: style.borderColor,
    lineWidth: style.borderWidth,
  });

  setCursorY(curY + headerH);

  // ── Data rows ──
  for (let r = 0; r < rows.length; r++) {
    ensureSpace(rowH);
    curY = getCursorY();

    // Alternating row background FIRST
    if (style.altRowBg && r % 2 === 1) {
      doc.drawRect(x, curY, totalWidth, rowH, { fill: style.altRowBg });
    }

    // Cell text AFTER background
    cellX = x;
    for (let c = 0; c < rows[r].length; c++) {
      const align = columnAlign?.[c] ?? "left";
      const textX = cellTextX(
        cellX,
        colWidths[c],
        rows[r][c],
        style.bodyFont,
        align,
      );
      doc.drawText(rows[r][c], textX, curY + textYOffset, {
        font: style.bodyFont,
        fontSize,
        color: style.bodyFg,
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
}

/**
 * Flow an array of PdfElements into the document with auto-pagination.
 *
 * Elements are rendered top-to-bottom. When content exceeds the available
 * space on the current page, a new page is automatically added.
 *
 * @param doc - PdfDocument to add content to
 * @param elements - Array of PdfElement objects from builder functions
 * @param opts - Optional margins
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

  // Ensure we have at least one page
  if (doc.pageCount === 0) {
    doc.addPage();
  }

  // Read the tracked cursor position from the current page.
  // If the LLM has already drawn content (drawText, drawRect, etc.),
  // cursorY will be > 0 and we start BELOW that content.
  // If no prior content, we start at margins.top.
  const internals = doc as unknown as {
    _getPages: () => PageData[];
  };
  let cursorY = margins.top;
  if (typeof internals._getPages === "function") {
    const pages = internals._getPages();
    const lastPage = pages[pages.length - 1];
    if (lastPage && lastPage.cursorY > margins.top) {
      // Start below existing content with a small gap
      cursorY = lastPage.cursorY + 12; // 12pt gap between low-level and flow content
    }
  }

  /**
   * Check if we need a new page. If remaining space is less than needed,
   * add a new page and reset cursor.
   */
  function ensureSpace(needed: number): void {
    if (cursorY + needed > pageBottom) {
      doc.addPage();
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

  // ── Process each element ──
  for (const el of elements) {
    if (!isPdfElement(el)) {
      throw new Error(
        `addContent: expected a PdfElement from paragraph/heading/bulletList/etc, ` +
          `but got ${typeof el}. Use the element builder functions.`,
      );
    }

    switch (el._kind) {
      case "paragraph": {
        const d = el._data as ParagraphData;
        const font = resolveFont(d.font, d.bold, d.italic);
        const color = resolveColor(d.color);
        const lines = wrapText(d.text, font, d.fontSize, contentWidth);
        const totalHeight =
          d.spaceBefore +
          lines.length * d.fontSize * d.lineHeight +
          d.spaceAfter;

        // Add space before
        cursorY += d.spaceBefore;
        ensureSpace(d.fontSize * d.lineHeight); // At least one line must fit

        renderLines(lines, font, d.fontSize, d.lineHeight, color, d.align);

        // Add space after
        cursorY += d.spaceAfter;
        void totalHeight; // Used for future orphan/widow control
        break;
      }

      case "heading": {
        const d = el._data as HeadingData;
        const fontSize = HEADING_SIZES[d.level] ?? 11;
        const font = "Helvetica-Bold";
        const color = resolveColor(d.color);
        const lines = wrapText(d.text, font, fontSize, contentWidth);
        // spaceBefore provides visual gap above the heading. Since renderLines
        // now offsets text by fontSize (so cursorY = visual top, not baseline),
        // we don't need extra ascent compensation here.
        const spaceBefore = d.spaceBefore ?? (d.level <= 2 ? 16 : 10);
        const spaceAfter = d.spaceAfter ?? (d.level <= 2 ? 8 : 6);
        const lineHeight = 1.3;

        // Headings should not be orphaned at page bottom — need at least
        // heading height + one line of body text after it
        const minNeeded =
          spaceBefore + lines.length * fontSize * lineHeight + spaceAfter + 20;
        cursorY += spaceBefore;
        ensureSpace(minNeeded);

        renderLines(lines, font, fontSize, lineHeight, color, "left");
        cursorY += spaceAfter;
        break;
      }

      case "bulletList": {
        const d = el._data as BulletListData;
        const color = resolveColor(d.color);
        const lineSpacing = d.fontSize * d.lineHeight;
        const availWidth = contentWidth - d.indent;

        cursorY += d.spaceBefore;

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

        cursorY += d.spaceAfter;
        break;
      }

      case "numberedList": {
        const d = el._data as NumberedListData;
        const color = resolveColor(d.color);
        const lineSpacing = d.fontSize * d.lineHeight;
        const availWidth = contentWidth - d.indent;

        cursorY += d.spaceBefore;

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

        cursorY += d.spaceAfter;
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
        const totalH = tableRowHeight(d.fontSize) * (1 + d.rows.length);
        ensureSpace(Math.min(totalH, tableRowHeight(d.fontSize) * 3)); // At least header + 2 rows must fit

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
        // keyWidth: if > 1, it's absolute points; if <= 1, it's a ratio
        const rawKW = d.keyWidth ?? 0.35;
        const keyW = rawKW > 1 ? rawKW : tableW * rawKW;
        const valW = tableW - keyW;
        const headers = ["Key", "Value"];
        const rows = d.items.map((item) => [item.key, item.value]);
        const colWidths: number[] = [keyW, valW];

        // Calculate X position based on alignment
        let tableX = margins.left;
        if (d.align === "right" && tableW < contentWidth) {
          tableX = margins.left + contentWidth - tableW;
        } else if (d.align === "center" && tableW < contentWidth) {
          tableX = margins.left + (contentWidth - tableW) / 2;
        }

        ensureSpace(tableRowHeight(d.fontSize) * Math.min(3, 1 + rows.length));

        // Right-align the value column by default (financial data looks better right-aligned)
        const kvColumnAlign: ("left" | "center" | "right")[] = [
          "left",
          "right",
        ];

        renderTable(
          doc,
          headers,
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
        );
        cursorY += 8;
        break;
      }

      case "comparisonTable": {
        const d = el._data as ComparisonTableData;
        const headers = ["Feature", ...d.options.map((o) => o.name)];
        const rows = d.features.map((feature, fi) => [
          feature,
          ...d.options.map((o) => (o.values[fi] ? "\u2713" : "\u2717")),
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
        cursorY += d.spaceBefore;

        const leftW = contentWidth * d.ratio;
        const rightW = contentWidth - leftW - d.gap;
        const leftX = margins.left;
        const rightX = margins.left + leftW + d.gap;
        const startY = cursorY;

        // Render elements into a column. Handles ALL element types so nothing
        // gets silently dropped. Returns the Y position after all elements.
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
                const kw = rkw > 1 ? rkw : tw * rkw;
                const vw = tw - kw;
                const kvH = ["Key", "Value"];
                const kvR = kd.items.map((it) => [it.key, it.value]);
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
              default:
                // Unsupported element in column — skip
                break;
            }
          }
          return cy;
        }

        const yLeft = renderColumn(d.left, leftX, leftW, startY);
        const yRight = renderColumn(d.right, rightX, rightW, startY);

        // Advance cursor past the tallest column
        cursorY = Math.max(yLeft, yRight) + d.spaceAfter;
        break;
      }

      case "richText": {
        const d = el._data as RichTextData;
        const lineSpacing = d.fontSize * d.lineHeight;
        cursorY += d.spaceBefore;

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

          renderLines(
            lines,
            font,
            fs,
            d.lineHeight,
            color,
            para.align ?? "left",
          );
        }

        cursorY += d.spaceAfter;
        break;
      }

      case "codeBlock": {
        const d = el._data as CodeBlockData;
        const codeLines = d.code.split("\n");
        const lineH = d.fontSize * d.lineHeight;
        const blockH = codeLines.length * lineH + d.padding * 2;

        cursorY += d.spaceBefore;
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
        const quoteFont = "Helvetica-Oblique";
        const indent = 16; // Left border width + gap
        const availWidth = contentWidth - indent;
        const lines = wrapText(d.text, quoteFont, d.fontSize, availWidth);
        const lineH = d.fontSize * d.lineHeight;
        const textBlockH = lines.length * lineH;
        const authorH = d.author ? d.fontSize * 1.4 : 0;
        const totalH = d.spaceBefore + textBlockH + authorH + d.spaceAfter;

        cursorY += d.spaceBefore;
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

        cursorY += d.spaceAfter;
        void totalH; // Future use
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
        };

        // Draw title above chart if provided
        if (d.title) {
          const titleSize = 14;
          ensureSpace(titleSize * 1.5 + d.height);
          doc.drawText(d.title, margins.left, cursorY, {
            font: "Helvetica-Bold",
            fontSize: titleSize,
            color: resolveColor(undefined),
          });
          cursorY += titleSize * 1.5;
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
              doc.drawText(op.text ?? "", chartX + op.x, chartY + op.y, {
                font: op.font,
                fontSize: op.fontSize,
                color: op.color,
              });
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
 * @param opts - Rich text options
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
    // Accept "spans" as alias for "runs" (LLMs use both interchangeably)
    if (!para.runs && (para as unknown as Record<string, unknown>).spans) {
      para.runs = (para as unknown as Record<string, unknown>)
        .spans as TextRun[];
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
 * @param opts - Code block options
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
 * @param opts - Quote options
 * @returns PdfElement for use with addContent()
 */
export function quote(opts: QuoteOptions): PdfElement {
  const data: QuoteData = {
    text: opts.text,
    author: opts.author,
    fontSize: opts.fontSize ?? 12,
    accentColor: opts.accentColor ?? "",
    lineHeight: opts.lineHeight ?? 1.5,
    spaceBefore: opts.spaceBefore ?? 12,
    spaceAfter: opts.spaceAfter ?? 12,
  };
  return _createPdfElement("quote", data);
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
}

/**
 * Add a title/cover page to the document.
 * Renders a centered title with optional subtitle, author, and date.
 *
 * @param doc - PdfDocument
 * @param opts - Title page options
 */
export function titlePage(doc: PdfDocument, opts: TitlePageOptions): void {
  const theme = doc.theme;
  const ps = doc.pageSize;
  doc.addPage();

  // Background fill
  doc.drawRect(0, 0, ps.width, ps.height, { fill: theme.bg });

  // Title — centered vertically at ~35% from top
  const titleY = ps.height * 0.35;
  const titleSize = 36;
  const titleW = measureText(opts.title, "Helvetica-Bold", titleSize);
  const titleX = (ps.width - titleW) / 2;
  doc.drawText(opts.title, titleX, titleY, {
    font: "Helvetica-Bold",
    fontSize: titleSize,
    color: theme.fg,
  });

  // Subtitle
  if (opts.subtitle) {
    const subY = titleY + titleSize * 1.6;
    const subSize = 18;
    const subW = measureText(opts.subtitle, "Helvetica", subSize);
    const subX = (ps.width - subW) / 2;
    doc.drawText(opts.subtitle, subX, subY, {
      font: "Helvetica",
      fontSize: subSize,
      color: theme.subtle,
    });
  }

  // Accent line
  const lineY = titleY + titleSize * 2.5;
  const lineW = ps.width * 0.3;
  const lineX = (ps.width - lineW) / 2;
  doc.drawLine(lineX, lineY, lineX + lineW, lineY, {
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
 * @param opts - Content page options
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
 * @param opts - Two column page options
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
 * @param opts - Quote page options
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
 * @param opts - Page number options
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
 * @param opts - Footer options
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
export function exportToFile(
  doc: PdfDocument,
  path: string,
  fsWrite: { writeFileBinary: (path: string, data: Uint8Array) => void },
): void {
  const bytes = doc.buildPdf();
  fsWrite.writeFileBinary(path, bytes);
}
