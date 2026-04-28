// @module xlsx
// @description Excel XLSX builder — cells, styles, formulas, merges, freeze, filter, pivots, charts, sparklines, conditional formatting, validation, hyperlinks, images, grouping, protection, print settings, named ranges, tab colors
// @created 2026-04-28T00:00:00.000Z
// @modified 2026-04-28T00:00:00.000Z
// @mutable false
// @author system

import { escapeXml as _escXml } from "ha:xml-escape";
import { createZip } from "ha:zip-format";

const escapeXml = _escXml;

type CellValue = string | number | boolean | Date | null | undefined;
type RowData = readonly CellValue[] | Record<string, CellValue>;
type CellRefLike = string | { row: number; col: number };
type HexColor = string;

type RelationshipId = string | null;
type ZipEntry = { name: string; data: string | Uint8Array };

/** Excel border style for one side of a cell border. */
export interface BorderSide {
  style?: string;
  color?: HexColor;
}

/** Excel border style, either one style for every side or per-side settings. */
export type BorderSpec =
  | string
  | {
      left?: string | BorderSide | null;
      right?: string | BorderSide | null;
      top?: string | BorderSide | null;
      bottom?: string | BorderSide | null;
    };

/** Cell style options accepted by setCell, addRow, addData, and table helpers. */
export interface CellStyle {
  /** Font size in points. Defaults to 11. */
  fontSize?: number;
  /** Font family name. Defaults to Calibri. */
  fontFamily?: string;
  /** Text colour as RGB hex, with or without leading #. */
  color?: HexColor;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** Solid fill colour as RGB hex, with or without leading #. */
  fill?: HexColor;
  /** Border style string or per-side border specification. */
  border?: BorderSpec;
  /** Excel number format code, e.g. "#,##0.00", "mm-dd-yy", "0%". */
  numFmt?: string;
  /** Horizontal alignment. */
  align?: "left" | "center" | "right" | "justify" | "distributed" | string;
  /** Vertical alignment. */
  valign?: "top" | "center" | "bottom" | "justify" | "distributed" | string;
  wrapText?: boolean;
  /** Formula text without leading =. If present, cell value is ignored. */
  formula?: string;
}

export type ChartType = "column" | "bar" | "line" | "area" | "pie" | "doughnut";
export type ChartLegendPosition = "l" | "r" | "t" | "b";

export interface ChartSeries {
  name: string;
  values: readonly number[];
}

export interface ChartAnchor {
  from?: string;
  to?: string;
}

export interface ChartOptions {
  type?: ChartType;
  title?: string;
  categories?: readonly string[];
  series?: readonly ChartSeries[];
  stacked?: boolean;
  percentStacked?: boolean;
  legend?: boolean;
  legendPosition?: ChartLegendPosition;
  dataLabels?: boolean;
  holeSize?: number;
  anchor?: ChartAnchor;
}

export type SparklineType = "line" | "column" | "winLoss";

export interface SparklineOptions {
  type?: SparklineType;
  dataRange: string;
  locationRange: string;
  color?: HexColor;
  negativeColor?: HexColor;
  firstColor?: HexColor;
  lastColor?: HexColor;
  highColor?: HexColor;
  lowColor?: HexColor;
  markers?: boolean;
  showHigh?: boolean;
  showLow?: boolean;
  showFirst?: boolean;
  showLast?: boolean;
  showNegative?: boolean;
  lineWeight?: number;
}

export interface DataBarRule {
  type: "dataBar";
  color?: HexColor;
}

export interface ColorScaleRule {
  type: "colorScale";
  minColor?: HexColor;
  midColor?: HexColor;
  maxColor?: HexColor;
}

export interface IconSetRule {
  type: "iconSet";
  iconSet?: string;
}

export interface CellIsRule {
  type: "cellIs";
  operator?: string;
  formula?: string | number;
  formula2?: string | number;
  style?: CellStyle;
}

export interface Top10Rule {
  type: "top10";
  rank?: number;
  bottom?: boolean;
  percent?: boolean;
  style?: CellStyle;
}

export interface AboveAverageRule {
  type: "aboveAverage";
  below?: boolean;
  style?: CellStyle;
}

export interface DuplicateValuesRule {
  type: "duplicateValues";
  style?: CellStyle;
}

export type ConditionalFormatRule =
  | DataBarRule
  | ColorScaleRule
  | IconSetRule
  | CellIsRule
  | Top10Rule
  | AboveAverageRule
  | DuplicateValuesRule;

export type DataValidationType =
  | "list"
  | "whole"
  | "decimal"
  | "textLength"
  | "custom";

export interface DataValidationOptions {
  type?: DataValidationType;
  values?: readonly string[];
  formula?: string;
  operator?: string;
  min?: number;
  max?: number;
  errorTitle?: string;
  error?: string;
  promptTitle?: string;
  prompt?: string;
  allowBlank?: boolean;
}

interface DataValidationEntry extends DataValidationOptions {
  range: string;
}

export interface HyperlinkOptions {
  display?: string;
  tooltip?: string;
}

export type HyperlinkTarget = string | { sheet?: string; cell?: string };

export interface ImageOptions {
  from?: string;
  to?: string;
}

export interface GroupOptions {
  level?: number;
  collapsed?: boolean;
}

export interface SheetProtectionOptions {
  /** Legacy Excel XOR hash; deters casual edits only, not secure encryption. */
  password?: string;
  allowSort?: boolean;
  allowFilter?: boolean;
  allowFormatCells?: boolean;
  allowFormatColumns?: boolean;
  allowFormatRows?: boolean;
  allowInsertColumns?: boolean;
  allowInsertRows?: boolean;
  allowDeleteColumns?: boolean;
  allowDeleteRows?: boolean;
}

export interface PageSetupOptions {
  orientation?: "landscape" | "portrait";
  paperSize?: number;
  fitToWidth?: number;
  fitToHeight?: number;
  scale?: number;
}

export interface PageMarginsOptions {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
  header?: number;
  footer?: number;
}

export interface HeaderFooterOptions {
  header?: string;
  footer?: string;
}

export interface PivotValueSpec {
  field?: string;
  name?: string;
  func?: "sum" | "count" | "average" | "min" | "max" | string;
  label?: string;
}

export interface PivotTableOptions {
  sourceRange: string;
  targetCell?: string;
  rows?: readonly string[];
  columns?: readonly string[];
  filters?: readonly string[];
  values?: readonly PivotValueSpec[];
}

export interface PivotTableAddOptions extends PivotTableOptions {
  sourceSheet: string | Sheet;
  targetSheet: string | Sheet;
}

export interface TableToWorkbookOptions {
  sheetName?: string;
  headers?: readonly string[];
  data: readonly RowData[];
  headerStyle?: CellStyle;
  columnWidths?: readonly number[];
  rowStyle?: CellStyle | ((rowIndex: number, row: RowData) => CellStyle);
}

export interface ExportResult {
  path: string;
  size: number;
}

interface ParsedCellRef {
  col: number;
  row: number;
}

interface CellEntry {
  v: CellValue;
  s: CellStyle | null;
}

interface AnchorPoint {
  col: number;
  row: number;
}

interface InternalAnchor {
  from: AnchorPoint;
  to: AnchorPoint;
}

interface ChartSpec {
  type: ChartType;
  title: string | null;
  categories: string[];
  series: ChartSeries[];
  stacked: boolean;
  percentStacked: boolean;
  legend: boolean;
  legendPosition: ChartLegendPosition;
  dataLabels: boolean;
  holeSize: number;
  _anchor: InternalAnchor;
}

interface CondFmtEntry {
  range: string;
  rule: ConditionalFormatRule;
}

interface HyperlinkEntry {
  ref: string;
  url?: string | null;
  location?: string | null;
  display: string;
  tooltip: string | null;
  internal: boolean;
}

interface ImageEntry {
  data: Uint8Array;
  ext: ImageExt;
  _anchor: InternalAnchor;
}

interface ColumnOutlineEntry {
  from: number;
  to: number;
  level: number;
  collapsed: boolean;
}

interface RowOutlineEntry {
  level: number;
  collapsed: boolean;
}

interface NamedRangeEntry {
  name: string;
  ref: string;
  localSheetId?: number;
}

type ImageExt = "png" | "jpeg" | "gif";

interface FontEntry {
  sz: number;
  nm: string;
  c: string | null;
  b: boolean;
  i: boolean;
  u: boolean;
}

interface FillEntry {
  t: "none" | "gray125" | "solid";
  c?: string | null;
}

interface ParsedBorderSide {
  s: string;
  c: string | null;
}

interface BorderEntry {
  l: ParsedBorderSide | null;
  r: ParsedBorderSide | null;
  t: ParsedBorderSide | null;
  b: ParsedBorderSide | null;
}

interface CellXfEntry {
  fi: number;
  fli: number;
  bi: number;
  ni: number;
  aF: 0 | 1;
  aFl: 0 | 1;
  aB: 0 | 1;
  aN: 0 | 1;
  aA: 0 | 1;
  hA: string | null;
  vA: string | null;
  wr: 0 | 1;
}

interface DxfOptions {
  bold?: boolean;
  italic?: boolean;
  color?: string;
  fill?: string;
}

interface PivotFieldSpec {
  name: string;
  idx: number;
  shared: boolean;
  unique?: CellValue[];
  valueMap?: Map<string, number>;
  min?: number;
  max?: number;
}

interface InternalPivotValueSpec {
  fld: number;
  func: string;
  label: string;
}

