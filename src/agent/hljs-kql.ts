// ── highlight.js KQL Language Grammar ────────────────────────────────
//
// Provides syntax highlighting for KQL (Kusto Query Language) code
// blocks in terminal markdown output. Keyword lists derived from
// @kusto/monaco-kusto (MIT licensed) Monarch language definition.
//
// Registered as "kql" with aliases "kusto" and "csl".
//
// ─────────────────────────────────────────────────────────────────────

/// <reference types="highlight.js" />

// ── Keyword Lists (from @kusto/monaco-kusto Monarch definition) ─────

const QUERY_OPERATORS = [
  "as",
  "consume",
  "count",
  "distinct",
  "evaluate",
  "extend",
  "facet",
  "filter",
  "find",
  "fork",
  "getschema",
  "graph-match",
  "graph-merge",
  "graph-to-table",
  "invoke",
  "join",
  "limit",
  "lookup",
  "make-graph",
  "make-series",
  "mv-apply",
  "mv-expand",
  "order",
  "parse",
  "parse-kv",
  "parse-where",
  "partition",
  "print",
  "project",
  "project-away",
  "project-keep",
  "project-rename",
  "project-reorder",
  "range",
  "reduce",
  "render",
  "sample",
  "sample-distinct",
  "scan",
  "search",
  "serialize",
  "sort",
  "summarize",
  "take",
  "top",
  "top-hitters",
  "top-nested",
  "union",
  "where",
];

const KEYWORDS = [
  "and",
  "asc",
  "between",
  "by",
  "contains",
  "desc",
  "false",
  "from",
  "has",
  "in",
  "inner",
  "leftouter",
  "let",
  "not",
  "on",
  "or",
  "set",
  "step",
  "table",
  "to",
  "true",
  "with",
  "datatable",
  "materialize",
];

const TYPES = [
  "bool",
  "datetime",
  "decimal",
  "double",
  "dynamic",
  "guid",
  "int",
  "long",
  "real",
  "string",
  "timespan",
];

const SCALAR_FUNCTIONS = [
  "abs",
  "acos",
  "ago",
  "array_concat",
  "array_length",
  "array_slice",
  "array_split",
  "asin",
  "atan",
  "atan2",
  "base64_decode_tostring",
  "base64_encode_tostring",
  "bin",
  "bin_at",
  "case",
  "ceiling",
  "coalesce",
  "cos",
  "countof",
  "datetime_add",
  "datetime_diff",
  "datetime_part",
  "dayofmonth",
  "dayofweek",
  "dayofyear",
  "endofday",
  "endofmonth",
  "endofweek",
  "endofyear",
  "exp",
  "exp10",
  "exp2",
  "extract",
  "extract_all",
  "extractjson",
  "floor",
  "format_datetime",
  "format_timespan",
  "gamma",
  "geo_distance_2points",
  "geo_point_in_circle",
  "geo_point_in_polygon",
  "geo_point_to_geohash",
  "geo_point_to_s2cell",
  "getmonth",
  "gettype",
  "getyear",
  "hash",
  "hash_sha256",
  "iif",
  "indexof",
  "isempty",
  "isfinite",
  "isinf",
  "isnan",
  "isnotempty",
  "isnotnull",
  "isnull",
  "log",
  "log10",
  "log2",
  "make_datetime",
  "make_string",
  "make_timespan",
  "max_of",
  "min_of",
  "monthofyear",
  "next",
  "now",
  "pack",
  "pack_array",
  "parse_csv",
  "parse_ipv4",
  "parse_json",
  "parse_path",
  "parse_url",
  "parse_urlquery",
  "parse_xml",
  "pow",
  "prev",
  "radians",
  "rand",
  "repeat",
  "replace_regex",
  "replace_string",
  "reverse",
  "round",
  "row_cumsum",
  "row_number",
  "row_window_session",
  "sign",
  "sin",
  "split",
  "sqrt",
  "startofday",
  "startofmonth",
  "startofweek",
  "startofyear",
  "strcat",
  "strcat_array",
  "strcat_delim",
  "strcmp",
  "strlen",
  "strrep",
  "substring",
  "tan",
  "tobool",
  "todatetime",
  "todecimal",
  "todouble",
  "todynamic",
  "toguid",
  "tohex",
  "toint",
  "tolong",
  "tolower",
  "toreal",
  "toscalar",
  "tostring",
  "totimespan",
  "toupper",
  "translate",
  "trim",
  "trim_end",
  "trim_start",
  "url_decode",
  "url_encode",
  "week_of_year",
];

