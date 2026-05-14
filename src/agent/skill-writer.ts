// ── agent/skill-writer.ts — User skill persistence ──────────────────
//
// Validates and persists user-created skills to ~/.hyperagent/skills/.
// User skills follow the same SKILL.md format as built-in (system) skills
// — see skill-loader.ts for the parsed shape and .github/instructions/
// skills.instructions.md for authoring guidelines.
//
// User skills override system skills with the same name (see
// loadSkillsFromDirs in skill-loader.ts).
//
// ─────────────────────────────────────────────────────────────────────

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadPatterns } from "./pattern-loader.js";
import { ALLOWED_TOOLS } from "./tool-gating.js";

// ── Constants ────────────────────────────────────────────────────────

/**
 * Root directory for user-created skills.
 *
 * Defaults to `~/.hyperagent/skills/`.  The `HYPERAGENT_USER_SKILLS_DIR`
 * environment variable overrides the default — tests use this to point
 * at a temporary directory without polluting the real user library.
 */
const DEFAULT_USER_SKILLS_DIR =
  process.env.HYPERAGENT_USER_SKILLS_DIR ??
  join(homedir(), ".hyperagent", "skills");

/** Maximum total size of a SKILL.md file (frontmatter + body). */
const MAX_SKILL_SIZE_BYTES = 64 * 1024;

/** Maximum length of the description field. */
const MAX_DESCRIPTION_LENGTH = 280;

/** Maximum number of triggers per skill. */
const MAX_TRIGGERS = 50;

/** Kebab-case name pattern (lowercase letters, digits, hyphens). */
const VALID_NAME_RE = /^[a-z][a-z0-9-]*$/;

// ── Types ────────────────────────────────────────────────────────────

/** Input data for a new skill, mirroring SKILL.md frontmatter fields. */
export interface SkillData {
  /** Skill identifier (kebab-case, used as directory name). */
  name: string;
  /** One-line description shown in `/skill list`. */
  description: string;
  /** Keyword triggers for intent matching. */
  triggers: string[];
  /** Markdown body — domain knowledge, workflow steps, tips. */
  guidance: string;
  /** Optional list of built-in pattern names this skill references. */
  patterns?: string[];
  /** Optional list of "DO NOT" rules surfaced to the LLM first. */
  antiPatterns?: string[];
  /** Optional list of MCP server names required (e.g. ["fabric-rti-mcp"]). */
  requiresMcp?: string[];
  /** Tools this skill can invoke (must be a subset of ALLOWED_TOOLS). */
  allowedTools: string[];
}

/** Metadata about a stored user skill. */
export interface UserSkillInfo {
  /** Skill identifier. */
  name: string;
  /** Absolute path to the SKILL.md file. */
  filePath: string;
  /** ISO timestamp of last modification (file mtime). */
  modified: string;
  /** File size in bytes. */
  sizeBytes: number;
}

// ── Directory Helpers ────────────────────────────────────────────────

/**
 * Get (and create on first call) the user skills directory path.
 * The directory is created lazily so test environments can override
 * the path before the first call.
 */
export function getUserSkillsDir(): string {
  mkdirSync(DEFAULT_USER_SKILLS_DIR, { recursive: true });
  return DEFAULT_USER_SKILLS_DIR;
}

// ── Validation ───────────────────────────────────────────────────────

/**
 * Validate a skill name. Returns an error message string, or null if valid.
 *
 * Rules: kebab-case (lowercase letters, digits, hyphens; must start with a
 * letter), ≤64 characters, no path traversal characters.
 */
export function validateSkillName(name: string): string | null {
  if (!name) return "Skill name must not be empty";
  if (name.length > 64) return "Skill name must be ≤64 characters";
  if (!VALID_NAME_RE.test(name)) {
    return "Skill name must be lowercase letters, digits, and hyphens (e.g. 'teams-transcript', 'kql-expert')";
  }
  if (name.includes("..") || name.includes("/") || name.includes("\\")) {
    return "Skill name must not contain path traversal characters";
  }
  return null;
}

/**
 * Validate the structured fields of a skill payload.
 * Returns a combined error message string, or null when the payload is
 * well-formed.  Each individual problem is surfaced so the LLM (or user)
 * can fix them all at once instead of round-tripping for every issue.
 *
 * @param data - The skill payload to validate.
 * @param builtinPatternNames - Set of valid built-in pattern names. Used to
 *   validate `patterns[]` references. Pass an empty set to skip the check
 *   (only useful in tests).
 */
export function validateSkillData(
  data: SkillData,
  builtinPatternNames: Set<string>,
): string | null {
  const errors: string[] = [];

  const nameError = validateSkillName(data.name);
  if (nameError) errors.push(nameError);

  if (!data.description || data.description.trim().length === 0) {
    errors.push("Skill description must not be empty");
  } else if (data.description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push(
      `Skill description must be ≤${MAX_DESCRIPTION_LENGTH} characters`,
    );
  }

  if (!Array.isArray(data.triggers) || data.triggers.length === 0) {
    errors.push("Skill must have at least one trigger");
  } else if (data.triggers.length > MAX_TRIGGERS) {
    errors.push(`Skill must have ≤${MAX_TRIGGERS} triggers`);
  } else {
    for (const t of data.triggers) {
      if (typeof t !== "string" || t.trim().length === 0) {
        errors.push("Triggers must be non-empty strings");
        break;
      }
    }
  }

  if (!data.guidance || data.guidance.trim().length === 0) {
    errors.push("Skill guidance body must not be empty");
  }

  if (!Array.isArray(data.allowedTools) || data.allowedTools.length === 0) {
    errors.push("Skill must declare at least one allowed-tool");
  } else {
    for (const tool of data.allowedTools) {
      if (!ALLOWED_TOOLS.has(tool)) {
        errors.push(`Unknown tool in allowed-tools: '${tool}'`);
      }
    }
  }

  if (
    data.patterns &&
    data.patterns.length > 0 &&
    builtinPatternNames.size > 0
  ) {
    for (const p of data.patterns) {
      if (!builtinPatternNames.has(p)) {
        errors.push(
          `Unknown pattern: '${p}' (must reference a built-in pattern)`,
        );
      }
    }
  }

  return errors.length > 0 ? errors.join("; ") : null;
}

