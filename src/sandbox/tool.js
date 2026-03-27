// ── Shared Sandbox Tool ──────────────────────────────────────────────
//
// Reusable Hyperlight sandbox lifecycle for executing JavaScript code
// inside an isolated micro-VM with strict CPU time bounding.
//
// Used by both the MCP server and Copilot SDK agent examples.
// Each consumer calls createSandboxTool() to get its own sandboxed
// execution environment with independent lifecycle and configuration.
//
// ─────────────────────────────────────────────────────────────────────

import { createRequire } from "node:module";
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";

const require = createRequire(import.meta.url);
const { SandboxBuilder } = require("@hyperlight/js-host-api");

// ── Defaults ─────────────────────────────────────────────────────────

/** Default maximum CPU time per execution (milliseconds). */
const DEFAULT_CPU_TIMEOUT_MS = 1000;

/** Default maximum wall-clock time per execution (milliseconds). */
const DEFAULT_WALL_CLOCK_TIMEOUT_MS = 5000;

/** Default guest heap size in megabytes. */
const DEFAULT_HEAP_SIZE_MB = 16;

/** Default guest scratch size in megabytes. */
const DEFAULT_SCRATCH_SIZE_MB = 16;

/**
 * Default guest input buffer size in kilobytes.
 *
 * This buffer carries host-function return values (host→guest), so it
 * must be large enough for the biggest single response any plugin can
 * produce (e.g. a 1 MB readFile chunk) plus ~16 KB of protocol framing.
 */
const DEFAULT_INPUT_BUFFER_KB = 1040;

/**
 * Default guest output buffer size in kilobytes.
 *
 * This buffer carries host-function call arguments (guest→host), so it
 * must be large enough for the biggest single payload any plugin accepts
 * (e.g. a 1 MB writeFile content string) plus ~16 KB of protocol framing.
 */
const DEFAULT_OUTPUT_BUFFER_KB = 1040;

/** Bytes per megabyte — used for MB ↔ bytes conversion. */
const BYTES_PER_MB = 1024 * 1024;

/** Bytes per kilobyte — used for KB ↔ bytes conversion. */
const BYTES_PER_KB = 1024;

/** Minimum buffer size enforced by hyperlight-host (8KB). */
const MIN_BUFFER_KB = 8;

// ── Utilities ────────────────────────────────────────────────────────

/**
 * Parse a positive integer from a raw value (typically an env var),
 * falling back to `defaultVal` when the value is unset, empty, or
 * not a valid positive integer.
 *
 * @param {string|number|undefined} raw  — raw value (env var string or number)
 * @param {number}                  defaultVal — fallback
 * @returns {number}
 */
export function parsePositiveInt(raw, defaultVal) {
  if (raw === undefined || raw === "") return defaultVal;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    console.error(
      `[hyperlight] Warning: ignoring invalid value "${raw}", using default ${defaultVal}`,
    );
    return defaultVal;
  }
  return n;
}

// ── Factory ──────────────────────────────────────────────────────────

/**
 * @typedef {object} SandboxToolConfig
 * @property {number}      cpuTimeoutMs       — Max CPU time per execution (ms)
 * @property {number}      wallClockTimeoutMs — Max wall-clock time per execution (ms)
 * @property {number}      heapSizeMb         — Guest heap size (megabytes)
 * @property {number}      heapSizeBytes      — Guest heap size (bytes)
 * @property {number}      scratchSizeMb      — Guest scratch size (megabytes)
 * @property {number}      scratchSizeBytes   — Guest scratch size (bytes)
 * @property {number}      inputBufferKb      — Input buffer size (kilobytes)
 * @property {number}      inputBufferBytes   — Input buffer size (bytes)
 * @property {number}      outputBufferKb     — Output buffer size (kilobytes)
 * @property {number}      outputBufferBytes  — Output buffer size (bytes)
 * @property {string|null} timingLogPath      — Path to timing log file, or null
 * @property {string|null} codeLogPath        — Path to code log file, or null
 */

/**
 * @typedef {object} ExecutionResult
 * @property {boolean}                    success  — Whether execution completed without error
 * @property {*}                          [result] — Return value from the handler (on success)
 * @property {string}                     [error]  — Human-readable error message (on failure)
 * @property {Record<string, number>}     [timing] — Timing breakdown (always present)
 */

/**
 * @typedef {object} SandboxTool
 * @property {SandboxToolConfig}                                                config
 * @property {() => Promise<void>}                                              initializeSandbox
 * @property {(code: string, overrides?: {cpuTimeoutMs?: number, wallClockTimeoutMs?: number}) => Promise<ExecutionResult>} executeJavaScript
 * @property {(timing: Record<string, number>) => void}                         writeTiming
 * @property {(code: string) => void}                                           writeCode
 * @property {(plugins: PluginRegistration[]) => void}                          setPlugins
 * @property {(inputKb?: number, outputKb?: number) => void}                    setBufferSizes
 * @property {() => void}                                                       resetBufferSizes
 * @property {() => {inputKb: number, outputKb: number}}                        getEffectiveBufferSizes
 * @property {(heapMb?: number, scratchMb?: number) => void}                    setMemorySizes
 * @property {() => void}                                                       resetMemorySizes
 * @property {() => {heapMb: number, scratchMb: number}}                        getEffectiveMemorySizes
 * @property {(name: string, code: string, options?: {isModule?: boolean}) => Promise<{success: boolean, message?: string, error?: string, handlers?: string[], codeSize?: number, mode?: string}>} registerHandler
 * @property {(name: string) => Promise<{success: boolean, message?: string, error?: string, handlers?: string[]}>} deleteHandler
 * @property {(name: string, event?: object) => Promise<ExecutionResult>}       execute
 * @property {() => string[]}                                                   getHandlers
 * @property {(name: string) => string | null}                                  getHandlerSource
 * @property {() => string[]}                                                   getAvailableModules
 */

/**
 * @typedef {object} PluginRegistration
 * @property {string}                          name     — Plugin name (for logging)
 * @property {(config: object) => Record<string, Record<string, Function>>} createHostFunctions — Returns host functions by module name
 * @property {Record<string, *>}               config   — Resolved plugin configuration
 * @property {string[]}                        [declaredModules] — Host modules declared in manifest (for verification)
 */

/**
 * Create a new sandbox tool instance with its own sandbox lifecycle.
 *
 * Each instance maintains its own sandbox state and configuration.
 * Configuration is resolved from the provided options first, falling
 * back to environment variables, falling back to built-in defaults.
 *
 * @param {object}      [options={}]
 * @param {number}      [options.cpuTimeoutMs]       — Override HYPERLIGHT_CPU_TIMEOUT_MS
 * @param {number}      [options.wallClockTimeoutMs]  — Override HYPERLIGHT_WALL_TIMEOUT_MS
 * @param {number}      [options.heapSizeMb]          — Override HYPERLIGHT_HEAP_SIZE_MB
 * @param {number}      [options.scratchSizeMb]       — Override HYPERLIGHT_SCRATCH_SIZE_MB
 * @param {number}      [options.inputBufferKb]        — Override HYPERLIGHT_INPUT_BUFFER_KB
 * @param {number}      [options.outputBufferKb]       — Override HYPERLIGHT_OUTPUT_BUFFER_KB
 * @param {string|null} [options.timingLogPath]       — Override HYPERAGENT_TIMING_LOG
 * @param {string|null} [options.codeLogPath]         — Override HYPERAGENT_CODE_LOG
 * @param {boolean}     [options.verbose]             — Log lifecycle events (default: HYPERAGENT_DEBUG=1)
 * @returns {SandboxTool}
 */
