// Type declarations for ha:* module imports
// AUTO-GENERATED from compiled .d.ts files — do not edit manually!
// Run: npx tsx scripts/generate-ha-modules-dts.ts

declare module "ha:base64" {
  /**
   * Encode a Uint8Array as a Base64 string.
   * @param bytes - Raw bytes to encode
   * @returns Base64-encoded string
   */
  export declare function encode(bytes: Uint8Array): string;
  /**
   * Decode a Base64 string to a Uint8Array.
   * @param str - Base64-encoded string
   * @returns Decoded bytes
   */
  export declare function decode(str: string): Uint8Array;
}

declare module "ha:crc32" {
  /**
   * Calculate CRC32 checksum for binary data.
   * Uses the IEEE 802.3 polynomial (same as ZIP, PNG, gzip).
   * @param data - Raw bytes to checksum
   * @returns Unsigned 32-bit CRC value
   */
  export declare function crc32(data: Uint8Array): number;
  /**
   * Update a running CRC32 with additional data (streaming).
   * Call with initial=0xFFFFFFFF, finalize by XORing with 0xFFFFFFFF.
   * @param crc - Running CRC value (start with 0xFFFFFFFF)
   * @param data - Additional bytes
   * @returns Updated CRC value (not finalized)
   */
  export declare function crc32Update(crc: number, data: Uint8Array): number;
  /**
   * Finalize a running CRC32 value.
   * @param crc - Running CRC from crc32Update
   * @returns Final unsigned 32-bit CRC
   */
  export declare function crc32Finalize(crc: number): number;
}

declare module "ha:html" {
  /**
   * Extract visible text from HTML, stripping all tags.
   * Decodes common HTML entities (&amp; &lt; etc).
   * Block elements (p, div, h1-h6, li, br) produce line breaks.
   * Invisible elements (script, style, head) are suppressed.
   */
  export declare function html_to_text(html: string): string;
  /**
   * Extract all links from HTML as [{href, text}] pairs.
   * Returns an array of objects with href and text properties.
   */
  export declare function extract_links(html: string): any[];
  /**
   * Extract visible text AND links in one pass (more efficient than
   * calling htmlToText + extractLinks separately).
   * Returns {text, links: [{href, text}]}.
   */
  export declare function parse_html(input: string): Record<string, any>;
}

declare module "ha:image" {
  /**
   * Read image dimensions from PNG, JPEG, GIF, or BMP header bytes.
   * Returns {width, height} or null if the format is unrecognised.
   * Only reads the header — does NOT decode the full image.
   */
  export declare function get_image_dimensions(data: Uint8Array, format: string): Uint8Array;
  /**
   * Auto-detect image format from header bytes and return dimensions.
   * Returns {width, height, format} or null if unrecognised.
   */
  export declare function detect_image_dimensions(data: Uint8Array): Uint8Array;
}

declare module "ha:markdown" {
  /**
   * Convert Markdown to HTML.
   * Supports: headings, bold, italic, links, code blocks, inline code,
   * unordered/ordered lists, blockquotes, horizontal rules, paragraphs.
   */
  export declare function markdown_to_html(md: string): string;
  /**
   * Convert Markdown to plain text (strip all formatting).
   * Code block content is preserved. Lists use bullet points.
   */
  export declare function markdown_to_text(md: string): string;
}

declare module "ha:ooxml-core" {
  /** EMUs per inch. */
  export declare const EMU_PER_INCH: number;
  /** EMUs per typographic point. */
  export declare const EMU_PER_PT: number;
  /** EMUs per centimetre. */
  export declare const EMU_PER_CM: number;
  /** Hundredths of a point (used for font sizes in OOXML). */
  export declare const HALF_PT: number;
  /**
   * Convert inches to EMUs.
   * @param n - Value in inches
   * @returns Value in EMUs
   */
  export declare function inches(n: number): number;
  /**
   * Convert points to EMUs.
   * @param n - Value in points
   * @returns Value in EMUs
   */
  export declare function pts(n: number): number;
  /**
   * Convert centimetres to EMUs.
   * @param n - Value in centimetres
   * @returns Value in EMUs
   */
  export declare function cm(n: number): number;
  /**
   * Convert point size to OOXML font size (hundredths of a point).
   * OOXML stores font sizes as half-points × 100.
   * @param pt - Font size in points (e.g. 24)
   * @returns OOXML font size value (e.g. 2400)
   */
  export declare function fontSize(pt: number): number;
  /**
   * Convert a hex color string to OOXML format (strip leading #).
   * This is the **lenient** version — it does NOT throw on bad input.
   * Prefer `requireHex()` at public API boundaries; this is kept for
   * internal paths where the value has already been validated.
   *
   * @param hex - Color like "#2196F3" or "2196F3"
   * @returns OOXML color like "2196F3"
   */
  export declare function hexColor(hex: string): string;
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
  export declare const THEMES: Record<string, Theme>;
  /**
   * Get a theme by name. Falls back to 'corporate-blue' if not found.
   * @param name - Theme name (see getThemeNames() for valid values)
   * @returns Theme object
   */
  export declare function getTheme(name: string): Theme;
  /**
   * Get all available theme names for createPresentation().
   * @returns Array of valid theme names: ['corporate-blue', 'dark-gradient', 'light-clean', 'emerald', 'sunset', 'black']
   * @example
   * // Check available themes before creating presentation
   * const themes = getThemeNames(); // ['corporate-blue', 'dark-gradient', ..., 'black']
   * const pres = createPresentation({ theme: themes[1] }); // Use 'dark-gradient'
   */
  export declare function getThemeNames(): string[];
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
  export declare function contentTypesXml(overrides: ContentTypeOverride[], defaults?: ContentTypeDefault[]): string;
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
  export declare function relsXml(rels: Relationship[]): string;
  /**
   * Generate a minimal Office theme XML.
   * @param theme - Theme object
   * @param name - Theme name attribute
   * @returns Complete theme1.xml string
   */
  export declare function themeXml(theme: Theme, name?: string): string;
  /** Standard widescreen 16:9 slide width (13.333 inches in EMUs). */
  export declare const SLIDE_WIDTH: number;
  /** Standard widescreen 16:9 slide height (7.5 inches in EMUs). */
  export declare const SLIDE_HEIGHT: number;
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
  export declare function requireHex(hex: string | null | undefined, paramName: string): string;
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
  export declare function requireThemeColor(hex: string, theme: Theme | null | undefined, paramName: string, opts?: RequireThemeColorOptions): string;
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
  export declare function requireNumber(n: unknown, paramName: string, opts?: RequireNumberOptions): number;
  /**
   * Validate that a value is a non-empty string.
   *
   * @param s - Value to validate
   * @param paramName - Parameter name for the error message
   * @returns The validated string
   * @throws If not a string or empty
   */
  export declare function requireString(s: unknown, paramName: string): string;
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
  export declare function requireArray<T>(a: unknown, paramName: string, opts?: RequireArrayOptions): T[];
  /**
   * Validate that a value is one of an allowed set of enum values.
   *
   * @param val - Value to validate
   * @param paramName - Parameter name for the error message
   * @param whitelist - Allowed values
   * @returns The validated value
   * @throws If not in the whitelist
   */
  export declare function requireEnum<T extends string>(val: unknown, paramName: string, whitelist: readonly T[]): T;
  /**
   * Calculate WCAG 2.0 relative luminance of a hex colour.
   * @param hex - 6-char hex colour (no #)
   * @returns Luminance 0.0–1.0
   */
  export declare function luminance(hex: string): number;
  /**
   * WCAG 2.0 contrast ratio between two colours (1.0–21.0).
   * >= 4.5 for AA normal text, >= 3.0 for AA large text.
   * @param hex1 - 6-char hex (no #)
   * @param hex2 - 6-char hex (no #)
   * @returns Contrast ratio
   */
  export declare function contrastRatio(hex1: string, hex2: string): number;
  /**
   * Pick readable text colour for a background. Returns whichever of
   * light / dark has higher WCAG contrast against bgHex.
   * @param bgHex - Background colour (6-char hex, no #)
   * @param light - Light text option
   * @param dark - Dark text option
   * @returns Hex colour with better contrast
   */
  export declare function autoTextColor(bgHex: string, light?: string, dark?: string): string;
  /**
   * Check if a colour is "dark" (luminance < 0.5).
   * Useful for choosing theme-appropriate defaults.
   * @param hex - 6-char hex colour (no #)
   * @returns True if the colour is dark
   */
  export declare function isDark(hex: string): boolean;
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
  export declare function _createShapeFragment(xml: string): ShapeFragment;
  /**
   * Check whether a value is a genuine ShapeFragment from a builder function.
   * Uses the private symbol brand — cannot be forged by LLM code.
   */
  export declare function isShapeFragment(x: unknown): x is ShapeFragment;
  /**
   * Convert an array of ShapeFragments to a single XML string.
   * Validates that every element is a genuine branded ShapeFragment.
   * @throws If any element is not a ShapeFragment
   */
  export declare function fragmentsToXml(fragments: ShapeFragment | ShapeFragment[]): string;
  /**
   * Get the next unique shape ID.
   * Used by shape-generating functions to ensure unique IDs within a slide.
   */
  export declare function nextShapeId(): number;
  /**
   * Get the next unique shape ID and generate a name for the shape.
   * PowerPoint expects shapes to have names - empty names trigger "repair" dialogs.
   * @param shapeType - Type of shape (e.g. "TextBox", "Rectangle", "Image", "Line")
   * @returns Object with id and name
   */
  export declare function nextShapeIdAndName(shapeType: string): {
      id: number;
      name: string;
  };
  /**
   * Reset shape ID counter for a new slide. Called at start of each slide.
   */
  export declare function resetShapeIdCounter(): void;
  /**
   * Get the current shape ID counter value.
   * Used for serialization to preserve counter across handler boundaries.
   */
  export declare function getShapeIdCounter(): number;
  /**
   * Set the shape ID counter to a specific value.
   * Used when restoring a presentation to continue numbering from where it left off.
   * @param n - The counter value to set
   */
  export declare function setShapeIdCounter(n: number): void;
  /**
   * Set the global forceAllColors flag.
   * When true, bypasses WCAG contrast validation for text colours.
   * @param value - Whether to force all colours
   */
  export declare function setForceAllColors(value: boolean): void;
  /**
   * Check if forceAllColors mode is active.
   * Used by shape functions to skip contrast validation.
   */
  export declare function isForceAllColors(): boolean;
  export {};
}

declare module "ha:pptx-charts" {
  /** Maximum charts per presentation deck. */
  export declare const MAX_CHARTS_PER_DECK = 50;
  /** Maximum data series per chart (Excel column reference limit B–Y). */
  export declare const MAX_SERIES_PER_CHART = 24;
  /** Maximum categories (X-axis labels) per chart. */
  export declare const MAX_CATEGORIES_PER_CHART = 100;
  export interface ChartSeries {
      /** Series name (appears in legend). REQUIRED. */
      name: string;
      /** Numeric values, one per category. REQUIRED. */
      values: number[];
      /** Optional hex color (auto-assigned if omitted). */
      color?: string;
  }
  export interface ChartResult {
      type: "chart";
      chartType: string;
      /**
       * Internal chart XML — do NOT concatenate into slide shapes.
       * Use chartSlide() or embedChart() to add charts to presentations.
       * @internal
       */
      _chartXml: string;
      /** Optional X position in inches (for embedChart fallback) */
      x?: number;
      /** Optional Y position in inches (for embedChart fallback) */
      y?: number;
      /** Optional width in inches (for embedChart fallback) */
      w?: number;
      /** Optional height in inches (for embedChart fallback) */
      h?: number;
      /** @internal Guard: throws if chart is accidentally concatenated into shapes */
      toString(): string;
  }
  export interface BarChartOptions {
      /** X-axis category labels (e.g. ['Q1', 'Q2', 'Q3']) */
      categories?: string[];
      /** Data series array. REQUIRED. */
      series: ChartSeries[];
      /** Horizontal bars (bar chart vs column chart) */
      horizontal?: boolean;
      /** Stack bars */
      stacked?: boolean;
      /** Show data labels on bars */
      showValues?: boolean;
      /** Chart title */
      title?: string;
      /** Show legend */
      showLegend?: boolean;
      /** Explicit text colour for axes/legend/labels (hex). Use on dark themes. */
      textColor?: string;
  }
  /**
   * Create a bar/column chart.
   *
   * @example
   * // Simple bar chart with two series
   * const chart = barChart({
   *   categories: ['Q1', 'Q2', 'Q3', 'Q4'],
   *   series: [
   *     { name: 'Revenue', values: [100, 120, 140, 160] },
   *     { name: 'Profit', values: [20, 25, 30, 35], color: '4CAF50' }
   *   ],
   *   title: 'Quarterly Results',
   *   textColor: 'E6EDF3'  // Use on dark themes for readability
   * });
   *
   * @param opts - REQUIRED: { series: Array<{name, values}> }. Optional: categories?, horizontal?, stacked?, showValues?, title?, showLegend?, textColor?
   * @returns Chart object with xml property and type metadata. Pass to chartSlide() or embedChart().
   */
  export declare function barChart(opts: BarChartOptions): ChartResult;
  export interface PieChartOptions {
      /** Slice labels */
      labels: string[];
      /** Slice values */
      values: number[];
      /** Custom colors per slice */
      colors?: string[];
      /** Show percentage labels (disable for many slices) */
      showPercent?: boolean;
      /**
       * Hide labels for slices below this percentage (0-100).
       * - 'auto' (default): hide labels for slices <5% when there are >5 slices
       * - number: explicit threshold (e.g., 3 = hide slices below 3%)
       * - 0: show all labels (same as omitting this option with ≤5 slices)
       */
      labelThreshold?: number | "auto";
      /** Donut style */
      donut?: boolean;
      /** Donut hole size (1-90) */
      holeSize?: number;
      /** Chart title (renders inside chart — don't add external title) */
      title?: string;
      /** Show legend */
      showLegend?: boolean;
      /** Explicit text colour for legend/labels (hex) */
      textColor?: string;
  }
  /**
   * Create a pie chart.
   *
   * SMART LABEL HANDLING: By default (labelThreshold='auto'), labels are hidden
   * for slices below 5% when there are more than 5 slices. This prevents the
   * common problem of overlapping labels on small slices. The legend always
   * shows all slices, so hidden labels are still identifiable.
   *
   * To show all labels regardless of size, set labelThreshold: 0.
   * To hide labels below a specific percentage, set labelThreshold: 3 (for 3%).
   *
   * TITLE: The opts.title renders INSIDE the chart area. Do NOT also add a
   * textBox title above the chart — this causes overlapping text.
   *
   * @param opts - REQUIRED: { labels: string[], values: number[] }. Optional: colors?, showPercent?, labelThreshold?, donut?, holeSize?, title?, showLegend?, textColor?
   * @returns Chart object
   */
  export declare function pieChart(opts: PieChartOptions): ChartResult;
  export interface LineChartOptions {
      /** X-axis category labels */
      categories?: string[];
      /** Data series array. Each series must have name, values, optional color. */
      series: ChartSeries[];
      /** Smooth lines (spline) */
      smooth?: boolean;
      /** Show data point markers */
      showMarkers?: boolean;
      /** Fill area under the line */
      area?: boolean;
      /** Show data labels */
      showValues?: boolean;
      /** Chart title */
      title?: string;
      /** Show legend */
      showLegend?: boolean;
      /** Explicit text colour for axes/legend/labels (hex). Use on dark themes. */
      textColor?: string;
  }
  /**
   * Create a line chart.
   *
   * @example
   * const chart = lineChart({
   *   categories: ['Jan', 'Feb', 'Mar', 'Apr'],
   *   series: [
   *     { name: 'Sales', values: [100, 120, 115, 140] },
   *     { name: 'Costs', values: [80, 85, 90, 95], color: 'E91E63' }
   *   ],
   *   smooth: true,
   *   title: 'Monthly Trend',
   *   textColor: 'E6EDF3'
   * });
   *
   * @param opts - REQUIRED: { series: Array<{name, values}> }. Optional: categories?, smooth?, showMarkers?, area?, showValues?, title?, showLegend?, textColor?
   * @returns Chart object. Pass to chartSlide() or embedChart().
   */
  export declare function lineChart(opts: LineChartOptions): ChartResult;
  export interface ComboChartOptions {
      /** X-axis category labels */
      categories?: string[];
      /** Bar data series. Each must have name, values, optional color. */
      barSeries?: ChartSeries[];
      /** Line data series (overlaid). Each must have name, values, optional color. */
      lineSeries?: ChartSeries[];
      /** Show data labels */
      showValues?: boolean;
      /** Chart title */
      title?: string;
      /** Show legend */
      showLegend?: boolean;
      /** Explicit text colour for axes/legend (hex). Use on dark themes. */
      textColor?: string;
  }
  /**
   * Create a combo chart — bars + line overlay on the same axes.
   *
   * @example
   * const chart = comboChart({
   *   categories: ['Q1', 'Q2', 'Q3', 'Q4'],
   *   barSeries: [
   *     { name: 'Revenue', values: [100, 120, 140, 160] }
   *   ],
   *   lineSeries: [
   *     { name: 'Target', values: [110, 130, 150, 170], color: 'FF5722' }
   *   ],
   *   title: 'Revenue vs Target'
   * });
   *
   * @param opts - Optional: { categories?, barSeries?, lineSeries?, showValues?, title?, showLegend?, textColor? }. At least one of barSeries or lineSeries required.
   * @returns Chart object. Pass to chartSlide() or embedChart().
   */
  export declare function comboChart(opts: ComboChartOptions): ChartResult;
  export interface ChartPosition {
      x?: number;
      y?: number;
      w?: number;
      h?: number;
  }
  export interface EmbedChartResult {
      /** ShapeFragment for use in customSlide shapes array. */
      shape: ShapeFragment;
      /** @internal Raw shape XML string (kept for internal compatibility). */
      shapeXml: string;
      zipEntries: Array<{
          name: string;
          data: string;
      }>;
      chartRelId: string;
      chartIndex: number;
      /** @deprecated Throws error — use .shape instead. */
      toString(): string;
  }
  interface PresentationWithCharts {
      slides: unknown[];
      _chartIndex?: number;
      _charts?: Array<{
          index: number;
          slideIndex: number;
          relId: string;
          chartPath: string;
      }>;
      _chartEntries?: Array<{
          name: string;
          data: string;
      }>;
  }
  /**
   * Embed a chart into a presentation. Returns the shape XML fragment for the
   * slide body + the ZIP entries for the chart parts.
   *
   * POSITIONING: Pass position via the third argument, OR set x/y/w/h on the chart
   * object itself. The pos argument takes precedence if provided.
   *
   * Usage:
   *   const chart = barChart({...});
   *   const { shapeXml, zipEntries } = embedChart(pres, chart, {x:1, y:1.5, w:10, h:5});
   *   customSlide(pres, { shapes: shapeXml });
   *   // Add zipEntries to pres before build, or merge into final entries
   *
   * @param pres - Presentation builder (to track chart index)
   * @param chart - Chart object from barChart/pieChart/lineChart
   * @param pos - Position {x?, y?, w?, h?} in inches. Falls back to chart.x/y/w/h if not specified.
   * @returns Embed result with shapeXml and zipEntries
   */
  export declare function embedChart(pres: PresentationWithCharts, chart: ChartResult, pos: ChartPosition): EmbedChartResult;
  export {};
}

