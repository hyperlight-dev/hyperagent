//
// AVAILABLE THEMES (use with setTheme() or presentation()):
//   • 'corporate-blue' — Dark blue bg (1B2A4A), white text, blue/green/orange accents
//   • 'dark-gradient'  — GitHub dark bg (0D1117), light text, blue/green/gold accents
//   • 'light-clean'    — White bg (FFFFFF), dark text, indigo/orange/teal accents
//   • 'emerald'        — Teal bg (004D40), white text, green/gold/cyan accents
//   • 'sunset'         — Dark red bg (370617), white text, orange/gold/red accents
//   • 'black'          — Pure black bg (000000), white text, blue/green/gold accents
//
// THEME COLOR PROPERTIES (all 6-char hex, no #):
//   bg      — Background color (slide/shape default fills)
//   fg      — Primary text color (titles, body text)
//   accent1 — Primary accent (links, highlights, chart color 1)
//   accent2 — Secondary accent (chart color 2, secondary highlights)
//   accent3 — Tertiary accent (chart color 3)
//   accent4 — Quaternary accent (chart color 4)
//   subtle  — Muted text color (captions, footnotes)
//

// ── Module Hints for LLM ─────────────────────────────────────────────

// Hints are now in ooxml-core.json (structured metadata).

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

// ── Color Utilities ──────────────────────────────────────────────────

/**
 * Convert a hex color string to OOXML format (strip leading #).
 * This is the **lenient** version — it does NOT throw on bad input.
 * Prefer `requireHex()` at public API boundaries; this is kept for
 * internal paths where the value has already been validated.
 *
 * @param hex - Color like "#2196F3" or "2196F3"
 * @returns OOXML color like "2196F3"
 */
