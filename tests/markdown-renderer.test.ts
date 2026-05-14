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

  it("trims trailing newlines", () => {
    const out = renderMarkdown("hello\n\n");
    expect(out.endsWith("\n")).toBe(false);
  });

  it("handles empty input", () => {
    expect(renderMarkdown("")).toBe("");
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