declare module "ha:pptx-tables" {
  /**
   * Predefined table styles for common use cases.
   * Use with table({...opts, style: TABLE_STYLES.dark})
   */
  export declare const TABLE_STYLES: {
      /** Default blue header with light body */
      readonly default: {
          readonly headerBg: "2196F3";
          readonly headerColor: "FFFFFF";
          readonly textColor: "333333";
          readonly borderColor: "CCCCCC";
          readonly altRows: true;
          readonly altRowColor: "F5F5F5";
      };
      /** Dark/brutalist: near-black with white text, red header */
      readonly dark: {
          readonly headerBg: "CC0000";
          readonly headerColor: "FFFFFF";
          readonly textColor: "E6EDF3";
          readonly borderColor: "333333";
          readonly altRows: true;
          readonly altRowColor: "1A1A1A";
      };
      /** Minimal: no alternating rows, subtle borders */
      readonly minimal: {
          readonly headerBg: "F5F5F5";
          readonly headerColor: "333333";
          readonly textColor: "333333";
          readonly borderColor: "E0E0E0";
          readonly altRows: false;
      };
      /** Corporate: navy header, professional look */
      readonly corporate: {
          readonly headerBg: "1B2A4A";
          readonly headerColor: "FFFFFF";
          readonly textColor: "333333";
          readonly borderColor: "CCCCCC";
          readonly altRows: true;
          readonly altRowColor: "F8F9FA";
      };
      /** Emerald: green header */
      readonly emerald: {
          readonly headerBg: "10B981";
          readonly headerColor: "FFFFFF";
          readonly textColor: "333333";
          readonly borderColor: "CCCCCC";
          readonly altRows: true;
          readonly altRowColor: "ECFDF5";
      };
  };
  export interface TableStyle {
      /** Header row fill color */
      headerBg?: string;
      /** Header text color */
      headerColor?: string;
      /** Alternating row shading */
      altRows?: boolean;
      /** Alt row fill color (auto from theme if not set) */
      altRowColor?: string;
      /** Border color (auto from theme if not set) */
      borderColor?: string;
      /** Body font size */
      fontSize?: number;
      /** Header font size */
      headerFontSize?: number;
      /** Body text color (auto from theme if not set) */
      textColor?: string;
      /** Theme text color (alias for textColor) */
      themeTextColor?: string;
  }
  export interface TableOptions {
      /** X position in inches */
      x?: number;
      /** Y position in inches */
      y?: number;
      /** Width in inches */
      w?: number;
      /** Height in inches (auto-calculated from rows if omitted) */
      h?: number;
      /** Row height in inches (default: auto based on content, min 0.35") */
      rowHeight?: number;
      /** Column header texts */
      headers?: string[];
      /** Data rows (array of arrays) */
      rows?: (string | number)[][];
      /** Theme object from pres.theme (auto-selects colors for dark/light) */
      theme?: Theme | {
          bg?: string;
          fg?: string;
      };
      /** Style overrides (take precedence over theme) */
      style?: TableStyle;
  }
  /**
   * Create a styled table as a PPTX shape XML fragment.
   *
   * NOTE: Tables do NOT perform WCAG contrast validation like pptx shapes do.
   * All colors are used as-is. The forceAllColors flag from createPresentation()
   * has no effect on tables (they already accept any color combination).
   *
   * @param opts.x - X position in inches (default: 0.5)
   * @param opts.y - Y position in inches (default: 1.5)
   * @param opts.w - Table width in inches (default: 12.333)
   * @param opts.headers - Column header labels (string array)
   * @param opts.rows - Data rows (2D array)
   * @param opts.theme - Theme name to use for colors (default: uses preset)
   * @param opts.style.headerBg - Header row background color (hex, no #)
   * @param opts.style.headerColor - Header text color (hex, no #)
   * @param opts.style.textColor - Data cell text color (hex, no #)
   * @param opts.style.altRows - Enable alternating row colors (default: true)
   * @param opts.style.altRowColor - Alternating row background color (hex, no #)
   * @param opts.style.borderColor - Cell border color (hex, no #)
   * @param opts.style.fontSize - Data cell font size in pt
   * @param opts.style.headerFontSize - Header font size in pt
   * @returns Shape XML fragment for use in slide body
   */
  export declare function table(opts: TableOptions): ShapeFragment;
  export interface KVItem {
      key: string;
      value: string;
  }
  export interface KVTableOptions {
      /** X position in inches */
      x?: number;
      /** Y position in inches */
      y?: number;
      /** Width in inches */
      w?: number;
      /** Key-value pairs */
      items: KVItem[];
      /** Theme object from pres.theme (auto-selects colors for dark/light) */
      theme?: Theme | {
          bg?: string;
          fg?: string;
      };
      /** Style overrides */
      style?: TableStyle;
  }
  /**
   * Create a key-value pair list as a simple two-column table.
   * Nice for specs, metadata, config displays.
   *
   * @param opts - KV table options: { x?, y?, w?, items: Array<{key, value}>, theme?, style? }
   * @returns Shape XML fragment
   */
  export declare function kvTable(opts: KVTableOptions): ShapeFragment;
  export interface ComparisonOption {
      /** Column header name */
      name: string;
      /** One boolean per feature */
      values: boolean[];
  }
  export interface ComparisonTableOptions {
      /** X position in inches */
      x?: number;
      /** Y position in inches */
      y?: number;
      /** Width in inches */
      w?: number;
      /** Feature/criterion names (row labels). REQUIRED, non-empty. */
      features: string[];
      /** Options to compare. REQUIRED, non-empty. */
      options: ComparisonOption[];
      /** Theme object from pres.theme (auto-selects colors for dark/light) */
      theme?: Theme | {
          bg?: string;
          fg?: string;
      };
      /** Style overrides (headerBg, headerColor, fontSize, etc.) */
      style?: TableStyle;
  }
  /**
   * Create a comparison table with feature rows and ✓/✗ columns.
   * Great for pros/cons, feature comparisons, or option evaluation.
   *
   * @example
   * // Compare three database options across features
   * const tbl = comparisonTable({
   *   x: 0.5, y: 1.5, w: 11,
   *   features: ['ACID compliance', 'Horizontal scaling', 'JSON support', 'Free tier'],
   *   options: [
   *     { name: 'PostgreSQL', values: [true, false, true, true] },
   *     { name: 'MongoDB', values: [false, true, true, true] },
   *     { name: 'DynamoDB', values: [true, true, true, false] }
   *   ],
   *   theme: pres.theme,  // Auto-select colors for dark/light background
   *   style: { headerBg: '1A3A5C', headerColor: 'E6EDF3' }
   * });
   *
   * @param opts - REQUIRED: { features: string[], options: Array<{name: string, values: boolean[]}> }. Optional: x?, y?, w?, theme?, style?
   * @returns Shape XML fragment
   */
  export declare function comparisonTable(opts: ComparisonTableOptions): ShapeFragment;
  export interface TimelineItem {
      /** Phase/milestone label */
      label: string;
      /** Optional description */
      description?: string;
      /** Optional custom color */
      color?: string;
  }
  export interface TimelineOptions {
      /** X position in inches */
      x?: number;
      /** Y position in inches */
      y?: number;
      /** Width in inches */
      w?: number;
      /** Timeline items */
      items: TimelineItem[];
      /** Theme object from pres.theme (auto-selects colors for dark/light) */
      theme?: Theme | {
          bg?: string;
          fg?: string;
      };
      /** Style overrides */
      style?: TableStyle;
  }
  /**
   * Create a horizontal timeline/roadmap display.
   * Shows phases or milestones as a sequence of colored boxes.
   *
   * @param opts - Timeline options: { x?, y?, w?, items: Array<{label, description?, color?}>, theme?, style? }
   * @returns Shape XML fragment (uses table layout)
   */
  export declare function timeline(opts: TimelineOptions): ShapeFragment;
}

