// ── Terminal Markdown Renderer ────────────────────────────────────────
//
// Renders markdown text as ANSI-formatted terminal output using
// marked + marked-terminal. Used when markdown mode is enabled (default)
// to make LLM output readable instead of raw markdown syntax.
//
// Usage:
//   import { renderMarkdown } from "./markdown-renderer.js";
//   console.log(renderMarkdown("# Hello\n**bold** and `code`"));

import { Marked, type MarkedExtension } from "marked";
import { markedTerminal } from "marked-terminal";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import kqlLanguage from "./hljs-kql.js";

// Register KQL/Kusto syntax highlighting on the shared highlight.js instance.
// cli-highlight (used by marked-terminal) loads highlight.js via CJS require().
// We use createRequire to get the same CJS singleton so registration is visible
// to cli-highlight's highlight() calls.
// Grammar derived from @kusto/monaco-kusto (MIT) Monarch definition.
const cjsRequire = createRequire(import.meta.url);
const hljsInstance = cjsRequire("highlight.js") as {
  registerLanguage: Function;
};
hljsInstance.registerLanguage("kql", kqlLanguage);

// Use a local Marked instance so we don't mutate the global marked
// singleton — other code importing marked won't accidentally get
// terminal-rendered output instead of HTML.
//
// `markedTerminal()` returns a MarkedExtension (`{ renderer, useNewRenderer }`)
// suitable for marked v15's strict `use()` validation.  Constructing a
// `TerminalRenderer` instance directly and passing it as `{ renderer }` no
// longer works in marked >=15 because TerminalRenderer's constructor sets
// own enumerable properties (`this.o`, `this.tab`, …) and marked iterates
// every enumerable key of the renderer object, rejecting anything that
// isn't a known renderer method.
//
// The @types/marked-terminal declaration mis-types the return as
// `TerminalRenderer`; cast through `unknown` to the correct shape.
const terminalExt = markedTerminal({
  // Indent code blocks for visual separation
  tab: 2,
  // Render headings WITHOUT a literal `### ` prefix on screen.  The
  // ANSI bold + green colour applied by marked-terminal is enough to
  // distinguish a heading from prose; keeping `###` visible defeats
  // the whole point of terminal markdown rendering (users see raw
  // markdown markers and assume rendering is broken — exactly the
  // bug report this fixes).
  showSectionPrefix: false,
  // Convert HTML entities back to characters
  unescape: true,
}) as unknown as MarkedExtension;

// ── Patch: process inline tokens inside `text`-block tokens ─────────
// marked-terminal v7.3.0's stock `text` renderer reads `token.text`
// (the raw markdown source) instead of `parser.parseInline(token.tokens)`.
// That's correct for *leaf* inline text tokens (no children) but wrong for
// the *block-level* `text` tokens that marked emits as the body of tight
// list items.  Result: `* **bold** rest` in a list rendered as the literal
// `* **bold** rest` instead of `*  bold  rest`.  See the README's KQL
// Expert example — that bug is what surfaced this.
//
// Fix: wrap the `text` renderer so that whenever the token has a
// non-empty `tokens` array, we recurse via `parseInline` to get proper
// inline formatting (strong/em/code/links/…).  Leaf tokens fall through
// to the original behaviour so escape-handling is preserved.
//
// This is a marked-terminal upstream bug; revisit when that ships a fix.
const patchedRenderer = terminalExt as unknown as {
  renderer: {
    text: (
      this: { parser: { parseInline: (t: unknown[]) => string } },
      token: unknown,
    ) => string;
  };
};
const originalText = patchedRenderer.renderer.text;
patchedRenderer.renderer.text = function (token: unknown): string {
  if (
    typeof token === "object" &&
    token !== null &&
    Array.isArray((token as { tokens?: unknown[] }).tokens) &&
    (token as { tokens: unknown[] }).tokens.length > 0
  ) {
    return this.parser.parseInline((token as { tokens: unknown[] }).tokens);
  }
  return originalText.call(this, token);
};

const localMarked = new Marked(terminalExt);

/**
 * Render a markdown string as ANSI-formatted terminal output.
 *
 * Returns the rendered string with ANSI escape codes for colours,
 * bold, underline, etc. The caller is responsible for printing it.
 *
 * Trailing whitespace is trimmed to avoid extra blank lines.
 *
 * @param text - Raw markdown text from the LLM
 * @returns ANSI-formatted string ready for console output
 */
export function renderMarkdown(text: string): string {
  // localMarked.parse() can return string | Promise<string> depending on
  // config. With our sync renderer it always returns string.
  const rendered = localMarked.parse(text) as string;
  // Trim trailing newlines that marked adds (avoids double-spacing)
  return rendered.replace(/\n+$/, "");
}

/**
 * Check if text looks like it contains markdown formatting.
 * Used to decide whether rendering would add value — plain text
 * doesn't benefit from being passed through the renderer.
 */
export function looksLikeMarkdown(text: string): boolean {
  // Require a strong signal that this is markdown rather than plain text.
  // Weak patterns like bold (**word**) or list bullets (- item) match
  // too many false positives (git branch output, log lines, etc.).
  return (
    /^#{1,6}\s/m.test(text) || // headings (strong signal)
    /```[\s\S]*?```/m.test(text) || // code fences (strong signal)
    /^\|\s*.+\s*\|\s*.+\s*\|/m.test(text) || // table rows (strong signal)
    /^\s*\d+\.\s/m.test(text) // ordered lists (moderate signal)
  );
}

// ── File Link Post-Processor ─────────────────────────────────────────
//
// Converts [[file:path]] markers in LLM output into clickable OSC 8
// terminal hyperlinks. The LLM is instructed (via system message) to
// use this format when summarising produced files.

/** Regex to match [[file:path]] markers in LLM output. */
const FILE_LINK_RE = /\[\[file:([^\]]+)\]\]/g;

/** Callback to register a produced file and get its reference number. */
export type FileTracker = (absPath: string, label: string) => number;

/**
 * Replace [[file:path]] markers with numbered references and absolute
 * paths. Registers each file via the tracker callback for later
 * retrieval via `/files` and `/open` commands.
 *
 * @param text - Rendered text (post-markdown or raw)
 * @param baseDir - Absolute path to the fs-write base directory
 * @param trackFile - Callback to register file and get its index
 * @returns Text with [[file:]] markers replaced
 */
export function linkifyFiles(
  text: string,
  baseDir: string | null,
  trackFile?: FileTracker,
): string {
  if (!baseDir) return text.replaceAll(FILE_LINK_RE, "$1");
  return text.replaceAll(FILE_LINK_RE, (_match, relPath: string) => {
    const trimmed = relPath.trim();
    const absPath = resolve(baseDir, trimmed);
    if (trackFile) {
      const idx = trackFile(absPath, trimmed);
      return `${absPath} [${idx}]`;
    }
    return absPath;
  });
}
