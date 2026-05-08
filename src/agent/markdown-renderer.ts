// ── Terminal Markdown Renderer ────────────────────────────────────────
//
// Renders markdown text as ANSI-formatted terminal output using
// marked + marked-terminal. Used when --markdown mode is enabled
// to make LLM output readable instead of raw markdown syntax.
//
// Usage:
//   import { renderMarkdown } from "./markdown-renderer.js";
//   console.log(renderMarkdown("# Hello\n**bold** and `code`"));

import { marked, type MarkedOptions } from "marked";
import TerminalRenderer from "marked-terminal";

// Configure marked with the terminal renderer once at import time.
// marked-terminal handles: headings, bold/italic, code blocks with
// syntax highlighting, lists, tables, links, blockquotes, and hr.
const renderer = new TerminalRenderer({
  // Indent code blocks for visual separation
  tab: 2,
  // Show URLs inline rather than as footnotes
  showSectionPrefix: true,
  // Use unicode bullets
  unescape: true,
});
// marked-terminal's renderer type doesn't match marked v15's _Renderer
// exactly, but it works at runtime. Cast to satisfy the type checker.
marked.setOptions({
  renderer: renderer as unknown as MarkedOptions["renderer"],
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
  // marked.parse() can return string | Promise<string> depending on
  // config. With our sync renderer it always returns string.
  const rendered = marked.parse(text) as string;
  // Trim trailing newlines that marked adds (avoids double-spacing)
  return rendered.replace(/\n+$/, "");
}

/**
 * Check if text looks like it contains markdown formatting.
 * Used to decide whether rendering would add value — plain text
 * doesn't benefit from being passed through the renderer.
 */
export function looksLikeMarkdown(text: string): boolean {
  // Quick heuristics — check for common markdown patterns
  return (
    /^#{1,6}\s/m.test(text) || // headings
    /\*\*[^*]+\*\*/m.test(text) || // bold
    /```[\s\S]*?```/m.test(text) || // code blocks
    /^\s*[-*+]\s/m.test(text) || // unordered lists
    /^\s*\d+\.\s/m.test(text) || // ordered lists
    /\|.*\|.*\|/m.test(text) // tables
  );
}