declare module "ha:pptx" {
  export interface GradientSpec {
      color1: string;
      color2: string;
      angle?: number;
  }
  export interface SlideOptions {
      background?: string | GradientSpec;
      transition?: "fade" | "push" | "wipe" | "split" | "cover" | "reveal" | "curtains" | "dissolve" | "zoom" | "fly" | "wheel" | "random" | "none";
      transitionDuration?: number;
      notes?: string;
  }
  /** Internal slide data structure */
  interface SlideData {
      bg: string;
      shapes: string;
      transition?: string | null;
      transitionDuration?: number;
      notes?: string | null;
  }
  /** Options for createPresentation */
  export interface CreatePresentationOptions {
      theme?: string;
      forceAllColors?: boolean;
      defaultBackground?: string | GradientSpec;
      /**
       * Default text color for all text elements (hex, no #).
       * When set, this color is used for textBox, bulletList, numberedList, statBox,
       * and other text-containing shapes unless explicitly overridden.
       * Useful for dark themes where most text should be white.
       * @example 'FFFFFF' for white text on dark backgrounds
       */
      defaultTextColor?: string;
  }
  export interface SerializedPresentation {
      _version?: number;
      themeName: string;
      defaultBackground?: string | GradientSpec;
      forceAllColors: boolean;
      defaultTextColor?: string;
      slides: SlideData[];
      images: ImageEntry[];
      imageIndex: number;
      charts: ChartEntry[];
      chartEntries: Array<{
          name: string;
          data: string;
      }>;
      shapeIdCounter?: number;
  }
  export interface Presentation {
      theme: Theme;
      slideCount: number;
      addBody(shapes: ShapeFragment | ShapeFragment[], opts?: SlideOptions): void;
      build(): Array<{
          name: string;
          data: string | Uint8Array;
      }>;
      buildZip(): Uint8Array;
      serialize(): SerializedPresentation;
      /** Save presentation to shared-state under the given key. Shorthand for sharedState.set(key, pres.serialize()). */
      save(key: string): void;
      _chartEntries: Array<{
          name: string;
          data: string;
      }>;
  }
  /** Internal presentation type with all mutable fields for shape functions */
  interface PresentationInternal {
      theme: Theme;
      slides?: SlideData[];
      _links?: Array<{
          slideIndex: number;
          relId: string;
          url: string;
      }>;
      _images?: ImageEntry[];
      _imageIndex?: number;
      _charts?: ChartEntry[];
      _chartEntries?: Array<{
          name: string;
          data: string;
      }>;
  }
  /** Internal image entry */
  interface ImageEntry {
      id: string;
      relId: string;
      data: Uint8Array;
      format: string;
      slideIndex: number;
      index: number;
      mediaPath: string;
      contentType: string;
  }
  /** Type alias for presentation builder (returned by createPresentation) */
  type Pres = any;
  /** Internal chart entry */
  interface ChartEntry {
      name: string;
      data: string;
      slideIndex?: number;
      chartPath?: string;
      /** Chart index number (e.g., 1 for chart1.xml) */
      index?: number;
      /** Relationship ID (e.g., rIdChart1) for slide rels */
      relId?: string;
  }
  export interface LayoutRect {
      x: number;
      y: number;
      w: number;
      h: number;
  }
  /** Text effect options for glow and shadow */
  export interface TextEffectOptions {
      /**
       * Glow effect around text. Color is hex (no #).
       * @example { color: 'FF0000', radius: 5 } // Red glow, 5pt radius
       */
      glow?: {
          color: string;
          radius?: number;
      };
      /**
       * Drop shadow effect. Color is hex (no #).
       * @example { color: '000000', blur: 4, offset: 2, angle: 45 }
       */
      shadow?: {
          color: string;
          blur?: number;
          offset?: number;
          angle?: number;
          opacity?: number;
      };
  }
  /** Internal interface with _theme for shape functions */
  interface InternalShapeOpts {
      _theme?: Theme | null;
      _skipBoundsCheck?: boolean;
  }
  export interface TextBoxOptions extends InternalShapeOpts, TextEffectOptions {
      x: number;
      y: number;
      w: number;
      h: number;
      text: string | string[];
      fontSize?: number;
      color?: string;
      forceColor?: boolean;
      fontFamily?: string;
      bold?: boolean;
      italic?: boolean;
      align?: string;
      valign?: string;
      background?: string;
      lineSpacing?: number;
      _skipContrastCheck?: boolean;
      wordWrap?: boolean;
      padding?: number;
      /** Auto-scale fontSize to fit text within the shape. Default: false. */
      autoFit?: boolean;
      /** Skip bounds validation (for internal use). */
      _skipBoundsCheck?: boolean;
  }
  export interface RectOptions extends InternalShapeOpts {
      x?: number;
      y?: number;
      w?: number;
      h?: number;
      fill?: string;
      text?: string;
      fontSize?: number;
      color?: string;
      forceColor?: boolean;
      bold?: boolean;
      cornerRadius?: number;
      borderColor?: string;
      borderWidth?: number;
      align?: string;
      valign?: string;
      opacity?: number;
      /** Skip bounds validation (for internal use). */
      _skipBoundsCheck?: boolean;
  }
  export interface BulletListOptions extends InternalShapeOpts {
      x?: number;
      y?: number;
      w?: number;
      h?: number;
      items?: (string | {
          text: string;
          bold?: boolean;
          color?: string;
      })[];
      fontSize?: number;
      color?: string;
      bulletColor?: string;
      lineSpacing?: number;
      valign?: string;
  }
  export interface NumberedListOptions extends InternalShapeOpts {
      x?: number;
      y?: number;
      w?: number;
      h?: number;
      items?: string[];
      fontSize?: number;
      color?: string;
      lineSpacing?: number;
      startAt?: number;
      valign?: string;
  }
  export interface StatBoxOptions extends InternalShapeOpts {
      x?: number;
      y?: number;
      w?: number;
      h?: number;
      value?: string;
      label?: string;
      valueSize?: number;
      labelSize?: number;
      background?: string;
      valueColor?: string;
      labelColor?: string;
      forceColor?: boolean;
      cornerRadius?: number;
  }
  export interface LineOptions extends InternalShapeOpts {
      x1?: number;
      y1?: number;
      x2?: number;
      y2?: number;
      color?: string;
      width?: number;
      dash?: string;
  }
  export interface ArrowOptions extends LineOptions {
      headType?: string;
      headSize?: string;
      bothEnds?: boolean;
  }
  export interface CircleOptions extends InternalShapeOpts {
      x?: number;
      y?: number;
      w?: number;
      h?: number;
      fill?: string;
      text?: string;
      fontSize?: number;
      color?: string;
      forceColor?: boolean;
      borderColor?: string;
      borderWidth?: number;
      bold?: boolean;
  }
  export interface CalloutOptions {
      x: number;
      y: number;
      w: number;
      h: number;
      text: string;
      accentColor?: string;
      background?: string;
      fontSize?: number;
      color?: string;
      forceColor?: boolean;
  }
  export interface IconOptions extends InternalShapeOpts {
      x?: number;
      y?: number;
      w?: number;
      h?: number;
      shape?: string;
      fill?: string;
      text?: string;
      fontSize?: number;
      color?: string;
  }
  /** Options for measureText function */
  export interface MeasureTextOptions {
      /** Text to measure (string or array of strings) */
      text: string | string[];
      /** Font size in points (default: 18) */
      fontSize?: number;
      /** Line height multiplier or absolute line height in points (default: fontSize * 1.2) */
      lineSpacing?: number;
      /** Width constraint in inches for wrapping estimation (optional) */
      maxWidth?: number;
      /** Average character width as fraction of font size (default: 0.5) */
      charWidthFactor?: number;
  }
  /** Result from measureText function */
  export interface TextMeasurement {
      /** Estimated width in inches (based on longest line) */
      width: number;
      /** Estimated height in inches */
      height: number;
      /** Number of lines */
      lines: number;
      /** Estimated character count of longest line */
      maxLineChars: number;
      /** Total character count */
      totalChars: number;
      /** Whether text would likely overflow given width constraint (if maxWidth provided) */
      wouldWrap: boolean;
  }
  /** Options for cloneSlide function */
  export interface CloneSlideOptions {
      /** Index of slide to clone (0-based, default: last slide) */
      sourceIndex?: number;
      /** Transition type for the cloned slide */
      transition?: "fade" | "push" | "wipe" | "split" | "cover" | "reveal" | "curtains" | "dissolve" | "zoom" | "fly" | "wheel" | "random" | "none";
      /** Transition duration in ms */
      transitionDuration?: number;
      /** Speaker notes for cloned slide (overrides original) */
      notes?: string;
  }
  /** Animation entrance types */
  export type AnimationEntrance = "appear" | "fadeIn" | "flyInLeft" | "flyInRight" | "flyInTop" | "flyInBottom" | "zoomIn" | "bounceIn" | "wipeRight" | "wipeDown";
  /** Animation emphasis types */
  export type AnimationEmphasis = "pulse" | "spin" | "grow" | "shrink" | "colorPulse" | "teeter";
  /** Animation exit types */
  export type AnimationExit = "disappear" | "fadeOut" | "flyOutLeft" | "flyOutRight" | "flyOutTop" | "flyOutBottom" | "zoomOut";
  /** Animation options for shapes */
  export interface AnimationOptions {
      /** Entrance animation */
      entrance?: AnimationEntrance;
      /** Emphasis animation (plays after entrance) */
      emphasis?: AnimationEmphasis;
      /** Exit animation */
      exit?: AnimationExit;
      /** Delay before animation starts in ms (default: 0) */
      delay?: number;
      /** Duration of animation in ms (default: 500) */
      duration?: number;
      /** Trigger: onClick or withPrevious (default: onClick) */
      trigger?: "onClick" | "withPrevious" | "afterPrevious";
  }
  /** Options for staggered animation sequences */
  export interface StaggeredAnimationOptions {
      /** Animation to apply to each shape */
      animation: AnimationOptions;
      /** Delay between each shape in ms (default: 200) */
      staggerDelay?: number;
      /** Whether all shapes trigger together or sequentially (default: 'sequential') */
      mode?: "sequential" | "simultaneous";
  }
  export interface CodeBlockOptions {
      x: number;
      y: number;
      w: number;
      h: number;
      code: string;
      title?: string;
      lineNumbers?: boolean;
      fontSize?: number;
      background?: string;
      color?: string;
      fontFamily?: string;
      titleColor?: string;
      cornerRadius?: number;
  }
  export interface ImagePlaceholderOptions extends InternalShapeOpts {
      x?: number;
      y?: number;
      w?: number;
      h?: number;
      label?: string;
      fill?: string;
      color?: string;
  }
  export interface SvgPathOptions extends InternalShapeOpts {
      x?: number;
      y?: number;
      w?: number;
      h?: number;
      d: string;
      viewBox?: {
          x?: number;
          y?: number;
          w: number;
          h: number;
      };
      fill?: string;
      stroke?: string;
      strokeWidth?: number;
  }
  export interface RichTextRun {
      text: string;
      fontSize?: number;
      color?: string;
      bold?: boolean;
      italic?: boolean;
      fontFamily?: string;
  }
  export interface RichTextOptions extends InternalShapeOpts {
      x?: number;
      y?: number;
      w?: number;
      h?: number;
      paragraphs?: RichTextRun[][];
      align?: string;
      valign?: string;
      background?: string;
  }
  export interface HyperlinkOptions extends InternalShapeOpts {
      x?: number;
      y?: number;
      w?: number;
      h?: number;
      text?: string;
      url: string;
      fontSize?: number;
      color?: string;
      underline?: boolean;
  }
  export interface EmbedImageOptions extends InternalShapeOpts {
      x?: number;
      y?: number;
      w?: number;
      h?: number;
      data: Uint8Array;
      format?: string;
      name?: string;
      /**
       * How to fit the image within the specified bounds (w × h).
       * - 'stretch' (default): Stretch image to fill bounds exactly (may distort)
       * - 'contain': Scale to fit within bounds, maintaining aspect ratio (may letterbox/pillarbox)
       * - 'cover': Scale to fill bounds, maintaining aspect ratio (may crop edges)
       *
       * Note: 'contain' and 'cover' require PNG/JPEG/GIF/BMP format to read dimensions.
       * SVG and unknown formats fall back to 'stretch'.
       */
      fit?: "stretch" | "contain" | "cover";
  }
  export interface LayoutColumnsOptions {
      margin?: number;
      gap?: number;
      y?: number;
      h?: number;
  }
  export interface LayoutGridOptions {
      cols?: number;
      margin?: number;
      gap?: number;
      gapX?: number;
      gapY?: number;
      y?: number;
      maxH?: number;
  }
  export interface OverlayOptions {
      opacity?: number;
      color?: string;
      x?: number;
      y?: number;
      w?: number;
      h?: number;
  }
  export interface GradientOverlayOptions {
      /** Start color (hex, default '000000' black) */
      color1?: string;
      /** End color (hex, default '000000' black) */
      color2?: string;
      /** Start opacity (0-1, default 0.8) */
      fromOpacity?: number;
      /** End opacity (0-1, default 0 = transparent) */
      toOpacity?: number;
      /** Gradient angle in degrees (0=right, 90=down, 180=left, 270=up, default 0 = left to right) */
      angle?: number;
      /** X position in inches (default 0) */
      x?: number;
      /** Y position in inches (default 0) */
      y?: number;
      /** Width in inches (default full slide) */
      w?: number;
      /** Height in inches (default full slide) */
      h?: number;
  }
  export interface TitleSlideOptions {
      title: string;
      subtitle?: string;
      background?: string | GradientSpec;
      transition?: string;
      notes?: string;
  }
  export interface SectionSlideOptions {
      title: string;
      subtitle?: string;
      background?: string | GradientSpec;
      transition?: string;
      notes?: string;
  }
  export interface ContentSlideOptions {
      title: string;
      /** Bullet points. Array of strings or newline-delimited string. */
      items?: string[] | string;
      background?: string | GradientSpec;
      transition?: string;
      notes?: string;
  }
  export interface TwoColumnSlideOptions {
      title: string;
      /** Left column bullet points. Array of strings or newline-delimited string. */
      leftItems?: string[] | string;
      /** Right column bullet points. Array of strings or newline-delimited string. */
      rightItems?: string[] | string;
      background?: string | GradientSpec;
      transition?: string;
      notes?: string;
  }
  export interface ComparisonSlideOptions {
      title: string;
      leftTitle?: string;
      rightTitle?: string;
      /** Left column items. Array of strings or newline-delimited string. */
      leftItems?: string[] | string;
      /** Right column items. Array of strings or newline-delimited string. */
      rightItems?: string[] | string;
      background?: string | GradientSpec;
      transition?: string;
      notes?: string;
  }
  export interface ChartObject {
      type: "chart";
      /** @internal Raw chart XML — use chartSlide() or embedChart() to embed */
      _chartXml: string;
  }
  export interface ChartSlideOptions {
      title: string;
      chart: ChartObject;
      background?: string | GradientSpec;
      transition?: string;
      notes?: string;
      chartPosition?: {
          x: number;
          y: number;
          w: number;
          h: number;
      };
      /** Additional text items below the chart. Array of strings or newline-delimited string. */
      extraItems?: string[] | string;
  }
  export interface CustomSlideOptions {
      /** Array of ShapeFragment objects from shape builders (textBox, rect, table, etc.). REQUIRED. */
      shapes: ShapeFragment | ShapeFragment[];
      background?: string | GradientSpec;
      transition?: string;
      transitionDuration?: number;
      notes?: string;
  }
  export interface HeroSlideOptions {
      image: Uint8Array;
      imageFormat?: string;
      title?: string;
      subtitle?: string;
      overlayOpacity?: number;
      overlayColor?: string;
      titleSize?: number;
      subtitleSize?: number;
      align?: string;
      transition?: string;
      notes?: string;
  }
  export interface StatGridSlideOptions {
      title?: string;
      stats: Array<{
          value: string;
          label: string;
      }>;
      background?: string | GradientSpec;
      transition?: string;
      notes?: string;
      valueSize?: number;
      labelSize?: number;
      accentColor?: string;
  }
  export interface ImageGridSlideOptions {
      title?: string;
      images: Uint8Array[] | Array<{
          data: Uint8Array;
          format?: string;
          caption?: string;
      }>;
      imageFormat?: string;
      format?: string;
      gap?: number;
      background?: string | GradientSpec;
      transition?: string;
      notes?: string;
  }
  export interface QuoteSlideOptions {
      quote: string;
      author?: string;
      role?: string;
      quoteSize?: number;
      background?: string | GradientSpec;
      transition?: string;
      notes?: string;
  }
  /** Options for bigNumberSlide - keynote-style dramatic number display */
  export interface BigNumberSlideOptions {
      /** The big number to display (e.g., "2.6", "$99,990", "350"). REQUIRED. */
      number: string;
      /** Unit or label next to the number (e.g., "SECONDS", "MILES", "HP") */
      unit?: string;
      /** Smaller footnote below (e.g., "0-60 MPH", "Range") */
      label?: string;
      /** Number font size (default: 160) */
      numberSize?: number;
      /** Unit font size (default: 48) */
      unitSize?: number;
      /** Label font size (default: 24) */
      labelSize?: number;
      /** Number color (default: theme.accent1) */
      numberColor?: string;
      /** Unit color (default: same as number) */
      unitColor?: string;
      /** Label color (default: theme.subtle) */
      labelColor?: string;
      /** Slide background color */
      background?: string | GradientSpec;
      /** Slide transition */
      transition?: string;
      /** Speaker notes */
      notes?: string;
  }
  /** Architecture diagram component */
  export interface ArchitectureComponent {
      /** Component label */
      label: string;
      /** Optional description */
      description?: string;
      /** Fill color (default: theme.accent1) */
      color?: string;
      /** Icon shape (from icon() presets) */
      icon?: string;
  }
  export interface ArchitectureDiagramSlideOptions {
      /** Slide title. REQUIRED. */
      title: string;
      /** Components to display (max 6 for best layout) */
      components: ArchitectureComponent[];
      /** Layout: 'horizontal' (left-to-right) or 'layered' (top-to-bottom) */
      layout?: "horizontal" | "layered";
      /** Show arrows between components (default: true) */
      showArrows?: boolean;
      /** Slide background */
      background?: string | GradientSpec;
      /** Slide transition */
      transition?: string;
      /** Speaker notes */
      notes?: string;
  }
  export interface CodeWalkthroughSlideOptions {
      /** Slide title. REQUIRED. */
      title: string;
      /** Code to display. REQUIRED. */
      code: string;
      /** Explanation bullets shown beside the code */
      bullets?: string[];
      /** Code language (for display, no syntax highlighting) */
      language?: string;
      /** Code font size (default: 11) */
      codeFontSize?: number;
      /** Slide background */
      background?: string | GradientSpec;
      /** Slide transition */
      transition?: string;
      /** Speaker notes */
      notes?: string;
  }
  export interface BeforeAfterSlideOptions {
      /** Slide title. REQUIRED. */
      title: string;
      /** "Before" column title (default: "Before") */
      beforeTitle?: string;
      /** "After" column title (default: "After") */
      afterTitle?: string;
      /** Before content (bullet points or description) */
      beforeContent: string[] | string;
      /** After content (bullet points or description) */
      afterContent: string[] | string;
      /** Before column accent color (default: red/warning) */
      beforeColor?: string;
      /** After column accent color (default: green/success) */
      afterColor?: string;
      /** Slide background */
      background?: string | GradientSpec;
      /** Slide transition */
      transition?: string;
      /** Speaker notes */
      notes?: string;
  }
  /** Process step definition */
  export interface ProcessStep {
      /** Step label/title */
      label: string;
      /** Optional description */
      description?: string;
      /** Optional icon shape */
      icon?: string;
      /** Step color (default: cycles through accent colors) */
      color?: string;
  }
  export interface ProcessFlowSlideOptions {
      /** Slide title. REQUIRED. */
      title: string;
      /** Process steps (max 6 for best layout). REQUIRED. */
      steps: ProcessStep[];
      /** Layout: 'horizontal' or 'vertical' (default: horizontal) */
      layout?: "horizontal" | "vertical";
      /** Show step numbers (default: true) */
      showNumbers?: boolean;
      /** Slide background */
      background?: string | GradientSpec;
      /** Slide transition */
      transition?: string;
      /** Speaker notes */
      notes?: string;
  }
  export interface SlideNumberOptions {
      x?: number;
      y?: number;
      fontSize?: number;
      startAt?: number;
  }
  export interface FooterOptions {
      text: string;
      fontSize?: number;
  }
  export { type Theme };
  export { type ShapeFragment, isShapeFragment, fragmentsToXml };
  export { table, kvTable, comparisonTable, timeline, TABLE_STYLES, } from "ha:pptx-tables";
  export { contrastRatio };
  export { getThemeNames };
  export { inches, fontSize } from "ha:ooxml-core";
  /**
   * Create a solid fill XML element.
   * Use for shape fills or customSlide({ background }) backgrounds.
   * @param {string} color - Hex color (6 digits, no #)
   * @param {number} [opacity] - Opacity from 0 (transparent) to 1 (opaque). Omit for fully opaque.
   * @returns {string} Solid fill XML
   */
  export declare function solidFill(color: string, opacity?: number): string;
  /**
   * Create a positioned text box element.
   *
   * _HINTS:
   * - Use autoFit: true when text length is variable/unknown to auto-scale fontSize
   * - If you get overflow errors, either increase h (height) or enable autoFit
   * - Bounds are validated: x+w must be ≤13.333", y+h must be ≤7.5"
   *
   * @param {Object} opts
   * @param {number} opts.x - X position in inches
   * @param {number} opts.y - Y position in inches
   * @param {number} opts.w - Width in inches
   * @param {number} opts.h - Height in inches
   * @param {string|string[]} opts.text - Text content (string or array of paragraphs)
   * @param {number} [opts.fontSize=18] - Font size in points
   * @param {string} [opts.color] - Text color (hex). OMIT to auto-select a readable colour from the theme. Do NOT hardcode — use theme palette values only.
   * @param {boolean} [opts.forceColor] - Set true to bypass WCAG contrast validation for color. Use when you KNOW the background and want to override auto-selection.
   * @param {string} [opts.fontFamily] - Font family
   * @param {boolean} [opts.bold] - Bold text
   * @param {boolean} [opts.italic] - Italic text
   * @param {string} [opts.align='l'] - Alignment: l, ctr, r
   * @param {string} [opts.valign='t'] - Vertical alignment: t, middle, bottom
   * @param {string} [opts.background] - Fill color (hex)
   * @param {number} [opts.lineSpacing] - Line spacing in points
   * @param {boolean} [opts.autoFit] - Auto-scale fontSize to fit text in shape. Use when text length is variable.
   * @returns {ShapeFragment} Branded shape fragment
   */
  export declare function textBox(opts: TextBoxOptions): ShapeFragment;
  /**
   * Create a colored rectangle with optional text.
   * @param {Object} opts
   * @param {number} opts.x - X position in inches
   * @param {number} opts.y - Y position in inches
   * @param {number} opts.w - Width in inches
   * @param {number} opts.h - Height in inches
   * @param {string} opts.fill - Fill color (hex)
   * @param {number} [opts.opacity] - Fill opacity (0=transparent, 1=opaque). Omit for fully opaque.
   * @param {string} [opts.text] - Optional text overlay
   * @param {number} [opts.fontSize=14] - Font size
   * @param {string} [opts.color] - Text color (hex). OMIT to auto-select a readable colour against the fill.
   * @param {boolean} [opts.forceColor] - Set true to bypass WCAG contrast validation for color.
   * @param {number} [opts.cornerRadius] - Corner radius in points
   * @param {string} [opts.borderColor] - Border color
   * @param {number} [opts.borderWidth=1] - Border width in points
   * @returns {ShapeFragment} Branded shape fragment
   */
  export declare function rect(opts: RectOptions): ShapeFragment;
  /**
   * Create a bulleted list.
   * @param {Object} opts
   * @param {number} opts.x - X position in inches
   * @param {number} opts.y - Y position in inches
   * @param {number} opts.w - Width in inches
   * @param {number} opts.h - Height in inches
   * @param {string[]} opts.items - List items
   * @param {number} [opts.fontSize=16] - Font size
   * @param {string} [opts.color] - Text color
   * @param {string} [opts.bulletColor] - Bullet color
   * @param {number} [opts.lineSpacing=24] - Line spacing
   * @returns {ShapeFragment} Branded shape fragment
   */
  export declare function bulletList(opts: BulletListOptions): ShapeFragment;
  /**
   * Create a numbered list.
   * @param {Object} opts
   * @param {number} opts.x - X position in inches
   * @param {number} opts.y - Y position in inches
   * @param {number} opts.w - Width in inches
   * @param {number} opts.h - Height in inches
   * @param {string[]} opts.items - List items
   * @param {number} [opts.fontSize=16] - Font size
   * @param {string} [opts.color] - Text color
   * @param {number} [opts.lineSpacing=24] - Line spacing
   * @param {number} [opts.startAt=1] - Starting number
   * @returns {ShapeFragment} Branded shape fragment
   */
  export declare function numberedList(opts: NumberedListOptions): ShapeFragment;
  /**
   * Create an image placeholder (colored rect with label).
   * Use this until binary image embedding is supported.
   * @param {Object} opts
   * @param {number} opts.x - X position in inches
   * @param {number} opts.y - Y position in inches
   * @param {number} opts.w - Width in inches
   * @param {number} opts.h - Height in inches
   * @param {string} [opts.label='Image'] - Placeholder label
   * @param {string} [opts.fill='3D4450'] - Background color (dark gray)
   * @param {string} [opts.color='B0B8C0'] - Label color (light gray, passes WCAG AA on 3D4450)
   * @returns {ShapeFragment} Branded shape fragment
   */
  export declare function imagePlaceholder(opts: ImagePlaceholderOptions): ShapeFragment;
  /**
   * Create a big metric display (number + label stacked).
   * @param {Object} opts
   * @param {number} opts.x - X position in inches
   * @param {number} opts.y - Y position in inches
   * @param {number} opts.w - Width in inches
   * @param {number} opts.h - Height in inches
   * @param {string} opts.value - Big number/text to display
   * @param {string} opts.label - Label beneath the value
   * @param {number} [opts.valueSize=36] - Value font size
   * @param {string} [opts.valueColor] - Value text color (hex). OMIT to auto-select against background.
   * @param {number} [opts.labelSize=14] - Label font size
   * @param {string} [opts.labelColor] - Label text color (hex). OMIT to auto-select against background.
   * @param {string} [opts.background] - Background fill
   * @param {boolean} [opts.forceColor] - Set true to bypass WCAG contrast validation for valueColor/labelColor.
   * @returns {ShapeFragment} Branded shape fragment
   */
  export declare function statBox(opts: StatBoxOptions): ShapeFragment;
  /**
   * Create a line between two points.
   * @param {Object} opts
   * @param {number} opts.x1 - Start X in inches
   * @param {number} opts.y1 - Start Y in inches
   * @param {number} opts.x2 - End X in inches
   * @param {number} opts.y2 - End Y in inches
   * @param {string} [opts.color='666666'] - Line color (hex)
   * @param {number} [opts.width=1.5] - Line width in points
   * @param {string} [opts.dash] - Dash style: 'solid', 'dash', 'dot', 'dashDot'
   * @returns {ShapeFragment} Branded shape fragment
   */
  export declare function line(opts: LineOptions): ShapeFragment;
  /**
   * Create an arrow (line with arrowhead) between two points.
   * @param {Object} opts
   * @param {number} opts.x1 - Start X in inches
   * @param {number} opts.y1 - Start Y in inches
   * @param {number} opts.x2 - End X in inches (arrowhead end)
   * @param {number} opts.y2 - End Y in inches (arrowhead end)
   * @param {string} [opts.color='666666'] - Arrow color (hex)
   * @param {number} [opts.width=1.5] - Line width in points
   * @param {string} [opts.headType='triangle'] - Arrowhead: 'triangle', 'stealth', 'diamond', 'oval', 'arrow'
   * @param {boolean} [opts.bothEnds=false] - Arrowhead on both ends
   * @param {string} [opts.dash] - Dash style: 'solid', 'dash', 'dot', 'dashDot'
   * @returns {ShapeFragment} Branded shape fragment
   */
  export declare function arrow(opts: ArrowOptions): ShapeFragment;
  /**
   * Create a circle or ellipse shape.
   * @param {Object} opts
   * @param {number} opts.x - Center X in inches
   * @param {number} opts.y - Center Y in inches
   * @param {number} opts.w - Width in inches
   * @param {number} opts.h - Height in inches (same as w for circle)
   * @param {string} [opts.fill] - Fill color (hex)
   * @param {string} [opts.text] - Text inside
   * @param {number} [opts.fontSize=14] - Text font size
   * @param {string} [opts.color='FFFFFF'] - Text color
   * @param {string} [opts.borderColor] - Border color
   * @param {number} [opts.borderWidth=1] - Border width in points
   * @returns {ShapeFragment} Branded shape fragment
   */
  export declare function circle(opts: CircleOptions): ShapeFragment;
  /**
   * Create a callout box — rounded rectangle with accent left border.
   * Good for highlighting insights, quotes, or key takeaways.
   * @param {Object} opts
   * @param {number} opts.x - X position in inches
   * @param {number} opts.y - Y position in inches
   * @param {number} opts.w - Width in inches
   * @param {number} opts.h - Height in inches
   * @param {string} opts.text - Callout text
   * @param {string} [opts.accentColor='2196F3'] - Left border accent color
   * @param {string} [opts.background='F5F5F5'] - Fill color
   * @param {number} [opts.fontSize=14] - Font size
   * @param {string} [opts.color] - Text color (hex). OMIT to auto-select a readable colour against the background. Do NOT hardcode.
   * @returns {ShapeFragment} Branded shape fragment
   */
  export declare function callout(opts: CalloutOptions): ShapeFragment;
  /**
   * Create a preset shape icon.
   *
   * @example
   * // Star icon with custom fill
   * const starIcon = icon({ x: 1, y: 1, w: 0.5, shape: 'star', fill: 'FFD700' });
   *
   * // Checkmark with text label
   * const checkIcon = icon({ x: 2, y: 1, w: 0.6, shape: 'checkmark', fill: '4CAF50', text: 'Done' });
   *
   * // Tech icon (SVG-based)
   * const layersIcon = icon({ x: 3, y: 1, w: 0.5, shape: 'layers', fill: '2196F3' });
   *
   * @param {Object} opts
   * @param {number} opts.x - X position in inches
   * @param {number} opts.y - Y position in inches
   * @param {number} opts.w - Width in inches
   * @param {number} [opts.h] - Height in inches (defaults to w for square)
   * @param {string} opts.shape - Shape name. REQUIRED. Categories:
   *   STATUS: 'checkmark'/'check', 'x'/'cross', 'warning', 'info'
   *   STARS: 'star', 'star4', 'star5', 'star6', 'star8', 'star10', 'star12', 'heart', 'lightning'/'lightningBolt'/'bolt', 'ribbon'
   *   GEOMETRIC: 'diamond', 'pentagon', 'hexagon', 'heptagon', 'octagon', 'decagon', 'dodecagon', 'triangle', 'circle', 'oval', 'donut', 'pie', 'arc', 'chord'
   *   ARROWS: 'right-arrow', 'left-arrow', 'up-arrow', 'down-arrow', 'curved-right/left/up/down', 'u-turn', 'circular-arrow'
   *   TECHNICAL: 'cloud', 'database'/'cylinder', 'cube', 'gear'/'cog'/'settings', 'gear9', 'funnel'/'filter', 'bevel', 'plaque'
   *   FLOWCHART: 'process', 'decision', 'document', 'data', 'terminal', 'connector', 'offpage', 'sort', 'merge', 'extract', 'delay', 'display'
   *   MATH: 'plus', 'minus', 'multiply', 'divide', 'equal', 'not-equal'
   *   CALLOUTS: 'callout-rect', 'callout-round', 'callout-oval', 'callout-cloud'
   *   ACTION BUTTONS: 'home', 'help', 'info-button', 'back', 'forward', 'beginning', 'end', 'return', 'doc', 'sound', 'movie', 'blank'
   *   TECH ICONS (SVG): 'layers'/'stack', 'lock'/'unlock', 'server', 'code', 'code-terminal', 'user'/'person', 'users'/'team',
   *     'folder', 'file', 'globe'/'network', 'key', 'shield-icon'/'security', 'zap', 'package'/'box',
   *     'cpu'/'chip', 'wifi', 'link', 'search', 'eye', 'clock', 'calendar', 'mail'/'email', 'bell'/'notification',
   *     'download', 'upload', 'refresh', 'api'/'plug'
   *   CHARTS (SVG): 'pie-chart', 'bar-chart', 'line-chart', 'chart', 'activity'/'pulse', 'trending-up', 'trending-down'
   * @param {string} [opts.fill='2196F3'] - Fill color (hex without #)
   * @param {string} [opts.text] - Optional text inside the shape
   * @param {number} [opts.fontSize=12] - Text font size
   * @param {string} [opts.color='FFFFFF'] - Text color
   * @returns {ShapeFragment} Branded shape fragment
   */
  export declare function icon(opts: IconOptions): ShapeFragment;
  /**
   * Create a shape from an SVG path string.
   * Enables custom icons, logos, and diagrams using standard SVG path data.
   *
   * @example
   * // Simple arrow shape from SVG path
   * const arrow = svgPath({
   *   x: 1, y: 1, w: 1, h: 1,
   *   d: 'M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8z',
   *   fill: '2196F3',
   *   viewBox: { w: 24, h: 24 }  // default 24x24 if omitted
   * });
   *
   * @example
   * // Database icon (Lucide)
   * const dbIcon = svgPath({
   *   x: 2, y: 2, w: 0.8, h: 0.8,
   *   d: 'M12 2C6.48 2 2 4.69 2 8v8c0 3.31 4.48 6 10 6s10-2.69 10-6V8c0-3.31-4.48-6-10-6z' +
   *      'M2 12c0 3.31 4.48 6 10 6s10-2.69 10-6',
   *   fill: '4CAF50'
   * });
   *
   * @param {Object} opts
   * @param {number} opts.x - X position in inches
   * @param {number} opts.y - Y position in inches
   * @param {number} opts.w - Width in inches
   * @param {number} [opts.h] - Height in inches (defaults to width for square)
   * @param {string} opts.d - SVG path data string (the 'd' attribute from <path>)
   * @param {Object} [opts.viewBox] - SVG viewBox dimensions (default { w: 24, h: 24 })
   * @param {number} [opts.viewBox.w=24] - ViewBox width
   * @param {number} [opts.viewBox.h=24] - ViewBox height
   * @param {string} [opts.fill] - Fill color (hex, e.g. '2196F3')
   * @param {string} [opts.stroke] - Stroke color (hex)
   * @param {number} [opts.strokeWidth=1] - Stroke width in points
   * @returns {ShapeFragment} Branded shape fragment
   */
  export declare function svgPath(opts: SvgPathOptions): ShapeFragment;
  /**
   * Create a gradient fill XML fragment for use in shapes.
   * Supports transparency for cinematic photo overlays (e.g., transparent-to-black).
   *
   * @param {string} color1 - Start color (hex)
   * @param {string} color2 - End color (hex)
   * @param {number} [angle=270] - Gradient angle in degrees (0=right, 90=down, 270=up)
   * @param {Object} [opts] - Optional settings
   * @param {number} [opts.opacity1=1] - Start opacity (0=transparent, 1=opaque)
   * @param {number} [opts.opacity2=1] - End opacity (0=transparent, 1=opaque)
   * @returns {string} Gradient fill XML (replaces solidFill in shape opts)
   *
   * @example
   * // Solid gradient (default)
   * gradientFill('000000', 'FFFFFF', 90)
   *
   * @example
   * // Transparent-to-opaque overlay for photos
   * gradientFill('000000', '000000', 270, { opacity1: 0, opacity2: 0.8 })
   */
  export declare function gradientFill(color1: string, color2: string, angle?: number, opts?: {
      opacity1?: number;
      opacity2?: number;
  }): string;
  /**
   * Convert markdown text to plain text suitable for speaker notes.
   * Strips formatting while preserving structure and readability.
   *
   * @example
   * // Convert README section to notes
   * const notes = markdownToNotes(`
   * ## Key Points
   * - **First point**: This is important
   * - *Second point*: Also relevant
   * - [Link text](https://example.com)
   *
   * > Quote from source
   *
   * \`\`\`javascript
   * const x = 1;
   * \`\`\`
   * `);
   * // Returns:
   * // "Key Points\n\n• First point: This is important\n• Second point: Also relevant..."
   *
   * @param {string} md - Markdown text to convert
   * @returns {string} Plain text for speaker notes
   */
  export declare function markdownToNotes(md: string): string;
  /**
   * Create a text box with mixed formatting (multiple runs per paragraph).
   * Each run can have different bold/italic/color/fontSize.
   *
   * @example
   * // Two paragraphs with mixed formatting
   * const rich = richText({
   *   x: 1, y: 2, w: 6, h: 1,
   *   paragraphs: [
   *     [
   *       { text: 'Important: ', bold: true, color: 'FF0000' },
   *       { text: 'This is the main point.' }
   *     ],
   *     [
   *       { text: 'Note: ', italic: true },
   *       { text: 'Additional details here.', fontSize: 10 }
   *     ]
   *   ]
   * });
   *
   * @param {Object} opts
   * @param {number} opts.x - X position in inches
   * @param {number} opts.y - Y position in inches
   * @param {number} opts.w - Width in inches
   * @param {number} opts.h - Height in inches
   * @param {Array<Array<Object>>} opts.paragraphs - Array of paragraphs. Each paragraph is an array of runs.
   *   Each run is an object with:
   *   - {string} text - The text content. REQUIRED.
   *   - {boolean} [bold] - Bold text
   *   - {boolean} [italic] - Italic text
   *   - {string} [color] - Hex color (e.g. 'FF0000')
   *   - {number} [fontSize] - Font size in points
   *   - {string} [fontFamily] - Font family name
   * @param {string} [opts.align='l'] - Paragraph alignment ('l', 'ctr', 'r')
   * @param {string} [opts.valign='t'] - Vertical alignment ('t', 'ctr', 'b')
   * @param {string} [opts.background] - Fill color (hex)
   * @returns {ShapeFragment} Branded shape fragment
   */
  export declare function richText(opts: RichTextOptions): ShapeFragment;
  /** Options for panel() composite shape */
  export interface PanelOptions {
      /** X position in inches */
      x: number;
      /** Y position in inches */
      y: number;
      /** Width in inches */
      w: number;
      /** Height in inches */
      h: number;
      /** Background fill color (hex, no #). Default: '1A1A1A' (dark gray) */
      fill?: string;
      /** Alias for fill (for convenience) */
      background?: string;
      /** Corner radius in points. Default: 8 */
      cornerRadius?: number;
      /** Panel title text (optional) */
      title?: string;
      /** Alias for title - simple text content (for convenience) */
      text?: string;
      /** Title font size. Default: 18 */
      titleSize?: number;
      /** Alias for titleSize (for convenience) */
      fontSize?: number;
      /** Title color (hex). Falls back to defaultTextColor or 'FFFFFF' */
      titleColor?: string;
      /** Alias for titleColor (for convenience) */
      color?: string;
      /** Title bold. Default: true */
      titleBold?: boolean;
      /** Body text (optional) - can be string or array of paragraphs */
      body?: string | string[];
      /** Body font size. Default: 12 */
      bodySize?: number;
      /** Body color (hex). Falls back to defaultTextColor or 'CCCCCC' */
      bodyColor?: string;
      /** Padding from panel edges in inches. Default: 0.2 */
      padding?: number;
      /** Gap between title and body in inches. Default: 0.15 */
      gap?: number;
  }
  /**
   * Create a panel with optional title and body text.
   * A panel is a rounded rectangle with automatic text layout inside.
   * Useful for info cards, feature boxes, and content panels on dark slides.
   *
   * @example
   * // Simple panel with title and body
   * shapes += panel({
   *   x: 1, y: 2, w: 5, h: 3,
   *   fill: '1A1A1A',
   *   title: 'Performance',
   *   body: 'The Cybertruck accelerates 0-60 in 2.6 seconds.',
   * });
   *
   * @example
   * // Panel with multi-paragraph body
   * shapes += panel({
   *   x: 1, y: 2, w: 5, h: 4,
   *   title: 'Features',
   *   body: ['Adaptive air suspension', 'Steer-by-wire', '17" display'],
   * });
   *
   * @param opts - Panel options
   * @returns Shape XML fragments for all panel elements
   */
  export declare function panel(opts: PanelOptions): ShapeFragment;
  /** Options for card() composite shape */
  export interface CardOptions extends PanelOptions {
      /** Accent color for top border (hex). If set, adds a colored stripe at top */
      accent?: string;
      /** Alias for accent (for convenience) */
      accentColor?: string;
      /** Accent stripe height in inches. Default: 0.08 */
      accentHeight?: number;
  }
  /**
   * Create a card with optional accent stripe.
   * Like panel() but with an optional colored top border for visual distinction.
   *
   * @example
   * shapes += card({
   *   x: 1, y: 2, w: 4, h: 2.5,
   *   accent: 'E31937',  // Red stripe at top
   *   title: 'Cyberbeast',
   *   body: '845 hp tri-motor',
   * });
   *
   * @param opts - Card options
   * @returns Shape XML fragments
   */
  export declare function card(opts: CardOptions): ShapeFragment;
  /**
   * Create a text box with a clickable hyperlink.
   * The entire text box is clickable. For inline hyperlinks within
   * rich text, use richText with link runs (future enhancement).
   *
   * @param {Object} opts
   * @param {number} opts.x - X position in inches
   * @param {number} opts.y - Y position in inches
   * @param {number} opts.w - Width in inches
   * @param {number} opts.h - Height in inches
   * @param {string} opts.text - Display text
   * @param {string} opts.url - Hyperlink URL
   * @param {number} [opts.fontSize=14] - Font size
   * @param {string} [opts.color='2196F3'] - Text color (default blue)
   * @param {boolean} [opts.underline=true] - Underline text
   * @param {Object} pres - Presentation builder (needed to register the link relationship)
   * @returns {ShapeFragment} Branded shape fragment
   */
  export declare function hyperlink(opts: HyperlinkOptions, pres: PresentationInternal): ShapeFragment;
  /** Image dimensions in pixels */
  export interface ImageDimensions {
      width: number;
      height: number;
  }
  /**
   * Read image dimensions from PNG/JPEG/GIF/BMP header bytes.
   * Returns null if format is unrecognized or header is malformed.
   * This is a lightweight operation - only reads the first ~30 bytes.
   *
   * Useful for calculating layouts based on image aspect ratios before
   * embedding images.
   *
   * @param data - Raw image bytes
   * @param format - Image format: 'png', 'jpg', 'jpeg', 'gif', 'bmp'
   * @returns Image dimensions or null if unreadable
   *
   * @example
   * const dims = getImageDimensions(imageData, 'jpg');
   * if (dims) {
   *   const aspectRatio = dims.width / dims.height;
   *   // Calculate appropriate w/h for the slide
   * }
   */
  export declare function getImageDimensions(data: Uint8Array, format: string): ImageDimensions | null;
  /**
   * Embed an image in the presentation at a given position.
   * The image data is raw bytes (Uint8Array) — fetch it via readBinary()
   * from the fetch plugin, or read it via readFileBinary() from fs-read,
   * or generate it in code.
   *
   * Call this when building slide content. The shapeXml goes in the slide body,
   * and the image data is automatically included by pres.build().
   *
   * @example
   * // Embed an image from the filesystem
   * const imageData = readFileBinary('/path/to/logo.png');
   * const imgShape = embedImage(pres, {
   *   x: 0.5, y: 0.5, w: 2, h: 1,
   *   data: imageData,
   *   format: 'png'
   * });
   * // Then include imgShape in your slide body
   *
   * @example
   * // Embed with aspect-ratio-preserving fit
   * const imgShape = embedImage(pres, {
   *   x: 0, y: 0, w: 10, h: 5,
   *   data: imageData,
   *   format: 'jpg',
   *   fit: 'cover'  // fills bounds, crops edges to maintain aspect ratio
   * });
   *
   * @param {Object} pres - Presentation builder (from createPresentation()). REQUIRED.
   * @param {Object} opts
   * @param {number} opts.x - X position in inches
   * @param {number} opts.y - Y position in inches
   * @param {number} opts.w - Width in inches
   * @param {number} opts.h - Height in inches
   * @param {Uint8Array} opts.data - Raw image bytes. REQUIRED.
   * @param {string} [opts.format='png'] - Image format: 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg'
   * @param {string} [opts.fit='stretch'] - How to fit image: 'stretch' (distort to fill), 'contain' (fit within, may letterbox), 'cover' (fill, may crop)
   * @param {string} [opts.name] - Optional image name (for the ZIP path)
   * @returns {ShapeFragment} Branded shape fragment for use in slide body
   */
  export declare function embedImage(pres: PresentationInternal, opts: EmbedImageOptions): ShapeFragment;
  /**
   * Helper to embed an image from a URL with auto-detected format.
   * This combines readBinary() and embedImage() into a simpler workflow.
   *
   * IMPORTANT: The image must be pre-fetched using readBinary(url) before
   * calling this function. The builtin-modules cannot fetch directly.
   *
   * @requires host:fetch
   * @example
   * // Two-step workflow:
   * const data = readBinary('https://example.com/logo.png');
   * const imgShape = embedImageFromUrl(pres, {
   *   url: 'https://example.com/logo.png',
   *   data: data,
   *   x: 0.5, y: 0.5, w: 2, h: 1
   * });
   *
   * @param {Object} pres - Presentation builder (from createPresentation()). REQUIRED.
   * @param {Object} opts
   * @param {string} opts.url - URL the image was fetched from (used for format detection). REQUIRED.
   * @param {Uint8Array} opts.data - Raw image bytes from readBinary(url). REQUIRED.
   * @param {number} opts.x - X position in inches
   * @param {number} opts.y - Y position in inches
   * @param {number} opts.w - Width in inches
   * @param {number} opts.h - Height in inches
   * @param {string} [opts.format] - Override format detection (png, jpg, gif, etc.)
   * @returns {ShapeFragment} Branded shape fragment for use in slide body
   */
  export declare function embedImageFromUrl(pres: PresentationInternal, opts: EmbedImageOptions & {
      url: string;
  }): ShapeFragment;
  /** Slide width in inches (16:9 aspect ratio). */
  export declare const SLIDE_WIDTH_INCHES = 13.333;
  /** Slide height in inches (16:9 aspect ratio). */
  export declare const SLIDE_HEIGHT_INCHES = 7.5;
  /** Maximum Y position for content to avoid footer/page number overlap. */
  export declare const SAFE_BOTTOM = 6.5;
  /** Standard Y position after title + accent bar. */
  export declare const CONTENT_TOP = 1.3;
  /**
   * Combine multiple shape XML fragments into a single string.
   * Safer than string concatenation (`+`) because it validates inputs and provides
   * clear error messages if non-string values are accidentally passed.
   *
   * Each item can be:
   * - A string (XML fragment from textBox, rect, etc.)
   * - An object with toString() method (like embedChart result)
   * - null/undefined (ignored)
   *
   * @example
   * // Instead of error-prone concatenation:
   * // shapes: textBox(...) + embedChart(...) + rect(...)  // embedChart might be [object Object]!
   *
   * // Use shapes() for safety:
   * customSlide(pres, {
   *   shapes: shapes([
   *     textBox({ x: 1, y: 1, w: 10, h: 1, text: 'Title' }),
   *     embedChart(pres, chart, { x: 1, y: 2, w: 10, h: 4 }),
   *     rect({ x: 1, y: 6.5, w: 10, h: 0.5, fill: 'FF0000' })
   *   ])
   * });
   *
   * @param items - Array of shape XML strings or objects with toString()
   * @returns Combined XML string
   */
  export declare function shapes(items: Array<ShapeFragment | null | undefined>): ShapeFragment;
  /**
   * Calculate positions for items in equal-width columns.
   * Useful for stat boxes, image cards, or any side-by-side layout.
   *
   * @example
   * // 3 equal columns with 0.5" margins and 0.25" gaps
   * const cols = layoutColumns(3, { margin: 0.5, gap: 0.25, y: 2, h: 3 });
   * // cols[0] = { x: 0.5, y: 2, w: 3.944, h: 3 }
   * // cols[1] = { x: 4.694, y: 2, w: 3.944, h: 3 }
   * // cols[2] = { x: 8.889, y: 2, w: 3.944, h: 3 }
   *
   * @param {number} count - Number of columns
   * @param {Object} [opts]
   * @param {number} [opts.margin=0.5] - Left/right margin in inches
   * @param {number} [opts.gap=0.25] - Gap between columns in inches
   * @param {number} [opts.y=1] - Y position for all items in inches
   * @param {number} [opts.h=2] - Height of all items in inches
   * @returns {Array<{x: number, y: number, w: number, h: number}>}
   */
  export declare function layoutColumns(count: number, opts?: LayoutColumnsOptions): LayoutRect[];
  /**
   * Calculate positions for items in a grid layout.
   * Items flow left-to-right, top-to-bottom.
   *
   * @example
   * // 2x3 grid (2 columns, 3 rows)
   * const grid = layoutGrid(6, { cols: 2, margin: 0.5, gap: 0.25 });
   *
   * @param {number} count - Number of items
   * @param {Object} [opts]
   * @param {number} [opts.cols=3] - Number of columns
   * @param {number} [opts.margin=0.5] - Outer margin in inches
   * @param {number} [opts.gapX=0.25] - Horizontal gap between items
   * @param {number} [opts.gapY=0.25] - Vertical gap between items
   * @param {number} [opts.y=1] - Top Y position in inches
   * @param {number} [opts.maxH] - Maximum height of grid area (auto-calc item height)
   * @returns {Array<{x: number, y: number, w: number, h: number}>}
   */
  export declare function layoutGrid(count: number, opts?: LayoutGridOptions): LayoutRect[];
  /**
   * Get safe content area bounds that won't overlap footer/page numbers.
   * Use when manually positioning shapes to ensure content stays in safe zone.
   *
   * @example
   * const area = getContentArea({ hasTitle: true });
   * // Returns: { x: 0.5, y: 1.3, w: 12.333, h: 5.2 }
   *
   * @param {Object} [opts]
   * @param {boolean} [opts.hasTitle=false] - If true, starts below title area (y: 1.3)
   * @returns {LayoutRect} Safe bounds for content placement
   */
  export declare function getContentArea(opts?: {
      hasTitle?: boolean;
  }): LayoutRect;
  /**
   * Create a dark overlay rectangle for image slides.
   * Use with customSlide to darken a background image for text readability.
   *
   * @example
   * // Full-slide dark overlay at 60% opacity
   * const overlayXml = overlay({ opacity: 0.6 });
   * customSlide(pres, { shapes: overlayXml + textBox({...}) });
   *
   * @param {Object} [opts]
   * @param {number} [opts.opacity=0.5] - Overlay opacity (0=transparent, 1=opaque)
   * @param {string} [opts.color='000000'] - Overlay color (hex, default black)
   * @param {number} [opts.x=0] - X position in inches
   * @param {number} [opts.y=0] - Y position in inches
   * @param {number} [opts.w] - Width in inches (default: full slide width)
   * @param {number} [opts.h] - Height in inches (default: full slide height)
   * @returns {ShapeFragment} Branded shape fragment
   */
  export declare function overlay(opts?: OverlayOptions): ShapeFragment;
  /**
   * Create a gradient overlay for cinematic effects.
   * Use for half-fades, vignettes, or directional darkening on image slides.
   *
   * @example
   * // Left-to-right fade (dark on left, transparent on right)
   * const fade = gradientOverlay({ fromOpacity: 0.8, toOpacity: 0, angle: 0 });
   * customSlide(pres, { shapes: bgImage + fade + textOnLeft });
   *
   * @example
   * // Top-down vignette
   * const vignette = gradientOverlay({ fromOpacity: 0.6, toOpacity: 0, angle: 90 });
   *
   * @example
   * // Red to transparent gradient
   * const redFade = gradientOverlay({ color1: 'FF0000', fromOpacity: 0.5, toOpacity: 0 });
   *
   * @param {Object} [opts]
   * @param {string} [opts.color1='000000'] - Start color (hex)
   * @param {string} [opts.color2='000000'] - End color (hex)
   * @param {number} [opts.fromOpacity=0.8] - Start opacity (0-1)
   * @param {number} [opts.toOpacity=0] - End opacity (0-1, 0=transparent)
   * @param {number} [opts.angle=0] - Gradient angle (0=right, 90=down, 180=left, 270=up)
   * @param {number} [opts.x=0] - X position in inches
   * @param {number} [opts.y=0] - Y position in inches
   * @param {number} [opts.w] - Width in inches (default full slide)
   * @param {number} [opts.h] - Height in inches (default full slide)
   * @returns {ShapeFragment} Branded shape fragment
   */
  export declare function gradientOverlay(opts?: GradientOverlayOptions): ShapeFragment;
  /**
   * Create a full-bleed background image that covers the entire slide.
   * Use with customSlide to create hero slides with image backgrounds.
   *
   * @example
   * // Full-slide background image with dark overlay for text
   * import { fetchBinary } from "host:fetch";
   * const imgData = fetchBinary("https://example.com/hero.jpg");
   * const bgImg = backgroundImage(pres, imgData, "jpg");
   * const darkOverlay = overlay({ opacity: 0.5 });
   * const title = textBox({x: 1, y: 3, w: 11, h: 1.5, text: 'Hero Title', fontSize: 48, color: 'FFFFFF', forceColor: true});
   * customSlide(pres, { shapes: bgImg + darkOverlay + title });
   *
   * @param {Object} pres - Presentation object from createPresentation()
   * @param {Uint8Array} data - Image data (from fetchBinary, readBinary, or shared-state)
   * @param {string} [format='jpg'] - Image format (jpg, png, gif, webp, etc.)
   * @returns {ShapeFragment} Branded shape fragment for a full-slide image
   */
  export declare function backgroundImage(pres: PresentationInternal, data: Uint8Array, format?: string): ShapeFragment;
  /**
   * Create a gradient background for slides.
   * Use with customSlide({ background }) or as defaultBackground in createPresentation().
   *
   * @param {string} color1 - Start color (hex, e.g. '000000')
   * @param {string} color2 - End color (hex, e.g. '1a1a2e')
   * @param {number} [angle=270] - Gradient angle in degrees (0=right, 90=down, 180=left, 270=up)
   * @returns {string} Background XML for use with customSlide()
   *
   * @example
   * // Vertical gradient (top to bottom)
   * const pres = createPresentation({ theme: 'brutalist' });
   * customSlide(pres, { shapes: [...], background: '000000' });
   *
   * @example
   * // As default background for all slides
   * const pres = createPresentation({
   *   theme: 'brutalist',
   *   defaultBackground: { color1: '0a0a0a', color2: '1a1a2e', angle: 180 }
   * });
   */
  export declare function gradientBg(color1: string, color2: string, angle?: number): string;
  export interface ValidationIssue {
      code: string;
      severity: "error" | "warn";
      message: string;
      part?: string;
      slideIndex?: number;
      hint?: string;
  }
  export interface ValidationResult {
      ok: boolean;
      errors: ValidationIssue[];
      warnings: ValidationIssue[];
  }
  /**
   * Create a new presentation builder.
   *
   * **Theme enforcement:** A valid theme name MUST be provided (or omitted
   * for the default 'corporate-blue').  This ensures all slides use a
   * professionally-designed colour palette with guaranteed contrast.
   * Available themes: corporate-blue, dark-gradient, light-clean, emerald, sunset, black, brutalist.
   *
   * @example
   * // Create presentation
   * const pres = createPresentation({ theme: 'dark-gradient' });
   *
   * // Use slide functions for common layouts:
   * titleSlide(pres, { title: 'My Title' });
   * contentSlide(pres, { title: 'Content', bullets: ['Point 1', 'Point 2'] });
   *
   * // For CUSTOM layouts, use customSlide():
   * customSlide(pres, {
   *   shapes: [textBox({x: 1, y: 1, w: 8, h: 1, text: 'Custom text'}),
   *            rect({x: 1, y: 3, w: 4, h: 2, fill: pres.theme.accent1})],
   *   transition: 'fade'
   * });
   *
   * // Build final file
   * const zip = pres.buildZip();
   *
   * @example
   * // With default background for all slides (avoids repeating per-slide)
   * const pres = createPresentation({
   *   theme: 'brutalist',
   *   defaultBackground: '0A0A0A'  // solid color
   * });
   *
   * @example
   * // With gradient default background
   * const pres = createPresentation({
   *   theme: 'brutalist',
   *   defaultBackground: { color1: '000000', color2: '1a1a2e', angle: 180 }
   * });
   *
   * @param {Object} [opts]
   * @param {string} [opts.theme='corporate-blue'] - Theme name (must be a known theme)
   * @param {boolean} [opts.forceAllColors=false] - When true, bypasses ALL WCAG contrast validation globally.
   *   Use when you want full control over colors without any validation errors. This is a "nuclear option"
   *   that skips contrast checking for ALL shapes in the presentation.
   * @param {string|Object} [opts.defaultBackground] - Default background for slides created via addBody().
   *   - String: hex color like '0A0A0A' for solid background
   *   - Object: {color1, color2, angle} for gradient background
   *   If not specified, slides use the theme's background color.
   * @returns {Object} Presentation builder with methods:
   *   - addSlide(bgXml, shapesXml, opts?) — append custom slide (bg from solidFill/gradientBg, shapes from textBox/rect/etc)
   *   - addBody(shapesXml, opts?) — append slide with shapes using default/theme background (simpler than addSlide!)
   *   - insertSlideAt(index, bgXml, shapesXml, opts?) — insert at position
   *   - reorderSlides(newOrder) — reorder by index array [2,0,1]
   *   - moveSlide(from, to) — move one slide
   *   - deleteSlide(index) — remove a slide
   *   - build() → entries array
   *   - buildZip() → Uint8Array (use with writeFileBinary)
   * @throws {Error} If theme name is not recognised
   */
  export declare function createPresentation(opts?: CreatePresentationOptions): {
      theme: Theme;
      _images: ImageEntry[];
      _imageIndex: number;
      _links: {
          slideIndex: number;
          relId: string;
          url: string;
      }[];
      _charts: ChartEntry[];
      _chartEntries: {
          name: string;
          data: string;
      }[];
      _animations: Record<number, string[]>;
      /**
       * Get the internal slides array. For advanced manipulation only.
       * Each slide is: { bg: string, shapes: string, transition?: string, notes?: string }
       * Prefer using the slide functions (titleSlide, contentSlide, etc.) instead.
       */
      slides: SlideData[];
      /** Current number of slides in the presentation. */
      readonly slideCount: number;
      /**
       * Add a raw slide with shapes.
       * @param {string} bgXml - Background XML
       * @param {string} shapesXml - Concatenated shape XML fragments
       * @param {Object} [slideOpts] - Optional slide-level settings
       * @param {string} [slideOpts.transition] - Transition type: 'fade', 'push', 'wipe', 'split', 'cover'
       * @param {number} [slideOpts.transitionDuration=500] - Transition duration in ms
       * @param {string} [slideOpts.notes] - Speaker notes text
       */
      addSlide(bgXml: string, shapesXml: string | string[], slideOpts?: SlideOptions): void;
      /**
       * Add shapes to a new slide (convenience alias for addSlide).
       * Uses theme background by default — just pass your shapes!
       * @param {string} shapesXml - Concatenated shape XML fragments (from textBox, rect, etc.)
       * @param {Object} [slideOpts] - Optional slide-level settings
       * @param {string|Object} [slideOpts.background] - Background color (hex) or gradient spec
       *   - String: hex color like '0D1117'
       *   - Object: {color1, color2, angle} for gradient (see gradientBg)
       * @param {string} [slideOpts.transition] - Transition type: 'fade', 'push', 'wipe', 'split', 'cover'
       * @param {number} [slideOpts.transitionDuration=500] - Transition duration in ms
       * @param {string} [slideOpts.notes] - Speaker notes text
       * @example
       * // Simple usage - just pass shapes:
       * pres.addBody(textBox({x:1, y:1, w:8, h:1, text:'Hello'}));
       *
       * // With solid background:
       * pres.addBody([shape1, shape2], { background: '0D1117', transition: 'fade' });
       *
       * // With gradient background:
       * pres.addBody([shape1], { background: {color1: '000000', color2: '1a1a2e', angle: 180} });
       */
      addBody(shapesInput: ShapeFragment | ShapeFragment[] | string | string[], slideOpts?: SlideOptions): void;
      /**
       * Internal: add shapes (as pre-validated XML string) to a new slide.
       * Resolves background from per-slide > defaultBackground > theme.
       * Not on the Presentation interface — internal use only.
       * @internal
       */
      _addBodyRaw(shapesStr: string, slideOpts?: SlideOptions): void;
      /**
       * Insert a slide at a specific index. Existing slides shift right.
       * @param {number} index - Position to insert (0-based). Clamped to valid range.
       * @param {string} bgXml - Background XML
       * @param {string} shapesXml - Concatenated shape XML fragments
       * @param {Object} [slideOpts] - Optional slide-level settings
       */
      insertSlideAt(index: number, bgXml: string, shapesXml: string, slideOpts?: SlideOptions): void;
      /**
       * Reorder slides by providing a new index sequence.
       * @example reorderSlides([2, 0, 1]) moves slide 3 to first position
       * @param {number[]} newOrder - Array of current indices in desired new order.
       *   Must contain all indices from 0 to slides.length-1 exactly once.
       * @throws {Error} If newOrder is invalid (wrong length, missing/duplicate indices)
       */
      reorderSlides(newOrder: number[]): void;
      /**
       * Move a slide from one position to another.
       * @param {number} fromIndex - Current index of slide to move (0-based)
       * @param {number} toIndex - Target index (0-based)
       */
      moveSlide(fromIndex: number, toIndex: number): void;
      /**
       * Delete a slide at the specified index.
       * @param {number} index - Index of slide to delete (0-based)
       */
      deleteSlide(index: number): void;
      /**
       * Build the presentation as an array of ZIP entries.
       * @returns {Array<{name: string, data: string}>} ZIP entries for createZip()
       */
      build(): ({
          name: string;
          data: string;
      } | {
          name: string;
          data: Uint8Array<ArrayBufferLike>;
      })[];
      /**
       * Build the presentation and return it as a ready-to-write Uint8Array ZIP.
       * This is a convenience wrapper: buildZip() = createZip(build()).
       * Use with writeFileBinary: writeFileBinary('output.pptx', pres.buildZip())
       * @returns {Uint8Array} Complete PPTX file as bytes
       */
      buildZip(): Uint8Array<ArrayBufferLike>;
      /**
       * Remove orphan charts that aren't referenced by any slide XML.
       * Charts can become orphaned when a handler fails after embedChart()
       * but before the slide is actually added. The chart is saved to state
       * during auto-save but never appears in any slide's shapes.
       * @internal
       */
      _cleanupOrphanCharts(): void;
      /**
       * Insert a warning slide at position 0 indicating this was AI-generated.
       * Called automatically by buildZip().
       * @internal
       */
      _insertWarningSlide(): void;
      /**
       * Serialize the presentation state to a plain object for storage in shared-state.
       * Use this to save presentation progress across handler boundaries.
       *
       * The returned object is JSON-serializable (images stored as Uint8Array which
       * survives shared-state serialization). Use restorePresentation() to restore.
       *
       * @returns {Object} Serialized state containing theme, slides, images, charts, options
       * @example
       * // Handler 1: Create and save
       * const pres = createPresentation({ theme: 'brutalist' });
       * titleSlide(pres, { title: 'Hello' });
       * sharedState.set('pres', pres.serialize());
       *
       * // Handler 2: Restore and continue
       * const pres = restorePresentation(sharedState.get('pres'));
       * contentSlide(pres, { title: 'More content' });
       * sharedState.set('pres', pres.serialize());
       *
       * // Handler 3: Export
       * const pres = restorePresentation(sharedState.get('pres'));
       * const bytes = pres.buildZip();
       */
      serialize(): {
          _version: number;
          themeName: string;
          defaultBackground: string | GradientSpec | null;
          forceAllColors: boolean;
          defaultTextColor: string | null;
          slides: SlideData[];
          images: ImageEntry[];
          imageIndex: number;
          charts: ChartEntry[];
          chartEntries: {
              name: string;
              data: string;
          }[];
          shapeIdCounter: number;
      };
      /**
       * Save presentation to shared-state under the given key.
       * Shorthand for: sharedState.set(key, pres.serialize())
       *
       * @param {string} key - Storage key in shared-state
       * @example
       * pres.save('myPres');  // Save to shared-state
       * // Later, in another handler:
       * const pres = loadPresentation('myPres');  // Restore
       */
      save(key: string): void;
  };
  /**
   * Load a presentation from shared-state by key.
   * Shorthand for: restorePresentation(sharedState.get(key))
   *
   * @param {string} key - Storage key in shared-state
   * @returns {Object} Restored presentation builder, or throws if not found
   * @throws {Error} If key not found or state is invalid
   *
   * @example
   * // Handler 1: Create and save
   * const pres = createPresentation({ theme: 'brutalist' });
   * titleSlide(pres, { title: 'Hello' });
   * pres.save('myPres');
   *
   * // Handler 2: Load and continue
   * const pres = loadPresentation('myPres');
   * contentSlide(pres, { title: 'More' });
   * pres.save('myPres');
   *
   * // Handler 3: Export
   * const pres = loadPresentation('myPres');
   * writeFileBinary('out.pptx', pres.buildZip());
   */
  export declare function loadPresentation(key: string): Pres;
  /**
   * Restore a presentation from serialized state (from pres.serialize()).
   * Use this to continue building a presentation across handler boundaries.
   *
   * @param {Object} state - Serialized state from pres.serialize()
   * @returns {Object} Restored presentation builder with all methods available
   * @throws {Error} If state is invalid or missing required fields
   *
   * @example
   * // Handler 1: Create and save
   * const pres = createPresentation({ theme: 'brutalist', defaultBackground: '0A0A0A' });
   * titleSlide(pres, { title: 'Hello' });
   * embedImage(pres, { data: imgBytes, format: 'jpg', x: 1, y: 1, w: 4, h: 3 });
   * sharedState.set('pres', pres.serialize());
   *
   * // Handler 2: Restore and continue
   * const pres = restorePresentation(sharedState.get('pres'));
   * contentSlide(pres, { title: 'More content' });
   * sharedState.set('pres', pres.serialize());
   *
   * // Handler 3: Export
   * const pres = restorePresentation(sharedState.get('pres'));
   * const bytes = pres.buildZip();
   * writeFileBinary('output.pptx', bytes);
   */
  export declare function restorePresentation(state: SerializedPresentation): Pres;
  /**
   * Export a presentation to a file in one step.
   * This is a convenience function that combines buildZip() + writeFileBinary().
   * Automatically chunks large files (>2MB) to avoid fs-write per-call limits.
   *
   * IMPORTANT: Requires the fs-write module to be imported and passed as the third parameter.
   * The module cannot be auto-imported - you must import it in your handler.
   *
   * @requires host:fs-write
   * @example
   * import { createPresentation, titleSlide, exportToFile } from "ha:pptx";
   * import * as fsWrite from "host:fs-write";
   *
   * const pres = createPresentation({ theme: 'dark-gradient' });
   * titleSlide(pres, { title: 'Hello World' });
   * exportToFile(pres, 'output.pptx', fsWrite); // Done!
   *
   * @param {Object} pres - Presentation object from createPresentation(). REQUIRED.
   * @param {string} path - Output file path (e.g., 'output.pptx'). REQUIRED.
   * @param {Object} fsWrite - The fs-write module (import * as fsWrite from "host:fs-write"). REQUIRED.
   * @returns {{ slides: number, size: number, path: string, chunks: number }} Summary of the exported file
   * @throws {Error} If pres is invalid or fsWrite is not provided
   */
  export declare function exportToFile(pres: Pres, path: string, fsWrite: any): {
      slides: any;
      size: any;
      path: string;
      chunks: number;
  };
  /**
   * Add a title slide with centered title and subtitle.
   *
   * IMPORTANT: The 'pres' parameter (from createPresentation) MUST be the first argument.
   * @example
   * const pres = createPresentation({ theme: 'corporate-blue' });
   * titleSlide(pres, { title: 'My Presentation', subtitle: 'A great story' });
   *
   * @param {Object} pres - Presentation object from createPresentation(). REQUIRED as first param.
   * @param {Object} opts - Slide options
   * @param {string} opts.title - Main title text. REQUIRED.
   * @param {string} [opts.subtitle] - Subtitle text
   * @param {string} [opts.background] - Override background color (6-char hex)
   * @param {string} [opts.transition] - Transition type: 'fade', 'push', 'wipe', 'split', 'cover'
   * @param {string} [opts.notes] - Speaker notes text
   */
  export declare function titleSlide(pres: Pres, opts: TitleSlideOptions): void;
  /**
   * Add a section divider slide with accent background.
   *
   * IMPORTANT: The 'pres' parameter (from createPresentation) MUST be the first argument.
   * @example
   * sectionSlide(pres, { title: 'Chapter 2', subtitle: 'The Journey Begins' });
   *
   * @param {Object} pres - Presentation object from createPresentation(). REQUIRED as first param.
   * @param {Object} opts - Slide options
   * @param {string} opts.title - Section title. REQUIRED.
   * @param {string} [opts.subtitle] - Optional subtitle
   * @param {string} [opts.transition] - Transition type: 'fade', 'push', 'wipe', 'split', 'cover'
   * @param {string} [opts.notes] - Speaker notes text
   */
  export declare function sectionSlide(pres: Pres, opts: SectionSlideOptions): void;
  /**
   * Add a content slide with title bar and body elements.
   *
   * IMPORTANT: The 'pres' parameter (from createPresentation) MUST be the first argument.
   * @example
   * // With shape fragments:
   * contentSlide(pres, {
   *   title: 'Key Metrics',
   *   body: [statBox({...}), bulletList({...})]
   * });
   *
   * // With plain strings (auto-wrapped in bulletList):
   * contentSlide(pres, {
   *   title: 'Agenda',
   *   items: ['First topic', 'Second topic', 'Third topic']
   * });
   *
   * // Or newline-delimited string:
   * contentSlide(pres, {
   *   title: 'Agenda',
   *   items: 'First topic\nSecond topic\nThird topic'
   * });
   *
   * @param {Object} pres - Presentation object from createPresentation(). REQUIRED as first param.
   * @param {Object} opts - Slide options
   * @param {string} opts.title - Slide title. REQUIRED.
   * @param {string[]|string} [opts.items] - Bullet points (array or newline-delimited string)
   * @param {string} [opts.transition] - Transition type: 'fade', 'push', 'wipe', 'split', 'cover'
   * @param {string} [opts.notes] - Speaker notes text
   */
  export declare function contentSlide(pres: Pres, opts: ContentSlideOptions): void;
  /**
   * Add a two-column slide with vertical divider.
   *
   * IMPORTANT: The 'pres' parameter (from createPresentation) MUST be the first argument.
   *
   * @example
   * // With plain strings:
   * twoColumnSlide(pres, {
   *   title: 'Pros and Cons',
   *   leftItems: ['Benefit 1', 'Benefit 2'],
   *   rightItems: ['Drawback 1', 'Drawback 2']
   * });
   *
   * // Or newline-delimited strings:
   * twoColumnSlide(pres, {
   *   title: 'Comparison',
   *   leftItems: 'Point A\nPoint B\nPoint C',
   *   rightItems: 'Point X\nPoint Y\nPoint Z'
   * });
   *
   * @param {Object} pres - Presentation object from createPresentation(). REQUIRED as first param.
   * @param {Object} opts - Slide options
   * @param {string} opts.title - Slide title. REQUIRED.
   * @param {string[]|string} [opts.leftItems] - Left column bullet points (array or newline-delimited string)
   * @param {string[]|string} [opts.rightItems] - Right column bullet points (array or newline-delimited string)
   * @param {string} [opts.transition] - Transition type: 'fade', 'push', 'wipe', 'split', 'cover'
   * @param {string} [opts.notes] - Speaker notes text
   */
  export declare function twoColumnSlide(pres: Pres, opts: TwoColumnSlideOptions): void;
  /**
   * Add a blank slide with just the theme background (NO content).
   *
   * ⚠️ WARNING: This creates an EMPTY slide. You CANNOT add shapes to it later.
   * For custom layouts with shapes, use customSlide() instead:
   *
   * @example
   * // DON'T do this — blankSlide creates empty slide with no way to add content:
   * blankSlide(pres);  // Creates empty slide, cannot add shapes after
   *
   * // DO this instead — use customSlide for custom layouts:
   * customSlide(pres, {
   *   shapes: [textBox({x: 1, y: 1, w: 8, h: 1, text: 'Custom slide'}),
   *            rect({x: 1, y: 3, w: 4, h: 2, fill: pres.theme.accent1})],
   *   transition: 'fade'
   * });
   *
   * @param {Object} pres - Presentation object from createPresentation(). REQUIRED as first param.
   * @returns {void}
   */
  export declare function blankSlide(pres: Pres): void;
  /**
   * Add a custom slide with shapes using the theme background.
   * This is the recommended way to create slides with arbitrary content.
   *
   * IMPORTANT: The 'pres' parameter (from createPresentation) MUST be the first argument.
   *
   * @example
   * // Basic custom slide with multiple shapes
   * customSlide(pres, {
   *   shapes: textBox({x: 1, y: 1, w: 10, h: 1, text: 'Custom Title', fontSize: 32}) +
   *           rect({x: 1, y: 2.5, w: 4, h: 3, fill: pres.theme.accent1}) +
   *           textBox({x: 6, y: 2.5, w: 5, h: 3, text: 'Details here'})
   * });
   *
   * // With transition and speaker notes
   * customSlide(pres, {
   *   shapes: textBox({x: 1, y: 1, w: 10, h: 5, text: 'Slide content'}),
   *   transition: 'fade',
   *   notes: 'Speaker notes for this slide'
   * });
   *
   * // With custom background color (overrides theme)
   * customSlide(pres, {
   *   shapes: textBox({x: 1, y: 1, w: 10, h: 1, text: 'Dark slide', color: 'FFFFFF'}),
   *   background: '1A1A2E'
   * });
   *
   * @param {Object} pres - Presentation object from createPresentation(). REQUIRED as first param.
   * @param {Object} opts - Slide options
   * @param {string} opts.shapes - Shape XML fragments concatenated (textBox + rect + ...). REQUIRED.
   * @param {string} [opts.background] - Background color hex (defaults to theme.bg)
   * @param {string} [opts.transition] - Transition type: 'fade', 'push', 'wipe', 'split', 'cover'
   * @param {number} [opts.transitionDuration=500] - Transition duration in ms
   * @param {string} [opts.notes] - Speaker notes text
   * @returns {void}
   */
  export declare function customSlide(pres: Pres, opts: CustomSlideOptions): void;
  /**
   * Add a slide with a chart and optional side content.
   * Handles embedChart and body assembly automatically — no IIFE needed.
   *
   * IMPORTANT: The 'pres' parameter (from createPresentation) MUST be the first argument.
   * @example
   * import { barChart } from 'ha:pptx-charts';
   * const chart = barChart({ labels: ['A', 'B'], series: [{ name: 'Sales', values: [10, 20] }] });
   * chartSlide(pres, { title: 'Revenue', chart });
   *
   * @param {Object} pres - Presentation object from createPresentation(). REQUIRED as first param.
   * @param {Object} opts - Slide options
   * @param {string} opts.title - Slide title. REQUIRED.
   * @param {Object} opts.chart - Chart object from barChart/pieChart/lineChart/comboChart (ha:pptx-charts)
   * @param {Object} [opts.chartPosition] - Chart position {x, y, w, h} in inches (defaults: full width)
   * @param {string[]|string} [opts.extraItems] - Additional text items below the chart (array or newline-delimited string)
   * @param {string} [opts.transition] - Transition type: 'fade', 'push', 'wipe', 'split', 'cover'
   * @param {string} [opts.notes] - Speaker notes text
   */
  export declare function chartSlide(pres: Pres, opts: ChartSlideOptions): void;
  /**
   * Add a comparison slide — side-by-side content with column headers.
   * Great for before/after, pros/cons, or option comparisons.
   *
   * IMPORTANT: The 'pres' parameter (from createPresentation) MUST be the first argument.
   * @example
   * // With arrays:
   * comparisonSlide(pres, {
   *   title: 'Pros vs Cons',
   *   leftTitle: 'Advantages',
   *   leftItems: ['Fast startup', 'Low memory', 'Secure isolation'],
   *   rightTitle: 'Limitations',
   *   rightItems: ['x86 only', 'No macOS support']
   * });
   *
   * @example
   * // Also accepts newline-delimited strings
   * comparisonSlide(pres, {
   *   title: 'When to Use',
   *   leftTitle: 'Great For',
   *   leftItems: 'Serverless functions\nPlugin sandboxing\nMulti-tenant apps',
   *   rightTitle: 'Not Ideal For',
   *   rightItems: 'General VMs\nGPU workloads'
   * });
   *
   * @param {Object} pres - Presentation object from createPresentation(). REQUIRED as first param.
   * @param {Object} opts - Slide options
   * @param {string} opts.title - Slide title. REQUIRED.
   * @param {string} [opts.leftTitle] - Left column header (default: "Option A")
   * @param {string} [opts.rightTitle] - Right column header (default: "Option B")
   * @param {string[]|string} [opts.leftItems] - Left column items (array or newline-delimited string)
   * @param {string[]|string} [opts.rightItems] - Right column items (array or newline-delimited string)
   * @param {string} [opts.transition] - Transition type: 'fade', 'push', 'wipe', 'split', 'cover'
   * @param {string} [opts.notes] - Speaker notes text
   */
  export declare function comparisonSlide(pres: Pres, opts: ComparisonSlideOptions): void;
  /**
   * Create a hero slide with a full-bleed background image and overlay text.
   * Perfect for title cards, section headers, or impactful visual slides.
   *
   * @example
   * // Basic hero slide
   * import { fetchBinary } from "host:fetch";
   * const imgData = fetchBinary("https://example.com/hero.jpg");
   * heroSlide(pres, {
   *   image: imgData,
   *   title: "Big Bold Title",
   *   subtitle: "Supporting text beneath"
   * });
   *
   * @example
   * // With customization
   * heroSlide(pres, {
   *   image: imgData,
   *   imageFormat: "png",
   *   title: "Custom Hero",
   *   subtitle: "With options",
   *   overlayOpacity: 0.7,       // Darker overlay (default: 0.5)
   *   titleSize: 60,             // Larger title (default: 48)
   *   align: "left",             // Left-aligned (default: center)
   *   transition: "fade"
   * });
   *
   * @param {Object} pres - Presentation object from createPresentation(). REQUIRED.
   * @param {Object} opts - Options
   * @param {Uint8Array} opts.image - Image data (from fetchBinary or shared-state). REQUIRED.
   * @param {string} [opts.imageFormat='jpg'] - Image format (jpg, png, gif, webp)
   * @param {string} [opts.title] - Main title text (optional for image-only slides)
   * @param {string} [opts.subtitle] - Subtitle text below the title
   * @param {number} [opts.overlayOpacity=0.5] - Dark overlay opacity (0-1)
   * @param {string} [opts.overlayColor='000000'] - Overlay color (hex)
   * @param {number} [opts.titleSize=48] - Title font size
   * @param {number} [opts.subtitleSize=24] - Subtitle font size
   * @param {string} [opts.align='center'] - Text alignment: 'left', 'center', 'right'
   * @param {string} [opts.transition] - Slide transition
   * @param {string} [opts.notes] - Speaker notes
   */
  export declare function heroSlide(pres: Pres, opts: HeroSlideOptions): void;
  /**
   * Create a stat grid slide showing 2-4 key metrics in a row.
   * Automatically arranges stats in equal-width columns.
   *
   * @example
   * // Basic stats
   * statGridSlide(pres, {
   *   title: "Key Metrics",
   *   stats: [
   *     { value: "10M+", label: "Users" },
   *     { value: "99.9%", label: "Uptime" },
   *     { value: "50ms", label: "Latency" }
   *   ]
   * });
   *
   * @example
   * // With customization
   * statGridSlide(pres, {
   *   title: "Q4 Results",
   *   stats: [
   *     { value: "$2.1B", label: "Revenue" },
   *     { value: "45%", label: "YoY Growth" },
   *     { value: "12", label: "New Markets" },
   *     { value: "4.8★", label: "Rating" }
   *   ],
   *   valueSize: 56,      // Larger values
   *   accentColor: pres.theme.accent2,
   *   transition: "fade"
   * });
   *
   * @param {Object} pres - Presentation object. REQUIRED.
   * @param {Object} opts - Options
   * @param {string} [opts.title] - Slide title (optional)
   * @param {Array} opts.stats - Array of {value, label} objects. REQUIRED. 2-4 items.
   * @param {number} [opts.valueSize=48] - Value font size
   * @param {number} [opts.labelSize=16] - Label font size
   * @param {string} [opts.accentColor] - Override accent color for values
   * @param {string} [opts.transition] - Slide transition
   * @param {string} [opts.notes] - Speaker notes
   */
  export declare function statGridSlide(pres: Pres, opts: StatGridSlideOptions): void;
  /**
   * Create an image grid slide with 2x2, 3x2, or 2x3 layout.
   * Perfect for portfolios, product showcases, or photo galleries.
   *
   * @example
   * // 2x2 grid
   * imageGridSlide(pres, {
   *   title: "Product Gallery",
   *   images: [img1, img2, img3, img4],  // Uint8Array from fetchBinary
   *   format: "jpg"
   * });
   *
   * @example
   * // With captions
   * imageGridSlide(pres, {
   *   images: [
   *     { data: img1, caption: "Feature A" },
   *     { data: img2, caption: "Feature B" },
   *     { data: img3, caption: "Feature C" },
   *     { data: img4, caption: "Feature D" }
   *   ],
   *   format: "png"
   * });
   *
   * @param {Object} pres - Presentation object. REQUIRED.
   * @param {Object} opts - Options
   * @param {string} [opts.title] - Slide title
   * @param {Array} opts.images - Array of Uint8Array or {data, caption, format}. REQUIRED. 2-6 items.
   * @param {string} [opts.format='jpg'] - Default image format (can be overridden per-image)
   * @param {number} [opts.gap=0.2] - Gap between images in inches
   * @param {string} [opts.transition] - Slide transition
   * @param {string} [opts.notes] - Speaker notes
   */
  export declare function imageGridSlide(pres: Pres, opts: ImageGridSlideOptions): void;
  /**
   * Create a quote/testimonial slide with large styled quotation.
   * Great for customer testimonials, key quotes, or inspirational messages.
   *
   * @example
   * quoteSlide(pres, {
   *   quote: "This product changed everything for our team.",
   *   author: "Jane Smith",
   *   role: "CEO, TechCorp"
   * });
   *
   * @param {Object} pres - Presentation object. REQUIRED.
   * @param {Object} opts - Options
   * @param {string} opts.quote - The quote text. REQUIRED.
   * @param {string} [opts.author] - Quote attribution
   * @param {string} [opts.role] - Author's role/company
   * @param {number} [opts.quoteSize=32] - Quote font size
   * @param {string} [opts.transition] - Slide transition
   * @param {string} [opts.notes] - Speaker notes
   */
  export declare function quoteSlide(pres: Pres, opts: QuoteSlideOptions): void;
  /**
   * Create a keynote-style slide with one big dramatic number.
   * Perfect for impact metrics like "2.6 SECONDS" or "$99,990" or "845 HP".
   * Number and unit are centered vertically with optional label below.
   *
   * @example
   * bigNumberSlide(pres, {
   *   number: '2.6',
   *   unit: 'SECONDS',
   *   label: '0-60 MPH',
   *   numberColor: 'FF0000',
   * });
   *
   * @param {Object} pres - Presentation object. REQUIRED.
   * @param {Object} opts - Options
   * @param {string} opts.number - The big number to display. REQUIRED.
   * @param {string} [opts.unit] - Unit/label next to number (e.g., "SECONDS")
   * @param {string} [opts.label] - Smaller footnote below
   * @param {number} [opts.numberSize=160] - Number font size
   * @param {number} [opts.unitSize=48] - Unit font size
   * @param {number} [opts.labelSize=24] - Label font size
   * @param {string} [opts.numberColor] - Number color (default: theme.accent1)
   * @param {string} [opts.unitColor] - Unit color (default: same as numberColor)
   * @param {string} [opts.labelColor] - Label color (default: theme.subtle)
   * @param {string|Object} [opts.background] - Slide background
   * @param {string} [opts.transition] - Slide transition
   * @param {string} [opts.notes] - Speaker notes
   */
  export declare function bigNumberSlide(pres: Pres, opts: BigNumberSlideOptions): void;
  /**
   * Create an architecture diagram slide showing system components.
   * Great for showing microservices, data flow, or system layers.
   *
   * IMPORTANT: The 'pres' parameter (from createPresentation) MUST be the first argument.
   * @example
   * architectureDiagramSlide(pres, {
   *   title: 'System Architecture',
   *   components: [
   *     { label: 'Client', icon: 'cloud', color: '64B5F6' },
   *     { label: 'API Gateway', icon: 'shield' },
   *     { label: 'Service', icon: 'gear' },
   *     { label: 'Database', icon: 'database', color: '00E676' }
   *   ],
   *   layout: 'horizontal'
   * });
   *
   * @param {Object} pres - Presentation object from createPresentation(). REQUIRED.
   * @param {Object} opts - Options
   * @param {string} opts.title - Slide title. REQUIRED.
   * @param {Array} opts.components - Array of {label, description?, color?, icon?}
   * @param {string} [opts.layout='horizontal'] - 'horizontal' or 'layered'
   * @param {boolean} [opts.showArrows=true] - Show arrows between components
   */
  export declare function architectureDiagramSlide(pres: Pres, opts: ArchitectureDiagramSlideOptions): void;
  /**
   * Create a code walkthrough slide with code and explanatory bullets.
   * Great for showing code snippets with annotations.
   *
   * IMPORTANT: The 'pres' parameter (from createPresentation) MUST be the first argument.
   * @example
   * codeWalkthroughSlide(pres, {
   *   title: 'API Handler',
   *   code: 'async function handler(req) {\n  const data = await fetch(url);\n  return data.json();\n}',
   *   bullets: ['Async/await for clean flow', 'Fetch for HTTP requests', 'Auto JSON parsing'],
   *   language: 'javascript'
   * });
   *
   * @param {Object} pres - Presentation object from createPresentation(). REQUIRED.
   * @param {Object} opts - Options
   * @param {string} opts.title - Slide title. REQUIRED.
   * @param {string} opts.code - Code to display. REQUIRED.
   * @param {Array} [opts.bullets] - Explanation points beside the code
   * @param {string} [opts.language] - Language label (displayed, no highlighting)
   */
  export declare function codeWalkthroughSlide(pres: Pres, opts: CodeWalkthroughSlideOptions): void;
  /**
   * Create a before/after comparison slide.
   * Great for showing improvements, changes, or transformations.
   *
   * IMPORTANT: The 'pres' parameter (from createPresentation) MUST be the first argument.
   * @example
   * beforeAfterSlide(pres, {
   *   title: 'Performance Improvements',
   *   beforeTitle: 'Before Optimization',
   *   beforeContent: ['500ms cold start', '128MB memory', 'Manual scaling'],
   *   afterTitle: 'After Optimization',
   *   afterContent: ['50ms cold start', '32MB memory', 'Auto-scaling'],
   * });
   *
   * @param {Object} pres - Presentation object from createPresentation(). REQUIRED.
   * @param {Object} opts - Options
   * @param {string} opts.title - Slide title. REQUIRED.
   * @param {Array|string} opts.beforeContent - Before items (array or newline-separated). REQUIRED.
   * @param {Array|string} opts.afterContent - After items (array or newline-separated). REQUIRED.
   */
  export declare function beforeAfterSlide(pres: Pres, opts: BeforeAfterSlideOptions): void;
  /**
   * Create a process flow slide showing sequential steps.
   * Great for workflows, pipelines, or step-by-step procedures.
   *
   * IMPORTANT: The 'pres' parameter (from createPresentation) MUST be the first argument.
   * @example
   * processFlowSlide(pres, {
   *   title: 'CI/CD Pipeline',
   *   steps: [
   *     { label: 'Build', description: 'Compile code', icon: 'gear' },
   *     { label: 'Test', description: 'Run tests', icon: 'checkmark' },
   *     { label: 'Deploy', description: 'Ship to prod', icon: 'cloud' }
   *   ],
   *   layout: 'horizontal'
   * });
   *
   * @param {Object} pres - Presentation object from createPresentation(). REQUIRED.
   * @param {Object} opts - Options
   * @param {string} opts.title - Slide title. REQUIRED.
   * @param {Array} opts.steps - Array of {label, description?, icon?, color?}. REQUIRED.
   * @param {string} [opts.layout='horizontal'] - 'horizontal' or 'vertical'
   * @param {boolean} [opts.showNumbers=true] - Show step numbers
   */
  export declare function processFlowSlide(pres: Pres, opts: ProcessFlowSlideOptions): void;
  /**
   * Add slide numbers to all slides in the presentation.
   * Call this AFTER adding all slides but BEFORE build().
   * Automatically selects a readable colour per-slide based on each slide's background.
   * Do NOT pass a color — the auto-selection handles dark and light slides correctly.
   *
   * IMPORTANT: The 'pres' parameter (from createPresentation) MUST be the first argument.
   * @example
   * // After adding all slides:
   * addSlideNumbers(pres, { fontSize: 10, startAt: 1 });
   * // Then build:
   * const zip = pres.buildZip();
   *
   * @param {Object} pres - Presentation object from createPresentation(). REQUIRED as first param.
   * @param {Object} [opts] - Options
   * @param {number} [opts.fontSize=10] - Font size in points
   * @param {number} [opts.startAt=1] - Starting number
   */
  export declare function addSlideNumbers(pres: Pres, opts?: SlideNumberOptions): void;
  /**
   * Add a footer to all slides in the presentation.
   * Call this AFTER adding all slides but BEFORE build().
   * Automatically selects a readable colour per-slide based on each slide's background.
   * Do NOT pass a color — the auto-selection handles dark and light slides correctly.
   * @param {Object} pres - Presentation builder
   * @param {Object} opts
   * @param {string} opts.text - Footer text
   * @param {number} [opts.fontSize=9] - Font size
   */
  export declare function addFooter(pres: Pres, opts: FooterOptions): void;
  /**
   * Measure text dimensions to help with layout and overflow detection.
   * Uses font metrics estimation (not exact rendering).
   *
   * @example
   * // Check if text fits in a box
   * const measurement = measureText({
   *   text: 'Hello, world!\nSecond line',
   *   fontSize: 24,
   *   maxWidth: 4
   * });
   * console.log(measurement.height); // Estimated height in inches
   * console.log(measurement.wouldWrap); // true if text would wrap
   *
   * @param {Object} opts
   * @param {string|string[]} opts.text - Text to measure
   * @param {number} [opts.fontSize=18] - Font size in points
   * @param {number} [opts.lineSpacing] - Line spacing (default: fontSize * 1.2)
   * @param {number} [opts.maxWidth] - Width constraint for wrap detection (inches)
   * @param {number} [opts.charWidthFactor=0.5] - Character width as fraction of font size
   * @returns {TextMeasurement} Measurement results
   */
  export declare function measureText(opts: MeasureTextOptions): TextMeasurement;
  /**
   * Clone an existing slide in the presentation.
   * Useful for creating variations of a template slide.
   *
   * @example
   * // Clone the last slide
   * cloneSlide(pres);
   *
   * // Clone slide at index 2 with new transition
   * cloneSlide(pres, { sourceIndex: 2, transition: 'fade' });
   *
   * @param {Object} pres - Presentation object from createPresentation()
   * @param {Object} [opts] - Clone options
   * @param {number} [opts.sourceIndex] - Index of slide to clone (default: last slide)
   * @param {string} [opts.transition] - Transition for cloned slide
   * @param {number} [opts.transitionDuration] - Transition duration in ms
   * @param {string} [opts.notes] - Override speaker notes
   * @returns {number} Index of the cloned slide
   */
  export declare function cloneSlide(pres: Pres, opts?: CloneSlideOptions): number;
  /**
   * Add animation to the last shape added on a slide.
   * Call this immediately after adding a shape to animate it.
   *
   * @example
   * // Add a text box with fade-in animation
   * const shape = textBox({ x: 1, y: 1, w: 4, h: 1, text: 'Hello!' });
   * pres.addBody(shape);
   * addAnimation(pres, pres.slideCount - 1, {
   *   entrance: 'fadeIn',
   *   duration: 1000
   * });
   *
   * IMPORTANT: Animation support is experimental. For best results, use
   * simple entrance animations like 'fadeIn' or 'appear'.
   *
   * @param {Object} pres - Presentation object from createPresentation()
   * @param {number} slideIndex - Index of the slide (0-based)
   * @param {AnimationOptions} opts - Animation options
   */
  export declare function addAnimation(pres: Pres, slideIndex: number, opts: AnimationOptions): void;
  /**
   * Add staggered animations to multiple shapes on a slide.
   * Creates a sequence where each shape animates with a delay after the previous.
   *
   * @example
   * // Staggered fade-in for bullet points
   * addStaggeredAnimation(pres, pres.slideCount - 1, 5, {
   *   animation: { entrance: 'fadeIn', duration: 300 },
   *   staggerDelay: 150
   * });
   *
   * @example
   * // Fly-in from left with longer stagger
   * addStaggeredAnimation(pres, 0, 3, {
   *   animation: { entrance: 'flyInLeft', duration: 500 },
   *   staggerDelay: 300,
   *   mode: 'sequential'
   * });
   *
   * IMPORTANT: Animation support is experimental. This function adds multiple
   * animations with cumulative delays to simulate staggered entrance.
   *
   * @param {Object} pres - Presentation object from createPresentation()
   * @param {number} slideIndex - Index of the slide (0-based)
   * @param {number} shapeCount - Number of shapes to animate
   * @param {StaggeredAnimationOptions} opts - Staggered animation options
   */
  export declare function addStaggeredAnimation(pres: Pres, slideIndex: number, shapeCount: number, opts: StaggeredAnimationOptions): void;
  /**
   * Create a styled code block with monospace font and dark background.
   * Ideal for displaying source code, CLI commands, or configuration snippets.
   *
   * @example
   * // Simple code block
   * const code = codeBlock({
   *   x: 1, y: 2, w: 10, h: 3,
   *   code: 'const greeting = "Hello, world!";\nconsole.log(greeting);',
   *   title: 'example.js',
   *   lineNumbers: true
   * });
   *
   * @param {Object} opts
   * @param {number} opts.x - X position in inches
   * @param {number} opts.y - Y position in inches
   * @param {number} opts.w - Width in inches
   * @param {number} opts.h - Height in inches
   * @param {string} opts.code - Code text (multi-line string). REQUIRED.
   * @param {number} [opts.fontSize=11] - Font size in points
   * @param {string} [opts.color='E6EDF3'] - Text color (light for dark bg)
   * @param {string} [opts.background='161B22'] - Background color (dark)
   * @param {string} [opts.fontFamily='Consolas'] - Monospace font
   * @param {string} [opts.title] - Optional title above the code block
   * @param {string} [opts.titleColor='8B949E'] - Title color
   * @param {boolean} [opts.lineNumbers=false] - Show line numbers
   * @param {number} [opts.cornerRadius=4] - Corner radius in points
   * @returns {ShapeFragment} Branded shape fragment
   */
  export declare function codeBlock(opts: CodeBlockOptions): ShapeFragment;
  /**
   * Slide configuration for batch creation.
   * Each object describes one slide using a declarative config.
   */
  export interface SlideConfig {
      /** Slide type: determines which slide function to call */
      type: "title" | "section" | "content" | "hero" | "comparison" | "twoColumn" | "stats" | "quote" | "imageGrid" | "bigNumber" | "custom";
      /** Options passed to the slide function (type-specific) */
      opts: Record<string, unknown>;
  }
  /**
   * Create multiple slides from an array of configurations.
   * Each config specifies a slide type and its options.
   *
   * @example
   * addSlidesFromConfig(pres, [
   *   { type: 'title', opts: { title: 'My Deck', subtitle: 'Overview' } },
   *   { type: 'section', opts: { title: 'Introduction' } },
   *   { type: 'content', opts: { title: 'Key Points', bullets: ['Point 1', 'Point 2'] } },
   *   { type: 'stats', opts: { title: 'Metrics', stats: [{value: '99%', label: 'Accuracy'}] } },
   * ]);
   *
   * @param {Object} pres - Presentation object from createPresentation()
   * @param {Array<SlideConfig>} configs - Array of slide configurations
   */
  export declare function addSlidesFromConfig(pres: Pres, configs: SlideConfig[]): void;
  /**
   * Quick deck section for quickDeck() API.
   */
  export interface QuickSection {
      /** Section title (creates a section slide) */
      title: string;
      /** Slides in this section */
      slides: Array<{
          type: "content";
          title: string;
          items: string[] | string;
      } | {
          type: "stats";
          title: string;
          stats: Array<{
              value: string;
              label: string;
          }>;
      } | {
          type: "quote";
          quote: string;
          author?: string;
          role?: string;
      } | {
          type: "comparison";
          title: string;
          leftTitle: string;
          rightTitle: string;
          leftItems: string[] | string;
          rightItems: string[] | string;
      } | {
          type: "bigNumber";
          number: string;
          unit?: string;
          label?: string;
      } | {
          type: "hero";
          title: string;
          subtitle?: string;
          image: Uint8Array;
          imageFormat?: string;
      }>;
  }
  /**
   * Quick deck configuration for quickDeck() API.
   */
  export interface QuickDeckConfig {
      /** Presentation title (first slide) */
      title: string;
      /** Optional subtitle for title slide */
      subtitle?: string;
      /** Theme name */
      theme?: string;
      /** Array of sections, each with a title and slides */
      sections: QuickSection[];
      /** Optional closing slide text */
      closing?: {
          title: string;
          subtitle?: string;
      };
      /** Add slide numbers? Default: true */
      slideNumbers?: boolean;
      /** Add footer text? */
      footer?: string;
  }
  /**
   * Generate a complete presentation from a structured outline.
   * Ideal for quickly creating decks from research/content without manual slide-by-slide calls.
   *
   * @example
   * const pres = quickDeck({
   *   title: "Q4 Results",
   *   subtitle: "Financial Overview",
   *   theme: "brutalist",
   *   sections: [
   *     {
   *       title: "Revenue",
   *       slides: [
   *         { type: "bigNumber", number: "$4.2M", label: "Total Revenue" },
   *         { type: "content", title: "Breakdown", items: ["Product: $2.1M", "Services: $2.1M"] }
   *       ]
   *     },
   *     {
   *       title: "Outlook",
   *       slides: [
   *         { type: "quote", quote: "Best quarter ever", author: "CEO" }
   *       ]
   *     }
   *   ],
   *   closing: { title: "Thank You", subtitle: "Questions?" },
   *   slideNumbers: true,
   *   footer: "Confidential"
   * });
   * writeFileBinary('q4.pptx', pres.buildZip());
   *
   * @param {QuickDeckConfig} config - Deck configuration
   * @returns {Pres} Presentation object ready for export
   */
  export declare function quickDeck(config: QuickDeckConfig): Pres;
  /**
   * Fetch an image from URL and embed it in the presentation in one call.
   * Requires the fetch plugin to be enabled with the image domain allowlisted.
   *
   * @example
   * // Single image
   * const img = fetchAndEmbed(pres, {
   *   url: "https://example.com/photo.jpg",
   *   x: 1, y: 1, w: 4, h: 3,
   *   fetchFn: fetchBinary
   * });
   * customSlide(pres, { shapes: [img, textBox({...})] });
   *
   * @example
   * // With fetch plugin
   * import { fetchBinary } from "host:fetch";
   * const img = fetchAndEmbed(pres, {
   *   url: "https://cdn.example.com/hero.jpg",
   *   x: 0, y: 0, w: 13.333, h: 7.5,
   *   fit: "cover",
   *   fetchFn: fetchBinary
   * });
   *
   * @param {Object} pres - Presentation object
   * @param {Object} opts - Options
   * @param {string} opts.url - Image URL to fetch
   * @param {number} opts.x - X position in inches
   * @param {number} opts.y - Y position in inches
   * @param {number} opts.w - Width in inches
   * @param {number} opts.h - Height in inches
   * @param {string} [opts.format] - Image format (auto-detected from URL if omitted)
   * @param {string} [opts.fit] - Fit mode: 'stretch', 'contain', 'cover'
   * @param {Function} opts.fetchFn - Fetch function (e.g., fetchBinary from host:fetch)
   * @returns {ShapeFragment} Branded image shape fragment
   */
  export declare function fetchAndEmbed(pres: Pres, opts: {
      url: string;
      x: number;
      y: number;
      w: number;
      h: number;
      format?: string;
      fit?: "stretch" | "contain" | "cover";
      fetchFn: (url: string) => Uint8Array;
  }): ShapeFragment;
  /**
   * Fetch multiple images and embed them all, returning XML fragments.
   * Uses fetchBinaryBatch for efficient parallel downloads when maxParallelFetches > 1.
   *
   * @example
   * import { fetchBinaryBatch } from "host:fetch";
   * const images = fetchAndEmbedBatch(pres, {
   *   items: [
   *     { url: "https://example.com/1.jpg", x: 0.5, y: 1, w: 4, h: 3 },
   *     { url: "https://example.com/2.jpg", x: 5, y: 1, w: 4, h: 3 },
   *     { url: "https://example.com/3.jpg", x: 9.5, y: 1, w: 4, h: 3 },
   *   ],
   *   fetchBatchFn: fetchBinaryBatch
   * });
   * // images = [{ url, shape }, { url, shape }, { url, shape }] or [{ url, error }, ...]
   *
   * @param {Object} pres - Presentation object
   * @param {Object} opts - Options
   * @param {Array} opts.items - Array of {url, x, y, w, h, format?, fit?}
   * @param {Function} opts.fetchBatchFn - Batch fetch function (fetchBinaryBatch from host:fetch)
   * @returns {Array} Array of {url, shape: ShapeFragment} or {url, error} for each item
   */
  export declare function fetchAndEmbedBatch(pres: Pres, opts: {
      items: Array<{
          url: string;
          x: number;
          y: number;
          w: number;
          h: number;
          format?: string;
          fit?: "stretch" | "contain" | "cover";
      }>;
      fetchBatchFn: (urls: string[]) => Array<{
          url: string;
          data?: Uint8Array;
          error?: string;
      }>;
  }): Array<{
      url: string;
      shape?: ShapeFragment;
      error?: string;
  }>;
}

