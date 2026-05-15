// ── Markdown Renderer Tests ────────────────────────────────────────
//
// These tests exist primarily to detect *module-load crashes* in
// `markdown-renderer.ts`.  The module wires `marked` + `marked-terminal`
// at import time and any incompatibility between the two pinned versions
// will throw on first require — long before any test exercises the
// rendered output.
//
// Regression: in marked v15 + marked-terminal v7, passing a
// `TerminalRenderer` *instance* via `new Marked({ renderer })` throws
// "renderer 'o' does not exist" because marked enumerates every key on
// the renderer object and the legacy `Renderer` constructor stores
// config as own properties (`this.o`, `this.tab`, …).  The fix is to
// use the `markedTerminal()` factory which returns a clean
// `MarkedExtension`.  These tests would have caught that bug.
//
// ────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import {
  renderMarkdown,
  looksLikeMarkdown,
} from "../src/agent/markdown-renderer.js";

describe("renderMarkdown", () => {
  it("renders plain text without crashing", () => {
    // The smoke test that matters most — if module init fails this
    // throws before reaching the assertion.
    const out = renderMarkdown("hello world");
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  it("renders headings, code, lists and code fences", () => {
    const md = [
      "# Title",
      "",
      "**bold** and `inline code`",
      "",
      "- one",
      "- two",
      "",
      "```js",
      "const x = 1;",
      "```",
    ].join("\n");

    const out = renderMarkdown(md);

    // We don't assert on ANSI codes (they vary by terminal capability)
    // — just that the meaningful content survived rendering.
    expect(out).toContain("Title");
    expect(out).toContain("bold");
    expect(out).toContain("inline code");
    expect(out).toContain("one");
    expect(out).toContain("two");
    expect(out).toContain("const x = 1");
  });

  it("strips inline markdown markers from list items (regression: marked-terminal v7 + marked v15)", () => {
    // Regression: marked-terminal's stock `text` renderer reads the
    // raw `token.text` instead of recursing into inline tokens.  For
    // tight list items (where the body is a `text`-type block token,
    // not a `paragraph`), this leaks `**bold**` / `*em*` / `` `code` ``
    // markers verbatim to the terminal.  The user-visible symptom is
    // skill greetings, /help output, and any LLM response containing
    // a bulleted list rendering with literal asterisks on screen
    // despite the user opting in to markdown.
    //
    // We patch the `text` renderer in markdown-renderer.ts; this test
    // anchors the fix so it can't silently regress.  Asserting on the
    // ABSENCE of the markdown markers is the only check that catches
    // a no-op renderer (the earlier "contains 'bold'" assertion did
    // not — the raw `**bold**` also contains the substring "bold").
    const md = [
      "* **bold item** rest of line",
      "* normal item",
      "",
      "1. **numbered bold** with `inline code`",
      "2. plain",
    ].join("\n");
    const out = renderMarkdown(md);

    // Inline formatters must have consumed their markers.
    expect(out).not.toContain("**bold item**");
    expect(out).not.toContain("**numbered bold**");
    expect(out).not.toContain("`inline code`");

    // The semantic content survives.
    expect(out).toContain("bold item");
    expect(out).toContain("normal item");
    expect(out).toContain("numbered bold");
    expect(out).toContain("inline code");
    expect(out).toContain("plain");
  });

  it("trims trailing newlines", () => {
    const out = renderMarkdown("hello\n\n");
    expect(out.endsWith("\n")).toBe(false);
  });

  it("handles empty input", () => {
    expect(renderMarkdown("")).toBe("");
  });

  it("renders headings without a literal ### prefix (showSectionPrefix=false)", () => {
    // Regression: marked-terminal defaults `showSectionPrefix` to true,
    // which keeps the literal `### ` markers in front of every heading
    // ("### What I can do:") and makes users assume markdown rendering
    // is broken even when bold/colour ANSI is correctly applied.  We
    // pin the option to `false` in markdown-renderer.ts; if a future
    // edit flips it back, this test catches it.
    const md = ["# top", "", "## sub", "", "### deep", ""].join("\n");
    const out = renderMarkdown(md);

    // The heading TEXT must survive…
    expect(out).toContain("top");
    expect(out).toContain("sub");
    expect(out).toContain("deep");

    // …but the markdown markers themselves must be gone.
    expect(out).not.toContain("# top");
    expect(out).not.toContain("## sub");
    expect(out).not.toContain("### deep");
  });

  it("renders GFM tables with header and body cells", () => {
    // Regression: the profile-apply preview emits a markdown table so
    // the limit before/after grid is readable.  marked-terminal's
    // table renderer must produce output that contains all header and
    // body cell text — if a future marked-terminal upgrade silently
    // breaks the table extension, this anchors the fix.
    const md = [
      "| Limit | Before | After |",
      "|---|---|---|",
      "| cpu | 1000ms | 2000ms |",
      "| heap | 16MB | 32MB |",
    ].join("\n");
    const out = renderMarkdown(md);

    // Header cells survive
    expect(out).toContain("Limit");
    expect(out).toContain("Before");
    expect(out).toContain("After");

    // Body cells survive with their units
    expect(out).toContain("cpu");
    expect(out).toContain("1000ms");
    expect(out).toContain("2000ms");
    expect(out).toContain("heap");
    expect(out).toContain("16MB");
    expect(out).toContain("32MB");

    // The raw pipe-delimited header row must NOT leak through —
    // marked-terminal should have converted it into a box-drawing
    // table.  If we see "| Limit | Before |" verbatim, the table
    // extension is broken.
    expect(out).not.toContain("| Limit | Before | After |");
  });
});

describe("looksLikeMarkdown", () => {
  it("detects headings", () => {
    expect(looksLikeMarkdown("# Heading")).toBe(true);
    expect(looksLikeMarkdown("###### h6")).toBe(true);
  });

  it("detects fenced code blocks", () => {
    expect(looksLikeMarkdown("```js\nconst x = 1;\n```")).toBe(true);
  });

  it("detects tables", () => {
    expect(looksLikeMarkdown("| a | b |\n| - | - |\n| 1 | 2 |")).toBe(true);
  });

  it("detects ordered lists", () => {
    expect(looksLikeMarkdown("1. first\n2. second")).toBe(true);
  });

  it("rejects plain text and weak signals", () => {
    // Bold markers and unordered bullets alone are too noisy to count
    // as markdown (false positives on git output, log lines, etc.).
    expect(looksLikeMarkdown("just a sentence")).toBe(false);
    expect(looksLikeMarkdown("**not strong enough**")).toBe(false);
    expect(looksLikeMarkdown("- bullet alone")).toBe(false);
  });
});
