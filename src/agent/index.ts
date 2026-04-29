#!/usr/bin/env -S npx tsx

// ── HyperAgent — Hyperlight JS × Copilot SDK Agent ──────────────────
//
// An interactive AI agent that uses the GitHub Copilot SDK to provide
// conversational access to a Hyperlight sandboxed JavaScript executor.
//
// Think of it as giving an AI a calculator, except the calculator can
// run arbitrary safe JavaScript inside a hardware-isolated micro-VM.
//
// ⚠️  The @github/copilot-sdk is in Technical Preview. The API surface
//     may change between releases. Pin your dependency version.
//
// Usage:
//   npx hyperagent                              # Launch with defaults
//   npx hyperagent --model claude-opus-4.6       # Use a specific model
//   npx hyperagent --cpu-timeout 2000           # 2s CPU limit
//   npx hyperagent --show-code                  # Log generated JS to file
//   npx hyperagent --show-timing                # Log timing breakdown to file
//   npx hyperagent --list-models                # List available models and exit
//   npx hyperagent --resume                     # Resume last session
//   npx hyperagent --resume <id>                # Resume a specific session
//   npx hyperagent --plugins-dir /path/to/plugins # Custom plugins directory
//
// ─────────────────────────────────────────────────────────────────────

import {
  CopilotClient,
  CopilotSession,
  defineTool,
  approveAll,
  type AssistantMessageEvent,
  type ModelInfo,
} from "@github/copilot-sdk";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

import { createSandboxTool, type PluginRegistration } from "../sandbox/tool.js";
import { Transcript } from "./transcript.js";
import {
  createPluginManager,
  contentHash,
  computePluginHash,
  loadOperatorConfig,
  exceedsRiskThreshold,
  resolvePluginSource,
} from "../plugin-system/manager.js";
import { deepAudit, formatAuditResult } from "../plugin-system/auditor.js";
import { extractSuggestedCommands } from "./command-suggestions.js";
import { ANSI, C } from "./ansi.js";
import { type CliConfig, parseCliArgs } from "./cli-parser.js";
import { getVersion, getVersionString } from "./version.js";
import { closestMatch } from "./fuzzy-match.js";
import { suggestBufferIncreaseIfNeeded } from "./buffer-overflow.js";
import { ALLOWED_TOOLS } from "./tool-gating.js";
import {
  handleSlashCommand as handleSlashCommandImpl,
  type SlashCommandDeps,
} from "./slash-commands.js";
import { COMPLETION_STRINGS, renderHelp, renderTopicHelp } from "./commands.js";
import { buildSystemMessage } from "./system-message.js";
import { Spinner } from "./spinner.js";
import { makeAuditProgressCallback } from "./audit-progress.js";
import { createAgentState, type AgentState } from "./state.js";
import {
  enableAbortOnEsc,
  disableAbortOnEsc,
  createAuditAbortHandler,
} from "./abort-controller.js";
import { createErrorHandler } from "./error-handler.js";
import { createUserInputHandler } from "./user-input-handler.js";
import { setupCtrlRHandler } from "./reverse-search.js";
import { applySandboxConfig, getEffectiveConfig } from "./config-actions.js";
import {
  mergeProfiles,
  getProfileNames,
  formatAllProfiles,
  PROFILES,
  type ProfilePlugin,
} from "./profiles.js";
import {
  saveModule,
  loadModule,
  loadModuleAsync,
  listModules,
  deleteModuleFromDisk,
  validateModuleName,
  findOverlappingExports,
  getModulesDir,
  type ModuleInfo,
  type ModuleHints,
} from "./module-store.js";
import {
  formatExports,
  formatSignatures,
  formatCompact,
} from "./format-exports.js";
import { loadPatterns } from "./pattern-loader.js";
import { loadSkills } from "./skill-loader.js";
import { runSuggestApproach } from "./approach-resolver.js";
import { validatePath } from "../../plugins/shared/path-jail.js";
import {
  validateJavaScript as validateJavaScriptGuest,
  extractModuleMetadata as extractModuleMetadataGuest,
  enableAnalysisGuest,
  checkAvailability as checkAnalysisGuest,
  shutdown as shutdownAnalysisGuest,
  type ValidationContext,
} from "./analysis-guest.js";
import {
  formatUsageStats,
  renderReasoningDelta,
  renderReasoningTransition,
  printUsageStats,
  printExtendedReasoningNotice,
  formatTokenSummary,
} from "./llm-output.js";

// ── Session Timing ───────────────────────────────────────────────────
// Track session start time to display total elapsed time on exit.

const SESSION_START_TIME = Date.now();

/**
 * Format elapsed time since session start as human-readable string.
 * Examples: "45s", "2m 15s", "1h 23m"
 */
function formatSessionDuration(): string {
  const elapsed = Date.now() - SESSION_START_TIME;
  const totalSeconds = Math.floor(elapsed / 1000);

  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/**
 * Print session token summary to console.
 * Called at all exit points (interactive, --prompt, SIGINT).
 */
function printExitTokenSummary(): void {
  if (state.totalInputTokens === 0 && state.totalOutputTokens === 0) return;
  const lines = formatTokenSummary(state);
  console.log(); // blank line before summary
  for (const line of lines) {
    console.log(`  ${line}`);
  }
}

// ── Paths ────────────────────────────────────────────────────────────

const __agentFilename = fileURLToPath(import.meta.url);
const __agentDirname = dirname(__agentFilename);
// Runtime content root — where plugins/, skills/, patterns/, builtin-modules/ live.
// In dev mode (tsx): two levels up from src/agent/ → repo root.
// In binary mode (dist/lib/hyperagent.cjs): same directory as the bundle,
// because build-binary.js copies runtime content into dist/lib/.
const CONTENT_ROOT = existsSync(join(__agentDirname, "plugins"))
  ? __agentDirname
  : resolve(__agentDirname, "../..");

// ── Parse CLI BEFORE any side effects ────────────────────────────────
// CLI flags override env vars. We write them back to process.env so
// that createSandboxTool() (which reads env vars) picks them up.

const cli = parseCliArgs();

// ── --version: print version and exit ────────────────────────────────
if (cli.showVersion) {
  console.log(getVersionString());
  process.exit(0);
}

// ── Standalone MCP setup/config commands: run and exit ──────────────
if (cli.mcpSetupCommand) {
  runMCPSetupCommand(cli.mcpSetupCommand, { contentRoot: CONTENT_ROOT });
  process.exit(0);
}

// Propagate CLI → env vars (so sandbox-tool.js and other modules pick them up)
process.env.COPILOT_MODEL = cli.model;
process.env.HYPERLIGHT_CPU_TIMEOUT_MS = cli.cpuTimeout;
process.env.HYPERLIGHT_WALL_TIMEOUT_MS = cli.wallTimeout;
process.env.HYPERAGENT_SEND_TIMEOUT_MS = cli.sendTimeout;
process.env.HYPERLIGHT_HEAP_SIZE_MB = cli.heapSize;
process.env.HYPERLIGHT_SCRATCH_SIZE_MB = cli.scratchSize;

// Propagate output threshold to SDK env vars so the CLI's own large-output
// handling aligns with our threshold. We handle interception ourselves in
// the tool handler (using skipLargeOutputProcessing), but set these so the
// CLI's VB() fallback uses the same value.
process.env.HYPERAGENT_OUTPUT_THRESHOLD_BYTES = cli.outputThreshold;
process.env.COPILOT_LARGE_OUTPUT_THRESHOLD_BYTES = cli.outputThreshold;
process.env.COPILOT_LARGE_OUTPUT_MAX_BYTES = cli.outputThreshold;

// ── Windows WHP surrogate pool sizing ────────────────────────────────
// On Windows, two independent SurrogateProcessManagers (hyperlight-js +
// code-validator) each pre-create a pool of surrogate processes. Keep the
// initial pool small and let on-demand growth handle spikes.
if (process.platform === "win32") {
  process.env.HYPERLIGHT_INITIAL_SURROGATES ??= "2";
  process.env.HYPERLIGHT_MAX_SURROGATES ??= "24";
}

// ── Cleanup on exit ──────────────────────────────────────────────────
// Remove auto-saved large output files from the results/ subdirectory
// when the process exits. Best-effort — don't block or throw.
function cleanupResultsDir(): void {
  try {
    const baseDir = getPluginBaseDir("fs-write");
    if (!baseDir) return;
    const resultsDir = resolve(baseDir, "results");
    if (existsSync(resultsDir)) {
      rmSync(resultsDir, { recursive: true, force: true });
    }
  } catch {
    // Best-effort — swallow errors during shutdown
  }
}
process.on("exit", cleanupResultsDir);

// ── Apply --profile limits at startup ────────────────────────────────
// Profile limits override CLI defaults by taking the MAX of each.
// Plugins are NOT auto-enabled — use /profile apply in the REPL.
if (cli.profile) {
  const profileNames = cli.profile.split(/\s+/).filter(Boolean);
  const merged = mergeProfiles(profileNames);
  if (merged.error) {
    console.error(`❌ --profile: ${merged.error}`);
    process.exit(1);
  }
  // Override env vars with profile limits (only if profile value is higher)
  if (merged.limits.cpuTimeoutMs !== undefined) {
    const current = parseInt(process.env.HYPERLIGHT_CPU_TIMEOUT_MS || "0", 10);
    if (merged.limits.cpuTimeoutMs > current) {
      process.env.HYPERLIGHT_CPU_TIMEOUT_MS = String(
        merged.limits.cpuTimeoutMs,
      );
    }
  }
  if (merged.limits.wallTimeoutMs !== undefined) {
    const current = parseInt(process.env.HYPERLIGHT_WALL_TIMEOUT_MS || "0", 10);
    if (merged.limits.wallTimeoutMs > current) {
      process.env.HYPERLIGHT_WALL_TIMEOUT_MS = String(
        merged.limits.wallTimeoutMs,
      );
    }
  }
  if (merged.limits.heapMb !== undefined) {
    const current = parseInt(process.env.HYPERLIGHT_HEAP_SIZE_MB || "0", 10);
    if (merged.limits.heapMb > current) {
      process.env.HYPERLIGHT_HEAP_SIZE_MB = String(merged.limits.heapMb);
    }
  }
  if (merged.limits.scratchMb !== undefined) {
    const current = parseInt(process.env.HYPERLIGHT_SCRATCH_SIZE_MB || "0", 10);
    if (merged.limits.scratchMb > current) {
      process.env.HYPERLIGHT_SCRATCH_SIZE_MB = String(merged.limits.scratchMb);
    }
  }
  // Note: input/output buffer profile limits are not applied via env vars
  // because sandbox-tool.js uses fixed defaults. Use /profile apply or
  // configure_sandbox at runtime for buffer changes.
}

if (cli.debug) process.env.HYPERAGENT_DEBUG = "1";

// Conditionally allow the tuning tool through the gate
if (cli.tune) ALLOWED_TOOLS.add("llm_thought");

// ── Debug Log File ───────────────────────────────────────────────────
// When debug is enabled, ALL diagnostic output goes to a timestamped
// file in /tmp/hyperlight-js/. No console.error pollution.
import {
  createWriteStream,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  copyFileSync,
  unlinkSync,
  rmSync,
  type WriteStream,
} from "node:fs";

// All log files go to ~/.hyperagent/logs/ — one tidy location.
const LOGS_DIR = join(homedir(), ".hyperagent", "logs");
let debugStream: WriteStream | null = null;

// ── Persistent Command History ────────────────────────────────────────
// Like bash's ~/.bash_history — remembers what you typed between sessions.
// Cross-platform: uses HOME (Unix) or USERPROFILE (Windows) or homedir().
const HISTORY_FILE = join(homedir(), ".hyperagent_history");
const HISTORY_SIZE = 1000;

/**
 * Load command history from disk for readline.
 * Returns newest-first (readline's expected format).
 * Silently returns empty array on any error.
 *
 * Multi-line entries are stored with embedded newlines escaped as \x00n.
 * Literal NUL bytes (rare) are stored as \x00\x00.
 * Entries are separated by record separator (ASCII 30).
 */
function loadHistory(): string[] {
  try {
    if (!existsSync(HISTORY_FILE)) return [];
    let content = readFileSync(HISTORY_FILE, "utf-8");
    // Remove trailing newline only (not leading whitespace which may be part of entries)
    if (content.endsWith("\n")) {
      content = content.slice(0, -1);
    }
    if (!content) return [];

    // Split by record separator, unescape each entry
    const entries = content.split("\x1e").map((entry) =>
      // Unescape: \x00\x00 -> NUL, \x00n -> newline (order matters)
      entry.replace(/\x00\x00/g, "\x00").replace(/\x00n/g, "\n"),
    );

    // File stores oldest-first (like bash), readline wants newest-first
    return entries.filter(Boolean).reverse();
  } catch {
    return [];
  }
}

/**
 * Save command history to disk.
 * Receives newest-first from readline, writes oldest-first (like bash).
 * Filters out invalid slash commands (starting with / but not matching any known command).
 * Silent no-op on error — history persistence is non-critical.
 *
 * Multi-line entries have embedded newlines escaped as \x00n.
 * Literal NUL bytes (rare) are stored as \x00\x00.
 * Entries are separated by record separator (ASCII 30) to distinguish from
 * escaped newlines within entries.
 */
function saveHistory(history: string[]): void {
  try {
    // Filter out invalid slash commands
    const filtered = history.filter((cmd) => {
      if (!cmd.startsWith("/")) return true; // Not a slash command
      // Extract the base command (first word, lowercased)
      const baseCmd = cmd.split(/\s+/)[0].toLowerCase();
      // Check if any completion string starts with this base command
      // COMPLETION_STRINGS has entries like "/plugin enable " — we match the start
      return COMPLETION_STRINGS.some((c) =>
        c.toLowerCase().startsWith(baseCmd),
      );
    });

    // Escape: NUL -> \x00\x00, newline -> \x00n (order matters - NUL first)
    const escaped = filtered.map((entry) =>
      entry.replace(/\x00/g, "\x00\x00").replace(/\n/g, "\x00n"),
    );

    // Reverse to oldest-first for file storage, use record separator between entries
    writeFileSync(HISTORY_FILE, escaped.slice().reverse().join("\x1e") + "\n");
  } catch {
    // Silent failure — can't save history, not the end of the world
  }
}

// ── Multi-line Paste Handling ─────────────────────────────────────────
// When text is pasted, all lines arrive within milliseconds. These helpers
// capture pasted content as a single block and drain any stale buffered
// lines before critical prompts.

/**
 * Like rl.question() but captures multi-line pasted content.
 *
 * When text is pasted, all lines arrive within milliseconds. We use a
 * short timeout to collect them all, then return as a single string
 * with newlines preserved.
 *
 * @param rl - readline interface
 * @param prompt - prompt string to display
 * @param collectWindowMs - time to wait for additional lines (default 100ms)
 */
async function questionCapturingPaste(
  rl: readline.Interface,
  prompt: string,
  collectWindowMs = 100,
): Promise<string> {
  process.stdout.write(prompt);

  return new Promise((resolve) => {
    const lines: string[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;

    const lineHandler = (line: string) => {
      lines.push(line);

      // Reset the timer on each line
      if (timer) clearTimeout(timer);

      timer = setTimeout(() => {
        // No more lines arrived within window - paste complete
        rl.off("line", lineHandler);
        const combined = lines.join("\n");

        // Record when user input was received - used to skip draining
        // if a tool prompt happens immediately after (those buffered
        // lines are part of the paste, not stale content).
        state.lastUserInputTime = Date.now();

        // Add the combined multi-line input to history.
        // Readline only adds to history via question(), but we're using
        // a custom line handler, so we need to add it manually.
        // This ensures the full pasted content is recalled as one entry.
        if (combined.trim()) {
          // Access readline's internal history array
          const internal = rl as unknown as { history: string[] };
          if (internal.history) {
            // Remove duplicate if exists (matches removeHistoryDuplicates behavior)
            const idx = internal.history.indexOf(combined);
            if (idx !== -1) {
              internal.history.splice(idx, 1);
            }
            // Add to front of history (newest first)
            internal.history.unshift(combined);
            // Emit 'history' event so saveHistory() persists it
            rl.emit("history", internal.history);
          }
        }

        resolve(combined);
      }, collectWindowMs);
    };

    rl.on("line", lineHandler);
  });
}

/**
 * Drain any buffered lines from a paste before showing a critical prompt.
 * Returns the discarded content for warning display.
 *
 * We watch for 'line' events with a short timeout. If lines arrive quickly,
 * they're buffered paste content. Once the timeout expires without new lines,
 * we're done draining.
 *
 * Note: This works because readline processes buffered stdin data when
 * the event loop runs. The short wait gives buffered lines a chance to
 * be emitted.
 *
 * @param rl - readline interface
 * @param waitMs - time to wait for buffered lines (default 80ms)
 */
async function drainBufferedLines(
  rl: readline.Interface,
  waitMs = 80,
): Promise<string[]> {
  const discarded: string[] = [];

  // Check if readline has anything in its current line buffer
  const internal = rl as unknown as { line: string; cursor: number };
  if (internal.line && internal.line.trim()) {
    discarded.push(internal.line);
    internal.line = "";
    internal.cursor = 0;
  }

  // Wait for any buffered lines to arrive via 'line' events
  // Readline will emit these as it processes buffered stdin data
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;

    const handler = (line: string) => {
      if (line.trim()) {
        discarded.push(line);
      }
      // Reset timer - wait for more lines
      clearTimeout(timer);
      timer = setTimeout(finish, waitMs);
    };

    const finish = () => {
      rl.off("line", handler);
      resolve(discarded);
    };

    // Start listening for line events
    rl.on("line", handler);

    // Set initial timeout
    timer = setTimeout(finish, waitMs);
  });
}

/**
 * Drain buffered lines and warn the user if content was discarded.
 * Use this before critical prompts (approval, config fields) to ensure
 * stale paste content doesn't accidentally answer them.
 *
 * IMPORTANT: If user input was received very recently (within 500ms),
 * we skip draining entirely. This prevents discarding the tail of a
 * multi-line paste when the model responds quickly with a tool call.
 */
async function drainAndWarn(rl: readline.Interface): Promise<void> {
  // Skip draining if we just received user input - those buffered lines
  // are part of the current paste, not stale content from before.
  const DRAIN_GRACE_MS = 500;
  if (Date.now() - state.lastUserInputTime < DRAIN_GRACE_MS) {
    return;
  }

  const discarded = await drainBufferedLines(rl);
  if (discarded.length > 0) {
    console.log(
      C.warn(`⚠️  Discarded ${discarded.length} buffered line(s) from paste:`),
    );
    for (const line of discarded.slice(0, 2)) {
      const truncated = line.length > 50 ? line.slice(0, 50) + "..." : line;
      console.log(C.dim(`     "${truncated}"`));
    }
    if (discarded.length > 2) {
      console.log(C.dim(`     ...and ${discarded.length - 2} more`));
    }
  }
}

/**
 * Prompt the user for input during tool execution.
 *
 * Wraps rl.question() with proper keep-alive timer management:
 * - Sets state.waitingForUserInput = true before prompting
 * - Clears the keep-alive timer (it's the user's turn now)
 * - Restores state.waitingForUserInput = false after user responds
 *
 * This prevents the inactivity timer from firing while the user is
 * thinking about an approval prompt.
 */
async function promptUser(
  rl: readline.Interface,
  prompt: string,
): Promise<string> {
  // Pause keep-alive timer — it's the user's turn
  state.waitingForUserInput = true;
  if (state.keepAliveTimeoutId) {
    clearTimeout(state.keepAliveTimeoutId);
    state.keepAliveTimeoutId = null;
  }

  try {
    return await rl.question(prompt);
  } finally {
    // Restore — model's turn resumes after user responds
    state.waitingForUserInput = false;
  }
}

/** Write a debug line to the log file (no-op when debug is off). */
function debugLog(msg: string): void {
  if (!debugStream) return;
  debugStream.write(`[${new Date().toISOString()}] ${msg}\n`);
}