export function hexColor(hex: string): string {
  return hex.replace(/^#/, "").toUpperCase();
}

// ── Theme Definitions ────────────────────────────────────────────────
// Each theme provides a coordinated color palette for professional output.

/**
 * Theme definition for presentation styling.
 */
export interface Theme {
  /** Background color (6-char hex, no #) */
  bg: string;
  /** Primary text color */
  fg: string;
  /** Primary accent */
  accent1: string;
  /** Secondary accent */
  accent2: string;
  /** Tertiary accent */
  accent3: string;
  /** Quaternary accent */
  accent4: string;
  /** Muted/subtle text color */
  subtle: string;
  /** Font for titles */
  titleFont: string;
  /** Font for body text */
  bodyFont: string;
  /** True if theme has a dark background (bg luminance < 0.5) */
  isDark: boolean;
}

/**
 * Available presentation themes. Use one of these theme names with createPresentation().
 *
 * IMPORTANT: Only these exact theme names are valid:
 * - 'corporate-blue' — Dark blue background, white text, professional look
 * - 'dark-gradient' — GitHub-style dark background, light text
 * - 'light-clean' — White background, dark text, clean minimal style
 * - 'emerald' — Teal/green background, white text, nature theme
 * - 'sunset' — Dark red background, white/gold text, warm theme
 */
export const THEMES: Record<string, Theme> = {
  "corporate-blue": {
    bg: "1B2A4A",
    fg: "FFFFFF",
    accent1: "2196F3",
    accent2: "4CAF50",
    accent3: "FF9800",
    accent4: "E91E63",
    subtle: "8899AA",
    titleFont: "Segoe UI",
    bodyFont: "Segoe UI",
    isDark: true,
  },
  "dark-gradient": {
    bg: "0D1117",
    fg: "E6EDF3",
    accent1: "58A6FF",
    accent2: "3FB950",
    accent3: "D29922",
    accent4: "F85149",
    subtle: "8B949E",
    titleFont: "Segoe UI",
    bodyFont: "Segoe UI",
    isDark: true,
  },
  "light-clean": {
    bg: "FFFFFF",
    fg: "333333",
    accent1: "3F51B5",
    accent2: "FF5722",
    accent3: "009688",
    accent4: "795548",
    subtle: "999999",
    titleFont: "Calibri",
    bodyFont: "Calibri",
    isDark: false,
  },
  emerald: {
    bg: "004D40",
    fg: "FFFFFF",
    accent1: "00E676",
    accent2: "FFD740",
    accent3: "40C4FF",
    accent4: "FF6E40",
    subtle: "80CBC4",
    titleFont: "Segoe UI",
    bodyFont: "Segoe UI",
    isDark: true,
  },
  sunset: {
    bg: "370617",
    fg: "FFFFFF",
    accent1: "F48C06",
    accent2: "FFBA08",
    accent3: "E85D04",
    accent4: "DC2F02",
    subtle: "D4A373",
    titleFont: "Segoe UI",
    bodyFont: "Segoe UI",
    isDark: true,
  },
  black: {
    bg: "000000",
    fg: "FFFFFF",
    accent1: "58A6FF",
    accent2: "3FB950",
    accent3: "D29922",
    accent4: "F85149",
    subtle: "8B949E",
    titleFont: "Segoe UI",
    bodyFont: "Segoe UI",
    isDark: true,
  },
  brutalist: {
    bg: "0A0A0A",
    fg: "F5F5F5",
    accent1: "FF0000", // Bold red
    accent2: "FFFFFF", // Pure white
    accent3: "FF3333", // Lighter red
    accent4: "CCCCCC", // Light gray
    subtle: "666666",
    titleFont: "Arial Black",
    bodyFont: "Arial",
    isDark: true,
  },
};

// Set up theme aliases after THEMES is defined
THEMES.midnight = THEMES.black;

/**
 * Get a theme by name. Falls back to 'corporate-blue' if not found.
 * @param name - Theme name (see getThemeNames() for valid values)
 * @returns Theme object
 */
export function getTheme(name: string): Theme {
  return THEMES[name] || THEMES["corporate-blue"];
}

/**
 * Get all available theme names for createPresentation().
 * @returns Array of valid theme names: ['corporate-blue', 'dark-gradient', 'light-clean', 'emerald', 'sunset', 'black']
 * @example
 * // Check available themes before creating presentation
 * const themes = getThemeNames(); // ['corporate-blue', 'dark-gradient', ..., 'black']
 * const pres = createPresentation({ theme: themes[1] }); // Use 'dark-gradient'
 */
export function getThemeNames(): string[] {
  return Object.keys(THEMES);
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

// ── Input Validation ─────────────────────────────────────────────────
// Central guards so bad data is stopped at the gate, not discovered
// three ZIP layers deep.  Every error message is LLM-actionable: it
// tells the caller WHAT is wrong, WHY, and HOW to fix it.

/** Regex for a valid 6-character hex colour (with optional #). */
const HEX_RE = /^#?[0-9A-Fa-f]{6}$/;

/**
 * Validate and normalise a hex colour string.
 * Throws a descriptive Error if the value is missing, wrong type, or
 * not a valid 6-character hex colour.
 *
 * **Rule:** All colour parameters in the PPTX modules MUST pass through
 * this function (or `requireThemeColor`) before being used in XML output.
 *
 * @param hex - Colour value to validate (e.g. "#2196F3" or "2196F3")
 * @param paramName - Parameter name for the error message
 * @returns Upper-cased 6-char hex without # (e.g. "2196F3")
 * @throws If hex is null, undefined, non-string, empty, or not 6-char hex
 */
export function requireHex(
  hex: string | null | undefined,
  paramName: string,
): string {
  if (hex == null) {
    throw new Error(
      `${paramName}: colour is required but was ${hex}. ` +
        `Provide a 6-character hex string like "2196F3" or "#FF9800".`,
    );
  }
  if (typeof hex !== "string") {
    throw new Error(
      `${paramName}: expected a hex colour string but got ${typeof hex} (${JSON.stringify(hex)}). ` +
        `Provide a 6-character hex string like "2196F3".`,
    );
  }
  if (!HEX_RE.test(hex)) {
    throw new Error(
      `${paramName}: "${hex}" is not a valid 6-character hex colour. ` +
        `Use format "RRGGBB" or "#RRGGBB" (e.g. "2196F3", "#FF9800"). ` +
        `3-char shorthand ("FFF"), named colours ("red"), and ` +
        `rgb() notation are NOT supported.`,
    );
  }
  return hex.replace(/^#/, "").toUpperCase();
}

interface RequireThemeColorOptions {
  /** Colour to check contrast against (default: theme.bg). Use this for text colours that sit on a known fill. */
  against?: string;
}

/**
 * Validate that a colour is either part of the active theme palette or
 * has sufficient WCAG AA contrast (≥ 4.5) against the theme background.
 * This prevents invisible text (e.g. dark-on-dark, light-on-light).
 *
 * **Rule:** Every user-facing colour parameter that will be rendered as
 * text or a visible element SHOULD go through this function.  Internal /
 * structural colours (e.g. XML namespace strings) are exempt.
 *
 * @param hex - Colour to check (6-char hex, no #)
 * @param theme - Active presentation theme
 * @param paramName - Parameter name for the error message
 * @param opts - Options
 * @returns The validated, upper-cased hex colour
 * @throws If colour has insufficient contrast and is not a theme colour
 */
export function requireThemeColor(
  hex: string,
  theme: Theme | null | undefined,
  paramName: string,
  opts?: RequireThemeColorOptions,
): string {
  const validated = requireHex(hex, paramName);
  if (!theme) return validated; // no theme context → skip contrast check

  // Theme palette colours are always allowed — they're designed to work.
  // Filter out undefined/null to avoid "not a function" errors on .toUpperCase()
  const palette = [
    theme.bg,
    theme.fg,
    theme.accent1,
    theme.accent2,
    theme.accent3,
    theme.accent4,
    theme.subtle,
  ]
    .filter(Boolean)
    .map((c) => c.toUpperCase());
  if (palette.includes(validated)) return validated;

  // Custom colour — must have WCAG AA contrast against the reference.
  const against = opts?.against
    ? requireHex(opts.against, `${paramName}.against`).toUpperCase()
    : (theme.bg?.toUpperCase() ?? "FFFFFF");
  const ratio = contrastRatio(validated, against);
  if (ratio < 4.5) {
    throw new Error(
      `${paramName}: colour "${validated}" has contrast ratio ${ratio.toFixed(2)}:1 ` +
        `against background "${against}" — below the WCAG AA minimum of 4.5:1. ` +
        `FIX: REMOVE the color parameter entirely — the system auto-selects a readable colour. ` +
        `If you MUST specify a colour, use a theme value: ` +
        `theme.fg, theme.accent1, theme.accent2, theme.accent3, theme.accent4, theme.subtle.`,
    );
  }
  return validated;
}

interface RequireNumberOptions {
  /** Minimum allowed value (inclusive) */
  min?: number;
  /** Maximum allowed value (inclusive) */
  max?: number;
}

/**
 * Validate that a value is a finite number.  Catches NaN, Infinity,
 * strings, null, undefined, and other non-numeric garbage.
 *
 * @param n - Value to validate
 * @param paramName - Parameter name for the error message
 * @param opts - Options
 * @returns The validated number
 * @throws If not a finite number or out of range
 */
export function requireNumber(
  n: unknown,
  paramName: string,
  opts?: RequireNumberOptions,
): number {
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new Error(
      `${paramName}: expected a number but got ${typeof n} (${JSON.stringify(n)}). ` +
        `Provide a numeric value like 1.5 or 24.`,
    );
  }
  if (opts?.min != null && n < opts.min) {
    throw new Error(
      `${paramName}: value ${n} is below the minimum ${opts.min}.`,
    );
  }
  if (opts?.max != null && n > opts.max) {
    throw new Error(
      `${paramName}: value ${n} exceeds the maximum ${opts.max}.`,
    );
  }
  return n;
}

/**
 * Validate that a value is a non-empty string.
 *
 * @param s - Value to validate
 * @param paramName - Parameter name for the error message
 * @returns The validated string
 * @throws If not a string or empty
 */
export function requireString(s: unknown, paramName: string): string {
  if (typeof s !== "string" || s.length === 0) {
    throw new Error(
      `${paramName}: expected a non-empty string but got ${typeof s} (${JSON.stringify(s)}). ` +
        `Provide a text value like "Revenue" or "Q1 2026".`,
    );
  }
  return s;
}

interface RequireArrayOptions {
  /** Require at least one element */
  nonEmpty?: boolean;
}

/**
 * Validate that a value is an array, optionally non-empty.
 *
 * @param a - Value to validate
 * @param paramName - Parameter name for the error message
 * @param opts - Options
 * @returns The validated array
 * @throws If not an array or empty when nonEmpty is true
 */
export function requireArray<T>(
  a: unknown,
  paramName: string,
  opts?: RequireArrayOptions,
): T[] {
  // Auto-convert string to array by splitting on newlines (LLM often passes strings)
  if (typeof a === "string") {
    a = a
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  if (!Array.isArray(a)) {
    throw new Error(
      `${paramName}: expected an array but got ${typeof a} (${JSON.stringify(a)}). ` +
        `Provide an array like ["Item 1", "Item 2"].`,
    );
  }
  if (opts?.nonEmpty && a.length === 0) {
    throw new Error(
      `${paramName}: array must not be empty. Provide at least one element.`,
    );
  }
  return a as T[];
}

/**
 * Validate that a value is one of an allowed set of enum values.
 *
 * @param val - Value to validate
 * @param paramName - Parameter name for the error message
 * @param whitelist - Allowed values
 * @returns The validated value
 * @throws If not in the whitelist
 */
export function requireEnum<T extends string>(
  val: unknown,
  paramName: string,
  whitelist: readonly T[],
): T {
  if (!whitelist.includes(val as T)) {
    throw new Error(
      `${paramName}: "${val}" is not a valid option. ` +
        `Allowed values: ${whitelist.map((v) => `"${v}"`).join(", ")}.`,
    );
  }
  return val as T;
}

// ── WCAG 2.0 Contrast Utilities ──────────────────────────────────────
// Used to auto-select readable text colours against arbitrary backgrounds.

/**
 * Calculate WCAG 2.0 relative luminance of a hex colour.
 * @param hex - 6-char hex colour (no #)
 * @returns Luminance 0.0–1.0
 */
export function luminance(hex: string): number {
  const c = hexColor(hex);
  const r = parseInt(c.slice(0, 2), 16) / 255;
  const g = parseInt(c.slice(2, 4), 16) / 255;
  const b = parseInt(c.slice(4, 6), 16) / 255;
  const lin = (v: number): number =>
    v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * WCAG 2.0 contrast ratio between two colours (1.0–21.0).
 * >= 4.5 for AA normal text, >= 3.0 for AA large text.
 * @param hex1 - 6-char hex (no #)
 * @param hex2 - 6-char hex (no #)
 * @returns Contrast ratio
 */
export function contrastRatio(hex1: string, hex2: string): number {
  const l1 = luminance(hex1);
  const l2 = luminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Pick readable text colour for a background. Returns whichever of
 * light / dark has higher WCAG contrast against bgHex.
 * @param bgHex - Background colour (6-char hex, no #)
 * @param light - Light text option
 * @param dark - Dark text option
 * @returns Hex colour with better contrast
 */
export function autoTextColor(
  bgHex: string,
  light: string = "FFFFFF",
  dark: string = "333333",
): string {
  return contrastRatio(bgHex, light) >= contrastRatio(bgHex, dark)
    ? light
    : dark;
}

/**
 * Check if a colour is "dark" (luminance < 0.5).
 * Useful for choosing theme-appropriate defaults.
 * @param hex - 6-char hex colour (no #)
 * @returns True if the colour is dark
 */
export function isDark(hex: string): boolean {
  return luminance(hex) < 0.5;
}

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
