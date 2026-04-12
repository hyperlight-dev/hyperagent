// ── doc-core: Format-agnostic document infrastructure ─────────────────
//
// Shared utilities for ALL document formats (PDF, PPTX, DOCX, etc.).
// Contains themes, colour validation, contrast checking, and input guards.
//
// This module was extracted from ha:ooxml-core to allow non-OOXML formats
// (like PDF) to share the same theme system and validation utilities.

// ── Colour Utilities ─────────────────────────────────────────────────

/**
 * Convert a hex colour string to normalised format (strip leading #, uppercase).
 * This is the **lenient** version — it does NOT throw on bad input.
 * Prefer `requireHex()` at public API boundaries; this is kept for
 * internal paths where the value has already been validated.
 *
 * @param hex - Colour like "#2196F3" or "2196F3"
 * @returns Normalised colour like "2196F3"
 */
export function hexColor(hex: string): string {
  return hex.replace(/^#/, "").toUpperCase();
}

// ── Theme Definitions ────────────────────────────────────────────────
// Each theme provides a coordinated colour palette for professional output.
// Themes are format-agnostic — the same palette drives PPTX, PDF, and more.
//
// AVAILABLE THEMES:
//   • 'corporate-blue' — Dark blue bg (1B2A4A), white text, blue/green/orange accents
//   • 'dark-gradient'  — GitHub dark bg (0D1117), light text, blue/green/gold accents
//   • 'light-clean'    — White bg (FFFFFF), dark text, indigo/orange/teal accents
//   • 'emerald'        — Teal bg (004D40), white text, green/gold/cyan accents
//   • 'sunset'         — Dark red bg (370617), white text, orange/gold/red accents
//   • 'black'          — Pure black bg (000000), white text, blue/green/gold accents
//   • 'brutalist'      — Bold black bg (0A0A0A), red/white accents
//
// THEME COLOUR PROPERTIES (all 6-char hex, no #):
//   bg      — Background colour (default fills)
//   fg      — Primary text colour (titles, body text)
//   accent1 — Primary accent (links, highlights, chart colour 1)
//   accent2 — Secondary accent (chart colour 2, secondary highlights)
//   accent3 — Tertiary accent (chart colour 3)
//   accent4 — Quaternary accent (chart colour 4)
//   subtle  — Muted text colour (captions, footnotes)

/**
 * Theme definition for document styling.
 * Used by PPTX, PDF, and any other document format modules.
 */
export interface Theme {
  /** Background colour (6-char hex, no #) */
  bg: string;
  /** Primary text colour */
  fg: string;
  /** Primary accent */
  accent1: string;
  /** Secondary accent */
  accent2: string;
  /** Tertiary accent */
  accent3: string;
  /** Quaternary accent */
  accent4: string;
  /** Muted/subtle text colour */
  subtle: string;
  /** Font for titles */
  titleFont: string;
  /** Font for body text */
  bodyFont: string;
  /** True if theme has a dark background (bg luminance < 0.5) */
  isDark: boolean;
}

/**
 * Built-in document themes. Use one of these theme names with
 * createPresentation() or createDocument().
 *
 * Valid theme names:
 * - 'corporate-blue' — Dark blue background, white text, professional look
 * - 'dark-gradient' — GitHub-style dark background, light text
 * - 'light-clean' — White background, dark text, clean minimal style
 * - 'emerald' — Teal/green background, white text, nature theme
 * - 'sunset' — Dark red background, white/gold text, warm theme
 * - 'black' — Pure black background, white text
 * - 'brutalist' — Bold black bg, red/white accents
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
 * Get all available theme names.
 * @returns Array of valid theme names
 */
export function getThemeNames(): string[] {
  return Object.keys(THEMES);
}

/** Theme description for LLM consumption. */
interface ThemeDescription {
  name: string;
  bg: string;
  fg: string;
  isDark: boolean;
  bestFor: string;
}

/** Human-readable descriptions of what each theme is best for. */
const THEME_DESCRIPTIONS: Record<string, string> = {
  "corporate-blue": "Professional dark blue — title pages, executive presentations",
  "dark-gradient": "GitHub-style dark mode — developer docs, technical reports",
  "light-clean": "Clean white background — documents, reports, invoices, letters, resumes (RECOMMENDED for most PDFs)",
  emerald: "Rich teal/green — branded reports, sustainability content",
  sunset: "Warm dark red/gold — creative, marketing materials",
  black: "Pure black — minimal, high-contrast presentations",
  midnight: "Pure black (alias for 'black')",
  brutalist: "Bold black with red accents — statements, manifestos",
};

/**
 * Get a markdown-formatted description of all available themes.
 * Includes name, background/text colours, whether it's dark, and recommended use cases.
 * Use this to help choose the right theme for a document.
 *
 * @returns Markdown string describing all themes
 */
export function describeThemes(): string {
  const lines: string[] = [
    "## Available Themes",
    "",
    "| Theme | Background | Text | Dark? | Best For |",
    "|-------|-----------|------|-------|----------|",
  ];
  for (const name of Object.keys(THEMES)) {
    const t = THEMES[name];
    const desc = THEME_DESCRIPTIONS[name] ?? "";
    lines.push(
      `| \`${name}\` | #${t.bg} | #${t.fg} | ${t.isDark ? "Yes" : "No"} | ${desc} |`,
    );
  }
  lines.push("");
  lines.push("**For PDF documents, use `light-clean`** unless the user specifically requests a dark/branded theme.");
  lines.push("Dark themes render white text — content pages will have dark backgrounds automatically.");
  return lines.join("\n");
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
 * @param light - Light text option (default: "FFFFFF")
 * @param dark - Dark text option (default: "333333")
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

// ── Input Validation ─────────────────────────────────────────────────
// Central guards so bad data is stopped at the gate, not discovered
// three layers deep. Every error message is LLM-actionable: it tells
// the caller WHAT is wrong, WHY, and HOW to fix it.

/** Regex for a valid 6-character hex colour (with optional #). */
const HEX_RE = /^#?[0-9A-Fa-f]{6}$/;

/**
 * Validate and normalise a hex colour string.
 * Throws a descriptive Error if the value is missing, wrong type, or
 * not a valid 6-character hex colour.
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

/** Options for requireThemeColor(). */
export interface RequireThemeColorOptions {
  /** Colour to check contrast against (default: theme.bg). Use this for text colours that sit on a known fill. */
  against?: string;
}

/**
 * Validate that a colour is either part of the active theme palette or
 * has sufficient WCAG AA contrast (≥ 4.5) against the theme background.
 * This prevents invisible text (e.g. dark-on-dark, light-on-light).
 *
 * @param hex - Colour to check (6-char hex, no #)
 * @param theme - Active theme
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

/** Options for requireNumber(). */
export interface RequireNumberOptions {
  /** Minimum allowed value (inclusive) */
  min?: number;
  /** Maximum allowed value (inclusive) */
  max?: number;
}

/**
 * Validate that a value is a finite number. Catches NaN, Infinity,
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

/** Options for requireArray(). */
export interface RequireArrayOptions {
  /** Require at least one element */
  nonEmpty?: boolean;
}

/**
 * Validate that a value is an array, optionally non-empty.
 * If a string is passed, it is auto-split on newlines into an array.
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