// Create the debug log file at startup if debug mode is on
if (cli.debug) {
  mkdirSync(LOGS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const debugLogPath = join(LOGS_DIR, `agent-debug-${ts}.log`);
  debugStream = createWriteStream(debugLogPath, { flags: "a" });
  console.log(`  📝 Debug log: ${debugLogPath}`);
}

// ── Tune Log File ────────────────────────────────────────────────────
// When --tune is enabled, write LLM decision/reasoning data to a JSONL
// file. Each line is a JSON object with timestamp, category, message,
// and turnNumber. Used for prompt tuning — analysing why the LLM makes
// specific choices and where guidance needs adjustment.

let tuneStream: WriteStream | null = null;
let tuneLogPath: string | null = null;
/** Turn counter — incremented each time the user sends a message. */
let tuneTurnNumber = 0;

if (cli.tune) {
  mkdirSync(LOGS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  tuneLogPath = join(LOGS_DIR, `tune-${ts}.jsonl`);
  tuneStream = createWriteStream(tuneLogPath, { flags: "a" });
  console.log(`  🎛️  Tune log: ${tuneLogPath}`);
}

/**
 * Valid tuning log categories.
 * - decision: explains why a particular approach was chosen
 * - concern: flags a potential problem or constraint worry
 * - constraint: notes a specific limit or boundary being considered
 * - alternative_rejected: records an approach that was considered but not taken
 */
type TuneCategory =
  | "decision"
  | "concern"
  | "constraint"
  | "alternative_rejected";

const TUNE_CATEGORIES = new Set<string>([
  "decision",
  "concern",
  "constraint",
  "alternative_rejected",
]);

/** Write a structured tune entry to the JSONL file. No-op when tune is off. */
function writeTuneEntry(category: TuneCategory, message: string): void {
  if (!tuneStream) return;
  const entry = {
    timestamp: new Date().toISOString(),
    turn: tuneTurnNumber,
    category,
    message,
  };
  tuneStream.write(JSON.stringify(entry) + "\n");
}

// Suppress Node.js experimental warnings (e.g. SQLite) from the
// Copilot SDK's internal CLI subprocess. Without this, noisy
// "[CLI subprocess] ExperimentalWarning" lines pollute the REPL.
process.env.NODE_NO_WARNINGS = "1";

// Timestamped log file paths — all go to ~/.hyperagent/logs/
if (cli.showCode) {
  mkdirSync(LOGS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  process.env.HYPERAGENT_CODE_LOG = join(LOGS_DIR, `hyperagent-code-${ts}.log`);
}
if (cli.showTiming) {
  mkdirSync(LOGS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  process.env.HYPERAGENT_TIMING_LOG = join(
    LOGS_DIR,
    `hyperagent-timing-${ts}.jsonl`,
  );
}

// ── Agent-level Timeouts ─────────────────────────────────────────────

/**
 * Inactivity timeout for sendAndWait (ms). Unlike the SDK's fixed
 * absolute timeout, our custom keep-alive implementation resets this
 * timer on EVERY session event (tool start/complete, message deltas,
 * etc.). The timeout only fires if the agent truly goes silent.
 *
 * Default: 120 000ms (2 minutes). With keep-alive, this is generous —
 * even a 5-minute chain of tool calls stays alive as long as events
 * keep flowing.
 */
const DEFAULT_SEND_TIMEOUT_MS = 300_000;

/**
 * Effective inactivity timeout, resolved from CLI config.
 * Can be overridden at runtime via `/timeout send <ms>`.
 */
const SEND_TIMEOUT_MS: number =
  parseInt(cli.sendTimeout, 10) || DEFAULT_SEND_TIMEOUT_MS;

// ── Sandbox Setup ────────────────────────────────────────────────────

/**
 * Create the sandbox tool instance. Configuration is resolved from
 * environment variables (see shared/sandbox-tool.js for details).
 */
const sandbox = createSandboxTool();

/**
 * Session transcript recorder. Created at module level so the SIGINT
 * handler can access it. Start is deferred until main() or /transcript.
 */
const transcript = new Transcript();

// ── Plugin Manager ───────────────────────────────────────────────────
//
// Discovers plugins from the ./plugins directory (gitignored for user
// customisation). Plugins register host functions on the sandbox proto
// that guest JavaScript can import.

/**
 * Plugin manager — discovers, audits, configures, and manages
 * lifecycle of sandbox plugins. Points at ./plugins/ by default,
 * overridable via HYPERAGENT_PLUGINS_DIR env var or --plugins-dir flag.
 */
const pluginsDir = cli.pluginsDir || join(CONTENT_ROOT, "plugins");
const pluginManager = createPluginManager(pluginsDir);

/**
 * Operator-level security policy, loaded from ~/.hyperagent/config.json.
 * Controls the maximum risk level a plugin can have to be enabled or approved.
 * Defaults to MEDIUM — plugins rated HIGH or CRITICAL are blocked.
 */
const operatorConfig = loadOperatorConfig();

// Run initial discovery (non-blocking, sync fs reads)
const discoveredCount = pluginManager.discover();
if (discoveredCount > 0) {
  console.error(`[plugins] Discovered ${discoveredCount} plugin(s)`);
}

// Pre-approve the MCP gateway plugin if it exists. The gateway is a
// boolean sentinel (zero risk) and its source hash changes on every
// npm install rebuild. Without this, syncPluginsToSandbox would refuse
// to load it due to a stale approval hash from a previous session.
{
  const mcpGateway = pluginManager.getPlugin("mcp");
  if (mcpGateway) {
    const mcpHash = computePluginHash(mcpGateway.dir);
    if (mcpHash) {
      pluginManager.setAuditResult("mcp", {
        contentHash: mcpHash,
        auditedAt: new Date().toISOString(),
        findings: [],
        riskLevel: "LOW",
        summary: "Boolean sentinel — exposes a single read-only status check.",
        descriptionAccurate: true,
        capabilities: ["MCP gateway status"],
        riskReasons: ["No filesystem, network, or exec capabilities"],
        recommendation: {
          verdict: "approve",
          reason: "Auto-approved: gateway sentinel",
        },
      });
      pluginManager.approve("mcp");
    }
  }
}

// ── MCP Integration ──────────────────────────────────────────────────
import { parseMCPConfig } from "./mcp/config.js";
import {
  isMCPHttpConfig,
  isMCPStdioConfig,
  mcpConfigDisplayString,
  type MCPToolSchema,
} from "./mcp/types.js";
import {
  createMCPClientManager,
  type MCPClientManager,
} from "./mcp/client-manager.js";
import {
  createMCPPluginAdapter,
  generateMCPDeclarations,
  type WriteSafetyGate,
} from "./mcp/plugin-adapter.js";
import {
  loadMCPApprovalStore,
  isMCPApproved,
  approveMCPServer,
  auditMCPTools,
} from "./mcp/approval.js";
import { canAcquireSilently } from "./mcp/auth/msal-oauth.js";
import { runMCPSetupCommand } from "./mcp/setup-commands.js";
import { findMCPTool, selectMCPTools } from "./mcp/tool-utils.js";

// Load MCP config from ~/.hyperagent/config.json
let mcpManager: MCPClientManager | null = null;

{
  const configPath = join(homedir(), ".hyperagent", "config.json");
  try {
    if (existsSync(configPath)) {
      const rawConfig = JSON.parse(readFileSync(configPath, "utf8"));
      if (rawConfig.mcpServers) {
        const { config: mcpConfig, errors } = parseMCPConfig(
          rawConfig.mcpServers,
        );
        if (errors.length > 0) {
          for (const e of errors) {
            console.error(`[mcp] Config error (${e.server}): ${e.message}`);
          }
        }
        if (mcpConfig.servers.size > 0) {
          mcpManager = createMCPClientManager();
          for (const [name, serverConfig] of mcpConfig.servers) {
            mcpManager.registerServer(name, serverConfig);
          }
          console.error(`[mcp] ${mcpConfig.servers.size} server(s) configured`);
        }
      }
    }
  } catch (err) {
    console.error(`[mcp] Failed to load config: ${(err as Error).message}`);
  }
}

/**
 * Synchronise enabled plugins with the sandbox. Called whenever
 * the sandbox dirty flag is set (plugin enabled/disabled).
 *
 * Loads each enabled plugin's source as a dynamic import and
 * wires the register() function into the sandbox's plugin array.
 *
 * SECURITY: Multiple checks happen BEFORE importing:
 * 1. Source hash verification — closes TOCTOU window
 * 2. Danger findings check — prevents register() from running if
 *    static analysis found dangerous patterns (eval, require, etc.)
 *
 * The danger findings check is critical: it prevents the register()
 * function from ever executing if dangerous code was detected. This
 * closes GAP 2 where malicious code could run in host context.
 */

/**
 * MCP write-safety gate.
 *
 * Intercepts non-read-only MCP tool calls before execution.
 * Read-only tools (readOnlyHint === true) bypass the gate entirely.
 *
 * Behaviour:
 *   - autoApprove mode → allow silently
 *   - already approved this session → allow silently
 *   - interactive TTY  → prompt user "[y/n]" (remembered for session)
 *   - no TTY           → refuse
 *
 * The gate runs on the host while the guest VM is paused, so prompting
 * the user is safe — there's no timeout risk from the sandbox side.
 */

/** Tools approved by the user during this session (server.tool keys). */
const mcpSessionApprovedTools = new Set<string>();

const mcpWriteSafetyGate: WriteSafetyGate = async (
  serverName,
  toolName,
  args,
  annotations,
) => {
  // Auto-approve mode → allow everything
  if (state.autoApprove) return true;

  // Already approved this tool in this session → allow silently
  const toolKey = `${serverName}.${toolName}`;
  if (mcpSessionApprovedTools.has(toolKey)) return true;

  // Build a concise summary of the args for the prompt
  const argSummary = Object.entries(args)
    .slice(0, 5) // Don't dump huge arg lists
    .map(([k, v]) => {
      const val = typeof v === "string" ? v.slice(0, 80) : JSON.stringify(v);
      return `   ${k}: ${val}`;
    })
    .join("\n");

  const label = annotations?.destructiveHint
    ? C.err("⚠️  MCP DESTRUCTIVE operation")
    : C.warn("⚠️  MCP write operation");

  console.log();
  console.log(`  ${label}: ${C.label(serverName)}.${C.label(toolName)}`);
  if (argSummary) {
    console.log(argSummary);
  }

  const rl = state.readlineInstance;
  if (!rl || !process.stdin.isTTY) {
    console.log(
      `  ${C.err("Refused")} — no interactive terminal to approve write operations.`,
    );
    return false;
  }

  await drainAndWarn(rl);
  const answer = await promptUser(rl, `  Allow? [y/n] `);
  const normalised = answer.trim().toLowerCase();
  const allowed = normalised === "y" || normalised === "yes";
  if (allowed) {
    // Remember for the rest of this session — don't re-prompt
    mcpSessionApprovedTools.add(toolKey);
  }
  return allowed;
};

async function syncPluginsToSandbox(): Promise<void> {
  const enabled = pluginManager.getEnabledPlugins();

  // Dynamic-import each enabled plugin to get the register fn
  const registrations = [];
  const loadErrors: string[] = [];
  for (const plugin of enabled) {
    // Resolve .ts (dev) or .js (npm/dist) — centralised in plugin-system
    const indexPath = resolvePluginSource(plugin.dir);

    // SECURITY CHECK 1: Verify source hasn't changed since audit/approval
    if (!pluginManager.verifySourceHash(plugin.manifest.name)) {
      const msg = `"${plugin.manifest.name}" source changed since audit — REFUSING to load. Re-run "/plugin enable ${plugin.manifest.name}" to re-audit.`;
      console.error(`[plugins] ⚠️  ${msg}`);
      loadErrors.push(msg);
      continue;
    }

    // SECURITY CHECK 2: Block plugins with danger-level static findings
    // This prevents register() from ever running if dangerous code detected
    const dangerFindings = pluginManager.getDangerFindings(
      plugin.manifest.name,
    );
    if (dangerFindings.length > 0) {
      const msg = `"${plugin.manifest.name}" has ${dangerFindings.length} DANGER finding(s) — REFUSING to load`;
      console.error(`[plugins] 🚫 ${msg}`);
      // Show ALL danger findings so user can see exactly what's blocking
      for (const finding of dangerFindings) {
        console.error(`[plugins]    • ${finding}`);
      }
      loadErrors.push(msg);
      continue;
    }

    try {
      // Dynamic import — each plugin exports createHostFunctions(config)
      // Use pathToFileURL for Windows compatibility (raw paths like C:\...
      // are rejected by the ESM loader which expects file:// URLs).
      const mod = await import(pathToFileURL(indexPath).href);
      if (typeof mod.createHostFunctions !== "function") {
        const msg = `"${plugin.manifest.name}" has no createHostFunctions() export`;
        console.error(`[plugins] ${msg}`);
        loadErrors.push(msg);
        continue;
      }
      registrations.push({
        name: plugin.manifest.name,
        createHostFunctions: mod.createHostFunctions,
        config: plugin.config,
        // SECURITY: Pass declared modules for runtime verification
        declaredModules: plugin.manifest.hostModules,
      });
    } catch (err) {
      const msg = `Failed to load "${plugin.manifest.name}": ${(err as Error).message}`;
      console.error(`[plugins] ${msg}`);
      loadErrors.push(msg);
    }
  }

  // HARD FAIL: If any enabled plugin failed to load, the user explicitly
  // asked for it and the LLM will try to use it. Silently continuing
  // leads to confusing "host:<module> not available" errors downstream.
  if (loadErrors.length > 0) {
    console.error();
    console.error(
      `  ${C.err("❌")} ${loadErrors.length} plugin(s) failed to load:`,
    );
    for (const msg of loadErrors) {
      console.error(`     • ${msg}`);
    }
    console.error();
    console.error(
      `  ${C.dim("Fix the issue and re-enable with /plugin enable <name>")}`,
    );
    console.error();
    // Disable the failed plugins so the state reflects reality
    for (const plugin of enabled) {
      const loaded = registrations.some((r) => r.name === plugin.manifest.name);
      if (!loaded) {
        pluginManager.disable(plugin.manifest.name);
      }
    }
  }

  // Add MCP server adapters for connected servers
  if (mcpManager) {
    const mcpPlugin = pluginManager.getPlugin("mcp");
    if (mcpPlugin && mcpPlugin.state === "enabled") {
      for (const conn of mcpManager.listServers()) {
        if (conn.state === "connected" && conn.tools.length > 0) {
          const adapter = createMCPPluginAdapter(
            conn,
            mcpManager,
            mcpWriteSafetyGate,
          );
          registrations.push(adapter);
        }
      }
    }
  }

  // Hand the registrations to the sandbox — it will rebuild on next call
  // Await is important: saves shared-state before invalidating the sandbox
  await sandbox.setPlugins(registrations);
}

// ── Mutable Agent State ──────────────────────────────────────────────
//
// All 22 mutable runtime variables bundled into a single typed record.
// Every function that reads or mutates state receives this explicitly —
// no more invisible closures over module globals.

const state = createAgentState(cli, {
  showCode: !!sandbox.config.codeLogPath,
  showTiming: !!sandbox.config.timingLogPath,
});

// Wire CLI --show-reasoning <level> to state.reasoningEffort
if (cli.showReasoning) {
  state.reasoningEffort = cli.showReasoning as
    | "low"
    | "medium"
    | "high"
    | "xhigh";
  state.sessionNeedsRebuild = true;
}

/**
 * Activity spinner — braille animation with reasoning preview.
 * Encapsulates spinnerIntervalId, spinnerFrame, spinnerLabel,
 * turnStartTime, currentReasoningText, spinnerHasSecondLine,
 * and verboseReasoningEnabled in a single class instance.
 */
const spinner = new Spinner();
// Sync verbose state from CLI flag to spinner
spinner.verboseReasoning = cli.verbose;

// ── Session Management State ─────────────────────────────────────────
//
// The client and session are module-level so slash commands like
// /model, /new, /resume, /sessions can manipulate them.

/**
 * Session ID prefix — every session created by hyperagent is tagged
 * with this prefix so `/sessions` can filter out sessions from other
 * Copilot clients (VS Code, CLI, etc.).
 */
const SESSION_ID_PREFIX = "hyperagent-";

/** Default number of sessions shown by `/sessions`. */
const SESSIONS_PAGE_SIZE = 10;

/** Generate a prefixed session ID for hyperagent sessions. */
function makeSessionId(): string {
  return `${SESSION_ID_PREFIX}${randomUUID()}`;
}

// ── Slash Command Handler ────────────────────────────────────────────
//
// Runtime-togglable options. Type /help at the REPL for the full list.

/**
 * Process a slash command from the REPL. Returns true if the input was
 * handled (caller should `continue` the loop), false if it should be
 * sent to the agent as a message.
 *
 * @param rawInput — The raw, trimmed user input (starts with '/')
 * @param rl       — The REPL readline interface (reused for config prompts)
 */
/**
 * Handle slash commands from the REPL.
 * Delegates to the extracted implementation in agent/slash-commands.ts.
 */
async function handleSlashCommand(
  rawInput: string,
  rl: readline.Interface,
): Promise<boolean> {
  const slashDeps: SlashCommandDeps = {
    state,
    spinner,
    sandbox,
    pluginManager,
    transcript,
    SEND_TIMEOUT_MS,
    debugLog,
    debugStream,
    setDebugStream: (s) => {
      debugStream = s;
    },
    LOGS_DIR,
    formatModelList,
    buildSessionConfig,
    registerEventHandler,
    drainAndWarn,
    mcpManager, // Real MCP manager (or null if no config)
    syncPlugins: syncPluginsToSandbox,
  };
  return handleSlashCommandImpl(rawInput, rl, slashDeps);
}

// ── Tool Definition ──────────────────────────────────────────────────

/**
 * The execute_javascript tool — lets the agent run JavaScript code
 * inside a Hyperlight micro-VM sandbox.
 *
 * ⚠️  We use a raw JSON Schema for parameters instead of Zod because
 *     the SDK bundles its own Zod in node_modules/@github/copilot-sdk/
 *     node_modules/zod/. When defineTool checks instanceof ZodSchema,
 *     it checks against ITS Zod — not ours. Two different Zod instances
 *     means the instanceof fails silently and the tool never registers
 *     with the CLI server. Raw JSON Schema bypasses this entirely.
 */

// ── Validation Token Store ────────────────────────────────────────────

/**
 * Load module files from disk for the Rust validator.
 * For ha:* imports: reads .js source, .d.ts declarations, and .json metadata.
 * For host:* imports: reads plugin source.
 * The host does NO parsing — just file I/O. The validator does all analysis.
 *
 * @param specifiers - Import specifiers whose files to load
 */
function loadModuleFilesForValidator(
  specifiers: string[],
  pluginManager: ReturnType<typeof createPluginManager>,
): {
  sources: Record<string, string>;
  dtsSources: Record<string, string>;
  moduleJsons: Record<string, string>;
} {
  const sources: Record<string, string> = {};
  const dtsSources: Record<string, string> = {};
  const moduleJsons: Record<string, string> = {};

  for (const specifier of specifiers) {
    if (specifier.startsWith("ha:")) {
      // Load module sources - NO PARSING, validator will extract metadata
      const moduleName = specifier.slice(3);
      const dir = getModulesDir();
      const jsPath = join(dir, `${moduleName}.js`);
      const dtsPath = join(dir, `${moduleName}.d.ts`);
      const jsonPath = join(dir, `${moduleName}.json`);

      if (existsSync(jsPath)) {
        sources[specifier] = readFileSync(jsPath, "utf-8");
      }
      // Native modules (type: "native") have no .js source — they're compiled
      // into the runtime binary. The validator handles this via module_jsons.

      // Load .d.ts if exists (validator extracts types from this)
      if (existsSync(dtsPath)) {
        dtsSources[specifier] = readFileSync(dtsPath, "utf-8");
      }

      // Load module.json if exists (system module metadata + hashes)
      if (existsSync(jsonPath)) {
        moduleJsons[specifier] = readFileSync(jsonPath, "utf-8");
      }
    } else if (specifier.startsWith("host:")) {
      if (specifier.startsWith("host:mcp-") && mcpManager) {
        // MCP modules: dynamically generate .d.ts from connected server tools
        const serverName = specifier.slice("host:mcp-".length);
        const conn = mcpManager.getConnection(serverName);
        if (conn && conn.state === "connected" && conn.tools.length > 0) {
          dtsSources[specifier] = generateMCPDeclarations(
            serverName,
            conn.tools,
          );
        }
      } else {
        // Native host plugins: load host-modules.d.ts for type info
        const hostModulesDts = join(pluginsDir, "host-modules.d.ts");
        if (existsSync(hostModulesDts) && !dtsSources[specifier]) {
          dtsSources[specifier] = readFileSync(hostModulesDts, "utf-8");
        }
      }
      // Mark as resolved (empty source = skip deep validation, but not missing)
      sources[specifier] = "";
    }
  }

  return { sources, dtsSources, moduleJsons };
}

// ── Shared handler validation ──────────────────────────────────────
//
// Validates handler code using the Hyperlight analysis guest.
// Used by both register_handler and edit_handler to ensure all
// code changes go through the same validation pipeline.

interface ValidationResult {
  valid: boolean;
  isModule: boolean;
  error?: string;
  validationErrors?: Array<{ type: string; message: string; line?: number }>;
}

async function validateHandlerCode(
  name: string,
  code: string,
): Promise<ValidationResult> {
  const registeredHandlers = sandbox.getHandlers().filter((h) => h !== name);
  const availableModules = sandbox.getAvailableModules();

  let validationContext: ValidationContext = {
    handlerName: name,
    registeredHandlers,
    availableModules,
    expectHandler: true,
  };

  let isModule = false;

  let validation = await validateJavaScriptGuest(code, validationContext);
  isModule = validation.isModule;

  // Multi-pass module resolution loop
  const maxIterations = 20;
  let iterations = 0;
  while (
    !validation.deepValidationDone &&
    validation.missingSources.length > 0 &&
    validation.errors.length === 0 &&
    iterations < maxIterations
  ) {
    iterations++;
    const {
      sources: newSources,
      dtsSources: newDtsSources,
      moduleJsons: newModuleJsons,
    } = loadModuleFilesForValidator(validation.missingSources, pluginManager);

    if (Object.keys(newSources).length === 0) {
      const unresolvable = validation.missingSources.filter(
        (s) => !s.startsWith("ha:") && !s.startsWith("host:"),
      );
      if (unresolvable.length > 0) {
        const suggestions = unresolvable
          .map((s) => {
            const asHa = `ha:${s}`;
            const asHost = `host:${s}`;
            if (availableModules.includes(asHa)) return `"${s}" → "${asHa}"`;
            if (availableModules.includes(asHost))
              return `"${s}" → "${asHost}"`;
            return `"${s}"`;
          })
          .join(", ");
        return {
          valid: false,
          isModule,
          error: `Invalid import specifiers: ${suggestions}. Modules require "ha:" prefix (e.g., import { x } from "ha:pptx"), plugins require "host:" prefix.`,
        };
      }
      break;
    }

    validationContext = {
      ...validationContext,
      moduleSources: { ...validationContext.moduleSources, ...newSources },
      dtsSources: { ...validationContext.dtsSources, ...newDtsSources },
      moduleJsons: { ...validationContext.moduleJsons, ...newModuleJsons },
    };
    validation = await validateJavaScriptGuest(code, validationContext);
  }

  if (iterations >= maxIterations) {
    const stillMissing = validation.missingSources.join(", ");
    return {
      valid: false,
      isModule,
      error: `Could not resolve all module dependencies after ${maxIterations} iterations. Still missing: ${stillMissing}.`,
    };
  }

  // Report warnings to console
  for (const warning of validation.warnings) {
    console.error(`  ${C.warn("⚠️")} ${warning.message}`);
  }

  if (!validation.valid) {
    const errorMessages = validation.errors
      .map((e) => {
        const loc = e.line ? ` (line ${e.line})` : "";
        return `${e.type}: ${e.message}${loc}`;
      })
      .join("\n  • ");
    return {
      valid: false,
      isModule,
      error: `Validation failed:\n  • ${errorMessages}`,
      validationErrors: validation.errors,
    };
  }

  return { valid: true, isModule };
}

// ── Tool: register_handler ────────────────────────────────────────────

const registerHandlerTool = defineTool("register_handler", {
  description: [
    "Register (or update) a named JavaScript handler in the sandbox.",
    "The code is compiled but NOT executed — call execute_javascript to run it.",
    "",
    "REQUIRED: Code must define `function handler(event) { ... return result; }`",
    "The function MUST be named exactly 'handler' — not Handler, handle, main.",
    "",
    "⚠️ TO UPDATE EXISTING CODE: Use get_handler_source first!",
    "When fixing errors, call get_handler_source(name) to get current code,",
    "edit ONLY the broken line, then register_handler with the fix.",
    "Do NOT regenerate from scratch — that wastes time and loses working code.",
    "",
    "⚠️ NESTED BACKTICKS WILL BREAK YOUR CODE:",
    "If your handler uses template literals containing backticks (e.g. codeBlock),",
    "use regular strings with \\n instead of template literals for the outer code.",
    "WRONG: register_handler('x', `codeBlock({code: `...`})`) ← breaks",
    "RIGHT: register_handler('x', 'codeBlock({code: \"...\"})') ← works",
    "",
    "Example:",
    "  import * as pptx from 'ha:pptx';",
    "  function handler(event) {",
    "    const pres = pptx.createPresentation();",
    "    return { slides: pres.slideCount };",
    "  }",
    "",
    "Multiple handlers can coexist — each has its own isolated module scope.",
    "IMPORTANT: Adding/updating/deleting ANY handler triggers recompilation",
    "of ALL handlers, resetting module-level state. Register all handlers upfront.",
    "",
    "💡 VALIDATION FAILURE IS CHEAP: If registration fails due to validation errors",
    "(syntax, missing imports, non-existent methods), NO state is lost. The sandbox",
    "is unchanged. Only SUCCESSFUL registration triggers recompilation.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description:
          "Unique name for this handler. Used to call it via execute_javascript.",
      },
      code: {
        type: "string",
        description:
          "JavaScript source code. Simple mode: use `return` for output. " +
          "Module mode: define `function handler(event) { ... }`.",
      },
    },
    required: ["name", "code"],
  },
  handler: async ({ name, code }: { name: string; code: string }) => {
    if (state.showCodeEnabled) {
      const indented = code
        .split("\n")
        .map((l: string) => `    ${l}`)
        .join("\n");
      console.error(`\n  📝 register_handler("${name}"):\n${indented}\n`);
    }
    sandbox.writeCode(`// ── handler: ${name} ──\n${code}\n`);

    // ── Validate code using Hyperlight analysis guest ─────────────
    // Two-stage validation:
    // 1. Parse handler, extract imports (guest returns import list)
    // 2. Host resolves imports to source, guest does deep validation
    // All parsing happens in the isolated Hyperlight micro-VM (no host parsing).
    const registeredHandlers = sandbox.getHandlers().filter((h) => h !== name); // exclude self for updates
    const availableModules = sandbox.getAvailableModules();

    let validationContext: ValidationContext = {
      handlerName: name,
      registeredHandlers,
      availableModules,
      expectHandler: true,
    };

    let isModule = false;
    try {
      // Multi-stage validation loop:
      // 1. Guest parses handler, returns imports
      // 2. Host resolves missing imports to source (file I/O)
      // 3. Guest parses those sources, finds their imports
      // 4. Repeat until no missing sources
      // 5. Guest does deep validation with complete dependency tree

      let validation = await validateJavaScriptGuest(code, validationContext);
      isModule = validation.isModule;

      // Loop until all sources are resolved or we hit an error
      const maxIterations = 20; // Safety limit for circular deps
      let iterations = 0;
      while (
        !validation.deepValidationDone &&
        validation.missingSources.length > 0 &&
        validation.errors.length === 0 &&
        iterations < maxIterations
      ) {
        iterations++;
        // Resolve missing sources (file I/O only - validator extracts metadata)
        const {
          sources: newSources,
          dtsSources: newDtsSources,
          moduleJsons: newModuleJsons,
        } = loadModuleFilesForValidator(
          validation.missingSources,
          pluginManager,
        );

        // If we couldn't resolve ANY of the missing sources, generate helpful errors
        // This happens when imports use wrong prefixes (e.g., "pptx" instead of "ha:pptx")
        if (Object.keys(newSources).length === 0) {
          const unresolvable = validation.missingSources.filter(
            (s) => !s.startsWith("ha:") && !s.startsWith("host:"),
          );
          if (unresolvable.length > 0) {
            // These imports can't be resolved - likely missing the ha: or host: prefix
            const suggestions = unresolvable
              .map((s) => {
                // Check if ha: prefixed version exists
                if (availableModules.includes(`ha:${s}`)) {
                  return `"${s}" should be "ha:${s}"`;
                }
                // Check if host: prefixed version exists
                if (availableModules.includes(`host:${s}`)) {
                  return `"${s}" should be "host:${s}"`;
                }
                return `"${s}" is not available. Use list_modules to see available modules.`;
              })
              .join(", ");
            const errorResult = {
              success: false,
              error: `Invalid import specifiers: ${suggestions}. Modules require "ha:" prefix (e.g., import { x } from "ha:pptx"), plugins require "host:" prefix.`,
            };
            console.error(`  ${C.err("❌ " + errorResult.error)}`);
            return errorResult;
          }
          // All missing sources have correct prefixes but still can't be resolved
          // This means the modules/plugins don't exist
          break;
        }

        validationContext = {
          ...validationContext,
          moduleSources: { ...validationContext.moduleSources, ...newSources },
          dtsSources: { ...validationContext.dtsSources, ...newDtsSources },
          moduleJsons: { ...validationContext.moduleJsons, ...newModuleJsons },
        };
        validation = await validateJavaScriptGuest(code, validationContext);
      }

      if (iterations >= maxIterations) {
        // This can happen with circular dependencies or deeply nested imports
        const stillMissing = validation.missingSources.join(", ");
        const errorResult = {
          success: false,
          error:
            `Validation failed: Could not resolve all module dependencies after ${maxIterations} iterations. ` +
            `Still missing: ${stillMissing}. This may indicate circular imports or deeply nested dependencies.`,
        };
        console.error(`  ${C.err("❌ " + errorResult.error)}`);
        return errorResult;
      }

      // Report warnings
      for (const warning of validation.warnings) {
        console.error(`  ${C.warn("⚠️")} ${warning.message}`);
      }

      // Block registration if validation failed
      if (!validation.valid) {
        const errorMessages = validation.errors
          .map((e) => {
            const loc = e.line ? ` (line ${e.line})` : "";
            return `${e.type}: ${e.message}${loc}`;
          })
          .join("\n  • ");
        const errorResult = {
          success: false,
          error: `Validation failed:\n  • ${errorMessages}`,
          validationErrors: validation.errors,
        };
        console.error(`  ${C.err("❌ " + errorResult.error)}`);
        return errorResult;
      }
    } catch (e) {
      // Analysis guest failed - report the error and block registration
      const errMsg = e instanceof Error ? e.message : String(e);
      const stack = e instanceof Error ? e.stack : "";
      console.error(`  ${C.err("❌ Validation error: " + errMsg)}`);
      if (stack) {
        console.error(`  ${C.dim(stack)}`);
      }
      return {
        success: false,
        error: `Validation failed: ${errMsg}`,
      };
    }

    // ── Proceed with registration ─────────────────────────────────
    const result = await sandbox.registerHandler(name, code, { isModule });
    if (result.success) {
      // Warn if handler code is large relative to input buffer
      const bufSizes = sandbox.getEffectiveBufferSizes();
      const codeBytes = Buffer.byteLength(code, "utf8");
      const pct = Math.round((codeBytes / (bufSizes.inputKb * 1024)) * 100);
      const sizeNote = pct >= 50 ? ` ⚠️  Code is ${pct}% of input buffer` : "";
      console.error(
        `  ${C.ok("✅")} Handler "${name}" registered (${result.handlers?.length ?? 0} total, ${(codeBytes / 1024).toFixed(1)}KB)${sizeNote}`,
      );
    } else {
      console.error(`  ${C.err("❌ " + result.error)}`);
    }
    return result;
  },
});

// ── Tool: delete_handler ─────────────────────────────────────────────

const deleteHandlerTool = defineTool("delete_handler", {
  description: [
    "Remove a named handler from the sandbox.",
    "IMPORTANT: Deleting any handler triggers recompilation of ALL remaining",
    "handlers, which resets ALL module-level state. Save important state to",
    "files before deleting handlers.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Name of the handler to remove.",
      },
    },
    required: ["name"],
  },
  handler: async ({ name }: { name: string }) => {
    const result = await sandbox.deleteHandler(name);
    if (result.success) {
      console.error(
        `  ${C.ok("🗑️")} Handler "${name}" deleted (${result.handlers?.length ?? 0} remaining)`,
      );
    } else {
      console.error(`  ${C.err("❌ " + result.error)}`);
    }
    return result;
  },
});

