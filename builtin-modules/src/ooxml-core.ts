// ── ooxml-core: OOXML-specific infrastructure ────────────────────────
//
// This module provides OOXML-specific utilities: EMU conversions, XML
// generators, slide dimensions, ShapeFragment branded types, and shape
// ID management. Format-agnostic utilities (themes, colours, validation)
// live in ha:doc-core and are re-exported from here for compatibility.
//
// Hints are now in ooxml-core.json (structured metadata).

// ── Re-exports from ha:doc-core ──────────────────────────────────────
// These were extracted to ha:doc-core so PDF and other formats can share
// them without depending on OOXML infrastructure. Re-exported here so
// that existing code importing from ha:ooxml-core continues to work.
export {
  hexColor,
  type Theme,
  THEMES,
  getTheme,
  getThemeNames,
  luminance,
  contrastRatio,
  autoTextColor,
  isDark,
  requireHex,
  requireThemeColor,
  type RequireThemeColorOptions,
  requireNumber,
  type RequireNumberOptions,
  requireString,
  requireArray,
  type RequireArrayOptions,
  requireEnum,
} from "ha:doc-core";

// Import for local use within this module (themeXml needs Theme)
import { type Theme } from "ha:doc-core";

// ── EMU Unit Conversions ─────────────────────────────────────────────
// OOXML uses English Metric Units (EMUs) for all positioning and sizing.
// 1 inch = 914400 EMU, 1 point = 12700 EMU, 1 cm = 360000 EMU.

/** EMUs per inch. */
export const EMU_PER_INCH: number = 914400;
/** EMUs per typographic point. */
export const EMU_PER_PT: number = 12700;
/** EMUs per centimetre. */
export const EMU_PER_CM: number = 360000;
/** Hundredths of a point (used for font sizes in OOXML). */
export const HALF_PT: number = 50;

/**
 * Convert inches to EMUs.
 * @param n - Value in inches
 * @returns Value in EMUs
 */
export function inches(n: number): number {
  return Math.round(n * EMU_PER_INCH);
}

/**
 * Convert points to EMUs.
 * @param n - Value in points
 * @returns Value in EMUs
 */
export function pts(n: number): number {
  return Math.round(n * EMU_PER_PT);
}

/**
 * Convert centimetres to EMUs.
 * @param n - Value in centimetres
 * @returns Value in EMUs
 */
export function cm(n: number): number {
  return Math.round(n * EMU_PER_CM);
}

/**
 * Convert point size to OOXML font size (hundredths of a point).
 * OOXML stores font sizes as half-points × 100.
 * @param pt - Font size in points (e.g. 24)
 * @returns OOXML font size value (e.g. 2400)
 */
export function fontSize(pt: number): number {
  return Math.round(pt * 100);
}

// ── Content_Types.xml ────────────────────────────────────────────────

interface ContentTypeDefault {
  extension: string;
  contentType: string;
}

interface ContentTypeOverride {
  partName: string;
  contentType: string;
}

/**
 * Generate [Content_Types].xml for an OOXML document.
 * @param overrides - Part-specific types
 * @param defaults - Extension defaults
 * @returns Complete [Content_Types].xml string
 */
