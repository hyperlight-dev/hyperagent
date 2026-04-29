import { describe, it, expect } from "vitest";
import {
  extractSuggestedCommands,
  ACTIONABLE_COMMAND_PREFIXES,
} from "../src/agent/command-suggestions.js";

// ── extractSuggestedCommands ─────────────────────────────────────────

describe("extractSuggestedCommands", () => {
  // ── Backtick-wrapped commands ────────────────────────────────

  it("should extract a backtick-wrapped /plugin enable command", () => {
    const text =
      "Try running `/plugin enable fetch allowedContentTypes=[application/json,text/html]`";
    const result = extractSuggestedCommands(text);
    expect(result).toEqual([
      "/plugin enable fetch allowedContentTypes=[application/json,text/html]",
    ]);
  });

  it("should extract a backtick-wrapped /plugin disable command", () => {
    const text = "Run: `/plugin disable fetch`";
    expect(extractSuggestedCommands(text)).toEqual(["/plugin disable fetch"]);
  });

  it("should extract a backtick-wrapped /buffer command", () => {
    const text = "Increase it with `/buffer output 128`";
    expect(extractSuggestedCommands(text)).toEqual(["/buffer output 128"]);
  });

  it("should extract a backtick-wrapped /timeout command", () => {
    const text = "Set with `/timeout cpu 5000`";
    expect(extractSuggestedCommands(text)).toEqual(["/timeout cpu 5000"]);
  });

  it("should extract a backtick-wrapped /set command", () => {
    const text = "Configure with `/set heap 16`";
    expect(extractSuggestedCommands(text)).toEqual(["/set heap 16"]);
  });

  // ── Markdown-emphasised commands ────────────────────────────

  it("should extract a bold /mcp enable command", () => {
    const text = [
      "The Microsoft Teams MCP server requires authentication.",
      "",
      "**/mcp enable work-iq-teams**",
      "",
      "This will prompt you to authenticate in your browser.",
    ].join("\n");

    expect(extractSuggestedCommands(text)).toEqual([
      "/mcp enable work-iq-teams",
    ]);
  });

  it("should extract an inline bold /mcp enable command", () => {
    const text = "Please run **/mcp enable work-iq-teams** to authenticate.";

    expect(extractSuggestedCommands(text)).toEqual([
      "/mcp enable work-iq-teams",
    ]);
  });

  it("should preserve wildcard arguments in bold commands", () => {
    const text =
      "Run **/plugin enable fetch allowedDomains=[*.bbc.co.uk,feeds.bbci.co.uk]**";

    expect(extractSuggestedCommands(text)).toEqual([
      "/plugin enable fetch allowedDomains=[*.bbc.co.uk,feeds.bbci.co.uk]",
    ]);
  });

  // ── Bare commands on their own line ──────────────────────────

  it("should extract a bare /plugin enable on its own line", () => {
    const text = [
      "To fix this, run:",
      "",
      "  /plugin enable fetch allowedContentTypes=[application/json,text/html]",
      "",
      "Then try again.",
    ].join("\n");
    expect(extractSuggestedCommands(text)).toEqual([
      "/plugin enable fetch allowedContentTypes=[application/json,text/html]",
    ]);
  });

  it("should extract a bare /buffer command on its own line", () => {
    const text = "Try:\n  /buffer output 256\nThat should fix it.";
    expect(extractSuggestedCommands(text)).toEqual(["/buffer output 256"]);
  });

  // ── Multiple commands ────────────────────────────────────────

  it("should extract multiple different commands", () => {
    const text = [
      "You need to:",
      "1. `/plugin enable fetch allowedContentTypes=[text/html]`",
      "2. `/buffer output 128`",
    ].join("\n");
    const result = extractSuggestedCommands(text);
    expect(result).toEqual([
      "/plugin enable fetch allowedContentTypes=[text/html]",
      "/buffer output 128",
    ]);
  });

  // ── Deduplication ────────────────────────────────────────────

  it("should deduplicate identical commands", () => {
    const text = [
      "Run `/plugin enable fetch allowPost=true`",
      "",
      "  /plugin enable fetch allowPost=true",
    ].join("\n");
    expect(extractSuggestedCommands(text)).toEqual([
      "/plugin enable fetch allowPost=true",
    ]);
  });

  // ── Non-actionable commands ignored ──────────────────────────

  it("should NOT extract /exit commands", () => {
    const text = "Type `/exit` to quit.";
    expect(extractSuggestedCommands(text)).toEqual([]);
  });

  it("should NOT extract /help commands", () => {
    const text = "Run `/help` for more info.";
    expect(extractSuggestedCommands(text)).toEqual([]);
  });

  it("should NOT extract /new or /clear commands", () => {
    const text = "Try `/new` to start fresh or `/clear`.";
    expect(extractSuggestedCommands(text)).toEqual([]);
  });

  it("should NOT extract /sessions or /resume", () => {
    const text = "Use `/sessions` to list or `/resume abc`";
    expect(extractSuggestedCommands(text)).toEqual([]);
  });

  it("should NOT extract /models or /model", () => {
    const text = "`/models` shows available, `/model gpt-4o` to switch";
    expect(extractSuggestedCommands(text)).toEqual([]);
  });

  // ── Edge cases ───────────────────────────────────────────────

  it("should return empty for text with no commands", () => {
    const text = "The server returned a 404 error. Try a different URL.";
    expect(extractSuggestedCommands(text)).toEqual([]);
  });

  it("should return empty for empty string", () => {
    expect(extractSuggestedCommands("")).toEqual([]);
  });

  it("should strip trailing markdown from bare commands", () => {
    const text = "  /plugin enable fetch allowPost=true**";
    expect(extractSuggestedCommands(text)).toEqual([
      "/plugin enable fetch allowPost=true",
    ]);
  });

  it("should handle the full BBC example from the user report", () => {
    const text = [
      "Both attempts came back empty. This is almost certainly the content type restriction.",
      "",
      "To fix this, run this command:",
      "",
      "  /plugin enable fetch allowedContentTypes=[application/json,text/plain,text/html,application/rss+xml]",
      "",
      "That will allow HTML pages and RSS feeds.",
    ].join("\n");
    expect(extractSuggestedCommands(text)).toEqual([
      "/plugin enable fetch allowedContentTypes=[application/json,text/plain,text/html,application/rss+xml]",
    ]);
  });

  it("should handle mixed backtick and bare commands", () => {
    const text = [
      "First enable HTML: `/plugin enable fetch allowedContentTypes=[text/html]`",
      "Then increase the buffer:",
      "  /buffer output 128",
    ].join("\n");
    const result = extractSuggestedCommands(text);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain("/plugin enable fetch");
    expect(result[1]).toBe("/buffer output 128");
  });

  it("should handle the BBC redirect multi-option scenario", () => {
    const text = [
      "The BBC redirects its RSS feeds to feeds.bbci.co.uk, which is not in",
      "the allowlist. There are two ways to fix this — pick one:",
      "",
      "Option A — add the feeds subdomain to the allowlist:",
      "",
      "  /plugin enable fetch allowedDomains=[*.bbc.co.uk,feeds.bbci.co.uk]",
      "",
      "Option B — increase the max response size so the full BBC news page",
      "can load, then I will scrape headlines from the HTML:",
      "",
      "  /plugin enable fetch maxResponseSizeKb=1024",
    ].join("\n");
    const result = extractSuggestedCommands(text);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(
      "/plugin enable fetch allowedDomains=[*.bbc.co.uk,feeds.bbci.co.uk]",
    );
    expect(result[1]).toBe("/plugin enable fetch maxResponseSizeKb=1024");
  });

  it("should handle three options with different command types", () => {
    const text = [
      "Three ways to fix this:",
      "",
      "  /plugin enable fetch allowedContentTypes=[text/html,application/rss+xml]",
      "",
      "  /plugin enable fetch maxResponseSizeKb=2048",
      "",
      "  /buffer output 256",
    ].join("\n");
    const result = extractSuggestedCommands(text);
    expect(result).toHaveLength(3);
  });

  it("should be case-insensitive on prefix matching", () => {
    // LLM might capitalise weirdly
    const text = "  /Plugin Enable fetch allowPost=true";
    expect(extractSuggestedCommands(text)).toEqual([
      "/Plugin Enable fetch allowPost=true",
    ]);
  });

  // ── Placeholder filtering ────────────────────────────────

  it("should filter out commands containing example.com", () => {
    const text = "  /plugin enable fetch allowedDomains=[*.example.com]";
    expect(extractSuggestedCommands(text)).toEqual([]);
  });

  it("should filter out backtick-wrapped example.com commands", () => {
    const text = "like: `/plugin enable fetch allowedDomains=[*.example.com]`";
    expect(extractSuggestedCommands(text)).toEqual([]);
  });

  it("should filter out example.org and example.net too", () => {
    const text = [
      "  /plugin enable fetch allowedDomains=[*.example.org]",
      "  /plugin enable fetch allowedDomains=[*.example.net]",
    ].join("\n");
    expect(extractSuggestedCommands(text)).toEqual([]);
  });

  it("should filter out commands with <placeholder> values", () => {
    const text = "  /plugin enable fetch allowedDomains=<value>";
    expect(extractSuggestedCommands(text)).toEqual([]);
  });

  it("should keep real commands and filter only placeholder ones", () => {
    // The LLM suggests a real command AND gives an example — only
    // the real one should be extracted.
    const text = [
      "Run this:",
      "  /plugin enable fetch allowedDomains=[*.bbc.co.uk,*.bbc.com]",
      "",
      "Or for a different site, you would use something like:",
      "  /plugin enable fetch allowedDomains=[*.example.com]",
    ].join("\n");
    expect(extractSuggestedCommands(text)).toEqual([
      "/plugin enable fetch allowedDomains=[*.bbc.co.uk,*.bbc.com]",
    ]);
  });

  it("should reproduce the exact false-positive from the bug report", () => {
    // The LLM said the plugin is already enabled and gave an
    // illustrative example — should NOT be suggested.
    const text = [
      "The fetch plugin is actually already enabled in this session!",
      "",
      "If you want to change the configuration, type:",
      "",
      "  /plugin enable fetch allowedDomains=[*.example.com]",
      "",
      "What are you trying to fetch or do?",
    ].join("\n");
    expect(extractSuggestedCommands(text)).toEqual([]);
  });
});