// ── Tool: delete_handlers (batch) ────────────────────────────────────

const deleteHandlersTool = defineTool("delete_handlers", {
  description: [
    "Remove multiple handlers from the sandbox in one call.",
    "Pass names array to delete specific handlers, or all: true to delete all.",
    "",
    "IMPORTANT: Deleting handlers triggers recompilation of ALL remaining",
    "handlers, which resets ALL module-level state. Save important state to",
    "files before deleting handlers.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      names: {
        type: "array",
        items: { type: "string" },
        description: "Array of handler names to delete. Ignored if all=true.",
      },
      all: {
        type: "boolean",
        description: "If true, delete ALL handlers (ignores names array).",
      },
    },
  },
  handler: async ({ names, all }: { names?: string[]; all?: boolean }) => {
    const deleted: string[] = [];
    const errors: string[] = [];

    // Get current handlers
    const currentHandlers = sandbox.getHandlers();

    // Determine which handlers to delete
    const toDelete = all ? currentHandlers : (names ?? []);

    if (toDelete.length === 0) {
      return {
        success: true,
        message: "No handlers to delete",
        deleted: [],
        remaining: currentHandlers,
      };
    }

    // Delete each handler
    for (const name of toDelete) {
      const result = await sandbox.deleteHandler(name);
      if (result.success) {
        deleted.push(name);
      } else {
        errors.push(`${name}: ${result.error}`);
      }
    }

    const remaining = sandbox.getHandlers();

    if (deleted.length > 0) {
      console.error(
        `  ${C.ok("🗑️")} Deleted ${deleted.length} handler(s): ${deleted.join(", ")} (${remaining.length} remaining)`,
      );
    }
    if (errors.length > 0) {
      console.error(`  ${C.err("❌ Errors:")} ${errors.join("; ")}`);
    }

    return {
      success: errors.length === 0,
      deleted,
      errors: errors.length > 0 ? errors : undefined,
      remaining,
    };
  },
});

// ── Tool: get_handler_source ─────────────────────────────────────────

const getHandlerSourceTool = defineTool("get_handler_source", {
  description: [
    "Retrieve the source code of a previously registered handler.",
    "Use this to inspect existing handlers before editing with edit_handler.",
    "",
    "Returns code with line numbers (e.g., '  1 | const x = ...').",
    "Use startLine/endLine to retrieve just a section of large handlers.",
    "",
    "For small fixes, use edit_handler instead of re-registering the whole handler.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Name of the handler to retrieve source for.",
      },
      startLine: {
        type: "number",
        description: "Optional: 1-based start line (inclusive). Defaults to 1.",
      },
      endLine: {
        type: "number",
        description:
          "Optional: 1-based end line (inclusive). Defaults to last line.",
      },
    },
    required: ["name"],
  },
  handler: ({
    name,
    startLine,
    endLine,
  }: {
    name: string;
    startLine?: number;
    endLine?: number;
  }) => {
    const result = sandbox.getHandlerSource(name, { startLine, endLine });
    if (result.success) {
      const rangeInfo =
        startLine || endLine
          ? ` (lines ${result.startLine}-${result.endLine} of ${result.totalLines})`
          : ` (${result.totalLines} lines)`;
      console.error(
        `  ${C.ok("✅")} Retrieved source for "${name}"${rangeInfo}`,
      );
    } else {
      console.error(`  ${C.err("❌ " + result.error)}`);
    }
    return result;
  },
});

// ── Tool: edit_handler ────────────────────────────────────────────────

const editHandlerTool = defineTool("edit_handler", {
  description: [
    "Make a surgical edit to an existing handler without re-sending all the code.",
    "",
    "Either replace oldString exactly once, or replace a line range from get_handler_source.",
    "Much faster and safer than regenerating the entire handler for small fixes.",
    "",
    "String mode: provide oldString and newString. oldString must match EXACTLY ONCE.",
    "Line mode: provide startLine, optional endLine, and replacement. Use the line",
    "numbers returned by get_handler_source, but do not include the 'N |' prefixes.",
    "",
    "Returns the edited region with surrounding context for verification.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Name of the handler to edit.",
      },
      oldString: {
        type: "string",
        description: "String mode: exact string to find and replace once.",
      },
      newString: {
        type: "string",
        description: "String mode: replacement string.",
      },
      startLine: {
        type: "number",
        description:
          "Line mode: 1-based start line to replace, from get_handler_source.",
      },
      endLine: {
        type: "number",
        description:
          "Line mode: optional 1-based end line to replace. Defaults to startLine.",
      },
      replacement: {
        type: "string",
        description: "Line mode: replacement code for the selected line range.",
      },
    },
    required: ["name"],
  },
  handler: async ({
    name,
    oldString,
    newString,
    startLine,
    endLine,
    replacement,
  }: {
    name: string;
    oldString?: string;
    newString?: string;
    startLine?: number;
    endLine?: number;
    replacement?: string;
  }) => {
    // ── Preview the edit and validate before applying ─────────────
    // Get current source to build the edited version
    const sourceResult = sandbox.getHandlerSource(name, {
      lineNumbers: false,
    });

    if (!sourceResult.success) {
      console.error(`  ${C.err("❌ " + sourceResult.error)}`);
      return { success: false, error: sourceResult.error };
    }

    const currentSource = sourceResult.code ?? "";

    const hasStringEdit = oldString !== undefined || newString !== undefined;
    const hasLineEdit =
      startLine !== undefined ||
      endLine !== undefined ||
      replacement !== undefined;

    if (hasStringEdit && hasLineEdit) {
      const error =
        "Use either string mode (oldString + newString) or line mode (startLine/endLine + replacement), not both.";
      console.error(`  ${C.err("❌ " + error)}`);
      return { success: false, error };
    }

    let editedCode: string;
    let applyEdit: () => Promise<{
      success: boolean;
      message?: string;
      error?: string;
      handlers?: string[];
      codeSize?: number;
      contextAfter?: string;
    }>;

    if (hasLineEdit) {
      if (typeof replacement !== "string") {
        const error = "Line mode requires replacement.";
        console.error(`  ${C.err("❌ " + error)}`);
        return { success: false, error };
      }
      if (
        typeof startLine !== "number" ||
        !Number.isInteger(startLine) ||
        startLine < 1
      ) {
        const error = "Line mode requires startLine as a positive integer.";
        console.error(`  ${C.err("❌ " + error)}`);
        return { success: false, error };
      }

      const lines = currentSource.split("\n");
      const rangeEnd = endLine ?? startLine;
      if (
        typeof rangeEnd !== "number" ||
        !Number.isInteger(rangeEnd) ||
        rangeEnd < startLine
      ) {
        const error =
          "endLine must be a positive integer greater than or equal to startLine.";
        console.error(`  ${C.err("❌ " + error)}`);
        return { success: false, error };
      }
      if (startLine > lines.length || rangeEnd > lines.length) {
        const error = `Line range ${startLine}-${rangeEnd} is outside handler "${name}" (${lines.length} lines).`;
        console.error(`  ${C.err("❌ " + error)}`);
        return { success: false, error };
      }

      const replacementLines =
        replacement === "" ? [] : replacement.split("\n");
      const editedLines = [
        ...lines.slice(0, startLine - 1),
        ...replacementLines,
        ...lines.slice(rangeEnd),
      ];
      editedCode = editedLines.join("\n");
      applyEdit = async () =>
        sandbox.editHandlerLines(name, startLine, rangeEnd, replacement);
    } else {
      if (typeof oldString !== "string" || typeof newString !== "string") {
        const error = "String mode requires oldString and newString.";
        console.error(`  ${C.err("❌ " + error)}`);
        return { success: false, error };
      }

      // Check exact-once match
      const firstIdx = currentSource.indexOf(oldString);
      if (firstIdx === -1) {
        const error =
          "oldString not found in handler. Use get_handler_source to see current code, then copy the EXACT text to replace, or use startLine/replacement line mode.";
        console.error(`  ${C.err("❌ " + error)}`);
        return { success: false, error };
      }
      const secondIdx = currentSource.indexOf(
        oldString,
        firstIdx + oldString.length,
      );
      if (secondIdx !== -1) {
        const error =
          "oldString matches multiple times. Add more surrounding context to make it unique, or use startLine/replacement line mode.";
        console.error(`  ${C.err("❌ " + error)}`);
        return { success: false, error };
      }

      // Build the edited code
      editedCode =
        currentSource.slice(0, firstIdx) +
        newString +
        currentSource.slice(firstIdx + oldString.length);
      applyEdit = async () => sandbox.editHandler(name, oldString, newString);
    }

    // Validate the edited code through the same pipeline as register_handler
    try {
      const validation = await validateHandlerCode(name, editedCode);
      if (!validation.valid) {
        console.error(
          `  ${C.err("❌ Edit rejected by validation (handler unchanged):")}`,
        );
        console.error(`  ${C.err(validation.error ?? "Unknown error")}`);
        return {
          success: false,
          error: `Edit rejected — ${validation.error}`,
          hint: "The edit was NOT applied. The handler is unchanged. Fix the error in your newString and try again.",
          validationErrors: validation.validationErrors,
        };
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error(`  ${C.err("❌ Validation error: " + errMsg)}`);
      return {
        success: false,
        error: `Edit rejected — validation failed: ${errMsg}`,
        hint: "The edit was NOT applied. The handler is unchanged.",
      };
    }

    // Validation passed — apply the edit
    const result = await applyEdit();
    if (result.success) {
      console.error(
        `  ${C.ok("✅")} Edited handler "${name}" (${result.codeSize} bytes)`,
      );
    } else {
      console.error(`  ${C.err("❌ " + result.error)}`);
    }
    return result;
  },
});

// ── Tool: list_handlers ───────────────────────────────────────────────

const listHandlersTool = defineTool("list_handlers", {
  description: [
    "List all registered handlers with their line counts.",
    "Cheaper than get_handler_source when you just need to know what's registered.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {},
  },
  handler: () => {
    const handlers = sandbox.getHandlers();
    const result = handlers.map((name) => {
      const source = sandbox.getHandlerSource(name, { lineNumbers: false });
      const lines = source.success ? source.totalLines : 0;
      return { name, lines };
    });
    console.error(`  ${C.ok("✅")} ${handlers.length} handler(s) registered`);
    return { success: true, handlers: result };
  },
});

// ── Tool: execute_javascript ─────────────────────────────────────────

const executeJavascriptTool = defineTool("execute_javascript", {
  description: [
    "Execute a previously registered handler by name.",
    "Call register_handler first to register code, then use this to run it.",
    "",
    "Pass `event` data to vary input each call while keeping the same handler.",
    "Module-level state persists across calls as long as no handlers are",
    "added, updated, or deleted. The response includes execution stats",
    "(wallClockMs, cpuTimeMs, terminatedBy) and a statePreserved flag.",
    "",
    "CPU and wall-clock time are bounded. The sandbox has NO filesystem,",
    "network, or Node.js access unless plugins provide it.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      handler: {
        type: "string",
        description: "Name of a previously registered handler to execute.",
      },
      event: {
        type: "object",
        description:
          "Optional event data passed to handler(event). " +
          "Use to send different input each call while preserving state. " +
          "Example: {action: 'addSlide', title: 'Intro'}",
      },
    },
    required: ["handler"],
  },
  handler: async ({
    handler: handlerName,
    event,
  }: {
    handler: string;
    event?: Record<string, unknown>;
  }) => {
    // Build per-call timeout overrides (slash command /timeout)
    const overrides: { cpuTimeoutMs?: number; wallClockTimeoutMs?: number } =
      {};
    if (state.cpuTimeoutOverride !== null)
      overrides.cpuTimeoutMs = state.cpuTimeoutOverride;
    if (state.wallTimeoutOverride !== null)
      overrides.wallClockTimeoutMs = state.wallTimeoutOverride;

    const {
      success,
      result,
      error,
      llmInstruction,
      consoleOutput,
      stats,
      statePreserved,
      timing,
    } = await sandbox.executeJavaScript(handlerName, event ?? {}, overrides);

    // ── Show console output ────────────────────────────────────
    // Guest console.log output captured via setHostPrintFn.
    // Always include in LLM result; show in terminal in verbose mode.
    if (consoleOutput?.length) {
      if (state.verboseOutput) {
        for (const line of consoleOutput) {
          console.error(`  ${C.dim(`[console] ${line.trimEnd()}`)}`);
        }
      }
      debugLog(
        `Console output (${consoleOutput.length} lines): ${consoleOutput.join("").slice(0, 200)}`,
      );
    }

    // ── Effective limits for this execution ────────────────────
    const effectiveCpuLimit =
      overrides.cpuTimeoutMs ?? sandbox.config.cpuTimeoutMs;
    const effectiveWallLimit =
      overrides.wallClockTimeoutMs ?? sandbox.config.wallClockTimeoutMs;

    if (state.showTimingEnabled && timing) {
      console.error(
        `  ${C.dim(`⏱️  ${timing.totalMs}ms wall-clock`)} ` +
          `${C.dim(`(init: ${timing.initMs}ms, compile: ${timing.compileMs}ms, exec: ${timing.executeMs}ms)`)} ` +
          `${C.dim(`· limits: cpu ${effectiveCpuLimit}ms, wall ${effectiveWallLimit}ms`)}`,
      );
    }

    const resourceStats = timing
      ? {
          executeMs: timing.executeMs,
          totalMs: timing.totalMs,
          cpuLimitMs: effectiveCpuLimit,
          wallLimitMs: effectiveWallLimit,
          cpuUtilisation: `${Math.round((timing.executeMs / effectiveCpuLimit) * 100)}%`,
          wallUtilisation: `${Math.round((timing.totalMs / effectiveWallLimit) * 100)}%`,
        }
      : undefined;

    if (success) {
      const fullResult = JSON.stringify(result, null, 2);
      const fullResultBytes = Buffer.byteLength(fullResult, "utf-8");

      // ── Large output interception ──────────────────────────────
      // If the result exceeds the configured threshold, save to disk
      // and return a summary with read_output instructions.
      // This fires BEFORE the SDK's own VB() truncation because we
      // return a small replacement result.
      const outputThreshold = parseInt(
        process.env.HYPERAGENT_OUTPUT_THRESHOLD_BYTES || "20480",
        10,
      );
      if (fullResultBytes > outputThreshold) {
        const fsWriteBaseDir = getPluginBaseDir("fs-write");
        if (fsWriteBaseDir) {
          // Save full result to results/ subdirectory
          const resultsDir = resolve(fsWriteBaseDir, "results");
          if (!existsSync(resultsDir)) {
            mkdirSync(resultsDir, { recursive: true });
          }
          const filename = `${handlerName}-${Date.now()}.txt`;
          const outputPath = join(resultsDir, filename);
          writeFileSync(outputPath, fullResult, "utf-8");
          const relativePath = `results/${filename}`;

          console.error(
            `  ${C.ok("📦")} Result too large (${(fullResultBytes / 1024).toFixed(1)} KB) → saved to ${relativePath}`,
          );

          const preview = fullResult.slice(0, 500);
          return {
            result:
              `Result saved to ${relativePath} (${(fullResultBytes / 1024).toFixed(1)} KB).\n` +
              `Preview (first 500 chars):\n${preview}\n\n` +
              `Use read_output("${relativePath}") to read the full result.\n` +
              `Use read_output("${relativePath}", startLine, endLine) for specific sections.\n` +
              `You can also read this file from handler code via host:fs-read.`,
            ...(consoleOutput?.length ? { consoleOutput } : {}),
            _resourceStats: resourceStats,
            _stats: stats ?? undefined,
            _statePreserved: statePreserved,
          };
        } else {
          // fs-write not enabled — return truncated preview with guidance
          console.error(
            `  ${C.warn("⚠️")} Result too large (${(fullResultBytes / 1024).toFixed(1)} KB) and fs-write not enabled`,
          );

          const preview = fullResult.slice(0, 2048);
          return {
            result:
              `Result truncated (${(fullResultBytes / 1024).toFixed(1)} KB). ` +
              `The fs-write plugin is not enabled, so the full result could not be saved to disk.\n` +
              `Enable it first: manage_plugin("fs-write", "enable") or apply_profile("file-builder")\n` +
              `Then re-run the handler to get the full output saved to the results/ directory.\n\n` +
              `Preview (first 2KB):\n${preview}`,
            ...(consoleOutput?.length ? { consoleOutput } : {}),
            _resourceStats: resourceStats,
            _stats: stats ?? undefined,
            _statePreserved: statePreserved,
          };
        }
      }

      const TRUNCATION_MARKER = "\n[TRUNCATED_FOR_LLM]";
      // Allow up to 50KB of result data in the LLM's context.
      // The LLM needs the full result to orchestrate multi-handler
      // workflows (e.g. research handler → build handler). Truncating
      // at 500 chars forced everything into monolithic handlers.
      // 50KB is ~12K tokens — well within model context limits.
      const MAX_LLM_RESULT_CHARS = 50_000;

      if (fullResult.length > MAX_LLM_RESULT_CHARS) {
        let displayText: string;
        try {
          const parsed = JSON.parse(fullResult);
          displayText =
            typeof parsed === "string"
              ? parsed
              : JSON.stringify(parsed, null, 2);
        } catch {
          displayText = fullResult;
        }
        console.error(`  ${C.ok("✅ Result:")}`);
        console.error(displayText);

        const preview = fullResult.slice(0, MAX_LLM_RESULT_CHARS);
        const remaining = fullResult.length - MAX_LLM_RESULT_CHARS;
        return {
          result:
            preview +
            `\n\n[… ${remaining} more characters — full output already displayed to user]` +
            TRUNCATION_MARKER,
          ...(consoleOutput?.length ? { consoleOutput } : {}),
          _resourceStats: resourceStats,
          _stats: stats ?? undefined,
          _statePreserved: statePreserved,
        };
      }
      return {
        result: fullResult,
        ...(consoleOutput?.length ? { consoleOutput } : {}),
        _resourceStats: resourceStats,
        _stats: stats ?? undefined,
        _statePreserved: statePreserved,
      };
    } else {
      console.log(`  ${C.err("❌ " + error)}`);
      suggestBufferIncreaseIfNeeded(error ?? "");
      const llmError = llmInstruction
        ? `${error} ${llmInstruction}`
        : (error ?? "");
      return {
        error: llmError,
        ...(consoleOutput?.length ? { consoleOutput } : {}),
        _userDisplayed: true,
        _resourceStats: resourceStats,
        _stats: stats ?? undefined,
        _statePreserved: statePreserved,
      };
    }
  },
});

// ── Tool: reset_sandbox ──────────────────────────────────────────────

const sandboxResetTool = defineTool("reset_sandbox", {
  description: [
    "Reset sandbox state — clears all module-level variables and compiled state.",
    "Registered handlers are PRESERVED — they auto-recompile on next execute.",
    "Use this for a clean slate without re-registering handlers.",
    "",
    "Use when:",
    "• You want fresh state but keep your handler code",
    "• State has grown too large and you want to free memory",
    "• A previous execution left the sandbox in an unexpected state",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {},
  },
  handler: async () => {
    const result = await sandbox.resetSandbox();
    if (result.success) {
      console.error(
        `  ${C.ok("🔄 Sandbox state reset")} (${result.handlers?.length ?? 0} handlers preserved, ha:shared-state preserved)`,
      );
    } else {
      console.error(`  ${C.err("❌ " + result.error)}`);
    }
    return result;
  },
});

// ── Interactive Tool Serialization ───────────────────────────────────
//
// Tools that prompt the user (configure_sandbox, manage_plugin) must
// NOT run in parallel — the LLM can dispatch multiple tool calls in
// one turn, and parallel readline prompts corrupt the terminal.
// We serialize all interactive tools through a shared promise queue.

let interactiveToolQueue: Promise<void> = Promise.resolve();

/**
 * Acquire the interactive tool lock. Returns a release function.
 * Call this at the start of any tool handler that prompts the user.
 */
async function acquireInteractiveLock(): Promise<() => void> {
  let release: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prev = interactiveToolQueue;
  interactiveToolQueue = gate;
  await prev;
  return release!;
}

// ── Tool: configure_sandbox ──────────────────────────────────────────

const configureSandboxTool = defineTool("configure_sandbox", {
  description: [
    "Change sandbox resource limits (heap, scratch, timeouts, buffers).",
    "Only set fields you want to change — others remain unchanged.",
    "",
    "WARNING: Changing heap, scratch, or buffer sizes rebuilds the sandbox,",
    "which resets handler module-level variables. ha:shared-state is preserved.",
    "(see PATTERN 5 in system message).",
    "",
    "Changing timeouts does NOT rebuild the sandbox (state preserved).",
    "",
    "The user will be prompted to approve the change. Once a setting TYPE",
    "is approved in a session, further changes to that type are auto-approved.",
    "",
    "Call proactively if you can predict a task needs more resources",
    "(e.g. ZIP/PPTX building, multiple network calls, large data processing).",
    "Also call reactively when a limit error tells you which limit was hit.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      heap: { type: "number", description: "Guest heap size in MB" },
      scratch: { type: "number", description: "Guest scratch size in MB" },
      cpuTimeout: { type: "number", description: "CPU timeout in ms" },
      wallTimeout: { type: "number", description: "Wall-clock timeout in ms" },
      inputBuffer: { type: "number", description: "Input buffer size in KB" },
      outputBuffer: { type: "number", description: "Output buffer size in KB" },
    },
  },
  handler: async (params: {
    heap?: number;
    scratch?: number;
    cpuTimeout?: number;
    wallTimeout?: number;
    inputBuffer?: number;
    outputBuffer?: number;
  }) => {
    // Serialize — only one interactive tool at a time.
    const release = await acquireInteractiveLock();
    try {
      return await configureSandboxImpl(params);
    } finally {
      release();
    }
  },
});