export function createSandboxTool(options = {}) {
  // ── Resolve Configuration ────────────────────────────────────
  //
  // Priority: explicit option → env var → default constant.
  // All sandbox limits are set by the operator — the calling agent
  // cannot override them at invocation time.

  const cpuTimeoutMs =
    options.cpuTimeoutMs ??
    parsePositiveInt(
      process.env.HYPERLIGHT_CPU_TIMEOUT_MS,
      DEFAULT_CPU_TIMEOUT_MS,
    );

  const wallClockTimeoutMs =
    options.wallClockTimeoutMs ??
    parsePositiveInt(
      process.env.HYPERLIGHT_WALL_TIMEOUT_MS,
      DEFAULT_WALL_CLOCK_TIMEOUT_MS,
    );

  const heapSizeMb =
    options.heapSizeMb ??
    parsePositiveInt(process.env.HYPERLIGHT_HEAP_SIZE_MB, DEFAULT_HEAP_SIZE_MB);

  const scratchSizeMb =
    options.scratchSizeMb ??
    parsePositiveInt(
      process.env.HYPERLIGHT_SCRATCH_SIZE_MB,
      DEFAULT_SCRATCH_SIZE_MB,
    );

  const inputBufferKb =
    options.inputBufferKb ??
    parsePositiveInt(
      process.env.HYPERLIGHT_INPUT_BUFFER_KB,
      DEFAULT_INPUT_BUFFER_KB,
    );

  const outputBufferKb =
    options.outputBufferKb ??
    parsePositiveInt(
      process.env.HYPERLIGHT_OUTPUT_BUFFER_KB,
      DEFAULT_OUTPUT_BUFFER_KB,
    );

  const timingLogPath =
    options.timingLogPath !== undefined
      ? options.timingLogPath
      : process.env.HYPERAGENT_TIMING_LOG || null;

  const codeLogPath =
    options.codeLogPath !== undefined
      ? options.codeLogPath
      : process.env.HYPERAGENT_CODE_LOG || null;

  /** Whether to log lifecycle messages (init, shutdown, etc.). */
  const verbose = options.verbose ?? process.env.HYPERAGENT_DEBUG === "1";

  // ── Plugin Registrations ─────────────────────────────────────
  //
  // Plugins register host functions on the proto BEFORE loadRuntime().
  // Set via setPlugins() — the sandbox rebuilds lazily on the next
  // executeJavaScript() call so plugin changes take effect.

  /** @type {PluginRegistration[]} */
  let activePlugins = [];

  /** Frozen configuration snapshot — safe to share with consumers. */
  const config = Object.freeze({
    cpuTimeoutMs,
    wallClockTimeoutMs,
    heapSizeMb,
    heapSizeBytes: heapSizeMb * BYTES_PER_MB,
    scratchSizeMb,
    scratchSizeBytes: scratchSizeMb * BYTES_PER_MB,
    inputBufferKb,
    inputBufferBytes: inputBufferKb * BYTES_PER_KB,
    outputBufferKb,
    outputBufferBytes: outputBufferKb * BYTES_PER_KB,
    timingLogPath,
    codeLogPath,
  });

  // ── Mutable Buffer Overrides ─────────────────────────────────
  //
  // Buffer sizes are set at sandbox BUILD time — they can't be
  // changed on a running sandbox. When overrides are set (via
  // setBufferSizes()), we null jsSandbox to force a rebuild on
  // the next executeJavaScript() call.

  /** Input buffer override (KB), or null to use config default. */
  let inputBufferOverrideKb = null;

  /** Output buffer override (KB), or null to use config default. */
  let outputBufferOverrideKb = null;

  // ── Console Output Capture ────────────────────────────────────
  //
  // Guest console.log/print output is captured via setHostPrintFn().
  // Drained after each callHandler and included in the result.

  /** Captured console output from the guest since last drain. */
  let capturedConsoleOutput = [];

  /** Drain captured output and return it, resetting the buffer. */
  function drainConsoleOutput() {
    const output = capturedConsoleOutput.filter(
      (line) => line.trim().length > 0,
    );
    capturedConsoleOutput = [];
    return output.length > 0 ? output : undefined;
  }

  // ── Mutable Memory Overrides ─────────────────────────────────
  //
  // Heap and scratch sizes are also set at BUILD time. Same lazy-rebuild
  // pattern as buffers — override, null the sandbox, rebuild on next call.

  /** Heap size override (MB), or null to use config default. */
  let heapOverrideMb = null;

  /** Scratch size override (MB), or null to use config default. */
  let scratchOverrideMb = null;

  // ── Sandbox State ────────────────────────────────────────────
  //
  // MULTI-HANDLER STATEFUL SANDBOX:
  //
  //   [null] ──build──▶ [ProtoJSSandbox] ──loadRuntime──▶ [JSSandbox]
  //                                                          │
  //                                              addHandler(s) + getLoadedSandbox
  //                                                          │
  //                                                          ▼
  //                                                  [LoadedJSSandbox]
  //                                                     │        │
  //                                              callHandler   unload
  //                                               (repeat!)     │
  //                                                     │        ▼
  //                                               (result)  [JSSandbox]
  //
  // Multiple NAMED handlers are registered and compiled together.
  // Each handler has its own ES module scope — state is isolated
  // between handlers but persists within each handler across calls.
  //
  // The handler cache (name → code) survives config rebuilds. When
  // the sandbox is rebuilt (config changes, plugins), all cached
  // handlers are automatically re-registered. Module-level STATE
  // is lost, but the LLM doesn't need to re-send code.

  /** @type {object | null} JSSandbox — unloaded (handler registration) state */
  let jsSandbox = null;

  /** @type {object | null} LoadedJSSandbox — execution-ready state */
  let loadedSandbox = null;

  /**
   * Handler cache — maps handler names to {code, hash}.
   * Survives config rebuilds (invalidateSandbox). Only cleared by
   * clearAllHandlers() or individual deleteHandler() calls.
   *
   * Internal handlers (names starting with _) are auto-registered
   * and cannot be deleted or overwritten by the LLM.
   *
   * @type {Map<string, {code: string, hash: string}>}
   */
  const handlerCache = new Map();

  // ── Internal Handlers ──────────────────────────────────────
  //
  // Always-present handlers for save/restore of shared-state.
  // Registered at creation time so they're part of every compilation.
  // Names start with _ — hidden from LLM-facing handler listings
  // and protected from deletion/overwrite.

  /** Handler code for _save_state — snapshots shared-state via ha:_save. */
  const INTERNAL_SAVE_HANDLER =
    'import { save } from "ha:_save";\n' +
    "export function handler() { return { saved: save() }; }";

  /** Handler code for _restore_state — repopulates shared-state via ha:_restore. */
  const INTERNAL_RESTORE_HANDLER =
    'import { restore } from "ha:_restore";\n' +
    "export function handler() {\n" +
    "  const count = restore();\n" +
    "  return { restored: count };\n" +
    "}";

  /** Stashed shared-state snapshot — survives sandbox rebuilds. */
  let savedSharedState = null;

  /**
   * When true, guest-side shared-state is stale (doesn't match host stash).
   * Set after crash recovery restore from snapshot. Cleared after next
   * successful handler execution re-establishes consistency.
   *
   * While stale, autoSaveState() is skipped to avoid overwriting good
   * stash data with empty/old guest state.
   */
  let guestStateStale = false;

  /**
   * Ensure internal save/restore handlers are registered in the cache.
   * Called from setModules() — only adds handlers when their dependency
   * modules (_save, _restore) are actually loaded, avoiding compile
   * errors in test sandboxes that don't load modules.
   */
  function ensureInternalHandlers() {
    if (!moduleCache.has("_save") || !moduleCache.has("_restore")) return;
    if (!handlerCache.has("_save_state")) {
      handlerCache.set("_save_state", {
        code: INTERNAL_SAVE_HANDLER,
        hash: sha256(INTERNAL_SAVE_HANDLER),
      });
    }
    if (!handlerCache.has("_restore_state")) {
      handlerCache.set("_restore_state", {
        code: INTERNAL_RESTORE_HANDLER,
        hash: sha256(INTERNAL_RESTORE_HANDLER),
      });
    }
  }

  /**
   * Auto-save shared-state to host-side stash — best-effort.
   * Calls the internal _save_state handler directly on the loaded sandbox,
   * bypassing executeJavaScript to avoid recursion and lock contention.
   * Silent on failure — the main operation must not be blocked.
   *
   * The actual state data flows through the host:_state-sidecar host function
   * (stash), which preserves binary data (Uint8Array) via Hyperlight's
   * native binary sidecar channel.
   *
   */
  async function autoSaveState() {
    if (!loadedSandbox) {
      if (verbose) {
        console.error("[sandbox] autoSaveState: SKIP - no loadedSandbox");
      }
      return;
    }
    // Skip if sandbox is poisoned — its state is corrupt/reset.
    // Saving would overwrite the good stash from before the poison event.
    if (loadedSandbox.poisoned) {
      if (verbose) {
        console.error(
          "[sandbox] autoSaveState: SKIP - sandbox is POISONED, preserving existing stash",
        );
      }
      return;
    }
    // Skip if guest state is stale (after crash recovery restore from snapshot).
    // The guest has old/empty state; saving would overwrite the good stash.
    if (guestStateStale) {
      if (verbose) {
        console.error(
          "[sandbox] autoSaveState: SKIP - guest state is STALE (post-crash-recovery), preserving existing stash",
        );
      }
      return;
    }
    if (!handlerCache.has("_save_state")) {
      if (verbose) {
        console.error(
          "[sandbox] autoSaveState: SKIP - _save_state handler not in cache. " +
            `handlerCache keys: [${[...handlerCache.keys()].join(", ")}]`,
        );
      }
      return;
    }
    try {
      if (verbose) {
        console.error(
          "[sandbox] autoSaveState: CALLING _save_state handler...",
        );
      }
      // The handler calls sidecar.stash() which stores state in savedSharedState
      const result = await loadedSandbox.callHandler(
        "_save_state",
        {},
        {
          cpuTimeoutMs: config.cpuTimeoutMs,
          wallClockTimeoutMs: config.wallClockTimeoutMs,
        },
      );
      if (verbose) {
        const stashSize = savedSharedState ? savedSharedState.size : 0;
        console.error(
          `[sandbox] autoSaveState: SUCCESS - result=${JSON.stringify(result)}, stash size=${stashSize} keys`,
        );
      }
    } catch (err) {
      // Only log failure in verbose mode — these are expected during
      // CPU timeouts and shouldn't clutter the UI.
      if (verbose) {
        console.error(
          `[sandbox] ⚠️  Failed to save shared-state: ${err.message ?? err}`,
        );
      }
    }
  }

  /**
   * Auto-restore shared-state from host-side stash — best-effort.
   * Calls the internal _restore_state handler directly on the loaded sandbox.
   * Returns true if restore succeeded, false otherwise.
   *
   * The actual state data flows through the host:_state-sidecar host functions
   * (listKeys, retrieveKey), which preserve binary data (Uint8Array) via
   * Hyperlight's native binary sidecar channel (top-level values only).
   *
   * @returns {Promise<boolean>}
   */
  async function autoRestoreState() {
    if (!loadedSandbox) {
      if (verbose) {
        console.error("[sandbox] autoRestoreState: SKIP - no loadedSandbox");
      }
      return false;
    }
    if (savedSharedState === null) {
      if (verbose) {
        console.error(
          "[sandbox] autoRestoreState: SKIP - savedSharedState is null",
        );
      }
      return false;
    }
    if (savedSharedState.size === 0) {
      if (verbose) {
        console.error(
          "[sandbox] autoRestoreState: SKIP - savedSharedState is empty",
        );
      }
      return false;
    }
    if (!handlerCache.has("_restore_state")) {
      if (verbose) {
        console.error(
          "[sandbox] autoRestoreState: SKIP - _restore_state handler not in cache. " +
            `handlerCache keys: [${[...handlerCache.keys()].join(", ")}]`,
        );
      }
      return false;
    }

    // Pre-check: estimate stash size to avoid buffer overflow that poisons sandbox.
    // Each value is sent through the host function return buffer separately.
    // Find the largest single value — that's the bottleneck.
    const effectiveOutputKb = outputBufferOverrideKb ?? config.outputBufferKb;
    const maxBufferBytes = effectiveOutputKb * 1024;
    let largestValueBytes = 0;
    let largestKey = "";
    for (const [key, value] of savedSharedState) {
      const size =
        value instanceof Uint8Array || Buffer.isBuffer(value)
          ? value.length
          : JSON.stringify(value).length;
      if (size > largestValueBytes) {
        largestValueBytes = size;
        largestKey = key;
      }
    }
    // Add ~10% overhead for host function call framing
    const estimatedRequired = Math.ceil(largestValueBytes * 1.1);
    if (estimatedRequired > maxBufferBytes) {
      console.error(
        `[sandbox] ⚠️  Shared-state key "${largestKey}" (~${Math.round(largestValueBytes / 1024)}KB) ` +
          `exceeds output buffer (${effectiveOutputKb}KB). Skipping restore. ` +
          `Increase buffer with configure_sandbox({ outputBuffer: ${Math.ceil(estimatedRequired / 1024) + 128} }) ` +
          `or use files for large binary data.`,
      );
      guestStateStale = false;
      return false;
    }

    try {
      if (verbose) {
        console.error(
          `[sandbox] autoRestoreState: CALLING _restore_state handler... (stash has ${savedSharedState.size} keys: [${[...savedSharedState.keys()].join(", ")}])`,
        );
      }
      // The handler calls sidecar.listKeys() and sidecar.retrieveKey() to restore
      const result = await loadedSandbox.callHandler(
        "_restore_state",
        {},
        {
          cpuTimeoutMs: config.cpuTimeoutMs,
          wallClockTimeoutMs: config.wallClockTimeoutMs,
        },
      );
      if (verbose) {
        console.error(
          `[sandbox] autoRestoreState: SUCCESS - result=${JSON.stringify(result)}`,
        );
      }
      return true;
    } catch (err) {
      // Restore failed — likely buffer overflow from oversized stash.
      const msg = err.message ?? String(err);
      const isBufferOverflow = /buffer|space|Required:.*Available:/i.test(msg);

      if (isBufferOverflow) {
        // Don't clear the stash — it can be restored after buffer increase.
        // Just warn once and skip restore for this execution.
        console.error(
          "[sandbox] ⚠️  Shared-state too large to restore (buffer overflow). " +
            "Increase output buffer with configure_sandbox({ outputBuffer: <larger_kb> }), " +
            "or store large binary data in files instead of ha:shared-state.",
        );
        // Clear stale flag so we don't keep trying every execution
        guestStateStale = false;
      } else if (verbose) {
        console.error(`[sandbox] ⚠️  Failed to restore shared-state: ${msg}`);
      }

      return false;
    }
  }

  /**
   * Plugins that failed to register during the last sandbox build.
   * Used to provide actionable error messages when handlers fail
   * to compile because a plugin's host module is missing.
   * @type {string[]}
   */
  let lastFailedPluginRegistrations = [];

  /**
   * Module cache — maps module names to {source, hash}.
   * User modules registered via registerModule(). System modules
   * set via setModules(). All survive config rebuilds (auto-re-registered).
   *
   * The namespace prefix (e.g. "ha") is applied when calling addModule()
   * on the JSSandbox — names in this cache do NOT include the prefix.
   *
   * @type {Map<string, {source: string, hash: string}>}
   */
  const moduleCache = new Map();

  /** The namespace prefix used for user/system modules. */
  const MODULE_NAMESPACE = "ha";

  /**
   * Combined hash of all registered handlers, computed from sorted
   * (name + hash) pairs. Used to detect when the handler set has
   * changed and recompilation is needed.
   * @type {string | null}
   */
  let compiledHandlersHash = null;

  /** @type {object | null} Post-compile snapshot for timeout recovery */
  let currentSnapshot = null;

  // ── Hashing Helpers ──────────────────────────────────────────

  /**
   * Compute a SHA-256 hash of a string.
   * @param {string} s
   * @returns {string} Hex-encoded SHA-256
   */
  function sha256(s) {
    return createHash("sha256").update(s).digest("hex");
  }

  /**
   * Strip JSDoc comments from source while preserving line numbers.
   * Replaces /** ... *​/ blocks with equivalent newlines so runtime
   * error line numbers match the original source.
   *
   * Does NOT strip single-line // comments.
   *
   * @param {string} source - JavaScript source code
   * @returns {string} Source with JSDoc blocks replaced by newlines
   */
  function stripJsdoc(source) {
    return source.replace(/\/\*\*[\s\S]*?\*\//g, (match) => {
      // Count newlines in the JSDoc block
      const newlineCount = (match.match(/\n/g) || []).length;
      return "\n".repeat(newlineCount);
    });
  }

  /**
   * Compute a combined hash of all handlers AND modules in the caches.
   * Sorted by name so insertion order doesn't matter.
   * Both caches contribute so module changes trigger recompilation.
   * @returns {string}
   */
  function computeHandlersHash() {
    if (handlerCache.size === 0 && moduleCache.size === 0) return "";
    const handlerEntries = [...handlerCache.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    );
    const moduleEntries = [...moduleCache.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    );
    const handlerPart = handlerEntries
      .map(([n, e]) => `h:${n}\0${e.hash}`)
      .join("\n");
    const modulePart = moduleEntries
      .map(([n, e]) => `m:${n}\0${e.hash}`)
      .join("\n");
    return sha256(handlerPart + "\n" + modulePart);
  }

  /**
   * Check if code is already registered under a DIFFERENT name.
   * Prevents duplicate code waste. Returns the existing name or null.
   * Skips internal handlers (names starting with _).
   * @param {string} hash — SHA-256 of the code to check
   * @param {string} excludeName — Name to exclude from the check
   * @returns {string | null} Name of the handler with the same code, or null
   */
  function findDuplicateCode(hash, excludeName) {
    for (const [name, entry] of handlerCache) {
      if (name.startsWith("_")) continue;
      if (name !== excludeName && entry.hash === hash) return name;
    }
    return null;
  }

  /**
   * Get public (non-internal) handler names.
   * Filters out names starting with _ (internal handlers).
   * @returns {string[]}
   */
  function publicHandlerNames() {
    return [...handlerCache.keys()].filter((n) => !n.startsWith("_"));
  }

  /**
   * Detect whether user code is a full ES module (defines its own
   * handler function) or a simple function body that needs wrapping.
   * @param {string} code
   * @returns {boolean}
   */
  function isFullModuleCode(code) {
    return /(?:^\s*(?:export\s+)?function\s+handler\s*\(|^\s*export\b)/m.test(
      code,
    );
  }

  /**
   * Invalidate compiled sandbox state — config changes, errors.
   * PRESERVES handlerCache so handlers are auto-re-registered.
   * PRESERVES savedSharedState — call autoSaveState() first if needed!
   *
   * For paths that might have unsaved state (setPlugins, setBufferSizes,
   * setMemorySizes), use invalidateSandboxWithSave() instead.
   */
  function invalidateSandbox() {
    // Deterministically release VM resources instead of relying on V8 GC.
    // dispose() on a consumed sandbox is a safe no-op, so order doesn't matter.
    if (loadedSandbox) {
      try {
        loadedSandbox.dispose();
      } catch {
        // Already consumed or errored — swallow silently
      }
    }
    if (jsSandbox) {
      try {
        jsSandbox.dispose();
      } catch {
        // Already consumed or errored — swallow silently
      }
    }
    loadedSandbox = null;
    compiledHandlersHash = null;
    currentSnapshot = null;
    jsSandbox = null;
  }

  /**
   * Save state and then invalidate — for paths that change sandbox config.
   * This is async because autoSaveState() calls a handler.
   */
  async function invalidateSandboxWithSave() {
    if (loadedSandbox !== null) {
      if (verbose) {
        console.error(
          "[sandbox] invalidateSandboxWithSave: loadedSandbox exists, saving state...",
        );
      }
      await autoSaveState();
    } else if (verbose) {
      console.error(
        "[sandbox] invalidateSandboxWithSave: loadedSandbox is null, nothing to save",
      );
    }
    invalidateSandbox();
  }

  /**
   * Clear all public handlers AND invalidate compiled state.
   * Preserves internal handlers (names starting with _).
   * Used by resetSandbox for a truly clean slate.
   */
  function clearAllHandlers() {
    for (const name of [...handlerCache.keys()]) {
      if (!name.startsWith("_")) handlerCache.delete(name);
    }
    invalidateSandbox();
  }

  /**
   * Extract execution stats from the loaded sandbox.
   * @param {object | null} loaded
   * @returns {{ wallClockMs: number, cpuTimeMs: number | null, terminatedBy: string | null } | null}
   */
  function extractCallStats(loaded) {
    if (!loaded) return null;
    const raw = loaded.lastCallStats;
    if (!raw) return null;
    return {
      wallClockMs: raw.wallClockMs,
      cpuTimeMs: raw.cpuTimeMs ?? null,
      terminatedBy: raw.terminatedBy ?? null,
    };
  }

  // ── Execution Lock ───────────────────────────────────────────

  /** @type {Promise<void>} */
  let executionQueue = Promise.resolve();

  /**
   * Acquire the execution lock. Returns a release function.
   * All sandbox operations go through this to prevent races.
   * @returns {Promise<() => void>}
   */
  async function acquireLock() {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const prev = executionQueue;
    executionQueue = gate;
    await prev;
    return release;
  }

  // ── Lifecycle Functions ──────────────────────────────────────

  /**
   * Build a fresh sandbox from scratch.
   * Called lazily on first execute, and again after unrecoverable errors.
   */
  async function initializeSandbox() {
    const builder = new SandboxBuilder();

    // Memory sizes — overrides win over config defaults.
    const effectiveHeapMb = heapOverrideMb ?? config.heapSizeMb;
    const effectiveScratchMb = scratchOverrideMb ?? config.scratchSizeMb;
    builder.setHeapSize(effectiveHeapMb * BYTES_PER_MB);
    builder.setScratchSize(effectiveScratchMb * BYTES_PER_MB);

    // Buffer sizes — overrides win over config defaults.
    const effectiveInputKb = inputBufferOverrideKb ?? config.inputBufferKb;
    const effectiveOutputKb = outputBufferOverrideKb ?? config.outputBufferKb;
    builder.setInputBufferSize(effectiveInputKb * BYTES_PER_KB);
    builder.setOutputBufferSize(effectiveOutputKb * BYTES_PER_KB);

    // Capture guest console.log/print output via host callback.
    // Each print message is pushed to capturedConsoleOutput and
    // drained after each callHandler.
    builder.setHostPrintFn((message) => {
      capturedConsoleOutput.push(message);
    });

    const proto = await builder.build();

    // ── Register internal state sidecar host functions ────────
    //
    // Binary data (Uint8Array) can't survive JSON serialization through
    // callHandler returns. But host functions use a binary sidecar that
    // preserves Uint8Array natively FOR TOP-LEVEL arguments/returns.
    //
    // CRITICAL: Nested Uint8Arrays in objects DO NOT go through the sidecar!
    // { key: Uint8Array } passes the Uint8Array through napi-rs default
    // conversion (JSON array), which is memory-inefficient.
    //
    // Solution: Store each value separately with individual host function
    // calls, so binary data is always a top-level argument.

    const stateSidecar = proto.hostModule("_state-sidecar");

    stateSidecar.register("stashKey", (key, value) => {
      // value is top-level — Buffer if Uint8Array, preserved via sidecar
      if (savedSharedState === null) savedSharedState = new Map();
      savedSharedState.set(key, value);
      return true;
    });

    stateSidecar.register("retrieveKey", (key) => {
      // Returns the value — binary comes back via sidecar (top-level)
      if (savedSharedState === null) return undefined;
      return savedSharedState.get(key);
    });

    stateSidecar.register("listKeys", () => {
      // Returns array of keys (plain JSON)
      if (savedSharedState === null) return [];
      return [...savedSharedState.keys()];
    });

    stateSidecar.register("clearStash", () => {
      savedSharedState = null;
      return true;
    });

    stateSidecar.register("hasStash", () => {
      return savedSharedState !== null && savedSharedState.size > 0;
    });

    // ── Register plugin host functions ───────────────────────
    //
    // SECURITY: Declarative plugin API — the host calls createHostFunctions()
    // and registers the returned functions itself. Plugins NEVER receive
    // access to proto or the sandbox, completely closing the GAP 2 attack
    // vector where a malicious plugin could register undeclared modules.
    //
    // Each plugin's createHostFunctions(config) returns:
    //   { moduleName: { fnName: fn, ... }, ... }
    //
    // The host then calls proto.hostModule(moduleName).register(fnName, fn)
    // for each function, verifying against the plugin manifest's hostModules.

    /** @type {string[]} Plugins that failed to register (for error surfacing) */
    const failedPluginRegistrations = [];
    for (const plugin of activePlugins) {
      // Safety check — catch misconfigured plugin objects before they
      // cause cryptic "undefined" errors in the VM.
      if (typeof plugin.createHostFunctions !== "function") {
        console.error(
          `[hyperlight] BUG: plugin "${plugin.name ?? "?"}" has no createHostFunctions() function. ` +
            `Keys: ${Object.keys(plugin).join(", ")}. Skipping.`,
        );
        failedPluginRegistrations.push(plugin.name ?? "unknown");
        continue;
      }

      try {
        // Get declared modules from manifest — only these are allowed
        const declaredModules = new Set(plugin.declaredModules || []);

        // Call the plugin's factory function to get host functions
        const hostFunctions = plugin.createHostFunctions(plugin.config);

        // Register each module and function — the HOST does this, not the plugin
        const registeredModules = [];
        for (const [moduleName, functions] of Object.entries(hostFunctions)) {
          // SECURITY: Verify module is declared in manifest
          if (!declaredModules.has(moduleName)) {
            console.error(
              `[hyperlight] 🚫 Plugin "${plugin.name}" returned UNDECLARED module: "${moduleName}"`,
            );
            console.error(
              `[hyperlight]    Declared in manifest: ${[...declaredModules].join(", ") || "(none)"}`,
            );
            failedPluginRegistrations.push(
              `${plugin.name}: undeclared module "${moduleName}"`,
            );
            continue; // Skip this module but continue with others
          }

          const mod = proto.hostModule(moduleName);
          for (const [fnName, fn] of Object.entries(functions)) {
            if (typeof fn !== "function") {
              console.error(
                `[hyperlight] Warning: plugin "${plugin.name}" module "${moduleName}" ` +
                  `has non-function value for "${fnName}" — skipping`,
              );
              continue;
            }
            mod.register(fnName, fn);
          }
          registeredModules.push(moduleName);
        }

        if (verbose) {
          console.error(
            `[hyperlight] Plugin "${plugin.name}" registered modules: ${registeredModules.join(", ")}`,
          );
        }
      } catch (err) {
        console.error(
          `[hyperlight] Warning: plugin "${plugin.name}" registration failed: ${err.message}`,
        );
        failedPluginRegistrations.push(`${plugin.name}: ${err.message}`);
      }
    }

    // Store failed registrations for actionable error messages later.
    lastFailedPluginRegistrations = failedPluginRegistrations;

    jsSandbox = await proto.loadRuntime();

    if (verbose) {
      console.error("[hyperlight] Sandbox initialized");
    }
  }

  // ── Handler Registration ──────────────────────────────────────

  /**
   * Register (or overwrite) a named handler.
   * The code is cached and will be compiled on the next execute call.
   * If the handler set changes, ALL handlers are recompiled (state lost).
   *
   * Duplicate detection: errors if the same code is already registered
   * under a different name (prevents waste).
   *
   * @param {string} name — Unique handler name
   * @param {string} code — JavaScript source (module or simple)
   * @param {{isModule?: boolean}} [options] — Optional settings from validation
   * @returns {Promise<{success: boolean, message?: string, error?: string, handlers?: string[]}>}
   */
  async function registerHandler(name, code, options = {}) {
    const release = await acquireLock();
    try {
      if (!name || typeof name !== "string") {
        return {
          success: false,
          error: "Handler name must be a non-empty string",
        };
      }
      // Block overwrite of internal handlers.
      if (name.startsWith("_")) {
        return {
          success: false,
          error: `Handler names starting with _ are reserved for internal use`,
        };
      }
      if (!code || typeof code !== "string") {
        return {
          success: false,
          error: "Handler code must be a non-empty string",
        };
      }

      // Use isModule from validation if provided, otherwise fall back to regex detection
      // (The regex fallback is only for backwards compatibility - validation should always provide isModule)
      const isModule =
        options.isModule !== undefined
          ? options.isModule
          : isFullModuleCode(code);
      const prepared = isModule
        ? code
        : `function handler(event) {\n${code}\n}\nexport { handler };`;
      const codeHash = sha256(prepared);

      // Duplicate code detection — same code under a different name.
      const existing = findDuplicateCode(codeHash, name);
      if (existing) {
        return {
          success: false,
          error: `This code is already registered as handler "${existing}". Use that name instead.`,
        };
      }

      // Check if this is a no-op (same name, same code).
      const prev = handlerCache.get(name);
      if (prev && prev.hash === codeHash) {
        return {
          success: true,
          message: `Handler "${name}" unchanged (same code)`,
          handlers: [...handlerCache.keys()],
        };
      }

      // Cache the handler — compilation happens lazily on next execute.
      handlerCache.set(name, { code: prepared, hash: codeHash });

      // Handler set changed — invalidate compiled state.
      // The next execute will recompile all handlers.
      if (loadedSandbox !== null) {
        if (verbose) {
          console.error(
            `[sandbox] registerHandler("${name}"): loadedSandbox exists, calling autoSaveState before invalidating...`,
          );
        }
        // autoSaveState() handles poisoned sandbox check internally
        await autoSaveState();
        try {
          jsSandbox = await loadedSandbox.unload();
          loadedSandbox = null;
        } catch {
          invalidateSandbox();
        }
        compiledHandlersHash = null;
        currentSnapshot = null;
        if (verbose) {
          const stashSize = savedSharedState ? savedSharedState.size : 0;
          console.error(
            `[sandbox] registerHandler("${name}"): sandbox invalidated, stash preserved with ${stashSize} keys`,
          );
        }
      } else {
        if (verbose) {
          console.error(
            `[sandbox] registerHandler("${name}"): loadedSandbox is null, no state to save`,
          );
        }
      }

      return {
        success: true,
        message: prev
          ? `Handler "${name}" updated (recompile pending — shared-state auto-preserved)`
          : `Handler "${name}" registered`,
        handlers: publicHandlerNames(),
        codeSize: prepared.length,
        mode: isModule ? "module" : "simple",
      };
    } finally {
      release();
    }
  }

  /**
   * Delete a named handler from the cache.
   * If the handler set changes, recompilation is triggered on next execute.
   *
   * @param {string} name — Handler name to remove
   * @returns {Promise<{success: boolean, message?: string, error?: string, handlers?: string[]}>}
   */
  async function deleteHandler(name) {
    const release = await acquireLock();
    try {
      // Block deletion of internal handlers — always, regardless of cache state.
      if (name.startsWith("_")) {
        return {
          success: false,
          error: `Internal handler "${name}" cannot be deleted`,
          handlers: publicHandlerNames(),
        };
      }
      if (!handlerCache.has(name)) {
        return {
          success: false,
          error: `Handler "${name}" not found`,
          handlers: publicHandlerNames(),
        };
      }

      handlerCache.delete(name);

      // Handler set changed — invalidate compiled state.
      if (loadedSandbox !== null) {
        await autoSaveState();
        try {
          jsSandbox = await loadedSandbox.unload();
          loadedSandbox = null;
        } catch {
          invalidateSandbox();
        }
        compiledHandlersHash = null;
        currentSnapshot = null;
      }

      return {
        success: true,
        message: `Handler "${name}" deleted (recompile pending — shared-state auto-preserved)`,
        handlers: publicHandlerNames(),
      };
    } finally {
      release();
    }
  }

  /**
   * Get the source code of a registered handler.
   * Allows the LLM to inspect and modify existing handlers without regenerating.
   *
   * @param {string} name — Handler name
   * @param {object} [options] — Optional parameters
   * @param {number} [options.startLine] — 1-based start line (inclusive)
   * @param {number} [options.endLine] — 1-based end line (inclusive)
   * @param {boolean} [options.lineNumbers] — Include line numbers (default: true)
   * @returns {{success: boolean, code?: string, totalLines?: number, startLine?: number, endLine?: number, error?: string, handlers?: string[]}}
   */
  function getHandlerSource(name, options = {}) {
    if (!name || typeof name !== "string") {
      return {
        success: false,
        error: "Handler name must be a non-empty string",
        handlers: publicHandlerNames(),
      };
    }
    if (name.startsWith("_")) {
      return {
        success: false,
        error: `Internal handler "${name}" source is not accessible`,
        handlers: publicHandlerNames(),
      };
    }
    const entry = handlerCache.get(name);
    if (!entry) {
      return {
        success: false,
        error: `Handler "${name}" not found`,
        handlers: publicHandlerNames(),
      };
    }

    const lines = entry.code.split("\n");
    const totalLines = lines.length;

    // Line range extraction (1-based, inclusive)
    let startLine = options.startLine ?? 1;
    let endLine = options.endLine ?? totalLines;

    // Clamp to valid range
    startLine = Math.max(1, Math.min(startLine, totalLines));
    endLine = Math.max(startLine, Math.min(endLine, totalLines));

    const selectedLines = lines.slice(startLine - 1, endLine);

    // Add line numbers by default (matches SDK edit tool pattern)
    const includeLineNumbers = options.lineNumbers !== false;
    let code;
    if (includeLineNumbers) {
      const width = String(endLine).length;
      code = selectedLines
        .map((line, i) => {
          const num = String(startLine + i).padStart(width, " ");
          return `${num} | ${line}`;
        })
        .join("\n");
    } else {
      code = selectedLines.join("\n");
    }

    return {
      success: true,
      code,
      totalLines,
      startLine,
      endLine,
      handlers: publicHandlerNames(),
    };
  }

  /**
   * Edit a handler by replacing a specific string with a new string.
   * Allows surgical edits without re-sending the entire handler code.
   *
   * @param {string} name — Handler name
   * @param {string} oldString — Exact string to find (must match exactly once)
   * @param {string} newString — Replacement string
   * @returns {Promise<{success: boolean, message?: string, error?: string, handlers?: string[], codeSize?: number, contextBefore?: string, contextAfter?: string}>}
   */
  async function editHandler(name, oldString, newString) {
    const release = await acquireLock();
    try {
      if (!name || typeof name !== "string") {
        return {
          success: false,
          error: "Handler name must be a non-empty string",
          handlers: publicHandlerNames(),
        };
      }
      if (name.startsWith("_")) {
        return {
          success: false,
          error: `Internal handler "${name}" cannot be edited`,
          handlers: publicHandlerNames(),
        };
      }
      if (typeof oldString !== "string") {
        return {
          success: false,
          error: "oldString must be a string",
          handlers: publicHandlerNames(),
        };
      }
      if (typeof newString !== "string") {
        return {
          success: false,
          error: "newString must be a string",
          handlers: publicHandlerNames(),
        };
      }
      if (oldString === newString) {
        return {
          success: false,
          error: "oldString and newString are identical — nothing to change",
          handlers: publicHandlerNames(),
        };
      }

      const entry = handlerCache.get(name);
      if (!entry) {
        return {
          success: false,
          error: `Handler "${name}" not found`,
          handlers: publicHandlerNames(),
        };
      }

      const code = entry.code;

      // Count occurrences
      let count = 0;
      let idx = 0;
      let matchIndex = -1;
      while ((idx = code.indexOf(oldString, idx)) !== -1) {
        if (count === 0) matchIndex = idx;
        count++;
        idx += oldString.length;
      }

      if (count === 0) {
        return {
          success: false,
          error: `oldString not found in handler "${name}"`,
          handlers: publicHandlerNames(),
        };
      }
      if (count > 1) {
        return {
          success: false,
          error: `oldString found ${count} times in handler "${name}" — must be unique. Add more surrounding context to make it unique.`,
          handlers: publicHandlerNames(),
        };
      }

      // Apply the edit
      const newCode =
        code.slice(0, matchIndex) +
        newString +
        code.slice(matchIndex + oldString.length);

      // Extract context around the edit for LLM feedback
      const lines = newCode.split("\n");
      const beforeMatch = code.slice(0, matchIndex);
      const matchLine = beforeMatch.split("\n").length; // 1-based line of start of match
      const contextStart = Math.max(0, matchLine - 3);
      const contextEnd = Math.min(lines.length, matchLine + 3);
      const contextLines = lines.slice(contextStart, contextEnd);
      const width = String(contextEnd).length;
      const contextAfter = contextLines
        .map((line, i) => {
          const num = String(contextStart + i + 1).padStart(width, " ");
          return `${num} | ${line}`;
        })
        .join("\n");

      const newHash = sha256(newCode);

      // Check for duplicate code under different name
      const existing = findDuplicateCode(newHash, name);
      if (existing) {
        return {
          success: false,
          error: `This edit would create duplicate code — same as handler "${existing}".`,
          handlers: publicHandlerNames(),
        };
      }

      // Update the cache
      handlerCache.set(name, { code: newCode, hash: newHash });

      // Invalidate compiled state (same as registerHandler)
      if (loadedSandbox !== null) {
        if (verbose) {
          console.error(
            `[sandbox] editHandler("${name}"): loadedSandbox exists, calling autoSaveState before invalidating...`,
          );
        }
        await autoSaveState();
        try {
          jsSandbox = await loadedSandbox.unload();
          loadedSandbox = null;
        } catch {
          invalidateSandbox();
        }
        compiledHandlersHash = null;
        currentSnapshot = null;
        if (verbose) {
          const stashSize = savedSharedState ? savedSharedState.size : 0;
          console.error(
            `[sandbox] editHandler("${name}"): sandbox invalidated, stash preserved with ${stashSize} keys`,
          );
        }
      }

      return {
        success: true,
        message: `Handler "${name}" edited (recompile pending — shared-state auto-preserved)`,
        handlers: publicHandlerNames(),
        codeSize: newCode.length,
        contextAfter,
      };
    } finally {
      release();
    }
  }

  // ── User Module Management ───────────────────────────────────
  //
  // Modules are ES modules that handlers (and other modules) can
  // import using `import { fn } from "ha:<name>"`. They are cached
  // alongside handlers and survive sandbox rebuilds.
  //
  // Unlike handlers, modules have NO "handler" export requirement
  // and cannot be called directly — they are pure libraries.

  /**
   * Register (or update) a named module in the cache.
   * The module will be available to handlers as `import { ... } from "ha:<name>"`.
   *
   * @param {string} name — Module name (without namespace prefix)
   * @param {string} source — ES module JavaScript source code
   * @returns {Promise<{success: boolean, message?: string, error?: string, modules?: string[]}>}
   */
  async function registerModule(name, source) {
    const release = await acquireLock();
    try {
      if (!name || typeof name !== "string") {
        return {
          success: false,
          error: "Module name must be a non-empty string",
        };
      }
      if (!source || typeof source !== "string") {
        return {
          success: false,
          error: "Module source must be a non-empty string",
        };
      }

      const sourceHash = sha256(source);

      // Check if this is a no-op (same name, same source).
      const prev = moduleCache.get(name);
      if (prev && prev.hash === sourceHash) {
        return {
          success: true,
          message: `Module "${name}" unchanged (same source)`,
          modules: [...moduleCache.keys()],
        };
      }

      // Cache the module — compilation happens lazily on next execute.
      moduleCache.set(name, { source, hash: sourceHash });

      // Module set changed — invalidate compiled state.
      if (loadedSandbox !== null) {
        await autoSaveState();
        try {
          jsSandbox = await loadedSandbox.unload();
          loadedSandbox = null;
        } catch {
          invalidateSandbox();
        }
        compiledHandlersHash = null;
        currentSnapshot = null;
      }

      return {
        success: true,
        message: prev
          ? `Module "${name}" updated (recompile pending — shared-state auto-preserved)`
          : `Module "${name}" registered`,
        modules: [...moduleCache.keys()],
        sourceSize: source.length,
      };
    } finally {
      release();
    }
  }

  /**
   * Delete a named module from the cache.
   *
   * @param {string} name — Module name to remove
   * @returns {Promise<{success: boolean, message?: string, error?: string, modules?: string[]}>}
   */
  async function deleteModule(name) {
    const release = await acquireLock();
    try {
      if (!moduleCache.has(name)) {
        return {
          success: false,
          error: `Module "${name}" not found`,
          modules: [...moduleCache.keys()],
        };
      }

      moduleCache.delete(name);

      // Module set changed — invalidate compiled state.
      if (loadedSandbox !== null) {
        await autoSaveState();
        try {
          jsSandbox = await loadedSandbox.unload();
          loadedSandbox = null;
        } catch {
          invalidateSandbox();
        }
        compiledHandlersHash = null;
        currentSnapshot = null;
      }

      return {
        success: true,
        message: `Module "${name}" deleted (recompile pending — shared-state auto-preserved)`,
        modules: [...moduleCache.keys()],
      };
    } finally {
      release();
    }
  }

  /**
   * Bulk-set modules in the cache. Called at startup to pre-populate
   * system modules and on sandbox rebuild to re-register all cached
   * modules.
   *
   * @param {Array<{name: string, source: string}>} modules — Modules to register
   */
  function setModules(modules) {
    for (const mod of modules) {
      if (mod.name && mod.source) {
        moduleCache.set(mod.name, {
          source: mod.source,
          hash: sha256(mod.source),
        });
      }
    }
    // Register internal save/restore handlers once their modules arrive.
    ensureInternalHandlers();
  }

  /**
   * Get all registered module names.
   * @returns {string[]}
   */
  function getModuleNames() {
    return [...moduleCache.keys()];
  }

  /**
   * Get all registered handler names (excluding internal handlers).
   * @returns {string[]}
   */
  function getHandlers() {
    return [...handlerCache.keys()].filter((name) => !name.startsWith("_"));
  }

  /**
   * Get all available modules for import (system + user modules + host plugins).
   * Returns qualified names like "ha:pptx", "ha:shared-state", "host:fetch".
   *
   * All modules from moduleCache use the "ha:" namespace when compiled
   * (via addModule with MODULE_NAMESPACE). Host modules use "host:" prefix.
   *
   * @returns {string[]}
   */
  function getAvailableModules() {
    // All modules in moduleCache are compiled with MODULE_NAMESPACE ("ha:")
    // Filter out internal modules (starting with "_")
    const haModules = [...moduleCache.keys()]
      .filter((name) => !name.startsWith("_"))
      .map((name) => `${MODULE_NAMESPACE}:${name}`);

    // Host modules from plugins are prefixed with "host:"
    // Each plugin registers as host:<plugin.name>
    const hostModules = activePlugins
      .filter((p) => p.name)
      .map((p) => `host:${p.name}`);

    return [...haModules, ...hostModules];
  }

  // ── Execution ────────────────────────────────────────────────

  /**
   * Execute a named handler with optional event data.
   *
   * If the sandbox needs building or recompiling (first call, config
   * change, handler change), it happens automatically. All cached
   * handlers are compiled together.
   *
   * @param {string}  handlerName — Name of a registered handler
   * @param {object}  [event={}]  — Event data passed to handler(event)
   * @param {object}  [overrides={}] — Per-call timeout overrides
   * @returns {Promise<ExecutionResult>}
   */
  async function executeJavaScript(handlerName, event = {}, overrides = {}) {
    const release = await acquireLock();
    try {
      return await executeImpl(handlerName, event, overrides);
    } finally {
      release();
    }
  }

  /**
   * Internal execution — called under the lock.
   * @param {string} handlerName
   * @param {object} event
   * @param {object} overrides
   * @returns {Promise<ExecutionResult>}
   */
  async function executeImpl(handlerName, event, overrides) {
    const timing = {
      initMs: 0,
      setupMs: 0,
      compileMs: 0,
      executeMs: 0,
      snapshotMs: 0,
      totalMs: 0,
    };
    const totalStart = performance.now();

    // ── Validate handler exists in cache ─────────────────────
    if (!handlerCache.has(handlerName)) {
      return {
        success: false,
        error: `Handler "${handlerName}" not registered. Call register_handler first.`,
      };
    }

    // ── Ensure sandbox infrastructure exists ─────────────────
    if (jsSandbox === null && loadedSandbox === null) {
      const t0 = performance.now();
      await initializeSandbox();
      timing.initMs = Math.round(performance.now() - t0);
    }

    // ── Compile all handlers if needed ───────────────────────
    const currentHash = computeHandlersHash();
    let statePreserved = false;
    let rebuildReason = null;

    if (loadedSandbox !== null && currentHash === compiledHandlersHash) {
      // All handlers unchanged — reuse loaded sandbox. State preserved!
      statePreserved = true;

      // BUT if guest state is stale (post-crash-recovery), we need to restore
      // from stash before executing. The snapshot-restored guest has old/empty
      // shared-state, but the host stash has the latest good state.
      if (
        guestStateStale &&
        savedSharedState !== null &&
        savedSharedState.size > 0
      ) {
        if (verbose) {
          console.error(
            "[sandbox] executeJavaScript: guest state is STALE, restoring from stash before execution...",
          );
        }
        if (await autoRestoreState()) {
          // Re-snapshot to include restored state
          try {
            currentSnapshot = await loadedSandbox.snapshot();
          } catch {
            // Non-fatal
          }
          guestStateStale = false;
          if (verbose) {
            console.error(
              "[sandbox] executeJavaScript: stash restored, guestStateStale cleared",
            );
          }
        }
        // If restore failed, autoRestoreState already cleared the stash
      } else if (guestStateStale) {
        // No saved state to restore — clear the stale flag anyway.
        // This happens when a crash occurs before any state was saved.
        guestStateStale = false;
        if (verbose) {
          console.error(
            "[sandbox] executeJavaScript: guestStateStale cleared (no stash to restore)",
          );
        }
      }
    } else {
      // Handler set changed or first compile — (re)compile all.
      rebuildReason =
        compiledHandlersHash === null ? "initial_compile" : "handler_change";

      // Unload if we have a loaded sandbox.
      if (loadedSandbox !== null) {
        await autoSaveState();
        const t0 = performance.now();
        try {
          jsSandbox = await loadedSandbox.unload();
          loadedSandbox = null;
        } catch {
          invalidateSandbox();
          const t1 = performance.now();
          await initializeSandbox();
          timing.initMs += Math.round(performance.now() - t1);
        }
        timing.setupMs = Math.round(performance.now() - t0);
      }

      // Register ALL cached modules FIRST, then handlers.
      // Modules must be registered before handlers because handlers
      // may import from them. Registration order among modules
      // doesn't matter — the guest runtime resolves lazily.
      // JSDoc is stripped to preserve line numbers in runtime errors.
      const t0 = performance.now();
      try {
        jsSandbox.clearModules();
        for (const [name, entry] of moduleCache) {
          jsSandbox.addModule(name, stripJsdoc(entry.source), MODULE_NAMESPACE);
        }
        jsSandbox.clearHandlers();
        for (const [name, entry] of handlerCache) {
          jsSandbox.addHandler(name, entry.code);
        }
      } catch (err) {
        invalidateSandbox();
        return { success: false, error: `Setup error: ${err.message}` };
      }
      timing.setupMs += Math.round(performance.now() - t0);

      // Compile & load all handlers.
      const t1 = performance.now();
      try {
        loadedSandbox = await jsSandbox.getLoadedSandbox();
        jsSandbox = null; // consumed
      } catch (err) {
        invalidateSandbox();

        // Detect the specific "handler is undefined" error.
        // This happens when the code compiles but doesn't define `function handler`.
        // The raw error is: FromJs { from: "undefined", to: "function" }
        const msg = err.message || String(err);
        if (/undefined.*function|FromJs/i.test(msg)) {
          // Try to identify which handler(s) are problematic by checking each one
          const handlerNames = [...handlerCache.keys()];
          let problematicHandlers = [];

          // Check if error message mentions a specific handler file
          for (const name of handlerNames) {
            if (msg.includes(name) || msg.includes(`${name}.js`)) {
              problematicHandlers.push(name);
            }
          }

          // If we couldn't identify from error, list all non-internal handlers
          if (problematicHandlers.length === 0) {
            problematicHandlers = handlerNames.filter(
              (n) => !n.startsWith("_"),
            );
          }

          const handlerList =
            problematicHandlers.length === 1
              ? `Handler "${problematicHandlers[0]}"`
              : `One of: ${problematicHandlers.join(", ")}`;

          // Extract JS exception details if present (message + stack trace)
          const exceptionMatch = msg.match(
            /message:\s*Some\(\s*"([^"]+)"\s*\)/,
          );
          const stackMatch = msg.match(/stack:\s*Some\(\s*"([^"]+)"\s*\)/);
          const jsMessage = exceptionMatch ? exceptionMatch[1] : null;
          const jsStack = stackMatch
            ? stackMatch[1].replace(/\\n/g, "\n")
            : null;

          let errorMsg = `Compilation failed: ${handlerList} did not define a valid handler function.\n`;

          if (jsMessage || jsStack) {
            // We have a real JS error - show it prominently
            errorMsg += `\nJavaScript error: ${jsMessage || "(no message)"}\n`;
            if (jsStack) {
              errorMsg += `Stack trace:\n${jsStack}\n`;
            }
          } else {
            // Generic case - give guidance
            errorMsg +=
              `\nThe sandbox expected \`function handler(event) { ... }\` but got undefined.\n` +
              `Common causes:\n` +
              `  - Syntax error preventing the function from being defined\n` +
              `  - Runtime error during module initialization\n` +
              `  - Function named something other than "handler"\n`;
          }

          errorMsg += `\nUse get_handler_source("${problematicHandlers[0]}") to inspect the code.`;

          return {
            success: false,
            error: errorMsg,
          };
        }
        // Detect "Error resolving module 'host:XXX'" — plugin not registered.
        // This happens when a plugin is "enabled" but its register() threw
        // (e.g. no allowedDomains for fetch). Give the LLM actionable guidance.
        const moduleMatch = msg.match(/resolving module '(host:\S+)'/);
        if (moduleMatch) {
          const moduleName = moduleMatch[1];
          const pluginName = moduleName.replace("host:", "");
          const failedInfo = lastFailedPluginRegistrations.find((f) =>
            f.startsWith(pluginName),
          );
          const reason = failedInfo
            ? `Registration failed: ${failedInfo}`
            : `The "${pluginName}" plugin may not be properly configured.`;
          return {
            success: false,
            error:
              `Plugin module ${moduleName} is not available. ${reason}\n` +
              `Fix: call manage_plugin({action:"enable", name:"${pluginName}", ` +
              `config:{...}}) with the required configuration, or use apply_profile ` +
              `with pluginConfig to set the missing fields.`,
          };
        }
        // Detect MMIO / unmapped address errors — these indicate VM memory
        // exhaustion at the hypervisor level (e.g. too many handlers for the
        // configured scratch size). Give the LLM clear stop-and-reduce guidance.
        if (
          /mmio|unmapped address|physical memory|dispatch guest call/i.test(msg)
        ) {
          return {
            success: false,
            error:
              `VM memory exhaustion during compilation: ${msg}\n` +
              `The ${handlerCache.size} registered handlers exceed the VM's memory capacity.`,
            llmInstruction:
              "STOP. The VM ran out of physical memory while compiling handlers. " +
              "Do NOT retry. Reduce the number of handlers by deleting unused ones " +
              "(delete_handler), or increase scratch memory (/set scratch <mb>). " +
              "Present the user with these options and WAIT for their choice.",
          };
        }
        return { success: false, error: `Compilation error: ${msg}` };
      }
      timing.compileMs = Math.round(performance.now() - t1);

      // Snapshot for timeout recovery.
      const t2 = performance.now();
      try {
        currentSnapshot = await loadedSandbox.snapshot();
      } catch (err) {
        invalidateSandbox();
        return { success: false, error: `Snapshot error: ${err.message}` };
      }
      timing.snapshotMs = Math.round(performance.now() - t2);

      compiledHandlersHash = currentHash;
      statePreserved = false;

      // Auto-restore shared state after recompile if we have a stash.
      if (verbose) {
        console.error(
          `[sandbox] executeJavaScript: after recompile, checking for state restore... ` +
            `savedSharedState=${savedSharedState !== null ? `Map(${savedSharedState.size})` : "null"}`,
        );
      }
      if (savedSharedState !== null && (await autoRestoreState())) {
        // Re-snapshot to include restored state in crash recovery.
        try {
          currentSnapshot = await loadedSandbox.snapshot();
        } catch {
          // Non-fatal — worst case, crash recovery loses shared-state
        }
        statePreserved = true;
        // Guest state now matches host stash — clear stale flag.
        guestStateStale = false;
        if (verbose) {
          console.error(
            "[sandbox] executeJavaScript: statePreserved=true after restore, guestStateStale cleared",
          );
        }
      } else if (verbose) {
        console.error(
          "[sandbox] executeJavaScript: NO state restore (savedSharedState=" +
            (savedSharedState === null
              ? "null"
              : `Map(${savedSharedState.size})`) +
            ")",
        );
      }
      // If restore failed, autoRestoreState already cleared the stash
    }

    // ── Execute the named handler ────────────────────────────
    const effectiveCpuTimeout = overrides.cpuTimeoutMs ?? config.cpuTimeoutMs;
    const effectiveWallTimeout =
      overrides.wallClockTimeoutMs ?? config.wallClockTimeoutMs;

    const execStart = performance.now();
    try {
      const result = await loadedSandbox.callHandler(handlerName, event, {
        cpuTimeoutMs: effectiveCpuTimeout,
        wallClockTimeoutMs: effectiveWallTimeout,
      });
      timing.executeMs = Math.round(performance.now() - execStart);
      timing.totalMs = Math.round(performance.now() - totalStart);
      writeTiming(timing);

      const stats = extractCallStats(loadedSandbox);

      // Auto-save shared state after every successful public handler execution.
      // Skip internal handlers (prefixed _) to avoid recursion from our own
      // save/restore operations and to keep execution stats clean.
      if (!handlerName.startsWith("_")) {
        await autoSaveState();
      }

      return {
        success: true,
        result,
        consoleOutput: drainConsoleOutput(),
        stats,
        statePreserved,
        timing,
      };
    } catch (err) {
      const consoleOutput = drainConsoleOutput();
      const stats = extractCallStats(loadedSandbox);

      // ── Error classification ───────────────────────────────
      let error;
      let llmInstruction = "";
      if (err.code === "ERR_CANCELLED") {
        error =
          `Execution timed out — CPU limit: ${effectiveCpuTimeout}ms, ` +
          `wall-clock limit: ${effectiveWallTimeout}ms.`;
        llmInstruction =
          "STOP. Do NOT retry or optimise yet. " +
          "Present the user with these two options and WAIT for their choice: " +
          "(1) optimise the code to use less CPU, or " +
          "(2) increase limits with /timeout cpu <ms> or /timeout wall <ms>. " +
          "Do NOT pick an option yourself.";
      } else if (
        err.message &&
        /out of memory|out of physical memory|heap|stack overflow|guest aborted|mmio|unmapped address/i.test(
          err.message,
        )
      ) {
        error = `Memory error: ${err.message}.`;
        llmInstruction =
          "STOP. Do NOT retry or optimise yet. " +
          'If the error mentions "Out of physical memory" or "Guest aborted: 13", ' +
          "the scratch setting (/set scratch <mb>) almost certainly needs increasing. " +
          "Present the user with these two options and WAIT for their choice: " +
          "(1) optimise the code to use less memory, or " +
          "(2) increase limits with /set heap <mb> or /set scratch <mb>. " +
          "Do NOT pick an option yourself.";
      } else if (
        err.message &&
        /output.*data|output.*size|output.*buffer|output.*too.*large/i.test(
          err.message,
        )
      ) {
        // Output buffer overflow — return value too large for the configured buffer
        const currentOutputKb = outputBufferOverrideKb ?? config.outputBufferKb;
        error =
          `Output buffer overflow: The handler's return value exceeds the ${currentOutputKb}KB output buffer. ` +
          `This typically happens when returning large binary data (e.g., a 500KB PPTX file with JSON encoding overhead).`;
        llmInstruction =
          "STOP. The return value is too large for the output buffer. " +
          "FIX: Use configure_sandbox({ outputBuffer: <larger_kb> }) to increase the output buffer size. " +
          `Current size: ${currentOutputKb}KB. Try doubling it (e.g., outputBuffer: ${currentOutputKb * 2}). ` +
          "Alternatively, consider writing large data directly to a file instead of returning it.";
      } else {
        error = `Runtime error: ${err.message}`;
        // Detect "not a function" errors — usually means calling a method that doesn't exist
        if (/not a function/i.test(err.message)) {
          llmInstruction =
            "The code called a method or function that does not exist. " +
            "This is NOT a handler naming issue. " +
            "Call module_info(name, fn) to check the actual API before retrying.";
        }
      }

      // ── Attempt recovery ───────────────────────────────────
      try {
        if (loadedSandbox && loadedSandbox.poisoned && currentSnapshot) {
          await loadedSandbox.restore(currentSnapshot);
          // Mark guest state as stale — the restored snapshot doesn't include
          // state changes from the execution that just failed. The host-side
          // stash (savedSharedState) has the latest good state from the last
          // successful execution. Don't let autoSaveState overwrite it.
          guestStateStale = true;
          if (verbose) {
            console.error(
              "[sandbox] crash recovery: restored from snapshot, marked guest state as STALE",
            );
          }
        }
      } catch {
        invalidateSandbox();
      }

      timing.executeMs = Math.round(performance.now() - execStart);
      timing.totalMs = Math.round(performance.now() - totalStart);
      writeTiming(timing);

      return {
        success: false,
        error,
        llmInstruction,
        consoleOutput,
        stats,
        // Use the actual statePreserved value from execution context.
        // Runtime errors do NOT cause sandbox rebuilds, so state IS preserved.
        // Bug: was hardcoded to false, causing LLM to unnecessarily re-download data.
        statePreserved,
        timing,
      };
    }
  }

  // ── Sandbox Lifecycle ────────────────────────────────────────

  /**
   * Reset sandbox state — keeps handler cache, clears compiled
   * state and module-level variables. Handlers auto-recompile
   * on next execute (but state starts fresh).
   *
   * @returns {Promise<{success: boolean, message?: string, error?: string, handlers?: string[]}>}
   */
  async function resetSandbox() {
    const release = await acquireLock();
    try {
      // Auto-save shared state before tearing down.
      await autoSaveState();
      if (loadedSandbox !== null) {
        try {
          jsSandbox = await loadedSandbox.unload();
          loadedSandbox = null;
        } catch {
          // Unload failed — full teardown.
          jsSandbox = null;
          loadedSandbox = null;
        }
      }
      compiledHandlersHash = null;
      currentSnapshot = null;
      if (jsSandbox) {
        jsSandbox.clearHandlers();
      }
      return {
        success: true,
        message:
          "Sandbox state reset — handlers preserved, shared-state auto-preserved",
        handlers: publicHandlerNames(),
      };
    } catch (err) {
      invalidateSandbox();
      return { success: false, error: `Reset failed: ${err.message}` };
    } finally {
      release();
    }
  }

  // ── Logging Helpers ──────────────────────────────────────────

  /**
   * Append a JSON timing record to the timing log file (if configured).
   * Best-effort — logging failures never break execution.
   *
   * @param {Record<string, number>} timing
   */
  function writeTiming(timing) {
    if (!config.timingLogPath) return;
    try {
      appendFileSync(config.timingLogPath, JSON.stringify(timing) + "\n");
    } catch {
      console.error("[hyperlight] Warning: failed to write timing log");
    }
  }

  /**
   * Append executed code to the code log file (if configured).
   * Best-effort — logging failures never break execution.
   *
   * @param {string} code — JavaScript source that was executed
   */
  function writeCode(code) {
    if (!config.codeLogPath) return;
    try {
      appendFileSync(config.codeLogPath, code);
    } catch {
      console.error("[hyperlight] Warning: failed to write code log");
    }
  }

  // ── Public API ───────────────────────────────────────────────

  // ── Plugin Management ──────────────────────────────────────

  /**
   * Set the active plugins for the sandbox. Forces a rebuild on
   * the next executeJavaScript() call so the new host functions
   * are available to guest code.
   *
   * @param {PluginRegistration[]} plugins — Array of plugin registrations
   */
  async function setPlugins(plugins) {
    if (verbose) {
      const stashBefore = savedSharedState ? savedSharedState.size : 0;
      console.error(
        `[sandbox] setPlugins: called with ${plugins.length} plugins, stash has ${stashBefore} keys before invalidate`,
      );
    }
    activePlugins = plugins;
    // Force full sandbox rebuild — plugins are registered at build time.
    // This clears loadedSandbox, code hash, and snapshot too.
    // IMPORTANT: Save shared-state first so it survives the rebuild!
    await invalidateSandboxWithSave();
    if (verbose) {
      const stashAfter = savedSharedState ? savedSharedState.size : 0;
      console.error(
        `[sandbox] setPlugins: after invalidate, stash has ${stashAfter} keys`,
      );
    }
  }

  // ── Buffer Management ─────────────────────────────────────

  /**
   * Update buffer sizes and force a sandbox rebuild on the next call.
   * Pass undefined for either parameter to leave it unchanged.
   *
   * Buffer sizes are set at sandbox build time — changing them
   * requires a fresh micro-VM. The rebuild happens lazily on the
   * next executeJavaScript() invocation.
   *
   * @param {number|undefined} inputKb  — New input buffer size (KB), or undefined
   * @param {number|undefined} outputKb — New output buffer size (KB), or undefined
   */
  async function setBufferSizes(inputKb, outputKb) {
    if (inputKb !== undefined) {
      if (inputKb < MIN_BUFFER_KB) {
        console.error(
          `[hyperlight] Warning: input buffer ${inputKb}KB below minimum ` +
            `(${MIN_BUFFER_KB}KB) — host will clamp to ${MIN_BUFFER_KB}KB`,
        );
      }
      inputBufferOverrideKb = inputKb;
    }
    if (outputKb !== undefined) {
      if (outputKb < MIN_BUFFER_KB) {
        console.error(
          `[hyperlight] Warning: output buffer ${outputKb}KB below minimum ` +
            `(${MIN_BUFFER_KB}KB) — host will clamp to ${MIN_BUFFER_KB}KB`,
        );
      }
      outputBufferOverrideKb = outputKb;
    }
    // Force sandbox rebuild on next call
    // IMPORTANT: Save shared-state first so it survives the rebuild!
    await invalidateSandboxWithSave();
  }

  /**
   * Reset buffer sizes to config defaults and force a rebuild.
   */
  async function resetBufferSizes() {
    inputBufferOverrideKb = null;
    outputBufferOverrideKb = null;
    await invalidateSandboxWithSave();
  }

  /**
   * Get the effective buffer sizes (accounting for overrides).
   * @returns {{ inputKb: number, outputKb: number }}
   */
  function getEffectiveBufferSizes() {
    return {
      inputKb: inputBufferOverrideKb ?? config.inputBufferKb,
      outputKb: outputBufferOverrideKb ?? config.outputBufferKb,
    };
  }

  // ── Memory Management ─────────────────────────────────────

  /**
   * Update heap and/or scratch sizes and force a sandbox rebuild.
   * Pass undefined for either parameter to leave it unchanged.
   *
   * Like buffers, memory sizes are set at sandbox build time —
   * changing them requires a fresh micro-VM.
   *
   * @param {number|undefined} heapMb    — New heap size (MB), or undefined
   * @param {number|undefined} scratchMb — New scratch size (MB), or undefined
   */
  async function setMemorySizes(heapMb, scratchMb) {
    const MIN_HEAP_MB = 1;
    const MIN_SCRATCH_MB = 3;
    if (heapMb !== undefined) {
      if (heapMb < MIN_HEAP_MB) {
        console.error(
          `[hyperlight] Warning: heap ${heapMb}MB below minimum ` +
            `(${MIN_HEAP_MB}MB) — clamping to ${MIN_HEAP_MB}MB`,
        );
        heapMb = MIN_HEAP_MB;
      }
      heapOverrideMb = heapMb;
    }
    if (scratchMb !== undefined) {
      if (scratchMb < MIN_SCRATCH_MB) {
        console.error(
          `[hyperlight] Warning: scratch ${scratchMb}MB below minimum ` +
            `(${MIN_SCRATCH_MB}MB) — clamping to ${MIN_SCRATCH_MB}MB`,
        );
        scratchMb = MIN_SCRATCH_MB;
      }
      scratchOverrideMb = scratchMb;
    }
    // Force sandbox rebuild on next call
    // IMPORTANT: Save shared-state first so it survives the rebuild!
    await invalidateSandboxWithSave();
  }

  /**
   * Reset heap and scratch sizes to config defaults and force a rebuild.
   */
  async function resetMemorySizes() {
    heapOverrideMb = null;
    scratchOverrideMb = null;
    await invalidateSandboxWithSave();
  }

  /**
   * Get the effective memory sizes (accounting for overrides).
   * @returns {{ heapMb: number, scratchMb: number }}
   */
  function getEffectiveMemorySizes() {
    return {
      heapMb: heapOverrideMb ?? config.heapSizeMb,
      scratchMb: scratchOverrideMb ?? config.scratchSizeMb,
    };
  }

  return Object.freeze({
    config,
    initializeSandbox,
    registerHandler,
    deleteHandler,
    getHandlerSource,
    editHandler,
    registerModule,
    deleteModule: deleteModule,
    setModules,
    getModuleNames,
    getHandlers,
    getAvailableModules,
    executeJavaScript,
    resetSandbox,
    writeTiming,
    writeCode,
    setPlugins,
    setBufferSizes,
    resetBufferSizes,
    getEffectiveBufferSizes,
    setMemorySizes,
    resetMemorySizes,
    getEffectiveMemorySizes,
  });
}
