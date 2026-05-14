// ── Skill Writer Tests ──────────────────────────────────────────────
//
// Covers validation, SKILL.md serialisation, and the persistence CRUD
// surface (writeUserSkill, listUserSkills, readUserSkill, deleteUserSkill,
// userSkillExists).
//
// Each test fixes HYPERAGENT_USER_SKILLS_DIR to a tmpdir so the real
// ~/.hyperagent/skills/ library is never touched.  Because skill-writer
// reads the env var at module load time, we re-import the module fresh
// inside each `beforeEach` after setting the env var.
// ─────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Module-under-test, re-imported per test so it reads the freshly set
 * `HYPERAGENT_USER_SKILLS_DIR` env var.  Vitest caches modules across
 * the file by default; `vi.resetModules()` plus a fresh dynamic import
 * gives each test a clean slate.
 */
type SkillWriter = typeof import("../src/agent/skill-writer.js");

let tempUserSkillsDir: string;
let tempPatternsDir: string;
let writer: SkillWriter;
let savedEnv: string | undefined;

beforeEach(async () => {
  tempUserSkillsDir = mkdtempSync(join(tmpdir(), "skill-writer-test-"));
  tempPatternsDir = mkdtempSync(join(tmpdir(), "skill-writer-patterns-"));
  // Seed a pattern so we can exercise pattern-reference validation.
  const patternDir = join(tempPatternsDir, "two-handler-pipeline");
  mkdirSync(patternDir, { recursive: true });
  writeFileSync(
    join(patternDir, "PATTERN.md"),
    `---\nname: two-handler-pipeline\ndescription: Test pattern\nmodules: []\nheapMb: 256\ncpuTimeoutMs: 10000\nwallTimeoutMs: 30000\n---\nBody.\n`,
    "utf-8",
  );

  savedEnv = process.env.HYPERAGENT_USER_SKILLS_DIR;
  process.env.HYPERAGENT_USER_SKILLS_DIR = tempUserSkillsDir;
  // Reset module cache so the constants re-evaluate against the env var.
  vi.resetModules();
  writer = await import("../src/agent/skill-writer.js");
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.HYPERAGENT_USER_SKILLS_DIR;
  else process.env.HYPERAGENT_USER_SKILLS_DIR = savedEnv;
  rmSync(tempUserSkillsDir, { recursive: true, force: true });
  rmSync(tempPatternsDir, { recursive: true, force: true });
});

// ── validateSkillName ────────────────────────────────────────────────

describe("validateSkillName", () => {
  it("accepts kebab-case names", () => {
    expect(writer.validateSkillName("teams-transcript-finder")).toBeNull();
    expect(writer.validateSkillName("a")).toBeNull();
    expect(writer.validateSkillName("foo123")).toBeNull();
  });

  it("rejects empty names", () => {
    expect(writer.validateSkillName("")).toMatch(/empty/);
  });

  it("rejects names with uppercase, spaces, or symbols", () => {
    expect(writer.validateSkillName("Teams-Skill")).toMatch(/kebab|lowercase/i);
    expect(writer.validateSkillName("teams skill")).toMatch(/kebab|lowercase/i);
    expect(writer.validateSkillName("teams_skill")).toMatch(/kebab|lowercase/i);
  });

  it("rejects names with path traversal characters", () => {
    // The regex blocks these before the traversal check fires, but the
    // outcome we care about is "rejected".
    expect(writer.validateSkillName("../evil")).not.toBeNull();
    expect(writer.validateSkillName("foo/bar")).not.toBeNull();
    expect(writer.validateSkillName("foo\\bar")).not.toBeNull();
  });

  it("rejects names longer than 64 characters", () => {
    expect(writer.validateSkillName("a".repeat(65))).toMatch(/64/);
  });
});

// ── validateSkillData ────────────────────────────────────────────────

describe("validateSkillData", () => {
  const validData = () => ({
    name: "test-skill",
    description: "A test skill",
    triggers: ["test"],
    guidance: "Do the thing.",
    allowedTools: ["execute_javascript"],
  });

  it("accepts a minimal valid payload", () => {
    expect(writer.validateSkillData(validData(), new Set())).toBeNull();
  });

  it("rejects missing description", () => {
    const err = writer.validateSkillData(
      { ...validData(), description: "" },
      new Set(),
    );
    expect(err).toMatch(/description/);
  });

  it("rejects empty triggers", () => {
    const err = writer.validateSkillData(
      { ...validData(), triggers: [] },
      new Set(),
    );
    expect(err).toMatch(/trigger/);
  });

  it("rejects empty allowedTools", () => {
    const err = writer.validateSkillData(
      { ...validData(), allowedTools: [] },
      new Set(),
    );
    expect(err).toMatch(/allowed-tool/);
  });

  it("rejects unknown tools", () => {
    const err = writer.validateSkillData(
      { ...validData(), allowedTools: ["nuclear_launch"] },
      new Set(),
    );
    expect(err).toMatch(/nuclear_launch/);
  });

  it("rejects descriptions over 280 chars", () => {
    const err = writer.validateSkillData(
      { ...validData(), description: "x".repeat(281) },
      new Set(),
    );
    expect(err).toMatch(/280/);
  });

  it("rejects unknown pattern references", () => {
    const err = writer.validateSkillData(
      { ...validData(), patterns: ["not-real"] },
      new Set(["two-handler-pipeline"]),
    );
    expect(err).toMatch(/not-real/);
  });

  it("accepts known pattern references", () => {
    expect(
      writer.validateSkillData(
        { ...validData(), patterns: ["two-handler-pipeline"] },
        new Set(["two-handler-pipeline"]),
      ),
    ).toBeNull();
  });
});

