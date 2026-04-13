//
//   QUICK START:
//   1. Create presentation: const pres = createPresentation({ theme: 'corporate-blue' });
//   2. Add slides: titleSlide(pres, { title: 'My Presentation' });
//   3. Build file: const zip = pres.buildZip();
//   4. Save: writeFileBinary('output.pptx', zip);
//
//   AVAILABLE THEMES (use with createPresentation, or call getThemeNames()):
//   'corporate-blue' (default), 'dark-gradient', 'light-clean', 'emerald', 'sunset', 'black', 'brutalist'
//
//   SLIDE FUNCTIONS (all require 'pres' as FIRST parameter):
//   titleSlide(pres, opts), sectionSlide(pres, opts), contentSlide(pres, opts),
//   twoColumnSlide(pres, opts), chartSlide(pres, opts), comparisonSlide(pres, opts),
//   customSlide(pres, opts), blankSlide(pres), addSlideNumbers(pres, opts), addFooter(pres, opts)
//
//   LAYOUT SAFETY (avoid footer/page number overlap):
//   • Slide is 13.333" x 7.5". Footer/page numbers at y: 7.
//   • Keep content within y: 0.5 to 6.5 (use SAFE_BOTTOM constant)
//   • Use getContentArea({ hasTitle: true/false }) for safe positioning bounds
//   • layoutGrid() auto-respects SAFE_BOTTOM; for manual layouts check your y + h < 6.5
//
//   COLOUR RULES (CRITICAL — contrast failures waste time):
//   • PREFER omitting text 'color' params — auto-selection picks highest-contrast
//   • If you need explicit colors: use forceColor:true on shape, or forceAllColors on pres
//   • createPresentation({forceAllColors: true}) bypasses ALL contrast validation
//   • For fill/background, any hex is fine — only TEXT colours are checked
//   • Theme palette (always valid): theme.fg, theme.accent1-4, theme.subtle
//
//   TABLE FUNCTIONS (re-exported from pptx-tables):
//   table(opts), kvTable(opts), comparisonTable(opts), timeline(opts)
//

import {
  hexColor,
  getTheme,
  getThemeNames,
  autoTextColor,
  isDark,
  requireHex,
  requireThemeColor,
  requireNumber,
  requireString,
  requireArray,
  requireEnum,
  THEMES,
  contrastRatio,
  type Theme,
} from "ha:doc-core";
import {
  inches,
  fontSize,
  contentTypesXml,
  relsXml,
  themeXml,
  SLIDE_WIDTH,
  SLIDE_HEIGHT,
  nextShapeId,
  nextShapeIdAndName,
  resetShapeIdCounter,
  getShapeIdCounter,
  setShapeIdCounter,
  setForceAllColors,
  isForceAllColors,
  _createShapeFragment,
  isShapeFragment,
  fragmentsToXml,
  type ShapeFragment,
} from "ha:ooxml-core";
import { escapeXml } from "ha:xml-escape";
import { createZip } from "ha:zip-format";
import { set as sharedStateSet, get as sharedStateGet } from "ha:shared-state";

// ── Type Definitions ─────────────────────────────────────────────────────

export interface GradientSpec {
  color1: string;
  color2: string;
  angle?: number;
}

export interface SlideOptions {
  background?: string | GradientSpec;
  transition?:
    | "fade"
    | "push"
    | "wipe"
    | "split"
    | "cover"
    | "reveal"
    | "curtains"
    | "dissolve"
    | "zoom"
    | "fly"
    | "wheel"
    | "random"
    | "none";
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
  chartEntries: Array<{ name: string; data: string }>;
  shapeIdCounter?: number; // Track shape IDs across handlers
}

export interface Presentation {
  theme: Theme;
  slideCount: number;
  addBody(shapes: ShapeFragment | ShapeFragment[], opts?: SlideOptions): void;
  build(): Array<{ name: string; data: string | Uint8Array }>;
  buildZip(): Uint8Array;
  serialize(): SerializedPresentation;
  /** Save presentation to shared-state under the given key. Shorthand for sharedState.set(key, pres.serialize()). */
  save(key: string): void;
  _chartEntries: Array<{ name: string; data: string }>;
}