// ── ACTIONABLE_COMMAND_PREFIXES ──────────────────────────────────────

describe("ACTIONABLE_COMMAND_PREFIXES", () => {
  it("should include plugin enable and disable", () => {
    expect(ACTIONABLE_COMMAND_PREFIXES).toContain("/plugin enable");
    expect(ACTIONABLE_COMMAND_PREFIXES).toContain("/plugin disable");
  });

  it("should include buffer, timeout, and set", () => {
    expect(ACTIONABLE_COMMAND_PREFIXES).toContain("/buffer ");
    expect(ACTIONABLE_COMMAND_PREFIXES).toContain("/timeout ");
    expect(ACTIONABLE_COMMAND_PREFIXES).toContain("/set ");
  });

  it("should NOT include navigation/destructive commands", () => {
    const prefixStarts = ACTIONABLE_COMMAND_PREFIXES.map(
      (p) => p.split(" ")[0],
    );
    expect(prefixStarts).not.toContain("/exit");
    expect(prefixStarts).not.toContain("/new");
    expect(prefixStarts).not.toContain("/clear");
    expect(prefixStarts).not.toContain("/help");
    expect(prefixStarts).not.toContain("/sessions");
    expect(prefixStarts).not.toContain("/resume");
    expect(prefixStarts).not.toContain("/models");
    expect(prefixStarts).not.toContain("/model");
  });
});
