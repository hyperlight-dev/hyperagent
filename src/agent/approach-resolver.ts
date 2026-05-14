// ── agent/approach-resolver.ts — Skill/pattern resolution + union ───
//
// Resolves matched skills to their patterns, unions all requirements,
// and returns a materialised guidance object for the LLM.
//
// ─────────────────────────────────────────────────────────────────────

import type { Skill } from "./skill-loader.js";
import type { Pattern } from "./pattern-loader.js";
import { matchIntent } from "./intent-matcher.js";
import { loadSkills } from "./skill-loader.js";
import { loadPatterns } from "./pattern-loader.js";
import { loadModule, type ModuleHints } from "./module-store.js";

// ── Types ────────────────────────────────────────────────────────────

/** Materialised guidance returned by suggest_approach. */
export interface MaterialisedGuidance {
  /** Which skills matched the intent. */
  matchedSkills: string[];
  /** Resource profiles to apply (union of all patterns). */
  profiles: string[];
  /** Config overrides — max of each numeric value. */
  config: Record<string, number>;
  /** ha:* modules to import (union). */
  modules: string[];
  /** host:* plugins to enable (union). */
  plugins: string[];
  /** MCP server names required by matched skills (union). */
  requiredMcp: string[];
  /** MCP server availability status (populated by caller with runtime state). */
  mcpStatus: MCPServerStatus[];
  /** Ordered implementation steps (concatenated from patterns). */
  steps: string[];
  /** Domain rules from skill guidance. */
  rules: string[];
  /** Things the LLM must NOT do (concatenated + deduped). */
  antiPatterns: string[];
}

/** Runtime availability status for a required MCP server. */
export interface MCPServerStatus {
  /** Server name (e.g. "fabric-rti-mcp"). */
  name: string;
  /** Whether the server is configured in MCP config. */
  configured: boolean;
  /** Connection state if configured. */
  state?: "idle" | "connecting" | "connected" | "error" | "closed";
  /** Number of discovered tools (if connected). */
  toolCount?: number;
  /** Error message (if state is "error"). */
  lastError?: string;
}

// ── Implementation ──────────────────────────────────────────────────

/**
 * Extract the first few non-empty, non-heading lines from guidance text
 * as "rules" for the LLM to follow.
 */
function extractRules(guidance: string, maxRules: number = 10): string[] {
  const rules: string[] = [];
  for (const line of guidance.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("---")) continue;
    if (trimmed.startsWith("```")) continue;
    // Keep bullet points and key-value lines
    if (
      trimmed.startsWith("-") ||
      trimmed.startsWith("•") ||
      trimmed.startsWith("*") ||
      trimmed.includes(":") ||
      /^[A-Z]/.test(trimmed)
    ) {
      rules.push(trimmed.replace(/^[-•*]\s*/, "").trim());
      if (rules.length >= maxRules) break;
    }
  }
  return rules;
}

/**
 * Resolve matched skills to their patterns and materialise guidance.
 *
 * @param skillNames - Names of matched skills
 * @param skills - All loaded skills
 * @param patterns - All loaded patterns
 * @returns Materialised guidance with unioned requirements
 */