const X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NR =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NP = "http://schemas.openxmlformats.org/package/2006/relationships";
const NC = "http://schemas.openxmlformats.org/package/2006/content-types";
const RD =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
const RW =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet";
const RS =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles";
const RT =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings";
const RPT =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotTable";
const RPR =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotCacheRecords";
const RPC =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotCacheDefinition";
const RDR =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing";
const RCH =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart";
const RHL =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";
const RIM =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";
const COLORS = [
  "4472C4",
  "ED7D31",
  "A5A5A5",
  "FFC000",
  "5B9BD5",
  "70AD47",
  "264478",
  "9B57A0",
  "636363",
  "EB7D3C",
];
const BUILTIN_FMTS: Record<string, number> = {
  General: 0,
  "0": 1,
  "0.00": 2,
  "#,##0": 3,
  "#,##0.00": 4,
  "0%": 9,
  "0.00%": 10,
  "mm-dd-yy": 14,
  "d-mmm-yy": 15,
  "d-mmm": 16,
  "mmm-yy": 17,
  "h:mm AM/PM": 18,
  "h:mm:ss AM/PM": 19,
  "h:mm": 20,
  "h:mm:ss": 21,
  "m/d/yy h:mm": 22,
  "#,##0 ;(#,##0)": 37,
  "#,##0 ;[Red](#,##0)": 38,
  "#,##0.00;(#,##0.00)": 39,
  "#,##0.00;[Red](#,##0.00)": 40,
  "mm:ss": 45,
  "[h]:mm:ss": 46,
  "mmss.0": 47,
  "##0.0E+0": 48,
  "@": 49,
};
const CONTENT_TYPES: Record<ImageExt | "jpg", string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  gif: "image/gif",
};

function escapeAttr(s: unknown): string {
  return escapeXml(String(s));
}

function strip(c: string | null | undefined): string {
  return c && c.charAt(0) === "#" ? c.slice(1) : c || "";
}