const AGGREGATION_FUNCTIONS = [
  "any",
  "avg",
  "avgif",
  "count",
  "countif",
  "dcount",
  "dcount_hll",
  "hll",
  "hll_merge",
  "make_bag",
  "make_list",
  "make_set",
  "max",
  "maxif",
  "min",
  "minif",
  "percentile",
  "percentiles",
  "stdev",
  "stdevif",
  "sum",
  "sumif",
  "tdigest",
  "tdigest_merge",
  "variance",
  "varianceif",
];

const SERIES_FUNCTIONS = [
  "series_add",
  "series_cosine_similarity",
  "series_decompose",
  "series_decompose_anomalies",
  "series_decompose_forecast",
  "series_divide",
  "series_equals",
  "series_fill_backward",
  "series_fill_const",
  "series_fill_forward",
  "series_fill_linear",
  "series_fir",
  "series_fit_2lines",
  "series_fit_line",
  "series_greater",
  "series_greater_equals",
  "series_iir",
  "series_less",
  "series_less_equals",
  "series_multiply",
  "series_not_equals",
  "series_outliers",
  "series_pearson_correlation",
  "series_periods_detect",
  "series_periods_validate",
  "series_seasonal",
  "series_stats",
  "series_stats_dynamic",
  "series_subtract",
];

// ── Grammar Definition ──────────────────────────────────────────────

/**
 * highlight.js language definition for KQL (Kusto Query Language).
 *
 * Register with: `hljs.registerLanguage("kql", kqlLanguage)`
 */
export default function kqlLanguage(hljs?: HLJSApi): Language {
  // All built-in functions combined for the "built_in" className
  const ALL_FUNCTIONS = [
    ...SCALAR_FUNCTIONS,
    ...AGGREGATION_FUNCTIONS,
    ...SERIES_FUNCTIONS,
  ].join(" ");

  // Comments: // line comments
  const LINE_COMMENT: Mode = hljs!.COMMENT("//", "$");

  // Strings: double-quoted and single-quoted
  const STRING: Mode = {
    className: "string",
    variants: [
      { begin: '"', end: '"', contains: [{ begin: '\\\\"' }] },
      { begin: "'", end: "'", contains: [{ begin: "\\\\'" }] },
      // Multi-line string literals: h@"...", @"..."
      { begin: /[hH]?@"/, end: '"' },
    ],
  };

  // Numbers: integers, decimals, scientific notation, timespan suffixes
  const NUMBER: Mode = {
    className: "number",
    variants: [
      // Timespan literals: 1d, 2h, 30m, 45s, 100ms, 500tick
      { begin: /\b\d+(\.\d+)?(d|h|m|s|ms|tick)\b/ },
      // Scientific notation
      { begin: /\b\d+(\.\d+)?[eE][+-]?\d+\b/ },
      // Decimal
      { begin: /\b\d+\.\d+\b/ },
      // Integer (including hex 0x...)
      { begin: /\b0x[0-9a-fA-F]+\b/ },
      { begin: /\b\d+\b/ },
    ],
  };

  // Management commands: .show, .create, .alter, .drop, etc.
  const COMMAND: Mode = {
    className: "meta",
    begin:
      /\.(show|create|alter|drop|set|append|delete|rename|move|replace|ingest|export|create-or-alter|alter-merge|create-merge|set-or-append|set-or-replace|drop-pretend)\b/,
  };

  // datetime() and timespan() literals
  const DATETIME_LITERAL: Mode = {
    className: "literal",
    begin: /\b(datetime|timespan)\s*\(/,
    end: /\)/,
    contains: [
      {
        className: "string",
        begin: /[^)]+/,
      },
    ],
  };

  return {
    name: "Kusto Query Language",
    aliases: ["kusto", "csl"],
    case_insensitive: true,
    keywords: {
      keyword: [...QUERY_OPERATORS, ...KEYWORDS].join(" "),
      type: TYPES.join(" "),
      built_in: ALL_FUNCTIONS,
    },
    contains: [
      LINE_COMMENT,
      STRING,
      NUMBER,
      COMMAND,
      DATETIME_LITERAL,
      // Pipe operator — visually distinct
      {
        className: "punctuation",
        begin: /\|/,
      },
    ],
  };
}