export function resolveApproach(
  skillNames: string[],
  skills: Map<string, Skill>,
  patterns: Map<string, Pattern>,
): MaterialisedGuidance {
  const profileSet = new Set<string>();
  const moduleSet = new Set<string>();
  const pluginSet = new Set<string>();
  const mcpSet = new Set<string>();
  const config: Record<string, number> = {};
  const allSteps: string[] = [];
  const allRules: string[] = [];
  const antiPatternSet = new Set<string>();

  for (const skillName of skillNames) {
    const skill = skills.get(skillName);
    if (!skill) continue;

    // Collect antiPatterns from skill
    for (const ap of skill.antiPatterns) {
      antiPatternSet.add(ap);
    }

    // Collect required MCP servers
    for (const mcp of skill.requiresMcp) {
      mcpSet.add(mcp);
    }

    // Extract rules from skill guidance
    const skillRules = extractRules(skill.guidance);
    allRules.push(...skillRules);

    // Resolve each pattern referenced by the skill
    for (const patternName of skill.patterns) {
      const pattern = patterns.get(patternName);
      if (!pattern) continue;

      // Union modules
      for (const m of pattern.modules) moduleSet.add(m);

      // Union plugins
      for (const p of pattern.plugins) pluginSet.add(p);

      // Union profiles
      for (const p of pattern.profiles) profileSet.add(p);

      // Config: take max of each numeric value
      for (const [key, value] of Object.entries(pattern.config)) {
        if (config[key] === undefined || value > config[key]) {
          config[key] = value;
        }
      }

      // Collect steps (prefixed with pattern name for clarity)
      for (const step of pattern.steps) {
        const prefixed = `[${patternName}] ${step}`;
        if (!allSteps.includes(prefixed)) {
          allSteps.push(prefixed);
        }
      }
    }
  }

  // Deduplicate rules
  const uniqueRules = [...new Set(allRules)];

  return {
    matchedSkills: skillNames,
    profiles: [...profileSet],
    config,
    modules: [...moduleSet],
    plugins: [...pluginSet],
    requiredMcp: [...mcpSet],
    mcpStatus: [],
    steps: allSteps,
    rules: uniqueRules,
    antiPatterns: [...antiPatternSet],
  };
}

/**
 * Expand a guidance's modules via relatedModules from JSON hints.
 * Also collects criticalRules and antiPatterns from module hints.
 * Called after resolveApproach to enrich with module-level knowledge.
 */
function enrichWithModuleHints(guidance: MaterialisedGuidance): void {
  const expandedModules = new Set(guidance.modules);

  for (const moduleName of [...guidance.modules]) {
    const mod = loadModule(moduleName);
    if (!mod?.structuredHints) continue;

    // Auto-include related modules
    if (mod.structuredHints.relatedModules) {
      for (const related of mod.structuredHints.relatedModules) {
        expandedModules.add(related.replace(/^ha:/, ""));
      }
    }

    // Collect criticalRules from module hints
    if (mod.structuredHints.criticalRules) {
      for (const rule of mod.structuredHints.criticalRules) {
        if (!guidance.rules.includes(rule)) {
          guidance.rules.push(rule);
        }
      }
    }

    // Collect antiPatterns from module hints
    if (mod.structuredHints.antiPatterns) {
      for (const ap of mod.structuredHints.antiPatterns) {
        if (!guidance.antiPatterns.includes(ap)) {
          guidance.antiPatterns.push(ap);
        }
      }
    }
  }

  guidance.modules = [...expandedModules];
}

// ── Standalone suggest_approach runner ───────────────────────────────

/** Result from runSuggestApproach — includes the formatted guidance string. */
export interface SuggestApproachResult {
  matchedSkills: string[];
  profile: string;
  guidance: MaterialisedGuidance;
  /** Pre-formatted guidance for injection into additionalContext. */
  formatted: string;
}

// Generic guidance for when no skills match the prompt.
const GENERIC_GUIDANCE: MaterialisedGuidance = {
  matchedSkills: [],
  profiles: [],
  config: {},
  modules: [],
  plugins: [],
  requiredMcp: [],
  mcpStatus: [],
  steps: [
    "1. Call list_modules to discover available modules",
    "2. Call module_info(name) for any relevant modules",
    "3. Register a handler with the appropriate code",
    "4. Execute the handler",
  ],
  rules: ["ALWAYS call module_info before writing handler code"],
  antiPatterns: [],
};

/**
 * Format materialised guidance as a readable string for LLM context injection.
 */