function quoteSheet(name: string): string {
  if (/[^A-Za-z0-9_]/.test(name)) return "'" + name.replace(/'/g, "''") + "'";
  return name;
}

function hashPassword(pw: string): string {
  let h = 0;
  for (let i = pw.length - 1; i >= 0; i--) {
    h = ((h >> 14) & 0x01) | ((h << 1) & 0x7fff);
    h ^= pw.charCodeAt(i);
  }
  h = ((h >> 14) & 0x01) | ((h << 1) & 0x7fff);
  h ^= pw.length;
  h ^= 0xce4b;
  return h.toString(16).toUpperCase().padStart(4, "0");
}

function detectImageType(data: Uint8Array): ImageExt {
  if (
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  )
    return "png";
  if (data[0] === 0xff && data[1] === 0xd8) return "jpeg";
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return "gif";
  return "png";
}

/** Convert column letter(s) to 1-based number. A=1, Z=26, AA=27 */
export function colToNum(letters: string): number {
  let n = 0;
  for (let i = 0; i < letters.length; i++)
    n = n * 26 + (letters.charCodeAt(i) - 64);
  return n;
}

/** Convert 1-based column number to letter(s). 1=A, 26=Z, 27=AA */
export function numToCol(num: number): string {
  let s = "";
  while (num > 0) {
    num--;
    s = String.fromCharCode(65 + (num % 26)) + s;
    num = Math.floor(num / 26);
  }
  return s;
}

/** Parse "A1" cell reference to { col, row } (both 1-based). */
export function parseCellRef(ref: string): ParsedCellRef {
  const m = ref.match(/^([A-Z]+)(\d+)$/);
  if (!m) throw new Error("Invalid cell ref: " + ref);
  return { col: colToNum(m[1]!), row: parseInt(m[2]!, 10) };
}

/** Build "A1" reference from 1-based row and col. */
export function cellRef(row: number, col: number): string {
  return numToCol(col) + row;
}

/** Convert JS Date to Excel serial date number. */
export function dateToSerial(d: Date): number {
  const epoch = new Date(1899, 11, 31);
  const serial = (d.getTime() - epoch.getTime()) / 86400000;
  return serial >= 60 ? serial + 1 : serial;
}

export class Sheet {
  name: string;
  index: number;
  _rows: Map<number, Map<number, CellEntry>>;
  _colW: Map<number, number>;
  _rowH: Map<number, number>;
  _merges: string[];
  _fzR: number;
  _fzC: number;
  _af: string | null;
  _charts: ChartSpec[];
  _sparkGroups: SparklineOptions[];
  _condFmts: CondFmtEntry[];
  _dataVals: DataValidationEntry[];
  _tabColor: string | null;
  _hyperlinks: HyperlinkEntry[];
  _images: ImageEntry[];
  _rowOutline: Map<number, RowOutlineEntry>;
  _colOutline: ColumnOutlineEntry[];
  _protection: SheetProtectionOptions | null;
  _printArea: string | null;
  _pageSetup: PageSetupOptions | null | undefined;
  _pageMargins: PageMarginsOptions | null | undefined;
  _headerFooter: HeaderFooterOptions | null | undefined;

  constructor(name: string, idx: number) {
    this.name = name;
    this.index = idx;
    this._rows = new Map();
    this._colW = new Map();
    this._rowH = new Map();
    this._merges = [];
    this._fzR = 0;
    this._fzC = 0;
    this._af = null;
    this._charts = [];
    this._sparkGroups = [];
    this._condFmts = [];
    this._dataVals = [];
    this._tabColor = null;
    this._hyperlinks = [];
    this._images = [];
    this._rowOutline = new Map();
    this._colOutline = [];
    this._protection = null;
    this._printArea = null;
    this._pageSetup = null;
    this._pageMargins = null;
    this._headerFooter = null;
  }

  setCell(ref: CellRefLike, value: CellValue, style?: CellStyle | null): this {
    const { row, col } = typeof ref === "string" ? parseCellRef(ref) : ref;
    if (!this._rows.has(row)) this._rows.set(row, new Map());
    this._rows.get(row)!.set(col, { v: value, s: style || null });
    return this;
  }

  setColumnWidth(colRef: number | string, width: number): this {
    this._colW.set(
      typeof colRef === "number" ? colRef : colToNum(colRef),
      width,
    );
    return this;
  }

  setRowHeight(row: number, height: number): this {
    this._rowH.set(row, height);
    return this;
  }

  mergeCells(from: string, to: string): this {
    this._merges.push(from + ":" + to);
    return this;
  }

  freezeRows(n: number): this {
    this._fzR = n;
    return this;
  }

  freezeColumns(n: number): this {
    this._fzC = n;
    return this;
  }

  setAutoFilter(range: string): this {
    this._af = range;
    return this;
  }

  addRow(
    rowNum: number,
    values: readonly CellValue[],
    style?: CellStyle | null,
  ): this {
    for (let c = 0; c < values.length; c++)
      this.setCell({ row: rowNum, col: c + 1 }, values[c], style || null);
    return this;
  }

  addData(
    data: readonly (readonly CellValue[])[],
    startRef?: CellRefLike,
    style?:
      | CellStyle
      | ((rowIndex: number, colIndex: number, value: CellValue) => CellStyle),
  ): this {
    const s = startRef
      ? typeof startRef === "string"
        ? parseCellRef(startRef)
        : startRef
      : { row: 1, col: 1 };
    for (let r = 0; r < data.length; r++) {
      for (let c = 0; c < data[r]!.length; c++) {
        const st =
          typeof style === "function"
            ? style(r, c, data[r]![c])
            : style || null;
        this.setCell({ row: s.row + r, col: s.col + c }, data[r]![c], st);
      }
    }
    return this;
  }

  getCellValue(ref: CellRefLike): CellValue {
    const { row, col } = typeof ref === "string" ? parseCellRef(ref) : ref;
    const r = this._rows.get(row);
    if (!r) return undefined;
    const c = r.get(col);
    return c ? c.v : undefined;
  }

  addChart(opts: ChartOptions): this {
    const anc = opts.anchor || {};
    const from = anc.from ? parseCellRef(anc.from) : { col: 6, row: 2 };
    const to = anc.to
      ? parseCellRef(anc.to)
      : { col: from.col + 7, row: from.row + 13 };
    this._charts.push({
      type: opts.type || "column",
      title: opts.title || null,
      categories: [...(opts.categories || [])],
      series: [...(opts.series || [])],
      stacked: !!opts.stacked,
      percentStacked: !!opts.percentStacked,
      legend: opts.legend !== false,
      legendPosition: opts.legendPosition || "r",
      dataLabels: !!opts.dataLabels,
      holeSize: opts.holeSize || 50,
      _anchor: {
        from: { col: from.col - 1, row: from.row - 1 },
        to: { col: to.col - 1, row: to.row - 1 },
      },
    });
    return this;
  }

  addSparklines(opts: SparklineOptions): this {
    this._sparkGroups.push(opts);
    return this;
  }

  addConditionalFormat(range: string, rule: ConditionalFormatRule): this {
    this._condFmts.push({ range, rule });
    return this;
  }

  addDataValidation(range: string, opts: DataValidationOptions): this {
    this._dataVals.push({ range, ...opts });
    return this;
  }

  setTabColor(color: string): this {
    this._tabColor = strip(color);
    return this;
  }

  addHyperlink(
    ref: string,
    target: HyperlinkTarget,
    opts?: HyperlinkOptions,
  ): this {
    const o = opts || {};
    const display = o.display || target;
    if (typeof target === "string") {
      this._hyperlinks.push({
        ref,
        url: target,
        display: typeof display === "string" ? display : target,
        tooltip: o.tooltip || null,
        internal: false,
      });
    } else {
      this._hyperlinks.push({
        ref,
        location:
          (target.sheet ? quoteSheet(target.sheet) + "!" : "") +
          (target.cell || "A1"),
        display:
          typeof display === "string"
            ? display
            : target.sheet || target.cell || "A1",
        tooltip: o.tooltip || null,
        internal: true,
      });
    }
    return this;
  }

  addImage(data: Uint8Array, opts?: ImageOptions): this {
    const anc = opts || {};
    const from = anc.from ? parseCellRef(anc.from) : { col: 1, row: 1 };
    const to = anc.to
      ? parseCellRef(anc.to)
      : { col: from.col + 4, row: from.row + 8 };
    this._images.push({
      data,
      ext: detectImageType(data),
      _anchor: {
        from: { col: from.col - 1, row: from.row - 1 },
        to: { col: to.col - 1, row: to.row - 1 },
      },
    });
    return this;
  }

  groupRows(from: number, to: number, opts?: GroupOptions): this {
    const o = opts || {};
    const lvl = o.level || 1;
    for (let r = from; r <= to; r++) {
      const cur = this._rowOutline.get(r);
      this._rowOutline.set(r, {
        level: Math.max(cur ? cur.level : 0, lvl),
        collapsed: !!(cur?.collapsed || o.collapsed),
      });
    }
    return this;
  }

  groupColumns(
    from: number | string,
    to: number | string,
    opts?: GroupOptions,
  ): this {
    const o = opts || {};
    const f = typeof from === "string" ? colToNum(from) : from;
    const t = typeof to === "string" ? colToNum(to) : to;
    this._colOutline.push({
      from: f,
      to: t,
      level: o.level || 1,
      collapsed: !!o.collapsed,
    });
    return this;
  }

  protect(opts?: SheetProtectionOptions): this {
    this._protection = opts || {};
    return this;
  }

  setPrintArea(range: string): this {
    this._printArea = range;
    return this;
  }

  setPageSetup(opts?: PageSetupOptions): this {
    this._pageSetup = opts;
    return this;
  }

  setPageMargins(opts?: PageMarginsOptions): this {
    this._pageMargins = opts;
    return this;
  }

  setHeaderFooter(opts?: HeaderFooterOptions): this {
    this._headerFooter = opts;
    return this;
  }
}

export class StyleMgr {
  _nf: { id: number; fc: string }[] = [];
  _nfNext = 164;
  _fonts: FontEntry[] = [
    { sz: 11, nm: "Calibri", c: null, b: false, i: false, u: false },
  ];
  _fills: FillEntry[] = [{ t: "none" }, { t: "gray125" }];
  _borders: BorderEntry[] = [{ l: null, r: null, t: null, b: null }];
  _xfs: CellXfEntry[] = [this._defaultXf()];
  _xfMap: Map<string, number> = new Map([
    [JSON.stringify(this._defaultXf()), 0],
  ]);
  _dxfs: DxfOptions[] = [];

  _defaultXf(): CellXfEntry {
    return {
      fi: 0,
      fli: 0,
      bi: 0,
      ni: 0,
      aF: 0,
      aFl: 0,
      aB: 0,
      aN: 0,
      aA: 0,
      hA: null,
      vA: null,
      wr: 0,
    };
  }

  _fontIdx(f: FontEntry): number {
    for (let i = 0; i < this._fonts.length; i++) {
      const e = this._fonts[i]!;
      if (
        e.sz === f.sz &&
        e.nm === f.nm &&
        e.c === f.c &&
        e.b === f.b &&
        e.i === f.i &&
        e.u === f.u
      )
        return i;
    }
    this._fonts.push(f);
    return this._fonts.length - 1;
  }

  _fillIdx(f: FillEntry): number {
    for (let i = 0; i < this._fills.length; i++) {
      const e = this._fills[i]!;
      if (e.t === f.t && e.c === f.c) return i;
    }
    this._fills.push(f);
    return this._fills.length - 1;
  }

  _borderIdx(b: BorderEntry): number {
    const k = JSON.stringify(b);
    for (let i = 0; i < this._borders.length; i++)
      if (JSON.stringify(this._borders[i]) === k) return i;
    this._borders.push(b);
    return this._borders.length - 1;
  }

  _nfId(fmt?: string): number {
    if (!fmt) return 0;
    if (fmt in BUILTIN_FMTS) return BUILTIN_FMTS[fmt]!;
    for (const nf of this._nf) if (nf.fc === fmt) return nf.id;
    const id = this._nfNext++;
    this._nf.push({ id, fc: fmt });
    return id;
  }

  _parseBdr(b?: BorderSpec): BorderEntry {
    if (!b) return { l: null, r: null, t: null, b: null };
    const p = (v?: string | BorderSide | null): ParsedBorderSide | null => {
      if (!v) return null;
      if (typeof v === "string") return { s: v, c: null };
      return { s: v.style || "thin", c: v.color ? strip(v.color) : null };
    };
    if (typeof b === "string") {
      const x = p(b);
      return { l: x, r: x, t: x, b: x };
    }
    return { l: p(b.left), r: p(b.right), t: p(b.top), b: p(b.bottom) };
  }

  resolve(opts?: CellStyle | null): number {
    if (!opts) return 0;
    const fi = this._fontIdx({
      sz: opts.fontSize || 11,
      nm: opts.fontFamily || "Calibri",
      c: opts.color ? strip(opts.color) : null,
      b: !!opts.bold,
      i: !!opts.italic,
      u: !!opts.underline,
    });
    const fli = opts.fill
      ? this._fillIdx({ t: "solid", c: strip(opts.fill) })
      : 0;
    const bi = this._borderIdx(this._parseBdr(opts.border));
    const ni = this._nfId(opts.numFmt);
    const xf: CellXfEntry = {
      fi,
      fli,
      bi,
      ni,
      aF: fi ? 1 : 0,
      aFl: fli ? 1 : 0,
      aB: bi ? 1 : 0,
      aN: ni ? 1 : 0,
      aA: opts.align || opts.valign || opts.wrapText ? 1 : 0,
      hA: opts.align || null,
      vA: opts.valign || null,
      wr: opts.wrapText ? 1 : 0,
    };
    const k = JSON.stringify(xf);
    if (this._xfMap.has(k)) return this._xfMap.get(k)!;
    this._xfs.push(xf);
    const idx = this._xfs.length - 1;
    this._xfMap.set(k, idx);
    return idx;
  }

  addDxf(opts?: DxfOptions): number {
    this._dxfs.push(opts || {});
    return this._dxfs.length - 1;
  }

  toXml(): string {
    let x = X + '<styleSheet xmlns="' + NS + '">';
    if (this._nf.length) {
      x += '<numFmts count="' + this._nf.length + '">';
      for (const n of this._nf)
        x +=
          '<numFmt numFmtId="' +
          n.id +
          '" formatCode="' +
          escapeAttr(n.fc) +
          '"/>';
      x += "</numFmts>";
    }
    x += '<fonts count="' + this._fonts.length + '">';
    for (const f of this._fonts) {
      x += "<font>";
      if (f.b) x += "<b/>";
      if (f.i) x += "<i/>";
      if (f.u) x += "<u/>";
      x += '<sz val="' + f.sz + '"/>';
      if (f.c) x += '<color rgb="FF' + f.c + '"/>';
      x += '<name val="' + escapeAttr(f.nm) + '"/>';
      x += "</font>";
    }
    x += '</fonts><fills count="' + this._fills.length + '">';
    for (const f of this._fills) {
      if (f.t === "none") x += '<fill><patternFill patternType="none"/></fill>';
      else if (f.t === "gray125")
        x += '<fill><patternFill patternType="gray125"/></fill>';
      else
        x +=
          '<fill><patternFill patternType="solid"><fgColor rgb="FF' +
          (f.c || "") +
          '"/></patternFill></fill>';
    }
    x += '</fills><borders count="' + this._borders.length + '">';
    for (const bd of this._borders) {
      x += "<border>";
      const tags = { l: "left", r: "right", t: "top", b: "bottom" } as const;
      for (const s of ["l", "r", "t", "b"] as const) {
        const tag = tags[s];
        const side = bd[s];
        if (side) {
          x += "<" + tag + ' style="' + side.s + '">';
          if (side.c) x += '<color rgb="FF' + side.c + '"/>';
          x += "</" + tag + ">";
        } else x += "<" + tag + "/>";
      }
      x += "<diagonal/></border>";
    }
    x +=
      '</borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>';
    x += '<cellXfs count="' + this._xfs.length + '">';
    for (const xf of this._xfs) {
      let a =
        'numFmtId="' +
        xf.ni +
        '" fontId="' +
        xf.fi +
        '" fillId="' +
        xf.fli +
        '" borderId="' +
        xf.bi +
        '"';
      if (xf.aF) a += ' applyFont="1"';
      if (xf.aFl) a += ' applyFill="1"';
      if (xf.aB) a += ' applyBorder="1"';
      if (xf.aN) a += ' applyNumberFormat="1"';
      if (xf.aA) {
        a += ' applyAlignment="1"';
        x += "<xf " + a + "><alignment";
        if (xf.hA) x += ' horizontal="' + xf.hA + '"';
        if (xf.vA) x += ' vertical="' + xf.vA + '"';
        if (xf.wr) x += ' wrapText="1"';
        x += "/></xf>";
      } else x += "<xf " + a + "/>";
    }
    x +=
      '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>';
    if (this._dxfs.length > 0) {
      x += '<dxfs count="' + this._dxfs.length + '">';
      for (const d of this._dxfs) {
        x += "<dxf>";
        if (d.bold || d.italic || d.color) {
          x += "<font>";
          if (d.bold) x += "<b/>";
          if (d.italic) x += "<i/>";
          if (d.color) x += '<color rgb="FF' + strip(d.color) + '"/>';
          x += "</font>";
        }
        if (d.fill)
          x +=
            '<fill><patternFill><bgColor rgb="FF' +
            strip(d.fill) +
            '"/></patternFill></fill>';
        x += "</dxf>";
      }
      x += "</dxfs>";
    }
    return x + "</styleSheet>";
  }
}

export class PivotConfig {
  id: number;
  srcSheet: Sheet;
  tgtSheet: Sheet;
  sourceRange: string;
  targetCell: string;
  headers: string[];
  dataRows: CellValue[][];
  rowIdxs: number[];
  colIdxs: number[];
  filterIdxs: number[];
  valSpecs: InternalPivotValueSpec[];
  fields: PivotFieldSpec[];

  constructor(
    id: number,
    opts: PivotTableOptions,
    srcSheet: Sheet,
    tgtSheet: Sheet,
  ) {
    this.id = id;
    this.srcSheet = srcSheet;
    this.tgtSheet = tgtSheet;
    this.sourceRange = opts.sourceRange;
    this.targetCell = opts.targetCell || "A3";
    const [fromRef, toRef] = opts.sourceRange.split(":");
    const from = parseCellRef(fromRef!);
    const to = parseCellRef(toRef!);
    this.headers = [];
    for (let c = from.col; c <= to.col; c++) {
      const v = srcSheet.getCellValue({ row: from.row, col: c });
      this.headers.push(v != null ? String(v) : "Column" + c);
    }
    this.dataRows = [];
    for (let r = from.row + 1; r <= to.row; r++) {
      const row: CellValue[] = [];
      for (let c = from.col; c <= to.col; c++) {
        const v = srcSheet.getCellValue({ row: r, col: c });
        row.push(v != null ? v : null);
      }
      this.dataRows.push(row);
    }
    const fm: Record<string, number> = {};
    this.headers.forEach((h, i) => (fm[h] = i));
    const resolve = (name: string | undefined, label: string): number => {
      if (!name) throw new Error(label + " field not found: " + name);
      const i = fm[name];
      if (i === undefined) throw new Error(label + " field not found: " + name);
      return i;
    };
    this.rowIdxs = [...(opts.rows || [])].map((n) => resolve(n, "Row"));
    this.colIdxs = [...(opts.columns || [])].map((n) => resolve(n, "Column"));
    this.filterIdxs = [...(opts.filters || [])].map((n) =>
      resolve(n, "Filter"),
    );
    this.valSpecs = [...(opts.values || [])].map((v) => {
      const name = v.field || v.name;
      const fld = resolve(name, "Value");
      const func = v.func || "sum";
      const cap = func.charAt(0).toUpperCase() + func.slice(1);
      return { fld, func, label: v.label || cap + " of " + name };
    });
    const axisSet = new Set([
      ...this.rowIdxs,
      ...this.colIdxs,
      ...this.filterIdxs,
    ]);
    this.fields = this.headers.map((name, idx) => {
      const vals = this.dataRows.map((r) => r[idx]);
      const isAxis = axisSet.has(idx);
      const allNum = vals.every((v) => v === null || typeof v === "number");
      if (isAxis || !allNum) {
        const unique: CellValue[] = [];
        const seen = new Map<string, number>();
        for (const v of vals) {
          const k = v === null ? "\x00null" : String(v);
          if (!seen.has(k)) {
            seen.set(k, unique.length);
            unique.push(v);
          }
        }
        return { name, idx, shared: true, unique, valueMap: seen };
      }
      const nums = vals.filter((v): v is number => typeof v === "number");
      return {
        name,
        idx,
        shared: false,
        min: nums.length ? Math.min(...nums) : 0,
        max: nums.length ? Math.max(...nums) : 0,
      };
    });
    this._preCompute();
  }

  _preCompute(): void {
    const tgt = parseCellRef(this.targetCell);
    const nFR = this.filterIdxs.length;
    const startRow = tgt.row + (nFR > 0 ? nFR + 1 : 0);
    const startCol = tgt.col;
    if (this.rowIdxs.length > 0)
      for (let ri = 0; ri < this.rowIdxs.length; ri++)
        this.tgtSheet.setCell(
          { row: startRow, col: startCol + ri },
          this.fields[this.rowIdxs[ri]!]!.name,
        );
    for (let vi = 0; vi < this.valSpecs.length; vi++)
      this.tgtSheet.setCell(
        {
          row: startRow,
          col: startCol + Math.max(this.rowIdxs.length, 1) + vi,
        },
        this.valSpecs[vi]!.label,
      );
    if (this.rowIdxs.length > 0) {
      const rowField = this.fields[this.rowIdxs[0]!]!;
      let r = startRow + 1;
      const grand = this.valSpecs.map(() => ({
        sum: 0,
        count: 0,
        min: 0,
        max: 0,
        hasValue: false,
      }));
      for (let ui = 0; ui < (rowField.unique || []).length; ui++) {
        const uVal = rowField.unique![ui];
        this.tgtSheet.setCell({ row: r, col: startCol }, uVal);
        for (let vi = 0; vi < this.valSpecs.length; vi++) {
          const vs = this.valSpecs[vi]!;
          const grandValue = grand[vi]!;
          let agg = 0;
          let cnt = 0;
          for (const dRow of this.dataRows) {
            if (
              dRow[this.rowIdxs[0]!] === uVal ||
              String(dRow[this.rowIdxs[0]!]) === String(uVal)
            ) {
              const rawVal = dRow[vs.fld];
              const val = typeof rawVal === "number" ? rawVal : 0;
              if (vs.func === "count") {
                cnt++;
                grandValue.count++;
              } else if (vs.func === "min") {
                agg = cnt === 0 ? val : Math.min(agg, val);
                cnt++;
                grandValue.min = grandValue.hasValue
                  ? Math.min(grandValue.min, val)
                  : val;
                grandValue.hasValue = true;
              } else if (vs.func === "max") {
                agg = cnt === 0 ? val : Math.max(agg, val);
                cnt++;
                grandValue.max = grandValue.hasValue
                  ? Math.max(grandValue.max, val)
                  : val;
                grandValue.hasValue = true;
              } else {
                agg += val;
                cnt++;
                grandValue.sum += val;
                grandValue.count++;
              }
            }
          }
          const result =
            vs.func === "count"
              ? cnt
              : vs.func === "average" && cnt > 0
                ? agg / cnt
                : agg;
          this.tgtSheet.setCell(
            { row: r, col: startCol + Math.max(this.rowIdxs.length, 1) + vi },
            result,
          );
        }
        r++;
      }
      this.tgtSheet.setCell({ row: r, col: startCol }, "Grand Total");
      for (let vi = 0; vi < this.valSpecs.length; vi++) {
        const vs = this.valSpecs[vi]!;
        const grandValue = grand[vi]!;
        let g = grandValue.sum;
        if (vs.func === "count") g = grandValue.count;
        else if (vs.func === "average" && grandValue.count > 0)
          g = grandValue.sum / grandValue.count;
        else if (vs.func === "min")
          g = grandValue.hasValue ? grandValue.min : 0;
        else if (vs.func === "max")
          g = grandValue.hasValue ? grandValue.max : 0;
        this.tgtSheet.setCell(
          { row: r, col: startCol + Math.max(this.rowIdxs.length, 1) + vi },
          g,
        );
      }
    }
  }

  cacheDefXml(): string {
    let x =
      X +
      '<pivotCacheDefinition xmlns="' +
      NS +
      '" xmlns:r="' +
      NR +
      '" r:id="rId1" refreshOnLoad="1" recordCount="' +
      this.dataRows.length +
      '">';
    x +=
      '<cacheSource type="worksheet"><worksheetSource ref="' +
      this.sourceRange +
      '" sheet="' +
      escapeAttr(this.srcSheet.name) +
      '"/></cacheSource>';
    x += '<cacheFields count="' + this.fields.length + '">';
    for (const f of this.fields) {
      x += '<cacheField name="' + escapeAttr(f.name) + '" numFmtId="0">';
      if (f.shared) {
        x += '<sharedItems count="' + (f.unique || []).length + '">';
        for (const v of f.unique || []) {
          if (v === null) x += "<m/>";
          else if (typeof v === "number") x += '<n v="' + v + '"/>';
          else x += '<s v="' + escapeAttr(String(v)) + '"/>';
        }
        x += "</sharedItems>";
      } else
        x +=
          '<sharedItems containsSemiMixedTypes="0" containsString="0" containsNumber="1" minValue="' +
          (f.min || 0) +
          '" maxValue="' +
          (f.max || 0) +
          '" count="0"/>';
      x += "</cacheField>";
    }
    return x + "</cacheFields></pivotCacheDefinition>";
  }

  cacheRecXml(): string {
    let x =
      X +
      '<pivotCacheRecords xmlns="' +
      NS +
      '" xmlns:r="' +
      NR +
      '" count="' +
      this.dataRows.length +
      '">';
    for (const row of this.dataRows) {
      x += "<r>";
      for (let i = 0; i < this.fields.length; i++) {
        const f = this.fields[i]!;
        const v = row[i];
        if (f.shared) {
          const k = v === null ? "\x00null" : String(v);
          x += '<x v="' + f.valueMap!.get(k) + '"/>';
        } else {
          if (v === null) x += "<m/>";
          else x += '<n v="' + v + '"/>';
        }
      }
      x += "</r>";
    }
    return x + "</pivotCacheRecords>";
  }

  tableXml(): string {
    const tgt = parseCellRef(this.targetCell);
    const nRL = Math.max(this.rowIdxs.length, 1);
    const nFR = this.filterIdxs.length;
    const locTop = tgt.row + (nFR > 0 ? nFR + 1 : 0);
    const locLeft = tgt.col;
    const nDataRows =
      this.rowIdxs.length > 0
        ? (this.fields[this.rowIdxs[0]!]!.unique || []).length
        : this.dataRows.length;
    const nDataCols = Math.max(this.valSpecs.length, 1);
    const hasColFields = this.colIdxs.length > 0 || this.valSpecs.length > 1;
    const locRef =
      cellRef(locTop, locLeft) +
      ":" +
      cellRef(locTop + 1 + nDataRows, locLeft + nRL + nDataCols - 1);
    let x =
      X +
      '<pivotTableDefinition xmlns="' +
      NS +
      '" name="PivotTable' +
      (this.id + 1) +
      '" cacheId="' +
      this.id +
      '" applyNumberFormats="0" applyBorderFormats="0" applyFontFormats="0" applyPatternFormats="0" applyAlignmentFormats="0" applyWidthHeightFormats="1" dataCaption="Values" updatedVersion="6" minRefreshableVersion="3" useAutoFormatting="1" itemPrintTitles="1" createdVersion="6" indent="0" outline="1" outlineData="1" multipleFieldFilters="0">';
    x +=
      '<location ref="' +
      locRef +
      '" firstHeaderRow="1" firstDataRow="1" firstDataCol="' +
      nRL +
      '"';
    if (nFR > 0) x += ' rowPageCount="' + nFR + '" colPageCount="1"';
    x += "/>";
    x += '<pivotFields count="' + this.fields.length + '">';
    for (let i = 0; i < this.fields.length; i++) {
      const f = this.fields[i]!;
      const isR = this.rowIdxs.includes(i);
      const isC = this.colIdxs.includes(i);
      const isF = this.filterIdxs.includes(i);
      const isV = this.valSpecs.some((v) => v.fld === i);
      if (isR || isC || isF) {
        const axis = isR ? "axisRow" : isC ? "axisCol" : "axisPage";
        x +=
          '<pivotField axis="' +
          axis +
          '" showAll="0"><items count="' +
          ((f.unique || []).length + 1) +
          '">';
        for (let j = 0; j < (f.unique || []).length; j++)
          x += '<item x="' + j + '"/>';
        x += '<item t="default"/></items></pivotField>';
      } else if (isV) x += '<pivotField dataField="1" showAll="0"/>';
      else x += '<pivotField showAll="0"/>';
    }
    x += "</pivotFields>";
    if (this.rowIdxs.length > 0) {
      x += '<rowFields count="' + this.rowIdxs.length + '">';
      for (const ri of this.rowIdxs) x += '<field x="' + ri + '"/>';
      x += "</rowFields>";
      const nItems = (this.fields[this.rowIdxs[0]!]!.unique || []).length;
      x += '<rowItems count="' + (nItems + 1) + '">';
      for (let j = 0; j < nItems; j++) x += '<i><x v="' + j + '"/></i>';
      x += '<i t="grand"><x/></i></rowItems>';
    }
    if (hasColFields) {
      const cfs = [...this.colIdxs];
      if (this.valSpecs.length > 1) cfs.push(-2);
      x += '<colFields count="' + cfs.length + '">';
      for (const cf of cfs) x += '<field x="' + cf + '"/>';
      x += '</colFields><colItems count="1"><i><x/></i></colItems>';
    } else x += '<colItems count="1"><i><x/></i></colItems>';
    if (this.filterIdxs.length > 0) {
      x += '<pageFields count="' + this.filterIdxs.length + '">';
      for (const fi of this.filterIdxs)
        x += '<pageField fld="' + fi + '" hier="-1"/>';
      x += "</pageFields>";
    }
    x += '<dataFields count="' + this.valSpecs.length + '">';
    for (const vs of this.valSpecs) {
      x +=
        '<dataField name="' + escapeAttr(vs.label) + '" fld="' + vs.fld + '"';
      if (vs.func !== "sum") x += ' subtotal="' + vs.func + '"';
      x += ' baseField="0" baseItem="0"/>';
    }
    x +=
      '</dataFields><pivotTableStyleInfo name="PivotStyleLight16" showRowHeaders="1" showColHeaders="1" showRowStripes="0" showColStripes="0" showLastColumn="1"/>';
    return x + "</pivotTableDefinition>";
  }
}

function buildChartXml(ch: ChartSpec, sheetName: string): string {
  const type = ch.type,
    nCat = ch.categories.length,
    isPie = type === "pie" || type === "doughnut",
    qn = quoteSheet(sheetName);
  let chartTag: string;
  let closeTag: string;
  if (type === "column" || type === "bar") {
    chartTag =
      '<c:barChart><c:barDir val="' +
      (type === "bar" ? "bar" : "col") +
      '"/><c:grouping val="' +
      (ch.percentStacked
        ? "percentStacked"
        : ch.stacked
          ? "stacked"
          : "clustered") +
      '"/>';
    closeTag = "</c:barChart>";
  } else if (type === "line") {
    chartTag =
      '<c:lineChart><c:grouping val="' +
      (ch.percentStacked
        ? "percentStacked"
        : ch.stacked
          ? "stacked"
          : "standard") +
      '"/>';
    closeTag = "</c:lineChart>";
  } else if (type === "area") {
    chartTag =
      '<c:areaChart><c:grouping val="' +
      (ch.percentStacked
        ? "percentStacked"
        : ch.stacked
          ? "stacked"
          : "standard") +
      '"/>';
    closeTag = "</c:areaChart>";
  } else if (type === "pie") {
    chartTag = "<c:pieChart>";
    closeTag = "</c:pieChart>";
  } else {
    chartTag = "<c:doughnutChart>";
    closeTag = "</c:doughnutChart>";
  }
  chartTag += '<c:varyColors val="' + (isPie ? "1" : "0") + '"/>';
  let s = "";
  for (let si = 0; si < ch.series.length; si++) {
    const ser = ch.series[si]!;
    const vl = numToCol(si + 2);
    s +=
      '<c:ser><c:idx val="' +
      si +
      '"/><c:order val="' +
      si +
      '"/><c:tx><c:strRef><c:f>' +
      qn +
      "!$" +
      vl +
      '$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>' +
      escapeXml(ser.name) +
      "</c:v></c:pt></c:strCache></c:strRef></c:tx>";
    if (!isPie)
      s +=
        '<c:spPr><a:solidFill><a:srgbClr val="' +
        COLORS[si % COLORS.length] +
        '"/></a:solidFill></c:spPr>';
    if (ch.dataLabels)
      s +=
        '<c:dLbls><c:showLegendKey val="0"/><c:showVal val="' +
        (isPie ? "0" : "1") +
        '"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="' +
        (isPie ? "1" : "0") +
        '"/></c:dLbls>';
    s +=
      "<c:cat><c:strRef><c:f>" +
      qn +
      "!$A$2:$A$" +
      (nCat + 1) +
      '</c:f><c:strCache><c:ptCount val="' +
      nCat +
      '"/>';
    for (let ci = 0; ci < nCat; ci++)
      s +=
        '<c:pt idx="' +
        ci +
        '"><c:v>' +
        escapeXml(String(ch.categories[ci])) +
        "</c:v></c:pt>";
    s +=
      "</c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>" +
      qn +
      "!$" +
      vl +
      "$2:$" +
      vl +
      "$" +
      (nCat + 1) +
      '</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="' +
      nCat +
      '"/>';
    for (let ci = 0; ci < nCat; ci++)
      s +=
        '<c:pt idx="' +
        ci +
        '"><c:v>' +
        (ser.values[ci] ?? 0) +
        "</c:v></c:pt>";
    s += "</c:numCache></c:numRef></c:val></c:ser>";
  }
  if (ch.dataLabels)
    s +=
      '<c:dLbls><c:showLegendKey val="0"/><c:showVal val="' +
      (isPie ? "0" : "1") +
      '"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="' +
      (isPie ? "1" : "0") +
      '"/></c:dLbls>';
  if (type === "doughnut") s += '<c:holeSize val="' + ch.holeSize + '"/>';
  const ax1 = 468642094,
    ax2 = 468642096;
  if (!isPie) s += '<c:axId val="' + ax1 + '"/><c:axId val="' + ax2 + '"/>';
  let ax = "";
  if (!isPie) {
    const cp = type === "bar" ? "l" : "b",
      vp = type === "bar" ? "b" : "l";
    ax =
      '<c:catAx><c:axId val="' +
      ax1 +
      '"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="' +
      cp +
      '"/><c:crossAx val="' +
      ax2 +
      '"/></c:catAx><c:valAx><c:axId val="' +
      ax2 +
      '"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="' +
      vp +
      '"/><c:numFmt formatCode="General" sourceLinked="1"/><c:crossAx val="' +
      ax1 +
      '"/></c:valAx>';
  }
  let tt = "";
  if (ch.title)
    tt =
      '<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1400" b="0"/></a:pPr><a:r><a:rPr lang="en-US" sz="1400" b="0"/><a:t>' +
      escapeXml(ch.title) +
      '</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>';
  const lg = ch.legend
    ? '<c:legend><c:legendPos val="' +
      ch.legendPosition +
      '"/><c:overlay val="0"/></c:legend>'
    : "";
  return (
    X +
    '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="' +
    NR +
    '"><c:chart>' +
    tt +
    "<c:plotArea><c:layout/>" +
    chartTag +
    s +
    closeTag +
    ax +
    "</c:plotArea>" +
    lg +
    '<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart><c:printSettings><c:headerFooter/><c:pageMargins b="0.75" l="0.7" r="0.7" t="0.75" header="0.3" footer="0.3"/><c:pageSetup/></c:printSettings></c:chartSpace>'
  );
}

function buildDrawingXml(
  charts: readonly ChartSpec[],
  images: readonly ImageEntry[],
  chartRIdStart: number,
  imageRIdStart: number,
): string {
  let xml =
    X +
    '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="' +
    NR +
    '">';
  let nextId = 2;
  for (let i = 0; i < charts.length; i++) {
    const anc = charts[i]!._anchor;
    xml +=
      "<xdr:twoCellAnchor><xdr:from><xdr:col>" +
      anc.from.col +
      "</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>" +
      anc.from.row +
      "</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>" +
      anc.to.col +
      "</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>" +
      anc.to.row +
      '</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="' +
      nextId++ +
      '" name="Chart ' +
      (i + 1) +
      '"/><xdr:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></xdr:cNvGraphicFramePr></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId' +
      (chartRIdStart + i) +
      '"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>';
  }
  for (let i = 0; i < images.length; i++) {
    const anc = images[i]!._anchor;
    xml +=
      '<xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>' +
      anc.from.col +
      "</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>" +
      anc.from.row +
      "</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>" +
      anc.to.col +
      "</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>" +
      anc.to.row +
      '</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="' +
      nextId++ +
      '" name="Picture ' +
      (i + 1) +
      '"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId' +
      (imageRIdStart + i) +
      '"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:twoCellAnchor>';
  }
  return xml + "</xdr:wsDr>";
}

function buildCondFmtXml(
  cfList: readonly CondFmtEntry[],
  sm: StyleMgr,
): string {
  let x = "";
  let pr = 1;
  for (const cf of cfList) {
    x += '<conditionalFormatting sqref="' + cf.range + '">';
    const r = cf.rule;
    if (r.type === "dataBar")
      x +=
        '<cfRule type="dataBar" priority="' +
        pr++ +
        '"><dataBar><cfvo type="min"/><cfvo type="max"/><color rgb="FF' +
        strip(r.color || "4472C4") +
        '"/></dataBar></cfRule>';
    else if (r.type === "colorScale") {
      x +=
        '<cfRule type="colorScale" priority="' +
        pr++ +
        '"><colorScale><cfvo type="min"/>';
      if (r.midColor) x += '<cfvo type="percentile" val="50"/>';
      x +=
        '<cfvo type="max"/><color rgb="FF' +
        strip(r.minColor || "FCFCFF") +
        '"/>';
      if (r.midColor) x += '<color rgb="FF' + strip(r.midColor) + '"/>';
      x +=
        '<color rgb="FF' +
        strip(r.maxColor || "4472C4") +
        '"/></colorScale></cfRule>';
    } else if (r.type === "iconSet") {
      const is = r.iconSet || "3TrafficLights1";
      const n = parseInt(is.charAt(0), 10) || 3;
      x +=
        '<cfRule type="iconSet" priority="' +
        pr++ +
        '"><iconSet iconSet="' +
        is +
        '">';
      for (let i = 0; i < n; i++)
        x += '<cfvo type="percent" val="' + Math.round((i / n) * 100) + '"/>';
      x += "</iconSet></cfRule>";
    } else if (r.type === "cellIs") {
      const di = sm.addDxf(r.style || {});
      x +=
        '<cfRule type="cellIs" dxfId="' +
        di +
        '" priority="' +
        pr++ +
        '" operator="' +
        (r.operator || "greaterThan") +
        '"><formula>' +
        escapeXml(String(r.formula)) +
        "</formula>";
      if (r.formula2)
        x += "<formula>" + escapeXml(String(r.formula2)) + "</formula>";
      x += "</cfRule>";
    } else if (r.type === "top10") {
      const di = sm.addDxf(r.style || {});
      x +=
        '<cfRule type="top10" dxfId="' +
        di +
        '" priority="' +
        pr++ +
        '" rank="' +
        (r.rank || 10) +
        '"';
      if (r.bottom) x += ' bottom="1"';
      if (r.percent) x += ' percent="1"';
      x += "/>";
    } else if (r.type === "aboveAverage") {
      const di = sm.addDxf(r.style || {});
      x +=
        '<cfRule type="aboveAverage" dxfId="' +
        di +
        '" priority="' +
        pr++ +
        '"';
      if (r.below) x += ' aboveAverage="0"';
      x += "/>";
    } else if (r.type === "duplicateValues") {
      const di = sm.addDxf(r.style || {});
      x +=
        '<cfRule type="duplicateValues" dxfId="' +
        di +
        '" priority="' +
        pr++ +
        '"/>';
    }
    x += "</conditionalFormatting>";
  }
  return x;
}

function buildDataValXml(dvList: readonly DataValidationEntry[]): string {
  if (!dvList.length) return "";
  let x = '<dataValidations count="' + dvList.length + '">';
  for (const dv of dvList) {
    x +=
      '<dataValidation type="' +
      (dv.type || "list") +
      '" allowBlank="' +
      (dv.allowBlank === false ? "0" : "1") +
      '" showInputMessage="1" showErrorMessage="1"';
    if (dv.operator) x += ' operator="' + dv.operator + '"';
    x += ' sqref="' + dv.range + '"';
    if (dv.errorTitle) x += ' errorTitle="' + escapeAttr(dv.errorTitle) + '"';
    if (dv.error) x += ' error="' + escapeAttr(dv.error) + '"';
    if (dv.promptTitle)
      x += ' promptTitle="' + escapeAttr(dv.promptTitle) + '"';
    if (dv.prompt) x += ' prompt="' + escapeAttr(dv.prompt) + '"';
    x += ">";
    if (dv.type === "list" || !dv.type) {
      if (dv.values)
        x += '<formula1>"' + inlineListFormula(dv.values) + '"</formula1>';
      else if (dv.formula)
        x += "<formula1>" + escapeXml(dv.formula) + "</formula1>";
    } else if (dv.type === "custom")
      x += "<formula1>" + escapeXml(dv.formula || "") + "</formula1>";
    else {
      if (dv.min !== undefined) x += "<formula1>" + dv.min + "</formula1>";
      if (dv.max !== undefined) x += "<formula2>" + dv.max + "</formula2>";
    }
    x += "</dataValidation>";
  }
  return x + "</dataValidations>";
}

function inlineListFormula(values: readonly string[]): string {
  for (const value of values) {
    if (value.includes(",") || value.includes('"'))
      throw new Error(
        "Inline XLSX validation lists cannot contain comma or quote characters; use a formula range instead",
      );
  }
  return escapeXml([...values].join(","));
}

function buildSparklineXml(
  sparkGroups: readonly SparklineOptions[],
  sheetName: string,
): string {
  if (!sparkGroups.length) return "";
  const qn = quoteSheet(sheetName);
  let x =
    '<extLst><ext uri="{05C60535-1F16-4fd2-B633-F4F36F0B64E0}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><x14:sparklineGroups xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main">';
  for (const sg of sparkGroups) {
    const type = sg.type || "line";
    const clr = strip(sg.color || "#4472C4");
    const negClr = strip(sg.negativeColor || "#ED7D31");
    x += "<x14:sparklineGroup";
    if (type !== "line") x += ' type="' + type + '"';
    x += ' displayEmptyCellsAs="gap"';
    if (sg.markers && type === "line") x += ' markers="1"';
    if (sg.showHigh) x += ' high="1"';
    if (sg.showLow) x += ' low="1"';
    if (sg.showFirst) x += ' first="1"';
    if (sg.showLast) x += ' last="1"';
    if (sg.showNegative) x += ' negative="1"';
    if (sg.lineWeight && type === "line")
      x += ' lineWeight="' + sg.lineWeight + '"';
    x +=
      '><x14:colorSeries rgb="FF' +
      clr +
      '"/><x14:colorNegative rgb="FF' +
      negClr +
      '"/><x14:colorAxis rgb="FF000000"/><x14:colorMarkers rgb="FF' +
      clr +
      '"/>';
    if (sg.firstColor)
      x += '<x14:colorFirst rgb="FF' + strip(sg.firstColor) + '"/>';
    if (sg.lastColor)
      x += '<x14:colorLast rgb="FF' + strip(sg.lastColor) + '"/>';
    if (sg.highColor)
      x += '<x14:colorHigh rgb="FF' + strip(sg.highColor) + '"/>';
    if (sg.lowColor) x += '<x14:colorLow rgb="FF' + strip(sg.lowColor) + '"/>';
    x += "<x14:sparklines>";
    const dRef = sg.dataRange.split(":");
    const lRef = sg.locationRange.split(":");
    const dFrom = parseCellRef(dRef[0]!);
    const dTo = parseCellRef(dRef[1] || dRef[0]!);
    const lFrom = parseCellRef(lRef[0]!);
    const lTo = parseCellRef(lRef[1] || lRef[0]!);
    const n = lTo.row - lFrom.row + 1;
    for (let i = 0; i < n; i++) {
      const dr = dFrom.row + i;
      x +=
        "<x14:sparkline><xm:f>" +
        qn +
        "!" +
        cellRef(dr, dFrom.col) +
        ":" +
        cellRef(dr, dTo.col) +
        "</xm:f><xm:sqref>" +
        cellRef(lFrom.row + i, lFrom.col) +
        "</xm:sqref></x14:sparkline>";
    }
    x += "</x14:sparklines></x14:sparklineGroup>";
  }
  return x + "</x14:sparklineGroups></ext></extLst>";
}

export class Workbook {
  _sheets: Sheet[] = [];
  _sm = new StyleMgr();
  _sst: string[] = [];
  _sstMap = new Map<string, number>();
  _pivots: PivotConfig[] = [];
  _namedRanges: NamedRangeEntry[] = [];
  _globalImages: ImageEntry[] = [];

  addSheet(name?: string): Sheet {
    const s = new Sheet(
      name || "Sheet" + (this._sheets.length + 1),
      this._sheets.length + 1,
    );
    this._sheets.push(s);
    return s;
  }

  addPivotTable(opts: PivotTableAddOptions): this {
    const src =
      typeof opts.sourceSheet === "string"
        ? this._sheets.find((s) => s.name === opts.sourceSheet)
        : opts.sourceSheet;
    const tgt =
      typeof opts.targetSheet === "string"
        ? this._sheets.find((s) => s.name === opts.targetSheet)
        : opts.targetSheet;
    if (!src) throw new Error("Source sheet not found");
    if (!tgt) throw new Error("Target sheet not found");
    this._pivots.push(new PivotConfig(this._pivots.length, opts, src, tgt));
    return this;
  }

  addNamedRange(name: string, ref: string, sheetName?: string): this {
    if (sheetName) ref = quoteSheet(sheetName) + "!" + ref;
    this._namedRanges.push({ name, ref });
    return this;
  }

  _addStr(s: string): number {
    if (this._sstMap.has(s)) return this._sstMap.get(s)!;
    const i = this._sst.length;
    this._sst.push(s);
    this._sstMap.set(s, i);
    return i;
  }

  build(): Uint8Array {
    if (!this._sheets.length) this.addSheet();
    const entries: ZipEntry[] = [];
    let chartIdx = 0;
    const sheetChartMap = new Map<Sheet, number[]>();
    let globalImgIdx = 0;
    const sheetImgMap = new Map<Sheet, number[]>();
    const imageExts = new Set<ImageExt>();
    for (const sh of this._sheets) {
      if (sh._charts.length > 0) {
        const indices: number[] = [];
        for (let c = 0; c < sh._charts.length; c++) indices.push(chartIdx++);
        sheetChartMap.set(sh, indices);
      }
      if (sh._images.length > 0) {
        const indices: number[] = [];
        for (let im = 0; im < sh._images.length; im++) {
          indices.push(globalImgIdx++);
          imageExts.add(sh._images[im]!.ext);
        }
        sheetImgMap.set(sh, indices);
      }
    }
    entries.push({
      name: "[Content_Types].xml",
      data: this._ctXml(chartIdx, sheetChartMap, imageExts),
    });
    entries.push({
      name: "_rels/.rels",
      data:
        X +
        '<Relationships xmlns="' +
        NP +
        '"><Relationship Id="rId1" Type="' +
        RD +
        '" Target="xl/workbook.xml"/></Relationships>',
    });
    entries.push({ name: "xl/workbook.xml", data: this._wbXml() });
    entries.push({ name: "xl/_rels/workbook.xml.rels", data: this._wbRels() });
    for (let i = 0; i < this._sheets.length; i++) {
      const sh = this._sheets[i]!;
      const pvIdxs: number[] = [];
      for (let p = 0; p < this._pivots.length; p++)
        if (this._pivots[p]!.tgtSheet === sh) pvIdxs.push(p);
      const hasCharts = sheetChartMap.has(sh);
      const hasImages = sheetImgMap.has(sh);
      const hasDrawing = hasCharts || hasImages;
      const extHyperlinks = sh._hyperlinks.filter((h) => !h.internal);
      let shRid = 1;
      const pvRids = pvIdxs.map(() => shRid++);
      const drawingRId = hasDrawing ? "rId" + shRid++ : null;
      const hlRids = extHyperlinks.map(() => shRid++);
      void pvRids;
      entries.push({
        name: "xl/worksheets/sheet" + (i + 1) + ".xml",
        data: this._wsXml(sh, drawingRId, i === 0, hlRids),
      });
      if (pvIdxs.length > 0 || hasDrawing || extHyperlinks.length > 0) {
        let r = X + '<Relationships xmlns="' + NP + '">';
        let rid = 1;
        for (const pi of pvIdxs)
          r +=
            '<Relationship Id="rId' +
            rid++ +
            '" Type="' +
            RPT +
            '" Target="../pivotTables/pivotTable' +
            (pi + 1) +
            '.xml"/>';
        if (hasDrawing)
          r +=
            '<Relationship Id="rId' +
            rid++ +
            '" Type="' +
            RDR +
            '" Target="../drawings/drawing' +
            sh.index +
            '.xml"/>';
        for (const hl of extHyperlinks)
          r +=
            '<Relationship Id="rId' +
            rid++ +
            '" Type="' +
            RHL +
            '" Target="' +
            escapeAttr(hl.url) +
            '" TargetMode="External"/>';
        r += "</Relationships>";
        entries.push({
          name: "xl/worksheets/_rels/sheet" + sh.index + ".xml.rels",
          data: r,
        });
      }
    }
    entries.push({ name: "xl/styles.xml", data: this._sm.toXml() });
    entries.push({ name: "xl/sharedStrings.xml", data: this._sstXml() });
    for (let p = 0; p < this._pivots.length; p++) {
      const pv = this._pivots[p]!;
      entries.push({
        name: "xl/pivotCache/pivotCacheDefinition" + (p + 1) + ".xml",
        data: pv.cacheDefXml(),
      });
      entries.push({
        name: "xl/pivotCache/pivotCacheRecords" + (p + 1) + ".xml",
        data: pv.cacheRecXml(),
      });
      entries.push({
        name: "xl/pivotTables/pivotTable" + (p + 1) + ".xml",
        data: pv.tableXml(),
      });
      entries.push({
        name:
          "xl/pivotCache/_rels/pivotCacheDefinition" + (p + 1) + ".xml.rels",
        data:
          X +
          '<Relationships xmlns="' +
          NP +
          '"><Relationship Id="rId1" Type="' +
          RPR +
          '" Target="pivotCacheRecords' +
          (p + 1) +
          '.xml"/></Relationships>',
      });
      entries.push({
        name: "xl/pivotTables/_rels/pivotTable" + (p + 1) + ".xml.rels",
        data:
          X +
          '<Relationships xmlns="' +
          NP +
          '"><Relationship Id="rId1" Type="' +
          RPC +
          '" Target="../pivotCache/pivotCacheDefinition' +
          (p + 1) +
          '.xml"/></Relationships>',
      });
    }
    for (const sh of this._sheets) {
      const hasCharts = sheetChartMap.has(sh);
      const hasImages = sheetImgMap.has(sh);
      if (!hasCharts && !hasImages) continue;
      const chartIndices = sheetChartMap.get(sh) || [];
      const imgIndices = sheetImgMap.get(sh) || [];
      let drRid = 1;
      entries.push({
        name: "xl/drawings/drawing" + sh.index + ".xml",
        data: buildDrawingXml(
          sh._charts,
          sh._images,
          drRid,
          drRid + chartIndices.length,
        ),
      });
      let dr = X + '<Relationships xmlns="' + NP + '">';
      for (let c = 0; c < chartIndices.length; c++)
        dr +=
          '<Relationship Id="rId' +
          drRid++ +
          '" Type="' +
          RCH +
          '" Target="../charts/chart' +
          (chartIndices[c]! + 1) +
          '.xml"/>';
      for (let im = 0; im < imgIndices.length; im++)
        dr +=
          '<Relationship Id="rId' +
          drRid++ +
          '" Type="' +
          RIM +
          '" Target="../media/image' +
          (imgIndices[im]! + 1) +
          "." +
          sh._images[im]!.ext +
          '"/>';
      dr += "</Relationships>";
      entries.push({
        name: "xl/drawings/_rels/drawing" + sh.index + ".xml.rels",
        data: dr,
      });
      for (let c = 0; c < chartIndices.length; c++)
        entries.push({
          name: "xl/charts/chart" + (chartIndices[c]! + 1) + ".xml",
          data: buildChartXml(sh._charts[c]!, sh.name),
        });
    }
    let gImg = 0;
    for (const sh of this._sheets)
      for (const img of sh._images)
        entries.push({
          name: "xl/media/image" + ++gImg + "." + img.ext,
          data: img.data,
        });
    return createZip(entries);
  }

  _ctXml(
    totalCharts: number,
    sheetChartMap: Map<Sheet, number[]>,
    imageExts: Set<ImageExt>,
  ): string {
    let x = X + '<Types xmlns="' + NC + '">';
    x +=
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>';
    x += '<Default Extension="xml" ContentType="application/xml"/>';
    for (const ext of imageExts)
      x +=
        '<Default Extension="' +
        ext +
        '" ContentType="' +
        (CONTENT_TYPES[ext] || "image/png") +
        '"/>';
    x +=
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>';
    for (let i = 0; i < this._sheets.length; i++)
      x +=
        '<Override PartName="/xl/worksheets/sheet' +
        (i + 1) +
        '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
    x +=
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>';
    x +=
      '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>';
    for (let p = 0; p < this._pivots.length; p++) {
      x +=
        '<Override PartName="/xl/pivotCache/pivotCacheDefinition' +
        (p + 1) +
        '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheDefinition+xml"/>';
      x +=
        '<Override PartName="/xl/pivotCache/pivotCacheRecords' +
        (p + 1) +
        '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheRecords+xml"/>';
      x +=
        '<Override PartName="/xl/pivotTables/pivotTable' +
        (p + 1) +
        '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.pivotTable+xml"/>';
    }
    for (const [sh] of sheetChartMap)
      x +=
        '<Override PartName="/xl/drawings/drawing' +
        sh.index +
        '.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>';
    for (let c = 0; c < totalCharts; c++)
      x +=
        '<Override PartName="/xl/charts/chart' +
        (c + 1) +
        '.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>';
    return x + "</Types>";
  }

  _wbXml(): string {
    let x =
      X +
      '<workbook xmlns="' +
      NS +
      '" xmlns:r="' +
      NR +
      '"><bookViews><workbookView xWindow="0" yWindow="0" windowWidth="16384" windowHeight="8192"/></bookViews><sheets>';
    for (let i = 0; i < this._sheets.length; i++)
      x +=
        '<sheet name="' +
        escapeAttr(this._sheets[i]!.name) +
        '" sheetId="' +
        (i + 1) +
        '" r:id="rId' +
        (i + 1) +
        '"/>';
    x += "</sheets>";
    const allNR: NamedRangeEntry[] = [...this._namedRanges];
    for (let i = 0; i < this._sheets.length; i++) {
      const sh = this._sheets[i]!;
      if (sh._printArea)
        allNR.push({
          name: "_xlnm.Print_Area",
          ref: quoteSheet(sh.name) + "!" + sh._printArea,
          localSheetId: i,
        });
    }
    if (allNR.length > 0) {
      x += "<definedNames>";
      for (const nr of allNR) {
        x += '<definedName name="' + escapeAttr(nr.name) + '"';
        if (nr.localSheetId !== undefined)
          x += ' localSheetId="' + nr.localSheetId + '"';
        x += ">" + escapeXml(nr.ref) + "</definedName>";
      }
      x += "</definedNames>";
    }
    if (this._pivots.length > 0) {
      x += "<pivotCaches>";
      const base = this._sheets.length + 3;
      for (let p = 0; p < this._pivots.length; p++)
        x += '<pivotCache cacheId="' + p + '" r:id="rId' + (base + p) + '"/>';
      x += "</pivotCaches>";
    }
    return x + "</workbook>";
  }

  _wbRels(): string {
    let x = X + '<Relationships xmlns="' + NP + '">';
    for (let i = 0; i < this._sheets.length; i++)
      x +=
        '<Relationship Id="rId' +
        (i + 1) +
        '" Type="' +
        RW +
        '" Target="worksheets/sheet' +
        (i + 1) +
        '.xml"/>';
    const n = this._sheets.length;
    x +=
      '<Relationship Id="rId' +
      (n + 1) +
      '" Type="' +
      RS +
      '" Target="styles.xml"/>';
    x +=
      '<Relationship Id="rId' +
      (n + 2) +
      '" Type="' +
      RT +
      '" Target="sharedStrings.xml"/>';
    for (let p = 0; p < this._pivots.length; p++)
      x +=
        '<Relationship Id="rId' +
        (n + 3 + p) +
        '" Type="' +
        RPC +
        '" Target="pivotCache/pivotCacheDefinition' +
        (p + 1) +
        '.xml"/>';
    return x + "</Relationships>";
  }

  _wsXml(
    sh: Sheet,
    drawingRId: RelationshipId,
    isFirst: boolean,
    hlRids: number[],
  ): string {
    let x = X + '<worksheet xmlns="' + NS + '" xmlns:r="' + NR + '">';
    const hasOutline = sh._rowOutline.size > 0 || sh._colOutline.length > 0;
    if (sh._tabColor || hasOutline) {
      x += "<sheetPr>";
      if (sh._tabColor) x += '<tabColor rgb="FF' + sh._tabColor + '"/>';
      if (hasOutline) x += '<outlinePr summaryBelow="1" summaryRight="1"/>';
      x += "</sheetPr>";
    }
    const rows = [...sh._rows.keys()];
    let minR = 1,
      maxR = 1,
      minC = 1,
      maxC = 1;
    if (rows.length) {
      minR = Math.min(...rows);
      maxR = Math.max(...rows);
      minC = Infinity;
      for (const [, rc] of sh._rows) {
        const cols = [...rc.keys()];
        if (cols.length) {
          minC = Math.min(minC, ...cols);
          maxC = Math.max(maxC, ...cols);
        }
      }
      if (!Number.isFinite(minC)) minC = 1;
    }
    x +=
      '<dimension ref="' +
      cellRef(minR, minC) +
      ":" +
      cellRef(maxR, maxC) +
      '"/>';
    x +=
      "<sheetViews><sheetView" +
      (isFirst ? ' tabSelected="1"' : "") +
      ' workbookViewId="0">';
    if (sh._fzR > 0 || sh._fzC > 0) {
      const tl = cellRef(sh._fzR + 1, Math.max(sh._fzC, 0) + 1);
      x += "<pane";
      if (sh._fzC > 0) x += ' xSplit="' + sh._fzC + '"';
      if (sh._fzR > 0) x += ' ySplit="' + sh._fzR + '"';
      x +=
        ' topLeftCell="' + tl + '" activePane="bottomRight" state="frozen"/>';
    }
    x += '</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"';
    if (hasOutline)
      x +=
        ' outlineLevelRow="' +
        Math.max(...[...sh._rowOutline.values()].map((o) => o.level), 0) +
        '"';
    x += "/>";
    const colOutMap = new Map<number, ColumnOutlineEntry>();
    for (const cg of sh._colOutline)
      for (let c = cg.from; c <= cg.to; c++)
        colOutMap.set(c, {
          from: c,
          to: c,
          level: Math.max(colOutMap.get(c)?.level || 0, cg.level),
          collapsed: !!(colOutMap.get(c)?.collapsed || cg.collapsed),
        });
    const allCols = new Set([...sh._colW.keys(), ...colOutMap.keys()]);
    if (allCols.size) {
      x += "<cols>";
      for (const c of [...allCols].sort((a, b) => a - b)) {
        const w = sh._colW.get(c) || 8.43;
        const ol = colOutMap.get(c);
        x += '<col min="' + c + '" max="' + c + '" width="' + w + '"';
        if (sh._colW.has(c)) x += ' customWidth="1"';
        if (ol) x += ' outlineLevel="' + ol.level + '"';
        if (ol?.collapsed) x += ' collapsed="1"';
        x += "/>";
      }
      x += "</cols>";
    }
    x += "<sheetData>";
    for (const rn of [...sh._rows.keys()].sort((a, b) => a - b)) {
      const rc = sh._rows.get(rn)!;
      x += '<row r="' + rn + '"';
      if (sh._rowH.has(rn))
        x += ' ht="' + sh._rowH.get(rn) + '" customHeight="1"';
      if (sh._rowOutline.has(rn)) {
        const outline = sh._rowOutline.get(rn)!;
        x += ' outlineLevel="' + outline.level + '"';
        if (outline.collapsed) x += ' collapsed="1"';
      }
      x += ">";
      for (const cn of [...rc.keys()].sort((a, b) => a - b)) {
        const cell = rc.get(cn)!;
        let st = cell.s;
        if (cell.v instanceof Date && (!st || !st.numFmt))
          st = Object.assign({}, st || {}, { numFmt: "mm-dd-yy" });
        const si = st ? this._sm.resolve(st) : 0;
        x += this._cXml(cellRef(rn, cn), cell.v, si, st);
      }
      x += "</row>";
    }
    x += "</sheetData>";
    if (sh._protection) {
      x += '<sheetProtection sheet="1" objects="1" scenarios="1"';
      if (sh._protection.password)
        x += ' password="' + hashPassword(sh._protection.password) + '"';
      if (sh._protection.allowSort) x += ' sort="1"';
      if (sh._protection.allowFilter) x += ' autoFilter="1"';
      if (sh._protection.allowFormatCells) x += ' formatCells="1"';
      if (sh._protection.allowFormatColumns) x += ' formatColumns="1"';
      if (sh._protection.allowFormatRows) x += ' formatRows="1"';
      if (sh._protection.allowInsertColumns) x += ' insertColumns="1"';
      if (sh._protection.allowInsertRows) x += ' insertRows="1"';
      if (sh._protection.allowDeleteColumns) x += ' deleteColumns="1"';
      if (sh._protection.allowDeleteRows) x += ' deleteRows="1"';
      x += "/>";
    }
    if (sh._af) x += '<autoFilter ref="' + sh._af + '"/>';
    if (sh._merges.length) {
      x += '<mergeCells count="' + sh._merges.length + '">';
      for (const m of sh._merges) x += '<mergeCell ref="' + m + '"/>';
      x += "</mergeCells>";
    }
    if (sh._condFmts.length) x += buildCondFmtXml(sh._condFmts, this._sm);
    if (sh._dataVals.length) x += buildDataValXml(sh._dataVals);
    if (sh._hyperlinks.length) {
      x += "<hyperlinks>";
      let extIdx = 0;
      for (const hl of sh._hyperlinks) {
        x += '<hyperlink ref="' + hl.ref + '"';
        if (hl.internal) x += ' location="' + escapeAttr(hl.location) + '"';
        else x += ' r:id="rId' + hlRids[extIdx++] + '"';
        if (hl.display) x += ' display="' + escapeAttr(hl.display) + '"';
        if (hl.tooltip) x += ' tooltip="' + escapeAttr(hl.tooltip) + '"';
        x += "/>";
      }
      x += "</hyperlinks>";
    }
    if (sh._pageMargins) {
      const m = sh._pageMargins;
      x +=
        '<pageMargins left="' +
        (m.left || 0.7) +
        '" right="' +
        (m.right || 0.7) +
        '" top="' +
        (m.top || 0.75) +
        '" bottom="' +
        (m.bottom || 0.75) +
        '" header="' +
        (m.header || 0.3) +
        '" footer="' +
        (m.footer || 0.3) +
        '"/>';
    }
    if (sh._pageSetup) {
      const ps = sh._pageSetup;
      x += "<pageSetup";
      if (ps.orientation) x += ' orientation="' + ps.orientation + '"';
      if (ps.paperSize) x += ' paperSize="' + ps.paperSize + '"';
      if (ps.fitToWidth !== undefined)
        x += ' fitToWidth="' + ps.fitToWidth + '"';
      if (ps.fitToHeight !== undefined)
        x += ' fitToHeight="' + ps.fitToHeight + '"';
      if (ps.scale) x += ' scale="' + ps.scale + '"';
      x += "/>";
    }
    if (sh._headerFooter) {
      const hf = sh._headerFooter;
      x += "<headerFooter>";
      if (hf.header) x += "<oddHeader>" + escapeXml(hf.header) + "</oddHeader>";
      if (hf.footer) x += "<oddFooter>" + escapeXml(hf.footer) + "</oddFooter>";
      x += "</headerFooter>";
    }
    if (drawingRId) x += '<drawing r:id="' + drawingRId + '"/>';
    if (sh._sparkGroups.length)
      x += buildSparklineXml(sh._sparkGroups, sh.name);
    return x + "</worksheet>";
  }

  _cXml(
    ref: string,
    v: CellValue,
    si: number,
    style: CellStyle | null,
  ): string {
    if (v === null || v === undefined)
      return si ? '<c r="' + ref + '" s="' + si + '"/>' : "";
    const sAttr = si ? ' s="' + si + '"' : "";
    const f =
      (style && style.formula) ||
      (typeof v === "string" && v.startsWith("=") ? v.slice(1) : null);
    if (f)
      return '<c r="' + ref + '"' + sAttr + "><f>" + escapeXml(f) + "</f></c>";
    if (typeof v === "number")
      return '<c r="' + ref + '"' + sAttr + "><v>" + v + "</v></c>";
    if (typeof v === "boolean")
      return (
        '<c r="' + ref + '" t="b"' + sAttr + "><v>" + (v ? 1 : 0) + "</v></c>"
      );
    if (v instanceof Date)
      return (
        '<c r="' + ref + '"' + sAttr + "><v>" + dateToSerial(v) + "</v></c>"
      );
    const idx = this._addStr(String(v));
    return '<c r="' + ref + '" t="s"' + sAttr + "><v>" + idx + "</v></c>";
  }

  _sstXml(): string {
    let x =
      X +
      '<sst xmlns="' +
      NS +
      '" count="' +
      this._sst.length +
      '" uniqueCount="' +
      this._sst.length +
      '">';
    for (const s of this._sst)
      x += '<si><t xml:space="preserve">' + escapeXml(s) + "</t></si>";
    return x + "</sst>";
  }
}

/** Create a new empty workbook. */
export function createWorkbook(): Workbook {
  return new Workbook();
}

/** Build and write workbook to an .xlsx file. */
export function exportToFile(
  wb: Workbook,
  path: string,
  writeFn: (path: string, bytes: Uint8Array) => void,
): ExportResult {
  const bytes = wb.build();
  writeFn(path, bytes);
  return { path, size: bytes.length };
}

/** Convenience: create a workbook with a single formatted table. */
export function tableToWorkbook(opts: TableToWorkbookOptions): Workbook {
  const wb = createWorkbook();
  const sh = wb.addSheet(opts.sheetName || "Sheet1");
  const hs = Object.assign(
    { bold: true, fill: "#4472C4", color: "#FFFFFF", border: "thin" },
    opts.headerStyle || {},
  );
  const first = opts.data[0];
  const headers = [
    ...(opts.headers ||
      (first && !Array.isArray(first) ? Object.keys(first) : [])),
  ];
  sh.addRow(1, headers, hs);
  if (opts.columnWidths)
    for (let i = 0; i < opts.columnWidths.length; i++)
      sh.setColumnWidth(i + 1, opts.columnWidths[i]!);
  for (let r = 0; r < opts.data.length; r++) {
    const sourceRow = opts.data[r]!;
    const row = Array.isArray(sourceRow)
      ? sourceRow
      : headers.map((h) => (sourceRow as Record<string, CellValue>)[h]);
    const rs =
      typeof opts.rowStyle === "function"
        ? opts.rowStyle(r, sourceRow)
        : opts.rowStyle ||
          (r % 2 === 0
            ? { border: "thin" }
            : { fill: "#D9E2F3", border: "thin" });
    sh.addRow(r + 2, row, rs);
  }
  sh.freezeRows(1);
  sh.setAutoFilter("A1:" + cellRef(1, headers.length));
  return wb;
}
