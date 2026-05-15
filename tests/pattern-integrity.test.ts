// ── Pattern & Skill Integrity Tests ─────────────────────────────────
//
// Validates that:
// 1. Every pattern referenced by a skill actually exists
// 2. Every module in a pattern's modules[] array is a real builtin module
// 3. Pattern steps don't contain hardcoded ha:module function calls
//    (the LLM should discover APIs via module_info, not from prose)
//
// ─────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { ALLOWED_TOOLS } from "../src/agent/tool-gating.js";
import { loadSkills } from "../src/agent/skill-loader.js";
import { loadPatterns } from "../src/agent/pattern-loader.js";

const ROOT = join(import.meta.dirname, "..");
const SKILLS_DIR = join(ROOT, "skills");
const PATTERNS_DIR = join(ROOT, "patterns");
const BUILTIN_MODULES_DIR = join(ROOT, "builtin-modules");

// Builtin module names derived from .json metadata files (excluding tsconfig)
const builtinModuleNames = new Set(
  readdirSync(BUILTIN_MODULES_DIR)
    .filter((f) => f.endsWith(".json") && f !== "tsconfig.json")
    .map((f) => f.replace(/\.json$/, "")),
);

// Internal/private modules that shouldn't be referenced in patterns
const PRIVATE_MODULES = new Set(["_restore", "_save"]);

const skills = loadSkills(SKILLS_DIR);
const patterns = loadPatterns(PATTERNS_DIR);

function parseAllowedTools(skillName: string): string[] {
  const skillFile = join(SKILLS_DIR, skillName, "SKILL.md");
  const content = readFileSync(skillFile, "utf-8");
  const lines = content.split("\n");
  const tools: string[] = [];
  let inAllowedTools = false;

  for (const line of lines) {
    if (line.trim() === "---" && inAllowedTools) break;
    if (/^allowed-tools:\s*$/.test(line.trim())) {
      inAllowedTools = true;
      continue;
    }
    if (!inAllowedTools) continue;
    if (/^\S/.test(line) && !line.trim().startsWith("-")) break;
    const match = line.match(/^\s+-\s+(.+)\s*$/);
    if (match) tools.push(match[1]!.trim());
  }

  return tools;
}