// ── Serialisation ────────────────────────────────────────────────────

/**
 * Render a SkillData payload to SKILL.md format (YAML frontmatter + body).
 *
 * The output is intentionally minimal — we only emit fields that are present
 * — so generated skills stay easy for humans to read and edit.
 */
export function renderSkillMarkdown(data: SkillData): string {
  const lines: string[] = ["---"];
  lines.push(`name: ${data.name}`);
  lines.push(`description: ${data.description.trim()}`);

  lines.push("triggers:");
  for (const t of data.triggers) lines.push(`  - ${t}`);

  if (data.patterns && data.patterns.length > 0) {
    lines.push("patterns:");
    for (const p of data.patterns) lines.push(`  - ${p}`);
  }

  if (data.antiPatterns && data.antiPatterns.length > 0) {
    lines.push("antiPatterns:");
    for (const a of data.antiPatterns) lines.push(`  - ${a}`);
  }

  if (data.requiresMcp && data.requiresMcp.length > 0) {
    lines.push("requires-mcp:");
    for (const m of data.requiresMcp) lines.push(`  - ${m}`);
  }

  lines.push("allowed-tools:");
  for (const tool of data.allowedTools) lines.push(`  - ${tool}`);

  lines.push("---", "");
  lines.push(data.guidance.trim(), "");

  return lines.join("\n");
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Persist a user skill to `~/.hyperagent/skills/<name>/SKILL.md`.
 *
 * Validates the payload (name, fields, pattern references, tool gating),
 * writes the SKILL.md, and returns the absolute path on success.
 *
 * @param data - The skill payload to persist.
 * @param patternsDir - Path to the built-in patterns directory; used to
 *   validate `patterns[]` references against real patterns on disk.
 * @returns The absolute path of the written SKILL.md file.
 * @throws Error if validation fails or the skill exceeds the size limit.
 */
export function writeUserSkill(data: SkillData, patternsDir: string): string {
  const builtinPatterns = loadPatterns(patternsDir);
  const validationError = validateSkillData(
    data,
    new Set(builtinPatterns.keys()),
  );
  if (validationError) {
    throw new Error(`Skill validation failed: ${validationError}`);
  }

  const rendered = renderSkillMarkdown(data);
  if (rendered.length > MAX_SKILL_SIZE_BYTES) {
    throw new Error(
      `SKILL.md exceeds maximum size (${rendered.length} bytes > ${MAX_SKILL_SIZE_BYTES} bytes)`,
    );
  }

  const userSkillsDir = getUserSkillsDir();
  const skillDir = join(userSkillsDir, data.name);
  mkdirSync(skillDir, { recursive: true });

  const filePath = join(skillDir, "SKILL.md");
  writeFileSync(filePath, rendered, "utf-8");
  return filePath;
}

/**
 * List all user skills currently stored on disk.
 *
 * @returns Sorted (by name) array of `UserSkillInfo` records.
 */
export function listUserSkills(): UserSkillInfo[] {
  const dir = getUserSkillsDir();
  if (!existsSync(dir)) return [];

  const entries = readdirSync(dir, { withFileTypes: true });
  const result: UserSkillInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const filePath = join(dir, entry.name, "SKILL.md");
    if (!existsSync(filePath)) continue;

    const stat = statSync(filePath);
    result.push({
      name: entry.name,
      filePath,
      modified: stat.mtime.toISOString(),
      sizeBytes: stat.size,
    });
  }

  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

/**
 * Read the raw SKILL.md contents for a user skill.
 *
 * @param name - Skill identifier.
 * @returns Full file contents, or null if the skill does not exist.
 */
export function readUserSkill(name: string): string | null {
  const nameError = validateSkillName(name);
  if (nameError) return null;

  const filePath = join(getUserSkillsDir(), name, "SKILL.md");
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, "utf-8");
}

/**
 * Delete a user skill directory (and its SKILL.md).
 *
 * @param name - Skill identifier.
 * @throws Error if the skill name is invalid or the skill does not exist.
 */
export function deleteUserSkill(name: string): void {
  const nameError = validateSkillName(name);
  if (nameError) throw new Error(nameError);

  const skillDir = join(getUserSkillsDir(), name);
  if (!existsSync(skillDir)) {
    throw new Error(`User skill not found: '${name}'`);
  }

  rmSync(skillDir, { recursive: true, force: true });
}

/**
 * Check whether a user skill with the given name exists.
 *
 * @param name - Skill identifier.
 */
export function userSkillExists(name: string): boolean {
  const nameError = validateSkillName(name);
  if (nameError) return false;
  return existsSync(join(getUserSkillsDir(), name, "SKILL.md"));
}
