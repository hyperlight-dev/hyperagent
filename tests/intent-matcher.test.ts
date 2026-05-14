import { describe, it, expect } from "vitest";
import { matchIntent, type SkillMatch } from "../src/agent/intent-matcher.js";
import type { Skill } from "../src/agent/skill-loader.js";
import { loadSkills } from "../src/agent/skill-loader.js";
import { join } from "path";

function makeSkill(
  name: string,
  triggers: string[],
  patterns: string[] = [],
): Skill {
  return {
    name,
    description: `Test skill: ${name}`,
    triggers,
    patterns,
    antiPatterns: [],
    requiresMcp: [],
    guidance: "",
  };
}

const TEST_SKILLS = new Map<string, Skill>([
  [
    "pptx-expert",
    makeSkill("pptx-expert", [
      "presentation",
      "PPTX",
      "slides",
      "deck",
      "PowerPoint",
    ]),
  ],
  [
    "web-scraper",
    makeSkill("web-scraper", [
      "scrape",
      "extract",
      "crawl",
      "website",
      "HTML",
      "parse",
    ]),
  ],
  [
    "data-processor",
    makeSkill("data-processor", [
      "CSV",
      "JSON",
      "transform",
      "convert",
      "process",
      "filter",
    ]),
  ],
  [
    "report-builder",
    makeSkill("report-builder", ["report", "document", "generate", "summary"]),
  ],
]);

describe("intent-matcher", () => {
  it("should match exact trigger word", () => {
    const matches = matchIntent("Make a PPTX about AI", TEST_SKILLS);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].name).toBe("pptx-expert");
    expect(matches[0].matchedTriggers).toContain("PPTX");
  });

  it("should match case-insensitively", () => {
    const matches = matchIntent("create a powerpoint deck", TEST_SKILLS);
    expect(matches[0].name).toBe("pptx-expert");
    expect(matches[0].score).toBeGreaterThanOrEqual(2); // deck + PowerPoint
  });

  it("should match multiple skills", () => {
    const matches = matchIntent(
      "scrape a website and generate a report",
      TEST_SKILLS,
    );
    expect(matches.length).toBeGreaterThanOrEqual(2);
    const names = matches.map((m) => m.name);
    expect(names).toContain("web-scraper");
    expect(names).toContain("report-builder");
  });

  it("should return no matches for unrelated input", () => {
    const matches = matchIntent("what is 2 + 2?", TEST_SKILLS);
    expect(matches.length).toBe(0);
  });

  it("should rank by score (most matching triggers first)", () => {
    const matches = matchIntent(
      "Create a presentation with slides as a PowerPoint deck",
      TEST_SKILLS,
    );
    expect(matches[0].name).toBe("pptx-expert");
    expect(matches[0].score).toBeGreaterThanOrEqual(3);
  });

  it("should handle empty intent", () => {
    const matches = matchIntent("", TEST_SKILLS);
    expect(matches.length).toBe(0);
  });

  it("should handle skills with no triggers", () => {
    const skills = new Map<string, Skill>([
      ["empty-triggers", makeSkill("empty-triggers", [])],
    ]);
    const matches = matchIntent("anything", skills);
    expect(matches.length).toBe(0);
  });

  it("should match substring triggers in intent", () => {
    const matches = matchIntent(
      "I need to parse some HTML from a webpage",
      TEST_SKILLS,
    );
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].name).toBe("web-scraper");
  });

  it("should handle data processing intent", () => {
    const matches = matchIntent(
      "transform this JSON data and filter the results",
      TEST_SKILLS,
    );
    expect(matches[0].name).toBe("data-processor");
    expect(matches[0].score).toBeGreaterThanOrEqual(2);
  });
});

// ── Real-world intent matching against loaded skills ────────────────
//
// These tests use the actual skill definitions from skills/ to ensure
// that prompts match the correct skill. This catches regressions from
// accidentally adding overly-generic triggers.
//
// ─────────────────────────────────────────────────────────────────────

const SKILLS_DIR = join(import.meta.dirname, "..", "skills");
const realSkills = loadSkills(SKILLS_DIR);

/**
 * Assert that the given prompt matches the expected skill as the top result.
 * If expectedSkill is null, asserts no skill matches at all.
 */
function expectTopMatch(prompt: string, expectedSkill: string | null): void {
  const matches = matchIntent(prompt, realSkills);
  if (expectedSkill === null) {
    expect(
      matches.length,
      `Expected no match for: "${prompt}" but got: ${matches.map((m) => m.name).join(", ")}`,
    ).toBe(0);
  } else {
    expect(
      matches.length,
      `Expected "${expectedSkill}" for: "${prompt}" but got no matches`,
    ).toBeGreaterThan(0);
    expect(
      matches[0].name,
      `Expected "${expectedSkill}" but got "${matches[0].name}" (triggers: ${matches[0].matchedTriggers.join(", ")}) for: "${prompt}"`,
    ).toBe(expectedSkill);
  }
}

