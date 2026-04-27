// ── Command Registry ─────────────────────────────────────────────────
//
// Single source of truth for all slash commands.  Drives:
//   1. Tab-completion (derived from `completion` strings)
//   2. /help output   (derived from `help` descriptions)
//
// No more triple-maintenance — a single source of truth for both.
//
// ─────────────────────────────────────────────────────────────────────

import { C } from "./ansi.js";

/** A registered slash command for help + tab completion. */
interface CommandEntry {
  /** The string used for tab completion (with trailing space if it takes args). */
  completion: string;
  /** One-line description shown in /help. */
  help: string;
  /** Optional group header — printed once before the first command in the group. */
  group?: string;
  /** Extended description shown by /help <topic>. Multi-line OK. */
  detail?: string;
}

/**
 * Master command registry.  Every slash command appears here exactly once.
 * Groups are rendered with a blank-line separator in /help.
 */
const COMMANDS: readonly CommandEntry[] = Object.freeze([
  // ── Toggles ──────────────────────────────────────────────
  {
    completion: "/show-code",
    help: "Toggle inline code display",
    group: "Toggles",
    detail:
      "When on, the generated JavaScript sent to the sandbox is\n" +
      "logged to a timestamped file. Toggle on/off at any time.",
  },
  {
    completion: "/show-timing",
    help: "Toggle inline timing display",
    detail:
      "Shows wall-clock timing breakdown after each tool execution:\n" +
      "init, compile, exec, total, plus configured CPU/wall limits.\n" +
      "Note: exec includes time suspended for host calls (fetch, fs).",
  },
  {
    completion: "/debug",
    help: "Toggle debug event logging",
    detail:
      "Enables verbose SDK event logging (same as HYPERAGENT_DEBUG=1).\n" +
      "Shows every event the agent receives from the Copilot SDK.",
  },
  {
    completion: "/tokens",
    help: "Show session token usage summary",
    detail:
      "Displays cumulative input/output/cache tokens, request count,\n" +
      "and turn count for the current session. Also shown on exit.",
  },
  {
    completion: "/reasoning conversation ",
    help: "Set conversation reasoning effort (low|medium|high|xhigh)",
    detail:
      "Controls how much effort the model spends reasoning during\n" +
      "conversation. Only works for models with 🧠 in /models.\n" +
      "\n" +
      "  /reasoning conversation <level>  — set effort\n" +
      "  /reasoning conversation reset    — use model default\n" +
      "\n" +
      "Levels: low | medium | high | xhigh\n" +
      "\n" +
      "Also: --show-reasoning [level] CLI flag.",
  },
  {
    completion: "/reasoning audit ",
    help: "Set audit reasoning effort (medium|high|xhigh, min: medium)",
    detail:
      "Controls how much effort the model spends reasoning during\n" +
      "plugin security audits. Minimum is medium — audits should\n" +
      "never skimp on thinking.\n" +
      "\n" +
      "  /reasoning audit <level>  — set effort\n" +
      "  /reasoning audit reset    — reset to medium\n" +
      "  /reasoning                — show both settings\n" +
      "\n" +
      "Levels:\n" +
      "  medium → balanced, visible reasoning (default)\n" +
      "  high   → deeper analysis, slower\n" +
      "  xhigh  → maximum depth, slowest\n" +
      "\n" +
      "Note: some models use opaque (non-streamable) reasoning at\n" +
      "higher effort levels. This is model-specific behaviour —\n" +
      "the agent will show a notice if it detects opaque reasoning.",
  },
  {
    completion: "/verbose",
    help: "Toggle verbose output (reasoning scroll, turn details)",
    detail:
      "Toggles verbose output mode on/off.\n" +
      "\n" +
      "When ON:\n" +
      "  • Reasoning deltas scroll freely through the terminal\n" +
      "  • Turn lifecycle events visible during SDK dead zones\n" +
      "  • More detailed progress output\n" +
      "\n" +
      "When OFF (default):\n" +
      "  • Reasoning shown as a compact spinner preview line\n" +
      "  • Quieter output\n" +
      "\n" +
      "Also: --verbose CLI flag or HYPERAGENT_VERBOSE=1.",
  },

  // ── Timeouts & Buffers ───────────────────────────────────
  {
    completion: "/timeout cpu ",
    help: "Set CPU timeout (milliseconds)",
    group: "Timeouts & Buffers",
    detail:
      "Limits CPU time per JavaScript execution in the micro-VM.\n" +
      "Example: /timeout cpu 2000",
  },
  {
    completion: "/timeout wall ",
    help: "Set wall-clock timeout (milliseconds)",
    detail:
      "Backstop wall-clock limit per execution. Catches hangs\n" +
      "even when the CPU timer cannot (e.g. host function calls).\n" +
      "Example: /timeout wall 10000",
  },
  {
    completion: "/timeout send ",
    help: "Set agent inactivity timeout (milliseconds)",
    detail:
      "If the agent produces no events for this long, the turn\n" +
      "is cancelled. Guards against infinite-loop tool calls.\n" +
      "Example: /timeout send 60000",
  },
  {
    completion: "/timeout reset",
    help: "Reset all timeouts to defaults",
    detail:
      "Restores CPU, wall, and send timeouts to the values\n" +
      "set at startup (CLI flags / environment variables).",
  },
  {
    completion: "/buffer input ",
    help: "Set input buffer size (kilobytes)",
    detail:
      "Controls how much data can be sent into the sandbox.\n" +
      "Takes effect on the next execution.\n" +
      "Example: /buffer input 128",
  },
  {
    completion: "/buffer output ",
    help: "Set output buffer size (kilobytes)",
    detail:
      "Controls how much data the sandbox can return.\n" +
      'Increase if you see "output truncated" errors.\n' +
      "Example: /buffer output 256",
  },
  {
    completion: "/buffer reset",
    help: "Reset buffer sizes to defaults",
    detail:
      "Restores input and output buffers to the values\n" +
      "set at startup (CLI flags / environment variables).",
  },
  {
    completion: "/set heap ",
    help: "Set guest heap size (megabytes)",
    group: "Resources",
    detail:
      "Controls the guest VM heap size. Forces a sandbox rebuild.\n" +
      'Increase when you see "Guest aborted" or out-of-memory errors.\n' +
      "Example: /set heap 32",
  },
  {
    completion: "/set scratch ",
    help: "Set guest scratch size (megabytes)",
    group: "Resources",
    detail:
      "Controls the guest VM scratch space (includes the stack).\n" +
      "Forces a sandbox rebuild.\n" +
      'Increase when you see "Out of physical memory", "Guest aborted: 13",\n' +
      "stack overflow, or deep-recursion errors.\n" +
      "Example: /set scratch 8",
  },
  {
    completion: "/set reset",
    help: "Reset heap and scratch to defaults",
    detail:
      "Restores heap and scratch sizes to the values\n" +
      "set at startup (CLI flags / environment variables).",
  },

  // ── Session ──────────────────────────────────────────────
  {
    completion: "/transcript",
    help: "Toggle session transcript on/off",
    group: "Session",
    detail:
      "Records all input/output (with ANSI stripped) to a temp\n" +
      "file. Useful for post-session review or bug reports.",
  },
  {
    completion: "/models",
    help: "List available models",
    detail:
      "Queries the Copilot SDK for available models and shows\n" +
      "them with capability icons (vision, streaming, etc.).",
  },
  {
    completion: "/model ",
    help: "Switch to a different model",
    detail:
      "Changes the LLM model used for subsequent turns while\n" +
      "preserving conversation history.\n" +
      "Example: /model gpt-4.1",
  },
  {
    completion: "/new",
    help: "Start a fresh session (blank context)",
    detail:
      "Saves the current session and starts a new one with\n" +
      "a blank conversation. Same model, same sandbox.",
  },
  {
    completion: "/sessions",
    help: "List hyperagent sessions (use --all for full list)",
    detail:
      "Shows hyperagent sessions only (filters out VS Code\n" +
      "and other Copilot clients). First 10 by default.\n" +
      "Use /sessions --all to show every hyperagent session.",
  },
  {
    completion: "/resume ",
    help: "Resume a previous hyperagent session",
    detail:
      "Restores conversation context from a saved session.\n" +
      "Omit the id to resume the most recent hyperagent session.\n" +
      "Pass a full or partial session ID (prefix optional).\n" +
      "Example: /resume abc123",
  },
  {
    completion: "/history",
    help: "Show recent conversation messages (/history [n])",
    detail:
      "Retrieves and displays the last N messages from the\n" +
      "current session (default: 10). Shows user and assistant\n" +
      "messages with a short preview of each.\n" +
      "Useful for verifying what context the LLM has after\n" +
      "compaction, or reviewing the conversation flow.\n" +
      "Example: /history 20",
  },

  // ── Plugins ──────────────────────────────────────────────
  {
    completion: "/plugin list",
    help: "List discovered plugins with state & approval",
    group: "Plugins",
    detail:
      "Re-scans the plugins/ directory and shows all plugins\n" +
      "with their current state (discovered/audited/enabled),\n" +
      "risk level, and approval status.",
  },
  {
    completion: "/plugin info ",
    help: "Show plugin details & config options",
    group: "Plugins",
    detail:
      "Displays manifest metadata, available config fields\n" +
      "with types/defaults/constraints, and an example\n" +
      "/plugin enable command. Run this before enabling a\n" +
      "plugin to understand what you can configure.",
  },
  {
    completion: "/plugin enable ",
    help: "Audit, configure, and enable a plugin [key=value ...]",
    detail:
      "Full lifecycle: audit → configure → enable.\n" +
      "Enabling is SESSION-SCOPED — the plugin starts disabled\n" +
      "again next session. It does NOT auto-approve.\n" +
      "Inline config overrides schema defaults:\n" +
      "  /plugin enable fs-read baseDir=/tmp maxFileSizeKb=2048\n" +
      "Approved plugins skip the audit step (fast-path).",
  },
  {
    completion: "/plugin disable ",
    help: "Disable an enabled plugin",
    detail:
      "Removes the plugin's host functions from the next\n" +
      "sandbox rebuild. Does not affect approval status.",
  },
  {
    completion: "/plugin approve ",
    help: "Approve a plugin (persists across sessions)",
    detail:
      "Marks a plugin as trusted — persists to\n" +
      "~/.hyperagent/approved-plugins.json.\n" +
      "Approved plugins skip the audit on /plugin enable.\n" +
      "Approval is invalidated if the plugin source changes\n" +
      "(SHA-256 content hash mismatch → must re-audit).\n" +
      "Requires a prior audit (/plugin enable or /plugin audit).",
  },
  {
    completion: "/plugin unapprove ",
    help: "Remove plugin approval",
    detail:
      "Revokes persistent approval. The plugin stays enabled\n" +
      "for this session but will require a full audit on next\n" +
      "/plugin enable.",
  },
  {
    completion: "/plugin audit ",
    help: "Force re-audit a plugin (--verbose for full findings)",
    detail:
      "Runs static scan + LLM deep audit on the plugin source,\n" +
      "even if a cached result exists. Useful after editing the\n" +
      "plugin source code. Add --verbose or -v for detailed findings.",
  },

  // ── MCP Servers ───────────────────────────────────────────
  {
    completion: "/mcp list",
    help: "List configured MCP servers with connection state",
    group: "MCP Servers",
    detail:
      "Shows all MCP servers from ~/.hyperagent/config.json with\n" +
      "their current state (idle, connected, error) and tool count.\n" +
      "Requires the 'mcp' plugin to be enabled first.",
  },
  {
    completion: "/mcp enable ",
    help: "Approve and connect to an MCP server",
    group: "MCP Servers",
    detail:
      "Connects to the named MCP server, spawning its process and\n" +
      "discovering available tools. First connection requires approval\n" +
      "(command/args shown, env vars masked). Once approved, the\n" +
      "server's tools are available as host:mcp-<name> modules.",
  },
  {
    completion: "/mcp disable ",
    help: "Disconnect from an MCP server",
    group: "MCP Servers",
    detail:
      "Disconnects from the named server for this session.\n" +
      "The server process is terminated. Approval is preserved.",
  },
  {
    completion: "/mcp info ",
    help: "Show MCP server tools, schemas, and details",
    group: "MCP Servers",
    detail:
      "Displays the server's discovered tools with their input\n" +
      "schemas and descriptions. Useful for understanding what\n" +
      "functions are available before writing handler code.",
  },
  {
    completion: "/mcp approve ",
    help: "Pre-approve an MCP server without connecting",
    group: "MCP Servers",
    detail:
      "Approves the server's config (command + args hash) so that\n" +
      "future /mcp enable calls skip the approval prompt.",
  },
  {
    completion: "/mcp revoke ",
    help: "Revoke approval for an MCP server",
    group: "MCP Servers",
    detail:
      "Removes the stored approval. Next /mcp enable will require\n" +
      "re-approval with full command/args review.",
  },

  // ── General ──────────────────────────────────────────────
  {
    completion: "/profile list",
    help: "List available resource profiles",
    group: "General",
    detail:
      "Shows all built-in profiles with their limits, plugins,\n" +
      "and use cases. Profiles bundle common configurations into\n" +
      "named presets (e.g. file-builder, web-research).",
  },
  {
    completion: "/profile apply ",
    help: "Apply resource profile(s)",
    group: "General",
    detail:
      "Apply one or more profiles to configure limits and plugins.\n" +
      "Stack multiple by separating with spaces:\n" +
      "  /profile apply web-research heavy-compute\n" +
      "Profiles are additive — max of each limit, union of plugins.\n" +
      "Plugin config is prompted interactively during enable.\n" +
      "(The LLM tool version supports pluginConfig for inline config.)",
  },
  {
    completion: "/profile show",
    help: "Show current effective configuration",
    group: "General",
    detail:
      "Displays the current resource limits and enabled plugins.\n" +
      "Shows whether current config matches any built-in profile.",
  },
  {
    completion: "/module list",
    help: "List all available modules",
    group: "General",
    detail:
      "Shows system and user modules with exports, descriptions,\n" +
      "and import syntax (ha:<name>).",
  },
  {
    completion: "/module info ",
    help: "Detailed module info + exports",
    group: "General",
    detail:
      "Shows full source, exported functions with JSDoc,\n" +
      "author (system/user), mutable status, and creation date.",
  },
  {
    completion: "/module delete ",
    help: "Delete a user module",
    group: "General",
    detail:
      "Removes a user-created module from disk. System modules\n" +
      "cannot be deleted.",
  },
  {
    completion: "/module lock ",
    help: "Lock a module (prevent LLM modification)",
    group: "General",
    detail:
      "Sets mutable=false. The LLM cannot overwrite or delete locked modules.",
  },
  {
    completion: "/module unlock ",
    help: "Unlock a module (allow LLM modification)",
    group: "General",
    detail: "Sets mutable=true. System modules cannot be unlocked.",
  },
  {
    completion: "/config",
    help: "Show current configuration",
    group: "General",
    detail:
      "Displays model, timeouts, buffer sizes, heap/scratch,\n" +
      "plugin status, and other runtime settings.",
  },
  {
    completion: "/skills",
    help: "List and invoke available skills",
    group: "General",
    detail:
      "/skills — list all available skills\n" +
      "/skills <name> — invoke a skill (injects domain expertise)\n" +
      "Skills are SKILL.md files in the skills/ directory.\n" +
      "Invoke a skill to get specialised instructions for a task.\n" +
      "Example: /skills pptx-expert — expert at building PPTX presentations.",
  },
  {
    completion: "/help",
    help: "Show this help (or /help <topic> for details)",
    detail:
      "Use /help alone for the full list.\n" +
      "Use /help <group> for a group (e.g. /help plugin, /help mcp, /help timeout).\n" +
      "Use /help <command> for one command (e.g. /help show-code).",
  },
  {
    completion: "/clear",
    help: "Clear the terminal screen",
    group: "General",
    detail:
      'Clears all terminal output. Same as Ctrl+L or the "clear" shell command.',
  },
  {
    completion: "/exit",
    help: "Exit the agent",
    detail: 'Saves session state and exits cleanly. Same as typing "exit".',
  },
]);