/** Internal presentation type with all mutable fields for shape functions */
interface PresentationInternal {
  theme: Theme;
  slides?: SlideData[];
  _links?: Array<{ slideIndex: number; relId: string; url: string }>;
  _images?: ImageEntry[];
  _imageIndex?: number;
  _charts?: ChartEntry[];
  _chartEntries?: Array<{ name: string; data: string }>;
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

// ── Options interfaces for all functions ────────────────────────────────

/** Text effect options for glow and shadow */
export interface TextEffectOptions {
  /**
   * Glow effect around text. Color is hex (no #).
   * @example { color: 'FF0000', radius: 5 } // Red glow, 5pt radius
   */
  glow?: { color: string; radius?: number };
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

interface RunPropertiesOptions extends TextEffectOptions {
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  color?: string;
  fontFamily?: string;
}

interface ParagraphOptions extends RunPropertiesOptions {
  align?: string;
  lineSpacing?: number;
}

interface BulletOptions extends ParagraphOptions {
  bulletColor?: string;
}

interface TextBodyOptions {
  wordWrap?: boolean;
  valign?: string;
  padding?: number;
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
  items?: (string | { text: string; bold?: boolean; color?: string })[];
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
  transition?:
    | "fade"
    | "push"
    | "wipe"
    | "split"
    | "cover"
    | "reveal"
    | "curtains"
    | "dissolve"
    | "zoom"
    | "fly"
    | "wheel"
    | "random"
    | "none";
  /** Transition duration in ms */
  transitionDuration?: number;
  /** Speaker notes for cloned slide (overrides original) */
  notes?: string;
}

/** Animation entrance types */
export type AnimationEntrance =
  | "appear"
  | "fadeIn"
  | "flyInLeft"
  | "flyInRight"
  | "flyInTop"
  | "flyInBottom"
  | "zoomIn"
  | "bounceIn"
  | "wipeRight"
  | "wipeDown";

/** Animation emphasis types */
export type AnimationEmphasis =
  | "pulse"
  | "spin"
  | "grow"
  | "shrink"
  | "colorPulse"
  | "teeter";

/** Animation exit types */
export type AnimationExit =
  | "disappear"
  | "fadeOut"
  | "flyOutLeft"
  | "flyOutRight"
  | "flyOutTop"
  | "flyOutBottom"
  | "zoomOut";

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
  viewBox?: { x?: number; y?: number; w: number; h: number };
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
  chartPosition?: { x: number; y: number; w: number; h: number };
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
  stats: Array<{ value: string; label: string }>;
  background?: string | GradientSpec;
  transition?: string;
  notes?: string;
  valueSize?: number;
  labelSize?: number;
  accentColor?: string;
}

export interface ImageGridSlideOptions {
  title?: string;
  images:
    | Uint8Array[]
    | Array<{ data: Uint8Array; format?: string; caption?: string }>;
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

// Re-export ShapeFragment type + validation for LLMs (NOT _createShapeFragment — internal only)
export { type ShapeFragment, isShapeFragment, fragmentsToXml };

// Re-export table-related functions from pptx-tables for convenience.
// LLMs can import just "ha:pptx" and get access to table(), kvTable(), etc.
export {
  table,
  kvTable,
  comparisonTable,
  timeline,
  TABLE_STYLES,
} from "ha:pptx-tables";

// Import chart complexity caps for validation engine (defined in pptx-charts, single source of truth)
import { MAX_CHARTS_PER_DECK } from "ha:pptx-charts";

// Re-export contrastRatio for LLM pre-validation of color combinations
export { contrastRatio };

// Re-export getThemeNames for theme discovery without trial-and-error
export { getThemeNames };

// Re-export unit converters so LLMs don't need to import from ooxml-core
export { inches, fontSize } from "ha:ooxml-core";

// ── Module Hints for LLM ─────────────────────────────────────────────
// Exported as _HINTS and returned by module_info for LLM guidance.

// Hints are now in pptx.json (structured metadata).

// ── Active Theme (module-level) ───────────────────────────────────────
// Set by createPresentation() so that shape builders (textBox, bulletList,
// numberedList, statBox) can auto-select readable text colours even when
// the LLM omits an explicit colour.  Single-threaded guest execution means
// only one presentation is ever being built at a time.
let _activeTheme: Theme | null = null;

// ── Force All Colors Flag ──────────────────────────────────────────────
// NOTE: _forceAllColors is now managed in ha:ooxml-core via setForceAllColors()
// and isForceAllColors() to break the circular dependency with ha:pptx-tables.
// When set to true by createPresentation({forceAllColors: true}), all
// WCAG contrast validation is bypassed globally.

// ── Default Text Color (module-level) ─────────────────────────────────
// When set by createPresentation({defaultTextColor: 'FFFFFF'}), this color
// is used for text elements that don't specify an explicit color.
// Useful for dark themes where most text should be white.
let _defaultTextColor: string | null = null;

// NOTE: nextShapeId(), resetShapeIdCounter(), setForceAllColors(), and
// isForceAllColors() are now imported from ha:ooxml-core to break the
// circular dependency with ha:pptx-tables.

/**
 * Extract XML string from a ShapeFragment for internal slide composition.
 * Internal-only helper — not exported to LLMs.
 */
function _s(fragment: ShapeFragment): string {
  return fragment._xml;
}

/**
 * Normalize items input to an array of strings.
 * Accepts: string[], string (newline-delimited), or undefined.
 * Returns: string[] (empty array if undefined).
 */
const normalizeItems = (input: string[] | string | undefined): string[] => {
  if (!input) return [];
  if (Array.isArray(input)) return input;
  return input
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
};

/**
 * Get the default text color if set, otherwise return the provided fallback.
 * Used internally by text-containing shape functions.
 */
function getDefaultTextColor(
  explicitColor: string | undefined,
  fallback: string,
): string {
  if (explicitColor) return explicitColor;
  if (_defaultTextColor) return _defaultTextColor;
  return fallback;
}

// ── Enum Whitelists ──────────────────────────────────────────────────
// Valid OOXML values for enumerated parameters.  Any value the LLM passes
// MUST be in one of these sets or the function throws a helpful error.

/** Valid alignment values (both friendly and OOXML forms). */
const VALID_ALIGNS = [
  "l",
  "ctr",
  "r",
  "just",
  "center",
  "left",
  "right",
  "justify",
];

/** Valid OOXML dash preset names (ECMA-376 §20.1.10.12). */
const VALID_DASHES = [
  "solid",
  "dash",
  "dot",
  "dashDot",
  "lgDash",
  "lgDashDot",
  "lgDashDotDot",
  "sysDash",
  "sysDot",
  "sysDashDot",
  "sysDashDotDot",
];

/** Valid OOXML arrowhead types (ECMA-376 §20.1.10.39). */
const VALID_HEAD_TYPES = [
  "none",
  "triangle",
  "stealth",
  "diamond",
  "oval",
  "arrow",
];

/** Valid image formats for embedImage. */
const VALID_IMAGE_FORMATS = ["png", "jpg", "jpeg", "gif", "bmp", "svg"];

// ── Colour Validation Helpers ────────────────────────────────────────

/**
 * Validate an optional colour parameter against the active theme.
 * If the colour is provided, it must be a valid hex AND must have
 * WCAG AA contrast against the reference background (theme.bg or
 * the specified fill).  If the colour is falsy, returns null (callers
 * should then use their default/theme fallback).
 *
 * Use for TEXT colours only.  For fill/background colours, use
 * `_validateOptionalHex()` instead — fills don't need contrast checks.
 *
 * @param {string|null|undefined} hex - Colour to validate, or falsy to skip
 * @param {string} paramName - Parameter name for error messages
 * @param {Theme} [theme] - Theme for contrast check (default: _activeTheme)
 * @param {Object} [opts] - Options passed to requireThemeColor
 * @returns {string|null} Validated hex or null if input was falsy
 */
function _validateOptionalColor(
  hex: string | null | undefined,
  paramName: string,
  theme?: Theme | null,
  opts?: { against?: string },
): string | null {
  if (!hex) return null;
  // Global escape hatch: skip contrast validation entirely
  if (isForceAllColors()) {
    return requireHex(hex, paramName);
  }
  return requireThemeColor(hex, theme || _activeTheme, paramName, opts);
}

/**
 * Validate an optional colour as valid hex only — no contrast check.
 * Use for fill/background colours, borders, and decorative elements.
 *
 * @param {string|null|undefined} hex - Colour to validate, or falsy to skip
 * @param {string} paramName - Parameter name for error messages
 * @returns {string|null} Validated hex or null if input was falsy
 */
function _validateOptionalHex(
  hex: string | null | undefined,
  paramName: string,
): string | null {
  if (!hex) return null;
  return requireHex(hex, paramName);
}

/**
 * Validate an optional numeric parameter.  Returns the value if present
 * and valid, or null if falsy.  Throws if present but not a finite number.
 * @param {*} n - Value to validate
 * @param {string} paramName - Parameter name for error messages
 * @param {Object} [opts] - min/max bounds
 * @returns {number|null} Validated number or null
 */
function _validateOptionalNumber(
  n: number | null | undefined,
  paramName: string,
  opts?: { min?: number; max?: number },
): number | null {
  if (n == null) return null;
  return requireNumber(n, paramName, opts);
}

// ── Namespace constants ──────────────────────────────────────────────
const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_R =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const RT_SLIDE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide";
const RT_SLIDE_LAYOUT =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout";
const RT_SLIDE_MASTER =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster";
const RT_NOTES_MASTER =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster";
const RT_THEME =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme";
const RT_PRES_PROPS =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps";
const RT_VIEW_PROPS =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/viewProps";
const RT_TABLE_STYLES =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles";

// ── Shape XML Helpers ────────────────────────────────────────────────

function spTransform(x: number, y: number, w: number, h: number): string {
  return `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>`;
}

/**
 * Create a solid fill XML element.
 * Use for shape fills or customSlide({ background }) backgrounds.
 * @param {string} color - Hex color (6 digits, no #)
 * @param {number} [opacity] - Opacity from 0 (transparent) to 1 (opaque). Omit for fully opaque.
 * @returns {string} Solid fill XML
 */
export function solidFill(color: string, opacity?: number): string {
  const c = hexColor(color);
  if (opacity != null && opacity < 1) {
    // OOXML alpha: 0 = transparent, 100000 = opaque
    const alpha = Math.round(opacity * 100000);
    return `<a:solidFill><a:srgbClr val="${c}"><a:alpha val="${alpha}"/></a:srgbClr></a:solidFill>`;
  }
  return `<a:solidFill><a:srgbClr val="${c}"/></a:solidFill>`;
}

/**
 * Generate text effect XML for glow and shadow.
 * Returns an <a:effectLst> element if any effects are specified.
 */
function textEffectsXml(opts: TextEffectOptions): string {
  const effects: string[] = [];

  // Glow effect
  if (opts.glow) {
    const glowColor = hexColor(opts.glow.color);
    // Radius in EMUs (1 point = 12700 EMUs)
    const radius = Math.round((opts.glow.radius ?? 5) * 12700);
    effects.push(
      `<a:glow rad="${radius}"><a:srgbClr val="${glowColor}"/></a:glow>`,
    );
  }

  // Drop shadow effect
  if (opts.shadow) {
    const shadowColor = hexColor(opts.shadow.color);
    // Blur radius in EMUs
    const blurRad = Math.round((opts.shadow.blur ?? 4) * 12700);
    // Distance in EMUs
    const dist = Math.round((opts.shadow.offset ?? 2) * 12700);
    // Angle in 60000ths of a degree (0 = right, 90 = down)
    const dir = Math.round((opts.shadow.angle ?? 45) * 60000);
    // Opacity (0-100000)
    const alpha = Math.round((opts.shadow.opacity ?? 0.5) * 100000);
    effects.push(
      `<a:outerShdw blurRad="${blurRad}" dist="${dist}" dir="${dir}">` +
        `<a:srgbClr val="${shadowColor}"><a:alpha val="${alpha}"/></a:srgbClr>` +
        `</a:outerShdw>`,
    );
  }

  if (effects.length === 0) return "";
  return `<a:effectLst>${effects.join("")}</a:effectLst>`;
}

function runProperties(opts: RunPropertiesOptions): string {
  const sz = opts.fontSize ? ` sz="${fontSize(opts.fontSize)}"` : "";
  const b = opts.bold ? ' b="1"' : "";
  const i = opts.italic ? ' i="1"' : "";
  const fill = opts.color ? solidFill(opts.color) : "";
  const font = opts.fontFamily
    ? `<a:latin typeface="${escapeXml(opts.fontFamily)}"/>`
    : "";
  const effects = textEffectsXml(opts);
  return `<a:rPr lang="en-US" dirty="0"${sz}${b}${i}>${fill}${effects}${font}</a:rPr>`;
}

/** Normalize alignment values — OOXML uses 'ctr' not 'center'.
 * @throws {Error} If alignment is not a recognised value.
 */
function normalizeAlign(align: string | undefined): string {
  if (!align) return "l";
  requireEnum(align, "align", VALID_ALIGNS);
  const map: Record<string, string> = {
    center: "ctr",
    left: "l",
    right: "r",
    justify: "just",
  };
  return map[align] || align;
}

function paragraphXml(
  text: string,
  opts: ParagraphOptions | null | undefined,
): string {
  const o = opts || {};
  const algn = normalizeAlign(o.align);
  // lineSpacing is in points (e.g. 24 = 24pt line height)
  // spcPts uses centipoints (1/100th of a point), so 24pt = 2400
  const spc = o.lineSpacing
    ? `<a:lnSpc><a:spcPts val="${Math.round(o.lineSpacing * 100)}"/></a:lnSpc>`
    : "";
  const rPr = runProperties(o);
  return `<a:p><a:pPr algn="${algn}">${spc}</a:pPr><a:r>${rPr}<a:t>${escapeXml(String(text))}</a:t></a:r></a:p>`;
}

function bulletParagraph(
  item: string | { text: string; bold?: boolean; color?: string },
  opts: BulletOptions | null | undefined,
  level: number | undefined,
): string {
  // Normalize item: accept both string and object with text/bold/color
  const text = typeof item === "string" ? item : item.text;
  const itemBold =
    typeof item === "object" && item !== null ? item.bold : undefined;
  const itemColor =
    typeof item === "object" && item !== null ? item.color : undefined;

  const o = opts || {};
  const lvl = level || 0;
  const algn = normalizeAlign(o.align);
  // Merge item-level overrides with default opts
  const rPr = runProperties({
    ...o,
    bold: itemBold ?? o.bold,
    color: itemColor ?? o.color,
  });
  const bulletColor = o.bulletColor
    ? `<a:buClr>${solidFill(o.bulletColor).replace(/<\/?a:solidFill>/g, "")}</a:buClr>`
    : "";
  // ECMA-376 §21.1.2.4.14: pPr bullet children must be: buClr, buFont, buChar
  return `<a:p><a:pPr lvl="${lvl}" algn="${algn}">${bulletColor}<a:buFont typeface="Arial"/><a:buChar char="&#x2022;"/></a:pPr><a:r>${rPr}<a:t>${escapeXml(String(text))}</a:t></a:r></a:p>`;
}

function textBodyXml(
  content: string | null | undefined,
  opts: TextBodyOptions | null | undefined,
): string {
  const o = opts || {};
  const wrap = o.wordWrap !== false ? "square" : "none";
  const anchor =
    o.valign === "middle" ? "ctr" : o.valign === "bottom" ? "b" : "t";
  // Default padding increased from 0.05" (45720) to 0.15" (137160) for better text fit in shapes
  const pad = o.padding !== undefined ? Math.round(o.padding * 914400) : 137160;
  // OOXML requires at least one <a:p> in a text body
  const body = content || "<a:p/>";
  return `<p:txBody><a:bodyPr wrap="${wrap}" anchor="${anchor}" lIns="${pad}" tIns="${pad}" rIns="${pad}" bIns="${pad}"/><a:lstStyle/>${body}</p:txBody>`;
}

// ── Shape Builder Functions ──────────────────────────────────────────

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
export function textBox(opts: TextBoxOptions): ShapeFragment {
  // ── Input validation ──────────────────────────────────────────────
  _validateOptionalNumber(opts.fontSize, "textBox.fontSize", {
    min: 1,
    max: 400,
  });
  _validateOptionalNumber(opts.lineSpacing, "textBox.lineSpacing", { min: 1 });
  const bgHex = _validateOptionalHex(opts.background, "textBox.background");

  const xIn = opts.x || 0;
  const yIn = opts.y || 0;
  const wIn = opts.w || 4;
  const hIn = opts.h || 1;

  // ── Bounds validation ─────────────────────────────────────────────
  if (!opts._skipBoundsCheck) {
    validateBounds(xIn, yIn, wIn, hIn, "textBox");
  }

  // ── AutoFit: calculate fontSize to fit text in shape ──────────────
  let fontSize = opts.fontSize || 18;
  const textStr = Array.isArray(opts.text)
    ? opts.text.join("\n")
    : String(opts.text || "");

  if (opts.autoFit && textStr) {
    // Binary search for largest fontSize that fits
    let minSize = 6;
    let maxSize = opts.fontSize || 72;
    const padding = opts.padding || 0.1;
    const availW = wIn - 2 * padding;
    const availH = hIn - 2 * padding;

    while (maxSize - minSize > 1) {
      const testSize = Math.floor((minSize + maxSize) / 2);
      if (textFitsInBox(textStr, availW, availH, testSize)) {
        minSize = testSize;
      } else {
        maxSize = testSize;
      }
    }
    fontSize = minSize;
  } else if (!opts._skipBoundsCheck && textStr) {
    // Validate text overflow (throws if content won't fit)
    validateTextOverflow(textStr, wIn, hIn, fontSize, "textBox");
  }

  // Internal callers (addSlideNumbers, addFooter) pass _skipContrastCheck: true
  // because they already selected the highest-contrast colour via autoTextColor.
  // Some theme accent backgrounds don't have ANY colour meeting WCAG AA (4.5:1),
  // so the auto-selected "best available" colour must bypass strict validation.
  // Users can also pass forceColor: true to bypass contrast validation when they
  // KNOW the background and want to override the auto-selection.
  // isForceAllColors() (set via createPresentation) bypasses ALL contrast checks globally.
  const contrastRef = bgHex;
  const skipContrast =
    isForceAllColors() || opts._skipContrastCheck || opts.forceColor;
  // Text colour: validate if provided, else fall back to theme fg
  const explicitColor = skipContrast
    ? opts.color
      ? requireHex(opts.color, "textBox.color")
      : null
    : _validateOptionalColor(
        opts.color,
        "textBox.color",
        _activeTheme,
        contrastRef ? { against: contrastRef } : undefined,
      );

  const x = inches(xIn);
  const y = inches(yIn);
  const w = inches(wIn);
  const h = inches(hIn);
  const fill = bgHex ? solidFill(bgHex) : "<a:noFill/>";

  // Fall back to active theme foreground so text is always readable
  // Check for presentation-level defaultTextColor first, then theme fg
  const defaultColor = _defaultTextColor || (opts._theme || _activeTheme)?.fg;
  const resolvedOpts = explicitColor
    ? { ...opts, color: explicitColor, fontSize }
    : { ...opts, color: defaultColor, fontSize };

  let paras;
  if (Array.isArray(opts.text)) {
    paras = opts.text.map((t) => paragraphXml(t, resolvedOpts)).join("");
  } else {
    paras = paragraphXml(opts.text || "", resolvedOpts);
  }

  const { id, name } = nextShapeIdAndName("TextBox");
  return _createShapeFragment(
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${spTransform(x, y, w, h)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${fill}</p:spPr>${textBodyXml(paras, opts)}</p:sp>`,
  );
}

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
export function rect(opts: RectOptions): ShapeFragment {
  // ── Input validation ──────────────────────────────────────────────
  _validateOptionalNumber(opts.fontSize, "rect.fontSize", { min: 1, max: 400 });
  _validateOptionalNumber(opts.borderWidth, "rect.borderWidth", { min: 0 });
  _validateOptionalNumber(opts.opacity, "rect.opacity", { min: 0, max: 1 });
  const fillHex = opts.fill ? requireHex(opts.fill, "rect.fill") : "2196F3";
  _validateOptionalHex(opts.borderColor, "rect.borderColor");

  const xIn = opts.x || 0;
  const yIn = opts.y || 0;
  const wIn = opts.w || 2;
  const hIn = opts.h || 1;

  // ── Bounds validation ─────────────────────────────────────────────
  if (!opts._skipBoundsCheck) {
    validateBounds(xIn, yIn, wIn, hIn, "rect");
  }

  // Text colour must be readable against the fill (unless forceColor bypasses)
  // isForceAllColors() (set via createPresentation) bypasses ALL contrast checks globally.
  const skipContrast = isForceAllColors() || opts.forceColor;
  const explicitTextColor = skipContrast
    ? opts.color
      ? requireHex(opts.color, "rect.color")
      : null
    : _validateOptionalColor(opts.color, "rect.color", _activeTheme, {
        against: fillHex,
      });

  const x = inches(xIn);
  const y = inches(yIn);
  const w = inches(wIn);
  const h = inches(hIn);
  const prst = opts.cornerRadius ? "roundRect" : "rect";
  const fill = solidFill(fillHex, opts.opacity);
  const border = opts.borderColor
    ? `<a:ln w="${Math.round((opts.borderWidth || 1) * 12700)}">${solidFill(opts.borderColor)}</a:ln>`
    : "";
  // Auto-select readable text colour against the fill background
  const textColor = explicitTextColor || autoTextColor(fillHex);
  const textContent = opts.text
    ? textBodyXml(
        paragraphXml(opts.text, {
          fontSize: opts.fontSize || 14,
          color: textColor,
          align: "ctr",
          bold: opts.bold,
        }),
        { valign: "middle" },
      )
    : "";

  const { id, name } = nextShapeIdAndName("Rectangle");
  return _createShapeFragment(
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${spTransform(x, y, w, h)}<a:prstGeom prst="${prst}"><a:avLst/></a:prstGeom>${fill}${border}</p:spPr>${textContent}</p:sp>`,
  );
}

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
export function bulletList(opts: BulletListOptions): ShapeFragment {
  // ── Input validation ──────────────────────────────────────────────
  if (opts.items != null) requireArray(opts.items, "bulletList.items");
  _validateOptionalNumber(opts.fontSize, "bulletList.fontSize", {
    min: 1,
    max: 400,
  });
  _validateOptionalNumber(opts.lineSpacing, "bulletList.lineSpacing", {
    min: 1,
  });
  _validateOptionalColor(opts.color, "bulletList.color");
  _validateOptionalHex(opts.bulletColor, "bulletList.bulletColor");

  const xIn = opts.x || 0;
  const yIn = opts.y || 0;
  const wIn = opts.w || 8;
  const hIn = opts.h || 4;

  // ── Bounds validation ─────────────────────────────────────────────
  validateBounds(xIn, yIn, wIn, hIn, "bulletList");

  const x = inches(xIn);
  const y = inches(yIn);
  const w = inches(wIn);
  const h = inches(hIn);
  // Fall back to defaultTextColor, then theme foreground so bullets are always readable
  const defaultColor =
    opts.color || _defaultTextColor || (opts._theme || _activeTheme)?.fg;
  const itemOpts = {
    fontSize: opts.fontSize || 16,
    color: defaultColor,
    bulletColor: opts.bulletColor,
    lineSpacing: opts.lineSpacing || 24,
  };
  const paras = (opts.items || [])
    .map((item) => bulletParagraph(item, itemOpts, 0))
    .join("");

  const { id, name } = nextShapeIdAndName("TextBox");
  return _createShapeFragment(
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${spTransform(x, y, w, h)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>${textBodyXml(paras, opts)}</p:sp>`,
  );
}

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
export function numberedList(opts: NumberedListOptions): ShapeFragment {
  // ── Input validation ──────────────────────────────────────────────
  if (opts.items != null) requireArray(opts.items, "numberedList.items");
  _validateOptionalNumber(opts.fontSize, "numberedList.fontSize", {
    min: 1,
    max: 400,
  });
  _validateOptionalNumber(opts.lineSpacing, "numberedList.lineSpacing", {
    min: 1,
  });
  _validateOptionalNumber(opts.startAt, "numberedList.startAt", { min: 0 });
  _validateOptionalColor(opts.color, "numberedList.color");

  // ── Bounds validation ─────────────────────────────────────────────
  const xIn = opts.x || 0;
  const yIn = opts.y || 0;
  const wIn = opts.w || 8;
  const hIn = opts.h || 4;
  if (!opts._skipBoundsCheck) {
    validateBounds(xIn, yIn, wIn, hIn, "numberedList");
  }

  const x = inches(xIn);
  const y = inches(yIn);
  const w = inches(wIn);
  const h = inches(hIn);
  const startAt = opts.startAt || 1;
  // Fall back to defaultTextColor, then theme foreground so items are always readable
  const defaultColor =
    opts.color || _defaultTextColor || (opts._theme || _activeTheme)?.fg;
  const paras = (opts.items || [])
    .map((item, idx) => {
      const num = startAt + idx;
      const rPr = runProperties({
        fontSize: opts.fontSize || 16,
        color: defaultColor,
      });
      return `<a:p><a:pPr algn="l"><a:buFont typeface="Arial"/><a:buAutoNum type="arabicPeriod" startAt="${startAt}"/></a:pPr><a:r>${rPr}<a:t>${escapeXml(String(item))}</a:t></a:r></a:p>`;
    })
    .join("");

  const { id, name } = nextShapeIdAndName("TextBox");
  return _createShapeFragment(
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${spTransform(x, y, w, h)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>${textBodyXml(paras, opts)}</p:sp>`,
  );
}

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
export function imagePlaceholder(opts: ImagePlaceholderOptions): ShapeFragment {
  return rect({
    x: opts.x,
    y: opts.y,
    w: opts.w || 4,
    h: opts.h || 3,
    fill: opts.fill || "3D4450",
    text: opts.label || "📷 Image",
    fontSize: 14,
    color: opts.color || "B0B8C0", // Light gray - passes WCAG AA on 3D4450 (4.89:1)
    cornerRadius: 4,
  });
}

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
export function statBox(opts: StatBoxOptions): ShapeFragment {
  // ── Input validation ──────────────────────────────────────────────
  _validateOptionalNumber(opts.valueSize, "statBox.valueSize", {
    min: 1,
    max: 400,
  });
  _validateOptionalNumber(opts.labelSize, "statBox.labelSize", {
    min: 1,
    max: 400,
  });
  const bgHex = _validateOptionalHex(opts.background, "statBox.background");
  // Value/label colours must be readable against the statBox background
  // forceColor bypasses WCAG validation for brand colours or artistic effect
  // isForceAllColors() (set via createPresentation) bypasses ALL contrast checks globally.
  const skipContrast = isForceAllColors() || opts.forceColor;
  const contrastRef = bgHex ? { against: bgHex } : undefined;
  const validatedValueColor = skipContrast
    ? opts.valueColor
      ? requireHex(opts.valueColor, "statBox.valueColor")
      : null
    : _validateOptionalColor(
        opts.valueColor,
        "statBox.valueColor",
        _activeTheme,
        contrastRef,
      );
  const validatedLabelColor = skipContrast
    ? opts.labelColor
      ? requireHex(opts.labelColor, "statBox.labelColor")
      : null
    : _validateOptionalColor(
        opts.labelColor,
        "statBox.labelColor",
        _activeTheme,
        contrastRef,
      );

  // ── Bounds validation ─────────────────────────────────────────────
  const xIn = opts.x || 0;
  const yIn = opts.y || 0;
  const wIn = opts.w || 3;
  const hIn = opts.h || 2;
  if (!opts._skipBoundsCheck) {
    validateBounds(xIn, yIn, wIn, hIn, "statBox");
  }

  const x = inches(xIn);
  const y = inches(yIn);
  const w = inches(wIn);
  const h = inches(hIn);
  const fill = bgHex ? solidFill(bgHex) : "<a:noFill/>";

  // When a background fill is set, auto-select readable text colours.
  // When no background, fall back to defaultTextColor, then theme foreground
  // so values and labels are always visible on the slide background.
  const statBoxDefaultColor = bgHex
    ? autoTextColor(bgHex)
    : _defaultTextColor || (opts._theme || _activeTheme)?.fg;
  const valuePara = paragraphXml(opts.value || "", {
    fontSize: opts.valueSize || 36,
    color: validatedValueColor || opts.valueColor || statBoxDefaultColor,
    bold: true,
    align: "ctr",
  });
  const labelPara = paragraphXml(opts.label || "", {
    fontSize: opts.labelSize || 14,
    color: validatedLabelColor || opts.labelColor || statBoxDefaultColor,
    align: "ctr",
  });

  const { id, name } = nextShapeIdAndName("TextBox");
  return _createShapeFragment(
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${spTransform(x, y, w, h)}<a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom>${fill}</p:spPr>${textBodyXml(valuePara + labelPara, { valign: "middle" })}</p:sp>`,
  );
}

// ── Lines, Arrows, and Connectors ────────────────────────────────────

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
export function line(opts: LineOptions): ShapeFragment {
  // ── Input validation ──────────────────────────────────────────────
  _validateOptionalNumber(opts.width, "line.width", { min: 0.1, max: 100 });
  _validateOptionalHex(opts.color, "line.color");
  if (opts.dash && opts.dash !== "solid") {
    requireEnum(opts.dash, "line.dash", VALID_DASHES);
  }

  const x1 = inches(opts.x1 || 0);
  const y1 = inches(opts.y1 || 0);
  const x2 = inches(opts.x2 || 1);
  const y2 = inches(opts.y2 || 1);
  // Use theme subtle colour for lines when no colour specified
  const color = hexColor(
    opts.color || (opts._theme ? opts._theme.subtle : "666666"),
  );
  const w = Math.round((opts.width || 1.5) * 12700);

  // Calculate position and extent from endpoints
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const cx = Math.abs(x2 - x1) || 1; // min 1 EMU to avoid zero-size
  const cy = Math.abs(y2 - y1) || 1;
  const flipH = x2 < x1 ? ' flipH="1"' : "";
  const flipV = y2 < y1 ? ' flipV="1"' : "";
  const dashXml =
    opts.dash && opts.dash !== "solid"
      ? `<a:prstDash val="${opts.dash}"/>`
      : "";

  const { id, name } = nextShapeIdAndName("Line");
  return _createShapeFragment(
    `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr><a:xfrm${flipH}${flipV}><a:off x="${left}" y="${top}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="${w}"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill>${dashXml}</a:ln></p:spPr></p:cxnSp>`,
  );
}

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
export function arrow(opts: ArrowOptions): ShapeFragment {
  // ── Input validation ──────────────────────────────────────────────
  _validateOptionalNumber(opts.width, "arrow.width", { min: 0.1, max: 100 });
  _validateOptionalHex(opts.color, "arrow.color");
  if (opts.dash && opts.dash !== "solid") {
    requireEnum(opts.dash, "arrow.dash", VALID_DASHES);
  }
  if (opts.headType) {
    requireEnum(opts.headType, "arrow.headType", VALID_HEAD_TYPES);
  }

  const x1 = inches(opts.x1 || 0);
  const y1 = inches(opts.y1 || 0);
  const x2 = inches(opts.x2 || 1);
  const y2 = inches(opts.y2 || 1);
  // Use theme subtle colour for arrows when no colour specified
  const color = hexColor(
    opts.color || (opts._theme ? opts._theme.subtle : "666666"),
  );
  const w = Math.round((opts.width || 1.5) * 12700);
  const headType = opts.headType || "triangle";

  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const cx = Math.abs(x2 - x1) || 1;
  const cy = Math.abs(y2 - y1) || 1;
  const flipH = x2 < x1 ? ' flipH="1"' : "";
  const flipV = y2 < y1 ? ' flipV="1"' : "";
  const dashXml =
    opts.dash && opts.dash !== "solid"
      ? `<a:prstDash val="${opts.dash}"/>`
      : "";
  const tailArrow = `<a:tailEnd type="${headType}" w="med" len="med"/>`;
  const headArrow = opts.bothEnds
    ? `<a:headEnd type="${headType}" w="med" len="med"/>`
    : "";

  const { id, name } = nextShapeIdAndName("Arrow");
  return _createShapeFragment(
    `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr><a:xfrm${flipH}${flipV}><a:off x="${left}" y="${top}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="${w}"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill>${dashXml}${headArrow}${tailArrow}</a:ln></p:spPr></p:cxnSp>`,
  );
}

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
export function circle(opts: CircleOptions): ShapeFragment {
  // ── Input validation ──────────────────────────────────────────────
  _validateOptionalNumber(opts.fontSize, "circle.fontSize", {
    min: 1,
    max: 400,
  });
  _validateOptionalNumber(opts.borderWidth, "circle.borderWidth", { min: 0 });
  const fillHex = opts.fill ? requireHex(opts.fill, "circle.fill") : "2196F3";
  _validateOptionalHex(opts.borderColor, "circle.borderColor");
  // Text must be readable against the circle fill
  const explicitTextColor = _validateOptionalColor(
    opts.color,
    "circle.color",
    _activeTheme,
    { against: fillHex },
  );

  // Calculate top-left from center coordinates
  const xIn = (opts.x || 0) - (opts.w || 1) / 2;
  const yIn = (opts.y || 0) - (opts.h || opts.w || 1) / 2;
  const wIn = opts.w || 1;
  const hIn = opts.h || opts.w || 1;

  // ── Bounds validation ─────────────────────────────────────────────
  if (!opts._skipBoundsCheck) {
    validateBounds(xIn, yIn, wIn, hIn, "circle");
  }

  const x = inches(xIn);
  const y = inches(yIn);
  const w = inches(wIn);
  const h = inches(hIn);
  const fill = solidFill(fillHex);
  const border = opts.borderColor
    ? `<a:ln w="${Math.round((opts.borderWidth || 1) * 12700)}">${solidFill(opts.borderColor)}</a:ln>`
    : "";
  // Auto-select readable text colour against the circle fill
  const textColor = explicitTextColor || autoTextColor(fillHex);
  const textContent = opts.text
    ? textBodyXml(
        paragraphXml(opts.text, {
          fontSize: opts.fontSize || 14,
          color: textColor,
          align: "ctr",
          bold: opts.bold,
        }),
        { valign: "middle" },
      )
    : "";

  const { id, name } = nextShapeIdAndName("Ellipse");
  return _createShapeFragment(
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${spTransform(x, y, w, h)}<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>${fill}${border}</p:spPr>${textContent}</p:sp>`,
  );
}

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
export function callout(opts: CalloutOptions): ShapeFragment {
  // ── Input validation ──────────────────────────────────────────────
  _validateOptionalNumber(opts.fontSize, "callout.fontSize", {
    min: 1,
    max: 400,
  });
  _validateOptionalHex(opts.accentColor, "callout.accentColor");
  // Resolve the actual fill that will be used (default F5F5F5)
  const resolvedBg = opts.background || "F5F5F5";
  const bgHex = requireHex(resolvedBg, "callout.background");
  // Text must be readable against the actual callout fill — not the theme bg
  _validateOptionalColor(opts.color, "callout.color", _activeTheme, {
    against: bgHex,
  });

  const x = inches(opts.x || 0);
  const y = inches(opts.y || 0);
  const w = inches(opts.w || 8);
  const h = inches(opts.h || 1);
  const accentColor = hexColor(opts.accentColor || "2196F3");
  const bg = opts.background || "F5F5F5";

  // Accent bar (thin rectangle on the left)
  const barShape = nextShapeIdAndName("Rectangle");
  const accentBar = `<p:sp><p:nvSpPr><p:cNvPr id="${barShape.id}" name="${barShape.name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${spTransform(x, y, inches(0.06), h)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${solidFill(accentColor)}</p:spPr></p:sp>`;

  // Auto-select readable text colour against the callout background
  const mainBox = rect({
    x: (opts.x || 0) + 0.08,
    y: opts.y,
    w: (opts.w || 8) - 0.08,
    h: opts.h || 1,
    fill: bg,
    text: opts.text,
    fontSize: opts.fontSize || 14,
    color: opts.color || autoTextColor(bg),
  });

  return _createShapeFragment(accentBar + mainBox.toString());
}

// ── Icons (Preset Shapes) ────────────────────────────────────────────

/** Map of friendly icon names to OOXML preset shape types. */
const ICON_SHAPES: Record<string, string> = {
  // Status indicators - NOTE: checkmark/warning moved to SVG_ICONS for better rendering
  x: "mathMultiply",
  cross: "mathMultiply",
  info: "flowChartConnector", // circle

  // Stars and decorative
  star: "star5",
  star4: "star4",
  star5: "star5", // explicit alias
  star6: "star6",
  star8: "star8",
  star10: "star10",
  star12: "star12",
  heart: "heart",
  lightning: "lightningBolt",
  lightningBolt: "lightningBolt", // alias for LLMs that guess camelCase
  bolt: "lightningBolt", // alias
  ribbon: "ribbon2",

  // Geometric
  diamond: "diamond",
  pentagon: "pentagon",
  hexagon: "hexagon",
  heptagon: "heptagon",
  octagon: "octagon",
  decagon: "decagon",
  dodecagon: "dodecagon",
  triangle: "triangle",
  circle: "ellipse",
  oval: "ellipse",
  rect: "rect",
  square: "rect", // alias for rect
  rectangle: "rect", // alias for rect
  "round-rect": "roundRect",
  "snip-rect": "snip1Rect",
  plaque: "plaque",
  bevel: "bevel",
  donut: "donut",
  pie: "pie",
  arc: "arc",
  chord: "chord",
  "cross-shape": "plus",

  // Arrows
  "right-arrow": "rightArrow",
  "left-arrow": "leftArrow",
  "up-arrow": "upArrow",
  "down-arrow": "downArrow",
  "curved-right": "curvedRightArrow",
  "curved-left": "curvedLeftArrow",
  "curved-up": "curvedUpArrow",
  "curved-down": "curvedDownArrow",
  "u-turn": "uturnArrow",
  "circular-arrow": "circularArrow",

  // Technical/computing
  cloud: "cloud",
  database: "can",
  cylinder: "can",
  cube: "cube",
  gear: "gear6",
  gear9: "gear9",
  cog: "gear6", // alias for gear
  settings: "gear6", // alias for gear
  funnel: "funnel",
  filter: "funnel", // alias - LLMs often use "filter"

  // Environment
  sun: "sun",
  moon: "moon",

  // Flowchart
  process: "flowChartProcess",
  decision: "flowChartDecision",
  document: "flowChartDocument",
  data: "flowChartInputOutput",
  terminal: "flowChartTerminator",
  "manual-input": "flowChartManualInput",
  "manual-op": "flowChartManualOperation",
  connector: "flowChartConnector",
  offpage: "flowChartOffpageConnector",
  sort: "flowChartSort",
  merge: "flowChartMerge",
  extract: "flowChartExtract",
  "stored-data": "flowChartOnlineStorage",
  delay: "flowChartDelay",
  display: "flowChartDisplay",
  preparation: "flowChartPreparation",
  "multi-doc": "flowChartMultidocument",

  // Math and symbols
  plus: "mathPlus",
  minus: "mathMinus",
  multiply: "mathMultiply",
  divide: "mathDivide",
  equal: "mathEqual",
  "not-equal": "mathNotEqual",

  // Actions
  "no-symbol": "noSmoking",
  prohibited: "noSmoking",

  // Brackets and frames
  "left-bracket": "leftBracket",
  "right-bracket": "rightBracket",
  "left-brace": "leftBrace",
  "right-brace": "rightBrace",
  frame: "frame",

  // Callouts
  "callout-rect": "wedgeRectCallout",
  "callout-round": "wedgeRoundRectCallout",
  "callout-oval": "wedgeEllipseCallout",
  "callout-cloud": "cloudCallout",

  // Action buttons (OOXML built-in)
  home: "actionButtonHome",
  help: "actionButtonHelp",
  "info-button": "actionButtonInformation",
  back: "actionButtonBackPrevious",
  forward: "actionButtonForwardNext",
  beginning: "actionButtonBeginning",
  end: "actionButtonEnd",
  return: "actionButtonReturn",
  doc: "actionButtonDocument",
  sound: "actionButtonSound",
  movie: "actionButtonMovie",
  blank: "actionButtonBlank",

  // Legacy aliases (deprecated - prefer SVG versions)
  // shield: "flowChartPreparation", // REMOVED - was mapping to hexagon, not a shield!
};

/** SVG path icons for tech concepts not available as OOXML presets */
const SVG_ICONS: Record<
  string,
  { d: string; viewBox?: { w: number; h: number } }
> = {
  // Status indicators (Lucide)
  check: {
    d: "M20 6L9 17l-5-5",
  },
  checkmark: {
    d: "M20 6L9 17l-5-5",
  },
  "check-circle": {
    d: "M22 11.08V12a10 10 0 11-5.93-9.14M22 4L12 14.01l-3-3",
  },
  warning: {
    d: "M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z",
  },
  "alert-triangle": {
    d: "M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z",
  },
  // Layers/stack - architecture diagrams (Lucide)
  layers: {
    d: "M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5",
  },
  stack: {
    d: "M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5",
  },
  // Lock - security (Lucide)
  lock: {
    d: "M19 11H5a2 2 0 00-2 2v7a2 2 0 002 2h14a2 2 0 002-2v-7a2 2 0 00-2-2zM7 11V7a5 5 0 0110 0v4",
  },
  // Unlock
  unlock: {
    d: "M19 11H5a2 2 0 00-2 2v7a2 2 0 002 2h14a2 2 0 002-2v-7a2 2 0 00-2-2zM7 11V7a5 5 0 019.9-1",
  },
  // Server (Lucide)
  server: {
    d: "M2 5a2 2 0 012-2h16a2 2 0 012 2v4a2 2 0 01-2 2H4a2 2 0 01-2-2V5zM2 15a2 2 0 012-2h16a2 2 0 012 2v4a2 2 0 01-2 2H4a2 2 0 01-2-2v-4zM6 7h.01M6 17h.01",
  },
  // Code brackets (Lucide)
  code: {
    d: "M16 18l6-6-6-6M8 6l-6 6 6 6",
  },
  // Terminal (Lucide - different from flowchart terminal)
  "code-terminal": {
    d: "M4 17l6-6-6-6M12 19h8",
  },
  // User/person (Lucide)
  user: {
    d: "M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z",
  },
  person: {
    d: "M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z",
  },
  // Users/team (Lucide)
  users: {
    d: "M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75M9 7a4 4 0 100 8 4 4 0 000-8z",
  },
  team: {
    d: "M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75M9 7a4 4 0 100 8 4 4 0 000-8z",
  },
  // Folder (Lucide)
  folder: {
    d: "M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2v11z",
  },
  // File (Lucide)
  file: {
    d: "M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zM14 2v6h6",
  },
  // Settings/cog (Lucide)
  settings: {
    d: "M12.22 2h-.44a2 2 0 00-2 2v.18a2 2 0 01-1 1.73l-.43.25a2 2 0 01-2 0l-.15-.08a2 2 0 00-2.73.73l-.22.38a2 2 0 00.73 2.73l.15.1a2 2 0 011 1.72v.51a2 2 0 01-1 1.74l-.15.09a2 2 0 00-.73 2.73l.22.38a2 2 0 002.73.73l.15-.08a2 2 0 012 0l.43.25a2 2 0 011 1.73V20a2 2 0 002 2h.44a2 2 0 002-2v-.18a2 2 0 011-1.73l.43-.25a2 2 0 012 0l.15.08a2 2 0 002.73-.73l.22-.39a2 2 0 00-.73-2.73l-.15-.08a2 2 0 01-1-1.74v-.5a2 2 0 011-1.74l.15-.09a2 2 0 00.73-2.73l-.22-.38a2 2 0 00-2.73-.73l-.15.08a2 2 0 01-2 0l-.43-.25a2 2 0 01-1-1.73V4a2 2 0 00-2-2zM12 15a3 3 0 100-6 3 3 0 000 6z",
  },
  cog: {
    d: "M12.22 2h-.44a2 2 0 00-2 2v.18a2 2 0 01-1 1.73l-.43.25a2 2 0 01-2 0l-.15-.08a2 2 0 00-2.73.73l-.22.38a2 2 0 00.73 2.73l.15.1a2 2 0 011 1.72v.51a2 2 0 01-1 1.74l-.15.09a2 2 0 00-.73 2.73l.22.38a2 2 0 002.73.73l.15-.08a2 2 0 012 0l.43.25a2 2 0 011 1.73V20a2 2 0 002 2h.44a2 2 0 002-2v-.18a2 2 0 011-1.73l.43-.25a2 2 0 012 0l.15.08a2 2 0 002.73-.73l.22-.39a2 2 0 00-.73-2.73l-.15-.08a2 2 0 01-1-1.74v-.5a2 2 0 011-1.74l.15-.09a2 2 0 00.73-2.73l-.22-.38a2 2 0 00-2.73-.73l-.15.08a2 2 0 01-2 0l-.43-.25a2 2 0 01-1-1.73V4a2 2 0 00-2-2zM12 15a3 3 0 100-6 3 3 0 000 6z",
  },
  // Globe/network (Lucide)
  globe: {
    d: "M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10zM2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z",
  },
  network: {
    d: "M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10zM2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z",
  },
  // Key (Lucide)
  key: {
    d: "M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.778-7.778zM15.5 7.5l3 3L22 7l-3-3z",
  },
  // Shield (Lucide - better than OOXML)
  shield: {
    d: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
  },
  "shield-icon": {
    d: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
  },
  security: {
    d: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
  },
  // Zap/lightning (Lucide)
  zap: {
    d: "M13 2L3 14h9l-1 8 10-12h-9l1-8z",
  },
  // Package/box (Lucide)
  package: {
    d: "M16.5 9.4l-9-5.19M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16zM3.27 6.96L12 12.01l8.73-5.05M12 22.08V12",
  },
  box: {
    d: "M16.5 9.4l-9-5.19M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16zM3.27 6.96L12 12.01l8.73-5.05M12 22.08V12",
  },
  // Cpu/chip (Lucide)
  cpu: {
    d: "M18 4H6a2 2 0 00-2 2v12a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2zM9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3M9 9h6v6H9V9z",
  },
  chip: {
    d: "M18 4H6a2 2 0 00-2 2v12a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2zM9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3M9 9h6v6H9V9z",
  },
  // Wifi (Lucide)
  wifi: {
    d: "M5 12.55a11 11 0 0114.08 0M1.42 9a16 16 0 0121.16 0M8.53 16.11a6 6 0 016.95 0M12 20h.01",
  },
  // Link (Lucide)
  link: {
    d: "M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71",
  },
  // Search (Lucide)
  search: {
    d: "M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.35-4.35",
  },
  // Eye (Lucide)
  eye: {
    d: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 15a3 3 0 100-6 3 3 0 000 6z",
  },
  // Clock (Lucide)
  clock: {
    d: "M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10zM12 6v6l4 2",
  },
  // Calendar (Lucide)
  calendar: {
    d: "M19 4H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V6a2 2 0 00-2-2zM16 2v4M8 2v4M3 10h18",
  },
  // Mail (Lucide)
  mail: {
    d: "M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2zM22 6l-10 7L2 6",
  },
  email: {
    d: "M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2zM22 6l-10 7L2 6",
  },
  // Bell/notification (Lucide)
  bell: {
    d: "M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0",
  },
  notification: {
    d: "M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0",
  },
  // Download (Lucide)
  download: {
    d: "M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3",
  },
  // Upload (Lucide)
  upload: {
    d: "M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12",
  },
  // Refresh (Lucide)
  refresh: {
    d: "M1 4v6h6M23 20v-6h-6M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15",
  },
  // API/plug (Lucide)
  api: {
    d: "M12 22v-5M9 8V2M15 8V2M20 8v6a2 2 0 01-2 2H6a2 2 0 01-2-2V8a2 2 0 012-2h12a2 2 0 012 2z",
  },
  plug: {
    d: "M12 22v-5M9 8V2M15 8V2M20 8v6a2 2 0 01-2 2H6a2 2 0 01-2-2V8a2 2 0 012-2h12a2 2 0 012 2z",
  },
  // Chart icons (Lucide-style) - common LLM requests
  "pie-chart": {
    d: "M21 12a9 9 0 11-9-9M21 12a9 9 0 00-9-9M21 12H12V3",
  },
  "bar-chart": {
    d: "M12 20V10M18 20V4M6 20v-4",
  },
  "line-chart": {
    d: "M3 3v18h18M7 16l4-4 4 4 5-6",
  },
  chart: {
    d: "M12 20V10M18 20V4M6 20v-4", // alias for bar-chart
  },
  // Activity/pulse (Lucide)
  activity: {
    d: "M22 12h-4l-3 9L9 3l-3 9H2",
  },
  pulse: {
    d: "M22 12h-4l-3 9L9 3l-3 9H2",
  },
  // Trending (Lucide)
  "trending-up": {
    d: "M23 6l-9.5 9.5-5-5L1 18M17 6h6v6",
  },
  "trending-down": {
    d: "M23 18l-9.5-9.5-5 5L1 6M17 18h6v-6",
  },
};

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
export function icon(opts: IconOptions): ShapeFragment {
  // ── Input validation ──────────────────────────────────────────────
  _validateOptionalNumber(opts.fontSize, "icon.fontSize", { min: 1, max: 400 });
  _validateOptionalHex(opts.fill, "icon.fill");

  // Use theme accent for icon fill when no explicit fill specified
  const fillHex = opts.fill || (opts._theme ? opts._theme.accent1 : "2196F3");

  // ── Bounds validation ─────────────────────────────────────────────
  const xIn = opts.x || 0;
  const yIn = opts.y || 0;
  const wIn = opts.w || 0.5;
  const hIn = opts.h || opts.w || 0.5;
  if (!opts._skipBoundsCheck) {
    validateBounds(xIn, yIn, wIn, hIn, "icon");
  }

  // Check if shape is an SVG icon — delegate to svgPath()
  if (opts.shape && SVG_ICONS[opts.shape]) {
    const svg = SVG_ICONS[opts.shape];
    return svgPath({
      x: xIn,
      y: yIn,
      w: wIn,
      h: hIn,
      d: svg.d,
      viewBox: svg.viewBox || { w: 24, h: 24 },
      fill: fillHex,
      stroke: fillHex, // Use stroke for line-based Lucide icons
      strokeWidth: 1.5,
      _skipBoundsCheck: true, // Already validated above
    });
  }

  // Validate that the icon shape exists
  if (opts.shape && !ICON_SHAPES[opts.shape]) {
    const availableShapes = Object.keys(ICON_SHAPES)
      .concat(Object.keys(SVG_ICONS))
      .sort();
    throw new Error(
      `icon: unknown shape '${opts.shape}'. ` +
        `Available shapes include: ${availableShapes.slice(0, 20).join(", ")}... ` +
        `(${availableShapes.length} total)`,
    );
  }

  const x = inches(xIn);
  const y = inches(yIn);
  const w = inches(wIn);
  const h = inches(hIn);
  // Use known ICON_SHAPES value (validated above)
  const prst =
    opts.shape && ICON_SHAPES[opts.shape] ? ICON_SHAPES[opts.shape] : "rect";
  // Use theme accent for icon fill when no explicit fill specified
  const fill = solidFill(fillHex);
  const textContent = opts.text
    ? textBodyXml(
        paragraphXml(opts.text, {
          fontSize: opts.fontSize || 12,
          color: opts.color || autoTextColor(fillHex),
          align: "ctr",
        }),
        { valign: "middle" },
      )
    : "";

  const { id, name } = nextShapeIdAndName("Shape");
  return _createShapeFragment(
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${spTransform(x, y, w, h)}<a:prstGeom prst="${prst}"><a:avLst/></a:prstGeom>${fill}</p:spPr>${textContent}</p:sp>`,
  );
}

// ── SVG Path Parser ─────────────────────────────────────────────────

/**
 * Parse SVG path data into OOXML path commands.
 * Supports: M/m (moveTo), L/l (lineTo), H/h (horizontal), V/v (vertical),
 * C/c (cubic bezier), S/s (smooth bezier), Q/q (quadratic), Z/z (close).
 * Coordinates are normalized to OOXML EMUs based on viewBox.
 * @internal
 */
function parseSvgPath(
  d: string,
  viewBox: { x?: number; y?: number; w: number; h: number } | undefined,
): string {
  const vb = viewBox || { x: 0, y: 0, w: 24, h: 24 }; // default 24x24 viewBox
  const cmds: string[] = [];
  // Regex to tokenize SVG path: command letters and numbers
  const tokens =
    d.match(
      /[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g,
    ) || [];
  let i = 0;
  let x = 0,
    y = 0; // current point
  let sx = 0,
    sy = 0; // start of subpath
  let lastCmd = "";
  let lastCx = 0,
    lastCy = 0; // last control point for S/T

  // Convert to EMU, clamping to valid range and handling NaN
  const toEmu = (val: number, max: number) => {
    if (!Number.isFinite(val) || !Number.isFinite(max) || max === 0) return 0;
    // Clamp to valid OOXML range [0, 100000] to prevent malformed output
    const emu = Math.round((val / max) * 100000);
    return Math.max(0, Math.min(100000, emu));
  };
  // Parse number, returning 0 for invalid values
  const num = () => {
    if (i >= tokens.length) return 0;
    const val = parseFloat(tokens[i++]);
    return Number.isFinite(val) ? val : 0;
  };

  while (i < tokens.length) {
    let cmd = tokens[i];
    if (/[MmLlHhVvCcSsQqTtAaZz]/.test(cmd)) {
      i++;
    } else {
      // Implicit repeat of last command
      cmd = lastCmd === "M" ? "L" : lastCmd === "m" ? "l" : lastCmd;
    }

    switch (cmd) {
      case "M":
        x = num();
        y = num();
        sx = x;
        sy = y;
        cmds.push(
          `<a:moveTo><a:pt x="${toEmu(x, vb.w)}" y="${toEmu(y, vb.h)}"/></a:moveTo>`,
        );
        lastCmd = "M";
        break;
      case "m":
        x += num();
        y += num();
        sx = x;
        sy = y;
        cmds.push(
          `<a:moveTo><a:pt x="${toEmu(x, vb.w)}" y="${toEmu(y, vb.h)}"/></a:moveTo>`,
        );
        lastCmd = "m";
        break;
      case "L":
        x = num();
        y = num();
        cmds.push(
          `<a:lnTo><a:pt x="${toEmu(x, vb.w)}" y="${toEmu(y, vb.h)}"/></a:lnTo>`,
        );
        lastCmd = "L";
        break;
      case "l":
        x += num();
        y += num();
        cmds.push(
          `<a:lnTo><a:pt x="${toEmu(x, vb.w)}" y="${toEmu(y, vb.h)}"/></a:lnTo>`,
        );
        lastCmd = "l";
        break;
      case "H":
        x = num();
        cmds.push(
          `<a:lnTo><a:pt x="${toEmu(x, vb.w)}" y="${toEmu(y, vb.h)}"/></a:lnTo>`,
        );
        lastCmd = "H";
        break;
      case "h":
        x += num();
        cmds.push(
          `<a:lnTo><a:pt x="${toEmu(x, vb.w)}" y="${toEmu(y, vb.h)}"/></a:lnTo>`,
        );
        lastCmd = "h";
        break;
      case "V":
        y = num();
        cmds.push(
          `<a:lnTo><a:pt x="${toEmu(x, vb.w)}" y="${toEmu(y, vb.h)}"/></a:lnTo>`,
        );
        lastCmd = "V";
        break;
      case "v":
        y += num();
        cmds.push(
          `<a:lnTo><a:pt x="${toEmu(x, vb.w)}" y="${toEmu(y, vb.h)}"/></a:lnTo>`,
        );
        lastCmd = "v";
        break;
      case "C": {
        const x1 = num(),
          y1 = num(),
          x2 = num(),
          y2 = num();
        x = num();
        y = num();
        lastCx = x2;
        lastCy = y2;
        cmds.push(
          `<a:cubicBezTo><a:pt x="${toEmu(x1, vb.w)}" y="${toEmu(y1, vb.h)}"/>` +
            `<a:pt x="${toEmu(x2, vb.w)}" y="${toEmu(y2, vb.h)}"/>` +
            `<a:pt x="${toEmu(x, vb.w)}" y="${toEmu(y, vb.h)}"/></a:cubicBezTo>`,
        );
        lastCmd = "C";
        break;
      }
      case "c": {
        const dx1 = num(),
          dy1 = num(),
          dx2 = num(),
          dy2 = num(),
          dx = num(),
          dy = num();
        const x1 = x + dx1,
          y1 = y + dy1,
          x2 = x + dx2,
          y2 = y + dy2;
        x += dx;
        y += dy;
        lastCx = x2;
        lastCy = y2;
        cmds.push(
          `<a:cubicBezTo><a:pt x="${toEmu(x1, vb.w)}" y="${toEmu(y1, vb.h)}"/>` +
            `<a:pt x="${toEmu(x2, vb.w)}" y="${toEmu(y2, vb.h)}"/>` +
            `<a:pt x="${toEmu(x, vb.w)}" y="${toEmu(y, vb.h)}"/></a:cubicBezTo>`,
        );
        lastCmd = "c";
        break;
      }
      case "S": {
        // Smooth curve - first control point is reflection of last
        const cx1 = 2 * x - lastCx,
          cy1 = 2 * y - lastCy;
        const x2 = num(),
          y2 = num();
        x = num();
        y = num();
        lastCx = x2;
        lastCy = y2;
        cmds.push(
          `<a:cubicBezTo><a:pt x="${toEmu(cx1, vb.w)}" y="${toEmu(cy1, vb.h)}"/>` +
            `<a:pt x="${toEmu(x2, vb.w)}" y="${toEmu(y2, vb.h)}"/>` +
            `<a:pt x="${toEmu(x, vb.w)}" y="${toEmu(y, vb.h)}"/></a:cubicBezTo>`,
        );
        lastCmd = "S";
        break;
      }
      case "s": {
        const cx1 = 2 * x - lastCx,
          cy1 = 2 * y - lastCy;
        const dx2 = num(),
          dy2 = num(),
          dx = num(),
          dy = num();
        const x2 = x + dx2,
          y2 = y + dy2;
        x += dx;
        y += dy;
        lastCx = x2;
        lastCy = y2;
        cmds.push(
          `<a:cubicBezTo><a:pt x="${toEmu(cx1, vb.w)}" y="${toEmu(cy1, vb.h)}"/>` +
            `<a:pt x="${toEmu(x2, vb.w)}" y="${toEmu(y2, vb.h)}"/>` +
            `<a:pt x="${toEmu(x, vb.w)}" y="${toEmu(y, vb.h)}"/></a:cubicBezTo>`,
        );
        lastCmd = "s";
        break;
      }
      case "Q": {
        const x1 = num(),
          y1 = num();
        x = num();
        y = num();
        lastCx = x1;
        lastCy = y1;
        cmds.push(
          `<a:quadBezTo><a:pt x="${toEmu(x1, vb.w)}" y="${toEmu(y1, vb.h)}"/>` +
            `<a:pt x="${toEmu(x, vb.w)}" y="${toEmu(y, vb.h)}"/></a:quadBezTo>`,
        );
        lastCmd = "Q";
        break;
      }
      case "q": {
        const dx1 = num(),
          dy1 = num(),
          dx = num(),
          dy = num();
        const x1 = x + dx1,
          y1 = y + dy1;
        x += dx;
        y += dy;
        lastCx = x1;
        lastCy = y1;
        cmds.push(
          `<a:quadBezTo><a:pt x="${toEmu(x1, vb.w)}" y="${toEmu(y1, vb.h)}"/>` +
            `<a:pt x="${toEmu(x, vb.w)}" y="${toEmu(y, vb.h)}"/></a:quadBezTo>`,
        );
        lastCmd = "q";
        break;
      }
      case "Z":
      case "z":
        cmds.push("<a:close/>");
        x = sx;
        y = sy;
        lastCmd = "Z";
        break;
      case "A":
      case "a": {
        // SVG arc: rx ry x-axis-rotation large-arc-flag sweep-flag x y
        const rx = Math.abs(num());
        const ry = Math.abs(num());
        const xAxisRotation = num(); // in degrees (unused - we approximate anyway)
        const largeArc = num() !== 0;
        const sweep = num() !== 0;
        let endX = num(),
          endY = num();

        // Convert relative to absolute
        if (cmd === "a") {
          endX += x;
          endY += y;
        }

        // Handle degenerate cases - just draw a line
        if (rx === 0 || ry === 0 || (x === endX && y === endY)) {
          if (x !== endX || y !== endY) {
            cmds.push(
              `<a:lnTo><a:pt x="${toEmu(endX, vb.w)}" y="${toEmu(endY, vb.h)}"/></a:lnTo>`,
            );
          }
          x = endX;
          y = endY;
          lastCmd = cmd;
          break;
        }

        // Approximate arc with cubic bezier curves
        // Using the standard endpoint-to-center parameterization
        // Reference: https://www.w3.org/TR/SVG/implnote.html#ArcConversionEndpointToCenter

        // Step 1: Compute (x1', y1') - transform to unit circle space
        const phi = (xAxisRotation * Math.PI) / 180;
        const cosPhi = Math.cos(phi);
        const sinPhi = Math.sin(phi);

        const dx = (x - endX) / 2;
        const dy = (y - endY) / 2;
        const x1p = cosPhi * dx + sinPhi * dy;
        const y1p = -sinPhi * dx + cosPhi * dy;

        // Step 2: Compute (cx', cy') - center in transformed space
        let rx2 = rx * rx,
          ry2 = ry * ry;
        const x1p2 = x1p * x1p,
          y1p2 = y1p * y1p;

        // Scale radii if arc is impossible
        const lambda = x1p2 / rx2 + y1p2 / ry2;
        let rxAdj = rx,
          ryAdj = ry;
        if (lambda > 1) {
          const sqrtLambda = Math.sqrt(lambda);
          rxAdj = sqrtLambda * rx;
          ryAdj = sqrtLambda * ry;
          rx2 = rxAdj * rxAdj;
          ry2 = ryAdj * ryAdj;
        }

        let sq =
          (rx2 * ry2 - rx2 * y1p2 - ry2 * x1p2) / (rx2 * y1p2 + ry2 * x1p2);
        if (sq < 0) sq = 0;
        const coef = (largeArc !== sweep ? 1 : -1) * Math.sqrt(sq);
        const cxp = (coef * rxAdj * y1p) / ryAdj;
        const cyp = (-coef * ryAdj * x1p) / rxAdj;

        // Step 3: Compute (cx, cy) - center in original space
        const cx = cosPhi * cxp - sinPhi * cyp + (x + endX) / 2;
        const cy = sinPhi * cxp + cosPhi * cyp + (y + endY) / 2;

        // Step 4: Compute start and end angles
        const ux = (x1p - cxp) / rxAdj;
        const uy = (y1p - cyp) / ryAdj;
        const vx = (-x1p - cxp) / rxAdj;
        const vy = (-y1p - cyp) / ryAdj;

        const angleStart = Math.atan2(uy, ux);
        let dAngle = Math.atan2(vy, vx) - angleStart;

        // Adjust angle based on sweep flag
        if (sweep && dAngle < 0) dAngle += 2 * Math.PI;
        if (!sweep && dAngle > 0) dAngle -= 2 * Math.PI;

        // Split arc into segments of at most 90 degrees (pi/2)
        const numSegments = Math.max(
          1,
          Math.ceil(Math.abs(dAngle) / (Math.PI / 2)),
        );
        const segmentAngle = dAngle / numSegments;

        // Generate cubic bezier for each segment
        let currentAngle = angleStart;
        for (let seg = 0; seg < numSegments; seg++) {
          const nextAngle = currentAngle + segmentAngle;

          // Control point factor for cubic bezier approximation of arc
          const t = Math.tan(segmentAngle / 4);
          const alpha =
            (Math.sin(segmentAngle) * (Math.sqrt(4 + 3 * t * t) - 1)) / 3;

          const cos1 = Math.cos(currentAngle),
            sin1 = Math.sin(currentAngle);
          const cos2 = Math.cos(nextAngle),
            sin2 = Math.sin(nextAngle);

          // Start point (already at x, y for first segment)
          const p1x = cx + rxAdj * (cosPhi * cos1 - sinPhi * sin1);
          const p1y = cy + ryAdj * (sinPhi * cos1 + cosPhi * sin1);

          // End point
          const p2x = cx + rxAdj * (cosPhi * cos2 - sinPhi * sin2);
          const p2y = cy + ryAdj * (sinPhi * cos2 + cosPhi * sin2);

          // Control point 1 - derivative at start
          const cp1x = p1x - alpha * rxAdj * (cosPhi * -sin1 - sinPhi * cos1);
          const cp1y = p1y - alpha * ryAdj * (sinPhi * -sin1 + cosPhi * cos1);

          // Control point 2 - derivative at end
          const cp2x = p2x + alpha * rxAdj * (cosPhi * -sin2 - sinPhi * cos2);
          const cp2y = p2y + alpha * ryAdj * (sinPhi * -sin2 + cosPhi * cos2);

          cmds.push(
            `<a:cubicBezTo><a:pt x="${toEmu(cp1x, vb.w)}" y="${toEmu(cp1y, vb.h)}"/>` +
              `<a:pt x="${toEmu(cp2x, vb.w)}" y="${toEmu(cp2y, vb.h)}"/>` +
              `<a:pt x="${toEmu(p2x, vb.w)}" y="${toEmu(p2y, vb.h)}"/></a:cubicBezTo>`,
          );

          currentAngle = nextAngle;
        }

        x = endX;
        y = endY;
        lastCmd = cmd;
        break;
      }
      default:
        // Skip unknown commands
        i++;
    }
  }
  return cmds.join("");
}

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
export function svgPath(opts: SvgPathOptions): ShapeFragment {
  // ── Input validation ──────────────────────────────────────────────
  requireString(opts.d, "svgPath.d");
  _validateOptionalHex(opts.fill, "svgPath.fill");
  _validateOptionalHex(opts.stroke, "svgPath.stroke");
  if (opts.strokeWidth != null)
    requireNumber(opts.strokeWidth, "svgPath.strokeWidth", {
      min: 0,
      max: 100,
    });

  // ── Bounds validation ─────────────────────────────────────────────
  const xIn = opts.x || 0;
  const yIn = opts.y || 0;
  const wIn = opts.w || 1;
  const hIn = opts.h || opts.w || 1;
  if (!opts._skipBoundsCheck) {
    validateBounds(xIn, yIn, wIn, hIn, "svgPath");
  }

  const x = inches(xIn);
  const y = inches(yIn);
  const w = inches(wIn);
  const h = inches(hIn);

  const viewBox = opts.viewBox || { w: 24, h: 24 };
  const pathCmds = parseSvgPath(opts.d, viewBox);

  // Build fill XML
  const fill = opts.fill
    ? `<a:solidFill><a:srgbClr val="${hexColor(opts.fill)}"/></a:solidFill>`
    : "<a:noFill/>";

  // Build stroke/line XML
  const sw = opts.strokeWidth != null ? opts.strokeWidth : opts.stroke ? 1 : 0;
  const stroke = opts.stroke
    ? `<a:ln w="${sw * 12700}"><a:solidFill><a:srgbClr val="${hexColor(opts.stroke)}"/></a:solidFill></a:ln>`
    : "";

  // Custom geometry with parsed path
  const custGeom =
    "<a:custGeom>" +
    "<a:avLst/>" +
    "<a:gdLst/>" +
    "<a:ahLst/>" +
    "<a:cxnLst/>" +
    '<a:rect l="0" t="0" r="0" b="0"/>' +
    `<a:pathLst><a:path w="100000" h="100000">${pathCmds}</a:path></a:pathLst>` +
    "</a:custGeom>";

  const { id, name } = nextShapeIdAndName("Icon");
  return _createShapeFragment(
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${spTransform(x, y, w, h)}${custGeom}${fill}${stroke}</p:spPr></p:sp>`,
  );
}

// ── Gradient Fill Helper ─────────────────────────────────────────────

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
export function gradientFill(
  color1: string,
  color2: string,
  angle?: number,
  opts?: { opacity1?: number; opacity2?: number },
): string {
  // ── Input validation ──────────────────────────────────────────────
  requireHex(color1, "gradientFill.color1");
  requireHex(color2, "gradientFill.color2");
  if (angle != null) requireNumber(angle, "gradientFill.angle");

  const o = opts || {};
  const a = ((angle || 270) % 360) * 60000;
  const c1 = hexColor(color1);
  const c2 = hexColor(color2);

  // Build color stops with optional alpha
  let stop1, stop2;
  if (o.opacity1 != null && o.opacity1 < 1) {
    const alpha1 = Math.round(o.opacity1 * 100000);
    stop1 = `<a:srgbClr val="${c1}"><a:alpha val="${alpha1}"/></a:srgbClr>`;
  } else {
    stop1 = `<a:srgbClr val="${c1}"/>`;
  }
  if (o.opacity2 != null && o.opacity2 < 1) {
    const alpha2 = Math.round(o.opacity2 * 100000);
    stop2 = `<a:srgbClr val="${c2}"><a:alpha val="${alpha2}"/></a:srgbClr>`;
  } else {
    stop2 = `<a:srgbClr val="${c2}"/>`;
  }

  return `<a:gradFill><a:gsLst><a:gs pos="0">${stop1}</a:gs><a:gs pos="100000">${stop2}</a:gs></a:gsLst><a:lin ang="${a}" scaled="1"/></a:gradFill>`;
}

// ── Markdown to Speaker Notes ────────────────────────────────────────

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
export function markdownToNotes(md: string): string {
  requireString(md, "markdownToNotes.md");

  let text = md;

  // Remove code blocks (preserve content without fences)
  text = text.replace(/```[\s\S]*?```/g, (match) => {
    const inner = match.replace(/```\w*\n?/, "").replace(/\n?```$/, "");
    return inner.trim();
  });

  // Remove inline code backticks
  text = text.replace(/`([^`]+)`/g, "$1");

  // Convert headers to plain text with newlines
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "$1\n");

  // Convert bold/italic
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, "$1"); // bold+italic
  text = text.replace(/\*\*(.+?)\*\*/g, "$1"); // bold
  text = text.replace(/\*(.+?)\*/g, "$1"); // italic
  text = text.replace(/___(.+?)___/g, "$1"); // bold+italic alt
  text = text.replace(/__(.+?)__/g, "$1"); // bold alt
  text = text.replace(/_(.+?)_/g, "$1"); // italic alt

  // Convert links to just text (or "text (url)" format)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");

  // Convert images to alt text
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");

  // Convert unordered lists to bullets
  text = text.replace(/^[\s]*[-*+]\s+/gm, "• ");

  // Convert ordered lists to numbers
  text = text.replace(/^[\s]*(\d+)\.\s+/gm, "$1. ");

  // Convert blockquotes
  text = text.replace(/^>\s*/gm, "");

  // Remove horizontal rules
  text = text.replace(/^[-*_]{3,}$/gm, "");

  // Clean up excessive whitespace
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.trim();

  return text;
}

// ── Rich Text (Mixed Formatting Runs) ────────────────────────────────

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
export function richText(opts: RichTextOptions): ShapeFragment {
  // ── Input validation ──────────────────────────────────────────────
  if (opts.paragraphs != null) {
    requireArray(opts.paragraphs, "richText.paragraphs");
    opts.paragraphs.forEach((runs, pi) => {
      requireArray(runs, `richText.paragraphs[${pi}]`);
      runs.forEach((run, ri) => {
        _validateOptionalColor(
          run.color,
          `richText.paragraphs[${pi}][${ri}].color`,
        );
        _validateOptionalNumber(
          run.fontSize,
          `richText.paragraphs[${pi}][${ri}].fontSize`,
          { min: 1, max: 400 },
        );
      });
    });
  }
  _validateOptionalHex(opts.background, "richText.background");

  const x = inches(opts.x || 0);
  const y = inches(opts.y || 0);
  const w = inches(opts.w || 8);
  const h = inches(opts.h || 2);
  const fill = opts.background ? solidFill(opts.background) : "<a:noFill/>";
  const algn = opts.align || "l";

  const parasXml = (opts.paragraphs || [])
    .map((runs) => {
      const runsXml = runs
        .map((run) => {
          // Fall back to defaultTextColor, then theme foreground for runs without explicit color
          const resolvedRun = run.color
            ? run
            : {
                ...run,
                color: _defaultTextColor || (opts._theme || _activeTheme)?.fg,
              };
          const rPr = runProperties(resolvedRun);
          return `<a:r>${rPr}<a:t>${escapeXml(String(run.text || ""))}</a:t></a:r>`;
        })
        .join("");
      return `<a:p><a:pPr algn="${algn}"/>${runsXml}</a:p>`;
    })
    .join("");

  const { id, name } = nextShapeIdAndName("TextBox");
  return _createShapeFragment(
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${spTransform(x, y, w, h)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${fill}</p:spPr>${textBodyXml(parasXml, opts)}</p:sp>`,
  );
}

// ── Composite Shapes ─────────────────────────────────────────────────
// Higher-level shapes that combine multiple primitives into common patterns.
// These reduce code verbosity for frequently-used UI patterns.

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
export function panel(opts: PanelOptions): ShapeFragment {
  // Support aliases: background → fill, text → title, fontSize → titleSize, color → titleColor
  const fill = opts.fill || opts.background || "1A1A1A";
  const title = opts.title || opts.text;
  const titleSize = opts.titleSize || opts.fontSize || 18;
  // Auto-select readable text color against panel fill (unless explicitly provided)
  const titleColor = opts.titleColor || opts.color || autoTextColor(fill);

  const pad = opts.padding ?? 0.2;
  const gap = opts.gap ?? 0.15;
  const cornerRadius = opts.cornerRadius ?? 8;

  // Body color auto-selects for contrast against fill (unless explicitly provided)
  const bodyColor = opts.bodyColor || autoTextColor(fill);

  let shapes = "";

  // Background rectangle
  shapes += rect({
    x: opts.x,
    y: opts.y,
    w: opts.w,
    h: opts.h,
    fill,
    cornerRadius,
  }).toString();

  let contentY = opts.y + pad;

  // Title (if provided)
  if (title) {
    const titleH = (titleSize * 1.4) / 72; // Approximate height in inches
    shapes += textBox({
      x: opts.x + pad,
      y: contentY,
      w: opts.w - pad * 2,
      h: titleH,
      text: title,
      fontSize: titleSize,
      color: titleColor,
      bold: opts.titleBold !== false,
      forceColor: true,
      autoFit: true, // Auto-scale if title wraps
    }).toString();
    contentY += titleH + gap;
  }

  // Body (if provided)
  if (opts.body) {
    const bodyText = Array.isArray(opts.body) ? opts.body : [opts.body];
    const remainingH = opts.y + opts.h - contentY - pad;
    shapes += textBox({
      x: opts.x + pad,
      y: contentY,
      w: opts.w - pad * 2,
      h: remainingH,
      text: bodyText,
      fontSize: opts.bodySize || 12,
      color: bodyColor,
      forceColor: true,
      autoFit: true, // Auto-scale if body is long
    }).toString();
  }

  return _createShapeFragment(shapes);
}

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
export function card(opts: CardOptions): ShapeFragment {
  let shapes = "";
  const accentH = opts.accentHeight ?? 0.08;
  const accent = opts.accent || opts.accentColor; // Support alias

  // Accent stripe at top (if specified)
  if (accent) {
    shapes += rect({
      x: opts.x,
      y: opts.y,
      w: opts.w,
      h: accentH,
      fill: accent,
      cornerRadius: opts.cornerRadius ?? 8,
    }).toString();
    // Adjust panel to start below accent
    shapes += panel({
      ...opts,
      y: opts.y + accentH,
      h: opts.h - accentH,
      cornerRadius: 0, // Flat top since accent has the rounded corners
    }).toString();
  } else {
    shapes += panel(opts).toString();
  }

  return _createShapeFragment(shapes);
}

// ── Hyperlinks ───────────────────────────────────────────────────────
//
// OOXML hyperlinks require a relationship entry in the slide .rels file.
// Since we track slides as arrays of shape XML strings, we use a pres-level
// hyperlink registry: each hyperlink gets a unique rId, stored on pres._links.
// The build() method wires them into the correct slide .rels.

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
export function hyperlink(
  opts: HyperlinkOptions,
  pres: PresentationInternal,
): ShapeFragment {
  // ── Input validation ──────────────────────────────────────────────
  requireString(opts.url, "hyperlink.url");
  if (pres == null) {
    throw new Error(
      "hyperlink: 'pres' (presentation builder) is required as the second argument. " +
        "Pass the object returned by createPresentation().",
    );
  }
  _validateOptionalNumber(opts.fontSize, "hyperlink.fontSize", {
    min: 1,
    max: 400,
  });
  _validateOptionalHex(opts.color, "hyperlink.color");

  const x = inches(opts.x || 0);
  const y = inches(opts.y || 0);
  const w = inches(opts.w || 4);
  const h = inches(opts.h || 0.5);
  const slideIdx = (pres.slides?.length || 0) + 1; // will be on the next slide

  // Register the link relationship
  if (!pres._links) pres._links = [];
  const linkId = `rIdLink${pres._links.length + 1}`;
  pres._links.push({ slideIndex: slideIdx, relId: linkId, url: opts.url });

  const u = opts.underline !== false ? ' u="sng"' : "";
  const sz = fontSize(opts.fontSize || 14);
  const color = hexColor(opts.color || "2196F3");

  const { id, name } = nextShapeIdAndName("Hyperlink");
  return _createShapeFragment(
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${spTransform(x, y, w, h)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" anchor="ctr"/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="${sz}"${u} dirty="0"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:hlinkClick r:id="${linkId}"/></a:rPr><a:t>${escapeXml(String(opts.text || ""))}</a:t></a:r></a:p></p:txBody></p:sp>`,
  );
}

// ── Image Dimension Detection ───────────────────────────────────────────

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
export function getImageDimensions(
  data: Uint8Array,
  format: string,
): ImageDimensions | null {
  if (data.length < 24) return null;

  // PNG: bytes 16-23 contain width (4 bytes BE) and height (4 bytes BE) in IHDR
  if (format === "png") {
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    if (
      data[0] !== 0x89 ||
      data[1] !== 0x50 ||
      data[2] !== 0x4e ||
      data[3] !== 0x47
    ) {
      return null;
    }
    const width =
      (data[16] << 24) | (data[17] << 16) | (data[18] << 8) | data[19];
    const height =
      (data[20] << 24) | (data[21] << 16) | (data[22] << 8) | data[23];
    return { width, height };
  }

  // JPEG: scan for SOF0/SOF2 marker (FF C0 or FF C2) which contains dimensions
  if (format === "jpg" || format === "jpeg") {
    // JPEG signature: FF D8
    if (data[0] !== 0xff || data[1] !== 0xd8) return null;

    let i = 2;
    while (i < data.length - 9) {
      if (data[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = data[i + 1];
      // SOF0 (baseline), SOF1, SOF2 (progressive) contain dimensions
      if (marker >= 0xc0 && marker <= 0xc3 && marker !== 0xc1) {
        // Format: FF Cx LL LL PP HH HH WW WW
        // LL LL = segment length, PP = precision, HH HH = height, WW WW = width
        const height = (data[i + 5] << 8) | data[i + 6];
        const width = (data[i + 7] << 8) | data[i + 8];
        return { width, height };
      }
      // Skip to next marker (length is big-endian, doesn't include the 2-byte marker)
      const len = (data[i + 2] << 8) | data[i + 3];
      i += 2 + len;
    }
    return null;
  }

  // GIF: bytes 6-9 contain width (2 bytes LE) and height (2 bytes LE)
  if (format === "gif") {
    // GIF signature: "GIF87a" or "GIF89a"
    if (
      data[0] !== 0x47 ||
      data[1] !== 0x49 ||
      data[2] !== 0x46 ||
      data[3] !== 0x38
    ) {
      return null;
    }
    const width = data[6] | (data[7] << 8);
    const height = data[8] | (data[9] << 8);
    return { width, height };
  }

  // BMP: bytes 18-21 (width) and 22-25 (height) as 32-bit LE integers
  if (format === "bmp") {
    // BMP signature: "BM"
    if (data[0] !== 0x42 || data[1] !== 0x4d) return null;
    const width =
      data[18] | (data[19] << 8) | (data[20] << 16) | (data[21] << 24);
    const height =
      data[22] | (data[23] << 8) | (data[24] << 16) | (data[25] << 24);
    // BMP height can be negative (top-down bitmap)
    return { width, height: Math.abs(height) };
  }

  return null;
}

/**
 * Calculate srcRect percentages to crop an image for 'cover' fit mode.
 * Returns percentages (0-100000 in OOXML units = 0-100%) to crop from each edge.
 * The image is centered and cropped to fill the target aspect ratio.
 */
function calcCoverCrop(
  imgW: number,
  imgH: number,
  targetW: number,
  targetH: number,
): { l: number; t: number; r: number; b: number } {
  const imgAspect = imgW / imgH;
  const targetAspect = targetW / targetH;

  if (imgAspect > targetAspect) {
    // Image is wider than target - crop left/right
    const visibleWidth = imgH * targetAspect;
    const cropTotal = imgW - visibleWidth;
    const cropPct = (cropTotal / imgW) * 100000;
    const cropEach = Math.round(cropPct / 2);
    return { l: cropEach, t: 0, r: cropEach, b: 0 };
  } else {
    // Image is taller than target - crop top/bottom
    const visibleHeight = imgW / targetAspect;
    const cropTotal = imgH - visibleHeight;
    const cropPct = (cropTotal / imgH) * 100000;
    const cropEach = Math.round(cropPct / 2);
    return { l: 0, t: cropEach, r: 0, b: cropEach };
  }
}

/**
 * Calculate fillRect percentages to pad an image for 'contain' fit mode.
 * Returns percentages (0-100000 in OOXML units) to offset from each edge.
 * The image is centered within the target bounds without cropping.
 */
function calcContainPad(
  imgW: number,
  imgH: number,
  targetW: number,
  targetH: number,
): { l: number; t: number; r: number; b: number } {
  const imgAspect = imgW / imgH;
  const targetAspect = targetW / targetH;

  if (imgAspect > targetAspect) {
    // Image is wider - will be letterboxed (bars top/bottom)
    const scaledH = targetW / imgAspect;
    const padTotal = targetH - scaledH;
    const padPct = (padTotal / targetH) * 100000;
    const padEach = Math.round(padPct / 2);
    return { l: 0, t: padEach, r: 0, b: padEach };
  } else {
    // Image is taller - will be pillarboxed (bars left/right)
    const scaledW = targetH * imgAspect;
    const padTotal = targetW - scaledW;
    const padPct = (padTotal / targetW) * 100000;
    const padEach = Math.round(padPct / 2);
    return { l: padEach, t: 0, r: padEach, b: 0 };
  }
}

// ── Image Embedding ──────────────────────────────────────────────────

/** Map of file extensions to OOXML content types for images. */
const IMAGE_CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

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
export function embedImage(
  pres: PresentationInternal,
  opts: EmbedImageOptions,
): ShapeFragment {
  // ── Input validation ──────────────────────────────────────────────
  if (pres == null) {
    throw new Error(
      "embedImage: 'pres' (presentation builder) is required as the first argument. " +
        "Pass the object returned by createPresentation().",
    );
  }
  if (opts.data == null) {
    throw new Error(
      "embedImage: 'opts.data' is required — provide image bytes as a Uint8Array. " +
        "Use readFileBinary() from the fs-read plugin or fetch the image via the fetch plugin.",
    );
  }
  if (opts.format) {
    requireEnum(
      opts.format.toLowerCase(),
      "embedImage.format",
      VALID_IMAGE_FORMATS,
    );
  }

  if (!pres._imageIndex) pres._imageIndex = 0;
  pres._imageIndex++;
  const idx = pres._imageIndex;
  const slideIdx = (pres.slides?.length || 0) + 1;

  const format = (opts.format || "png").toLowerCase();
  const ext = format === "jpeg" ? "jpg" : format;
  const contentType = IMAGE_CONTENT_TYPES[format] || "image/png";
  const relId = `rIdImage${idx}`;
  const mediaPath = `media/image${idx}.${ext}`;

  const x = inches(opts.x || 0);
  const y = inches(opts.y || 0);
  const w = inches(opts.w || 4);
  const h = inches(opts.h || 3);

  // Store image metadata for build() to wire rels + content types
  if (!pres._images) pres._images = [];
  pres._images.push({
    id: `image${idx}`,
    index: idx,
    slideIndex: slideIdx,
    relId,
    mediaPath,
    contentType,
    format,
    data: opts.data,
  });

  // Determine fit mode and generate appropriate blipFill XML
  const fitMode = opts.fit || "stretch";
  let blipFillContent: string;

  if (fitMode === "stretch") {
    // Default: stretch to fill (may distort)
    blipFillContent = `<a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch>`;
  } else {
    // contain or cover: need image dimensions
    const dims = getImageDimensions(opts.data, format);
    if (!dims) {
      // Can't read dimensions - fall back to stretch
      blipFillContent = `<a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch>`;
    } else {
      // Convert target dimensions from EMUs back to a comparable unit
      // We just need the aspect ratio, so use the raw EMU values
      const targetW = w; // EMUs
      const targetH = h; // EMUs

      if (fitMode === "cover") {
        // Crop to fill: use srcRect to crop the source image
        const crop = calcCoverCrop(dims.width, dims.height, targetW, targetH);
        blipFillContent =
          `<a:blip r:embed="${relId}"/>` +
          `<a:srcRect l="${crop.l}" t="${crop.t}" r="${crop.r}" b="${crop.b}"/>` +
          `<a:stretch><a:fillRect/></a:stretch>`;
      } else {
        // contain: pad to fit - use fillRect offsets
        const pad = calcContainPad(dims.width, dims.height, targetW, targetH);
        blipFillContent =
          `<a:blip r:embed="${relId}"/>` +
          `<a:stretch><a:fillRect l="${pad.l}" t="${pad.t}" r="${pad.r}" b="${pad.b}"/></a:stretch>`;
      }
    }
  }

  // Picture shape with blipFill referencing the image relationship.
  // OOXML DrawingML uses r:embed (not r:id) to reference embedded media.
  return _createShapeFragment(
    `<p:pic><p:nvPicPr><p:cNvPr id="${nextShapeId()}" name="Image ${idx}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill>${blipFillContent}</p:blipFill><p:spPr>${spTransform(x, y, w, h)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`,
  );
}

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
export function embedImageFromUrl(
  pres: PresentationInternal,
  opts: EmbedImageOptions & { url: string },
): ShapeFragment {
  if (pres == null) {
    throw new Error(
      "embedImageFromUrl: 'pres' (presentation builder) is required as the first argument.",
    );
  }
  requireString(opts.url, "embedImageFromUrl.url");
  if (opts.data == null) {
    throw new Error(
      "embedImageFromUrl: 'opts.data' is required — fetch the image first with readBinary(url).",
    );
  }

  // Auto-detect format from URL extension if not explicitly provided
  let format = opts.format;
  if (!format) {
    const urlPath = opts.url.split("?")[0]; // Strip query params
    const ext = urlPath.split(".").pop()?.toLowerCase();
    if (ext && VALID_IMAGE_FORMATS.includes(ext)) {
      format = ext;
    } else {
      format = "png"; // Default fallback
    }
  }

  return embedImage(pres, {
    x: opts.x,
    y: opts.y,
    w: opts.w,
    h: opts.h,
    data: opts.data,
    format: format,
    name: opts.name,
  });
}

// ── Layout Helpers ────────────────────────────────────────────────────
// These functions calculate positions for common slide patterns.
// They return arrays of {x, y, w, h} objects that can be spread into shape opts.
// Slide dimensions: 13.333" x 7.5" (standard 16:9)
//
// LAYOUT SAFETY: Content should stay within y: 0.5 to SAFE_BOTTOM (6.5").
// Footer is at y: 7, page numbers at y: 7. Leave 0.5" buffer.
// Use getContentArea() or SAFE_BOTTOM constant for safe positioning.

/** Slide width in inches (16:9 aspect ratio). */
export const SLIDE_WIDTH_INCHES = 13.333;

/** Slide height in inches (16:9 aspect ratio). */
export const SLIDE_HEIGHT_INCHES = 7.5;

/** Maximum Y position for content to avoid footer/page number overlap. */
export const SAFE_BOTTOM = 6.5;

/** Standard Y position after title + accent bar. */
export const CONTENT_TOP = 1.3;

/**
 * Validate that a shape fits within slide bounds.
 * Throws an error with helpful context if the shape overflows.
 *
 * @param x - X position in inches
 * @param y - Y position in inches
 * @param w - Width in inches
 * @param h - Height in inches
 * @param shapeName - Name of the shape function for error messages
 * @throws Error if shape extends beyond slide bounds
 */
function validateBounds(
  x: number,
  y: number,
  w: number,
  h: number,
  shapeName: string,
): void {
  const issues: string[] = [];

  if (x < 0) {
    issues.push(`x=${x} is negative (starts off left edge)`);
  }
  if (y < 0) {
    issues.push(`y=${y} is negative (starts off top edge)`);
  }
  if (x + w > SLIDE_WIDTH_INCHES) {
    issues.push(
      `x=${x} + w=${w} = ${(x + w).toFixed(2)} exceeds slide width (${SLIDE_WIDTH_INCHES})`,
    );
  }
  if (y + h > SLIDE_HEIGHT_INCHES) {
    issues.push(
      `y=${y} + h=${h} = ${(y + h).toFixed(2)} exceeds slide height (${SLIDE_HEIGHT_INCHES})`,
    );
  }

  if (issues.length > 0) {
    throw new Error(
      `${shapeName}: shape overflows slide bounds:\n  • ${issues.join("\n  • ")}\n` +
        `Slide dimensions: ${SLIDE_WIDTH_INCHES}" × ${SLIDE_HEIGHT_INCHES}" (16:9)`,
    );
  }
}

/**
 * Estimate if text content will overflow a text box.
 * Uses approximate character-per-line calculations.
 *
 * @param text - Text content (string or array of strings)
 * @param w - Width in inches
 * @param h - Height in inches
 * @param fontSize - Font size in points (default 18)
 * @param shapeName - Name of the shape function for error messages
 * @throws Error if text is estimated to overflow the shape
 */
function validateTextOverflow(
  text: string | string[],
  w: number,
  h: number,
  fontSize: number,
  shapeName: string,
): void {
  const textStr = Array.isArray(text) ? text.join("\n") : String(text || "");
  if (!textStr) return;

  // Approximate characters per inch at different font sizes
  // Based on average character width being roughly 0.6 * fontSize in points
  // 1 inch = 72 points, so chars per inch ≈ 72 / (0.6 * fontSize)
  const charsPerInch = 72 / (0.6 * fontSize);
  const charsPerLine = Math.floor(w * charsPerInch);

  // Count actual lines after wrapping
  const lines = textStr.split("\n");
  let totalLines = 0;
  for (const line of lines) {
    if (line.length === 0) {
      totalLines += 1;
    } else {
      totalLines += Math.ceil(line.length / Math.max(charsPerLine, 1));
    }
  }

  // Line height is typically 1.2 * fontSize
  const lineHeightIn = (fontSize * 1.2) / 72;
  const requiredHeight = totalLines * lineHeightIn;

  if (requiredHeight > h * 1.1) {
    // 10% tolerance
    throw new Error(
      `${shapeName}: text content likely overflows shape:\n` +
        `  • Estimated ${totalLines} lines at ${fontSize}pt require ~${requiredHeight.toFixed(2)}" height\n` +
        `  • Shape height is only ${h}"\n` +
        `  • Consider: increasing height, reducing fontSize, or using autoFit: true`,
    );
  }
}

/**
 * Check if text fits within a box at a given font size.
 * Used by autoFit to binary search for optimal font size.
 *
 * @param text - Text content
 * @param w - Available width in inches
 * @param h - Available height in inches
 * @param fontSize - Font size in points to test
 * @returns true if text fits, false otherwise
 */
function textFitsInBox(
  text: string,
  w: number,
  h: number,
  fontSize: number,
): boolean {
  if (!text) return true;

  const charsPerInch = 72 / (0.6 * fontSize);
  const charsPerLine = Math.max(1, Math.floor(w * charsPerInch));

  const lines = text.split("\n");
  let totalLines = 0;
  for (const line of lines) {
    if (line.length === 0) {
      totalLines += 1;
    } else {
      totalLines += Math.ceil(line.length / charsPerLine);
    }
  }

  const lineHeightIn = (fontSize * 1.2) / 72;
  const requiredHeight = totalLines * lineHeightIn;

  return requiredHeight <= h;
}

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
export function shapes(items: Array<ShapeFragment | null | undefined>): ShapeFragment {
  if (!Array.isArray(items)) {
    throw new Error(
      `shapes(): expected an array of ShapeFragment items, but got ${typeof items}. ` +
        `Usage: shapes([textBox(...), rect(...), embedChart(...)])`,
    );
  }

  const result: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item == null) continue; // Skip null/undefined

    if (isShapeFragment(item)) {
      result.push(item.toString());
    } else {
      throw new Error(
        `shapes()[${i}]: expected a ShapeFragment (from textBox(), rect(), etc.), but got ${typeof item}. ` +
          `Each item must be a shape returned by a builder function like textBox(), rect(), embedChart(), etc.`,
      );
    }
  }

  return _createShapeFragment(result.join(""));
}

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
export function layoutColumns(
  count: number,
  opts: LayoutColumnsOptions = {},
): LayoutRect[] {
  const margin = opts.margin ?? 0.5;
  const gap = opts.gap ?? 0.25;
  const y = opts.y ?? 1;
  const h = opts.h ?? 2;

  const totalWidth = SLIDE_WIDTH_INCHES - 2 * margin;
  const totalGaps = (count - 1) * gap;
  const itemWidth = (totalWidth - totalGaps) / count;

  const result = [];
  for (let i = 0; i < count; i++) {
    result.push({
      x: margin + i * (itemWidth + gap),
      y,
      w: itemWidth,
      h,
    });
  }
  return result;
}

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
export function layoutGrid(
  count: number,
  opts: LayoutGridOptions = {},
): LayoutRect[] {
  const cols = opts.cols ?? 3;
  const margin = opts.margin ?? 0.5;
  const gapX = opts.gapX ?? opts.gap ?? 0.25;
  const gapY = opts.gapY ?? opts.gap ?? 0.25;
  const topY = opts.y ?? 1;
  // Use SAFE_BOTTOM to avoid footer/page number overlap (footer at y:7)
  const maxH = opts.maxH ?? SAFE_BOTTOM - topY;

  const rows = Math.ceil(count / cols);
  const totalWidth = SLIDE_WIDTH_INCHES - 2 * margin;
  const totalGapsX = (cols - 1) * gapX;
  const itemWidth = (totalWidth - totalGapsX) / cols;

  const totalGapsY = (rows - 1) * gapY;
  const itemHeight = (maxH - totalGapsY) / rows;

  const result = [];
  for (let i = 0; i < count; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    result.push({
      x: margin + col * (itemWidth + gapX),
      y: topY + row * (itemHeight + gapY),
      w: itemWidth,
      h: itemHeight,
    });
  }
  return result;
}

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
export function getContentArea(opts?: { hasTitle?: boolean }): LayoutRect {
  const startY = opts?.hasTitle ? CONTENT_TOP : 0.5;
  return {
    x: 0.5,
    y: startY,
    w: SLIDE_WIDTH_INCHES - 1, // 0.5" margin each side
    h: SAFE_BOTTOM - startY,
  };
}

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
export function overlay(opts: OverlayOptions = {}): ShapeFragment {
  return rect({
    x: opts.x ?? 0,
    y: opts.y ?? 0,
    w: opts.w ?? SLIDE_WIDTH_INCHES,
    h: opts.h ?? SLIDE_HEIGHT_INCHES,
    fill: opts.color ?? "000000",
    opacity: opts.opacity ?? 0.5,
  });
}

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
export function gradientOverlay(
  opts: GradientOverlayOptions = {},
): ShapeFragment {
  const color1 = opts.color1
    ? requireHex(opts.color1, "gradientOverlay.color1")
    : "000000";
  const color2 = opts.color2
    ? requireHex(opts.color2, "gradientOverlay.color2")
    : "000000";
  const fromOpacity = opts.fromOpacity ?? 0.8;
  const toOpacity = opts.toOpacity ?? 0;

  _validateOptionalNumber(fromOpacity, "gradientOverlay.fromOpacity", {
    min: 0,
    max: 1,
  });
  _validateOptionalNumber(toOpacity, "gradientOverlay.toOpacity", {
    min: 0,
    max: 1,
  });

  const x = inches(opts.x ?? 0);
  const y = inches(opts.y ?? 0);
  const w = inches(opts.w ?? SLIDE_WIDTH_INCHES);
  const h = inches(opts.h ?? SLIDE_HEIGHT_INCHES);

  // OOXML angle: degrees * 60000
  const angle = ((opts.angle ?? 0) % 360) * 60000;

  // OOXML alpha: 0 = transparent, 100000 = opaque
  const alpha1 = Math.round(fromOpacity * 100000);
  const alpha2 = Math.round(toOpacity * 100000);

  // Build gradient fill with opacity at each stop
  const gradFill =
    `<a:gradFill>` +
    `<a:gsLst>` +
    `<a:gs pos="0"><a:srgbClr val="${color1}"><a:alpha val="${alpha1}"/></a:srgbClr></a:gs>` +
    `<a:gs pos="100000"><a:srgbClr val="${color2}"><a:alpha val="${alpha2}"/></a:srgbClr></a:gs>` +
    `</a:gsLst>` +
    `<a:lin ang="${angle}" scaled="1"/>` +
    `</a:gradFill>`;

  const { id, name } = nextShapeIdAndName("Rectangle");
  return _createShapeFragment(
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${spTransform(x, y, w, h)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${gradFill}</p:spPr></p:sp>`,
  );
}

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
export function backgroundImage(
  pres: PresentationInternal,
  data: Uint8Array,
  format: string = "jpg",
): ShapeFragment {
  // Validate pres object — check for .theme which is always present
  if (!pres || typeof pres.theme !== "object") {
    throw new Error(
      "backgroundImage: first parameter must be the presentation object from createPresentation().",
    );
  }
  if (!data || !(data instanceof Uint8Array)) {
    throw new Error(
      "backgroundImage: second parameter must be image data (Uint8Array from fetchBinary).",
    );
  }
  return embedImage(pres, {
    x: 0,
    y: 0,
    w: SLIDE_WIDTH_INCHES,
    h: SLIDE_HEIGHT_INCHES,
    data: data,
    format: format,
  });
}

// ── Slide Background ─────────────────────────────────────────────────

function solidBg(color: string): string {
  return `<p:bg><p:bgPr>${solidFill(color)}<a:effectLst/></p:bgPr></p:bg>`;
}

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
export function gradientBg(
  color1: string,
  color2: string,
  angle?: number,
): string {
  requireHex(color1, "gradientBg.color1");
  requireHex(color2, "gradientBg.color2");
  const a = ((angle || 270) % 360) * 60000; // degrees to 60000ths
  return `<p:bg><p:bgPr><a:gradFill><a:gsLst><a:gs pos="0">${solidFill(color1).replace(/<\/?a:solidFill>/g, "")}</a:gs><a:gs pos="100000">${solidFill(color2).replace(/<\/?a:solidFill>/g, "")}</a:gs></a:gsLst><a:lin ang="${a}" scaled="1"/></a:gradFill><a:effectLst/></p:bgPr></p:bg>`;
}

/**
 * Extract the primary background color from slide bg XML.
 * Returns hex string or null if not a solid fill.
 * Used by addFooter/addSlideNumbers to pick contrasting text color.
 */
function _extractBgColor(bgXml: string | null | undefined): string | null {
  if (!bgXml) return null;
  const match = bgXml.match(/srgbClr val="([A-Fa-f0-9]{6})"/);
  return match ? match[1] : null;
}

// ── Slide Transitions ────────────────────────────────────────────────

/** Map of transition names to OOXML transition elements. */
const TRANSITIONS: Record<string, (spd: string) => string> = {
  fade: (spd: string) => `<p:transition spd="${spd}"><p:fade/></p:transition>`,
  push: (spd: string) =>
    `<p:transition spd="${spd}"><p:push dir="l"/></p:transition>`,
  wipe: (spd: string) =>
    `<p:transition spd="${spd}"><p:wipe dir="d"/></p:transition>`,
  split: (spd: string) =>
    `<p:transition spd="${spd}"><p:split orient="horz" dir="out"/></p:transition>`,
  cover: (spd: string) =>
    `<p:transition spd="${spd}"><p:cover dir="l"/></p:transition>`,
  // New transitions
  reveal: (spd: string) =>
    `<p:transition spd="${spd}"><p:strips dir="ld"/></p:transition>`,
  curtains: (spd: string) =>
    `<p:transition spd="${spd}"><p:split orient="vert" dir="in"/></p:transition>`,
  dissolve: (spd: string) =>
    `<p:transition spd="${spd}"><p:dissolve/></p:transition>`,
  zoom: (spd: string) =>
    `<p:transition spd="${spd}"><p:zoom dir="in"/></p:transition>`,
  fly: (spd: string) =>
    `<p:transition spd="${spd}"><p:fly dir="l"/></p:transition>`,
  wheel: (spd: string) =>
    `<p:transition spd="${spd}"><p:wheel spokes="4"/></p:transition>`,
  random: (spd: string) =>
    `<p:transition spd="${spd}"><p:random/></p:transition>`,
  none: () => "",
};

function buildTransitionXml(
  type: string | null | undefined,
  durationMs: number,
): string {
  const spd = durationMs <= 300 ? "fast" : durationMs >= 800 ? "slow" : "med";
  const builder = type
    ? TRANSITIONS[type] || TRANSITIONS.fade
    : TRANSITIONS.fade;
  return builder(spd);
}

// ── Speaker Notes ────────────────────────────────────────────────────

function notesSlideXml(notesText: string, slideIndex: number): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}">
<p:cSld><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr/>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/>
<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${escapeXml(notesText)}</a:t></a:r></a:p></p:txBody>
</p:sp>
</p:spTree></p:cSld>
</p:notes>`;
}

// ── Strict Validation Engine ─────────────────────────────────────────
// Enforces structural correctness before build/export. All issues are
// reported with machine-readable codes, slide indices, and LLM-actionable hints.

/** Maximum notes length per slide in characters. */
const MAX_NOTES_LENGTH = 12_000;

/** Regex matching XML control characters that are invalid in OOXML text. */
const INVALID_XML_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

/** Allowed top-level shape node types in slide shapes XML. */
const ALLOWED_SHAPE_NODES = new Set([
  "p:sp",
  "p:pic",
  "p:graphicFrame",
  "p:cxnSp",
  "p:grpSp",
]);

/** Regex matching invalid XML chars as a global variant (for replacement). */
const INVALID_XML_CHARS_G = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/**
 * Sanitize speaker notes at input-stage: enforce type, strip invalid XML
 * characters, and truncate to MAX_NOTES_LENGTH.
 * Returns null if input is falsy, the sanitized string otherwise.
 */
function _sanitizeNotes(raw: unknown): string | null {
  if (raw == null || raw === "") return null;
  if (typeof raw !== "string") {
    throw new Error(
      `notes must be a string but got ${typeof raw}. ` +
        `Pass plain text — no HTML, XML, or objects.`,
    );
  }
  // Strip invalid XML control chars (keep \t, \n, \r)
  let text = raw.replace(INVALID_XML_CHARS_G, "");
  // Truncate to cap
  if (text.length > MAX_NOTES_LENGTH) {
    text = text.slice(0, MAX_NOTES_LENGTH);
  }
  return text || null;
}

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
 * Validate the presentation structure for OOXML correctness.
 * Called automatically by buildZip() and exportToFile() — cannot be bypassed.
 *
 * @param slides - Internal slide data array
 * @param charts - Chart metadata array
 * @param chartEntries - Chart ZIP entries
 * @param images - Image entries
 * @param links - Hyperlink entries
 * @returns ValidationResult with any issues found
 * @internal
 */
function _validatePresentation(
  slides: SlideData[],
  charts: ChartEntry[],
  chartEntries: Array<{ name: string; data: string }>,
  images: ImageEntry[],
  _links: Array<{ slideIndex: number; relId: string; url: string }>,
): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // ── A) Slide integrity ──────────────────────────────────────────────
  const globalShapeIds = new Map<string, number[]>(); // track shape ID usage
  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i];
    const shapes = slide.shapes || "";

    // A1: Check for nested/foreign document roots (e.g. chart XML pasted in)
    if (shapes.includes("<?xml")) {
      errors.push({
        code: "PPTX_FOREIGN_ROOT",
        severity: "error",
        message: `Slide shapes contain an XML declaration — likely raw chart/document XML was concatenated.`,
        slideIndex: i,
        hint: "Use chartSlide() or embedChart().shape instead of inserting raw chart XML.",
      });
    }

    // A2: Check for allowed shape node types only
    // Extract all top-level opening tags that look like OOXML elements
    const topTags = shapes.match(/<(p:\w+)[\s>]/g);
    if (topTags) {
      for (const tag of topTags) {
        const nodeName = tag.match(/<(p:\w+)/)?.[1];
        if (nodeName && !ALLOWED_SHAPE_NODES.has(nodeName) && nodeName !== "p:txBody") {
          // Only warn for unexpected nodes (not errors, since some are legit internal use)
          warnings.push({
            code: "PPTX_UNEXPECTED_SHAPE_NODE",
            severity: "warn",
            message: `Unexpected shape node <${nodeName}> found.`,
            slideIndex: i,
            hint: `Only standard shapes (sp, pic, graphicFrame, cxnSp, grpSp) are expected.`,
          });
        }
      }
    }

    // A3: Detect duplicate shape IDs within a slide
    const idMatches = shapes.matchAll(/<p:cNvPr\s+id="(\d+)"/g);
    const slideIds = new Set<string>();
    for (const m of idMatches) {
      const id = m[1];
      if (slideIds.has(id)) {
        errors.push({
          code: "PPTX_DUPLICATE_SHAPE_ID",
          severity: "error",
          message: `Duplicate shape ID ${id} found on slide.`,
          slideIndex: i,
          hint: "Each shape must have a unique ID. This usually means shapes were copy-pasted incorrectly.",
        });
      }
      slideIds.add(id);
      // Track globally too
      if (!globalShapeIds.has(id)) globalShapeIds.set(id, []);
      globalShapeIds.get(id)!.push(i);
    }

    // A4: Check balanced required tags
    for (const tag of ["p:sp", "p:pic", "p:graphicFrame", "p:cxnSp"]) {
      const opens = (shapes.match(new RegExp(`<${tag}[\\s>]`, "g")) || []).length;
      const closes = (shapes.match(new RegExp(`</${tag}>`, "g")) || []).length;
      if (opens !== closes) {
        errors.push({
          code: "PPTX_UNBALANCED_TAGS",
          severity: "error",
          message: `Unbalanced <${tag}> tags: ${opens} opening vs ${closes} closing.`,
          slideIndex: i,
          hint: "Shape XML is malformed. Regenerate the slide using the high-level slide functions.",
        });
      }
    }
  }

  // A5: Cross-slide duplicate shape ID check
  for (const [id, slideIndices] of globalShapeIds) {
    if (slideIndices.length > 1) {
      warnings.push({
        code: "PPTX_CROSS_SLIDE_DUPLICATE_ID",
        severity: "warn",
        message: `Shape ID ${id} appears on slides [${slideIndices.map((s) => s + 1).join(", ")}].`,
        hint: "Cross-slide duplicate IDs can trigger PowerPoint repair. Ensure each shape has a unique ID.",
      });
    }
  }

  // ── B) Chart integrity ────────────────────────────────────────────────
  // B1: Check total chart count
  if (charts.length > MAX_CHARTS_PER_DECK) {
    errors.push({
      code: "PPTX_TOO_MANY_CHARTS",
      severity: "error",
      message: `Deck has ${charts.length} charts — max allowed is ${MAX_CHARTS_PER_DECK}.`,
      hint: "Reduce the number of charts or split into multiple presentations.",
    });
  }

  // B2: Check for duplicate chart relation IDs
  const chartRelIds = new Set<string>();
  for (const chart of charts) {
    if (chart.relId) {
      if (chartRelIds.has(chart.relId)) {
        errors.push({
          code: "PPTX_DUPLICATE_CHART_REL",
          severity: "error",
          message: `Duplicate chart relationship ID "${chart.relId}".`,
          part: chart.chartPath,
          hint: "Chart indexing is inconsistent. This is likely a bug — regenerate the deck.",
        });
      }
      chartRelIds.add(chart.relId);
    }
  }

  // B3: Validate chart XML entries
  for (const entry of chartEntries) {
    if (!entry.name.endsWith(".xml.rels") && entry.name.includes("chart")) {
      const xml = entry.data;

      // B3a: Check required chart nodes
      if (!xml.includes("<c:chartSpace") && !xml.includes("<c:chart")) {
        errors.push({
          code: "PPTX_CHART_MISSING_ROOT",
          severity: "error",
          message: "Chart XML missing required <c:chartSpace> or <c:chart> elements.",
          part: entry.name,
          hint: "Regenerate the chart using barChart/pieChart/lineChart/comboChart.",
        });
      }

      // B3b: Axis ID/crossAx consistency (for bar/line/combo charts)
      const axIds = [...xml.matchAll(/<c:axId val="(\d+)"\/>/g)].map((m) =>
        m[1],
      );
      const crossAxIds = [
        ...xml.matchAll(/<c:crossAx val="(\d+)"\/>/g),
      ].map((m) => m[1]);
      for (const crossId of crossAxIds) {
        if (!axIds.includes(crossId)) {
          errors.push({
            code: "PPTX_CHART_AXIS_MISMATCH",
            severity: "error",
            message: `crossAx ${crossId} not found in chart axis IDs [${axIds.join(", ")}].`,
            part: entry.name,
            hint: "Regenerate chart via comboChart/barChart with consistent axes.",
          });
        }
      }

      // B3c: Check for non-finite values in chart data
      const valMatches = [...xml.matchAll(/<c:v>([^<]+)<\/c:v>/g)];
      for (const vm of valMatches) {
        const val = vm[1];
        // Numeric values must be finite numbers
        if (val === "NaN" || val === "Infinity" || val === "-Infinity") {
          errors.push({
            code: "PPTX_CHART_INVALID_VALUE",
            severity: "error",
            message: `Chart contains non-finite value "${val}".`,
            part: entry.name,
            hint: "All chart data values must be finite numbers. Check for NaN/Infinity in data.",
          });
        }
      }
    }
  }

  // B4: Chart parts have matching ZIP entries
  for (const chart of charts) {
    const expectedPath = `ppt/${chart.chartPath}`;
    const found = chartEntries.some((e) => e.name === expectedPath);
    if (!found) {
      errors.push({
        code: "PPTX_CHART_MISSING_PART",
        severity: "error",
        message: `Chart part "${chart.chartPath}" referenced but ZIP entry not found.`,
        part: chart.chartPath,
        hint: "Chart may have been orphaned. Regenerate the chart.",
      });
    }
  }

  // ── C) Notes integrity ────────────────────────────────────────────────
  for (let i = 0; i < slides.length; i++) {
    const notes = slides[i].notes;
    if (notes == null) continue;

    // C1: Notes must be a string
    if (typeof notes !== "string") {
      errors.push({
        code: "PPTX_NOTES_TYPE",
        severity: "error",
        message: `Notes must be a string, got ${typeof notes}.`,
        slideIndex: i,
        hint: "Pass a plain text string as notes.",
      });
      continue;
    }

    // C2: Notes length cap (defence-in-depth — _sanitizeNotes truncates at input,
    // but this catches any notes injected by restore/deserialization bypassing sanitization)
    if (notes.length > MAX_NOTES_LENGTH) {
      errors.push({
        code: "PPTX_NOTES_TOO_LONG",
        severity: "error",
        message: `Notes are ${notes.length} chars — max ${MAX_NOTES_LENGTH}.`,
        slideIndex: i,
        hint: `Trim notes to ${MAX_NOTES_LENGTH} characters or split across slides.`,
      });
    }

    // C3: Invalid XML characters
    if (INVALID_XML_CHARS.test(notes)) {
      const match = notes.match(INVALID_XML_CHARS);
      const charCode = match ? match[0].charCodeAt(0) : 0;
      errors.push({
        code: "PPTX_NOTES_INVALID_CHARS",
        severity: "error",
        message: `Notes contain invalid XML control character (U+${charCode.toString(16).padStart(4, "0").toUpperCase()}).`,
        slideIndex: i,
        hint: "Remove control characters. Only printable UTF-8 text, tabs, and newlines are allowed.",
      });
    }
  }

  // ── D) Package integrity ──────────────────────────────────────────────
  // D1: Check for orphan chart entries (charts in ZIP not referenced by any slide rels)
  const usedChartPaths = new Set(charts.map((c) => `ppt/${c.chartPath}`));
  for (const entry of chartEntries) {
    if (entry.name.endsWith(".xml") && !entry.name.endsWith(".xml.rels")) {
      if (!usedChartPaths.has(entry.name)) {
        warnings.push({
          code: "PPTX_ORPHAN_CHART",
          severity: "warn",
          message: `Chart ZIP entry "${entry.name}" not referenced by any slide.`,
          part: entry.name,
          hint: "This chart was created but never embedded in a slide.",
        });
      }
    }
  }

  // D2: Check image slide index references are valid
  for (const img of images) {
    if (img.slideIndex < 1 || img.slideIndex > slides.length) {
      warnings.push({
        code: "PPTX_IMAGE_BAD_SLIDE_REF",
        severity: "warn",
        message: `Image "${img.id}" references slide ${img.slideIndex} but only ${slides.length} slides exist.`,
        hint: "Image may have been orphaned by slide deletion.",
      });
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Throw a structured validation error with machine-readable payload.
 * Format: PPTX_VALIDATION_FAILED: X errors, Y warnings
 * @internal
 */
function _throwValidationError(result: ValidationResult): never {
  const maxIssues = 5; // Show first N issues in message
  const lines: string[] = [
    `PPTX_VALIDATION_FAILED: ${result.errors.length} error${result.errors.length !== 1 ? "s" : ""}, ${result.warnings.length} warning${result.warnings.length !== 1 ? "s" : ""}`,
  ];

  const allIssues = [...result.errors, ...result.warnings].slice(0, maxIssues);
  for (const issue of allIssues) {
    const severity = issue.severity === "error" ? "ERROR" : "WARN";
    const slide = issue.slideIndex != null ? ` slide=${issue.slideIndex}` : "";
    const part = issue.part ? ` part=${issue.part}` : "";
    lines.push(`[${severity}] ${issue.code}${slide}${part}`);
    lines.push(`  ${issue.message}`);
    if (issue.hint) {
      lines.push(`  Hint: ${issue.hint}`);
    }
  }

  if (result.errors.length + result.warnings.length > maxIssues) {
    lines.push(
      `  ... and ${result.errors.length + result.warnings.length - maxIssues} more issue(s)`,
    );
  }

  const error = new Error(lines.join("\n"));
  // Attach machine-readable payload
  (error as Error & { validation: ValidationResult }).validation = result;
  throw error;
}

// ── Slide XML Assembly ───────────────────────────────────────────────

function slideXml(
  bg: string,
  shapes: string,
  transition: string | null | undefined,
  animations?: string[],
): string {
  // Guard: detect raw chart XML accidentally concatenated into shapes.
  // Chart XML contains its own <?xml declaration which corrupts the OOXML.
  if (shapes.includes("<?xml")) {
    throw new Error(
      "Slide shapes contain a raw XML declaration (<?xml ..?>). " +
        "This usually means a chart was concatenated directly into shapes. " +
        "Use chartSlide(pres, { chart: ... }) or " +
        "embedChart(pres, chart, { x, y, w, h }) to embed charts.",
    );
  }
  // Note: Shape IDs are assigned when shapes are created (via nextShapeId()),
  // not when the XML is assembled. The counter is managed globally and must
  // be preserved across handler boundaries via serialize()/restorePresentation().
  const transXml = transition || "";
  const animXml =
    animations && animations.length > 0 ? animations.join("") : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}">
<p:cSld>${bg}<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes}</p:spTree></p:cSld>${transXml}${animXml}</p:sld>`;
}

// ── Presentation Builder ─────────────────────────────────────────────

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
export function createPresentation(opts?: CreatePresentationOptions) {
  const o = opts || {};
  const themeName = o.theme || "corporate-blue";
  // Validate theme name — LLM must use one of the predefined themes
  if (!THEMES[themeName]) {
    const available = Object.keys(THEMES).join(", ");
    throw new Error(
      `createPresentation: theme "${themeName}" is not recognised. ` +
        `Available themes: ${available}. ` +
        `Choose one of these for a professionally-designed colour palette.`,
    );
  }
  const theme = getTheme(themeName);
  // Publish for shape builders — see module-level _activeTheme comment.
  _activeTheme = theme;
  // Set global forceAllColors flag — bypasses WCAG contrast validation globally.
  // Auto-enable for dark themes (isDark: true) unless explicitly set to false.
  // This prevents contrast errors when using dark themes with light accent colors.
  if (o.forceAllColors !== undefined) {
    setForceAllColors(!!o.forceAllColors);
  } else {
    setForceAllColors(!!theme.isDark); // Auto-enable for dark themes
  }

  // Default background — used by addBody() when no per-slide background specified.
  // Can be a hex color string OR a gradient spec {color1, color2, angle}.
  const defaultBackground = o.defaultBackground || null;

  // Default text color — used by text-containing shapes when no color specified.
  // Useful for dark themes where most text should be white.
  const defaultTextColor = o.defaultTextColor || null;
  // Expose via module-level variable for shape functions to access
  _defaultTextColor = defaultTextColor;

  const slides: SlideData[] = [];

  // Internal state for images, charts, hyperlinks, and animations
  let _imageIndex = 0;
  const _images: ImageEntry[] = [];
  const _links: Array<{ slideIndex: number; relId: string; url: string }> = [];
  const _charts: ChartEntry[] = [];
  const _chartEntries: Array<{ name: string; data: string }> = [];
  const _animations: Record<number, string[]> = {};

  const pres = {
    theme,

    // Expose internal state for external functions (embedImage, hyperlink, etc.)
    _images,
    _imageIndex,
    _links,
    _charts,
    _chartEntries,
    _animations,

    /**
     * Get the internal slides array. For advanced manipulation only.
     * Each slide is: { bg: string, shapes: string, transition?: string, notes?: string }
     * Prefer using the slide functions (titleSlide, contentSlide, etc.) instead.
     */
    get slides() {
      return slides;
    },

    /**
     * Replace all slides. For advanced use only.
     * @param {Array} newSlides - Array of slide objects with {bg, shapes, transition?, notes?}
     */
    set slides(newSlides) {
      if (!Array.isArray(newSlides)) {
        throw new Error(
          "slides setter: must be an array of slide objects. " +
            "Each slide needs: { bg: string, shapes: string, transition?: string, notes?: string }",
        );
      }
      slides.length = 0;
      slides.push(...newSlides);
    },

    /** Current number of slides in the presentation. */
    get slideCount() {
      return slides.length;
    },

    /**
     * Add a raw slide with shapes.
     * @param {string} bgXml - Background XML
     * @param {string} shapesXml - Concatenated shape XML fragments
     * @param {Object} [slideOpts] - Optional slide-level settings
     * @param {string} [slideOpts.transition] - Transition type: 'fade', 'push', 'wipe', 'split', 'cover'
     * @param {number} [slideOpts.transitionDuration=500] - Transition duration in ms
     * @param {string} [slideOpts.notes] - Speaker notes text
     */
    addSlide(
      bgXml: string,
      shapesXml: string | string[],
      slideOpts?: SlideOptions,
    ) {
      // Defensively handle arrays - join them if accidentally passed
      const shapes = Array.isArray(shapesXml) ? shapesXml.join("") : shapesXml;
      slides.push({
        bg: bgXml,
        shapes: shapes,
        transition: slideOpts?.transition || null,
        transitionDuration: slideOpts?.transitionDuration || 500,
        notes: _sanitizeNotes(slideOpts?.notes),
      });
    },

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
    addBody(
      shapesInput: ShapeFragment | ShapeFragment[] | string | string[],
      slideOpts?: SlideOptions,
    ) {
      // Reject raw strings — LLMs must use shape builder functions
      if (typeof shapesInput === "string") {
        throw new Error(
          "addBody: raw XML strings are no longer accepted. " +
            "Pass ShapeFragment objects from builder functions (textBox, rect, bulletList, etc.). " +
            "Example: pres.addBody(textBox({ x:1, y:1, w:8, h:1, text:'Hello' }))",
        );
      }
      if (
        Array.isArray(shapesInput) &&
        shapesInput.length > 0 &&
        typeof shapesInput[0] === "string"
      ) {
        throw new Error(
          "addBody: raw XML string arrays are no longer accepted. " +
            "Pass ShapeFragment objects from builder functions (textBox, rect, bulletList, etc.).",
        );
      }
      // Validate and convert ShapeFragment(s) to XML, then delegate to internal method
      const shapesStr = fragmentsToXml(shapesInput as ShapeFragment | ShapeFragment[]);
      pres._addBodyRaw(shapesStr, slideOpts);
    },

    /**
     * Internal: add shapes (as pre-validated XML string) to a new slide.
     * Resolves background from per-slide > defaultBackground > theme.
     * Not on the Presentation interface — internal use only.
     * @internal
     */
    _addBodyRaw(shapesStr: string, slideOpts?: SlideOptions) {
      // Resolve background: per-slide > defaultBackground > theme.bg
      let bgXml: string;
      const bgSpec = slideOpts?.background;
      if (bgSpec) {
        // Per-slide background specified
        if (typeof bgSpec === "object" && "color1" in bgSpec) {
          // Gradient spec
          bgXml = gradientBg(bgSpec.color1, bgSpec.color2, bgSpec.angle);
        } else {
          // Solid color
          bgXml = solidBg(bgSpec as string);
        }
      } else if (defaultBackground) {
        // Use presentation default
        if (
          typeof defaultBackground === "object" &&
          "color1" in defaultBackground
        ) {
          bgXml = gradientBg(
            defaultBackground.color1,
            defaultBackground.color2,
            defaultBackground.angle,
          );
        } else {
          bgXml = solidBg(defaultBackground as string);
        }
      } else {
        // Fall back to theme background
        bgXml = solidBg(theme.bg);
      }
      slides.push({
        bg: bgXml,
        shapes: shapesStr,
        transition: slideOpts?.transition || null,
        transitionDuration: slideOpts?.transitionDuration || 500,
        notes: _sanitizeNotes(slideOpts?.notes),
      });
    },

    /**
     * Insert a slide at a specific index. Existing slides shift right.
     * @param {number} index - Position to insert (0-based). Clamped to valid range.
     * @param {string} bgXml - Background XML
     * @param {string} shapesXml - Concatenated shape XML fragments
     * @param {Object} [slideOpts] - Optional slide-level settings
     */
    insertSlideAt(
      index: number,
      bgXml: string,
      shapesXml: string,
      slideOpts?: SlideOptions,
    ) {
      const slide: SlideData = {
        bg: bgXml,
        shapes: shapesXml,
        transition: slideOpts?.transition || null,
        transitionDuration: slideOpts?.transitionDuration || 500,
        notes: _sanitizeNotes(slideOpts?.notes),
      };
      const clampedIndex = Math.max(0, Math.min(index, slides.length));
      slides.splice(clampedIndex, 0, slide);
    },

    /**
     * Reorder slides by providing a new index sequence.
     * @example reorderSlides([2, 0, 1]) moves slide 3 to first position
     * @param {number[]} newOrder - Array of current indices in desired new order.
     *   Must contain all indices from 0 to slides.length-1 exactly once.
     * @throws {Error} If newOrder is invalid (wrong length, missing/duplicate indices)
     */
    reorderSlides(newOrder: number[]) {
      requireArray(newOrder, "reorderSlides.newOrder");
      if (newOrder.length !== slides.length) {
        throw new Error(
          `reorderSlides: newOrder has ${newOrder.length} elements but there are ` +
            `${slides.length} slides. Provide exactly one index per slide.`,
        );
      }
      // Validate all indices are present exactly once
      const sorted = [...newOrder].sort((a, b) => a - b);
      for (let i = 0; i < sorted.length; i++) {
        if (sorted[i] !== i) {
          throw new Error(
            `reorderSlides: newOrder must contain each index 0-${slides.length - 1} exactly once. ` +
              `Got: [${newOrder.join(", ")}]`,
          );
        }
      }
      // Create new array in specified order
      const reordered = newOrder.map((i: number) => slides[i]);
      slides.length = 0;
      slides.push(...reordered);
    },

    /**
     * Move a slide from one position to another.
     * @param {number} fromIndex - Current index of slide to move (0-based)
     * @param {number} toIndex - Target index (0-based)
     */
    moveSlide(fromIndex: number, toIndex: number) {
      if (fromIndex < 0 || fromIndex >= slides.length) {
        throw new Error(
          `moveSlide: fromIndex ${fromIndex} is out of range. ` +
            `Valid range: 0-${slides.length - 1}`,
        );
      }
      const clampedTo = Math.max(0, Math.min(toIndex, slides.length - 1));
      const [slide] = slides.splice(fromIndex, 1);
      slides.splice(clampedTo, 0, slide);
    },

    /**
     * Delete a slide at the specified index.
     * @param {number} index - Index of slide to delete (0-based)
     */
    deleteSlide(index: number) {
      if (index < 0 || index >= slides.length) {
        throw new Error(
          `deleteSlide: index ${index} is out of range. ` +
            `Valid range: 0-${slides.length - 1}`,
        );
      }
      slides.splice(index, 1);
    },

    /**
     * Build the presentation as an array of ZIP entries.
     * @returns {Array<{name: string, data: string}>} ZIP entries for createZip()
     */
    build() {
      const entries = [];
      const slideCount = slides.length;

      // Check if any slides have notes - if so, we need a notesMaster
      const hasNotes = slides.some((s) => s.notes);

      // [Content_Types].xml
      const overrides = [
        {
          partName: "/ppt/presentation.xml",
          contentType:
            "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
        },
        {
          partName: "/ppt/presProps.xml",
          contentType:
            "application/vnd.openxmlformats-officedocument.presentationml.presProps+xml",
        },
        {
          partName: "/ppt/viewProps.xml",
          contentType:
            "application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml",
        },
        {
          partName: "/ppt/tableStyles.xml",
          contentType:
            "application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml",
        },
        {
          partName: "/ppt/theme/theme1.xml",
          contentType:
            "application/vnd.openxmlformats-officedocument.theme+xml",
        },
        {
          partName: "/ppt/slideMasters/slideMaster1.xml",
          contentType:
            "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml",
        },
        {
          partName: "/ppt/slideLayouts/slideLayout1.xml",
          contentType:
            "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml",
        },
        {
          partName: "/docProps/core.xml",
          contentType:
            "application/vnd.openxmlformats-package.core-properties+xml",
        },
        {
          partName: "/docProps/app.xml",
          contentType:
            "application/vnd.openxmlformats-officedocument.extended-properties+xml",
        },
      ];
      for (let i = 0; i < slideCount; i++) {
        overrides.push({
          partName: `/ppt/slides/slide${i + 1}.xml`,
          contentType:
            "application/vnd.openxmlformats-officedocument.presentationml.slide+xml",
        });
      }
      entries.push({
        name: "[Content_Types].xml",
        data: contentTypesXml(overrides),
      });

      // _rels/.rels
      entries.push({
        name: "_rels/.rels",
        data: relsXml([
          {
            id: "rId1",
            type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
            target: "ppt/presentation.xml",
          },
          {
            id: "rId2",
            type: "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties",
            target: "docProps/core.xml",
          },
          {
            id: "rId3",
            type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties",
            target: "docProps/app.xml",
          },
        ]),
      });

      // docProps/core.xml (Dublin Core metadata)
      const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      entries.push({
        name: "docProps/core.xml",
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>Presentation</dc:title>
<dc:creator>Hyperlight PPTX</dc:creator>
<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`,
      });

      // docProps/app.xml (application properties)
      entries.push({
        name: "docProps/app.xml",
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
<Application>Hyperlight PPTX</Application>
<Slides>${slideCount}</Slides>
</Properties>`,
      });

      // ppt/_rels/presentation.xml.rels
      const presRels = [];
      for (let i = 0; i < slideCount; i++) {
        presRels.push({
          id: `rId${i + 1}`,
          type: RT_SLIDE,
          target: `slides/slide${i + 1}.xml`,
        });
      }
      const base = slideCount + 1;
      presRels.push({
        id: `rId${base}`,
        type: RT_SLIDE_MASTER,
        target: "slideMasters/slideMaster1.xml",
      });
      presRels.push({
        id: `rId${base + 1}`,
        type: RT_THEME,
        target: "theme/theme1.xml",
      });
      presRels.push({
        id: `rId${base + 2}`,
        type: RT_PRES_PROPS,
        target: "presProps.xml",
      });
      presRels.push({
        id: `rId${base + 3}`,
        type: RT_VIEW_PROPS,
        target: "viewProps.xml",
      });
      presRels.push({
        id: `rId${base + 4}`,
        type: RT_TABLE_STYLES,
        target: "tableStyles.xml",
      });
      // Add notesMaster reference if any slide has notes
      const notesMasterRelId = hasNotes ? `rId${base + 5}` : "";
      if (hasNotes) {
        presRels.push({
          id: notesMasterRelId,
          type: RT_NOTES_MASTER,
          target: "notesMasters/notesMaster1.xml",
        });
      }
      entries.push({
        name: "ppt/_rels/presentation.xml.rels",
        data: relsXml(presRels),
      });

      // ppt/presentation.xml
      const slideList = slides
        .map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`)
        .join("");
      const notesMasterIdLst = hasNotes
        ? `<p:notesMasterIdLst><p:notesMasterId r:id="${notesMasterRelId}"/></p:notesMasterIdLst>`
        : "";
      entries.push({
        name: "ppt/presentation.xml",
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}">
<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId${base}"/></p:sldMasterIdLst>
${notesMasterIdLst}<p:sldIdLst>${slideList}</p:sldIdLst>
<p:sldSz cx="${SLIDE_WIDTH}" cy="${SLIDE_HEIGHT}"/>
<p:notesSz cx="${SLIDE_HEIGHT}" cy="${SLIDE_WIDTH}"/>
</p:presentation>`,
      });

      // ppt/presProps.xml, viewProps.xml, tableStyles.xml
      entries.push({
        name: "ppt/presProps.xml",
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:presentationPr xmlns:p="${NS_P}"/>`,
      });
      entries.push({
        name: "ppt/viewProps.xml",
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:viewPr xmlns:p="${NS_P}"/>`,
      });
      entries.push({
        name: "ppt/tableStyles.xml",
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<a:tblStyleLst xmlns:a="${NS_A}" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`,
      });

      // ppt/theme/theme1.xml
      entries.push({ name: "ppt/theme/theme1.xml", data: themeXml(theme) });

      // Slide master + layout (minimal)
      entries.push({
        name: "ppt/slideMasters/_rels/slideMaster1.xml.rels",
        data: relsXml([
          {
            id: "rId1",
            type: RT_SLIDE_LAYOUT,
            target: "../slideLayouts/slideLayout1.xml",
          },
          { id: "rId2", type: RT_THEME, target: "../theme/theme1.xml" },
        ]),
      });
      entries.push({
        name: "ppt/slideMasters/slideMaster1.xml",
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}">
<p:cSld><p:bg><p:bgPr>${solidFill(theme.bg)}<a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>
<p:clrMap bg1="dk1" tx1="lt1" bg2="dk2" tx2="lt2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
</p:sldMaster>`,
      });
      entries.push({
        name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
        data: relsXml([
          {
            id: "rId1",
            type: RT_SLIDE_MASTER,
            target: "../slideMasters/slideMaster1.xml",
          },
        ]),
      });
      entries.push({
        name: "ppt/slideLayouts/slideLayout1.xml",
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" preserve="1">
<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>
</p:sldLayout>`,
      });