describe("intent-matcher — real-world skill matching", () => {
  describe("kql-expert", () => {
    it.each([
      "Query my ADX cluster for failed requests in the last 24 hours",
      "Write a KQL query to detect anomalies in telemetry data",
      "Analyze Application Insights logs for error spikes",
      "Use Kusto to find the top 10 users by request count",
      "Show me the Eventhouse table schema",
    ])("should match: %s", (prompt) => {
      expectTopMatch(prompt, "kql-expert");
    });
  });

  describe("data-processor", () => {
    it.each([
      "Convert this CSV to JSON",
      "Parse the CSV file and transform the data",
      "Build an ETL pipeline for tabular data",
    ])("should match: %s", (prompt) => {
      expectTopMatch(prompt, "data-processor");
    });
  });

  describe("api-explorer", () => {
    it.each([
      "Test the REST API endpoint for user creation",
      "Check the swagger docs for the GraphQL API",
    ])("should match: %s", (prompt) => {
      expectTopMatch(prompt, "api-explorer");
    });
  });

  describe("pdf-expert", () => {
    it.each([
      "Create a PDF invoice from this data",
      "Generate a PDF report with charts",
    ])("should match: %s", (prompt) => {
      expectTopMatch(prompt, "pdf-expert");
    });
  });

  describe("report-builder", () => {
    it.each([
      "Write a report on Q3 sales performance",
      "Generate a DOCX executive summary",
    ])("should match: %s", (prompt) => {
      expectTopMatch(prompt, "report-builder");
    });
  });

  describe("pptx-expert", () => {
    it.each([
      "Create a PowerPoint presentation about AI",
      "Build a slide deck for the board meeting",
    ])("should match: %s", (prompt) => {
      expectTopMatch(prompt, "pptx-expert");
    });
  });

  describe("web-scraper", () => {
    it.each([
      "Scrape the website for product prices",
      "Crawl this URL and extract the article text",
    ])("should match: %s", (prompt) => {
      expectTopMatch(prompt, "web-scraper");
    });
  });

  describe("mcp-services", () => {
    it.each([
      "Check my Teams messages from today",
      "Search SharePoint for the project plan",
    ])("should match: %s", (prompt) => {
      expectTopMatch(prompt, "mcp-services");
    });
  });

  describe("research-synthesiser", () => {
    it.each(["Do a deep dive competitive analysis of cloud providers"])(
      "should match: %s",
      (prompt) => {
        expectTopMatch(prompt, "research-synthesiser");
      },
    );
  });

  describe("xlsx-expert", () => {
    it.each(["Create an Excel spreadsheet with pivot tables"])(
      "should match: %s",
      (prompt) => {
        expectTopMatch(prompt, "xlsx-expert");
      },
    );
  });

  describe("no false positives from generic terms", () => {
    it("'sort the results by name' should not match data-processor", () => {
      const matches = matchIntent("sort the results by name", realSkills);
      const dp = matches.find((m) => m.name === "data-processor");
      expect(
        dp,
        "data-processor should not match generic 'sort' — triggers should be specific",
      ).toBeUndefined();
    });

    it("'analyze this data and filter it' should not match data-processor", () => {
      const matches = matchIntent(
        "analyze this data and filter it",
        realSkills,
      );
      const dp = matches.find((m) => m.name === "data-processor");
      expect(
        dp,
        "data-processor should not match generic 'analyze'/'data'/'filter'",
      ).toBeUndefined();
    });

    it("'parse the error message' should not match web-scraper", () => {
      const matches = matchIntent("parse the error message", realSkills);
      const ws = matches.find((m) => m.name === "web-scraper");
      expect(
        ws,
        "web-scraper should not match generic 'parse'",
      ).toBeUndefined();
    });

    it("'write a summary document' should not match report-builder", () => {
      const matches = matchIntent("write a summary document", realSkills);
      const rb = matches.find((m) => m.name === "report-builder");
      expect(
        rb,
        "report-builder should not match generic 'write'/'summary'/'document'",
      ).toBeUndefined();
    });

    it("'send an email about the meeting tasks' should match mcp-services via Mail", () => {
      // "email" contains "mail" which matches the M365 Mail trigger — this is correct behaviour
      const matches = matchIntent(
        "send an email about the meeting tasks",
        realSkills,
      );
      const mcp = matches.find((m) => m.name === "mcp-services");
      expect(
        mcp,
        "mcp-services should match 'email' via the Mail trigger",
      ).toBeDefined();
    });
  });
});