declare module "ha:shared-state" {
  /** Type for storable values */
  export type StorableValue = string | number | boolean | null | undefined | Uint8Array | StorableValue[] | {
      [key: string]: StorableValue;
  };
  /**
   * Store a value by key. Overwrites any existing value.
   * Values can be any JSON-serialisable type OR Uint8Array for binary data.
   * Binary data survives sandbox recompiles via the host sidecar mechanism.
   * @param key - Storage key
   * @param value - Value to store (supports Uint8Array for binary)
   */
  export declare function set(key: string, value: StorableValue): void;
  /**
   * Retrieve a value by key. Returns undefined if not found.
   * @param key - Storage key
   * @returns The stored value, or undefined
   */
  export declare function get(key: string): StorableValue | undefined;
  /**
   * Check if a key exists in the store.
   * @param key - Storage key
   * @returns True if the key exists
   */
  export declare function has(key: string): boolean;
  /**
   * Delete a key from the store.
   * @param key - Storage key
   * @returns True if the key existed and was deleted
   */
  export declare function del(key: string): boolean;
  /**
   * Get all stored key-value pairs as a plain object.
   * Used internally by the save/restore system.
   * @returns All stored data as { key: value, ... }
   */
  export declare function getAll(): Record<string, StorableValue>;
  /**
   * Get all stored keys.
   * @returns Array of all keys
   */
  export declare function keys(): string[];
  /**
   * Clear all stored data.
   */
  export declare function clear(): void;
  /**
   * Get the number of stored entries.
   * @returns Number of stored key-value pairs
   */
  export declare function size(): number;
  /**
   * Estimate the byte size of a stored value.
   * For Uint8Array, returns exact byte count.
   * For other types, estimates JSON serialization size.
   * @param key - Storage key
   * @returns Estimated size in bytes, or 0 if key doesn't exist
   */
  export declare function getSize(key: string): number;
  /**
   * Get storage statistics for all keys.
   * Useful for debugging memory usage and finding large values.
   * @returns Object with { totalBytes, entries: [{key, bytes}...] } sorted by size descending
   */
  export declare function stats(): {
      totalBytes: number;
      entries: Array<{
          key: string;
          bytes: number;
      }>;
  };
}

