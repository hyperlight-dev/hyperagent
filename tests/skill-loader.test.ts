// ── Skill Loader Tests ──────────────────────────────────────────────
//
// Validates that loadSkills() correctly parses SKILL.md frontmatter,
// including the requires-mcp field.
//
// ─────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadSkills } from "../src/agent/skill-loader.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "skill-loader-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** Write a SKILL.md file inside tempDir/<name>/SKILL.md */
function writeSkill(name: string, content: string): void {
  const dir = join(tempDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), content, "utf-8");
}

describe("skill-loader", () => {
  describe("requires-mcp parsing", () => {
    it("should parse requires-mcp as string array", () => {
      writeSkill(
        "kql-expert",
        `---
name: kql-expert
description: KQL expertise
triggers:
  - KQL
  - Kusto
requires-mcp:
  - fabric-rti-mcp
---

# KQL Expert
Some guidance text.
`,
      );

      const skills = loadSkills(tempDir);
      const skill = skills.get("kql-expert");
      expect(skill).toBeDefined();
      expect(skill!.requiresMcp).toEqual(["fabric-rti-mcp"]);
    });

    it("should handle multiple requires-mcp entries", () => {
      writeSkill(
        "multi-mcp",
        `---
name: multi-mcp
description: Needs multiple MCP servers
requires-mcp:
  - fabric-rti-mcp
  - github-mcp
  - other-server
---

# Multi MCP Skill
`,
      );

      const skills = loadSkills(tempDir);
      const skill = skills.get("multi-mcp");
      expect(skill).toBeDefined();
      expect(skill!.requiresMcp).toEqual([
        "fabric-rti-mcp",
        "github-mcp",
        "other-server",
      ]);
    });

    it("should default to empty array when requires-mcp is absent", () => {
      writeSkill(
        "no-mcp",
        `---
name: no-mcp
description: No MCP needed
triggers:
  - something
---

# No MCP
`,
      );

      const skills = loadSkills(tempDir);
      const skill = skills.get("no-mcp");
      expect(skill).toBeDefined();
      expect(skill!.requiresMcp).toEqual([]);
    });

    it("should parse inline array format for requires-mcp", () => {
      writeSkill(
        "inline-mcp",
        `---
name: inline-mcp
description: Inline array
requires-mcp: [fabric-rti-mcp, github-mcp]
---

# Inline
`,
      );

      const skills = loadSkills(tempDir);
      const skill = skills.get("inline-mcp");
      expect(skill).toBeDefined();
      expect(skill!.requiresMcp).toEqual(["fabric-rti-mcp", "github-mcp"]);
    });
  });

  describe("basic frontmatter parsing", () => {
    it("should parse name, description, triggers, and patterns", () => {
      writeSkill(
        "test-skill",
        `---
name: test-skill
description: A test skill
triggers:
  - alpha
  - beta
patterns:
  - fetch-and-process
antiPatterns:
  - Don't do bad things
---

# Test Skill
Guidance body here.
`,
      );

      const skills = loadSkills(tempDir);
      const skill = skills.get("test-skill");
      expect(skill).toBeDefined();
      expect(skill!.name).toBe("test-skill");
      expect(skill!.description).toBe("A test skill");
      expect(skill!.triggers).toEqual(["alpha", "beta"]);
      expect(skill!.patterns).toEqual(["fetch-and-process"]);
      expect(skill!.antiPatterns).toEqual(["Don't do bad things"]);
      expect(skill!.guidance).toContain("# Test Skill");
      expect(skill!.guidance).toContain("Guidance body here.");
    });

    it("should use directory name when name field is absent", () => {
      writeSkill(
        "dir-name",
        `---
description: Unnamed skill
---

# Body
`,
      );

      const skills = loadSkills(tempDir);
      const skill = skills.get("dir-name");
      expect(skill).toBeDefined();
      expect(skill!.name).toBe("dir-name");
    });

    it("should return empty map for nonexistent directory", () => {
      const skills = loadSkills("/nonexistent/path/that/does/not/exist");
      expect(skills.size).toBe(0);
    });

    it("should skip directories without SKILL.md", () => {
      mkdirSync(join(tempDir, "empty-dir"), { recursive: true });
      const skills = loadSkills(tempDir);
      expect(skills.size).toBe(0);
    });
  });
});