/** Internal implementation for configure_sandbox — called under lock. */
async function configureSandboxImpl(params: {
  heap?: number;
  scratch?: number;
  cpuTimeout?: number;
  wallTimeout?: number;
  inputBuffer?: number;
  outputBuffer?: number;
}) {
  // Build a human-readable summary of what's being changed.
  const changes: string[] = [];
  if (params.heap !== undefined) changes.push(`heap → ${params.heap}MB`);
  if (params.scratch !== undefined)
    changes.push(`scratch → ${params.scratch}MB`);
  if (params.cpuTimeout !== undefined)
    changes.push(`CPU timeout → ${params.cpuTimeout}ms`);
  if (params.wallTimeout !== undefined)
    changes.push(`wall timeout → ${params.wallTimeout}ms`);
  if (params.inputBuffer !== undefined)
    changes.push(`input buffer → ${params.inputBuffer}KB`);
  if (params.outputBuffer !== undefined)
    changes.push(`output buffer → ${params.outputBuffer}KB`);

  if (changes.length === 0) {
    return { success: false, error: "No changes specified" };
  }

  // Check session approvals — approve per-type, not per-value.
  const needsApproval: string[] = [];
  const configKeys = [
    ["heap", params.heap],
    ["scratch", params.scratch],
    ["cpuTimeout", params.cpuTimeout],
    ["wallTimeout", params.wallTimeout],
    ["inputBuffer", params.inputBuffer],
    ["outputBuffer", params.outputBuffer],
  ] as const;

  for (const [key, value] of configKeys) {
    if (value !== undefined && !state.sessionApprovals.has(`config:${key}`)) {
      needsApproval.push(key);
    }
  }

  // Prompt user if any setting type hasn't been approved yet.
  if (needsApproval.length > 0) {
    const rl = state.readlineInstance;
    if (!rl) {
      return {
        success: false,
        error: "No readline available for approval prompt",
      };
    }

    // Stop spinner before prompting (timer is paused by promptUser)
    spinner.stop();

    console.log(
      `\n  ${C.warn("🔧 Assistant wants to change sandbox configuration:")}`,
    );
    for (const c of changes) {
      console.log(`     ${c}`);
    }

    const willRebuild =
      params.heap !== undefined ||
      params.scratch !== undefined ||
      params.inputBuffer !== undefined ||
      params.outputBuffer !== undefined;
    if (willRebuild) {
      console.log(
        `  ${C.warn("⚠️  This will rebuild the sandbox (handler variables reset, ha:shared-state preserved)")}`,
      );
    }

    await drainAndWarn(rl);
    const answer = state.autoApprove
      ? "y"
      : await promptUser(rl, `  ${C.dim("Allow? [y/n] ")}`);
    if (answer.trim().toLowerCase() !== "y") {
      console.log(`  ${C.dim("Denied by user.")}`);
      return { success: false, error: "Configuration change denied by user" };
    }

    // Mark these types as approved for the rest of the session.
    for (const key of needsApproval) {
      state.sessionApprovals.add(`config:${key}`);
    }
  }

  // Apply the configuration changes.
  const result = await applySandboxConfig(sandbox, state, params);

  if (result.success) {
    console.error(`  ${C.ok("✅")} ${result.message}`);
    if (result.sandboxRebuilt) {
      console.error(
        `  ${C.dim("Sandbox will rebuild on next execute (handler variables reset, ha:shared-state preserved)")}`,
      );
    }
  } else {
    console.error(`  ${C.err("❌ " + result.error)}`);
  }

  return result;
}

// ── Tool: manage_plugin ──────────────────────────────────────────────

const managePluginTool = defineTool("manage_plugin", {
  description: [
    "Enable or disable a plugin. Use list_plugins to discover available plugins.",
    "",
    "Enable: The plugin's code is audited for security before activation.",
    "The user ALWAYS approves plugin enable (security audit required).",
    "Config parameters are passed as key-value pairs.",
    "",
    "Disable: Removes the plugin. User is prompted once per session.",
    "",
    "Enabling a plugin may auto-enable companion plugins (e.g. fs-write",
    "auto-enables fs-read). Companions also go through audit approval.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Action to perform: 'enable' or 'disable'",
        enum: ["enable", "disable"],
      },
      name: {
        type: "string",
        description: "Plugin name (e.g. 'fs-write', 'fetch')",
      },
      config: {
        type: "object",
        description:
          "Configuration for the plugin (only for enable). Keys depend on the plugin — use plugin_info to see the schema.",
      },
    },
    required: ["action", "name"],
  },
  handler: async (params: {
    action: "enable" | "disable";
    name: string;
    config?: Record<string, unknown>;
  }) => {
    // Serialize — only one interactive tool at a time.
    const release = await acquireInteractiveLock();
    try {
      return await managePluginImpl(params);
    } finally {
      release();
    }
  },
});

/** Internal implementation for manage_plugin — called under lock. */
async function managePluginImpl(params: {
  action: "enable" | "disable";
  name: string;
  config?: Record<string, unknown>;
}) {
  const rl = state.readlineInstance;
  if (!rl) {
    return {
      success: false,
      error: "No readline available for approval prompt",
    };
  }

  if (params.action === "enable") {
    // Build the equivalent slash command config string.
    const configStr = params.config
      ? " " +
        Object.entries(params.config)
          .map(([k, v]) => {
            if (Array.isArray(v)) return `${k}=[${v.join(",")}]`;
            return `${k}=${v}`;
          })
          .join(" ")
      : "";

    // Stop spinner before prompting (timer is paused by promptUser)
    spinner.stop();

    // ── Gate 1: Initial approval ─────────────────────────────
    // Before doing ANYTHING (audit, config), ask the user if they
    // want to proceed. This prevents the LLM from triggering
    // audits and config prompts without user awareness.
    console.log(
      `\n  ${C.warn("🔌 Assistant requests plugin:")} ${C.tool(params.name)}`,
    );
    if (params.config) {
      for (const [k, v] of Object.entries(params.config)) {
        const display = Array.isArray(v) ? `[${v.join(", ")}]` : String(v);
        console.log(`     ${k}: ${display}`);
      }
    }
    console.log(
      `  ${C.dim("This will run a security audit and prompt for configuration.")}`,
    );

    await drainAndWarn(rl);
    const preApproval = state.autoApprove
      ? "y"
      : await promptUser(rl, `  ${C.dim("Proceed? [y/n] ")}`);
    if (preApproval.trim().toLowerCase() !== "y") {
      console.log(`  ${C.dim("Denied by user.")}`);
      return { success: false, error: "Plugin enable denied by user" };
    }

    // ── Gate 2: Delegate to slash command ─────────────────────
    // The slash command handler runs the full flow:
    //   audit → show results → risk check → config → enable
    // After it returns, the plugin is enabled (or rejected by policy).
    const syntheticInput = `/plugin enable ${params.name}${configStr}`;
    try {
      await handleSlashCommand(syntheticInput, rl);
      spinner.stop(); // ensure spinner is off after

      // CRITICAL: Sync plugins to sandbox immediately — the slash
      // command set the dirty flag but the REPL loop sync won't run
      // before this tool returns to the LLM. Without this, the next
      // execute_javascript call won't have the plugin's host modules
      // registered, causing "Error resolving module 'host:...'" errors.
      if (pluginManager.consumeSandboxDirty()) {
        await syncPluginsToSandbox();
      }
      // Also consume session dirty so the session rebuilds with
      // updated plugin system messages.
      if (pluginManager.consumeSessionDirty()) {
        state.sessionNeedsRebuild = true;
      }

      // Check if the plugin actually got enabled.
      const pluginState = pluginManager
        .listPlugins()
        .find((p) => p.manifest.name === params.name);
      if (pluginState?.state === "enabled") {
        return {
          success: true,
          message: `Plugin "${params.name}" enabled successfully`,
        };
      } else {
        return {
          success: false,
          error: `Plugin "${params.name}" was not enabled (rejected by policy or user)`,
        };
      }
    } catch (err: unknown) {
      spinner.stop();
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Plugin enable failed: ${msg}` };
    }
  } else {
    // Disable
    const approvalKey = `plugin:disable:${params.name}`;
    if (!state.sessionApprovals.has(approvalKey)) {
      spinner.stop();
      console.log(
        `\n  ${C.warn("🔌 Assistant wants to disable plugin:")} ${C.tool(params.name)}`,
      );
      await drainAndWarn(rl);
      const answer = state.autoApprove
        ? "y"
        : await promptUser(rl, `  ${C.dim("Allow? [y/n] ")}`);
      if (answer.trim().toLowerCase() !== "y") {
        console.log(`  ${C.dim("Denied by user.")}`);
        return { success: false, error: "Plugin disable denied by user" };
      }
      state.sessionApprovals.add(approvalKey);
    }

    const disabled = pluginManager.disable(params.name);
    if (disabled) {
      await syncPluginsToSandbox();
      console.error(`  ${C.ok("⏸️")} Plugin "${params.name}" disabled`);
      return { success: true, message: `Plugin "${params.name}" disabled` };
    } else {
      return {
        success: false,
        error: `Plugin "${params.name}" is not enabled`,
      };
    }
  }
}

// ── Tool: write_output ─────────────────────────────────────────────────
//
// Writes text content directly to the fs-write plugin's base directory.
// Bypasses the sandbox entirely — the LLM doesn't need to wrap text in
// a JavaScript handler just to call writeFile. Only works when fs-write
// is enabled. Uses the same path-jail validation as the plugin.

/** Resolve the baseDir for an enabled fs-* plugin, or null if not enabled. */
function getPluginBaseDir(pluginName: string): string | null {
  const plugin = pluginManager.getPlugin(pluginName);
  if (!plugin || plugin.state !== "enabled") return null;
  const baseDir = plugin.config.baseDir;
  if (typeof baseDir === "string" && baseDir.trim().length > 0) {
    return resolve(baseDir.trim());
  }
  return null;
}

const writeOutputTool = defineTool("write_output", {
  description: [
    "Write text content directly to a file in the output directory.",
    "Requires the fs-write plugin to be enabled — uses the same base directory.",
    "",
    "Use this instead of register_handler when you already have the content",
    "as text (reports, analysis, Markdown, CSV, JSON, etc.).",
    "For binary output (PPTX, ZIP, images), use the sandbox instead.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Filename or relative path within the output directory (e.g. 'report.md', 'data/results.json')",
      },
      content: {
        type: "string",
        description: "Text content to write to the file",
      },
    },
    required: ["path", "content"],
  },
  handler: async (params: { path: string; content: string }) => {
    const baseDir = getPluginBaseDir("fs-write");
    if (!baseDir) {
      return {
        error:
          "fs-write plugin is not enabled. Enable it first with manage_plugin or apply_profile, then try again.",
      };
    }

    const check = validatePath(params.path, baseDir);
    if (!check.valid) {
      return { error: check.error };
    }

    const targetPath = resolve(baseDir, params.path);

    // Ensure parent directory exists
    const parentDir = dirname(targetPath);
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }

    writeFileSync(targetPath, params.content, "utf-8");

    console.error(
      `  ${C.ok("📄")} Wrote ${params.content.length.toLocaleString()} chars → ${params.path}`,
    );

    return {
      success: true,
      path: params.path,
      bytes: Buffer.byteLength(params.content, "utf-8"),
      directory: baseDir,
    };
  },
});

// ── Tool: read_input ──────────────────────────────────────────────────
//
// Reads text content from the fs-read plugin's base directory.
// Bypasses the sandbox — the LLM can read files directly without
// wrapping in a handler. Only works when fs-read is enabled.

const readInputTool = defineTool("read_input", {
  description: [
    "Read text content from a file in the input directory.",
    "Requires the fs-read plugin to be enabled — uses the same base directory.",
    "",
    "Use this instead of register_handler when you just need to read a text file.",
    "For binary files or complex processing, use the sandbox instead.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Filename or relative path within the input directory (e.g. 'data.csv', 'input/config.json')",
      },
    },
    required: ["path"],
  },
  handler: async (params: { path: string }) => {
    const baseDir = getPluginBaseDir("fs-read");
    if (!baseDir) {
      return {
        error:
          "fs-read plugin is not enabled. Enable it first with manage_plugin or apply_profile, then try again.",
      };
    }

    const check = validatePath(params.path, baseDir);
    if (!check.valid) {
      return { error: check.error };
    }

    const targetPath = resolve(baseDir, params.path);

    if (!existsSync(targetPath)) {
      return { error: `File not found: ${params.path}` };
    }

    const content = readFileSync(targetPath, "utf-8");

    console.error(
      `  ${C.ok("📖")} Read ${content.length.toLocaleString()} chars ← ${params.path}`,
    );

    return {
      content,
      path: params.path,
      bytes: Buffer.byteLength(content, "utf-8"),
    };
  },
});

// ── Tool: read_output ─────────────────────────────────────────────────
//
// Reads text content from the fs-write plugin's base directory with
// optional line range support. Used to read large tool results saved
// to the results/ subdirectory, but can read any file in the output dir.

const readOutputTool = defineTool("read_output", {
  description: [
    "Read text content from a file in the output directory, with optional line range.",
    "Requires the fs-write plugin to be enabled — uses the same base directory.",
    "",
    "Use this to read large tool results saved to the results/ subdirectory,",
    "or any other file previously written to the output directory.",
    "Supports startLine/endLine for reading specific sections of large files.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Filename or relative path within the output directory (e.g. 'results/research-1234.txt', 'report.md')",
      },
      startLine: {
        type: "number",
        description:
          "First line to read (1-indexed, inclusive). Omit to start from the beginning.",
      },
      endLine: {
        type: "number",
        description:
          "Last line to read (1-indexed, inclusive). Omit to read to the end.",
      },
    },
    required: ["path"],
  },
  handler: async (params: {
    path: string;
    startLine?: number;
    endLine?: number;
  }) => {
    const baseDir = getPluginBaseDir("fs-write");
    if (!baseDir) {
      return {
        error:
          "fs-write plugin is not enabled. Enable it first with manage_plugin or apply_profile, then try again.",
      };
    }

    const check = validatePath(params.path, baseDir);
    if (!check.valid) {
      return { error: check.error };
    }

    const targetPath = resolve(baseDir, params.path);

    if (!existsSync(targetPath)) {
      return { error: `File not found: ${params.path}` };
    }

    const fullContent = readFileSync(targetPath, "utf-8");
    const allLines = fullContent.split("\n");
    const totalLines = allLines.length;

    // Apply line range (1-indexed, inclusive)
    const start = Math.max(1, params.startLine ?? 1);
    const end = Math.min(totalLines, params.endLine ?? totalLines);
    const selectedLines = allLines.slice(start - 1, end);
    const content = selectedLines.join("\n");

    console.error(
      `  ${C.ok("📖")} Read ${params.path} lines ${start}-${end} of ${totalLines} (${content.length.toLocaleString()} chars)`,
    );

    return {
      content,
      path: params.path,
      totalLines,
      range: { start, end },
      bytes: Buffer.byteLength(content, "utf-8"),
    };
  },
});

// ── Tool: sandbox_help ────────────────────────────────────────────────

const HELP_TOPICS: Record<string, string> = {
  topics: [
    "Available topics: modules, profiles, patterns, state, handlers, binary, fetch, debugging, limits",
    "Call sandbox_help with one of these topic names to get detailed guidance.",
  ].join("\n"),

  modules: [
    "USER MODULES — REUSABLE ES MODULE LIBRARIES:",
    "",
    "Modules are persistent JavaScript libraries importable by handlers.",
    "Import syntax: import { fn } from 'ha:<name>'",
    "",
    "DISCOVERY (see system message for mandatory rules):",
    "  1. Call list_modules to see what's available",
    "  2. Call module_info(name) to see exports, JSDoc, rules, and related modules",
    "  3. Call plugin_info(name) for plugin APIs before using them",
    "  4. Only call register_module if nothing suitable exists",
    "",
    "SYSTEM MODULES (always available, immutable):",
    "  str-bytes  — strToBytes, bytesToStr, strToUtf8Bytes, uint16LE, uint32LE, concatBytes",
    "  crc32      — crc32(data), crc32Update(crc, data), crc32Finalize(crc)",
    "  base64     — encode(bytes), decode(str)",
    "  xml-escape — escapeXml(str), escapeAttr(str), el(tag, content, attrs)",
    "  zip-format — createZip(entries) — builds valid ZIP files from entries array",
    "  image      — getImageDimensions(data, format), detectImageDimensions(data) — read PNG/JPEG/GIF/BMP header",
    "  html       — htmlToText(html), extractLinks(html), parseHtml(html) — extract text/links from HTML",
    "  markdown   — markdownToHtml(md), markdownToText(md) — convert Markdown to HTML or plain text",
    "",
    "CREATING A MODULE:",
    "  register_module({",
    "    name: 'my-utils',",
    "    source: 'export function double(x) { return x * 2; }',",
    "    description: 'Math utilities'",
    "  })",
    "  Handler code: import { double } from 'ha:my-utils';",
    "",
    "RULES:",
    "  - Module names: lowercase, hyphens, digits (e.g. 'csv-parser')",
    "  - Add JSDoc to exports for discoverability",
    "  - Modules can import other modules: import { crc32 } from 'ha:crc32'",
    "  - Modules can import host plugins: import * as fs from 'host:fs-write'",
    "  - Modules persist across sessions — write generic, reusable code",
    "  - System modules cannot be modified or deleted",
    "  - Max module size: 512KB",
    "  - Modules with structured hints show rules, related modules, and anti-patterns via module_info",
    "    (module_info returns hints when present — helps with complex APIs)",
    "",
    "BINARY OUTPUT (PPTX, ZIP, etc.):",
    "  createZip(entries) returns Uint8Array.",
    "  You MUST use fsWrite.writeFileBinary(path, data) for Uint8Array.",
    "  Do NOT use fsWrite.writeFile() — it only accepts strings.",
    "  writeFileBinary THROWS on error — wrap in try/catch.",
    "  Example:",
    "    import { createZip } from 'ha:zip-format';",
    "    import * as fs from 'host:fs-write';",
    "    const zipBytes = createZip(pres.build());",
    "    fs.writeFileBinary('output.pptx', zipBytes);",
    "",
    "MODULE vs HANDLER:",
    "  Handler = entry point you CALL via execute_javascript(name, event)",
    "  Module  = library you IMPORT via import { fn } from 'ha:name'",
  ].join("\n"),

  patterns: [
    "SANDBOX PATTERNS — reusable recipes for common tasks:",
    "",
    "two-handler-pipeline: STATEFUL HANDLER WITH EVENT DISPATCH (most common)",
    "Register ONE handler with module-level state. Call it repeatedly with",
    "different event.action values. State persists across calls.",
    "Example:",
    "  register_handler('builder', `",
    "    import * as pptx from 'ha:pptx';",
    "    let pres = null;",
    "    export function handler(event) {",
    "      if (event.action === 'init') { pres = pptx.createPresentation(); return {ok:true}; }",
    "      if (event.action === 'addSlide') { pptx.contentSlide(pres, event); return {ok:true}; }",
    "      if (event.action === 'build') { /* ... build + write */ }",
    "    }",
    "  `)",
    "  execute_javascript('builder', {action:'init'})",
    "  execute_javascript('builder', {action:'addSlide', title:'Intro', items:[...]})",
    "  execute_javascript('builder', {action:'build'})",
    "The 'pres' variable survives across all three calls. This is normal.",
    "",
    "file-generation: BINARY FILE BUILDING (requires fs-write plugin)",
    "Import system modules instead of writing utilities inline:",
    "  import { strToBytes, uint32LE, concatBytes } from 'ha:str-bytes';",
    "  import { crc32 } from 'ha:crc32';",
    "  import { createZip } from 'ha:zip-format';",
    "Use writeFileBinary/appendFileBinary to write up to 10 MB.",
    "Binary functions accept Uint8Array directly — no base64 needed.",
    "",
    "fetch-and-process: FETCH + PROCESS (requires fetch plugin)",
    "fetch uses TWO-STEP: f.get(url)→{status,ok,contentType}, then f.read(url)→{data,done}",
    "Loop read() until done, push chunks to array, join at end. ALWAYS check meta.ok first.",
    "Use ha:html parseHtml() or htmlToText() to extract content from HTML responses.",
    "Use ha:markdown markdownToText() for Markdown content.",
    "",
    "image-embed: IMAGE EMBEDDING",
    "Use ha:image getImageDimensions() to read width/height from PNG/JPEG/GIF/BMP headers.",
    "Calculate aspect-ratio-correct placement before embedding.",
    "Pass raw Uint8Array bytes — no base64 encoding needed for PPTX.",
    "",
    "data-transformation: DATA PROCESSING",
    "Process/filter/aggregate data using event dispatch pattern.",
    "Use ha:shared-state for cross-handler data sharing.",
    "",
    "REUSABLE MODULES:",
    "If writing utility code that could be reused across tasks, register it as a module:",
    "  register_module({ name: 'csv-parser', source: '...', description: 'Parse CSV' })",
    "Then import in any handler: import { parseCSV } from 'ha:csv-parser';",
    "ALWAYS call list_modules first — a module may already exist for what you need.",
    "System modules (str-bytes, crc32, base64, xml-escape, zip-format, image, html, markdown)",
    "are always available and cover the most common needs. Do NOT rewrite them inline.",
  ].join("\n"),

  state: [
    "STATE RULES:",
    "- Calling execute_javascript on the SAME handler multiple times: state PRESERVED",
    "  Module-level variables (let, const, objects, arrays) survive across calls.",
    "  This is the NORMAL pattern — create state in call 1, use it in call 2+.",
    "- ANY of these operations trigger recompile → module-level state LOST:",
    "    • register_handler (new or updated)",
    "    • delete_handler",
    "    • register_module / delete_module",
    "    • config changes (/set, /timeout, /buffer, /plugin)",
    "    • reset_sandbox",
    "  Module-level variables (let, const, var) reset to initial values.",
    "  ha:shared-state is AUTO-PRESERVED — saved after every execution,",
    "  restored automatically after recompile. No manual steps needed.",
    "- Re-registering same name+code: NO-OP (state preserved)",
    "",
    "CROSS-HANDLER STATE SHARING:",
    "  Handler A: import { set } from 'ha:shared-state'; set('data', result);",
    "  Handler B: import { get } from 'ha:shared-state'; const data = get('data');",
    "  This works because ESM modules are singletons — all handlers see the same instance.",
    "  State in ha:shared-state persists across execute calls AND across recompiles.",
    "",
    "BEST PRACTICE: Use ONE handler with event.action dispatch for simple tasks.",
    "For complex multi-handler workflows (e.g. research + build), use ha:shared-state.",
    "Data stored in shared-state automatically survives handler registrations.",
    "",
    "Handler cache survives config rebuilds — code is re-registered automatically.",
    "But handler module-level variables (let, const, var) are reset to their initial values.",
  ].join("\n"),

  handlers: [
    "HANDLER EXECUTION MODEL:",
    "- Handlers receive JSON (event param), return JSON (result)",
    "- Can import plugin modules: import * as x from 'host:<plugin>'",
    "- Module-level declarations persist across calls (let, const, var, function)",
    "- Handlers CANNOT call other handlers — they are isolated modules",
    "- YOU orchestrate: pass handler A's result as handler B's event",
    "",
    "TWO CODE STYLES (auto-detected):",
    "- Simple: no 'function handler' → wrapped as function body, locals reset each call",
    "- Module: defines 'function handler(event)' → module-level state persists",
    "",
    "COMMON MISTAKES:",
    "- Function must be named exactly 'handler' (not Handler, handle, main)",
    "- All import statements at the top, before any code",
    "- No unclosed braces, strings, or template literals",
    "- 'Handler function not found' = code structure issue, NOT size limit",
  ].join("\n"),

  binary: [
    "BINARY I/O:",
    "- writeFileBinary(path, Uint8Array) — writes raw bytes, THROWS on error",
    "- appendFileBinary(path, Uint8Array) — appends raw bytes, THROWS on error",
    "- readFileBinary(path) → Uint8Array — reads raw bytes, THROWS on error",
    "- readFileChunkBinary(path, offset, length) → Uint8Array",
    "- Text functions (writeFile, readFile) return {error} on failure",
    "",
    "String ↔ bytes conversion:",
    "  new TextEncoder().encode(str) → Uint8Array (UTF-8)",
    "  new TextDecoder().decode(bytes) → string (UTF-8)",
    "  import { strToBytes } from 'ha:str-bytes' — Latin-1 (single-byte)",
    "  atob(base64) → decoded string, btoa(string) → base64",
    "",
    "Max 1 MB per write/append call. Multiple calls build up to 10 MB per file.",
  ].join("\n"),

  fetch: [
    "FETCH PLUGIN API (TWO-STEP PATTERN):",
    "  import * as f from 'host:fetch';",
    "",
    "Step 1: f.get(url) → {status, ok, contentType, totalBytes}",
    "  - Returns metadata ONLY, no body",
    "  - Check meta.error and meta.ok before reading",
    "",
    "Step 2: f.read(url) → {data, done}",
    "  - Call in a loop until done === true",
    "  - Use array push + join (NOT string concatenation)",
    "",
    "Full example:",
    "  const meta = f.get(url);",
    "  if (meta.error) return {error: meta.error};",
    "  if (!meta.ok) return {error: 'HTTP '+meta.status};",
    "  const chunks = [];",
    "  let c;",
    "  do { c = f.read(url); chunks.push(c.data); } while (!c.done);",
    "  const body = chunks.join('');",
    "",
    "Also supports: f.post(url, body), f.post(url, body, {headers: {...}})",
    "Call plugin_info('fetch') for full API including rate limits, caching, pagination.",
  ].join("\n"),

  debugging: [
    "DEBUGGING TIPS:",
    "- 'not a function' = you guessed a method name. Call module_info/plugin_info to verify.",
    "- register_handler returns codeSize and mode (module/simple) — check these",
    "- If handler errors, try a minimal version first",
    "- Build up complexity gradually — add one feature at a time",
    "- Use try/catch inside handlers to catch runtime errors cleanly",
    "- 'Handler function not found' = syntax issue, NOT code size limit",
    "- Nested backticks (`) are the #1 cause of invisible syntax errors",
    "",
    "UNAVAILABLE APIs (will crash if used):",
    "- setTimeout / setInterval — no async scheduling",
    "- fetch() / XMLHttpRequest — use fetch plugin",
    "- Buffer (Node.js) — use Uint8Array",
    "- fs / path / process — use plugins",
    "",
    "AVAILABLE GLOBALS (no import needed):",
    "- TextEncoder / TextDecoder — UTF-8 string ↔ bytes",
    "- atob / btoa — base64 encode/decode",
    "- queueMicrotask — schedule microtask",
  ].join("\n"),

  limits: [
    "RESOURCE LIMITS (current values shown in system message):",
    "- CPU timeout: actual CPU time, excludes host call blocking",
    "- Wall-clock timeout: total elapsed time including host calls",
    "- Heap: JS objects, strings, arrays, closures — 'malloc failed' = too small",
    "- Scratch: call stack + engine working memory — 'Out of physical memory' = too small",
    "- Input buffer: host→guest (readFile results, fetch responses)",
    "- Output buffer: guest→host (writeFile content, handler return value)",
    "",
    "ON LIMIT ERRORS:",
    "Call configure_sandbox to increase the relevant limit and retry.",
    "No need to ask the user — just fix it and continue.",
    "If the same limit fails repeatedly after increases, then ask.",
    "",
    "PROACTIVE INCREASES ARE FINE:",
    "If a task clearly needs more resources (ZIP/PPTX, many fetches, large data),",
    "increase limits BEFORE starting. Do not waste time trying to fit into defaults.",
  ].join("\n"),

  profiles: [
    "RESOURCE PROFILES:",
    "Use apply_profile to configure the sandbox for a specific type of task.",
    "Profiles set appropriate resource limits AND enable required plugins.",
    "You can stack multiple profiles: apply_profile(['web-research', 'heavy-compute'])",
    "Stacking takes the MAX of each limit and the UNION of all plugins.",
    "Profiles are ADDITIVE — they never downgrade limits or disable plugins.",
    "",
    "AVAILABLE PROFILES:",
    "",
    formatAllProfiles(),
    "",
    "STACKING EXAMPLE:",
    "  apply_profile(['web-research', 'heavy-compute'])",
    "  → Limits take MAX, plugins take UNION",
    "",
    "WHEN TO USE PROFILES vs configure_sandbox:",
    "  • Use profiles for common tasks — one call, sensible defaults",
    "  • Use configure_sandbox to fine-tune individual limits after a profile",
    "  • Profiles are the PREFERRED approach — simpler and less error-prone",
    "",
    "PLUGIN CONFIG:",
    "  Profiles include sensible default config for their plugins.",
    "  These defaults are applied automatically — no interactive prompts.",
    "",
    "  REQUIRED FIELDS (must be passed in pluginConfig or will be prompted):",
    "    web-research → fetch.allowedDomains (REQUIRED, no default)",
    "    file-builder → no required fields (fs-write defaults to temp dir)",
    "",
    "  Pass pluginConfig to set required + optional fields:",
    "    apply_profile({profiles:'web-research', pluginConfig:{",
    "      fetch:{allowedDomains:'api.github.com,*.example.com'}",
    "    }})",
    "  Call plugin_info(name) to see what config keys a plugin accepts.",
  ].join("\n"),
};

// ── Tool: llm_thought (tune mode only) ───────────────────────────────
// Gives the LLM a structured way to log its decision process, concerns,
// and reasoning. Only available when --tune is active. Writes to JSONL
// for post-session analysis and prompt tuning.

const llmThoughtTool = defineTool("llm_thought", {
  description: [
    "Log a brief thought about your decision process, a concern, a constraint",
    "you're considering, or an alternative you rejected.",
    "",
    "Use this to make your reasoning visible — then MOVE ON immediately.",
    "Do NOT use this to deliberate or seek permission. Log and act.",
    "",
    "Categories:",
    "  decision — why you chose a specific approach",
    "  concern — a potential problem you've identified",
    "  constraint — a limit or boundary you're working within",
    "  alternative_rejected — an approach you considered but didn't take",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      category: {
        type: "string",
        enum: ["decision", "concern", "constraint", "alternative_rejected"],
        description: "Type of thought being logged",
      },
      message: {
        type: "string",
        description: "One sentence (max ~120 chars). Be concise.",
      },
    },
    required: ["category", "message"],
  },
  handler: async (params: { category: string; message: string }) => {
    const cat = params.category;
    if (!TUNE_CATEGORIES.has(cat)) {
      return {
        error: `Invalid category "${cat}". Use: decision, concern, constraint, alternative_rejected`,
      };
    }
    writeTuneEntry(cat as TuneCategory, params.message);
    return { logged: true };
  },
});