declare module "ha:str-bytes" {
  /**
   * Convert a string to a Uint8Array (Latin-1 / byte-per-char).
   * Replacement for TextEncoder which is unavailable in QuickJS.
   * Only handles code points 0-255 (Latin-1). For multi-byte Unicode,
   * use strToUtf8Bytes instead.
   * @param s - Input string
   * @returns Byte array
   */
  export declare function strToBytes(s: string): Uint8Array;
  /**
   * Convert a Uint8Array back to a string (Latin-1 / byte-per-char).
   * Replacement for TextDecoder which is unavailable in QuickJS.
   * @param a - Byte array
   * @returns Decoded string
   */
  export declare function bytesToStr(a: Uint8Array): string;
  /**
   * Encode a string as UTF-8 bytes. Handles multi-byte Unicode correctly.
   * Use this for text that may contain characters outside Latin-1.
   * @param s - Input string (any Unicode)
   * @returns UTF-8 encoded bytes
   */
  export declare function strToUtf8Bytes(s: string): Uint8Array;
  /**
   * Convert a 16-bit integer to 2 bytes (little-endian).
   * Common in binary file format construction (ZIP, PPTX, etc.)
   * @param n - 16-bit integer
   * @returns 2-byte array
   */
  export declare function uint16LE(n: number): Uint8Array;
  /**
   * Convert a 32-bit integer to 4 bytes (little-endian).
   * @param n - 32-bit integer
   * @returns 4-byte array
   */
  export declare function uint32LE(n: number): Uint8Array;
  /**
   * Concatenate multiple Uint8Arrays into a single array.
   * @param arrays - Arrays to concatenate
   * @returns Combined array
   */
  export declare function concatBytes(...arrays: Uint8Array[]): Uint8Array;
}

