// ── Terminal Markdown Renderer ────────────────────────────────────────
//
// Renders markdown text as ANSI-formatted terminal output using
// marked + marked-terminal. Used when markdown mode is enabled (default)
// to make LLM output readable instead of raw markdown syntax.
//
// Usage:
//   import { renderMarkdown } from "./markdown-renderer.js";
//   console.log(renderMarkdown("# Hello\n**bold** and `code`"));

import { Marked, type MarkedOptions } from "marked";
import TerminalRenderer from "marked-terminal";
import { resolve } from "node:path";

// Use a local Marked instance so we don't mutate the global marked
// singleton — other code importing marked won't accidentally get
// terminal-rendered output instead of HTML.
const terminalRenderer = new TerminalRenderer({
  // Indent code blocks for visual separation
  tab: 2,
  // Show URLs inline rather than as footnotes
  showSectionPrefix: true,
  // Convert HTML entities back to characters
  unescape: true,
});

// marked-terminal's renderer type doesn't match marked v15's _Renderer
// exactly, but it works at runtime. Cast to satisfy the type checker.
const localMarked = new Marked({
  renderer: terminalRenderer as unknown as MarkedOptions["renderer"],
});

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