const sandboxHelpTool = defineTool("sandbox_help", {
  description: [
    "Get detailed guidance on sandbox patterns, state management, binary I/O,",
    "fetch API, debugging, or resource limits.",
    "Call with a topic name: patterns, state, handlers, binary, fetch, debugging, limits.",
    "Call with no topic to see the list of available topics.",
    "",
    "Use this BEFORE writing complex handler code to understand the right approach.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      topic: {
        type: "string",
        description:
          "Help topic: patterns, state, handlers, binary, fetch, debugging, limits",
      },
    },
  },
  handler: async ({ topic }: { topic?: string }) => {
    const key = (topic || "topics").toLowerCase().trim();
    const content = HELP_TOPICS[key];
    if (!content) {
      return {
        error: `Unknown topic "${topic}". Available: ${Object.keys(HELP_TOPICS).join(", ")}`,
      };
    }
    return { topic: key, content };
  },
});

// ── Tool: apply_profile ─────────────────────────────────────────────

const applyProfileTool = defineTool("apply_profile", {
  description: [
    "Apply one or more resource profiles to configure the sandbox for a",
    "specific type of task. Profiles bundle resource limits + required",
    "plugins into a single step.",
    "",
    `Available profiles: ${getProfileNames().join(", ")}`,
    "",
    "Stacking: pass multiple profiles to combine them (max of each limit,",
    "union of all plugins). e.g. ['web-research', 'heavy-compute']",
    "",
    "Profiles are ADDITIVE — they never downgrade limits or disable plugins.",
    "Plugins still go through audit + user approval.",
    "",
    "Use this INSTEAD of manually calling configure_sandbox + manage_plugin.",
    "Call sandbox_help('profiles') for detailed descriptions of each profile.",
    "",
    "REQUIRED plugin config for profiles with plugins:",
    "  web-research: MUST pass pluginConfig.fetch.allowedDomains (comma-separated domains)",
    "    Example: apply_profile({profiles:'web-research',",
    "      pluginConfig:{fetch:{allowedDomains:'api.github.com,*.example.com'}}})",
    "  file-builder: no required config (fs-write uses temp dir by default)",
    "",
    "If you omit required pluginConfig, the user will be prompted interactively.",
    "Call plugin_info(name) to see all config fields for a plugin.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      profiles: {
        oneOf: [
          { type: "string", description: "Single profile name" },
          {
            type: "array",
            items: { type: "string" },
            description: "Multiple profile names to stack",
          },
        ],
        description: `Profile name(s): ${getProfileNames().join(", ")}`,
      },
      pluginConfig: {
        type: "object",
        description:
          "Per-plugin configuration. Keys are plugin names, values are config objects. " +
          "Example: {fetch: {domains: 'api.github.com', allowPost: true}, 'fs-write': {baseDir: '/tmp/output'}}",
      },
    },
    required: ["profiles"],
  },
  handler: async (params: {
    profiles: string | string[];
    pluginConfig?: Record<string, Record<string, unknown>>;
  }) => {
    // Normalize to array
    const names = Array.isArray(params.profiles)
      ? params.profiles
      : [params.profiles];

    // Serialize — profile application may enable plugins (interactive)
    const release = await acquireInteractiveLock();
    try {
      return await applyProfileImpl(names, params.pluginConfig);
    } finally {
      release();
    }
  },
});

/** Internal implementation for apply_profile — called under lock. */
async function applyProfileImpl(
  names: string[],
  pluginConfig?: Record<string, Record<string, unknown>>,
) {
  const rl = state.readlineInstance;
  if (!rl) {
    return {
      success: false,
      error: "No readline available for approval prompt",
    };
  }

  // Merge requested profiles
  const merged = mergeProfiles(names);
  if (merged.error) {
    return { success: false, error: merged.error };
  }

  // Get current config for comparison
  const currentConfig = getEffectiveConfig(sandbox, state);

  // Build a summary showing profile values vs current values
  const limitChanges: string[] = [];
  if (merged.limits.cpuTimeoutMs !== undefined) {
    const current = currentConfig.cpuTimeoutMs;
    const willChange = merged.limits.cpuTimeoutMs > current;
    limitChanges.push(
      willChange
        ? `cpu: ${current}ms → ${merged.limits.cpuTimeoutMs}ms`
        : `cpu: ${merged.limits.cpuTimeoutMs}ms (already ≥)`,
    );
  }
  if (merged.limits.wallTimeoutMs !== undefined) {
    const current = currentConfig.wallTimeoutMs;
    const willChange = merged.limits.wallTimeoutMs > current;
    limitChanges.push(
      willChange
        ? `wall: ${current}ms → ${merged.limits.wallTimeoutMs}ms`
        : `wall: ${merged.limits.wallTimeoutMs}ms (already ≥)`,
    );
  }
  if (merged.limits.heapMb !== undefined) {
    const current = currentConfig.heapMb;
    const willChange = merged.limits.heapMb > current;
    limitChanges.push(
      willChange
        ? `heap: ${current}MB → ${merged.limits.heapMb}MB`
        : `heap: ${merged.limits.heapMb}MB (already ≥)`,
    );
  }
  if (merged.limits.scratchMb !== undefined) {
    const current = currentConfig.scratchMb;
    const willChange = merged.limits.scratchMb > current;
    limitChanges.push(
      willChange
        ? `scratch: ${current}MB → ${merged.limits.scratchMb}MB`
        : `scratch: ${merged.limits.scratchMb}MB (already ≥)`,
    );
  }
  if (merged.limits.inputBufferKb !== undefined) {
    const current = currentConfig.inputBufferKb;
    const willChange = merged.limits.inputBufferKb > current;
    limitChanges.push(
      willChange
        ? `input: ${current}KB → ${merged.limits.inputBufferKb}KB`
        : `input: ${merged.limits.inputBufferKb}KB (already ≥)`,
    );
  }
  if (merged.limits.outputBufferKb !== undefined) {
    const current = currentConfig.outputBufferKb;
    const willChange = merged.limits.outputBufferKb > current;
    limitChanges.push(
      willChange
        ? `output: ${current}KB → ${merged.limits.outputBufferKb}KB`
        : `output: ${merged.limits.outputBufferKb}KB (already ≥)`,
    );
  }

  const pluginNames = merged.plugins.map((p) => p.name);

  // Stop spinner before prompting (timer is paused by promptUser)
  spinner.stop();

  // Show what the profile will do
  const profileLabel =
    merged.appliedProfiles.length === 1
      ? merged.appliedProfiles[0]
      : merged.appliedProfiles.join(" + ");

  console.log(`\n  ${C.warn("📋 Profile:")} ${C.tool(profileLabel)}`);
  if (limitChanges.length > 0) {
    console.log(`     Limits:`);
    for (const change of limitChanges) {
      console.log(`       ${change}`);
    }
  }
  if (pluginNames.length > 0) {
    console.log(`     Plugins: ${pluginNames.join(", ")}`);
  } else {
    console.log(`     Plugins: none`);
  }

  await drainAndWarn(rl);
  const approval = state.autoApprove
    ? "y"
    : await promptUser(rl, `  ${C.dim("Apply? [y/n] ")}`);
  if (approval.trim().toLowerCase() !== "y") {
    console.log(`  ${C.dim("Denied by user.")}`);
    return { success: false, error: "Profile application denied by user" };
  }

  // Apply limits (only set values that INCREASE current config)
  // currentConfig already fetched above for the summary display
  const limitsToApply: Record<string, number> = {};

  if (
    merged.limits.cpuTimeoutMs !== undefined &&
    merged.limits.cpuTimeoutMs > currentConfig.cpuTimeoutMs
  ) {
    limitsToApply.cpuTimeout = merged.limits.cpuTimeoutMs;
  }
  if (
    merged.limits.wallTimeoutMs !== undefined &&
    merged.limits.wallTimeoutMs > currentConfig.wallTimeoutMs
  ) {
    limitsToApply.wallTimeout = merged.limits.wallTimeoutMs;
  }
  if (
    merged.limits.heapMb !== undefined &&
    merged.limits.heapMb > currentConfig.heapMb
  ) {
    limitsToApply.heap = merged.limits.heapMb;
  }
  if (
    merged.limits.scratchMb !== undefined &&
    merged.limits.scratchMb > currentConfig.scratchMb
  ) {
    limitsToApply.scratch = merged.limits.scratchMb;
  }
  if (
    merged.limits.inputBufferKb !== undefined &&
    merged.limits.inputBufferKb > currentConfig.inputBufferKb
  ) {
    limitsToApply.inputBuffer = merged.limits.inputBufferKb;
  }
  if (
    merged.limits.outputBufferKb !== undefined &&
    merged.limits.outputBufferKb > currentConfig.outputBufferKb
  ) {
    limitsToApply.outputBuffer = merged.limits.outputBufferKb;
  }

  // Apply config changes if any limits are increasing
  let configResult;
  if (Object.keys(limitsToApply).length > 0) {
    configResult = await applySandboxConfig(sandbox, state, limitsToApply);
    if (configResult.success) {
      console.error(`  ${C.ok("✅ Limits applied:")} ${configResult.message}`);
    } else {
      return {
        success: false,
        error: `Failed to apply limits: ${configResult.error}`,
      };
    }
  } else {
    console.error(
      `  ${C.dim("Limits: current values already meet or exceed profile.")}`,
    );
  }

  // Enable required plugins (each goes through audit+approval)
  const enabledPlugins: string[] = [];
  const skippedPlugins: string[] = [];
  const failedPlugins: string[] = [];

  for (const plugin of merged.plugins) {
    // Check if already enabled
    const existing = pluginManager.getPlugin(plugin.name);
    if (existing?.state === "enabled") {
      skippedPlugins.push(plugin.name);
      continue;
    }

    // Build config string for the slash command.
    // Merge: tool-provided pluginConfig > profile defaultConfig.
    // Remaining uncovered keys are prompted interactively.
    const mergedConfig: Record<string, unknown> = {
      ...(plugin.defaultConfig ?? {}),
      ...(pluginConfig?.[plugin.name] ?? {}),
    };

    const configStr =
      Object.keys(mergedConfig).length > 0
        ? " " +
          Object.entries(mergedConfig)
            .map(([k, v]) => {
              if (Array.isArray(v)) return `${k}=[${v.join(",")}]`;
              return `${k}=${v}`;
            })
            .join(" ")
        : "";

    const syntheticInput = `/plugin enable ${plugin.name}${configStr}`;
    try {
      await handleSlashCommand(syntheticInput, rl);
      spinner.stop(); // ensure spinner is off after

      // Check if enable succeeded
      const after = pluginManager.getPlugin(plugin.name);
      if (after?.state === "enabled") {
        enabledPlugins.push(plugin.name);
      } else {
        console.error(
          `  ${C.err("❌")} Plugin "${plugin.name}" was not enabled after audit/config flow`,
        );
        failedPlugins.push(plugin.name);
      }
    } catch (err) {
      console.error(
        `  ${C.err("❌")} Plugin "${plugin.name}" enable failed: ${(err as Error).message}`,
      );
      failedPlugins.push(plugin.name);
    }
  }

  // Sync plugins to sandbox if any were enabled
  if (enabledPlugins.length > 0 && pluginManager.consumeSandboxDirty()) {
    await syncPluginsToSandbox();
    // Also consume session-dirty so the session rebuilds
    if (pluginManager.consumeSessionDirty()) {
      state.sessionNeedsRebuild = true;
    }
  }

  // Build result
  const effective = getEffectiveConfig(sandbox, state);
  const result: Record<string, unknown> = {
    success: true,
    profiles: merged.appliedProfiles,
    effective,
  };

  if (enabledPlugins.length > 0) result.enabledPlugins = enabledPlugins;
  if (skippedPlugins.length > 0) result.alreadyEnabled = skippedPlugins;
  if (failedPlugins.length > 0) {
    result.failedPlugins = failedPlugins;
    result.warning = `Some plugins failed to enable: ${failedPlugins.join(", ")}`;
  }
  if (configResult?.sandboxRebuilt) result.sandboxRebuilt = true;

  console.error(`  ${C.ok("📋 Profile applied:")} ${profileLabel}`);

  return result;
}

// ── Tool: list_plugins ───────────────────────────────────────────────

const listPluginsTool = defineTool("list_plugins", {
  description: [
    "List all available plugins with their name, description, and status.",
    "Use this to discover what plugins exist and whether they are enabled.",
    "To get detailed info about a specific plugin, use plugin_info.",
    "To enable a plugin, suggest the /plugin enable command to the user.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {},
  },
  handler: async () => {
    const all = pluginManager.listPlugins();
    const plugins = all.map((p) => ({
      name: p.manifest.name,
      version: p.manifest.version,
      description: p.manifest.description,
      status: p.state === "enabled" ? "enabled" : "available",
      riskLevel: p.audit?.riskLevel ?? "unaudited",
      hostModules: p.manifest.hostModules,
      companions: p.manifest.companions ?? [],
    }));
    return { plugins, total: plugins.length };
  },
});

// ── Tool: plugin_info ────────────────────────────────────────────────

/**
 * Extract API declarations for a specific host module from host-modules.d.ts.
 * Returns the declare module block content (function signatures with JSDoc).
 */
function extractHostModuleApi(moduleName: string): string | null {
  const hostModulesDtsPath = join(pluginsDir, "host-modules.d.ts");
  if (!existsSync(hostModulesDtsPath)) return null;

  const content = readFileSync(hostModulesDtsPath, "utf-8");
  // Match: declare module "host:moduleName" { ... }
  const modulePattern = new RegExp(
    `declare module "host:${moduleName}"\\s*\\{([\\s\\S]*?)\\n\\}`,
    "m",
  );
  const match = content.match(modulePattern);
  if (!match) return null;

  // Clean up the content: remove leading indentation, keep JSDoc and signatures
  return match[1]
    .split("\n")
    .map((line) => line.replace(/^  /, "")) // Remove 2-space indent
    .join("\n")
    .trim();
}

const pluginInfoTool = defineTool("plugin_info", {
  description: [
    "Get detailed information about a specific plugin including its full API.",
    "Returns the TypeScript function signatures with JSDoc comments for all",
    "host module functions provided by the plugin. CALL THIS before writing",
    "any handler code that uses host:* modules to ensure correct API usage.",
    "Use list_plugins first to see available plugin names.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Plugin name (e.g. 'fs-write', 'fetch').",
      },
    },
    required: ["name"],
  },
  handler: async ({ name }: { name: string }) => {
    // Track that the LLM has engaged with API discovery
    // This also satisfies the hasCalledListModules requirement for register_handler
    state.hasCalledListModules = true;

    const all = pluginManager.listPlugins();
    const plugin = all.find((p) => p.manifest.name === name);
    if (!plugin) {
      return {
        error: `Plugin "${name}" not found. Use list_plugins to see available plugins.`,
      };
    }

    // Extract API declarations from host-modules.d.ts for each host module
    const apiDeclarations: Record<string, string> = {};
    if (plugin.manifest.hostModules?.length) {
      for (const moduleName of plugin.manifest.hostModules) {
        const api = extractHostModuleApi(moduleName);
        if (api) {
          apiDeclarations[`host:${moduleName}`] = api;
        }
      }
    }

    return {
      name: plugin.manifest.name,
      version: plugin.manifest.version,
      description: plugin.manifest.description,
      status: plugin.state === "enabled" ? "enabled" : "available",
      riskLevel: plugin.audit?.riskLevel ?? "unaudited",
      hostModules: plugin.manifest.hostModules,
      companions: plugin.manifest.companions ?? [],
      configSchema: plugin.manifest.configSchema ?? {},
      currentConfig: plugin.config ?? {},
      // Full API declarations extracted from host-modules.d.ts
      api:
        Object.keys(apiDeclarations).length > 0
          ? apiDeclarations
          : "(no API declarations found)",
      // Import pattern for handlers
      importPattern: plugin.manifest.hostModules?.length
        ? plugin.manifest.hostModules
            .map((m) => `import * as ${m.replace(/-/g, "")} from "host:${m}";`)
            .join("\n")
        : null,
      // Capabilities, constraints, and usage examples
      // Prefer structured hints from plugin.json, fall back to legacy systemMessage
      ...(plugin.manifest.hints
        ? { hints: formatStructuredHints(plugin.manifest.hints) }
        : plugin.manifest.systemMessage
          ? { systemMessage: plugin.manifest.systemMessage }
          : {}),
    };
  },
});

// ── MCP SDK Tools ────────────────────────────────────────────────────
//
// Three tools for LLM-driven MCP server management. Only available
// when the gateway `mcp` plugin is enabled. The LLM discovers MCP
// by first enabling `mcp` via manage_plugin, then using these tools.

/**
 * Check whether the MCP gateway plugin is enabled.
 * All MCP SDK tools gate on this — returns an error message if not.
 */
function requireMCPEnabled(): string | null {
  const mcpPlugin = pluginManager.getPlugin("mcp");
  if (!mcpPlugin || mcpPlugin.state !== "enabled") {
    return 'MCP is not enabled. Enable it first: use manage_plugin to enable "mcp", then retry.';
  }
  if (!mcpManager) {
    return "No MCP servers configured. Add servers to ~/.hyperagent/config.json under mcpServers.";
  }
  return null;
}

const listMCPServersTool = defineTool("list_mcp_servers", {
  description: [
    "List all configured MCP servers with their connection state and available tools.",
    "Use this to discover which external tool servers are available.",
    "Works even before the MCP gateway plugin is enabled.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {},
  },
  handler: async () => {
    if (!mcpManager) {
      return {
        servers: [],
        total: 0,
        hint: "No MCP servers configured. Add servers to ~/.hyperagent/config.json under mcpServers.",
      };
    }

    const servers = mcpManager.listServers().map((conn) => ({
      name: conn.name,
      state: conn.state,
      transport: isMCPHttpConfig(conn.config) ? "http" : "stdio",
      endpoint: mcpConfigDisplayString(conn.config),
      toolCount: conn.tools.length,
      tools: conn.tools.map((t) => t.name),
      module: `host:mcp-${conn.name}`,
      lastError: conn.lastError ?? null,
    }));

    return { servers, total: servers.length };
  },
});

const mcpServerInfoTool = defineTool("mcp_server_info", {
  description: [
    "Get detailed information about a specific MCP server including its",
    "tool schemas, connection state, and TypeScript declarations.",
    "Use list_mcp_servers first to see available server names.",
    "Prefer mcp_tool_info for focused schema lookup before choosing tools.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: 'MCP server name (e.g. "github", "everything").',
      },
      tools: {
        type: "array",
        description:
          "Optional tool names to include. Use this to avoid huge all-server schema dumps.",
        items: { type: "string" },
      },
      query: {
        type: "string",
        description:
          'Optional search query for relevant tools (e.g. "messages chats recent").',
      },
      limit: {
        type: "number",
        description: "Maximum tools to return when filtering or searching.",
      },
    },
    required: ["name"],
  },
  handler: async ({
    name,
    tools,
    query,
    limit,
  }: {
    name: string;
    tools?: string[];
    query?: string;
    limit?: number;
  }) => {
    const err = requireMCPEnabled();
    if (err) return { error: err };

    // Also counts as API discovery (satisfies hasCalledListModules)
    state.hasCalledListModules = true;

    const conn = mcpManager!.getConnection(name);
    if (!conn) {
      const available = mcpManager!
        .listServers()
        .map((c) => c.name)
        .join(", ");
      return {
        error: `MCP server "${name}" not found. Available: ${available || "(none)"}`,
      };
    }

    const selection = selectMCPTools(conn.tools, { tools, query, limit });

    // Generate TypeScript declarations for the selected tools
    let declarations: string | null = null;
    if (selection.tools.length > 0) {
      const selectedSchemas = selection.tools
        .map((tool) => findMCPTool(conn.tools, tool.name))
        .filter((tool): tool is MCPToolSchema => tool !== undefined);
      declarations = generateMCPDeclarations(conn.name, selectedSchemas);
    }

    return {
      name: conn.name,
      state: conn.state,
      transport: isMCPHttpConfig(conn.config) ? "http" : "stdio",
      endpoint: mcpConfigDisplayString(conn.config),
      toolCount: conn.tools.length,
      returnedToolCount: selection.tools.length,
      totalMatches: selection.totalMatches,
      missingTools: selection.missing,
      tools: selection.tools,
      module: `host:mcp-${conn.name}`,
      importPattern:
        selection.tools.length > 0
          ? `import { ${selection.tools.map((t) => t.name).join(", ")} } from "host:mcp-${conn.name}";`
          : null,
      declarations,
      lastError: conn.lastError ?? null,
      hint: "Use register_handler to import selected tools from the host:mcp-* module and execute MCP calls inside sandbox handler code.",
    };
  },
});

