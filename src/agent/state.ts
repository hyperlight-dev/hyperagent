// ── agent/state.ts — Typed mutable state container ───────────────────
//
// Bundles all 22 module-level `let` variables from agent.ts into a
// single typed "bag of state".  Every function that reads or mutates
// agent state receives this object explicitly — no more invisible
// closures over module globals.
//
// Created once at startup via `createAgentState()` and threaded
// through the system as a plain mutable record.
// ─────────────────────────────────────────────────────────────────────

import type {
  CopilotClient,
  CopilotSession,
  AssistantMessageEvent,
  ModelInfo,
} from "@github/copilot-sdk";
import type { Interface as ReadlineInterface } from "node:readline/promises";
import type { CliConfig } from "./cli-parser.js";

// ── AgentState Interface ─────────────────────────────────────────────

/**
 * All mutable runtime state for the HyperAgent REPL.
 *
 * Organised into logical groups that mirror how the state flows
 * through the system.  Created once via `createAgentState()` and
 * threaded through every function that needs to read or mutate it.
 */
export interface AgentState {
  // ── Model & Display Toggles ───────────────────────────────────────

  /** Active model identifier.  Changed via `/model` slash command. */
  currentModel: string;

  /** Show executed code inline in the REPL.  Toggled via `/show code`. */
  showCodeEnabled: boolean;

  /** Show execution timing inline in the REPL.  Toggled via `/show timing`. */
  showTimingEnabled: boolean;

  /** Debug mode — log all session events to stderr.  Toggled via `/debug`. */
  debugEnabled: boolean;

  /**
   * Tune mode — capture LLM decision logs to JSONL.
   * Enabled via `--tune` CLI flag or `HYPERAGENT_TUNE=1`.
   * When active, the `llm_thought` tool is available to the LLM.
   */
  tuneEnabled: boolean;

  /**
   * Auto-approve all interactive prompts. When true, all plugin enable,
   * config change, audit, and module approval gates return "y" immediately.
   * Enabled via `--auto-approve` / `--yolo` CLI flag.
   */
  autoApprove: boolean;

  // ── Resource Overrides (slash-command DIP switches) ───────────────

  /** CPU timeout override (ms), or null → sandbox default. */
  cpuTimeoutOverride: number | null;

  /** Wall-clock timeout override (ms), or null → sandbox default. */
  wallTimeoutOverride: number | null;

  /** sendAndWait inactivity timeout override (ms), or null → SEND_TIMEOUT_MS. */
  sendTimeoutOverride: number | null;

  /** Input buffer size override (KB), or null → sandbox default. */
  inputBufferOverride: number | null;

  /** Output buffer size override (KB), or null → sandbox default. */
  outputBufferOverride: number | null;

  /** Heap size override (MB), or null → sandbox default. */
  heapOverride: number | null;

  /** Scratch size override (MB), or null → sandbox default. */
  scratchOverride: number | null;

  /**
   * Reasoning effort level override, or null → model default.
   * Only meaningful for models where capabilities.supports.reasoningEffort
   * is true. Changed via `/reasoning <low|medium|high|xhigh>`.
   */
  reasoningEffort: "low" | "medium" | "high" | "xhigh" | null;

  /**
   * Verbose output mode. When true, reasoning deltas scroll freely
   * through the terminal instead of showing a compact spinner preview,
   * and additional LLM lifecycle events are visible.
   * Toggled via `/verbose` command or `--verbose` CLI flag.
   */
  verboseOutput: boolean;

  /**
   * Reasoning effort level for audit sessions, or null → "medium".
   * Minimum is "medium" — audits should never skimp on thinking.
   * Changed via `/reasoning audit <low|medium|high|xhigh>`.
   * Note: "high" and "xhigh" may trigger opaque extended reasoning
   * with no visible output during continuation calls.
   */
  auditReasoningEffort: "medium" | "high" | "xhigh" | null;

  // ── Session Management ────────────────────────────────────────────

  /** Flag: session needs rebuild (buffer sizes changed, model switch). */
  sessionNeedsRebuild: boolean;

  /** The Copilot client — spawns the CLI server process. */
  copilotClient: CopilotClient | null;

  /** The active conversation session.  Replaced on /model, /new, /resume. */
  activeSession: CopilotSession | null;

  /** Cached model list from `client.listModels()`. */
  cachedModels: ModelInfo[] | null;

  // ── Event Handler ─────────────────────────────────────────────────

  /** Unsubscribe handle for the current session event handler. */
  eventHandlerUnsub: (() => void) | null;

  /** Generation counter — stale handlers bail on mismatch. */
  handlerGeneration: number;

  // ── Keep-Alive Shared State ───────────────────────────────────────

  /** Resolve function for the current send-and-wait promise. */
  pendingResolve: ((msg: AssistantMessageEvent | undefined) => void) | null;

  /** Reject function for the current send-and-wait promise. */
  pendingReject: ((err: Error) => void) | null;

  /** Keep-alive inactivity timeout handle. */
  keepAliveTimeoutId: ReturnType<typeof setTimeout> | null;

  /** Last assistant.message event captured for the active send. */
  lastAssistantMessage: AssistantMessageEvent | undefined;

  /**
   * Whether we're currently waiting for user input (approval prompts,
   * config questions, etc.). When true, the keep-alive timer should NOT
   * be running — it's the user's turn, not the model's turn.
   * Set before rl.question() prompts, cleared when user responds.
   */
  waitingForUserInput: boolean;

  // ── Message Processing ────────────────────────────────────────────

  /** Whether any streamed content was received in the current turn. */
  streamedContent: boolean;

  /** Accumulated streamed response text for suggestion extraction. */
  streamedText: string;