export function formatGuidance(guidance: MaterialisedGuidance): string {
  const parts: string[] = ["--- TASK GUIDANCE ---"];

  // Anti-patterns and rules go FIRST — the LLM is most likely to follow
  // instructions at the top of the context injection.
  if (guidance.antiPatterns.length > 0) {
    parts.push("⚠️ DO NOT:");
    for (const ap of guidance.antiPatterns) {
      parts.push(`  ✗ ${ap}`);
    }
  }
  if (guidance.rules.length > 0) {
    parts.push("Rules:");
    for (const rule of guidance.rules) {
      parts.push(`  - ${rule}`);
    }
  }

  if (guidance.modules.length > 0) {
    parts.push(
      `Modules: ${guidance.modules.map((m) => `ha:${m}`).join(", ")} — call module_info() for each before writing code`,
    );
  }
  if (guidance.plugins.length > 0) {
    parts.push(
      `Plugins: ${guidance.plugins.join(", ")} — enable via manage_plugin or apply_profile`,
    );
  }
  if (guidance.mcpStatus.length > 0) {
    parts.push("MCP Servers:");
    for (const s of guidance.mcpStatus) {
      if (!s.configured) {
        parts.push(
          `  ❌ ${s.name} — not configured. Run: hyperagent --mcp setup-${s.name.replace(/^fabric-/, "")}`,
        );
      } else if (s.state === "connected") {
        parts.push(
          `  ✅ ${s.name} — connected (${s.toolCount ?? 0} tools). Import from host:mcp-${s.name}`,
        );
      } else if (s.state === "error") {
        parts.push(
          `  ⚠️ ${s.name} — configured but errored: ${s.lastError ?? "unknown"}`,
        );
      } else {
        parts.push(
          `  ⚡ ${s.name} — configured (${s.state ?? "idle"}). Call manage_mcp({action:"connect", name:"${s.name}"}) to connect`,
        );
      }
    }
  }
  if (guidance.profiles.length > 0) {
    parts.push(`Profiles: ${guidance.profiles.join(", ")}`);
  }
  if (guidance.steps.length > 0) {
    parts.push("Steps:");
    for (const step of guidance.steps) {
      parts.push(`  ${step}`);
    }
  }

  parts.push("--- END GUIDANCE ---");
  return parts.join("\n");
}

/**
 * Run the full suggest_approach flow: load skills/patterns, match intent,
 * resolve guidance, format output.
 *
 * Pure function — no side effects beyond reading skill/pattern files.
 *
 * @param prompt - The user's prompt text
 * @param preLoadedSkills - Pre-loaded skill names (from --skill flag)
 * @param skillsDir - Path to skills/ directory
 * @param patternsDir - Path to patterns/ directory
 * @param debugLog - Optional debug logger
 */
export function runSuggestApproach(
  prompt: string,
  preLoadedSkills: string[],
  skillsDir: string,
  patternsDir: string,
  debugLog?: (msg: string) => void,
): SuggestApproachResult {
  const log = debugLog ?? (() => {});

  const skills = loadSkills(skillsDir);
  const patterns = loadPatterns(patternsDir);

  let matchedSkillNames: string[];

  if (preLoadedSkills.length > 0) {
    matchedSkillNames = preLoadedSkills;
    log(
      `runSuggestApproach: using pre-loaded skills: ${matchedSkillNames.join(", ")}`,
    );
  } else {
    const matches = matchIntent(prompt, skills);
    matchedSkillNames = matches.map((m) => m.name);
    log(
      `runSuggestApproach: matched ${matches.length} skill(s): ${matches.map((m) => `${m.name}(${m.score})`).join(", ")}`,
    );
  }

  if (matchedSkillNames.length === 0) {
    return {
      matchedSkills: [],
      profile: "default",
      guidance: GENERIC_GUIDANCE,
      formatted: formatGuidance(GENERIC_GUIDANCE),
    };
  }

  const guidance = resolveApproach(matchedSkillNames, skills, patterns);

  // Enrich with module hints — expands relatedModules and adds
  // criticalRules/antiPatterns from module JSON metadata.
  enrichWithModuleHints(guidance);

  return {
    matchedSkills: guidance.matchedSkills,
    profile: guidance.profiles[0] ?? "default",
    guidance,
    formatted: formatGuidance(guidance),
  };
}