      // Notes master (required if any slide has notes)
      // IMPORTANT: Notes master needs its own theme file (theme2.xml) - sharing theme1 causes PowerPoint repair
      if (hasNotes) {
        // Create theme2.xml for notesMaster (can be identical to theme1, but must be separate)
        entries.push({ name: "ppt/theme/theme2.xml", data: themeXml(theme) });
        overrides.push({
          partName: "/ppt/theme/theme2.xml",
          contentType:
            "application/vnd.openxmlformats-officedocument.theme+xml",
        });
        entries.push({
          name: "ppt/notesMasters/_rels/notesMaster1.xml.rels",
          data: relsXml([
            { id: "rId1", type: RT_THEME, target: "../theme/theme2.xml" },
          ]),
        });
        entries.push({
          name: "ppt/notesMasters/notesMaster1.xml",
          data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notesMaster xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}">
<p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>
<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
</p:notesMaster>`,
        });
        // Add notes master content type
        overrides.push({
          partName: "/ppt/notesMasters/notesMaster1.xml",
          contentType:
            "application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml",
        });
      }

      // Slides (with transitions, notes, and chart relationships)
      // Collect chart metadata from pres._charts (set by embedChart)
      const chartsBySlide = new Map();
      if (this._charts) {
        for (const chart of this._charts) {
          const key = chart.slideIndex;
          if (!chartsBySlide.has(key)) chartsBySlide.set(key, []);
          chartsBySlide.get(key).push(chart);
        }
      }

      // Track sequential notes slide numbering (OOXML requires 1, 2, 3... not slide numbers)
      let notesIndex = 0;

      for (let i = 0; i < slideCount; i++) {
        const slide = slides[i];
        const slideNum = i + 1;
        let relIdCounter = 1;
        // Track sequential notes slide index (notes slides must be numbered 1, 2, 3... not matching slide numbers)
        // This is set after we check if slide.notes exists, so we can use it for the filename
        let notesSlideIndex: number | undefined;
        const slideRels: Array<{
          id: string;
          type: string;
          target: string;
          targetMode?: string;
        }> = [
          {
            id: `rId${relIdCounter++}`,
            type: RT_SLIDE_LAYOUT,
            target: "../slideLayouts/slideLayout1.xml",
          },
        ];

        // Notes relationship (if notes exist)
        if (slide.notes) {
          notesSlideIndex = ++notesIndex; // Increment and capture for this slide
          slideRels.push({
            id: `rId${relIdCounter++}`,
            type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide",
            target: `../notesSlides/notesSlide${notesSlideIndex}.xml`,
          });
        }

        // Chart relationships for this slide (dedupe by relId)
        const slideCharts = chartsBySlide.get(slideNum) || [];
        const seenChartRelIds = new Set<string>();
        for (const chart of slideCharts) {
          if (!seenChartRelIds.has(chart.relId)) {
            seenChartRelIds.add(chart.relId);
            slideRels.push({
              id: chart.relId,
              type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart",
              target: `../${chart.chartPath}`,
            });
          }
        }

        // Hyperlink relationships for this slide (dedupe by relId)
        if (this._links) {
          const seenLinkRelIds = new Set<string>();
          for (const link of this._links) {
            if (
              link.slideIndex === slideNum &&
              !seenLinkRelIds.has(link.relId)
            ) {
              seenLinkRelIds.add(link.relId);
              slideRels.push({
                id: link.relId,
                type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
                target: link.url,
                targetMode: "External",
              });
            }
          }
        }

        // Image relationships for this slide (dedupe by relId to prevent duplicates)
        // Remap rIdImage* to sequential rId* to comply with OOXML standards.
        // The original rIdImage* IDs are used in the slide XML (blipFill r:embed),
        // so we build a mapping and rewrite the slide XML before adding it.
        const imageRelMap = new Map<string, string>(); // rIdImage15 → rId4
        if (this._images) {
          const seenRelIds = new Set<string>();
          for (const img of this._images) {
            if (img.slideIndex === slideNum && !seenRelIds.has(img.relId)) {
              seenRelIds.add(img.relId);
              const newRelId = `rId${relIdCounter++}`;
              imageRelMap.set(img.relId, newRelId);
              slideRels.push({
                id: newRelId,
                type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
                target: `../${img.mediaPath}`,
              });
            }
          }
        }

        entries.push({
          name: `ppt/slides/_rels/slide${i + 1}.xml.rels`,
          data: relsXml(slideRels),
        });

        // Build transition XML
        const transXml = slide.transition
          ? buildTransitionXml(
              slide.transition,
              slide.transitionDuration ?? 500,
            )
          : "";

        // Get animations for this slide (if any)
        const slideAnims = this._animations ? this._animations[i] : undefined;

        // Generate slide XML and remap image rel IDs from rIdImage* to rId*
        let slideContent = slideXml(
          slide.bg,
          slide.shapes,
          transXml,
          slideAnims,
        );
        // Rewrite r:embed="rIdImage15" → r:embed="rId4" etc.
        for (const [oldId, newId] of imageRelMap) {
          slideContent = slideContent.replaceAll(
            `r:embed="${oldId}"`,
            `r:embed="${newId}"`,
          );
        }
        entries.push({
          name: `ppt/slides/slide${i + 1}.xml`,
          data: slideContent,
        });

        // Notes slide (if notes exist)
        if (slide.notes && notesSlideIndex !== undefined) {
          entries.push({
            name: `ppt/notesSlides/notesSlide${notesSlideIndex}.xml`,
            data: notesSlideXml(slide.notes, i + 1),
          });
          // Add notes slide relationship file (required!)
          // Must reference both the notesMaster AND the parent slide
          entries.push({
            name: `ppt/notesSlides/_rels/notesSlide${notesSlideIndex}.xml.rels`,
            data: relsXml([
              {
                id: "rId1",
                type: RT_NOTES_MASTER,
                target: "../notesMasters/notesMaster1.xml",
              },
              {
                id: "rId2",
                type: RT_SLIDE,
                target: `../slides/slide${i + 1}.xml`,
              },
            ]),
          });
          // Add notes content type override
          overrides.push({
            partName: `/ppt/notesSlides/notesSlide${notesSlideIndex}.xml`,
            contentType:
              "application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml",
          });
        }
      }

      // Add chart ZIP entries and content type overrides
      if (this._charts && this._charts.length > 0) {
        for (const chart of this._charts) {
          overrides.push({
            partName: `/ppt/${chart.chartPath}`,
            contentType:
              "application/vnd.openxmlformats-officedocument.drawingml.chart+xml",
          });
        }
        if (this._chartEntries) {
          for (const entry of this._chartEntries) {
            entries.push(entry);
          }
        }
      }

      // Collect image extensions for Default entries (not Override per-file)
      const imageExtensions = new Set<string>();
      if (this._images && this._images.length > 0) {
        for (const img of this._images) {
          // Extract extension from mediaPath (e.g., "media/image1.png" -> "png")
          const ext = img.mediaPath.split(".").pop()?.toLowerCase();
          if (ext) {
            imageExtensions.add(ext);
          }
          // Add image binary data as ZIP entry
          entries.push({
            name: `ppt/${img.mediaPath}`,
            data: img.data, // Uint8Array — zip-format handles binary entries
          });
        }
      }

      // Build defaults array: standard ones plus image extensions
      const defaults = [
        {
          extension: "rels",
          contentType:
            "application/vnd.openxmlformats-package.relationships+xml",
        },
        { extension: "xml", contentType: "application/xml" },
      ];
      // Map image extensions to MIME types
      const extToMime: Record<string, string> = {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        bmp: "image/bmp",
        tiff: "image/tiff",
        tif: "image/tiff",
        svg: "image/svg+xml",
        webp: "image/webp",
      };
      for (const ext of imageExtensions) {
        const mime = extToMime[ext] || `image/${ext}`;
        defaults.push({ extension: ext, contentType: mime });
      }

      // Rebuild Content_Types with notes + chart overrides, plus image defaults
      entries[0] = {
        name: "[Content_Types].xml",
        data: contentTypesXml(overrides, defaults),
      };

      return entries;
    },

    /**
     * Build the presentation and return it as a ready-to-write Uint8Array ZIP.
     * This is a convenience wrapper: buildZip() = createZip(build()).
     * Use with writeFileBinary: writeFileBinary('output.pptx', pres.buildZip())
     * @returns {Uint8Array} Complete PPTX file as bytes
     */
    buildZip() {
      // Clean up orphan charts (charts created but never used in a slide)
      this._cleanupOrphanCharts();

      // ── Strict validation (mandatory, no bypass) ──────────────────────
      const validationResult = _validatePresentation(
        slides,
        this._charts || [],
        this._chartEntries || [],
        this._images || [],
        this._links || [],
      );
      if (!validationResult.ok) {
        _throwValidationError(validationResult);
      }

      // Insert warning slide at the beginning
      this._insertWarningSlide();
      return createZip(this.build());
    },

    /**
     * Remove orphan charts that aren't referenced by any slide XML.
     * Charts can become orphaned when a handler fails after embedChart()
     * but before the slide is actually added. The chart is saved to state
     * during auto-save but never appears in any slide's shapes.
     * @internal
     */
    _cleanupOrphanCharts() {
      if (!this._charts || this._charts.length === 0) return;

      // Collect all rIdChart* references from all slide shapes
      const usedRelIds = new Set<string>();
      for (const slide of slides) {
        const shapes = slide.shapes || "";
        // Match r:id="rIdChart1" or r:id="rIdChart123" patterns
        const matches = shapes.matchAll(/r:id="(rIdChart\d+)"/g);
        for (const m of matches) {
          usedRelIds.add(m[1]);
        }
      }

      // Filter _charts to only keep those with relIds that are actually used
      const usedCharts: typeof pres._charts = [];
      const usedChartPaths = new Set<string>();
      for (const chart of this._charts) {
        if (chart.relId && usedRelIds.has(chart.relId)) {
          usedCharts.push(chart);
          if (chart.chartPath) {
            usedChartPaths.add(chart.chartPath);
          }
        }
      }
      this._charts = usedCharts;

      // Filter _chartEntries to only keep those for used charts
      if (this._chartEntries && this._chartEntries.length > 0) {
        const usedEntries: typeof pres._chartEntries = [];
        for (const entry of this._chartEntries) {
          // entry.name is like "ppt/charts/chart1.xml"
          const match = entry.name.match(/ppt\/(charts\/chart\d+\.xml)/);
          if (match && usedChartPaths.has(match[1])) {
            usedEntries.push(entry);
          }
        }
        this._chartEntries = usedEntries;
      }
    },

    /**
     * Insert a warning slide at position 0 indicating this was AI-generated.
     * Called automatically by buildZip().
     * @internal
     */
    _insertWarningSlide() {
      const t = pres.theme;
      const currentSlideCount = slides.length;

      // Create warning slide content
      const warningText = textBox({
        x: 1,
        y: 2,
        w: 11.33,
        h: 2,
        text: "⚠️ Warning: This PowerPoint deck was generated by HyperAgent.\nYou should carefully check and verify the contents.",
        fontSize: 28,
        color: t.fg,
        bold: true,
        align: "ctr",
        valign: "middle",
        _skipBoundsCheck: true,
      });

      // Create hyperlink to HyperAgent repo
      const linkUrl = "https://github.com/hyperlight-dev/hyperagent";
      const slideIdx = currentSlideCount + 1;
      if (!pres._links) pres._links = [];
      const linkId = `rIdLink${pres._links.length + 1}`;
      pres._links.push({ slideIndex: slideIdx, relId: linkId, url: linkUrl });

      const linkShape = nextShapeIdAndName("Hyperlink");
      const linkText = `<p:sp><p:nvSpPr><p:cNvPr id="${linkShape.id}" name="${linkShape.name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${spTransform(inches(3), inches(4.5), inches(7.33), inches(0.6))}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" anchor="ctr"/><a:lstStyle/><a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="en-US" sz="1600" u="sng" dirty="0"><a:solidFill><a:srgbClr val="${t.accent1.replace("#", "")}"/></a:solidFill><a:hlinkClick r:id="${linkId}"/></a:rPr><a:t>Learn more about HyperAgent</a:t></a:r></a:p></p:txBody></p:sp>`;

      // Add slide at end, then reorder to position 0
      const bg = solidBg(t.bg);
      pres.addSlide(bg, warningText + linkText, {});

      // Reorder slides to put warning first: [new, 0, 1, 2, ...]
      if (slides.length > 1) {
        const newOrder = [slides.length - 1]; // new slide goes first
        for (let i = 0; i < slides.length - 1; i++) {
          newOrder.push(i);
        }
        pres.reorderSlides(newOrder);

        // Fix link slide indices after reorder (warning slide is now index 1)
        if (pres._links) {
          for (const link of pres._links) {
            if (link.slideIndex === slideIdx) {
              link.slideIndex = 1; // warning slide is now first
            } else if (link.slideIndex < slideIdx) {
              link.slideIndex += 1; // other slides shifted down
            }
          }
        }

        // Fix image slide indices after reorder
        if (pres._images) {
          for (const img of pres._images) {
            if (img.slideIndex < slideIdx) {
              img.slideIndex += 1; // other slides shifted down
            }
          }
        }

        // Fix chart slide indices after reorder
        if (pres._charts) {
          for (const chart of pres._charts) {
            if (chart.slideIndex !== undefined && chart.slideIndex < slideIdx) {
              chart.slideIndex += 1; // other slides shifted down
            }
          }
        }
      }
    },

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
    serialize() {
      return {
        _version: 1,
        themeName: themeName,
        defaultBackground: defaultBackground,
        forceAllColors: isForceAllColors(),
        defaultTextColor: defaultTextColor,
        slides: slides,
        images: pres._images || [],
        imageIndex: pres._imageIndex || 0,
        charts: pres._charts || [],
        chartEntries: pres._chartEntries || [],
        shapeIdCounter: getShapeIdCounter(), // Track shape IDs across handlers
      };
    },

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
    save(key: string) {
      if (!key || typeof key !== "string") {
        throw new Error("pres.save(): key must be a non-empty string");
      }
      // Cast to unknown to satisfy StorableValue type - the serialized state
      // contains nested objects that match StorableValue semantically but not structurally
      sharedStateSet(
        key,
        this.serialize() as unknown as import("ha:shared-state").StorableValue,
      );
    },
  };