  /** How many auto-retries have been attempted for the current send. */
  inactivityRetryCount: number;
  /**
   * Whether the last processMessage() call was cancelled by the user
   * pressing ESC. Set by triggerAbort(), cleared at the start of each
   * processMessage(). Used to suppress suggestion extraction and
   * auto-continuation from cancelled/partial responses.
   */
  lastResponseWasCancelled: boolean;

  /**
   * Timestamp (ms) when the last user prompt was received.
   * Used to skip drainAndWarn() if a tool prompt happens immediately
   * after user input — those buffered lines are part of the paste,
   * not stale content from a previous interaction.
   */
  lastUserInputTime: number;

  // ── UI ───────────────────────────────────────────────────────────────

  /**
   * Active readline instance. Set once in main() after the readline
   * interface is created. Used by SDK hooks (onUserInputRequest) that
   * need to prompt the user for structured input.
   */
  readlineInstance: ReadlineInterface | null;

  // ── LLM Tool Approvals ──────────────────────────────────────────

  /**
   * Session-scoped approval cache for LLM tool actions that need
   * user consent. Cleared on /new session.
   *
   * Key format:
   *   "config:heap"           — config setting type approved
   *   "config:scratch"        — config setting type approved
   *   "config:cpuTimeout"     — etc.
   *   "plugin:disable:fetch"  — plugin disable approved
   *
   * Plugin ENABLE is NOT cached here — always goes through audit.
   * Config value changes within an approved type are auto-approved.
   */
  sessionApprovals: Set<string>;

  // ── suggest_approach State ──────────────────────────────────────

  /**
   * Skills pre-loaded via --skill CLI flag.
   * When non-empty, suggest_approach skips keyword matching and uses
   * these skill names directly for pattern resolution.
   */
  preLoadedSkills: string[];

  /**
   * Whether suggest_approach enforcement is skipped.
   * Set via --skip-suggest CLI flag.
   */
  skipSuggest: boolean;

  /**
   * The user's current prompt text, captured by onUserPromptSubmitted.
   * Used by runSuggestApproach for keyword matching against skills.
   */
  currentUserPrompt: string;

  /**
   * Whether list_modules has been called for the current task.
   * Reset on each new prompt. Used by onPreToolUse to enforce
   * module discovery before register_handler / edit_handler.
   */
  hasCalledListModules: boolean;

  /**
   * Tracks which modules the LLM has called module_info() on.
   * Used to warn when register_handler imports modules it hasn't inspected.
   * Reset on each new prompt.
   */
  modulesInspected: Set<string>;

  /**
   * Formatted guidance from the last runSuggestApproach invocation.
   * Stored in state so it survives compaction — re-injected via
   * additionalContext on every onUserPromptSubmitted.
   */
  lastGuidance: string | null;

  // ── Token Tracking ───────────────────────────────────────────────

  /** Cumulative input tokens across all LLM requests this session. */
  totalInputTokens: number;

  /** Cumulative output tokens across all LLM requests this session. */
  totalOutputTokens: number;

  /** Cumulative cache-read tokens across all LLM requests this session. */
  totalCacheReadTokens: number;

  /** Cumulative cache-write tokens across all LLM requests this session. */
  totalCacheWriteTokens: number;

  /** Total number of LLM API requests (one per assistant.usage event). */
  totalRequests: number;

  /** Number of user turns (messages sent) this session. */
  totalTurns: number;
}

// ── Factory ──────────────────────────────────────────────────────────

/**
 * Create a fresh `AgentState` from CLI config and initial display flags.
 *
 * The `opts` booleans are derived from sandbox config at startup so
 * that `state.ts` stays free of sandbox-tool dependencies.
 *
 * @param cli  - Parsed CLI arguments (model, debug flag, etc.)
 * @param opts - Initial display flags derived from `sandbox.config`
 */
export function createAgentState(
  cli: CliConfig,
  opts: { showCode: boolean; showTiming: boolean },
): AgentState {
  return {
    // Model & toggles
    currentModel: cli.model,
    showCodeEnabled: opts.showCode,
    showTimingEnabled: opts.showTiming,
    debugEnabled: cli.debug,
    tuneEnabled: cli.tune,
    autoApprove: cli.autoApprove,

    // Resource overrides — all null until slash commands change them
    cpuTimeoutOverride: null,
    wallTimeoutOverride: null,
    sendTimeoutOverride: null,
    inputBufferOverride: null,
    outputBufferOverride: null,
    heapOverride: null,
    scratchOverride: null,
    reasoningEffort: null,
    verboseOutput: cli.verbose,
    auditReasoningEffort: null,

    // Session management
    sessionNeedsRebuild: false,
    copilotClient: null,
    activeSession: null,
    cachedModels: null,

    // Event handler
    eventHandlerUnsub: null,
    handlerGeneration: 0,

    // Keep-alive
    pendingResolve: null,
    pendingReject: null,
    keepAliveTimeoutId: null,
    lastAssistantMessage: undefined,
    waitingForUserInput: false,

    // Message processing
    streamedContent: false,
    streamedText: "",
    inactivityRetryCount: 0,
    lastResponseWasCancelled: false,
    lastUserInputTime: 0,

    // UI
    readlineInstance: null,

    // LLM Tool Approvals
    sessionApprovals: new Set<string>(),

    // suggest_approach
    preLoadedSkills: [],
    skipSuggest: false,

    // Approach guidance (auto-invoked)
    currentUserPrompt: "",
    hasCalledListModules: false,
    modulesInspected: new Set<string>(),
    lastGuidance: null,

    // Token tracking
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalRequests: 0,
    totalTurns: 0,
  };
}