const mcpToolInfoTool = defineTool("mcp_tool_info", {
  description: [
    "Get focused schema information for relevant tools on one MCP server.",
    "Use this before writing handler code so you do not guess parameter names.",
    "Pass either explicit tools or a natural-language query.",
    "After this, register a handler that imports the selected tools from host:mcp-<name>.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: 'MCP server name (e.g. "github", "work-iq-teams").',
      },
      tools: {
        type: "array",
        description: "Specific MCP tool names to inspect.",
        items: { type: "string" },
      },
      query: {
        type: "string",
        description:
          'Search terms for relevant tools (e.g. "last messages chats").',
      },
      limit: {
        type: "number",
        description: "Maximum matching tools to return; defaults to 8.",
      },
    },
    required: ["name"],
  },
  handler: async ({
    name,
    tools,
    query,
    limit,
  }: {
    name: string;
    tools?: string[];
    query?: string;
    limit?: number;
  }) => {
    const err = requireMCPEnabled();
    if (err) return { error: err };

    state.hasCalledListModules = true;

    const conn = mcpManager!.getConnection(name);
    if (!conn) {
      const available = mcpManager!
        .listServers()
        .map((c) => c.name)
        .join(", ");
      return {
        error: `MCP server "${name}" not found. Available: ${available || "(none)"}`,
      };
    }

    if (conn.state !== "connected") {
      return {
        name: conn.name,
        state: conn.state,
        tools: [],
        hint: `Connect first with manage_mcp({ action: "connect", name: "${conn.name}" }).`,
      };
    }

    const selection = selectMCPTools(conn.tools, { tools, query, limit });
    const selectedSchemas = selection.tools
      .map((tool) => findMCPTool(conn.tools, tool.name))
      .filter((tool): tool is MCPToolSchema => tool !== undefined);

    return {
      name: conn.name,
      state: conn.state,
      module: `host:mcp-${conn.name}`,
      returnedToolCount: selection.tools.length,
      totalMatches: selection.totalMatches,
      missingTools: selection.missing,
      tools: selection.tools,
      declarations:
        selectedSchemas.length > 0
          ? generateMCPDeclarations(conn.name, selectedSchemas)
          : null,
      handlerImportPattern:
        selection.tools.length > 0
          ? `import { ${selection.tools.map((t) => t.name).join(", ")} } from "host:mcp-${conn.name}";`
          : null,
      handlerCallPattern: `const result = await ${selection.tools[0]?.name ?? "ToolName"}({ /* args from schema */ });`,
    };
  },
});

const manageMCPTool = defineTool("manage_mcp", {
  description: [
    "Connect or disconnect an MCP server. Use list_mcp_servers to discover",
    "available servers. Connecting spawns the server process and discovers",
    "its tools. The user must approve new servers (security review).",
    "",
    "After connecting, the server's tools are available as host:mcp-<name>",
    "modules in handler code.",
    "After connecting, use mcp_tool_info, then register a handler that imports and awaits the selected MCP tools.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Action: 'connect' or 'disconnect'",
        enum: ["connect", "disconnect"],
      },
      name: {
        type: "string",
        description: 'MCP server name (e.g. "github", "everything").',
      },
    },
    required: ["action", "name"],
  },
  handler: async (params: {
    action: "connect" | "disconnect";
    name: string;
  }) => {
    const rl = state.readlineInstance;
    const err = requireMCPEnabled();
    if (err) return { error: err };

    const conn = mcpManager!.getConnection(params.name);
    if (!conn) {
      const available = mcpManager!
        .listServers()
        .map((c) => c.name)
        .join(", ");
      return {
        error: `MCP server "${params.name}" not found. Available: ${available || "(none)"}`,
      };
    }

    if (params.action === "connect") {
      if (conn.state === "connected") {
        return {
          success: true,
          message: `"${params.name}" is already connected with ${conn.tools.length} tool(s).`,
          tools: conn.tools.map((t) => t.name),
          nextStep:
            "Call mcp_tool_info({ name, query }) to choose a tool, then register_handler with imports from host:mcp-<name>.",
        };
      }

      try {
        // For OAuth servers, check if we can authenticate silently
        // (cached/refreshed token). If not, interactive auth would
        // block the tool call indefinitely — bail out and tell the
        // user to authenticate first via /mcp enable.
        if (
          isMCPHttpConfig(conn.config) &&
          conn.config.auth?.method === "oauth"
        ) {
          const canSilent = await canAcquireSilently(
            params.name,
            conn.config.auth,
          );
          if (!canSilent) {
            return {
              success: false,
              error: `"${params.name}" requires authentication. Tell the user to run: /mcp enable ${params.name}`,
              hint: "The user needs to authenticate in their browser first. Once done, you can retry manage_mcp to connect.",
            };
          }
        }

        // Connect and discover tools
        console.error(`[mcp] Connecting to ${params.name}...`);
        const connected = await mcpManager!.connect(params.name);

        // Audit tool descriptions for prompt injection risks
        const warnings = auditMCPTools(connected.tools);

        // Check if already approved (pre-approved via /mcp approve,
        // profile, or a previous session)
        const approvalStore = loadMCPApprovalStore();
        const approved = isMCPApproved(params.name, conn.config, approvalStore);

        if (!approved) {
          // Show server details + tool list to the user
          console.log();
          console.log(`  ${C.label("MCP Server Approval Required")}`);
          console.log();
          console.log(`  Server:  ${C.label(params.name)}`);
          console.log(
            `  ${isMCPStdioConfig(conn.config) ? "Command" : "URL"}:    ${C.dim(mcpConfigDisplayString(conn.config))}`,
          );
          console.log();
          console.log(`  Tools (${connected.tools.length}):`);
          for (const tool of connected.tools) {
            console.log(
              `    ${C.label(tool.name)} — ${tool.description.slice(0, 80)}`,
            );
          }
          if (warnings.length > 0) {
            console.log();
            console.log(`  ${C.err("⚠️  Audit Warnings:")}`);
            for (const w of warnings) {
              console.log(`    ${C.err("•")} ${w}`);
            }
          }
          console.log();

          // Auto-approve or prompt
          if (state.autoApprove) {
            console.log(`  ${C.ok("Auto-approved")} (--auto-approve mode)`);
          } else if (process.stdin.isTTY && rl) {
            await drainAndWarn(rl);
            const answer = await promptUser(
              rl,
              `  Approve "${params.name}"? (y/n) `,
            );
            if (answer.trim().toLowerCase() !== "y") {
              console.log(`  ${C.dim("Denied by user.")}`);
              await mcpManager!.disconnect(params.name);
              return {
                success: false,
                error: `User denied approval for "${params.name}".`,
              };
            }
          } else {
            // Non-interactive, not auto-approved — refuse
            await mcpManager!.disconnect(params.name);
            return {
              success: false,
              error: `"${params.name}" requires approval but no interactive terminal is available. Run /mcp approve ${params.name} first.`,
            };
          }

          // Store approval
          approveMCPServer(
            params.name,
            conn.config,
            connected.tools.map((t) => t.name),
            warnings,
            approvalStore,
          );
        }

        // Sync MCP modules to the sandbox so the LLM can import them
        await syncPluginsToSandbox();

        console.log(
          `  ${C.ok(`✓ "${params.name}" connected`)} — ${connected.tools.length} tool(s) available as ${C.dim(`host:mcp-${params.name}`)}`,
        );

        return {
          success: true,
          message: `"${params.name}" connected with ${connected.tools.length} tool(s).`,
          module: `host:mcp-${params.name}`,
          tools: connected.tools.map((t) => t.name),
          nextStep:
            "Call mcp_tool_info({ name, query }) to choose a tool, then register_handler with imports from host:mcp-<name>.",
        };
      } catch (err) {
        return {
          success: false,
          error: `Failed to connect "${params.name}": ${(err as Error).message}`,
        };
      }
    }

    // Disconnect
    if (conn.state !== "connected") {
      return {
        success: true,
        message: `"${params.name}" is already disconnected (state: ${conn.state}).`,
      };
    }

    await mcpManager!.disconnect(params.name);
    return {
      success: true,
      message: `"${params.name}" disconnected.`,
    };
  },
});

// ── Module Tools ─────────────────────────────────────────────────────
//
// Four tools for user module lifecycle: register, list, info, delete.
// Modules are reusable ES modules importable via "ha:<name>".
// System modules (author="system") are immutable.

const registerModuleTool = defineTool("register_module", {
  description: [
    "Register a reusable JavaScript module that handlers can import.",
    "Modules persist across sessions. Import with: import { fn } from 'ha:<name>'",
    "",
    "BEFORE creating a module, call list_modules to check if one already exists.",
    "Add JSDoc to exports for discoverability.",
    "",
    "System modules (author=system) cannot be overwritten.",
    "User modules can be updated by registering with the same name.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description:
          "Module name (lowercase, hyphens, e.g. 'zip-utils', 'csv-parser')",
      },
      source: {
        type: "string",
        description: "ES module JavaScript source code (must use export)",
      },
      description: {
        type: "string",
        description: "One-line description of what this module provides",
      },
    },
    required: ["name", "source", "description"],
  },
  handler: async (params: {
    name: string;
    source: string;
    description: string;
  }) => {
    const release = await acquireInteractiveLock();
    try {
      return await registerModuleImpl(params);
    } finally {
      release();
    }
  },
});

async function registerModuleImpl(params: {
  name: string;
  source: string;
  description: string;
}) {
  const rl = state.readlineInstance;
  if (!rl) {
    return { success: false, error: "No readline available" };
  }

  // Validate name
  const nameError = validateModuleName(params.name);
  if (nameError) {
    return { success: false, error: nameError };
  }

  // Block registration of names matching system modules
  const existingModule = loadModule(params.name);
  if (existingModule?.author === "system") {
    return {
      success: false,
      error: `"${params.name}" is a system module name and cannot be overwritten. Choose a different name.`,
    };
  }

  // ── Validate module source using Hyperlight analysis guest ─────────────
  // Multi-stage validation: guest parses module, extracts imports, host resolves them
  const availableModules = sandbox.getAvailableModules();

  let validationContext: ValidationContext = {
    handlerName: params.name, // Used for module name in this context
    registeredHandlers: [], // Modules don't conflict with handlers
    availableModules,
    expectHandler: false, // Modules don't need handler() function
  };

  let validationResult;
  try {
    // Multi-stage validation loop (same as register_handler)
    validationResult = await validateJavaScriptGuest(
      params.source,
      validationContext,
    );

    const maxIterations = 20;
    let iterations = 0;
    while (
      !validationResult.deepValidationDone &&
      validationResult.missingSources.length > 0 &&
      validationResult.errors.length === 0 &&
      iterations < maxIterations
    ) {
      iterations++;
      const {
        sources: newSources,
        dtsSources: newDtsSources,
        moduleJsons: newModuleJsons,
      } = loadModuleFilesForValidator(
        validationResult.missingSources,
        pluginManager,
      );
      validationContext = {
        ...validationContext,
        moduleSources: { ...validationContext.moduleSources, ...newSources },
        dtsSources: { ...validationContext.dtsSources, ...newDtsSources },
        moduleJsons: { ...validationContext.moduleJsons, ...newModuleJsons },
      };
      validationResult = await validateJavaScriptGuest(
        params.source,
        validationContext,
      );
    }

    if (iterations >= maxIterations) {
      console.error(
        `  ${C.warn("⚠️")} Validation hit iteration limit - possible circular dependency`,
      );
    }

    // Report warnings
    for (const warning of validationResult.warnings) {
      console.error(`  ${C.warn("⚠️")} ${warning.message}`);
    }

    // Block registration if validation failed
    if (!validationResult.valid) {
      const errorMessages = validationResult.errors
        .map((e) => {
          const loc = e.line ? ` (line ${e.line})` : "";
          return `${e.type}: ${e.message}${loc}`;
        })
        .join("\n  • ");
      const errorResult = {
        success: false,
        error: `Validation failed:\n  • ${errorMessages}`,
        validationErrors: validationResult.errors,
      };
      console.error(`  ${C.err("❌ " + errorResult.error)}`);
      return errorResult;
    }
  } catch (e) {
    // Analysis guest failed - report the error and block registration
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error(`  ${C.err("❌ Validation error: " + errMsg)}`);
    return {
      success: false,
      error: `Validation failed: ${errMsg}`,
    };
  }

  // Extract exports using Rust guest (secure, ReDoS-safe)
  const metadata = await extractModuleMetadataGuest(params.source);
  const exports = metadata.exports;
  const exportNames = exports.map((e: { name: string }) => e.name);
  const overlaps = findOverlappingExports(exportNames, params.name);
  let overlapWarning = "";
  if (overlaps.length > 0) {
    overlapWarning = overlaps
      .map(
        (o) =>
          `Module "${o.moduleName}" already exports: ${o.overlappingExports.join(", ")}`,
      )
      .join("; ");
  }

  // Stop spinner before prompting (timer is paused by promptUser)
  spinner.stop();

  // Show what's being registered
  console.log(`\n  ${C.warn("📦 Register module:")} ${C.tool(params.name)}`);
  console.log(`     ${params.description}`);
  console.log(`     Exports: ${formatExports(exports) || "(none detected)"}`);
  console.log(`     Size: ${params.source.length} bytes`);
  if (overlapWarning) {
    console.log(`  ${C.warn("⚠️  Overlap:")} ${overlapWarning}`);
  }

  await drainAndWarn(rl);
  const approval = state.autoApprove
    ? "y"
    : await promptUser(rl, `  ${C.dim("Register? [y/n] ")}`);
  if (approval.trim().toLowerCase() !== "y") {
    console.log(`  ${C.dim("Denied by user.")}`);
    return { success: false, error: "Module registration denied by user" };
  }

  try {
    const info = await saveModule(
      params.name,
      params.source,
      params.description,
    );

    // Register in sandbox module cache
    const sandboxResult = await sandbox.registerModule(
      params.name,
      params.source,
    );

    console.error(
      `  ${C.ok("📦 Module registered:")} ${params.name} (${exports.length} exports, ${params.source.length} bytes)`,
    );

    return {
      success: true,
      name: info.name,
      description: info.description,
      exports: formatExports(info.exports),
      sourceSize: info.sizeBytes,
      importAs: `import { ... } from "ha:${info.name}"`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

const listModulesTool = defineTool("list_modules", {
  description: [
    "List all available modules (system and user-created).",
    "Call this BEFORE writing handler code to check for existing modules.",
    "Shows name, description, exports summary, and author (system/user).",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {},
  },
  handler: async () => {
    // Track that the LLM has called list_modules (for module discovery enforcement)
    state.hasCalledListModules = true;

    try {
      // Filter out internal modules (names starting with _)
      const modules = listModules().filter((m) => !m.name.startsWith("_"));
      const result = modules.map((m) => ({
        name: m.name,
        description: m.description,
        exports: formatExports(m.exports),
        author: m.author,
        mutable: m.mutable,
        sizeBytes: m.sizeBytes,
        importAs: `import { ... } from "ha:${m.name}"`,
      }));

      // Include connected MCP server modules
      if (mcpManager) {
        const mcpPlugin = pluginManager.getPlugin("mcp");
        if (mcpPlugin && mcpPlugin.state === "enabled") {
          for (const conn of mcpManager.listServers()) {
            if (conn.state === "connected" && conn.tools.length > 0) {
              result.push({
                name: `mcp-${conn.name}`,
                description: `MCP server "${conn.name}" — ${conn.tools.length} tool(s)`,
                exports: conn.tools.map((t) => t.name).join(", "),
                author: "system" as const,
                mutable: false,
                sizeBytes: 0,
                importAs: `import { ... } from "host:mcp-${conn.name}"`,
              });
            }
          }
        }
      }

      return {
        modules: result,
        count: result.length,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: msg };
    }
  },
});

// ── Structured Hints Formatter ─────────────────────────────────────────
//
// Converts ModuleHints JSON into a readable string for the LLM.

function formatStructuredHints(hints: Partial<ModuleHints>): string {
  const parts: string[] = [];

  if (hints.overview) {
    parts.push(hints.overview);
  }
  if (hints.relatedModules?.length) {
    parts.push(`Related modules: ${hints.relatedModules.join(", ")}`);
  }
  if (hints.requiredPlugins?.length) {
    parts.push(`Required plugins: ${hints.requiredPlugins.join(", ")}`);
  }
  if (hints.optionalPlugins?.length) {
    parts.push(`Optional plugins: ${hints.optionalPlugins.join(", ")}`);
  }
  if (hints.criticalRules?.length) {
    parts.push("Critical rules:");
    for (const rule of hints.criticalRules) {
      parts.push(`  • ${rule}`);
    }
  }
  if (hints.antiPatterns?.length) {
    parts.push("Anti-patterns:");
    for (const ap of hints.antiPatterns) {
      parts.push(`  ✗ ${ap}`);
    }
  }
  if (hints.commonPatterns?.length) {
    parts.push("Common patterns:");
    for (const cp of hints.commonPatterns) {
      parts.push(`  → ${cp}`);
    }
  }

  return parts.join("\n");
}

const moduleInfoTool = defineTool("module_info", {
  description: [
    "Get detailed information about a specific module.",
    "Shows exports with JSDoc, description, size, and author.",
    "For large modules (>10KB), source is omitted — exports are sufficient.",
    "Options:",
    "  - functionName: get info for one or more functions (comma-separated or array)",
    "  - signatures: true for full parameter details on ALL functions (useful for API discovery)",
    "  - compact: true for condensed cheat sheet (just function names + required params)",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Module name (e.g. 'str-bytes', 'pptx')",
      },
      functionName: {
        type: ["string", "array"],
        description:
          "Optional: get info for specific function(s). Accepts single name, comma-separated list, or array (e.g. 'chartSlide' or 'chartSlide,heroSlide,table' or ['chartSlide', 'heroSlide'])",
      },
      signatures: {
        type: "boolean",
        description:
          "Optional: return full parameter types and descriptions for ALL functions (better for API discovery)",
      },
      compact: {
        type: "boolean",
        description:
          "Optional: return condensed one-liner per export (just names + required params, no descriptions)",
      },
    },
    required: ["name"],
  },
  handler: async ({
    name,
    functionName,
    signatures,
    compact,
  }: {
    name: string;
    functionName?: string | string[];
    signatures?: boolean;
    compact?: boolean;
  }) => {
    // Track that the LLM has engaged with module discovery
    // This also satisfies the hasCalledListModules requirement for register_handler
    state.hasCalledListModules = true;

    try {
      // Block access to internal modules (names starting with _)
      if (name.startsWith("_")) {
        const available = listModules()
          .filter((m) => !m.name.startsWith("_"))
          .map((m) => m.name);
        return {
          error: `Module "${name}" not found. Available: ${available.join(", ") || "(none)"}`,
        };
      }
      // Check if this is an MCP module
      if (name.startsWith("mcp-") && mcpManager) {
        const serverName = name.slice("mcp-".length);
        const conn = mcpManager.getConnection(serverName);
        if (conn && conn.state === "connected" && conn.tools.length > 0) {
          const { generateMCPModuleHints, generateMCPDeclarations } =
            await import("./mcp/plugin-adapter.js");
          const hints = generateMCPModuleHints(serverName, conn.tools);
          const decl = generateMCPDeclarations(serverName, conn.tools);
          return {
            name: `mcp-${serverName}`,
            description: `MCP server "${serverName}" — ${conn.tools.length} tool(s)`,
            author: "system",
            importAs: `import { ... } from "host:mcp-${serverName}"`,
            exports: conn.tools.map((t) => ({
              name: t.name,
              description: t.description,
              parameters: t.inputSchema,
            })),
            hints,
            typeDefinitions: decl,
          };
        }
      }

      const info = await loadModuleAsync(name);
      if (!info) {
        const available = listModules()
          .filter((m) => !m.name.startsWith("_"))
          .map((m) => m.name);
        return {
          error: `Module "${name}" not found. Available: ${available.join(", ") || "(none)"}`,
        };
      }
      // If specific function(s) were requested, filter exports
      if (functionName) {
        // Normalize to array: accept string, comma-separated, or array
        let fnNames: string[];
        if (Array.isArray(functionName)) {
          fnNames = functionName.map((n) => n.trim()).filter(Boolean);
        } else {
          fnNames = functionName
            .split(",")
            .map((n) => n.trim())
            .filter(Boolean);
        }

        // Find all requested functions
        const foundFns: typeof info.exports = [];
        const notFound: string[] = [];
        for (const fnName of fnNames) {
          const fn = info.exports.find((e) => e.name === fnName);
          if (fn) {
            foundFns.push(fn);
          } else {
            notFound.push(fnName);
          }
        }

        if (notFound.length > 0 && foundFns.length === 0) {
          return {
            error: `Function(s) "${notFound.join(", ")}" not found in module "${name}". Available: ${info.exports.map((e) => e.name).join(", ")}`,
          };
        }

        // Build result for each function
        const results = foundFns.map((fn) => {
          // Build requires usage hint if function has dependencies
          let requiresUsage: string | undefined;
          if (fn.requires?.length) {
            const deps = fn.requires;
            const hostDeps = deps.filter((d) => d.startsWith("host:"));
            if (hostDeps.length > 0) {
              const imports = hostDeps
                .map((d) => {
                  const pluginName = d.replace("host:", "");
                  const varName = pluginName.replace(/-/g, "");
                  return `import * as ${varName} from "${d}";`;
                })
                .join("\n");
              const paramHint = hostDeps
                .map((d) => d.replace("host:", "").replace(/-/g, ""))
                .join(", ");
              requiresUsage = [
                `This function requires: ${deps.join(", ")}`,
                `You MUST:`,
                `  1. Enable the plugin(s) via manage_plugin or apply_profile`,
                `  2. Import in your handler:`,
                `     ${imports}`,
                `  3. Pass as parameter to ${fn.name}(..., ${paramHint})`,
              ].join("\n");
            }
          }

          return {
            functionName: fn.name,
            signature: formatExports([fn]),
            params: fn.params?.length
              ? fn.params
                  .map(
                    (p) =>
                      `${p.name}${p.type ? `: ${p.type}` : ""}${p.description ? ` — ${p.description}` : ""}`,
                  )
                  .join("\n")
              : undefined,
            returns: fn.returns?.type
              ? `${fn.returns.type}${fn.returns.description ? ` — ${fn.returns.description}` : ""}`
              : undefined,
            requires: fn.requires?.length ? fn.requires : undefined,
            ...(requiresUsage ? { requiresUsage } : {}),
          };
        });

        // For single function, return flat; for multiple, return array
        if (results.length === 1) {
          return {
            name: info.name,
            ...results[0],
            importAs: `import { ${results[0].functionName} } from "ha:${info.name}"`,
          };
        }

        return {
          name: info.name,
          functions: results,
          ...(notFound.length > 0 ? { notFound } : {}),
          importAs: `import { ${foundFns.map((f) => f.name).join(", ")} } from "ha:${info.name}"`,
        };
      }

      // For large modules (>10KB), omit source to avoid overwhelming the output.
      // The LLM gets exports + JSDoc which is what it needs for API usage.
      const includeSource = info.sizeBytes <= 10240;

      // If signatures mode requested, return detailed parameter info
      if (signatures) {
        return {
          name: info.name,
          description: info.description,
          signatures: formatSignatures(info.exports),
          ...(info.structuredHints
            ? { hints: formatStructuredHints(info.structuredHints) }
            : info.hints
              ? { hints: info.hints }
              : {}),
          importAs:
            info.importStyle === "namespace"
              ? `import * as ${info.name.replace(/-/g, "")} from "ha:${info.name}"`
              : `import { ... } from "ha:${info.name}"`,
        };
      }

      // If compact mode requested, return condensed cheat sheet
      if (compact) {
        return {
          name: info.name,
          exportCount: info.exports.length,
          exports: formatCompact(info.exports),
          ...(info.structuredHints
            ? { hints: formatStructuredHints(info.structuredHints) }
            : info.hints
              ? { hints: info.hints }
              : {}),
          importAs:
            info.importStyle === "namespace"
              ? `import * as ${info.name.replace(/-/g, "")} from "ha:${info.name}"`
              : `import { ... } from "ha:${info.name}"`,
        };
      }

      return {
        name: info.name,
        description: info.description,
        author: info.author,
        mutable: info.mutable,
        created: info.created,
        modified: info.modified,
        sizeBytes: info.sizeBytes,
        exports: formatExports(info.exports),
        ...(info.structuredHints
          ? { hints: formatStructuredHints(info.structuredHints) }
          : info.hints
            ? { hints: info.hints }
            : {}),
        ...(includeSource
          ? { source: info.source }
          : {
              sourceOmitted: `Source too large (${(info.sizeBytes / 1024).toFixed(1)}KB). Use exports above for API reference.`,
            }),
        importAs:
          info.importStyle === "namespace"
            ? `import * as ${info.name.replace(/-/g, "")} from "ha:${info.name}"`
            : `import { ... } from "ha:${info.name}"`,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: msg };
    }
  },
});

const deleteModuleTool = defineTool("delete_module", {
  description: [
    "Delete a user-created module. System modules cannot be deleted.",
    "The module file is removed from disk and the cache is cleared.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Module name to delete",
      },
    },
    required: ["name"],
  },
  handler: async ({ name }: { name: string }) => {
    const release = await acquireInteractiveLock();
    try {
      const rl = state.readlineInstance;
      if (!rl) {
        return { success: false, error: "No readline available" };
      }

      const info = loadModule(name);
      if (!info) {
        return { success: false, error: `Module "${name}" not found` };
      }
      if (info.author === "system") {
        return {
          success: false,
          error: `Module "${name}" is a system module and cannot be deleted`,
        };
      }

      spinner.stop();

      console.log(`\n  ${C.warn("🗑️  Delete module:")} ${C.tool(name)}`);
      await drainAndWarn(rl);
      const approval = state.autoApprove
        ? "y"
        : await promptUser(rl, `  ${C.dim("Delete? [y/n] ")}`);
      if (approval.trim().toLowerCase() !== "y") {
        return { success: false, error: "Deletion denied by user" };
      }

      deleteModuleFromDisk(name);
      // Also remove from sandbox cache
      await sandbox.deleteModule(name);

      console.error(`  ${C.ok("🗑️  Module deleted:")} ${name}`);
      return { success: true, message: `Module "${name}" deleted` };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    } finally {
      release();
    }
  },
});

