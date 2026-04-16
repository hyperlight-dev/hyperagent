// ── agent/llm-output.ts — Shared LLM output rendering ───────────────
//
// Centralised rendering for LLM events (reasoning deltas, usage stats,
// SDK bug dead-zone notices) used by BOTH the main session event
// handler (agent.ts) and the audit progress callback (audit-progress).
//
// By putting the rendering logic in one place, the main session and
// audit sessions behave consistently — same formatting, same verbose
// toggle, same dead-zone messaging.
// ─────────────────────────────────────────────────────────────────────

import type { Spinner } from "./spinner.js";
import { ANSI, C } from "./ansi.js";

// ── Constants ────────────────────────────────────────────────────────

// ── Usage Stats ──────────────────────────────────────────────────────

/** Shape of assistant.usage event data. */
export interface UsageData {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost?: number;
  duration?: number;
}

/**
 * Format usage stats into a compact "N in / N out · cache: N read · N req · Ns"
 * string. Returns null if there's nothing to show.
 */
export function formatUsageStats(d: UsageData): string | null {
  const parts: string[] = [];
  if (d.inputTokens !== undefined || d.outputTokens !== undefined) {
    parts.push(`${d.inputTokens ?? 0} in / ${d.outputTokens ?? 0} out`);
  }
  if (d.cacheReadTokens) {
    parts.push(`cache: ${d.cacheReadTokens} read`);
  }
  // The SDK cost field represents premium request count
  // (typically 1 per API call), not a dollar amount.
  if (d.cost !== undefined && d.cost > 0) {
    parts.push(`${d.cost} req`);
  }
  if (d.duration !== undefined) {
    parts.push(`${(d.duration / 1000).toFixed(1)}s`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * Print a usage stats line to the console with the 📊 icon.
 *
 * @param stats - Formatted stats string from `formatUsageStats()`
 * @param indent - Leading whitespace (differs between main "  " and audit "     ")
 */
export function printUsageStats(stats: string, indent: string): void {
  console.log(`${indent}${C.dim("📊 " + stats)}`);
}

/**
 * Format a session token summary for /tokens command or exit display.
 * Returns an array of lines (without leading newline).
 */
export function formatTokenSummary(state: {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalRequests: number;
  totalTurns: number;
}): string[] {
  const total = state.totalInputTokens + state.totalOutputTokens;
  const lines: string[] = [];
  lines.push(`${C.label("Token Usage")}  ${C.dim("(session total)")}`);
  lines.push(
    `  Input:       ${state.totalInputTokens.toLocaleString()} tokens`,
  );
  lines.push(
    `  Output:      ${state.totalOutputTokens.toLocaleString()} tokens`,
  );
  if (state.totalCacheReadTokens > 0) {
    lines.push(
      `  Cache read:  ${state.totalCacheReadTokens.toLocaleString()} tokens`,
    );
  }
  lines.push(`  Total:       ${total.toLocaleString()} tokens`);
  lines.push(`  Requests:    ${state.totalRequests}`);
  lines.push(`  Turns:       ${state.totalTurns}`);
  return lines;
}

// ── Reasoning Rendering ──────────────────────────────────────────────

/**
 * Render a reasoning delta to the terminal.
 *
 * Verbose mode: prints inline — text scrolls freely through the terminal.
 * Compact mode: feeds the spinner's second-line reasoning preview.
 *
 * @param spinner - The shared Spinner instance
 * @param delta - The reasoning text chunk from the model
 * @param verbose - Whether verbose output mode is enabled
 */
export function renderReasoningDelta(
  spinner: Spinner,
  delta: string,
  verbose: boolean,
): void {
  if (!verbose) {
    spinner.start("Reasoning...");
    spinner.appendReasoning(delta);
  } else {
    spinner.stop();
    process.stdout.write(`${ANSI.dim}${ANSI.italic}${delta}${ANSI.reset}`);
  }
}

/**
 * Render the reasoning→response transition.
 *
 * In verbose mode, reasoning deltas are printed inline with no trailing
 * newline — the cursor sits at the end of the last reasoning text.
 * This function emits a newline to preserve that text, then prints
 * a "Reasoning complete" separator.
 *
 * In compact mode, the spinner is just stopped and restarted.
 *
 * @param spinner - The shared Spinner instance
 * @param verbose - Whether verbose output mode is enabled
 * @param indent - Leading whitespace for the separator line
 */
export function renderReasoningTransition(
  spinner: Spinner,
  verbose: boolean,
  indent: string,
): void {
  if (verbose) {
    // Newline to end the last reasoning line, then separator
    process.stdout.write(`${ANSI.reset}\n`);
  }
  spinner.stop();
  console.log(`${indent}✅ Reasoning complete`);
  spinner.resetTurnStart();
  spinner.start("Generating response...");
}

// ── Extended Reasoning Notice ────────────────────────────────────────

/**
 * Print a one-time notice when the model enters an extended reasoning
 * phase — multiple continuation API calls producing usage events but
 * no streamed content. Some models use opaque (encrypted) reasoning
 * at certain effort levels — this is model-specific, not a bug.
 * Output will arrive when the reasoning chain completes.
 *
 * @param indent - Leading whitespace
 */
export function printExtendedReasoningNotice(indent: string): void {
  console.log(
    `${indent}${C.dim("\u23f3 Extended reasoning in progress (model is using opaque multi-step reasoning)")}`,
  );
}