// ── renderSkillMarkdown ──────────────────────────────────────────────

describe("renderSkillMarkdown", () => {
  it("emits all required fields", () => {
    const md = writer.renderSkillMarkdown({
      name: "demo",
      description: "Demo skill",
      triggers: ["demo", "example"],
      guidance: "Run the demo.",
      allowedTools: ["execute_javascript"],
    });
    expect(md).toMatch(/^---\n/);
    expect(md).toMatch(/name: demo\n/);
    expect(md).toMatch(/description: Demo skill\n/);
    expect(md).toMatch(/triggers:\n {2}- demo\n {2}- example\n/);
    expect(md).toMatch(/allowed-tools:\n {2}- execute_javascript\n/);
    expect(md).toMatch(/\n---\n\nRun the demo\.\n$/);
  });

  it("omits optional sections when empty", () => {
    const md = writer.renderSkillMarkdown({
      name: "demo",
      description: "Demo skill",
      triggers: ["demo"],
      guidance: "Body.",
      allowedTools: ["execute_javascript"],
    });
    expect(md).not.toMatch(/patterns:/);
    expect(md).not.toMatch(/antiPatterns:/);
    expect(md).not.toMatch(/requires-mcp:/);
  });

  it("includes optional sections when present", () => {
    const md = writer.renderSkillMarkdown({
      name: "demo",
      description: "Demo skill",
      triggers: ["demo"],
      guidance: "Body.",
      patterns: ["two-handler-pipeline"],
      antiPatterns: ["Do not delete production data"],
      requiresMcp: ["workiq"],
      allowedTools: ["execute_javascript"],
    });
    expect(md).toMatch(/patterns:\n {2}- two-handler-pipeline\n/);
    expect(md).toMatch(/antiPatterns:\n {2}- Do not delete production data\n/);
    expect(md).toMatch(/requires-mcp:\n {2}- workiq\n/);
  });
});

// ── writeUserSkill + CRUD round-trip ─────────────────────────────────

describe("writeUserSkill / listUserSkills / readUserSkill / deleteUserSkill", () => {
  it("persists a skill to disk and round-trips through list/read", () => {
    const filePath = writer.writeUserSkill(
      {
        name: "round-trip",
        description: "Round trip test",
        triggers: ["round"],
        guidance: "Do round trips.",
        allowedTools: ["execute_javascript"],
      },
      tempPatternsDir,
    );
    expect(filePath).toContain("round-trip");
    expect(filePath).toMatch(/SKILL\.md$/);

    expect(writer.userSkillExists("round-trip")).toBe(true);
    const listed = writer.listUserSkills();
    expect(listed).toHaveLength(1);
    expect(listed[0].name).toBe("round-trip");
    expect(listed[0].sizeBytes).toBeGreaterThan(0);

    const content = writer.readUserSkill("round-trip");
    expect(content).not.toBeNull();
    expect(content).toMatch(/name: round-trip/);
    expect(content).toMatch(/Do round trips\./);
  });

  it("listUserSkills returns names sorted alphabetically", () => {
    for (const name of ["zebra", "alpha", "mike"]) {
      writer.writeUserSkill(
        {
          name,
          description: "x",
          triggers: ["x"],
          guidance: "x",
          allowedTools: ["execute_javascript"],
        },
        tempPatternsDir,
      );
    }
    expect(writer.listUserSkills().map((s) => s.name)).toEqual([
      "alpha",
      "mike",
      "zebra",
    ]);
  });

  it("deleteUserSkill removes the directory and marks skill absent", () => {
    writer.writeUserSkill(
      {
        name: "doomed",
        description: "x",
        triggers: ["x"],
        guidance: "x",
        allowedTools: ["execute_javascript"],
      },
      tempPatternsDir,
    );
    expect(writer.userSkillExists("doomed")).toBe(true);
    writer.deleteUserSkill("doomed");
    expect(writer.userSkillExists("doomed")).toBe(false);
    expect(writer.readUserSkill("doomed")).toBeNull();
  });

  it("rejects invalid skill names before writing anything", () => {
    expect(() =>
      writer.writeUserSkill(
        {
          name: "Bad Name",
          description: "x",
          triggers: ["x"],
          guidance: "x",
          allowedTools: ["execute_javascript"],
        },
        tempPatternsDir,
      ),
    ).toThrow(/validation/i);
    expect(writer.listUserSkills()).toEqual([]);
  });

  it("rejects unknown pattern references against the patterns dir", () => {
    expect(() =>
      writer.writeUserSkill(
        {
          name: "bad-pattern",
          description: "x",
          triggers: ["x"],
          guidance: "x",
          allowedTools: ["execute_javascript"],
          patterns: ["not-a-real-pattern"],
        },
        tempPatternsDir,
      ),
    ).toThrow(/not-a-real-pattern/);
  });
});