export function contentTypesXml(
  overrides: ContentTypeOverride[],
  defaults?: ContentTypeDefault[],
): string {
  const defs = defaults || [
    {
      extension: "rels",
      contentType: "application/vnd.openxmlformats-package.relationships+xml",
    },
    { extension: "xml", contentType: "application/xml" },
  ];
  const defStr = defs
    .map(
      (d) =>
        `<Default Extension="${d.extension}" ContentType="${d.contentType}"/>`,
    )
    .join("");
  // Deduplicate overrides by partName - last entry wins
  const seenParts = new Map<string, ContentTypeOverride>();
  for (const o of overrides) {
    seenParts.set(o.partName, o);
  }
  const overStr = Array.from(seenParts.values())
    .map(
      (o) =>
        `<Override PartName="${o.partName}" ContentType="${o.contentType}"/>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${defStr}${overStr}</Types>`;
}

// ── Relationships ────────────────────────────────────────────────────

interface Relationship {
  id: string;
  type: string;
  target: string;
  targetMode?: string;
}

/**
 * Generate a .rels relationships file.
 * @param rels - Relationship entries
 * @returns Complete .rels XML string
 */
export function relsXml(rels: Relationship[]): string {
  const entries = rels
    .map((r) => {
      // External targets (absolute URLs) need TargetMode="External"
      const mode = r.targetMode ? ` TargetMode="${r.targetMode}"` : "";
      return `<Relationship Id="${r.id}" Type="${r.type}" Target="${r.target}"${mode}/>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries}</Relationships>`;
}

// ── Theme XML ────────────────────────────────────────────────────────

/**
 * Generate a minimal Office theme XML.
 * @param theme - Theme object
 * @param name - Theme name attribute
 * @returns Complete theme1.xml string
 */
export function themeXml(theme: Theme, name?: string): string {
  const n = name || "HyperAgent";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="${n}">
<a:themeElements>
<a:clrScheme name="${n}">
<a:dk1><a:srgbClr val="${theme.bg}"/></a:dk1>
<a:lt1><a:srgbClr val="${theme.fg}"/></a:lt1>
<a:dk2><a:srgbClr val="44546A"/></a:dk2>
<a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
<a:accent1><a:srgbClr val="${theme.accent1}"/></a:accent1>
<a:accent2><a:srgbClr val="${theme.accent2}"/></a:accent2>
<a:accent3><a:srgbClr val="${theme.accent3}"/></a:accent3>
<a:accent4><a:srgbClr val="${theme.accent4}"/></a:accent4>
<a:accent5><a:srgbClr val="${theme.subtle}"/></a:accent5>
<a:accent6><a:srgbClr val="${theme.accent1}"/></a:accent6>
<a:hlink><a:srgbClr val="${theme.accent1}"/></a:hlink>
<a:folHlink><a:srgbClr val="${theme.accent3}"/></a:folHlink>
</a:clrScheme>
<a:fontScheme name="${n}">
<a:majorFont><a:latin typeface="${theme.titleFont}"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>
<a:minorFont><a:latin typeface="${theme.bodyFont}"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>
</a:fontScheme>
<a:fmtScheme name="${n}">
<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>
<a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="25400"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="38100"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>
<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>
</a:fmtScheme>
</a:themeElements>
</a:theme>`;
}

// ── Standard Widescreen Dimensions ───────────────────────────────────

/** Standard widescreen 16:9 slide width (13.333 inches in EMUs). */
export const SLIDE_WIDTH: number = 12192000;
/** Standard widescreen 16:9 slide height (7.5 inches in EMUs). */
export const SLIDE_HEIGHT: number = 6858000;

// ── ShapeFragment (Opaque Branded Type) ──────────────────────────────
// All shape builders (textBox, rect, table, etc.) return ShapeFragment.
// Only code that holds the private SHAPE_BRAND symbol can forge one.
// This prevents LLMs from injecting arbitrary XML strings into slides.
//
// SECURITY MODEL:
// The sandbox architecture shares all ha:* module exports at runtime.
// We cannot make _createShapeFragment truly unexportable for cross-module
// use (pptx.ts, pptx-charts.ts, pptx-tables.ts all need it).
// Defence layers:
//   1. Underscore prefix → excluded from module_info / hints by convention
//   2. Filtered from ha-modules.d.ts → invisible to LLM type discovery
//      (generate-ha-modules-dts.ts skips _-prefixed exports)
//   3. SKILL.md documents only builder functions, not the factory
//   4. Code-validator + sandbox provide the hard security boundary
// The threat model is LLM hallucinations, not adversarial humans.

/** Private brand symbol — never exported by module boundary. */
const SHAPE_BRAND: unique symbol = Symbol("ShapeFragment");

/**
 * Opaque shape fragment produced by official shape builders.
 * Cannot be constructed from raw strings by LLM code.
 *
 * Internal code can read `._xml`; external (LLM) code treats this as opaque.
 */
export interface ShapeFragment {
  /** @internal Raw OOXML XML for this shape element. */
  readonly _xml: string;
  /** Returns the internal XML (for string concatenation in internal code). */
  toString(): string;
}

/**
 * Create a branded ShapeFragment wrapping validated XML.
 * Called internally by shape builder functions (textBox, rect, table, etc.).
 * Underscore-prefixed to signal internal-only — LLMs should use builder
 * functions (textBox, rect, etc.) not this directly.
 * @internal
 */
export function _createShapeFragment(xml: string): ShapeFragment {
  const obj = {
    _xml: xml,
    toString(): string {
      return xml;
    },
  } as ShapeFragment;
  // Brand the object with the private symbol (runtime check)
  (obj as unknown as Record<symbol, boolean>)[SHAPE_BRAND] = true;
  return Object.freeze(obj);
}

/**
 * Check whether a value is a genuine ShapeFragment from a builder function.
 * Uses the private symbol brand — cannot be forged by LLM code.
 */
export function isShapeFragment(x: unknown): x is ShapeFragment {
  return (
    x != null &&
    typeof x === "object" &&
    (x as Record<symbol, unknown>)[SHAPE_BRAND] === true
  );
}

/**
 * Convert an array of ShapeFragments to a single XML string.
 * Validates that every element is a genuine branded ShapeFragment.
 * @throws If any element is not a ShapeFragment
 */
export function fragmentsToXml(
  fragments: ShapeFragment | ShapeFragment[],
): string {
  const arr = Array.isArray(fragments) ? fragments : [fragments];
  const parts: string[] = [];
  for (let i = 0; i < arr.length; i++) {
    const f = arr[i];
    if (!isShapeFragment(f)) {
      throw new Error(
        `shapes[${i}]: expected a ShapeFragment from textBox/rect/table/bulletList/etc, ` +
          `but got ${typeof f}. Do NOT pass raw XML strings — use the shape builder functions.`,
      );
    }
    parts.push(f._xml);
  }
  return parts.join("");
}

// ── Shape ID Counter ─────────────────────────────────────────────────
// OOXML requires each shape in a presentation to have a unique positive integer ID.
// PowerPoint will show a "found a problem with content" error if multiple
// shapes share the same ID (even id="0"). This counter generates unique IDs.
// IMPORTANT: Counter must be preserved across handler boundaries via
// serialize()/restorePresentation() to avoid duplicate IDs when shapes are
// added (e.g., addSlideNumbers, addFooter) after restoring a presentation.

let _shapeIdCounter = 1;

/**
 * Get the next unique shape ID.
 * Used by shape-generating functions to ensure unique IDs within a slide.
 */
export function nextShapeId(): number {
  return ++_shapeIdCounter;
}

/**
 * Get the next unique shape ID and generate a name for the shape.
 * PowerPoint expects shapes to have names - empty names trigger "repair" dialogs.
 * @param shapeType - Type of shape (e.g. "TextBox", "Rectangle", "Image", "Line")
 * @returns Object with id and name
 */
export function nextShapeIdAndName(shapeType: string): {
  id: number;
  name: string;
} {
  const id = ++_shapeIdCounter;
  return { id, name: `${shapeType} ${id}` };
}

/**
 * Reset shape ID counter for a new slide. Called at start of each slide.
 */
export function resetShapeIdCounter(): void {
  _shapeIdCounter = 1; // Start at 2 because group container uses 1
}

/**
 * Get the current shape ID counter value.
 * Used for serialization to preserve counter across handler boundaries.
 */
export function getShapeIdCounter(): number {
  return _shapeIdCounter;
}

/**
 * Set the shape ID counter to a specific value.
 * Used when restoring a presentation to continue numbering from where it left off.
 * @param n - The counter value to set
 */
export function setShapeIdCounter(n: number): void {
  _shapeIdCounter = n;
}

// ── Global forceAllColors Flag ───────────────────────────────────────
// Bypasses WCAG contrast validation globally when enabled.
// Auto-enabled for dark themes (isDark: true) unless explicitly set to false.

let _forceAllColors = false;

/**
 * Set the global forceAllColors flag.
 * When true, bypasses WCAG contrast validation for text colours.
 * @param value - Whether to force all colours
 */
export function setForceAllColors(value: boolean): void {
  _forceAllColors = value;
}

/**
 * Check if forceAllColors mode is active.
 * Used by shape functions to skip contrast validation.
 */
export function isForceAllColors(): boolean {
  return _forceAllColors;
}
