/**
 * Parse a positive integer from a raw value (typically an env var),
 * falling back to `defaultVal` when the value is unset, empty, or
 * not a valid positive integer.
 *
 * @param {string|number|undefined} raw  — raw value (env var string or number)
 * @param {number}                  defaultVal — fallback
 * @returns {number}
 */
export function parsePositiveInt(
  raw: string | number | undefined,
  defaultVal: number,
): number;
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
 * @property {SandboxToolConfig}                          config
 * @property {() => Promise<void>}                        initializeSandbox
 * @property {(code: string) => Promise<ExecutionResult>} executeJavaScript
 * @property {(timing: Record<string, number>) => void}   writeTiming
 * @property {(code: string) => void}                      writeCode
 */
/**
 * @typedef {object} PluginRegistration
 * @property {string}                          name     — Plugin name (for logging)
 * @property {(proto: object, config: object) => void} register — Registers host functions on the proto
 * @property {Record<string, *>}               config   — Resolved plugin configuration
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
export function createSandboxTool(options?: {
  cpuTimeoutMs?: number | undefined;
  wallClockTimeoutMs?: number | undefined;
  heapSizeMb?: number | undefined;
  scratchSizeMb?: number | undefined;
  inputBufferKb?: number | undefined;
  outputBufferKb?: number | undefined;
  timingLogPath?: string | null | undefined;
  codeLogPath?: string | null | undefined;
  verbose?: boolean | undefined;
}): SandboxTool;
export type SandboxToolConfig = {
  /**
   * — Max CPU time per execution (ms)
   */
  cpuTimeoutMs: number;
  /**
   * — Max wall-clock time per execution (ms)
   */
  wallClockTimeoutMs: number;
  /**
   * — Guest heap size (megabytes)
   */
  heapSizeMb: number;
  /**
   * — Guest heap size (bytes)
   */
  heapSizeBytes: number;
  /**
   * — Guest scratch size (megabytes)
   */
  scratchSizeMb: number;
  /**
   * — Guest scratch size (bytes)
   */
  scratchSizeBytes: number;
  /**
   * — Input buffer size (kilobytes)
   */
  inputBufferKb: number;
  /**
   * — Input buffer size (bytes)
   */
  inputBufferBytes: number;
  /**
   * — Output buffer size (kilobytes)
   */
  outputBufferKb: number;
  /**
   * — Output buffer size (bytes)
   */
  outputBufferBytes: number;
  /**
   * — Path to timing log file, or null
   */
  timingLogPath: string | null;
  /**
   * — Path to code log file, or null
   */
  codeLogPath: string | null;
};
export type ExecutionResult = {
  /**
   * — Whether execution completed without error
   */
  success: boolean;
  /**
   * — Return value from the handler (on success)
   */
  result?: any;
  /**
   * — Human-readable error message (on failure)
   */
  error?: string | undefined;
  /**
   * — Model-only guidance appended to the error for the LLM.
   * Contains instructions like "STOP" or "suggest /set heap".
   * Never shown to the user directly.
   */
  llmInstruction?: string | undefined;
  /**
   * — Execution statistics from the Hyperlight micro-VM.
   * Includes wall-clock time, CPU time (if available), and
   * termination reason (if killed by a monitor).
   */
  stats?: CallStats | null;
  /**
   * — Whether module-level state was preserved from the previous call.
   * true when the same code was executed again without recompilation.
   * false on first call, after code changes, or after reset.
   */
  statePreserved?: boolean;
  /**
   * — Captured console.log/warn/error/info/debug output from the handler.
   * Array of strings (one per print call). Undefined when no output.
   */
  consoleOutput?: string[];
  /**
   * — Timing breakdown (always present)
   */
  timing?: Record<string, number> | undefined;
};
/**
 * Execution statistics from a guest function call.
 * Retrieved from the loaded sandbox after callHandler().
 */
export type CallStats = {
  /** Wall-clock (elapsed) time in milliseconds. Always present. */
  wallClockMs: number;
  /** CPU time in milliseconds. null if not available on this platform. */
  cpuTimeMs: number | null;
  /** Name of the monitor that terminated execution, or null if completed normally. */
  terminatedBy: string | null;
};
/** Result from register_handler / delete_handler operations. */
export type HandlerResult = {
  success: boolean;
  message?: string;
  error?: string;
  /** Names of all currently registered handlers. */
  handlers?: string[];
  timing?: Record<string, number>;
};

export type SandboxTool = {
  config: Readonly<SandboxToolConfig>;
  initializeSandbox: () => Promise<void>;
  registerHandler: (
    name: string,
    code: string,
    options?: { isModule?: boolean },
  ) => Promise<HandlerResult>;
  deleteHandler: (name: string) => Promise<HandlerResult>;
  getHandlerSource: (
    name: string,
    options?: { startLine?: number; endLine?: number; lineNumbers?: boolean },
  ) => {
    success: boolean;
    code?: string;
    totalLines?: number;
    startLine?: number;
    endLine?: number;
    error?: string;
    handlers?: string[];
  };
  editHandler: (
    name: string,
    oldString: string,
    newString: string,
  ) => Promise<{
    success: boolean;
    message?: string;
    error?: string;
    handlers?: string[];
    codeSize?: number;
    contextAfter?: string;
  }>;
  editHandlerLines: (
    name: string,
    startLine: number,
    endLine: number,
    replacement: string,
  ) => Promise<{
    success: boolean;
    message?: string;
    error?: string;
    handlers?: string[];
    codeSize?: number;
    contextAfter?: string;
  }>;
  registerModule: (
    name: string,
    source: string,
  ) => Promise<{
    success: boolean;
    message?: string;
    error?: string;
    modules?: string[];
    sourceSize?: number;
  }>;
  deleteModule: (name: string) => Promise<{
    success: boolean;
    message?: string;
    error?: string;
    modules?: string[];
  }>;
  setModules: (modules: Array<{ name: string; source: string }>) => void;
  getModuleNames: () => string[];
  getHandlers: () => string[];
  getAvailableModules: () => string[];
  executeJavaScript: (
    handlerName: string,
    event?: Record<string, unknown>,
    overrides?: { cpuTimeoutMs?: number; wallClockTimeoutMs?: number },
  ) => Promise<ExecutionResult>;
  resetSandbox: () => Promise<HandlerResult>;
  writeTiming: (timing: Record<string, number>) => void;
  writeCode: (code: string) => void;
  setPlugins: (plugins: PluginRegistration[]) => Promise<void>;
  setBufferSizes: (inputKb?: number, outputKb?: number) => Promise<void>;
  resetBufferSizes: () => Promise<void>;
  getEffectiveBufferSizes: () => { inputKb: number; outputKb: number };
  setMemorySizes: (heapMb?: number, scratchMb?: number) => Promise<void>;
  resetMemorySizes: () => Promise<void>;
  getEffectiveMemorySizes: () => { heapMb: number; scratchMb: number };
};
export type PluginRegistration = {
  /**
   * — Plugin name (for logging)
   */
  name: string;
  /**
   * — Factory function that returns host functions by module name
   */
  createHostFunctions: (
    config: object,
  ) => Record<string, Record<string, (...args: any[]) => any>>;
  /**
   * — Resolved plugin configuration
   */
  config: Record<string, any>;
  /**
   * — Host modules declared in manifest (for verification)
   */
  declaredModules?: string[];
};
