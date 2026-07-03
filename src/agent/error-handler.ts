// ── agent/error-handler.ts — SDK onErrorOccurred hook ────────────────
//
// Structured error recovery using the SDK's hook system instead of
// raw try/catch. Returns { errorHandling, retryCount, userNotification }
// so the SDK handles retry/skip/abort logic and the user sees
// human-readable messages instead of raw stack traces.
//
// ─────────────────────────────────────────────────────────────────────

// ── Types ────────────────────────────────────────────────────────────
// These mirror the SDK's internal ErrorOccurredHookInput/Output types
// from types.d.ts. They aren't re-exported from the SDK's public
// barrel (index.d.ts), so we define them locally to stay type-safe
// without reaching into node_modules internals.

/**
 * Input provided to the onErrorOccurred hook by the SDK.
 *
 * Declared as a minimal structural subset of the SDK's ErrorOccurredHookInput
 * (which extends BaseHookInput) — only the fields this handler reads. Keeping it
 * a subset means the handler stays assignable to ErrorOccurredHandler as the SDK
 * evolves surrounding fields (e.g. 1.0.5 dropped the previously-present
 * `cwd`/`timestamp`).
 */
interface ErrorOccurredHookInput {
  /** Human-readable error description. */
  error: string;
  /** Where the error occurred: model call, tool execution, etc. */
  errorContext: "model_call" | "tool_execution" | "system" | "user_input";
  /** Whether the SDK considers this error recoverable. */
  recoverable: boolean;
}

/** Output returned from the onErrorOccurred hook to tell the SDK what to do. */
interface ErrorOccurredHookOutput {
  /** Whether to suppress the default error display. */
  suppressOutput?: boolean;
  /** How the SDK should handle the error. */
  errorHandling?: "retry" | "skip" | "abort";
  /** Maximum retries (only meaningful with errorHandling: "retry"). */
  retryCount?: number;
  /** Human-readable notification to show the user. */
  userNotification?: string;
}

/**
 * Regex pattern for sandbox memory-related errors.
 * Matches OOM, heap overflow, stack overflow, and guest abort signals
 * from the Hyperlight micro-VM. Note: "stack overflow" is an error
 * symptom — the user-facing config is "scratch" (which includes the stack).
 */
const MEMORY_ERROR_PATTERN =
  /out of memory|out of physical memory|heap|stack overflow|guest aborted|allocation failed/i;

/**
 * Maximum number of automatic retries for recoverable model errors.
 * Keeps the agent moving without infinite loops.
 */
const MODEL_RETRY_LIMIT = 2;

/**
 * Maximum retries for tool execution memory errors.
 * One retry with potentially smaller input is usually enough.
 */
const TOOL_MEMORY_RETRY_LIMIT = 1;

/**
 * Build the onErrorOccurred hook handler.
 *
 * Uses a factory so we can inject config (heap size, timeout values)
 * without the hook needing to know about sandbox internals.
 *
 * @param getHeapMb — Callback returning current heap size in MB
 */
export function createErrorHandler(
  getHeapMb: () => number,
): (input: ErrorOccurredHookInput) => ErrorOccurredHookOutput | undefined {
  return (
    input: ErrorOccurredHookInput,
  ): ErrorOccurredHookOutput | undefined => {
    const { error, errorContext, recoverable } = input;

    // ── Sandbox memory errors ──────────────────────────────────
    // When the guest VM runs out of heap/scratch, suggest a concrete
    // fix rather than dumping a cryptic error.
    if (errorContext === "tool_execution" && MEMORY_ERROR_PATTERN.test(error)) {
      const heapMb = getHeapMb();
      return {
        errorHandling: recoverable ? "retry" : "skip",
        retryCount: TOOL_MEMORY_RETRY_LIMIT,
        userNotification:
          `⚠️  The code ran out of memory (current heap: ${heapMb}MB). ` +
          `If the error mentions "Out of physical memory", increase scratch with /set scratch <MB>. ` +
          `For general OOM, use /set heap <MB> to increase heap. ` +
          `Or try breaking it into smaller pieces.`,
      };
    }

    // ── Model call errors (rate limits, transient failures) ────
    // Retry recoverable model errors transparently. The user sees
    // a brief "retrying" notice instead of the raw API error.
    if (errorContext === "model_call" && recoverable) {
      return {
        errorHandling: "retry",
        retryCount: MODEL_RETRY_LIMIT,
        userNotification: "🔄 Model hiccup — retrying…",
      };
    }

    // ── System errors (session corruption, CLI crashes) ────────
    // These are usually unrecoverable — abort cleanly and tell the
    // user what to do next.
    if (errorContext === "system") {
      return {
        errorHandling: "abort",
        userNotification: `❌ System error: ${error}. Use /new to start a fresh session.`,
      };
    }

    // ── Default: let the SDK decide ────────────────────────────
    // For unknown error contexts or non-recoverable errors we
    // haven't specifically handled, return undefined so the SDK
    // applies its own default behaviour.
    return undefined;
  };
}