/** Pre-computed completion strings for the readline completer. */
export const COMPLETION_STRINGS: readonly string[] = [
  ...COMMANDS.map((c) => c.completion),
  // Aliases — /plugins is shorthand for /plugin
  "/plugins list",
  "/plugins info ",
  "/plugins enable ",
  "/plugins disable ",
  "/plugins approve ",
  "/plugins unapprove ",
  "/plugins audit ",
];

/**
 * Render the full help text from the COMMANDS registry.
 * Groups are separated by blank lines with a header comment.
 */
export function renderHelp(): string {
  const lines: string[] = [
    `  ${C.label("📖 Available commands")} ${C.dim("(type /help <topic> for details):")}`,
  ];
  let lastGroup: string | undefined;
  for (const cmd of COMMANDS) {
    if (cmd.group && cmd.group !== lastGroup) {
      lines.push("");
      lastGroup = cmd.group;
    }
    const display = cmd.completion.trimEnd();
    lines.push(`     ${C.info(display.padEnd(25))} ${C.dim(cmd.help)}`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Normalise a user-supplied help topic into a canonical group name.
 * Handles common aliases so users don't have to guess the exact group.
 */
const GROUP_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  toggle: "Toggles",
  toggles: "Toggles",
  timeout: "Timeouts & Buffers",
  timeouts: "Timeouts & Buffers",
  buffer: "Timeouts & Buffers",
  buffers: "Timeouts & Buffers",
  session: "Session",
  sessions: "Session",
  plugin: "Plugins",
  plugins: "Plugins",
  mcp: "MCP Servers",
  general: "General",
});

/**
 * Render help for a specific topic — either a group name or a command.
 *
 * Resolution order:
 *   1. Exact group match (via GROUP_ALIASES)
 *   2. Exact command match (with or without leading /)
 *   3. Substring match on completion strings
 *
 * Returns null if nothing matched.
 */
export function renderTopicHelp(topic: string): string | null {
  const key = topic.toLowerCase().replace(/^\//, "");

  // ── 1. Group match ──────────────────────────────────────
  const groupName = GROUP_ALIASES[key];
  if (groupName) {
    const cmds = COMMANDS.filter((c) => resolveGroup(c) === groupName);
    if (cmds.length === 0) return null;
    const lines = [`  📖 ${groupName}:`];
    for (const c of cmds) {
      const display = c.completion.trimEnd();
      lines.push(`     ${display.padEnd(25)} ${c.help}`);
      if (c.detail) {
        for (const dl of c.detail.split("\n")) {
          lines.push(`       ${dl}`);
        }
        lines.push("");
      }
    }
    return lines.join("\n");
  }

  // ── 2. Exact command match ──────────────────────────────
  const withSlash = key.startsWith("/") ? key : `/${key}`;
  let match = COMMANDS.find(
    (c) => c.completion.trimEnd().toLowerCase() === withSlash,
  );

  // ── 3. Substring fallback ───────────────────────────────
  if (!match) {
    match = COMMANDS.find((c) => c.completion.toLowerCase().includes(key));
  }

  if (!match) return null;

  const display = match.completion.trimEnd();
  const lines = [`  📖 ${display}`, `     ${match.help}`];
  if (match.detail) {
    lines.push("");
    for (const dl of match.detail.split("\n")) {
      lines.push(`     ${dl}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Resolve which group a command belongs to by walking backwards
 * through COMMANDS until we find one with a group set.
 */
function resolveGroup(entry: CommandEntry): string | undefined {
  let group: string | undefined;
  for (const c of COMMANDS) {
    if (c.group) group = c.group;
    if (c === entry) return group;
  }
  return undefined;
}