declare module "ha:xml-escape" {
  /**
   * Escape a string for use as XML text content.
   * Handles: & < > (the required three).
   * @param str - Raw string
   * @returns XML-safe string
   */
  export declare function escapeXml(str: string): string;
  /**
   * Escape a string for use as an XML attribute value.
   * Handles: & < > " ' (all five).
   * @param str - Raw string
   * @returns Attribute-safe string
   */
  export declare function escapeAttr(str: string): string;
  /**
   * Create a simple XML element string.
   * @param tag - Element name (e.g. "a:t")
   * @param content - Text content (escaped automatically), null for self-closing
   * @param attrs - Attribute key-value pairs (values escaped automatically)
   * @returns XML element string
   */
  export declare function el(tag: string, content: string | null | undefined, attrs?: Record<string, string | number | boolean>): string;
}

declare module "ha:zip-format" {
  /** ZIP file entry */
  export interface ZipEntry {
      /** File path within the archive */
      name: string;
      /** File content as bytes or UTF-8 string */
      data: Uint8Array | string;
  }
  /** ZIP creation options */
  export interface ZipOptions {
      /** Enable DEFLATE compression (default: true, false = STORE only) */
      compress?: boolean;
  }
  /**
   * Create a ZIP file from an array of entries.
   * Uses DEFLATE compression by default - falls back to STORE
   * when compression doesn't reduce size (e.g. already-compressed images).
   *
   * Memory-efficient implementation: pre-calculates total size and writes
   * directly to a single buffer to avoid intermediate allocations.
   *
   * Duplicate file names are automatically deduplicated - last entry wins.
   * This prevents invalid ZIPs when the same file path appears multiple times.
   *
   * @param entries - Files to include
   * @param opts - Options
   * @returns Complete ZIP file as bytes
   */
  export declare function createZip(entries: ZipEntry[], opts?: ZipOptions): Uint8Array;
}

declare module "ha:ziplib" {
  /**
   * Compress data using DEFLATE (RFC 1951).
   * Produces raw DEFLATE output (no zlib or gzip wrapper).
   */
  export declare function deflate(data: Uint8Array): Uint8Array;
  /**
   * Decompress DEFLATE-compressed data (RFC 1951).
   * Expects raw DEFLATE input (no zlib or gzip wrapper).
   */
  export declare function inflate(data: Uint8Array): Uint8Array;
}

// Host module type declarations
declare module "host:_binary-state" {
  export function set(key: string, value: Uint8Array): void;
  export function get(key: string): Uint8Array | undefined;
  export function del(key: string): boolean;
  export function clear(): void;
}
