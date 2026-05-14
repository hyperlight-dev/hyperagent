// ── agent/skill-loader.ts — SKILL.md parser ─────────────────────────
//
// Loads skill definitions from skills/<name>/SKILL.md files.
// Parses the YAML frontmatter for suggest_approach fields:
// triggers, patterns, antiPatterns.
//
// The SDK loads SKILL.md content for conversation injection.
// This loader extracts the structured metadata for intent matching
// and pattern resolution.
//

// ─────────────────────────────────────────────────────────────────────

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ── Types ────────────────────────────────────────────────────────────

/** A parsed skill definition. */
export interface Skill {
  /** Skill name (directory name, e.g. "pptx-expert"). */
  name: string;
  /** One-line description. */
  description: string;
  /** Keyword triggers for intent matching (e.g. ["presentation", "PPTX", "slides"]). */
  triggers: string[];
  /** Pattern names this skill references (e.g. ["two-handler-pipeline", "image-embed"]). */
  patterns: string[];
  /** Things the LLM must NOT do. */
  antiPatterns: string[];
  /** MCP server names this skill requires (e.g. ["fabric-rti-mcp"]). */
  requiresMcp: string[];
  /** The markdown body — domain-specific guidance text. */
  guidance: string;
}

// ── YAML Frontmatter Parser ──────────────────────────────────────────

/**
 * Parse simple YAML frontmatter between --- delimiters.
 * Handles string, string[], and common frontmatter fields.
 */
function parseFrontmatter(content: string): {
  meta: Record<string, unknown>;
  body: string;
} {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") {
    return { meta: {}, body: content };
  }

  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    return { meta: {}, body: content };
  }

  const meta: Record<string, unknown> = {};
  let currentKey = "";
  let currentList: string[] | null = null;

  for (let i = 1; i < endIdx; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) continue;

    // List item
    if (/^\s+-\s+/.test(line) && currentList !== null) {
      const value = trimmed.replace(/^-\s+/, "").trim();
      currentList.push(value);
      continue;
    }

    // Save previous list
    if (currentList !== null && currentKey) {
      meta[currentKey] = currentList;
      currentList = null;
    }

    // Key: value
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const rawValue = trimmed.slice(colonIdx + 1).trim();
    currentKey = key;

    if (!rawValue) {
      currentList = [];
      continue;
    }

    // Inline array: [a, b, c]
    if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      const inner = rawValue.slice(1, -1);
      meta[key] = inner
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      continue;
    }

    // String (strip quotes)
    meta[key] = rawValue.replace(/^["']|["']$/g, "");
  }

  if (currentList !== null && currentKey) {
    meta[currentKey] = currentList;
  }

  const body = lines
    .slice(endIdx + 1)
    .join("\n")
    .trim();
  return { meta, body };
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Load all skills from a directory.
 * Each subdirectory should contain a SKILL.md file.
 *
 * @param dir - Path to skills directory (e.g. "./skills")
 * @returns Map of skill name → Skill
 */
export function loadSkills(dir: string): Map<string, Skill> {
  const skills = new Map<string, Skill>();

  if (!existsSync(dir)) return skills;

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillFile = join(dir, entry.name, "SKILL.md");
    if (!existsSync(skillFile)) continue;

    const content = readFileSync(skillFile, "utf-8");
    const { meta, body } = parseFrontmatter(content);

    const name = (meta.name as string) || entry.name;
    const description = (meta.description as string) || "";

    const triggers = Array.isArray(meta.triggers)
      ? (meta.triggers as string[])
      : [];
    const patterns = Array.isArray(meta.patterns)
      ? (meta.patterns as string[])
      : [];
    const antiPatterns = Array.isArray(meta.antiPatterns)
      ? (meta.antiPatterns as string[])
      : [];
    const requiresMcp = Array.isArray(meta["requires-mcp"])
      ? (meta["requires-mcp"] as string[])
      : [];

    skills.set(name, {
      name,
      description,
      triggers,
      patterns,
      antiPatterns,
      requiresMcp,
      guidance: body,
    });
  }

  return skills;
}