// ── Startup Module Loading ───────────────────────────────────────────
//
// Load builtin system modules from builtin-modules/ directory and
// copy them to ~/.hyperagent/modules/ on first run.
// Also loads any user-created modules from ~/.hyperagent/modules/.

/**
 * Copy builtin modules to ~/.hyperagent/modules/ if not already present.
 * Then load ALL modules (system + user) into the sandbox module cache.
 */
function loadAllModules(): void {
  const builtinDir = join(CONTENT_ROOT, "builtin-modules");
  const modulesDir = getModulesDir();

  // Always overwrite system modules from builtin-modules/ — ensures
  // users get the latest versions with bug fixes and new features.
  // User modules (author=user) in the same directory are NOT touched.
  if (existsSync(builtinDir)) {
    // Copy .js module files
    const builtins = readdirSync(builtinDir).filter((f) => f.endsWith(".js"));
    for (const file of builtins) {
      const dest = join(modulesDir, file);
      copyFileSync(join(builtinDir, file), dest);
      debugLog(`Synced builtin module: ${file}`);
    }
    // Copy .d.ts declaration files (for validator type extraction)
    const dtsFiles = readdirSync(builtinDir).filter((f) => f.endsWith(".d.ts"));
    for (const file of dtsFiles) {
      const dest = join(modulesDir, file);
      copyFileSync(join(builtinDir, file), dest);
    }
    // Copy .json metadata files (for system module identification + hashes)
    const metaFiles = readdirSync(builtinDir).filter(
      (f) => f.endsWith(".json") && f !== "tsconfig.json",
    );
    for (const file of metaFiles) {
      const dest = join(modulesDir, file);
      copyFileSync(join(builtinDir, file), dest);
    }
    // Clean up stale files from renamed/removed modules (e.g. deflate → ziplib)
    const staleFiles = ["deflate.js", "deflate.d.ts", "deflate.json"];
    for (const file of staleFiles) {
      const stalePath = join(modulesDir, file);
      if (existsSync(stalePath)) {
        unlinkSync(stalePath);
        debugLog(`Removed stale module file: ${file}`);
      }
    }
  }

  // Load all modules into the sandbox cache
  const allModules = listModules();
  if (allModules.length > 0) {
    sandbox.setModules(
      allModules.map((m) => ({ name: m.name, source: m.source })),
    );
    debugLog(
      `Loaded ${allModules.length} modules: ${allModules.map((m) => m.name).join(", ")}`,
    );
  }
}

// ── Session Configuration Builder ────────────────────────────────────
//
// Shared config for createSession / resumeSession so all session
// creation paths get identical tools, hooks, streaming, etc.

/**
 * Build the session configuration shared between createSession and
 * resumeSession. Excludes model (caller sets it) to avoid duplication.
 */