  return pres;
}

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
export function loadPresentation(key: string): Pres {
  if (!key || typeof key !== "string") {
    throw new Error("loadPresentation(): key must be a non-empty string");
  }
  const state = sharedStateGet(key);
  if (!state) {
    throw new Error(
      `loadPresentation(): no presentation found at key '${key}'. ` +
        `Use pres.save('${key}') to store it first.`,
    );
  }
  return restorePresentation(state as unknown as SerializedPresentation);
}

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
export function restorePresentation(state: SerializedPresentation): Pres {
  if (!state || typeof state !== "object") {
    throw new Error(
      "restorePresentation: state is required — pass the object from pres.serialize().",
    );
  }
  if (!state.themeName) {
    throw new Error(
      "restorePresentation: invalid state — missing themeName. " +
        "Pass the object returned by pres.serialize().",
    );
  }

  // Recreate the presentation with the same options
  const pres = createPresentation({
    theme: state.themeName,
    defaultBackground: state.defaultBackground,
    forceAllColors: state.forceAllColors,
    defaultTextColor: state.defaultTextColor,
  });

  // Restore slides (replace the empty array)
  if (state.slides && Array.isArray(state.slides)) {
    pres.slides = state.slides;
  }

  // Restore images
  if (state.images && Array.isArray(state.images)) {
    pres._images = state.images;
  }
  // Restore image index counter to prevent duplicate rIdImage* values
  if (typeof state.imageIndex === "number") {
    pres._imageIndex = state.imageIndex;
  }

  // Restore charts
  if (state.charts && Array.isArray(state.charts)) {
    pres._charts = state.charts;
  }
  if (state.chartEntries && Array.isArray(state.chartEntries)) {
    pres._chartEntries = state.chartEntries;
  }

  // Restore shape ID counter to prevent duplicate IDs when adding new shapes
  // This is critical for addSlideNumbers/addFooter called after restore
  if (typeof state.shapeIdCounter === "number") {
    setShapeIdCounter(state.shapeIdCounter);
  }

  return pres;
}

// Maximum bytes per write call (2MB) — must match fs-write plugin limit
const EXPORT_CHUNK_SIZE = 2 * 1024 * 1024;

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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function exportToFile(pres: Pres, path: string, fsWrite: any) {
  // Validate pres
  if (!pres || !pres.theme || typeof pres.buildZip !== "function") {
    throw new Error(
      `exportToFile: first parameter must be the presentation object from createPresentation(). ` +
        `Got: ${pres === null ? "null" : typeof pres}. ` +
        `Correct usage: exportToFile(pres, 'output.pptx', fsWrite)`,
    );
  }
  // Validate path
  if (!path || typeof path !== "string") {
    throw new Error(
      `exportToFile: second parameter must be a file path string. ` +
        `Got: ${typeof path}. ` +
        `Correct usage: exportToFile(pres, 'output.pptx', fsWrite)`,
    );
  }
  // Validate fsWrite module
  if (!fsWrite || typeof fsWrite.writeFileBinary !== "function") {
    throw new Error(
      `exportToFile: third parameter must be the fs-write module. ` +
        `Import it in your handler: import * as fsWrite from "host:fs-write"; ` +
        `Then call: exportToFile(pres, 'output.pptx', fsWrite)`,
    );
  }

  // Build the ZIP
  const zip = pres.buildZip();
  const totalSize = zip.length;

  // Auto-chunk large files to avoid fs-write per-call limits
  if (totalSize <= EXPORT_CHUNK_SIZE) {
    // Small file — single write
    fsWrite.writeFileBinary(path, zip);
    return {
      slides: pres.slideCount,
      size: totalSize,
      path: path,
      chunks: 1,
    };
  }

  // Large file — chunked writes
  // First chunk: writeFileBinary (creates/overwrites)
  const firstChunk = zip.slice(0, EXPORT_CHUNK_SIZE);
  fsWrite.writeFileBinary(path, firstChunk);

  // Remaining chunks: appendFileBinary
  let offset = EXPORT_CHUNK_SIZE;
  let chunkCount = 1;
  while (offset < totalSize) {
    const end = Math.min(offset + EXPORT_CHUNK_SIZE, totalSize);
    const chunk = zip.slice(offset, end);
    fsWrite.appendFileBinary(path, chunk);
    offset = end;
    chunkCount++;
  }

  return {
    slides: pres.slideCount,
    size: totalSize,
    path: path,
    chunks: chunkCount,
  };
}

// ── Convenience Slide Builders ───────────────────────────────────────
// IMPORTANT: All slide functions require the presentation object as the FIRST parameter.
// Call pattern: slideFunction(pres, { title: '...', ... })
// NOT: slideFunction({ title: '...' })  ← This will fail!

/**
 * Validate that the first parameter is a presentation object.
 * Throws a helpful error if the user passed options instead.
 * @param {*} pres - Value to validate
 * @param {string} fnName - Function name for error message
 * @throws {Error} If pres is not a valid presentation object
 */
function _requirePres(pres: Pres, fnName: string) {
  if (!pres || !pres.theme || typeof pres.addSlide !== "function") {
    throw new Error(
      `${fnName}: first parameter must be the presentation object from createPresentation(). ` +
        `Got: ${pres === null ? "null" : typeof pres}. ` +
        `Correct usage: ${fnName}(pres, { title: 'My Title' }) — NOT ${fnName}({ title: '...' })`,
    );
  }
}

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
export function titleSlide(pres: Pres, opts: TitleSlideOptions) {
  // ── Input validation ──────────────────────────────────────────────
  _requirePres(pres, "titleSlide");
  if (!opts || typeof opts !== "object") {
    throw new Error(
      `titleSlide: second parameter must be an options object with at least { title: 'string' }. ` +
        `Got: ${typeof opts}. ` +
        `Correct usage: titleSlide(pres, { title: 'My Title', subtitle: 'Optional' })`,
    );
  }
  requireString(opts.title, "titleSlide.title");
  const bgSpec = opts.background;
  if (bgSpec && typeof bgSpec === "string") {
    requireHex(bgSpec, "titleSlide.background");
  }

  const t = pres.theme;
  const bg = bgSpec
    ? typeof bgSpec === "object" && "color1" in bgSpec
      ? gradientBg(bgSpec.color1, bgSpec.color2, bgSpec.angle ?? 315)
      : solidBg(bgSpec)
    : gradientBg(t.bg, t.accent1, 315);
  const shapes = [
    textBox({
      x: 1,
      y: 2,
      w: 11.33,
      h: 2,
      text: opts.title,
      fontSize: 44,
      color: t.fg,
      bold: true,
      align: "ctr",
      valign: "middle",
      _skipBoundsCheck: true,
    }),
  ];
  if (opts.subtitle) {
    shapes.push(
      textBox({
        x: 2,
        y: 4,
        w: 9.33,
        h: 1,
        text: opts.subtitle,
        fontSize: 20,
        color: t.subtle,
        align: "ctr",
        _skipBoundsCheck: true,
      }),
    );
  }
  pres.addSlide(bg, shapes.map(_s).join(""), opts);
}

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
export function sectionSlide(pres: Pres, opts: SectionSlideOptions) {
  // ── Input validation ──────────────────────────────────────────────
  _requirePres(pres, "sectionSlide");
  requireString(opts.title, "sectionSlide.title");

  const t = pres.theme;
  const bg = solidBg(t.accent1);
  const shapes = [
    rect({ x: 0.5, y: 3.2, w: 3, h: 0.08, fill: t.fg, _skipBoundsCheck: true }),
    textBox({
      x: 0.5,
      y: 2,
      w: 12,
      h: 1.5,
      text: opts.title,
      fontSize: 36,
      color: t.fg,
      bold: true,
      _skipBoundsCheck: true,
    }),
  ];
  if (opts.subtitle) {
    shapes.push(
      textBox({
        x: 0.5,
        y: 3.5,
        w: 12,
        h: 1,
        text: opts.subtitle,
        fontSize: 18,
        color: t.fg,
        _skipBoundsCheck: true,
      }),
    );
  }
  pres.addSlide(bg, shapes.map(_s).join(""), opts);
}

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
export function contentSlide(pres: Pres, opts: ContentSlideOptions) {
  _requirePres(pres, "contentSlide");
  requireString(opts.title, "contentSlide.title");

  const t = pres.theme;
  const bg = solidBg(t.bg);
  const titleShape = textBox({
    x: 0.5,
    y: 0.3,
    w: 12,
    h: 0.8,
    text: opts.title,
    fontSize: 28,
    color: t.fg,
    bold: true,
    _skipBoundsCheck: true,
  });
  const accentBar = rect({
    x: 0.5,
    y: 1.05,
    w: 2,
    h: 0.05,
    fill: t.accent1,
    _skipBoundsCheck: true,
  });

  const itemsArr = normalizeItems(opts.items);
  const body =
    itemsArr.length > 0
      ? bulletList({
          x: 0.5,
          y: 1.5,
          w: 12,
          h: 5.5,
          items: itemsArr,
          color: t.fg,
          _skipBoundsCheck: true,
        })
      : "";

  pres.addSlide(
    bg,
    _s(titleShape) + _s(accentBar) + (body === "" ? "" : _s(body)),
    opts,
  );
}

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
export function twoColumnSlide(pres: Pres, opts: TwoColumnSlideOptions) {
  _requirePres(pres, "twoColumnSlide");
  requireString(opts.title, "twoColumnSlide.title");

  const t = pres.theme;
  const bg = solidBg(t.bg);
  const titleShape = textBox({
    x: 0.5,
    y: 0.3,
    w: 12,
    h: 0.8,
    text: opts.title,
    fontSize: 28,
    color: t.fg,
    bold: true,
    _skipBoundsCheck: true,
  });
  const accentBar = rect({
    x: 0.5,
    y: 1.05,
    w: 2,
    h: 0.05,
    fill: t.accent1,
    _skipBoundsCheck: true,
  });
  const divider = rect({
    x: 6.5,
    y: 1.3,
    w: 0.03,
    h: 5.5,
    fill: t.subtle,
    _skipBoundsCheck: true,
  });

  const leftItemsArr = normalizeItems(opts.leftItems);
  const rightItemsArr = normalizeItems(opts.rightItems);

  const left =
    leftItemsArr.length > 0
      ? bulletList({
          x: 0.5,
          y: 1.5,
          w: 5.5,
          h: 5.5,
          items: leftItemsArr,
          color: t.fg,
          _skipBoundsCheck: true,
        })
      : "";

  const right =
    rightItemsArr.length > 0
      ? bulletList({
          x: 7,
          y: 1.5,
          w: 5.5,
          h: 5.5,
          items: rightItemsArr,
          color: t.fg,
          _skipBoundsCheck: true,
        })
      : "";

  pres.addSlide(
    bg,
    _s(titleShape) +
      _s(accentBar) +
      _s(divider) +
      (left === "" ? "" : _s(left)) +
      (right === "" ? "" : _s(right)),
    opts,
  );
}

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
export function blankSlide(pres: Pres): void {
  _requirePres(pres, "blankSlide");
  pres.addSlide(solidBg(pres.theme.bg), "");
}

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
export function customSlide(pres: Pres, opts: CustomSlideOptions) {
  _requirePres(pres, "customSlide");
  if (!opts || opts.shapes == null) {
    throw new Error(
      "customSlide: 'shapes' parameter is required. " +
        "Pass an array of ShapeFragment objects from shape builders: " +
        "customSlide(pres, { shapes: [textBox({...}), rect({...})] })",
    );
  }
  // Validate and convert ShapeFragment(s) to XML string
  const shapesXml = fragmentsToXml(opts.shapes);
  pres._addBodyRaw(shapesXml, {
    background: opts.background,
    transition: opts.transition,
    transitionDuration: opts.transitionDuration,
    notes: opts.notes,
  });
}

// ── Chart Text-Colour Patch ──────────────────────────────────────────

/**
 * Inject a <c:txPr> element into chart XML for legend, category axis, value
 * axis, and data-label blocks that lack one.  This ensures text is readable
 * on dark slide backgrounds where the OOXML theme dk1 colour matches the
 * slide fill.
 *
 * The function is intentionally conservative: it only patches closing tags
 * that do NOT already contain a <c:txPr> and operates on the raw XML string
 * to avoid pulling in a full parser.
 * @param {string} xml - Chart XML string
 * @param {string} color - Hex colour for chart text (e.g. theme fg)
 * @returns {string} Patched chart XML string
 */
function _patchChartTextColor(xml: string, color: string): string {
  if (!color) return xml;
  const c = hexColor(color);
  const txPr =
    "<c:txPr><a:bodyPr/><a:lstStyle/>" +
    "<a:p><a:pPr><a:defRPr>" +
    `<a:solidFill><a:srgbClr val="${c}"/></a:solidFill>` +
    '</a:defRPr></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr>';

  // OOXML element ordering requires txPr at specific positions:
  //   catAx/valAx: txPr must appear BEFORE <c:crossAx> (ECMA-376 §21.2.2.25/§21.2.2.227)
  //   dLbls:       txPr must appear BEFORE <c:dLblPos>/<c:showVal> etc.
  //   legend:      txPr goes at the end (before </c:legend>) which is correct
  //
  // For each target, we define "insert-before" sentinels.  If found inside
  // the block, txPr is inserted before the first matching sentinel.
  // Otherwise we fall back to the closing tag (correct for <c:legend>).
  const targets = [
    { tag: "c:legend", sentinels: [] },
    { tag: "c:catAx", sentinels: ["<c:crossAx"] },
    { tag: "c:valAx", sentinels: ["<c:crossAx"] },
    {
      tag: "c:dLbls",
      sentinels: [
        "<c:dLblPos",
        "<c:showLegendKey",
        "<c:showVal",
        "<c:showCatName",
        "<c:showSerName",
        "<c:showPercent",
        "<c:showBubbleSize",
        "<c:separator",
      ],
    },
  ];

  let patched = xml;
  for (const { tag, sentinels } of targets) {
    const closeTag = `</${tag}>`;
    const idx = patched.indexOf(closeTag);
    if (idx === -1) continue;

    // Find the opening tag to scope our search
    const openTag = `<${tag}`;
    const openIdx = patched.lastIndexOf(openTag, idx);
    const block = patched.slice(openIdx, idx);
    if (block.includes("c:txPr")) continue; // already styled

    // Find the correct insertion point within the block
    let insertIdx = idx; // default: before closing tag
    for (const sentinel of sentinels) {
      const sentinelIdx = patched.indexOf(sentinel, openIdx);
      if (sentinelIdx !== -1 && sentinelIdx < idx) {
        insertIdx = sentinelIdx;
        break;
      }
    }

    patched = patched.slice(0, insertIdx) + txPr + patched.slice(insertIdx);
  }
  return patched;
}

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
export function chartSlide(pres: Pres, opts: ChartSlideOptions) {
  // ── Input validation ──────────────────────────────────────────────
  _requirePres(pres, "chartSlide");
  requireString(opts.title, "chartSlide.title");
  if (opts.chart && opts.chart.type !== "chart") {
    throw new Error(
      `chartSlide.chart: expected a chart object from barChart/pieChart/lineChart/comboChart ` +
        `but got an object with type="${opts.chart.type}". ` +
        `Build the chart first: const chart = barChart({...}); then pass it to chartSlide.`,
    );
  }

  const t = pres.theme;
  const bg = solidBg(t.bg);
  const titleShape = textBox({
    x: 0.5,
    y: 0.3,
    w: 12,
    h: 0.8,
    text: opts.title,
    fontSize: 28,
    color: t.fg,
    bold: true,
  });
  const accentBar = rect({ x: 0.5, y: 1.05, w: 2, h: 0.05, fill: t.accent1 });

  // Import embedChart dynamically — it's in pptx-charts
  // The caller passes the chart object, we embed it at the given position
  // Reduced from 5.7 to 5.2 to leave room for bottom legend without clipping
  const pos = opts.chartPosition || { x: 0.5, y: 1.3, w: 12, h: 5.2 };
  let chartXml = "";
  if (opts.chart && opts.chart.type === "chart") {
    // Use the pres-level chart registry
    if (!pres._charts) pres._charts = [];
    if (!pres._chartEntries) pres._chartEntries = [];

    // Find the highest chart index in use to avoid conflicts after sandbox rebuild
    let maxIdx = 0;
    for (const chart of pres._charts) {
      if (chart.index > maxIdx) maxIdx = chart.index;
    }
    // Also check _chartEntries for charts that might have been created but not tracked
    if (pres._chartEntries) {
      for (const entry of pres._chartEntries) {
        const match = entry.name.match(/chart(\d+)\.xml$/);
        if (match) {
          const entryIdx = parseInt(match[1], 10);
          if (entryIdx > maxIdx) maxIdx = entryIdx;
        }
      }
    }
    const idx = maxIdx + 1;
    const slideIdx = (pres.slides?.length || 0) + 1;
    const chartPath = `charts/chart${idx}.xml`;
    const relId = `rIdChart${idx}`;

    pres._charts.push({ index: idx, slideIndex: slideIdx, relId, chartPath });

    // Inject theme text colour into chart XML so axis labels, legend text,
    // and data labels are visible on dark slide backgrounds.  Only patches
    // charts that don't already carry explicit text properties (<c:txPr>).
    const chartData = _patchChartTextColor(opts.chart._chartXml, t.fg);
    pres._chartEntries.push({ name: `ppt/${chartPath}`, data: chartData });
    // Note: Empty chart .rels files cause OOXML corruption - don't create them
    // When charts have external data sources, we'll add those relationships here

    const cx = Math.round((pos.w || 12) * 914400);
    const cy = Math.round((pos.h || 5.2) * 914400);
    const offX = Math.round((pos.x || 0.5) * 914400);
    const offY = Math.round((pos.y || 1.3) * 914400);
    chartXml = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${nextShapeId()}" name="Chart ${idx}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${offX}" y="${offY}"/><a:ext cx="${cx}" cy="${cy}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="${relId}"/></a:graphicData></a:graphic></p:graphicFrame>`;
  }

  // Handle extraItems
  const extraItemsArr = normalizeItems(opts.extraItems);
  const extra =
    extraItemsArr.length > 0
      ? bulletList({
          x: 0.5,
          y: 6.6,
          w: 12,
          h: 1,
          items: extraItemsArr,
          fontSize: 12,
          color: t.fg,
          _skipBoundsCheck: true,
        })
      : "";

  pres.addSlide(
    bg,
    _s(titleShape) + _s(accentBar) + chartXml + (extra === "" ? "" : _s(extra)),
    opts,
  );
}

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
export function comparisonSlide(pres: Pres, opts: ComparisonSlideOptions) {
  _requirePres(pres, "comparisonSlide");
  requireString(opts.title, "comparisonSlide.title");

  // Column positioning constants
  const LEFT_COL = { x: 0.5, w: 5.5 };
  const RIGHT_COL = { x: 7, w: 5.5 };
  const BODY_Y = 1.9;
  const BODY_H = 4.8;
  const MAX_ITEMS = 12;

  const t = pres.theme;
  const bg = solidBg(t.bg);
  const titleShape = textBox({
    x: 0.5,
    y: 0.3,
    w: 12,
    h: 0.8,
    text: opts.title,
    fontSize: 28,
    color: t.fg,
    bold: true,
    _skipBoundsCheck: true,
  });
  const accentBar = rect({
    x: 0.5,
    y: 1.05,
    w: 2,
    h: 0.05,
    fill: t.accent1,
    _skipBoundsCheck: true,
  });
  const leftHeader = textBox({
    x: LEFT_COL.x,
    y: 1.3,
    w: LEFT_COL.w,
    h: 0.5,
    text: opts.leftTitle || "Option A",
    fontSize: 18,
    color: t.accent1,
    bold: true,
    _skipBoundsCheck: true,
  });
  const rightHeader = textBox({
    x: RIGHT_COL.x,
    y: 1.3,
    w: RIGHT_COL.w,
    h: 0.5,
    text: opts.rightTitle || "Option B",
    fontSize: 18,
    color: t.accent2,
    bold: true,
    _skipBoundsCheck: true,
  });
  const divider = rect({
    x: 6.5,
    y: 1.3,
    w: 0.03,
    h: 5.5,
    fill: t.subtle,
    _skipBoundsCheck: true,
  });

  // Build left column content
  const leftItemsArr = normalizeItems(opts.leftItems);
  const left =
    leftItemsArr.length > 0
      ? bulletList({
          x: LEFT_COL.x,
          y: BODY_Y,
          w: LEFT_COL.w,
          h: BODY_H,
          items: leftItemsArr.slice(0, MAX_ITEMS),
          color: t.bodyText,
          bulletColor: t.accent1,
        })
      : "";

  // Build right column content
  const rightItemsArr = normalizeItems(opts.rightItems);
  const right =
    rightItemsArr.length > 0
      ? bulletList({
          x: RIGHT_COL.x,
          y: BODY_Y,
          w: RIGHT_COL.w,
          h: BODY_H,
          items: rightItemsArr.slice(0, MAX_ITEMS),
          color: t.bodyText,
          bulletColor: t.accent2,
        })
      : "";

  pres.addSlide(
    bg,
    _s(titleShape) +
      _s(accentBar) +
      _s(leftHeader) +
      _s(rightHeader) +
      _s(divider) +
      (left === "" ? "" : _s(left)) +
      (right === "" ? "" : _s(right)),
    opts,
  );
}

// ── Slide Templates ───────────────────────────────────────────────────
// High-level templates that combine multiple shapes into common layouts.
// These are theme-aware — colors adapt to the active theme automatically.

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
export function heroSlide(pres: Pres, opts: HeroSlideOptions) {
  _requirePres(pres, "heroSlide");
  if (!opts.image || !(opts.image instanceof Uint8Array)) {
    throw new Error(
      "heroSlide: 'opts.image' is required — provide image data (Uint8Array from fetchBinary).",
    );
  }
  // Title is optional — image-only hero slides are valid

  const format = opts.imageFormat || "jpg";
  const overlayOpacity = opts.overlayOpacity ?? 0.5;
  const overlayColor = opts.overlayColor || "000000";
  const titleSize = opts.titleSize || 48;
  const subtitleSize = opts.subtitleSize || 24;
  const align = opts.align || "center";

  // Calculate positions based on alignment
  const xMap: Record<string, number> = { left: 0.8, center: 0.5, right: 0.5 };
  const wMap: Record<string, number> = {
    left: 11.5,
    center: 12.333,
    right: 11.5,
  };
  const textX = xMap[align] || 0.5;
  const textW = wMap[align] || 12.333;

  // Build shapes
  const bgImg = backgroundImage(pres, opts.image, format);
  const darkOverlay = overlay({ opacity: overlayOpacity, color: overlayColor });

  let shapes = _s(bgImg) + _s(darkOverlay);

  // Only add title if provided
  if (opts.title) {
    const titleY = opts.subtitle ? 2.8 : 3.2;
    const titleShape = textBox({
      x: textX,
      y: titleY,
      w: textW,
      h: 1.5,
      text: opts.title,
      fontSize: titleSize,
      color: "FFFFFF",
      bold: true,
      align: align,
      forceColor: true,
    });
    shapes += _s(titleShape);

    if (opts.subtitle) {
      const subtitleShape = textBox({
        x: textX,
        y: titleY + 1.4,
        w: textW,
        h: 0.8,
        text: opts.subtitle,
        fontSize: subtitleSize,
        color: "FFFFFF",
        align: align,
        forceColor: true,
      });
      shapes += _s(subtitleShape);
    }
  }

  pres._addBodyRaw(shapes, {
    background: "000000", // Black bg in case image doesn't fully load
    transition: opts.transition,
    notes: opts.notes,
  });
}

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
export function statGridSlide(pres: Pres, opts: StatGridSlideOptions) {
  _requirePres(pres, "statGridSlide");
  requireArray(opts.stats, "statGridSlide.stats");
  if (opts.stats.length < 2 || opts.stats.length > 4) {
    throw new Error(
      "statGridSlide: 'opts.stats' must have 2-4 items. Got: " +
        opts.stats.length,
    );
  }

  const t = pres.theme;
  const valueSize = opts.valueSize || 48;
  const labelSize = opts.labelSize || 16;
  const accentColor = opts.accentColor || t.accent1;

  let shapes = "";

  // Title if provided
  if (opts.title) {
    shapes += textBox({
      x: 0.5,
      y: 0.5,
      w: 12,
      h: 0.8,
      text: opts.title,
      fontSize: 28,
      color: t.fg,
      bold: true,
    });
  }

  // Calculate stat positions
  const cols = layoutColumns(opts.stats.length, {
    margin: 0.8,
    gap: 0.3,
    y: opts.title ? 2.2 : 1.5,
    h: 4,
  });

  // Build stat boxes
  for (let i = 0; i < opts.stats.length; i++) {
    const stat = opts.stats[i];
    const col = cols[i];

    // Value
    shapes += textBox({
      x: col.x,
      y: col.y,
      w: col.w,
      h: 1.5,
      text: String(stat.value),
      fontSize: valueSize,
      color: accentColor,
      bold: true,
      align: "center",
    });

    // Label
    shapes += textBox({
      x: col.x,
      y: col.y + 1.5,
      w: col.w,
      h: 0.6,
      text: stat.label,
      fontSize: labelSize,
      color: t.subtle || t.fg,
      align: "center",
    });

    // Divider line (except after last)
    if (i < opts.stats.length - 1) {
      shapes += rect({
        x: col.x + col.w + 0.15,
        y: col.y + 0.3,
        w: 0.02,
        h: 2,
        fill: t.subtle || t.fg,
      });
    }
  }

  pres._addBodyRaw(shapes, {
    transition: opts.transition,
    notes: opts.notes,
  });
}

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
export function imageGridSlide(pres: Pres, opts: ImageGridSlideOptions) {
  _requirePres(pres, "imageGridSlide");
  requireArray(opts.images, "imageGridSlide.images");
  if (opts.images.length < 2 || opts.images.length > 6) {
    throw new Error(
      "imageGridSlide: 'opts.images' must have 2-6 items. Got: " +
        opts.images.length,
    );
  }

  const t = pres.theme;
  const defaultFormat = opts.format || "jpg";
  const gap = opts.gap ?? 0.2;

  let shapes = "";

  // Title if provided
  const contentY = opts.title ? 1.3 : 0.5;
  if (opts.title) {
    shapes += textBox({
      x: 0.5,
      y: 0.3,
      w: 12,
      h: 0.8,
      text: opts.title,
      fontSize: 28,
      color: t.fg,
      bold: true,
    });
  }

  // Determine grid layout based on count
  const count = opts.images.length;
  let cols, rows;
  if (count <= 2) {
    cols = 2;
    rows = 1;
  } else if (count <= 4) {
    cols = 2;
    rows = 2;
  } else {
    cols = 3;
    rows = 2;
  }

  // Calculate cell dimensions
  const margin = 0.5;
  const availW = SLIDE_WIDTH_INCHES - 2 * margin;
  const firstImg = opts.images[0];
  const firstHasCaption =
    firstImg && !(firstImg instanceof Uint8Array) && firstImg.caption;
  const availH = (opts.title ? 6 : 6.5) - (firstHasCaption ? 0.5 : 0);
  const cellW = (availW - (cols - 1) * gap) / cols;
  const cellH = (availH - (rows - 1) * gap) / rows;

  // Place images
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const x = margin + col * (cellW + gap);
    const y = contentY + row * (cellH + gap);

    const imgItem = opts.images[i];
    const isUint8Array = imgItem instanceof Uint8Array;
    const imgData = isUint8Array ? imgItem : imgItem.data;
    const imgFormat = isUint8Array
      ? defaultFormat
      : imgItem.format || defaultFormat;
    const caption = isUint8Array ? undefined : imgItem.caption;

    if (!imgData || !(imgData instanceof Uint8Array)) {
      throw new Error(
        `imageGridSlide: images[${i}] must be a Uint8Array or {data: Uint8Array, ...}`,
      );
    }

    // Embed image
    shapes += embedImage(pres, {
      x: x,
      y: y,
      w: cellW,
      h: caption ? cellH - 0.4 : cellH,
      data: imgData,
      format: imgFormat,
    });

    // Caption if provided
    if (caption) {
      shapes += textBox({
        x: x,
        y: y + cellH - 0.35,
        w: cellW,
        h: 0.35,
        text: caption,
        fontSize: 11,
        color: t.subtle || t.fg,
        align: "center",
      });
    }
  }

  pres._addBodyRaw(shapes, {
    transition: opts.transition,
    notes: opts.notes,
  });
}

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
export function quoteSlide(pres: Pres, opts: QuoteSlideOptions) {
  _requirePres(pres, "quoteSlide");
  requireString(opts.quote, "quoteSlide.quote");

  const t = pres.theme;
  const quoteSize = opts.quoteSize || 32;

  let shapes = "";

  // Large opening quote mark
  shapes += textBox({
    x: 0.8,
    y: 1.2,
    w: 1,
    h: 1.2,
    text: "\u201C", // Left double quote
    fontSize: 120,
    color: t.accent1,
    bold: true,
    forceColor: true, // Theme color - bypass contrast check
    _skipBoundsCheck: true, // Decorative element with known sizing
  });

  // Quote text
  shapes += textBox({
    x: 1.5,
    y: 2,
    w: 10,
    h: 3,
    text: opts.quote,
    fontSize: quoteSize,
    color: t.fg,
    italic: true,
    align: "left",
    forceColor: true, // Theme color - bypass contrast check
    _skipBoundsCheck: true, // User-provided content, let PowerPoint handle overflow
  });

  // Large closing quote mark
  shapes += textBox({
    x: 10.8,
    y: 4.2,
    w: 1,
    h: 1.2,
    text: "\u201D", // Right double quote
    fontSize: 120,
    color: t.accent1,
    bold: true,
    align: "right",
    forceColor: true, // Theme color - bypass contrast check
    _skipBoundsCheck: true, // Decorative element with known sizing
  });

  // Attribution line
  if (opts.author) {
    let attribution = `— ${opts.author}`;
    if (opts.role) {
      attribution += `, ${opts.role}`;
    }
    shapes += textBox({
      x: 1.5,
      y: 5.2,
      w: 10,
      h: 0.5,
      text: attribution,
      fontSize: 16,
      color: t.subtle || t.fg,
      forceColor: true, // Theme color - bypass contrast check
    });
  }

  // Accent bar
  shapes += rect({
    x: 1.5,
    y: 5.8,
    w: 3,
    h: 0.06,
    fill: t.accent1,
  });

  pres._addBodyRaw(shapes, {
    transition: opts.transition,
    notes: opts.notes,
  });
}

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
export function bigNumberSlide(pres: Pres, opts: BigNumberSlideOptions) {
  _requirePres(pres, "bigNumberSlide");
  requireString(opts.number, "bigNumberSlide.number");

  const t = pres.theme;
  const numberSize = opts.numberSize || 160;
  const unitSize = opts.unitSize || 48;
  const labelSize = opts.labelSize || 24;

  // Colors - default to theme accent for number, subtle for label
  const numberColor = opts.numberColor || t.accent1;
  const unitColor = opts.unitColor || numberColor;
  const labelColor = opts.labelColor || t.subtle || t.fg;

  let shapes = "";

  // Calculate vertical centering
  // Number + unit takes roughly 2 inches, label adds 0.5 more
  const hasUnit = !!opts.unit;
  const hasLabel = !!opts.label;
  const contentHeight = 2 + (hasLabel ? 0.8 : 0);
  const startY = (SLIDE_HEIGHT_INCHES - contentHeight) / 2;

  // Big number - centered, massive font
  shapes += textBox({
    x: 0.5,
    y: startY,
    w: hasUnit ? 8 : 12.33, // Narrower if unit is next to it
    h: 2,
    text: opts.number,
    fontSize: numberSize,
    color: numberColor,
    bold: true,
    align: hasUnit ? "right" : "center",
    forceColor: true,
  });

  // Unit next to number (same line)
  if (hasUnit) {
    shapes += textBox({
      x: 8.7,
      y: startY + 0.8, // Slightly lower to align with number baseline
      w: 4,
      h: 1.2,
      text: opts.unit!, // Asserted: hasUnit check guarantees defined
      fontSize: unitSize,
      color: unitColor,
      bold: true,
      align: "left",
      forceColor: true,
    });
  }

  // Label below
  if (hasLabel) {
    shapes += textBox({
      x: 0.5,
      y: startY + 2.2,
      w: 12.33,
      h: 0.6,
      text: opts.label!, // Asserted: hasLabel check guarantees defined
      fontSize: labelSize,
      color: labelColor,
      align: "center",
      forceColor: true,
    });
  }

  pres._addBodyRaw(shapes, {
    background: opts.background,
    transition: opts.transition,
    notes: opts.notes,
  });
}

// ── Technical Slide Templates ─────────────────────────────────────────

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
export function architectureDiagramSlide(
  pres: Pres,
  opts: ArchitectureDiagramSlideOptions,
) {
  _requirePres(pres, "architectureDiagramSlide");
  requireString(opts.title, "architectureDiagramSlide.title");
  requireArray(opts.components, "architectureDiagramSlide.components", {
    nonEmpty: true,
  });

  const t = pres.theme;
  const bg = solidBg(t.bg);
  const layout = opts.layout || "horizontal";
  const showArrows = opts.showArrows !== false;
  const comps = opts.components.slice(0, 6); // Max 6 components

  // Title
  let shapes = _s(
    textBox({
      x: 0.5,
      y: 0.3,
      w: 12,
      h: 0.8,
      text: opts.title,
      fontSize: 28,
      color: t.fg,
      bold: true,
    }),
  );
  shapes += _s(rect({ x: 0.5, y: 1.05, w: 2, h: 0.05, fill: t.accent1 }));

  const accentColors = [
    t.accent1,
    t.accent2,
    "00E676",
    "FFD700",
    "FF7043",
    "AB47BC",
  ];

  if (layout === "horizontal") {
    // Horizontal layout: components in a row
    const boxW = 1.8;
    const boxH = 1.5;
    const gap = 0.8;
    const totalW = comps.length * boxW + (comps.length - 1) * gap;
    const startX = (13.33 - totalW) / 2;
    const y = 3.0;

    comps.forEach((comp, i) => {
      const x = startX + i * (boxW + gap);
      const color = comp.color || accentColors[i % accentColors.length];

      // Component box
      shapes += _s(
        rect({
          x,
          y,
          w: boxW,
          h: boxH,
          fill: color,
          cornerRadius: 8,
          text: comp.label,
          fontSize: 12,
          color: autoTextColor(color),
          bold: true,
        }),
      );

      // Description below
      if (comp.description) {
        shapes += _s(
          textBox({
            x,
            y: y + boxH + 0.1,
            w: boxW,
            h: 0.6,
            text: comp.description,
            fontSize: 9,
            color: t.subtle,
            align: "center",
          }),
        );
      }

      // Arrow to next component
      if (showArrows && i < comps.length - 1) {
        shapes += _s(
          icon({
            x: x + boxW + 0.2,
            y: y + boxH / 2 - 0.2,
            w: 0.4,
            h: 0.4,
            shape: "right-arrow",
            fill: t.subtle,
          }),
        );
      }
    });
  } else {
    // Layered layout: components stacked vertically
    const boxW = 8;
    const startX = (13.33 - boxW) / 2;
    const startY = 1.8;
    const maxY = 7.2; // Leave 0.3" margin at bottom
    const availableH = maxY - startY; // 5.4"
    const n = comps.length;

    // Calculate adaptive box height and gap based on component count
    // Total height needed: n * boxH + (n-1) * gap = availableH
    // Use ratio boxH:gap = 4:3 (0.8:0.6) for aesthetics
    // n * boxH + (n-1) * (0.75 * boxH) = availableH
    // boxH * (n + 0.75n - 0.75) = availableH
    // boxH = availableH / (1.75n - 0.75)
    const boxHRaw = availableH / (1.75 * n - 0.75);
    const boxH = Math.min(0.8, boxHRaw); // Cap at 0.8", no min to ensure fit
    const gap = boxH * 0.75; // Maintain proportion

    comps.forEach((comp, i) => {
      const y = startY + i * (boxH + gap);
      const color = comp.color || accentColors[i % accentColors.length];

      shapes += _s(
        rect({
          x: startX,
          y,
          w: boxW,
          h: boxH,
          fill: color,
          cornerRadius: 6,
          text: comp.label + (comp.description ? ` — ${comp.description}` : ""),
          fontSize: 14,
          color: autoTextColor(color),
          bold: true,
        }),
      );

      // Arrow down
      if (showArrows && i < comps.length - 1) {
        shapes += _s(
          icon({
            x: startX + boxW / 2 - 0.2,
            y: y + boxH + 0.1,
            w: 0.4,
            h: 0.4,
            shape: "down-arrow",
            fill: t.subtle,
          }),
        );
      }
    });
  }

  pres.addSlide(bg, shapes, opts);
}

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
export function codeWalkthroughSlide(
  pres: Pres,
  opts: CodeWalkthroughSlideOptions,
) {
  _requirePres(pres, "codeWalkthroughSlide");
  requireString(opts.title, "codeWalkthroughSlide.title");
  requireString(opts.code, "codeWalkthroughSlide.code");

  const t = pres.theme;
  const bg = solidBg(t.bg);

  // Title
  let shapes = _s(
    textBox({
      x: 0.5,
      y: 0.3,
      w: 12,
      h: 0.8,
      text: opts.title,
      fontSize: 28,
      color: t.fg,
      bold: true,
    }),
  );
  shapes += _s(rect({ x: 0.5, y: 1.05, w: 2, h: 0.05, fill: t.accent1 }));

  // Code block (left side)
  const codeW = opts.bullets && opts.bullets.length > 0 ? 7.5 : 12;
  shapes += _s(
    codeBlock({
      x: 0.5,
      y: 1.5,
      w: codeW,
      h: 5,
      code: opts.code,
      fontSize: opts.codeFontSize || 11,
      title: opts.language,
    }),
  );

  // Explanation bullets (right side)
  if (opts.bullets && opts.bullets.length > 0) {
    shapes += _s(
      rect({
        x: 8.3,
        y: 1.5,
        w: 4.5,
        h: 5,
        fill: isDark(t.bg) ? "1A1A2E" : "F5F5F5",
        cornerRadius: 8,
      }),
    );
    shapes += _s(
      textBox({
        x: 8.5,
        y: 1.6,
        w: 4,
        h: 0.5,
        text: "Key Points",
        fontSize: 16,
        color: t.accent1,
        bold: true,
      }),
    );
    shapes += _s(
      bulletList({
        x: 8.5,
        y: 2.2,
        w: 4,
        h: 4,
        items: opts.bullets,
        fontSize: 12,
        color: t.fg,
        bulletColor: t.accent1,
      }),
    );
  }

  pres.addSlide(bg, shapes, opts);
}

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
export function beforeAfterSlide(pres: Pres, opts: BeforeAfterSlideOptions) {
  _requirePres(pres, "beforeAfterSlide");
  requireString(opts.title, "beforeAfterSlide.title");

  const t = pres.theme;
  const bg = solidBg(t.bg);

  // Normalize content
  const normalizeBullets = (input: string[] | string): string[] => {
    if (Array.isArray(input)) return input;
    return input
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  };
  const beforeItems = normalizeBullets(opts.beforeContent);
  const afterItems = normalizeBullets(opts.afterContent);

  const beforeColor = opts.beforeColor || "FF5252"; // Red
  const afterColor = opts.afterColor || "00E676"; // Green

  // Title
  let shapes = _s(
    textBox({
      x: 0.5,
      y: 0.3,
      w: 12,
      h: 0.8,
      text: opts.title,
      fontSize: 28,
      color: t.fg,
      bold: true,
    }),
  );
  shapes += _s(rect({ x: 0.5, y: 1.05, w: 2, h: 0.05, fill: t.accent1 }));

  // Before column
  shapes += _s(
    rect({
      x: 0.5,
      y: 1.4,
      w: 5.8,
      h: 5.3,
      fill: isDark(t.bg) ? "1F1F2E" : "FFF5F5",
      cornerRadius: 10,
    }),
  );
  shapes += _s(
    rect({
      x: 0.5,
      y: 1.4,
      w: 5.8,
      h: 0.6,
      fill: beforeColor,
      cornerRadius: 10,
    }),
  );
  shapes += _s(rect({ x: 0.5, y: 1.7, w: 5.8, h: 0.3, fill: beforeColor })); // Cover bottom radius
  shapes += _s(
    textBox({
      x: 0.7,
      y: 1.45,
      w: 5.4,
      h: 0.5,
      text: opts.beforeTitle || "Before",
      fontSize: 18,
      color: "FFFFFF",
      bold: true,
      align: "center",
    }),
  );
  shapes += _s(
    bulletList({
      x: 0.7,
      y: 2.2,
      w: 5.4,
      h: 4.3,
      items: beforeItems,
      fontSize: 13,
      color: t.fg,
      bulletColor: beforeColor,
    }),
  );

  // Arrow in center
  shapes += _s(
    icon({
      x: 6.4,
      y: 3.5,
      w: 0.6,
      h: 0.6,
      shape: "right-arrow",
      fill: t.subtle,
    }),
  );

  // After column
  shapes += _s(
    rect({
      x: 7.1,
      y: 1.4,
      w: 5.8,
      h: 5.3,
      fill: isDark(t.bg) ? "1F2E1F" : "F5FFF5",
      cornerRadius: 10,
    }),
  );
  shapes += _s(
    rect({
      x: 7.1,
      y: 1.4,
      w: 5.8,
      h: 0.6,
      fill: afterColor,
      cornerRadius: 10,
    }),
  );
  shapes += _s(rect({ x: 7.1, y: 1.7, w: 5.8, h: 0.3, fill: afterColor })); // Cover bottom radius
  shapes += _s(
    textBox({
      x: 7.3,
      y: 1.45,
      w: 5.4,
      h: 0.5,
      text: opts.afterTitle || "After",
      fontSize: 18,
      color: "FFFFFF",
      bold: true,
      align: "center",
    }),
  );
  shapes += _s(
    bulletList({
      x: 7.3,
      y: 2.2,
      w: 5.4,
      h: 4.3,
      items: afterItems,
      fontSize: 13,
      color: t.fg,
      bulletColor: afterColor,
    }),
  );

  pres.addSlide(bg, shapes, opts);
}

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
export function processFlowSlide(pres: Pres, opts: ProcessFlowSlideOptions) {
  _requirePres(pres, "processFlowSlide");
  requireString(opts.title, "processFlowSlide.title");
  requireArray(opts.steps, "processFlowSlide.steps", { nonEmpty: true });

  const t = pres.theme;
  const bg = solidBg(t.bg);
  const layout = opts.layout || "horizontal";
  const showNumbers = opts.showNumbers !== false;
  const steps = opts.steps.slice(0, 6); // Max 6 steps
  const accentColors = [
    t.accent1,
    t.accent2,
    "00E676",
    "FFD700",
    "FF7043",
    "AB47BC",
  ];

  // Title
  let shapes = _s(
    textBox({
      x: 0.5,
      y: 0.3,
      w: 12,
      h: 0.8,
      text: opts.title,
      fontSize: 28,
      color: t.fg,
      bold: true,
    }),
  );
  shapes += _s(rect({ x: 0.5, y: 1.05, w: 2, h: 0.05, fill: t.accent1 }));

  if (layout === "horizontal") {
    // Adaptive sizing: reduce box width as step count increases
    // At 3 steps: 2.2" boxes, at 6 steps: 1.5" boxes
    const baseBoxW = 2.2;
    const minBoxW = 1.5;
    const boxW = Math.max(minBoxW, baseBoxW - (steps.length - 3) * 0.15);
    const boxH = 1.8;
    const gap = 0.4;
    const totalW = steps.length * boxW + (steps.length - 1) * gap;
    const startX = Math.max(0.3, (13.33 - totalW) / 2); // Ensure non-negative
    const y = 2.8;

    steps.forEach((step, i) => {
      const x = startX + i * (boxW + gap);
      const color = step.color || accentColors[i % accentColors.length];

      // Step number circle
      if (showNumbers) {
        shapes += _s(
          icon({
            x: x + boxW / 2 - 0.25,
            y: y - 0.6,
            w: 0.5,
            h: 0.5,
            shape: "circle",
            fill: color,
            text: String(i + 1),
            fontSize: 14,
            color: autoTextColor(color),
          }),
        );
      }

      // Step box
      shapes += _s(
        rect({
          x,
          y,
          w: boxW,
          h: boxH,
          fill: isDark(t.bg) ? "1A1A2E" : "F5F5F5",
          cornerRadius: 8,
        }),
      );

      // Icon (if provided)
      if (step.icon) {
        shapes += _s(
          icon({
            x: x + boxW / 2 - 0.3,
            y: y + 0.2,
            w: 0.6,
            h: 0.6,
            shape: step.icon,
            fill: color,
          }),
        );
      }

      // Label
      shapes += _s(
        textBox({
          x,
          y: step.icon ? y + 0.9 : y + 0.3,
          w: boxW,
          h: 0.5,
          text: step.label,
          fontSize: 12,
          color: t.fg,
          bold: true,
          align: "center",
        }),
      );

      // Description
      if (step.description) {
        shapes += _s(
          textBox({
            x,
            y: y + boxH + 0.1,
            w: boxW,
            h: 0.8,
            text: step.description,
            fontSize: 9,
            color: t.subtle,
            align: "center",
          }),
        );
      }

      // Arrow to next
      if (i < steps.length - 1) {
        shapes += _s(
          icon({
            x: x + boxW + 0.15,
            y: y + boxH / 2 - 0.15,
            w: 0.3,
            h: 0.3,
            shape: "right-arrow",
            fill: t.subtle,
          }),
        );
      }
    });
  } else {
    // Vertical layout
    const boxW = 10;
    const boxH = 0.9;
    const gap = 0.5;
    const startX = (13.33 - boxW) / 2;
    const startY = 1.6;

    steps.forEach((step, i) => {
      const y = startY + i * (boxH + gap);
      const color = step.color || accentColors[i % accentColors.length];

      // Number circle
      if (showNumbers) {
        shapes += _s(
          icon({
            x: startX - 0.6,
            y: y + 0.2,
            w: 0.5,
            h: 0.5,
            shape: "circle",
            fill: color,
            text: String(i + 1),
            fontSize: 12,
            color: autoTextColor(color),
          }),
        );
      }

      // Step bar
      shapes += _s(
        rect({
          x: startX,
          y,
          w: boxW,
          h: boxH,
          fill: color,
          cornerRadius: 6,
        }),
      );

      const labelText = step.description
        ? `${step.label} — ${step.description}`
        : step.label;

      shapes += _s(
        textBox({
          x: startX + 0.3,
          y: y + 0.15,
          w: boxW - 0.6,
          h: 0.6,
          text: labelText,
          fontSize: 14,
          color: autoTextColor(color),
          bold: true,
        }),
      );

      // Arrow down
      if (i < steps.length - 1) {
        shapes += _s(
          icon({
            x: startX + boxW / 2 - 0.15,
            y: y + boxH + 0.1,
            w: 0.3,
            h: 0.3,
            shape: "down-arrow",
            fill: t.subtle,
          }),
        );
      }
    });
  }

  pres.addSlide(bg, shapes, opts);
}

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
export function addSlideNumbers(pres: Pres, opts?: SlideNumberOptions) {
  _requirePres(pres, "addSlideNumbers");
  const o = opts || {};
  const sz = o.fontSize || 10;
  const startAt = o.startAt || 1;

  for (let i = 0; i < pres.slides.length; i++) {
    const num = startAt + i;
    // Always auto-select readable colour per slide.
    // Slides with custom backgrounds (e.g. section slides) get autoTextColor;
    // slides on the default theme background get theme.subtle.
    const slideBg = _extractBgColor(pres.slides[i].bg);
    const color = slideBg
      ? autoTextColor(slideBg)
      : autoTextColor(pres.theme.bg);
    const numShape = textBox({
      x: 12,
      y: 7,
      w: 0.8,
      h: 0.4,
      text: String(num),
      fontSize: sz,
      color,
      align: "r",
      // Skip strict contrast validation — autoTextColor already picked
      // the highest-contrast option. Some accent backgrounds don't have
      // ANY colour meeting WCAG AA, so we accept "best available".
      _skipContrastCheck: true,
    });
    pres.slides[i].shapes += numShape;
  }
}

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
export function addFooter(pres: Pres, opts: FooterOptions) {
  // ── Input validation ──────────────────────────────────────────────
  _requirePres(pres, "addFooter");
  requireString(opts.text, "addFooter.text");

  for (let i = 0; i < pres.slides.length; i++) {
    // Always auto-select readable colour per slide — same as addSlideNumbers
    const slideBg = _extractBgColor(pres.slides[i].bg);
    const color = slideBg
      ? autoTextColor(slideBg)
      : autoTextColor(pres.theme.bg);
    const footerShape = textBox({
      x: 0.5,
      y: 7,
      w: 8,
      h: 0.4,
      text: opts.text,
      fontSize: opts.fontSize || 9,
      color,
      // Skip strict contrast validation — autoTextColor already picked
      // the highest-contrast option (same as addSlideNumbers).
      _skipContrastCheck: true,
    });
    pres.slides[i].shapes += footerShape;
  }
}

// ── Text Measurement ─────────────────────────────────────────────────

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
export function measureText(opts: MeasureTextOptions): TextMeasurement {
  const textStr = Array.isArray(opts.text)
    ? opts.text.join("\n")
    : String(opts.text || "");
  const fontSize = opts.fontSize || 18;
  const lineHeightPt = opts.lineSpacing || fontSize * 1.2;
  const charWidthFactor = opts.charWidthFactor || 0.5;

  // Split into lines
  const lines = textStr.split("\n");
  const lineCount = lines.length;

  // Find longest line in characters
  const lineLengths = lines.map((line) => line.length);
  const maxLineChars = Math.max(...lineLengths, 0);
  const totalChars = textStr.length;

  // Estimate dimensions
  // Height: lines * line height (in points) / 72 = inches
  const heightInches = (lineCount * lineHeightPt) / 72;

  // Width: max chars * char width * fontSize / 72
  // Character width is typically ~0.5 of font size for proportional fonts
  const charWidthPt = fontSize * charWidthFactor;
  const widthInches = (maxLineChars * charWidthPt) / 72;

  // Check if text would wrap given maxWidth
  let wouldWrap = false;
  if (opts.maxWidth && opts.maxWidth > 0) {
    wouldWrap = widthInches > opts.maxWidth;
  }

  return {
    width: widthInches,
    height: heightInches,
    lines: lineCount,
    maxLineChars,
    totalChars,
    wouldWrap,
  };
}

// ── Slide Cloning ────────────────────────────────────────────────────

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
export function cloneSlide(pres: Pres, opts?: CloneSlideOptions): number {
  _requirePres(pres, "cloneSlide");

  if (!pres.slides || pres.slides.length === 0) {
    throw new Error(
      "cloneSlide: No slides to clone. Add at least one slide before calling cloneSlide().",
    );
  }

  const sourceIdx =
    opts?.sourceIndex !== undefined ? opts.sourceIndex : pres.slides.length - 1;

  if (sourceIdx < 0 || sourceIdx >= pres.slides.length) {
    throw new Error(
      `cloneSlide: sourceIndex ${sourceIdx} is out of bounds. ` +
        `Valid range: 0-${pres.slides.length - 1}`,
    );
  }

  const source = pres.slides[sourceIdx];

  // Deep copy the slide data
  const clonedSlide: SlideData = {
    bg: source.bg,
    shapes: source.shapes,
    transition: opts?.transition ?? source.transition,
    transitionDuration: opts?.transitionDuration ?? source.transitionDuration,
    notes: opts?.notes ?? source.notes,
  };

  pres.slides.push(clonedSlide);
  return pres.slides.length - 1;
}

// ── Animation Building ───────────────────────────────────────────────

/**
 * Build animation XML for a shape.
 * PowerPoint animations use DrawingML animation markup.
 *
 * @param {string} shapeId - The shape ID to animate
 * @param {AnimationOptions} opts - Animation options
 * @param {number} seqNum - Sequence number for this animation
 * @returns {string} Animation timing XML fragment
 */
function buildAnimationXml(
  shapeId: string,
  opts: AnimationOptions,
  seqNum: number,
): string {
  const delay = opts.delay || 0;
  const dur = opts.duration || 500;

  // Map animation types to OOXML preset IDs
  const entrancePresets: Record<string, { preset: number; subtype?: string }> =
    {
      appear: { preset: 1 },
      fadeIn: { preset: 10 },
      flyInLeft: { preset: 2, subtype: "l" },
      flyInRight: { preset: 2, subtype: "r" },
      flyInTop: { preset: 2, subtype: "t" },
      flyInBottom: { preset: 2, subtype: "b" },
      zoomIn: { preset: 23, subtype: "in" },
      bounceIn: { preset: 26 },
      wipeRight: { preset: 22, subtype: "r" },
      wipeDown: { preset: 22, subtype: "d" },
    };

  const emphasisPresets: Record<string, { preset: number }> = {
    pulse: { preset: 32 },
    spin: { preset: 8 },
    grow: { preset: 6 },
    shrink: { preset: 6 },
    colorPulse: { preset: 32 },
    teeter: { preset: 24 },
  };

  const exitPresets: Record<string, { preset: number; subtype?: string }> = {
    disappear: { preset: 1 },
    fadeOut: { preset: 10 },
    flyOutLeft: { preset: 2, subtype: "l" },
    flyOutRight: { preset: 2, subtype: "r" },
    flyOutTop: { preset: 2, subtype: "t" },
    flyOutBottom: { preset: 2, subtype: "b" },
    zoomOut: { preset: 23, subtype: "out" },
  };

  const animations: string[] = [];

  // Determine trigger
  let triggerNode =
    '<p:cTn id="1" dur="indefinite" restart="never" nodeType="clickEffect">';
  if (opts.trigger === "withPrevious") {
    triggerNode =
      '<p:cTn id="1" dur="indefinite" restart="never" nodeType="withEffect">';
  } else if (opts.trigger === "afterPrevious") {
    triggerNode =
      '<p:cTn id="1" dur="indefinite" restart="never" nodeType="afterEffect">';
  }

  // Build entrance animation
  if (opts.entrance && entrancePresets[opts.entrance]) {
    const ep = entrancePresets[opts.entrance];
    const subtypeAttr = ep.subtype ? ` subtype="${ep.subtype}"` : "";
    animations.push(
      `<p:par>` +
        `<p:cTn id="${seqNum}" presetID="${ep.preset}" presetClass="entr" presetSubtype="0"${subtypeAttr} fill="hold" nodeType="clickEffect">` +
        `<p:stCondLst><p:cond delay="${delay}"/></p:stCondLst>` +
        `<p:childTnLst>` +
        `<p:set><p:cBhvr><p:cTn id="${seqNum + 1}" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn>` +
        `<p:tgtEl><p:spTgt spid="${shapeId}"/></p:tgtEl>` +
        `<p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst>` +
        `</p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set>` +
        `<p:anim calcmode="lin" valueType="num">` +
        `<p:cBhvr additive="base"><p:cTn id="${seqNum + 2}" dur="${dur}" fill="hold"/><p:tgtEl><p:spTgt spid="${shapeId}"/></p:tgtEl>` +
        `<p:attrNameLst><p:attrName>ppt_x</p:attrName></p:attrNameLst>` +
        `</p:cBhvr><p:tavLst><p:tav tm="0"><p:val><p:strVal val="#ppt_x"/></p:val></p:tav><p:tav tm="100000"><p:val><p:strVal val="#ppt_x"/></p:val></p:tav></p:tavLst></p:anim>` +
        `</p:childTnLst></p:cTn></p:par>`,
    );
  }

  // Build emphasis animation
  if (opts.emphasis && emphasisPresets[opts.emphasis]) {
    const emp = emphasisPresets[opts.emphasis];
    animations.push(
      `<p:par>` +
        `<p:cTn id="${seqNum + 10}" presetID="${emp.preset}" presetClass="emph" presetSubtype="0" fill="hold" nodeType="withEffect">` +
        `<p:stCondLst><p:cond delay="${delay + dur}"/></p:stCondLst>` +
        `<p:childTnLst>` +
        `<p:animScale><p:cBhvr><p:cTn id="${seqNum + 11}" dur="${dur}" fill="hold"/><p:tgtEl><p:spTgt spid="${shapeId}"/></p:tgtEl></p:cBhvr>` +
        `<p:by x="110000" y="110000"/></p:animScale>` +
        `</p:childTnLst></p:cTn></p:par>`,
    );
  }

  // Build exit animation
  if (opts.exit && exitPresets[opts.exit]) {
    const ex = exitPresets[opts.exit];
    const subtypeAttr = ex.subtype ? ` subtype="${ex.subtype}"` : "";
    animations.push(
      `<p:par>` +
        `<p:cTn id="${seqNum + 20}" presetID="${ex.preset}" presetClass="exit" presetSubtype="0"${subtypeAttr} fill="hold" nodeType="afterEffect">` +
        `<p:stCondLst><p:cond delay="${delay + dur * 2}"/></p:stCondLst>` +
        `<p:childTnLst>` +
        `<p:set><p:cBhvr><p:cTn id="${seqNum + 21}" dur="1" fill="hold"><p:stCondLst><p:cond delay="${dur}"/></p:stCondLst></p:cTn>` +
        `<p:tgtEl><p:spTgt spid="${shapeId}"/></p:tgtEl>` +
        `<p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst>` +
        `</p:cBhvr><p:to><p:strVal val="hidden"/></p:to></p:set>` +
        `</p:childTnLst></p:cTn></p:par>`,
    );
  }

  if (animations.length === 0) return "";

  return (
    `<p:timing><p:tnLst><p:par>${triggerNode}<p:childTnLst>` +
    `<p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq">` +
    `<p:childTnLst>${animations.join("")}</p:childTnLst></p:cTn></p:seq>` +
    `</p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>`
  );
}

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
export function addAnimation(
  pres: Pres,
  slideIndex: number,
  opts: AnimationOptions,
): void {
  _requirePres(pres, "addAnimation");

  if (slideIndex < 0 || slideIndex >= pres.slides.length) {
    throw new Error(
      `addAnimation: slideIndex ${slideIndex} is out of bounds. ` +
        `Valid range: 0-${pres.slides.length - 1}`,
    );
  }

  // Get current shape ID counter value (this is the last shape added)
  // Note: This is a simplified implementation - real animation requires
  // tracking shape IDs within the slide
  const shapeId = "2"; // Default to first shape after group container

  const seqNum = 3; // Start sequence numbering after built-in IDs
  const animXml = buildAnimationXml(shapeId, opts, seqNum);

  if (animXml) {
    // Store animation for this slide
    if (!pres._animations) {
      pres._animations = {};
    }
    if (!pres._animations[slideIndex]) {
      pres._animations[slideIndex] = [];
    }
    pres._animations[slideIndex].push(animXml);
  }
}

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
export function addStaggeredAnimation(
  pres: Pres,
  slideIndex: number,
  shapeCount: number,
  opts: StaggeredAnimationOptions,
): void {
  _requirePres(pres, "addStaggeredAnimation");

  if (slideIndex < 0 || slideIndex >= pres.slides.length) {
    throw new Error(
      `addStaggeredAnimation: slideIndex ${slideIndex} is out of bounds. ` +
        `Valid range: 0-${pres.slides.length - 1}`,
    );
  }

  const staggerDelay = opts.staggerDelay ?? 200;
  const baseAnimation = opts.animation;
  const mode = opts.mode ?? "sequential";

  for (let i = 0; i < shapeCount; i++) {
    const shapeId = String(i + 2); // Shape IDs start at 2 after container
    const delay = (baseAnimation.delay || 0) + i * staggerDelay;
    const seqNum = 3 + i;

    const animOpts: AnimationOptions = {
      ...baseAnimation,
      delay,
      // In sequential mode, first shape is onClick, rest are afterPrevious
      trigger:
        mode === "sequential"
          ? i === 0
            ? "onClick"
            : "afterPrevious"
          : "withPrevious",
    };

    const animXml = buildAnimationXml(shapeId, animOpts, seqNum);

    if (animXml) {
      if (!pres._animations) {
        pres._animations = {};
      }
      if (!pres._animations[slideIndex]) {
        pres._animations[slideIndex] = [];
      }
      pres._animations[slideIndex].push(animXml);
    }
  }
}

// ── Code Block ───────────────────────────────────────────────────────

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
export function codeBlock(opts: CodeBlockOptions): ShapeFragment {
  // ── Input validation ──────────────────────────────────────────────
  _validateOptionalNumber(opts.fontSize, "codeBlock.fontSize", {
    min: 1,
    max: 400,
  });
  const bg = opts.background
    ? requireHex(opts.background, "codeBlock.background")
    : "161B22";
  const color = opts.color
    ? requireHex(opts.color, "codeBlock.color")
    : "E6EDF3";
  _validateOptionalHex(opts.titleColor, "codeBlock.titleColor");

  const code = opts.code || "";
  const fontFamily = opts.fontFamily || "Consolas";
  const sz = opts.fontSize || 11;
  const lines = code.split("\n");

  // Add line numbers if requested
  let displayText: string;
  if (opts.lineNumbers) {
    const pad = String(lines.length).length;
    displayText = lines
      .map(
        (line: string, i: number) => `${String(i + 1).padStart(pad)}  ${line}`,
      )
      .join("\n");
  } else {
    displayText = code;
  }

  const shapes: ShapeFragment[] = [];

  // Optional title bar
  if (opts.title) {
    shapes.push(
      rect({
        x: opts.x,
        y: opts.y,
        w: opts.w,
        h: 0.35,
        fill: "0D1117",
        text: opts.title,
        fontSize: 10,
        color: opts.titleColor || "8B949E",
        cornerRadius: opts.cornerRadius || 4,
      }),
    );
  }

  const codeY = opts.title ? (opts.y || 0) + 0.35 : opts.y || 0;
  const codeH = opts.title ? (opts.h || 3) - 0.35 : opts.h || 3;

  // Code body — dark background with monospace text
  shapes.push(
    textBox({
      x: opts.x,
      y: codeY,
      w: opts.w,
      h: codeH,
      text: displayText,
      fontSize: sz,
      color,
      fontFamily,
      background: bg,
      align: "l",
      valign: "t",
      padding: 0.12,
    }),
  );

  return _createShapeFragment(shapes.join(""));
}

// ── Batch & Quick APIs ──────────────────────────────────────────────────
// High-level APIs for rapid deck creation with minimal code.

/**
 * Slide configuration for batch creation.
 * Each object describes one slide using a declarative config.
 */
export interface SlideConfig {
  /** Slide type: determines which slide function to call */
  type:
    | "title"
    | "section"
    | "content"
    | "hero"
    | "comparison"
    | "twoColumn"
    | "stats"
    | "quote"
    | "imageGrid"
    | "bigNumber"
    | "custom";
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
export function addSlidesFromConfig(pres: Pres, configs: SlideConfig[]): void {
  _requirePres(pres, "addSlidesFromConfig");
  if (!Array.isArray(configs)) {
    throw new Error(
      "addSlidesFromConfig: 'configs' must be an array of slide configurations",
    );
  }

  for (const config of configs) {
    const { type, opts } = config;
    if (!type || !opts) {
      throw new Error(
        `addSlidesFromConfig: each config needs { type: string, opts: {...} }`,
      );
    }

    switch (type) {
      case "title":
        titleSlide(pres, opts as unknown as TitleSlideOptions);
        break;
      case "section":
        sectionSlide(pres, opts as unknown as SectionSlideOptions);
        break;
      case "content":
        contentSlide(pres, opts as unknown as ContentSlideOptions);
        break;
      case "hero":
        heroSlide(pres, opts as unknown as HeroSlideOptions);
        break;
      case "comparison":
        comparisonSlide(pres, opts as unknown as ComparisonSlideOptions);
        break;
      case "twoColumn":
        twoColumnSlide(pres, opts as unknown as TwoColumnSlideOptions);
        break;
      case "stats":
        statGridSlide(pres, opts as unknown as StatGridSlideOptions);
        break;
      case "quote":
        quoteSlide(pres, opts as unknown as QuoteSlideOptions);
        break;
      case "imageGrid":
        imageGridSlide(pres, opts as unknown as ImageGridSlideOptions);
        break;
      case "bigNumber":
        bigNumberSlide(pres, opts as unknown as BigNumberSlideOptions);
        break;
      case "custom":
        customSlide(pres, opts as unknown as CustomSlideOptions);
        break;
      default:
        throw new Error(
          `addSlidesFromConfig: unknown slide type '${type}'. ` +
            `Valid types: title, section, content, hero, comparison, twoColumn, stats, quote, imageGrid, bigNumber, custom`,
        );
    }
  }
}

/**
 * Quick deck section for quickDeck() API.
 */
export interface QuickSection {
  /** Section title (creates a section slide) */
  title: string;
  /** Slides in this section */
  slides: Array<
    | { type: "content"; title: string; items: string[] | string }
    | {
        type: "stats";
        title: string;
        stats: Array<{ value: string; label: string }>;
      }
    | { type: "quote"; quote: string; author?: string; role?: string }
    | {
        type: "comparison";
        title: string;
        leftTitle: string;
        rightTitle: string;
        leftItems: string[] | string;
        rightItems: string[] | string;
      }
    | { type: "bigNumber"; number: string; unit?: string; label?: string }
    | {
        type: "hero";
        title: string;
        subtitle?: string;
        image: Uint8Array;
        imageFormat?: string;
      }
  >;
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
  closing?: { title: string; subtitle?: string };
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
export function quickDeck(config: QuickDeckConfig): Pres {
  const pres = createPresentation({ theme: config.theme || "corporate-blue" });

  // Title slide
  titleSlide(pres, { title: config.title, subtitle: config.subtitle });

  // Process sections
  for (const section of config.sections) {
    // Section header
    sectionSlide(pres, { title: section.title });

    // Section slides
    for (const slide of section.slides) {
      switch (slide.type) {
        case "content":
          contentSlide(pres, { title: slide.title, items: slide.items });
          break;
        case "stats":
          statGridSlide(pres, { title: slide.title, stats: slide.stats });
          break;
        case "quote":
          quoteSlide(pres, {
            quote: slide.quote,
            author: slide.author,
            role: slide.role,
          });
          break;
        case "comparison":
          comparisonSlide(pres, {
            title: slide.title,
            leftTitle: slide.leftTitle,
            rightTitle: slide.rightTitle,
            leftItems: slide.leftItems,
            rightItems: slide.rightItems,
          });
          break;
        case "bigNumber":
          bigNumberSlide(pres, {
            number: slide.number,
            unit: slide.unit,
            label: slide.label,
          });
          break;
        case "hero":
          heroSlide(pres, {
            title: slide.title,
            subtitle: slide.subtitle,
            image: slide.image,
            imageFormat: slide.imageFormat,
          });
          break;
      }
    }
  }

  // Closing slide
  if (config.closing) {
    sectionSlide(pres, {
      title: config.closing.title,
      subtitle: config.closing.subtitle,
    });
  }

  // Add slide numbers and footer
  if (config.slideNumbers !== false) {
    addSlideNumbers(pres, { startAt: 2 });
  }
  if (config.footer) {
    addFooter(pres, { text: config.footer });
  }

  return pres;
}

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
export function fetchAndEmbed(
  pres: Pres,
  opts: {
    url: string;
    x: number;
    y: number;
    w: number;
    h: number;
    format?: string;
    fit?: "stretch" | "contain" | "cover";
    fetchFn: (url: string) => Uint8Array;
  },
): ShapeFragment {
  _requirePres(pres, "fetchAndEmbed");
  if (!opts.url) {
    throw new Error("fetchAndEmbed: 'url' is required");
  }
  if (typeof opts.fetchFn !== "function") {
    throw new Error(
      "fetchAndEmbed: 'fetchFn' is required — pass fetchBinary from host:fetch. " +
        "Example: fetchAndEmbed(pres, { url, x, y, w, h, fetchFn: fetchBinary })",
    );
  }

  // Auto-detect format from URL extension
  let format = opts.format;
  if (!format) {
    const urlLower = opts.url.toLowerCase();
    if (urlLower.includes(".png")) format = "png";
    else if (urlLower.includes(".gif")) format = "gif";
    else if (urlLower.includes(".webp")) format = "webp";
    else format = "jpg"; // Default to jpg
  }

  // Fetch the image
  const data = opts.fetchFn(opts.url);
  if (!(data instanceof Uint8Array)) {
    throw new Error(
      `fetchAndEmbed: fetchFn must return Uint8Array, got ${typeof data}`,
    );
  }

  // Embed it — return ShapeFragment directly (embedImage returns ShapeFragment)
  return embedImage(pres, {
    data,
    x: opts.x,
    y: opts.y,
    w: opts.w,
    h: opts.h,
    format,
    fit: opts.fit,
  });
}

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
export function fetchAndEmbedBatch(
  pres: Pres,
  opts: {
    items: Array<{
      url: string;
      x: number;
      y: number;
      w: number;
      h: number;
      format?: string;
      fit?: "stretch" | "contain" | "cover";
    }>;
    fetchBatchFn: (
      urls: string[],
    ) => Array<{ url: string; data?: Uint8Array; error?: string }>;
  },
): Array<{ url: string; shape?: ShapeFragment; error?: string }> {
  _requirePres(pres, "fetchAndEmbedBatch");
  if (!Array.isArray(opts.items) || opts.items.length === 0) {
    throw new Error("fetchAndEmbedBatch: 'items' must be a non-empty array");
  }
  if (typeof opts.fetchBatchFn !== "function") {
    throw new Error(
      "fetchAndEmbedBatch: 'fetchBatchFn' is required — pass fetchBinaryBatch from host:fetch",
    );
  }

  // Extract URLs and build lookup map
  const urls = opts.items.map((item) => item.url);
  const itemMap = new Map(opts.items.map((item) => [item.url, item]));

  // Fetch all images
  const results = opts.fetchBatchFn(urls);

  // Process results
  return results.map((result) => {
    if (result.error || !result.data) {
      return { url: result.url, error: result.error || "No data returned" };
    }

    const item = itemMap.get(result.url);
    if (!item) {
      return { url: result.url, error: "Item config not found" };
    }

    // Auto-detect format
    let format = item.format;
    if (!format) {
      const urlLower = result.url.toLowerCase();
      if (urlLower.includes(".png")) format = "png";
      else if (urlLower.includes(".gif")) format = "gif";
      else if (urlLower.includes(".webp")) format = "webp";
      else format = "jpg";
    }

    try {
      const shape = embedImage(pres, {
        data: result.data,
        x: item.x,
        y: item.y,
        w: item.w,
        h: item.h,
        format,
        fit: item.fit,
      });
      return { url: result.url, shape };
    } catch (e) {
      return { url: result.url, error: String(e) };
    }
  });
}