describe("pattern-integrity", () => {
  describe("skill → pattern references", () => {
    for (const [skillName, skill] of skills) {
      for (const patternName of skill.patterns) {
        it(`skill "${skillName}" references existing pattern "${patternName}"`, () => {
          expect(
            patterns.has(patternName),
            `Pattern "${patternName}" referenced by skill "${skillName}" does not exist in ${PATTERNS_DIR}`,
          ).toBe(true);
        });
      }
    }
  });

  describe("pattern modules exist as builtin modules", () => {
    for (const [patternName, pattern] of patterns) {
      for (const moduleName of pattern.modules) {
        it(`pattern "${patternName}" module "${moduleName}" is a real builtin module`, () => {
          expect(
            builtinModuleNames.has(moduleName),
            `Module "${moduleName}" in pattern "${patternName}" is not in builtin-modules/. ` +
              `Available: ${[...builtinModuleNames].filter((m) => !PRIVATE_MODULES.has(m)).join(", ")}`,
          ).toBe(true);
        });

        it(`pattern "${patternName}" module "${moduleName}" is not a private module`, () => {
          expect(
            !PRIVATE_MODULES.has(moduleName),
            `Module "${moduleName}" in pattern "${patternName}" is a private/internal module`,
          ).toBe(true);
        });
      }
    }
  });

  describe("pattern steps do not hardcode ha:module API calls", () => {
    // Matches: ha:module-name functionName(args) — a specific module API call in prose.
    // This is the (a) option: only flag ha:module-name + function combos.
    const HA_MODULE_CALL_RE = /ha:\S+\s+\w+\([^)]*\)/;

    for (const [patternName, pattern] of patterns) {
      it(`pattern "${patternName}" steps should not contain ha:module function calls`, () => {
        const violations: string[] = [];
        for (const step of pattern.steps) {
          if (HA_MODULE_CALL_RE.test(step)) {
            violations.push(step);
          }
        }
        expect(
          violations,
          `Pattern "${patternName}" has hardcoded API calls in steps. ` +
            `Use descriptive intent instead (e.g. "parse HTML using ha:html"). ` +
            `Violations:\n${violations.map((v) => `  - ${v}`).join("\n")}`,
        ).toEqual([]);
      });
    }
  });

  describe("skill allowed-tools metadata", () => {
    const mcpTools = ["list_mcp_servers", "mcp_server_info", "manage_mcp"];

    for (const [skillName] of skills) {
      const allowedTools = parseAllowedTools(skillName);

      it(`skill "${skillName}" only references real HyperAgent tools`, () => {
        expect(
          allowedTools.filter((tool) => !ALLOWED_TOOLS.has(tool)),
          `Skill "${skillName}" has stale/unknown allowed-tools entries`,
        ).toEqual([]);
      });

      it(`skill "${skillName}" includes MCP discovery/connect tools`, () => {
        expect(
          mcpTools.filter((tool) => !allowedTools.includes(tool)),
          `Skill "${skillName}" should allow MCP discovery/connect tools so it can use external data sources when relevant`,
        ).toEqual([]);
      });
    }
  });

  describe("tool gating completeness", () => {
    // Extract all tool names from defineTool() calls in index.ts
    const indexSource = readFileSync(
      join(ROOT, "src", "agent", "index.ts"),
      "utf-8",
    );
    const toolNames = [...indexSource.matchAll(/defineTool\("([^"]+)"/g)].map(
      (m) => m[1],
    );

    // Tools that are intentionally NOT gated (internal-only, not exposed to LLM)
    const INTERNAL_TOOLS = new Set([
      "llm_thought", // Internal reasoning — not user-facing
      "delete_handlers", // Bulk delete — internal use
    ]);

    for (const toolName of toolNames) {
      if (INTERNAL_TOOLS.has(toolName)) continue;

      it(`tool "${toolName}" is in ALLOWED_TOOLS`, () => {
        expect(
          ALLOWED_TOOLS.has(toolName),
          `Tool "${toolName}" is defined via defineTool() but NOT in ALLOWED_TOOLS. ` +
            `The LLM cannot use tools that aren't in the gating list. ` +
            `Add it to src/agent/tool-gating.ts.`,
        ).toBe(true);
      });

      it(`tool "${toolName}" is in availableTools`, () => {
        // availableTools is a separate SDK list that controls which tools
        // the model can SEE. Without this, the tool exists but is invisible.
        const availableToolsMatch = indexSource.match(
          /availableTools:\s*\[([\s\S]*?)\]/,
        );
        expect(
          availableToolsMatch,
          "Could not find availableTools array in index.ts",
        ).toBeTruthy();
        const availableList = availableToolsMatch![1];
        expect(
          availableList.includes(`"${toolName}"`),
          `Tool "${toolName}" is defined via defineTool() but NOT in availableTools. ` +
            `The model cannot see tools that aren't in availableTools. ` +
            `Add "${toolName}" to the availableTools array in buildSessionConfig().`,
        ).toBe(true);
      });
    }

    // ── SDK built-in tools we rely on ──────────────────────────────
    // Some tools (like the "skill" tool that materialises /<skill-name>
    // invocations into the conversation) are owned by the Copilot SDK,
    // not defined via defineTool(). They still need to appear in BOTH
    // ALLOWED_TOOLS and availableTools — otherwise the SDK reports
    // "Disabled tools: ... skill ..." in session.info and the model
    // can never call them. This caught a real regression where typing
    // /kql-expert loaded the skill metadata but never injected the
    // SKILL.md body, because the SDK's "skill" tool was gated out.
    const SDK_BUILTIN_TOOLS = ["skill"];
    for (const toolName of SDK_BUILTIN_TOOLS) {
      it(`SDK built-in "${toolName}" is in ALLOWED_TOOLS`, () => {
        expect(
          ALLOWED_TOOLS.has(toolName),
          `SDK built-in tool "${toolName}" is missing from ALLOWED_TOOLS. ` +
            `onPreToolUse will reject it. Add it to src/agent/tool-gating.ts.`,
        ).toBe(true);
      });

      it(`SDK built-in "${toolName}" is in availableTools`, () => {
        const availableToolsMatch = indexSource.match(
          /availableTools:\s*\[([\s\S]*?)\]/,
        );
        expect(
          availableToolsMatch,
          "Could not find availableTools array in index.ts",
        ).toBeTruthy();
        const availableList = availableToolsMatch![1];
        expect(
          availableList.includes(`"${toolName}"`),
          `SDK built-in tool "${toolName}" is missing from availableTools. ` +
            `The SDK will disable it (visible as "Disabled tools: ... ${toolName} ..." ` +
            `in session.info) and the model cannot invoke it. ` +
            `Add "${toolName}" to the availableTools array in buildSessionConfig().`,
        ).toBe(true);
      });
    }
  });

  describe("skill hot-reload wiring", () => {
    // These tests guard the "no process restart needed" fix.
    //
    // The SDK's `ensureSkillsLoaded()` is one-shot per session, so any
    // skill written mid-session (via `/save-skill`, the `generate_skill`
    // tool, or `$EDITOR` on `~/.hyperagent/skills/<name>/SKILL.md`) is
    // invisible to the model until the next process start.  We close
    // the gap by:
    //   1. Auto-calling `session.rpc.skills.reload()` immediately after
    //      `generate_skill` writes a SKILL.md.
    //   2. Exposing a manual `/skills reload` subcommand for external
    //      editor workflows.
    //
    // Regressing either of these silently puts us back to "user has to
    // restart the agent to invoke a skill they just wrote" — exactly
    // the footgun the fix removed.  Keep both assertions.
    const indexSource = readFileSync(
      join(ROOT, "src", "agent", "index.ts"),
      "utf-8",
    );
    const slashSource = readFileSync(
      join(ROOT, "src", "agent", "slash-commands.ts"),
      "utf-8",
    );

    it("generate_skill tool calls skills.reload() after writeUserSkill", () => {
      // Anchor on the exact API path we depend on — a refactor that
      // accidentally drops the reload call would otherwise sneak by.
      expect(
        indexSource.includes("activeSession.rpc.skills.reload()"),
        "generate_skill must call `state.activeSession.rpc.skills.reload()` " +
          "after `writeUserSkill()` so the new skill is invocable on the next " +
          "turn. Without it, the user has to restart the agent — see " +
          "src/agent/index.ts generateSkillTool.",
      ).toBe(true);
    });

    it("/skills reload subcommand exists and calls skills.reload()", () => {
      // Two-step check: the subcommand handler and the RPC call must
      // both be present in the /skills case.
      expect(
        slashSource.includes('sub === "reload"'),
        "Slash-command handler for `/skills reload` is missing. " +
          "Without it, users editing skills in $EDITOR have no way to " +
          "refresh the SDK's skill registry short of restarting the agent.",
      ).toBe(true);
      expect(
        slashSource.includes("activeSession.rpc.skills.reload()"),
        "`/skills reload` subcommand must call " +
          "`state.activeSession.rpc.skills.reload()` — it's the public " +
          "SDK API that clears the skill cache and re-scans skillDirectories.",
      ).toBe(true);
    });

    it("REPL `/skills <name>` rewrite gates on validateSkillName, not a hardcoded set", () => {
      // PR #151 review caught a regression: the rewrite used a
      // `KNOWN_SKILLS_SUBS = new Set(["info","edit","delete","list"])`
      // local set that omitted `reload`, so typing `/skills reload`
      // got rewritten to `/reload` and broke the hot-reload command.
      // The fix is to delegate to `validateSkillName()` which uses
      // the canonical `RESERVED_SKILL_NAMES` set in skill-writer.ts
      // (single source of truth — adding a new subcommand only requires
      // updating one place).  This test pins the new mechanism so a
      // future "quick fix" doesn't reintroduce a parallel hardcoded
      // list that can drift again.
      expect(
        indexSource.includes(
          "validateSkillName(skillsParts[1].toLowerCase()) === null",
        ),
        "The /skills rewrite must gate on `validateSkillName(...) === null` " +
          "so reserved subcommands (info|edit|delete|list|reload) and any " +
          "future additions are automatically excluded via RESERVED_SKILL_NAMES.",
      ).toBe(true);
      expect(
        !indexSource.includes("KNOWN_SKILLS_SUBS"),
        "The hardcoded `KNOWN_SKILLS_SUBS` set was the source of the " +
          "`/skills reload` regression — it must stay deleted.  Use " +
          "validateSkillName() / RESERVED_SKILL_NAMES instead.",
      ).toBe(true);
    });
  });

  describe("slash-command skill detection (no path traversal)", () => {
    // PR #151 review found that the default-case skill-detection used
    // `existsSync(join(skillsDir, skillName, "SKILL.md"))` with `skillName`
    // taken directly from `cmd.slice(1)` — unsanitised user input.
    // A literal `/../etc` would resolve outside `skillsDir`, turning
    // the "is this a skill?" check into an arbitrary filesystem probe.
    //
    // Fix: route the system-skill side of the check through
    // `systemSkillExists()` which calls `validateSkillName()` first —
    // rejecting empty / oversized / kebab-case-violating / path-traversal
    // / reserved names BEFORE any `join()` touches disk.
    const slashSource = readFileSync(
      join(ROOT, "src", "agent", "slash-commands.ts"),
      "utf-8",
    );

    it("default case uses systemSkillExists, not a raw existsSync(join(skillsDir, ...))", () => {
      // The validated helper is the canonical entry-point.
      expect(
        slashSource.includes("systemSkillExists(skillName, skillsDir)"),
        "Slash-command default case must call " +
          "`systemSkillExists(skillName, skillsDir)` — it validates the " +
          "name before any path join, preventing /../etc-style traversal.",
      ).toBe(true);

      // The raw pattern must NOT come back in the same file.  Grep on
      // the exact arg shape (`skillName, "SKILL.md"`) so unrelated
      // existsSync calls elsewhere in slash-commands.ts (there are
      // several legitimate ones) don't trip this guard.
      expect(
        slashSource.includes(
          'existsSync(join(skillsDir, skillName, "SKILL.md"))',
        ),
        'Found a raw `existsSync(join(skillsDir, skillName, "SKILL.md"))` ' +
          "in slash-commands.ts — this is the exact unsafe pattern PR #151 " +
          "review flagged.  Replace it with `systemSkillExists()`.",
      ).toBe(false);
    });
  });

  describe("markdown UX (no toggle-trap, no raw `**` rendering)", () => {
    // These tests guard against three previously-shipped UX bugs:
    //
    //   Bug 1 — `/markdown` was a destructive toggle.  Users running it
    //   to inspect state inadvertently flipped state, then reported
    //   "markdown is OFF when it should be ON".  Fix: bare invocation
    //   is a pure status query; mutation requires `on|off|toggle`.
    //
    //   Bug 2 — Two callsites printed literal `**Configuration:**` via
    //   plain `console.log`, so the asterisks ended up on screen
    //   instead of bold formatting.  Fix: use `C.label()` / ANSI bold.
    //
    //   Bug 3 — `processMessage()` gated the rendered output of the
    //   *assistant's own response* on `looksLikeMarkdown()`, producing
    //   inconsistent results (some turns rendered, others raw) for users
    //   who had explicitly opted in.  Fix: when `markdownEnabled` is
    //   true the assistant response always goes through `renderMarkdown`.
    const indexSource = readFileSync(
      join(ROOT, "src", "agent", "index.ts"),
      "utf-8",
    );
    const slashSource = readFileSync(
      join(ROOT, "src", "agent", "slash-commands.ts"),
      "utf-8",
    );

    it("/markdown supports explicit subcommands (on/off/toggle/status)", () => {
      // Anchor on each subcommand literal — a refactor that drops one
      // would silently regress the "inspect without mutating" contract.
      for (const verb of ['"on"', '"off"', '"toggle"', '"status"']) {
        expect(
          slashSource.includes(`sub === ${verb}`),
          `/markdown handler must accept the ${verb} subcommand. ` +
            `Bare invocation is the status query; on/off/toggle are the ` +
            `explicit mutations. Dropping any of these reverts the ` +
            `"toggle-trap" UX bug — see src/agent/slash-commands.ts.`,
        ).toBe(true);
      }
    });

    it("no callsite prints literal `**Configuration:**` via console.log", () => {
      // Plain console.log does NOT pass strings through the markdown
      // renderer, so `**foo**` would print raw asterisks.  Callers must
      // use C.label() (ANSI bold helper) or renderMarkdown() instead.
      const bannerRe =
        /console\.(?:log|error)\([^)]*\*\*[^)]*Configuration[^)]*\*\*/;
      expect(
        bannerRe.test(indexSource),
        "src/agent/index.ts startup banner prints literal `**Configuration:**`. " +
          "Use `${bold}Configuration:${reset}` (ANSI) so users opted-in to " +
          "markdown don't see raw asterisks above the rendered table.",
      ).toBe(false);
      expect(
        bannerRe.test(slashSource),
        "src/agent/slash-commands.ts /config handler prints literal " +
          '`**Configuration:**`. Use `C.label("⚙️  Configuration:")` to match ' +
          "the non-markdown branch and avoid raw asterisks on screen.",
      ).toBe(false);
    });

    it("processMessage renders assistant content unconditionally when markdown is on", () => {
      // The pre-fix code wrapped the renderMarkdown call in a
      // `looksLikeMarkdown(state.streamedText)` gate, so turns whose
      // text didn't trip the heuristic landed on screen raw — even
      // though the user explicitly opted in via /markdown.  The fix is
      // to drop that inner gate for the streamed-text branch.
      //
      // We anchor on a comment phrase that lives next to the fix.  The
      // assertion is purposely loose (regex-free) so legitimate edits
      // to the comment don't break the test — but a regression that
      // re-introduces the inner gate would also have to re-introduce
      // the gating call, which is what the second assertion checks.
      expect(
        indexSource.includes("user has\n      // explicitly opted in") ||
          indexSource.includes("explicitly opted in via the default-on flag"),
        "processMessage() must document why it renders unconditionally " +
          "when state.markdownEnabled is true — the comment is the only " +
          "thing keeping a future refactor from re-adding a looksLikeMarkdown " +
          "gate that would re-introduce the inconsistent-rendering bug.",
      ).toBe(true);
      // Hard structural check: the streamedText branch must NOT gate on
      // looksLikeMarkdown.  We grep for the previous pattern; if it
      // returns, the regression is back.
      expect(
        indexSource.includes("if (looksLikeMarkdown(state.streamedText))"),
        "processMessage() reintroduced a `looksLikeMarkdown(state.streamedText)` " +
          "gate on the buffered assistant output. When the user has opted in to " +
          "markdown rendering, that gate produces inconsistent output (some " +
          "turns rendered, others raw). Render unconditionally.",
      ).toBe(false);
    });
  });

  describe("MCP setup shortcut surfacing", () => {
    // Background: when a skill declares `requires-mcp: <server>` and the
    // server isn't yet configured, the LLM is supposed to tell the user
    // about the specific `--mcp-setup-<server>` shortcut.  In practice
    // the model has been observed to (a) hallucinate generic flags that
    // don't exist (e.g. `--mcp foo=bar`) or (b) bury the recommendation
    // under config.json snippets.  formatGuidance() is what feeds the
    // model — if we hold its output to a strict shape, the model's
    // surfaced advice stays accurate.

    const resolverSource = readFileSync(
      join(ROOT, "src", "agent", "approach-resolver.ts"),
      "utf-8",
    );
    const cliSource = readFileSync(
      join(ROOT, "src", "agent", "cli-parser.ts"),
      "utf-8",
    );

    // The names in MCP_SETUP_COMMANDS must correspond to real CLI flags.
    // If you add a new shortcut, this list must grow in lockstep.
    const SUPPORTED_SHORTCUTS = [
      ["fabric-rti-mcp", "--mcp-setup-fabric-rti"],
      ["everything", "--mcp-setup-everything"],
      ["github", "--mcp-setup-github"],
      ["filesystem", "--mcp-setup-filesystem"],
      ["workiq", "--mcp-setup-workiq"],
    ] as const;

    it("MCP_SETUP_COMMANDS lists every supported server", () => {
      for (const [name, flag] of SUPPORTED_SHORTCUTS) {
        // Match a key-value line like  `name: "--mcp-setup-...",` or
        // `"fabric-rti-mcp": "--mcp-setup-fabric-rti",` — quoting on
        // bare keys is optional in TS object literals.
        const keyRe = new RegExp(
          `["']?${name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}["']?\\s*:\\s*["']${flag}["']`,
        );
        expect(
          keyRe.test(resolverSource),
          `MCP_SETUP_COMMANDS must map "${name}" → "${flag}" so ` +
            `formatGuidance() can recommend the specific shortcut. ` +
            "See src/agent/approach-resolver.ts.",
        ).toBe(true);
      }
    });

    it("every MCP_SETUP_COMMANDS flag has a matching CLI case", () => {
      // Belt-and-braces: a shortcut listed in the resolver but missing
      // from the parser would have us recommend a flag that prints
      // "unknown option" — exactly the failure mode we're guarding.
      for (const [, flag] of SUPPORTED_SHORTCUTS) {
        expect(
          cliSource.includes(`case "${flag}"`),
          `cli-parser.ts must handle "${flag}" — MCP_SETUP_COMMANDS in ` +
            "approach-resolver.ts references it. Either remove the " +
            "mapping or wire up the CLI case.",
        ).toBe(true);
      }
    });

    it("formatGuidance does NOT synthesise a fake `--mcp-setup-${name}` flag", () => {
      // The previous fallback was `--mcp-setup-${s.name}` — that would
      // emit, e.g., `--mcp-setup-made-up-mcp` for unsupported servers,
      // which the CLI parser would reject. Honest guidance must point
      // users at the config file instead.
      expect(
        resolverSource.includes("`--mcp-setup-${s.name}`"),
        "formatGuidance() reintroduced a synthesised " +
          "`--mcp-setup-${name}` fallback. That flag does not exist for " +
          "arbitrary names; recommend ~/.hyperagent/config.json instead. " +
          "See src/agent/approach-resolver.ts.",
      ).toBe(false);
    });
  });
});