function buildSessionConfig() {
  // Build the system message with current buffer sizes and plugin info.
  // Plugin system messages tell the model about host:* capabilities.
  const buffers = sandbox.getEffectiveBufferSizes();
  const memory = sandbox.getEffectiveMemorySizes();
  const baseMessage = buildSystemMessage({
    cpuTimeoutMs: state.cpuTimeoutOverride ?? sandbox.config.cpuTimeoutMs,
    wallTimeoutMs:
      state.wallTimeoutOverride ?? sandbox.config.wallClockTimeoutMs,
    heapMb: memory.heapMb,
    scratchMb: memory.scratchMb,
    inputKb: buffers.inputKb,
    outputKb: buffers.outputKb,
    mcpConfigured: mcpManager !== null,
  });
  const pluginAdditions = pluginManager.getSystemMessageAdditions();

  // When tune mode is active, append guidance about the llm_thought tool
  const tuneAddition = state.tuneEnabled
    ? [
        "",
        "TUNING MODE ACTIVE — MANDATORY LOGGING:",
        "  You MUST call llm_thought at these decision points:",
        "  1. BEFORE calling apply_profile or manage_plugin — log why you chose this profile/plugin",
        "  2. BEFORE calling register_handler — log your handler design decision",
        "  3. When you encounter a constraint — log it as category 'constraint'",
        "  4. When you reject an alternative approach — log it as 'alternative_rejected'",
        "  5. BEFORE calling register_module — log why this should be a reusable module",
        "",
        "  Categories: decision, concern, constraint, alternative_rejected",
        "  Keep each log to ONE sentence. Log THEN act — do not deliberate.",
        "  This data is used for prompt tuning. More entries = better tuning.",
      ].join("\n")
    : "";

  const fullSystemMessage =
    baseMessage + (pluginAdditions ?? "") + tuneAddition;

  return {
    // Identify this app in User-Agent headers — good SDK citizenship.
    clientName: "hyperagent",
    // Pin tool file operations to wherever the user launched from.
    // Without this the SDK uses the CLI server's cwd, which may differ.
    workingDirectory: process.cwd(),
    // Skills — markdown instruction files that inject expertise on demand.
    // The LLM can invoke /pptx-expert to get PPTX building best practices.
    skillDirectories: [join(CONTENT_ROOT, "skills")],
    systemMessage: {
      mode: "replace" as const,
      content: fullSystemMessage,
    },
    tools: [
      registerHandlerTool,
      executeJavascriptTool,
      deleteHandlerTool,
      deleteHandlersTool,
      getHandlerSourceTool,
      editHandlerTool,
      listHandlersTool,
      sandboxResetTool,
      configureSandboxTool,
      managePluginTool,
      listPluginsTool,
      pluginInfoTool,
      sandboxHelpTool,
      applyProfileTool,
      registerModuleTool,
      listModulesTool,
      moduleInfoTool,
      deleteModuleTool,
      writeOutputTool,
      readInputTool,
      readOutputTool,
      // MCP SDK tools — gated inside handlers, always registered
      listMCPServersTool,
      mcpServerInfoTool,
      mcpToolInfoTool,
      manageMCPTool,
      // Conditionally include tuning tool — only when --tune is active
      ...(state.tuneEnabled ? [llmThoughtTool] : []),
    ],
    // Hide SDK built-in tools (bash, create, edit, view, grep, etc.)
    // so the LLM only sees our custom tools. Without this, the LLM
    // wastes tokens trying bash/web_fetch/create_file before discovering
    // they're all blocked. Our onPreToolUse gate still blocks anything
    // not in ALLOWED_TOOLS as a safety net.
    availableTools: [
      "register_handler",
      "execute_javascript",
      "delete_handler",
      "get_handler_source",
      "edit_handler",
      "list_handlers",
      "reset_sandbox",
      "configure_sandbox",
      "manage_plugin",
      "list_plugins",
      "plugin_info",
      "sandbox_help",
      "apply_profile",
      "register_module",
      "list_modules",
      "module_info",
      "delete_module",
      "write_output",
      "read_input",
      "read_output",
      "ask_user",
      "report_intent",
      // MCP tools — always listed, gated inside handler
      "list_mcp_servers",
      "mcp_server_info",
      "mcp_tool_info",
      "manage_mcp",
      // Conditionally expose tuning tool
      ...(state.tuneEnabled ? ["llm_thought"] : []),
    ],
    onPermissionRequest: approveAll,
    // Enable the ask_user tool — the LLM can ask structured questions
    // with optional multiple‐choice answers. Complements (does NOT
    // replace) our /command suggestion regex system.
    onUserInputRequest: createUserInputHandler(
      () => state.readlineInstance,
      () => spinner,
      () => state.autoApprove,
    ),
    hooks: {
      onPreToolUse: async (toolInput: {
        toolName: string;
        toolArgs?: unknown;
      }) => {
        const allowed = ALLOWED_TOOLS.has(toolInput.toolName);
        if (state.debugEnabled) {
          debugLog(
            `onPreToolUse: ${toolInput.toolName} → ${allowed ? "ALLOW" : "DENY"}`,
          );
        }
        if (!allowed) {
          return { permissionDecision: "deny" as const };
        }

        // Module discovery enforcement: block register_handler / edit_handler
        // until list_modules has been called. The LLM must discover APIs
        // before writing code — guessing function signatures causes crashes.
        if (
          (toolInput.toolName === "register_handler" ||
            toolInput.toolName === "edit_handler") &&
          !state.hasCalledListModules &&
          !state.skipSuggest
        ) {
          debugLog(
            `onPreToolUse: BLOCKED ${toolInput.toolName} — API discovery not done yet`,
          );
          // Check if any plugins are enabled to customize the message
          const enabledPlugins = pluginManager
            .listPlugins()
            .filter((p) => p.state === "enabled");
          const pluginGuidance =
            enabledPlugins.length > 0
              ? `You have ${enabledPlugins.length} plugin(s) enabled (${enabledPlugins.map((p) => p.manifest.name).join(", ")}). ` +
                "Call plugin_info(name) for each to learn their host:* module APIs. "
              : "";
          return {
            permissionDecision: "deny" as const,
            permissionDecisionReason:
              "BLOCKED: You must discover APIs before writing code. " +
              "Call list_modules() to see available ha:* modules, then module_info(name) " +
              "for each module you plan to import. " +
              pluginGuidance +
              "Never guess function signatures — this causes runtime crashes.",
          };
        }

        // Soft reminder when writing code — inject critical rules prominently.
        if (
          toolInput.toolName === "register_handler" ||
          toolInput.toolName === "edit_handler"
        ) {
          // Check the handler code for regex HTML stripping without ha:html import.
          // This is the most common mistake — the LLM writes regex to strip HTML
          // tags instead of using the native Rust parseHtml() which is faster
          // and more correct.
          const args = toolInput.toolArgs as
            | Record<string, unknown>
            | undefined;
          const code =
            typeof args?.code === "string"
              ? args.code
              : typeof args?.newString === "string"
                ? args.newString
                : "";

          if (code) {
            const importsFetch =
              code.includes("host:fetch") || code.includes("fetchText");
            const importsHtml = code.includes("ha:html");
            const hasHtmlRegex =
              /<\[?\^?>?\]+?>/.test(code) || // /<[^>]+>/g pattern
              /<script/.test(code) || // <script tag stripping
              /<style/.test(code) || // <style tag stripping
              /\.replace\(.*<.*>/s.test(code); // .replace(/<.../

            if (importsFetch && hasHtmlRegex && !importsHtml) {
              return {
                permissionDecision: "deny" as const,
                permissionDecisionReason:
                  "BLOCKED: Your handler imports host:fetch and uses regex to strip HTML tags, " +
                  "but does not import ha:html. You MUST use the native parseHtml() function instead of regex. " +
                  "Fix: import { parseHtml } from 'ha:html'; then use: const { text, links } = parseHtml(html); " +
                  "parseHtml() is a native Rust parser — faster and handles malformed HTML correctly.",
              };
            }
          }

          const parts: string[] = [];

          // CRITICAL: Put the most important reminders FIRST — the LLM
          // is more likely to follow instructions at the top.
          parts.push(
            "⚠️ BEFORE REGISTERING THIS HANDLER, VERIFY:",
            "• Have you called module_info() for ALL modules you're importing?",
          );

          // Only warn about ha:html if fetch plugin is enabled AND allows HTML content
          const fetchPlugin = pluginManager.getPlugin("fetch");
          if (fetchPlugin?.state === "enabled") {
            const allowedTypes = fetchPlugin.config.allowedContentTypes;
            const htmlAllowed =
              Array.isArray(allowedTypes) &&
              allowedTypes.some(
                (t: unknown) =>
                  typeof t === "string" && t.includes("text/html"),
              );
            if (htmlAllowed) {
              parts.push(
                "• If you import host:fetch and handle HTML: you MUST import { parseHtml } from 'ha:html'",
                "  Do NOT use regex to strip HTML tags — parseHtml() is faster and more correct.",
              );
            }
          }

          parts.push(
            "• For text output: use write_output(path, content) — no handler needed.",
          );

          // Re-inject full task guidance below the critical reminders
          if (state.lastGuidance) {
            parts.push("", state.lastGuidance);
          }

          return {
            permissionDecision: "allow" as const,
            additionalContext: parts.join("\n"),
          };
        }

        return { permissionDecision: "allow" as const };
      },
      // Pre-process user prompts — auto-invoke suggest_approach,
      // inject guidance + current resource state as additional context.
      // Guidance is stored in state.lastGuidance and re-injected on
      // every turn so it survives compaction.
      onUserPromptSubmitted: async (input: { prompt: string }) => {
        // Track turn count
        state.totalTurns++;

        // Capture prompt and reset per-prompt tracking flags
        state.currentUserPrompt = input.prompt;
        state.hasCalledListModules = false;

        // Auto-invoke suggest_approach for non-trivial prompts
        const isNonTrivial = input.prompt.length > 25;
        if (isNonTrivial) {
          const result = runSuggestApproach(
            input.prompt,
            state.preLoadedSkills,
            join(CONTENT_ROOT, "skills"),
            join(CONTENT_ROOT, "patterns"),
            debugLog,
          );

          state.lastGuidance = result.formatted;

          // UI feedback — one-liner so the user knows what matched
          if (result.matchedSkills.length > 0) {
            console.error(
              `  ${C.ok("🎯")} Matched: ${result.matchedSkills.join(", ")} → profile: ${result.profile}`,
            );
          } else {
            console.error(
              `  ${C.dim("📋 No skill match — using generic guidance")}`,
            );
          }

          debugLog(
            `runSuggestApproach: prompt=${JSON.stringify(input.prompt.slice(0, 80))} ` +
              `matched=[${result.matchedSkills.join(",")}] ` +
              `profile=${result.profile} ` +
              `modules=${result.guidance.modules.length} ` +
              `preLoaded=${state.preLoadedSkills.length > 0}`,
          );
        } else if (state.lastGuidance) {
          // Re-injection of existing guidance on subsequent turns
          debugLog(
            `Re-injecting lastGuidance (${state.lastGuidance.length} chars)`,
          );
        }

        const bufSizes = sandbox.getEffectiveBufferSizes();
        const memSizes = sandbox.getEffectiveMemorySizes();
        const enabledPlugins = pluginManager.getEnabledPlugins();

        const contextParts: string[] = [
          `Current limits: heap=${memSizes.heapMb}MB, ` +
            `cpu=${state.cpuTimeoutOverride ?? sandbox.config.cpuTimeoutMs}ms`,
          `Buffers: in=${bufSizes.inputKb}KB, out=${bufSizes.outputKb}KB`,
        ];
        if (state.reasoningEffort) {
          contextParts.push(`Reasoning effort: ${state.reasoningEffort}`);
        }
        if (enabledPlugins.length > 0) {
          contextParts.push(
            `Active plugins: ${enabledPlugins.map((p) => p.manifest.name).join(", ")}`,
          );
        }

        // Inject guidance (auto-generated or re-injected from previous turn)
        if (state.lastGuidance) {
          contextParts.push(state.lastGuidance);
        }

        return { additionalContext: contextParts.join("\n") };
      },
      // Structured error recovery — retry transient failures,
      // surface human-readable messages for memory errors, and
      // abort cleanly on system errors.
      onErrorOccurred: createErrorHandler(
        () => state.heapOverride ?? sandbox.config.heapSizeMb,
      ),
      // Enrich tool results with additional context for the LLM.
      // This is the SDK-blessed way to inject agent-level knowledge
      // (resource limits, active config) alongside raw tool output
      // without hacking the tool response JSON.
      onPostToolUse: async (input: {
        toolName: string;
        toolResult: { resultType: string; error?: string };
      }) => {
        const { toolName, toolResult } = input;

        // For sandbox memory errors, tell the LLM about the current
        // heap size and how to suggest an increase to the user.
        if (
          toolName === "execute_javascript" &&
          toolResult.resultType === "failure" &&
          /out of memory|out of physical memory|heap|stack overflow|guest aborted/i.test(
            toolResult.error ?? "",
          )
        ) {
          const heapMb = state.heapOverride ?? sandbox.config.heapSizeMb;
          const scratchMb =
            state.scratchOverride ?? sandbox.config.scratchSizeMb;
          return {
            additionalContext:
              `Current heap: ${heapMb}MB, scratch: ${scratchMb}MB. ` +
              `If the error says "Out of physical memory" or "Guest aborted: 13", ` +
              `the scratch setting is too low — suggest /set scratch <MB> (e.g. double it). ` +
              `For general OOM, suggest /set heap <MB>. ` +
              `Or try breaking the computation into smaller pieces.`,
          };
        }

        // For execution runtime errors, guide LLM to EDIT not regenerate
        if (
          toolName === "execute_javascript" &&
          toolResult.resultType === "failure" &&
          toolResult.error &&
          !/out of memory|out of physical memory|heap|stack overflow|guest aborted/i.test(
            toolResult.error,
          )
        ) {
          return {
            additionalContext:
              `TO FIX: Use get_handler_source to retrieve the existing code, ` +
              `make a MINIMAL edit to fix the specific error, then register_handler. ` +
              `Do NOT regenerate the entire handler from scratch — that wastes time ` +
              `and may introduce new errors. Edit only the failing line.`,
          };
        }

        return undefined;
      },
    },
    streaming: true,
    // Reasoning effort — only included when the user explicitly sets
    // a level via /reasoning <low|medium|high|xhigh>. Without this,
    // the model uses its own default.
    ...(state.reasoningEffort
      ? { reasoningEffort: state.reasoningEffort }
      : {}),
    // Infinite sessions — automatic context compaction when the
    // context window fills up. The SDK summarises old context in
    // the background so the conversation can continue indefinitely.
    infiniteSessions: {
      enabled: true,
      backgroundCompactionThreshold: 0.8,
      bufferExhaustionThreshold: 0.95,
    },
  };
}

// ── Event Handler (delegated to agent/event-handler.ts) ──────────────

import {
  registerEventHandler as registerEventHandlerImpl,
  sendAndWaitWithKeepAlive as sendAndWaitImpl,
  clearKeepAliveState as clearKeepAliveStateImpl,
  type EventHandlerDeps,
} from "./event-handler.js";

/** How many auto-retries on inactivity timeout before giving up. */
const MAX_INACTIVITY_RETRIES = 1;

function getEventHandlerDeps(): EventHandlerDeps {
  return {
    state,
    spinner,
    sandbox,
    SEND_TIMEOUT_MS,
    MAX_INACTIVITY_RETRIES,
    debugLog,
  };
}

function registerEventHandler(session: CopilotSession): void {
  registerEventHandlerImpl(session, getEventHandlerDeps());
}

function clearKeepAliveState(): void {
  clearKeepAliveStateImpl(getEventHandlerDeps());
}

function sendAndWaitWithKeepAlive(
  session: CopilotSession,
  prompt: string,
  _inactivityMs: number,
): Promise<AssistantMessageEvent | undefined> {
  return sendAndWaitImpl(session, prompt, getEventHandlerDeps());
}

// ── Suggested Command Extraction ─────────────────────────────────────
//
// Extracted into command-suggestions.ts for testability.
// See that module for the extraction logic and ACTIONABLE_COMMAND_PREFIXES.

/**
 * Process a single user message: send it to the agent, wait for the
 * full response with keep-alive inactivity tracking. Streaming output
 * and tool invocation visibility are handled by the event handler
 * registered on the session.
 *
 * @param session — The active CopilotSession
 * @param userInput — The user's message text
 */
async function processMessage(
  session: CopilotSession,
  userInput: string,
): Promise<string | undefined> {
  state.streamedContent = false;
  state.streamedText = "";
  state.inactivityRetryCount = 0;
  state.lastResponseWasCancelled = false;
  // Bump tune turn counter so log entries track which user message
  // triggered each LLM thought.
  tuneTurnNumber++;
  // Reset spinner elapsed timer so it counts from THIS message, not
  // a stale turn from a previous (possibly errored) cycle.
  spinner.resetTurnStart();
  spinner.start();

  // Arm ESC-key cancellation so the user can bail at any time.
  enableAbortOnEsc(session, state, spinner, debugLog);
  try {
    const effectiveTimeout = state.sendTimeoutOverride ?? SEND_TIMEOUT_MS;
    const response = await sendAndWaitWithKeepAlive(
      session,
      userInput,
      effectiveTimeout,
    );

    const content = response?.data?.content;
    // Use streamed text for suggestion extraction — the final
    // assistant.message content can be empty when the response
    // was delivered via message_delta events.
    const responseForSuggestions = content || state.streamedText;
    if (!state.streamedContent && content) {
      console.log(content);
    }
    console.log();
    return responseForSuggestions || undefined;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    // Friendly messages for known error patterns
    if (/503|GOAWAY|connection.*error/i.test(message)) {
      console.log(
        `\n  ${C.err("❌ API connection lost")} — the model server returned an error.`,
      );
      console.log(
        `  ${C.dim("This is a transient server issue, not a problem with your request.")}`,
      );
      console.log(
        `  ${C.dim("Just send your message again or type 'continue' to resume.")}`,
      );
      console.log();
    } else if (/stopped responding|no activity/i.test(message)) {
      console.log(
        `\n  ${C.err("❌ Model went quiet")} — no response for the timeout period.`,
      );
      console.log(
        `  ${C.dim("Try sending your message again, or /new for a fresh session.")}`,
      );
      console.log();
    } else {
      console.error(`\n${C.err("❌ Agent error:")} ${message}\n`);
    }
    return undefined;
  } finally {
    // Disarm ESC handler and restore readline control of stdin
    disableAbortOnEsc();
    // Safety net — ensure spinner is always killed, even on error
    spinner.stop();
  }
}

/**
 * Format a model list for display. Used by --list-models and /models.
 */
function formatModelList(models: ModelInfo[], current?: string): string {
  const lines: string[] = [
    `  ${C.label("🤖 Available models")} (${models.length}):`,
  ];
  for (const m of models) {
    const isCurrent = m.id === current ? ` ${C.ok("← current")}` : "";
    const vision = m.capabilities?.supports?.vision ? "👁️" : "";
    const reasoning = m.capabilities?.supports?.reasoningEffort ? "🧠" : "";
    const policy =
      m.policy?.state === "disabled" ? ` ${C.err("[disabled]")}` : "";
    lines.push(
      `     ${C.val(m.id)}${isCurrent}${policy} ${vision}${reasoning}`,
    );
  }
  lines.push("");
  lines.push(`     ${C.dim("👁️ = vision  🧠 = reasoning effort")}`);
  return lines.join("\n");
}

/**
 * Run the interactive REPL loop.
 * Reads user input line by line, sends each to the agent, and streams
 * the response. Type 'exit' or press Ctrl+C to quit.
 */
async function main(): Promise<void> {
  // ── Prerequisite checks ──────────────────────────────────────
  // Verify the native addon loads before we do anything else.
  try {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    require("@hyperlight/js-host-api");
  } catch {
    console.error(
      `${ANSI.red}❌ Native addon failed to load — rebuild with 'just setup' from the repo root.${ANSI.reset}`,
    );
    process.exit(1);
  }

  // ── Load modules (builtin + user) ─────────────────────────────
  // Copy builtin system modules to ~/.hyperagent/modules/ if not
  // already present, then load ALL modules into the sandbox cache.
  loadAllModules();

  // ── Load skills and patterns for suggest_approach ──────────────
  const allSkills = loadSkills(join(CONTENT_ROOT, "skills"));
  const allPatterns = loadPatterns(join(CONTENT_ROOT, "patterns"));
  debugLog(
    `Loaded ${allSkills.size} skills, ${allPatterns.size} patterns for suggest_approach`,
  );

  // Wire --skill CLI flag → preLoadedSkills
  if (cli.skill) {
    state.preLoadedSkills = cli.skill.split(/\s+/).filter(Boolean);
  }
  // Wire --skip-suggest CLI flag
  if (cli.skipSuggest) {
    state.skipSuggest = true;
  }

  // ── Enable the analysis guest ──────────────────────────────────
  // The analysis guest provides secure, isolated code validation.
  // It MUST be available — without it, code validation and plugin
  // schema extraction are broken. Fail hard if missing.
  const analysisStatus = await checkAnalysisGuest();
  if (!analysisStatus.available) {
    console.error(`\n  ${C.err("❌ FATAL: Analysis guest not available")}`);
    console.error(`     ${analysisStatus.error}`);
    console.error(`     Run 'just build' to compile the native addon.\n`);
    process.exit(1);
  }
  enableAnalysisGuest();
  debugLog(
    `Analysis guest enabled (hash: ${analysisStatus.hash?.slice(0, 12)}...)`,
  );

  // ── Auto-start transcript from CLI flag ──────────────────────
  if (cli.transcript) {
    const buffers = sandbox.getEffectiveBufferSizes();
    transcript.start({
      model: state.currentModel,
      cpuTimeoutMs: sandbox.config.cpuTimeoutMs,
      wallClockTimeoutMs: sandbox.config.wallClockTimeoutMs,
      heapSizeMb: sandbox.config.heapSizeMb,
      inputBufferKb: buffers.inputKb,
      outputBufferKb: buffers.outputKb,
    });
  }

  // ── Create Copilot client ────────────────────────────────────
  //
  // The client spawns the Copilot CLI server process. The session
  // maintains conversation state, tools, and event handlers.
  //
  // ⚠️  @github/copilot-sdk is in Technical Preview — the session
  //     API may evolve. See the SDK changelog for migration guidance.

  const client = new CopilotClient();
  state.copilotClient = client;

  // ── --list-models: print models and exit ─────────────────────
  if (cli.listModels) {
    await client.start();
    try {
      const models = await client.listModels();
      state.cachedModels = models;
      console.log(formatModelList(models, state.currentModel));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${C.err("❌ Failed to list models:")} ${msg}`);
      process.exit(1);
    } finally {
      await client.stop();
    }
    return;
  }

  // ── Banner ───────────────────────────────────────────────────
  const { bold, magenta, cyan, green, dim, reset, yellow } = ANSI;
  const versionStr = `v${getVersion()}`;

  const boxWidth = 48;

  // All lines: 4 space indent, right-pad to boxWidth
  const line = (text: string, visibleLen: number): string => {
    return "    " + text + " ".repeat(Math.max(0, boxWidth - 4 - visibleLen));
  };

  console.log();
  console.log(`${bold}${magenta}  ╔${"═".repeat(boxWidth)}╗${reset}`);
  console.log(`${bold}${magenta}  ║${" ".repeat(boxWidth)}║${reset}`);
  console.log(
    `${bold}${magenta}  ║${line("🤖 H Y P E R A G E N T", 22)}║${reset}`,
  );
  console.log(
    `${bold}${magenta}  ║${line(`   ${dim}${versionStr}${reset}${bold}${magenta}`, 3 + versionStr.length)}║${reset}`,
  );
  console.log(`${bold}${magenta}  ║${" ".repeat(boxWidth)}║${reset}`);
  console.log(
    `${bold}${magenta}  ║${line("Hyperlight × Copilot SDK Agent", 30)}║${reset}`,
  );
  console.log(
    `${bold}${magenta}  ║${line("Sandboxed JavaScript Execution", 30)}║${reset}`,
  );
  console.log(`${bold}${magenta}  ║${" ".repeat(boxWidth)}║${reset}`);
  console.log(`${bold}${magenta}  ╚${"═".repeat(boxWidth)}╝${reset}`);

  // Warning banner
  const isContainer =
    existsSync("/.dockerenv") || existsSync("/run/.containerenv");
  console.log();
  console.log(
    `  ${bold}${yellow}⚠  WARNING: Pre-release software created by AI.${reset}`,
  );
  console.log(
    `  ${yellow}   Not for production use. Be careful where you run it and what you do with it.${reset}`,
  );
  if (!isContainer) {
    console.log(`  ${yellow}   Consider running in a container.${reset}`);
  }

  console.log();
  console.log(`  ${bold}Configuration:${reset}`);
  console.log(`    Model:         ${cyan}${state.currentModel}${reset}`);
  console.log(
    `    CPU timeout:   ${cyan}${sandbox.config.cpuTimeoutMs}ms${reset}`,
  );
  console.log(
    `    Wall timeout:  ${cyan}${sandbox.config.wallClockTimeoutMs}ms${reset}`,
  );
  console.log(
    `    Send timeout:  ${cyan}${SEND_TIMEOUT_MS}ms${reset} ${dim}(inactivity)${reset}`,
  );
  console.log(
    `    Heap size:     ${cyan}${sandbox.config.heapSizeMb}MB${reset}`,
  );
  console.log(
    `    Scratch size:  ${cyan}${sandbox.config.scratchSizeMb}MB${reset}`,
  );
  console.log(
    `    Buffers:       ${cyan}${sandbox.config.inputBufferKb}KB${reset} input / ${cyan}${sandbox.config.outputBufferKb}KB${reset} output`,
  );
  console.log(`    Context:       infinite sessions (auto-compaction)`);
  {
    const bannerPlugins = pluginManager.listPlugins();
    const bannerEnabled = pluginManager.getEnabledPlugins();
    if (bannerPlugins.length > 0) {
      const audited = bannerPlugins.filter((p) => p.audit !== null).length;
      const approved = bannerPlugins.filter((p) => p.approved).length;
      console.log(
        `    Plugins:       ${green}${bannerEnabled.length}/${bannerPlugins.length}${reset} enabled, ${audited} audited, ${approved} approved`,
      );
    } else {
      console.log(
        `    Plugins:       ${dim}none (create plugins/ directory to extend)${reset}`,
      );
    }
  }
  if (cli.showCode && process.env.HYPERAGENT_CODE_LOG) {
    console.log(
      `    Code log:      ${green}${process.env.HYPERAGENT_CODE_LOG}${reset}`,
    );
  }
  if (cli.showTiming && process.env.HYPERAGENT_TIMING_LOG) {
    console.log(
      `    Timing log:    ${green}${process.env.HYPERAGENT_TIMING_LOG}${reset}`,
    );
  }
  if (transcript.active) {
    console.log(`    Transcript:    ${green}${transcript.rawPath}${reset}`);
  }
  console.log();
  console.log(
    `   ${dim}Type your request and press Enter. Type ${ANSI.cyan}/help${ANSI.reset}${dim} for commands, ${ANSI.cyan}/exit${ANSI.reset}${dim} to quit.${reset}`,
  );
  console.log(
    `   ${dim}Press ${ANSI.cyan}ESC${ANSI.reset}${dim} during a response to cancel.${reset}`,
  );
  console.log();

  // ── Diagnostic: verify tool definition before sending ────────
  if (state.debugEnabled) {
    debugLog("Tool definition being sent to createSession:");
    debugLog(
      JSON.stringify(
        executeJavascriptTool,
        (key, val) => (typeof val === "function" ? "[Function]" : val),
        2,
      ),
    );
    // parameters is a raw JSON Schema object (Record<string, unknown>),
    // not a ZodSchema — safe to access .type directly.
    const params = executeJavascriptTool.parameters as
      | Record<string, unknown>
      | undefined;
    debugLog(`parameters.type = "${params?.type}"`);
  }

  // ── Start the client ───────────────────────────────────────
  // Must call start() before createSession/resumeSession.
  await client.start();

  // ── Model validation ─────────────────────────────────────────
  // Fetch available models and warn if the requested model is
  // invalid.
  try {
    const models = await client.listModels();
    state.cachedModels = models;
    const valid = models.some((m) => m.id === state.currentModel);
    if (!valid) {
      console.log(
        `  ⚠️  Model "${state.currentModel}" not found in available models.`,
      );
      console.log("     Available models:");
      for (const m of models) {
        console.log(`       ${m.id}`);
      }
      console.log(`\n     Proceeding anyway — the API may accept it.\n`);
    }
  } catch {
    // Validation is best-effort — don't block on failure
    if (state.debugEnabled) {
      console.error(
        "[DEBUG] Model validation failed — proceeding without validation.",
      );
    }
  }

  // ── Create or resume session ─────────────────────────────────
  let session: CopilotSession;

  if (cli.resumeSession) {
    // --resume: pick up where we left off
    try {
      // Resolve "__last__" sentinel to the most recent hyperagent session
      let targetId = cli.resumeSession;
      if (targetId === "__last__") {
        const allSessions = await client.listSessions();
        const ours = allSessions
          .filter((s) => s.sessionId.startsWith(SESSION_ID_PREFIX))
          .sort((a, b) => {
            const ta = a.modifiedTime ? new Date(a.modifiedTime).getTime() : 0;
            const tb = b.modifiedTime ? new Date(b.modifiedTime).getTime() : 0;
            return tb - ta;
          });
        if (ours.length === 0) {
          console.log(
            "  ⚠️  No previous hyperagent sessions found — starting fresh.",
          );
          console.log();
          targetId = "";
        } else {
          targetId = ours[0].sessionId;
        }
      }

      if (targetId) {
        session = await client.resumeSession(targetId, {
          model: state.currentModel,
          ...buildSessionConfig(),
        });
        console.log(`  ⏮️  Resumed session: ${targetId.slice(0, 12)}…`);
        console.log();
      } else {
        session = await client.createSession({
          sessionId: makeSessionId(),
          model: state.currentModel,
          ...buildSessionConfig(),
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `${C.err("❌ Failed to resume session")} "${cli.resumeSession}": ${msg}`,
      );
      console.error("   Starting a new session instead.\n");
      session = await client.createSession({
        sessionId: makeSessionId(),
        model: state.currentModel,
        ...buildSessionConfig(),
      });
    }
  } else {
    session = await client.createSession({
      sessionId: makeSessionId(),
      model: state.currentModel,
      ...buildSessionConfig(),
    });
  }

  state.activeSession = session;

  if (state.debugEnabled) {
    debugLog(`Session created: ${session.sessionId}`);
  }

  // Register event handler for streaming + tool visibility
  registerEventHandler(session);

  // ── Auto-enable MCP gateway if servers are configured ────────
  // The gateway plugin is a boolean sentinel (zero risk). When MCP
  // servers are configured, auto-enable it so the LLM can discover
  // and connect servers via tools without the user having to run
  // /plugin enable mcp first.
  //
  // We also set a synthetic audit result and re-approve the plugin
  // so that syncPluginsToSandbox doesn't reject it due to stale
  // content hashes (which change every time npm install rebuilds).
  if (mcpManager) {
    const mcpPlugin = pluginManager.getPlugin("mcp");
    if (mcpPlugin && mcpPlugin.state !== "enabled") {
      const mcpSource = pluginManager.loadSource("mcp");
      // Compute current content hash so the audit matches the source
      const mcpHash = computePluginHash(mcpPlugin.dir);
      if (mcpSource && mcpHash) {
        pluginManager.setAuditResult("mcp", {
          contentHash: mcpHash,
          auditedAt: new Date().toISOString(),
          findings: [],
          riskLevel: "LOW",
          summary:
            "Boolean sentinel — exposes a single read-only status check.",
          descriptionAccurate: true,
          capabilities: ["MCP gateway status"],
          riskReasons: ["No filesystem, network, or exec capabilities"],
          recommendation: {
            verdict: "approve",
            reason: "Auto-approved: gateway sentinel",
          },
        });
        pluginManager.approve("mcp");
      }
      pluginManager.enable("mcp");
      await syncPluginsToSandbox();
      console.log(`  ${C.ok("MCP gateway auto-enabled")} (servers configured)`);
    }
  }

  // ── REPL Loop ────────────────────────────────────────────────
  //
  // Slash commands are intercepted before reaching the agent.

  // Tab-completion for slash commands — type '/' then Tab.
  // Driven by the COMMANDS registry (single source of truth).
  function completer(line: string): [string[], string] {
    if (line.startsWith("/")) {
      const hits = COMPLETION_STRINGS.filter((c) => c.startsWith(line));
      return [hits.length ? hits : Array.from(COMPLETION_STRINGS), line];
    }
    return [[], line];
  }

  const rl = readline.createInterface({
    input,
    output,
    completer,
    history: loadHistory(),
    historySize: HISTORY_SIZE,
    removeHistoryDuplicates: true,
  });

  // Persist history to disk on every change (like bash does).
  rl.on("history", saveHistory);

  // Set up Ctrl+R reverse history search.
  const prompt = `${ANSI.bold}${ANSI.cyan}You: ${ANSI.reset}`;
  const cleanupCtrlR = setupCtrlRHandler(
    rl,
    () => {
      // @ts-expect-error - readline's history is internal but accessible
      return (rl.history as string[]) || [];
    },
    prompt,
  );

  // Expose readline to SDK hooks (onUserInputRequest) so they can
  // prompt the user for structured input mid-conversation.
  state.readlineInstance = rl;

  try {
    // ── Non-interactive prompt mode ──────────────────────────────
    // When --prompt "..." is provided, send the prompt once and exit.
    if (cli.prompt) {
      // Invoke skills before sending the prompt (--skill flag)
      if (cli.skill) {
        const skillNames = cli.skill.split(/\s+/).filter(Boolean);
        for (const skillName of skillNames) {
          console.log(
            `${ANSI.bold}${ANSI.cyan}You: ${ANSI.reset}${C.dim(`(invoking skill: ${skillName})`)}`,
          );
          const handled = await handleSlashCommand(`/${skillName}`, rl);
          if (!handled) {
            // Skill detected but not a slash command — send to SDK
            // so the session can load the skill instructions.
            await processMessage(session, `/${skillName}`);
          }
        }
      }
      console.log(`${ANSI.bold}${ANSI.cyan}You: ${ANSI.reset}${cli.prompt}`);
      const response = await processMessage(session, cli.prompt);
      if (response) {
        const suggestions = extractSuggestedCommands(response);
        for (const cmd of suggestions) {
          console.log(
            `${ANSI.bold}${ANSI.cyan}You: ${ANSI.reset}${C.dim(`(auto-applying: ${cmd})`)}`,
          );
          await handleSlashCommand(cmd, rl);
          if (pluginManager.consumeSandboxDirty()) {
            await syncPluginsToSandbox();
          }
          if (pluginManager.consumeSessionDirty()) {
            state.sessionNeedsRebuild = true;
          }
        }
        // If auto-approve + suggestions applied, continue the conversation
        if (state.autoApprove && suggestions.length > 0) {
          await processMessage(session, "continue");
        }
      }
      printExitTokenSummary();
      console.log(`\n✅ Prompt completed. (${formatSessionDuration()})\n`);
      cleanupCtrlR?.();
      rl.close();
      return;
    }

    // When a suggested command is approved, the agent should
    // automatically continue rather than waiting for user input.
    let pendingContinuation: string | null = null;

    while (true) {
      let trimmed: string;

      if (pendingContinuation) {
        // Auto-continue after an approved suggested command.
        // Show what we're sending so the user sees the flow.
        trimmed = pendingContinuation;
        pendingContinuation = null;
        console.log(
          `${ANSI.bold}${ANSI.cyan}You: ${ANSI.reset}${C.dim("(continuing after config change…)")}`,
        );
      } else {
        const userInput = await questionCapturingPaste(
          rl,
          `${ANSI.bold}${ANSI.cyan}You: ${ANSI.reset}`,
        );
        trimmed = userInput.trim();
      }

      if (!trimmed) continue;

      // Exit — either bare 'exit' or '/exit'
      const lower = trimmed.toLowerCase();
      if (lower === "exit" || lower === "/exit") {
        printExitTokenSummary();
        console.log(`\n👋 Goodbye! (session: ${formatSessionDuration()})\n`);
        break;
      }

      // Slash commands — intercepted before the agent sees them.
      // Clear any pending continuation — if the user is typing
      // commands manually, any auto-continue from a previous
      // suggestion acceptance is stale.
      if (trimmed.startsWith("/")) {
        pendingContinuation = null;
        const handled = await handleSlashCommand(trimmed, rl);
        if (handled) continue;
        // Not handled — could be a skill (/<skill-name>).
        // Fall through to processMessage so the SDK can invoke it.
      }

      // Use activeSession (may have been swapped by /model, /new, /resume)
      if (!state.activeSession) {
        console.error(
          `\n${C.err("❌ No active session.")} Use /new to start one.\n`,
        );
        continue;
      }

      // ── Dirty flag handling (plugin + buffer changes) ─────
      // When plugins are enabled/disabled or buffer sizes change,
      // rebuild the sandbox and/or session before the next message.
      if (pluginManager.consumeSandboxDirty()) {
        await syncPluginsToSandbox();
        if (state.debugEnabled) {
          debugLog("Sandbox synced with plugin changes");
        }
      }

      // Rebuild the session if plugins changed OR buffer sizes changed
      // (buffer changes update the system message with new limits).
      const needsSessionRebuild =
        pluginManager.consumeSessionDirty() || state.sessionNeedsRebuild;
      if (needsSessionRebuild && state.copilotClient && state.activeSession) {
        state.sessionNeedsRebuild = false;
        try {
          // Resume the SAME session with updated config (tools,
          // system message). Do NOT destroy first — destroy nukes
          // the server-side session and its history.
          const sessionId = state.activeSession.sessionId;
          state.activeSession = await state.copilotClient.resumeSession(
            sessionId,
            {
              model: state.currentModel,
              ...buildSessionConfig(),
            },
          );
          registerEventHandler(state.activeSession);
          if (state.debugEnabled) {
            debugLog("Session rebuilt with updated config");
          }
        } catch (err) {
          console.error(
            `  ⚠️  Failed to rebuild session: ${(err as Error).message}`,
          );
        }
      }

      process.stdout.write(`\n${ANSI.bold}${ANSI.magenta}Agent: ${ANSI.reset}`);
      const responseText = await processMessage(state.activeSession, trimmed);

      // ── Cancel guard ─────────────────────────────────────
      // If the user pressed ESC and this response was cancelled,
      // the streamed text is partial/stale. Don't extract
      // suggestions from dead text (Fix A) and don't auto-
      // continue from a cancelled context (Fix D).
      if (state.lastResponseWasCancelled) {
        pendingContinuation = null;
        continue;
      }

      // ── Auto-suggest actionable commands ─────────────────
      // If the LLM suggested slash commands (e.g.
      //   /plugin enable fetch allowedContentTypes=[...]
      // ), offer them for quick approval instead of making
      // the user copy-paste.
      //
      // Single command → simple Y/n prompt.
      // Multiple commands → numbered menu (pick one or skip).
      //
      // When a command is approved and executed, we set
      // pendingContinuation so the agent auto-continues with
      // the task — no need for the user to re-type anything.
      if (responseText) {
        const suggestions = extractSuggestedCommands(responseText);
        if (suggestions.length === 1) {
          // Single suggestion — quick Y/n approval
          const cmd = suggestions[0];
          await drainAndWarn(rl);
          const answer = await rl.question(
            `  ${C.warn("💡 Run suggested command?")} ${C.val(cmd)}\n` +
              `     ${C.dim("[Y]es / [n]o: ")}`,
          );
          const normalised = answer.trim().toLowerCase();
          if (normalised === "" || normalised === "y" || normalised === "yes") {
            console.log(`  ${C.info("⚡ Executing:")} ${C.val(cmd)}`);
            await handleSlashCommand(cmd, rl);
            // Auto-continue — tell the LLM the config changed
            // so it picks up where it left off. We DON'T re-send
            // the original input (it might be a mistyped command).
            // The conversation history already has the user's
            // original request — the LLM just needs a nudge.
            pendingContinuation =
              "Done — I applied that configuration change. Please continue with what I asked.";
          } else {
            console.log(`  ${C.dim("⏭️  Skipped.")}`);
          }
        } else if (suggestions.length > 1) {
          // Multiple suggestions — numbered menu, pick one
          console.log(`  ${C.warn("💡 Suggested commands:")}`);
          for (let i = 0; i < suggestions.length; i++) {
            console.log(
              `     ${C.info(`[${i + 1}]`)} ${C.val(suggestions[i])}`,
            );
          }
          await drainAndWarn(rl);
          const answer = await rl.question(
            `     ${C.dim(`Pick [1-${suggestions.length}], [a]ll, or [n]one: `)}`,
          );
          const normalised = answer.trim().toLowerCase();
          if (
            normalised === "n" ||
            normalised === "none" ||
            normalised === ""
          ) {
            console.log(`  ${C.dim("⏭️  Skipped all.")}`);
          } else if (
            normalised === "both" ||
            normalised === "all" ||
            normalised === "b" ||
            normalised === "a"
          ) {
            // Execute ALL suggested commands sequentially
            for (const cmd of suggestions) {
              console.log(`  ${C.info("⚡ Executing:")} ${C.val(cmd)}`);
              await handleSlashCommand(cmd, rl);
            }
            pendingContinuation =
              "Done — I applied all those configuration changes. Please continue with what I asked.";
          } else {
            const pick = parseInt(normalised, 10);
            if (pick >= 1 && pick <= suggestions.length) {
              const cmd = suggestions[pick - 1];
              console.log(`  ${C.info("⚡ Executing:")} ${C.val(cmd)}`);
              await handleSlashCommand(cmd, rl);
              // Auto-continue — see single-command path for rationale.
              pendingContinuation =
                "Done — I applied that configuration change. Please continue with what I asked.";
            } else {
              console.log(`  ${C.dim("⏭️  Invalid choice — skipped.")}`);
            }
          }
        }
      }
    }
  } finally {
    cleanupCtrlR?.();
    rl.close();

    // Stop transcript and show file paths before cleanup.
    if (transcript.active) {
      const paths = await transcript.stop();
      console.log("  📄 Transcript saved:");
      console.log(`     ANSI log:  ${paths.logPath}`);
      console.log(`     Clean text: ${paths.txtPath}`);
      console.log();
    }

    // Close tune stream if active
    if (tuneStream) {
      tuneStream.end();
      console.log(`  🎛️  Tune log saved: ${tuneLogPath}`);
    }

    // Clean up: destroy the session and stop the CLI server
    if (state.activeSession) {
      await state.activeSession.destroy();
      state.activeSession = null;
    }
    await client.stop();
    state.copilotClient = null;

    // Shutdown native addons before exit to prevent SIGSEGV from
    // Rust TLS destructors racing with Node's exit handlers.
    await shutdownAnalysisGuest();

    // Exit cleanly so the process doesn't linger after /exit.
    // Without this the event loop stays alive (readline, timers)
    // and the user has to CTRL-C — which triggers the SIGINT
    // handler and prints a second goodbye message.  Not cool.
    process.exit(0);
  }
}

// ── Entry Point ──────────────────────────────────────────────────────

// Timeout (ms) for graceful SDK shutdown before force-stopping.
const SHUTDOWN_TIMEOUT_MS = 5_000;

// Graceful shutdown — clean up on SIGINT (Ctrl+C)
process.on("SIGINT", async () => {
  printExitTokenSummary();
  console.log(`\n\n👋 Goodbye! (session: ${formatSessionDuration()})\n`);

  // Stop transcript synchronously — async won't complete before exit
  if (transcript.active) {
    const paths = transcript.stopSync();
    console.log("  📄 Transcript saved:");
    if (paths.logPath) console.log(`     ANSI log:  ${paths.logPath}`);
    if (paths.txtPath) console.log(`     Clean text: ${paths.txtPath}`);
    console.log();
  }

  // Graceful SDK shutdown — destroy session, then stop client
  // with a timeout fallback to forceStop.
  if (state.activeSession) {
    try {
      await state.activeSession.destroy();
    } catch {
      // Best-effort — don't block exit on destroy failure
    }
    state.activeSession = null;
  }

  if (state.copilotClient) {
    const stopPromise = state.copilotClient.stop();
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("Graceful stop timed out")),
        SHUTDOWN_TIMEOUT_MS,
      ),
    );
    try {
      await Promise.race([stopPromise, timeout]);
    } catch {
      // Graceful stop timed out or failed — force kill the CLI server
      try {
        await state.copilotClient.forceStop();
      } catch {
        // Nothing more we can do — exit anyway
      }
    }
    state.copilotClient = null;
  }

  // Shutdown native addons before exit to prevent SIGSEGV from
  // Rust TLS destructors racing with Node's exit handlers.
  await shutdownAnalysisGuest();

  process.exit(0);
});

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
