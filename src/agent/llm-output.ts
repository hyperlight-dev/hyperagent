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

// ── Model Pricing ────────────────────────────────────────────────────
//
// List-price rates per million tokens for supported models.
// Rates are matched by prefix — the first matching entry wins.
// Add new models by inserting a new entry; order matters (longest
// prefix first for specificity).

/** Per-million-token rates for a model tier. */
export interface ModelPricing {
  /** Human-readable label for the pricing tier. */
  label: string;
  /** Input (non-cached) tokens — $/MTok. */
  inputPerMTok: number;
  /** Output tokens — $/MTok. */
  outputPerMTok: number;
  /** Cache-read tokens — $/MTok (0 if caching not supported). */
  cacheReadPerMTok: number;
  /** Cache-write tokens — $/MTok (0 if caching not supported). */
  cacheWritePerMTok: number;
}

/**
 * Pricing table keyed by model-name prefix. Checked in order — first
 * match wins. Keep entries ordered from most-specific to least-specific
 * within each vendor group.
 */
const MODEL_PRICING: Array<{ prefix: string; pricing: ModelPricing }> = [
  // ── Anthropic Claude ────────────────────────────────────────
  {
    prefix: "claude-opus",
    pricing: {
      label: "Claude Opus",
      inputPerMTok: 15,
      outputPerMTok: 75,
      cacheReadPerMTok: 1.875,
      cacheWritePerMTok: 18.75,
    },
  },
  {
    prefix: "claude-sonnet",
    pricing: {
      label: "Claude Sonnet",
      inputPerMTok: 3,
      outputPerMTok: 15,
      cacheReadPerMTok: 0.3,
      cacheWritePerMTok: 3.75,
    },
  },
  {
    prefix: "claude-haiku",
    pricing: {
      label: "Claude Haiku",
      inputPerMTok: 0.8,
      outputPerMTok: 4,
      cacheReadPerMTok: 0.08,
      cacheWritePerMTok: 1,
    },
  },
  // ── OpenAI ──────────────────────────────────────────────────
  {
    prefix: "o1",
    pricing: {
      label: "OpenAI o1",
      inputPerMTok: 15,
      outputPerMTok: 60,
      cacheReadPerMTok: 7.5,
      cacheWritePerMTok: 0,
    },
  },
  {
    prefix: "o3",
    pricing: {
      label: "OpenAI o3",
      inputPerMTok: 10,
      outputPerMTok: 40,
      cacheReadPerMTok: 2.5,
      cacheWritePerMTok: 0,
    },
  },
  {
    prefix: "gpt-4.1",
    pricing: {
      label: "GPT-4.1",
      inputPerMTok: 2,
      outputPerMTok: 8,
      cacheReadPerMTok: 0.5,
      cacheWritePerMTok: 0,
    },
  },
  {
    prefix: "gpt-4o",
    pricing: {
      label: "GPT-4o",
      inputPerMTok: 2.5,
      outputPerMTok: 10,
      cacheReadPerMTok: 1.25,
      cacheWritePerMTok: 0,
    },
  },
  // ── Google Gemini ───────────────────────────────────────────
  {
    prefix: "gemini-2.5-pro",
    pricing: {
      label: "Gemini 2.5 Pro",
      inputPerMTok: 1.25,
      outputPerMTok: 10,
      cacheReadPerMTok: 0.315,
      cacheWritePerMTok: 0,
    },
  },
  {
    prefix: "gemini-2.5-flash",
    pricing: {
      label: "Gemini 2.5 Flash",
      inputPerMTok: 0.15,
      outputPerMTok: 0.6,
      cacheReadPerMTok: 0.0375,
      cacheWritePerMTok: 0,
    },
  },
];

/**
 * Look up pricing for a model by name prefix.
 * Matches against known model prefixes, requiring a word boundary
 * (end-of-string or '-') after the prefix to avoid misclassification.
 * Returns undefined if no matching pricing tier is found.
 */
export function getModelPricing(
  modelName: string | undefined,
): ModelPricing | undefined {
  if (!modelName) return undefined;
  const lower = modelName.toLowerCase();
  return MODEL_PRICING.find((entry) => {
    if (!lower.startsWith(entry.prefix)) return false;
    // Require word boundary after prefix: end-of-string or '-'
    const afterPrefix = lower[entry.prefix.length];
    return afterPrefix === undefined || afterPrefix === "-";
  })?.pricing;
}

/**
 * Calculate the estimated cost in USD for a set of token counts.
 * The inputTokens parameter should be non-cached input only (total
 * input minus cache reads) to avoid double-counting.
 */
export function estimateCost(
  pricing: ModelPricing,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
): number {
  const MILLION = 1_000_000;
  return (
    (inputTokens / MILLION) * pricing.inputPerMTok +
    (outputTokens / MILLION) * pricing.outputPerMTok +
    (cacheReadTokens / MILLION) * pricing.cacheReadPerMTok +
    (cacheWriteTokens / MILLION) * pricing.cacheWritePerMTok
  );
}

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
  // Estimated cost for this request based on model pricing
  const pricing = getModelPricing(d.model);
  if (pricing) {
    // Subtract cache reads from input to avoid double-counting —
    // inputTokens typically includes the cached portion.
    const nonCachedInput = Math.max(
      0,
      (d.inputTokens ?? 0) - (d.cacheReadTokens ?? 0),
    );
    const reqCost = estimateCost(
      pricing,
      nonCachedInput,
      d.outputTokens ?? 0,
      d.cacheReadTokens ?? 0,
      d.cacheWriteTokens ?? 0,
    );
    if (reqCost > 0) {
      parts.push(
        `~$${reqCost < 0.01 ? reqCost.toFixed(4) : reqCost.toFixed(2)}`,
      );
    }
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
  totalCacheWriteTokens: number;
  totalRequests: number;
  totalTurns: number;
  currentModel?: string;
}): string[] {
  const total = state.totalInputTokens + state.totalOutputTokens;
  const lines: string[] = [];
  lines.push(`${C.label("Token Usage")}  ${C.dim("(process total)")}`);
  lines.push(`Input:       ${state.totalInputTokens.toLocaleString()} tokens`);
  lines.push(`Output:      ${state.totalOutputTokens.toLocaleString()} tokens`);
  if (state.totalCacheReadTokens > 0) {
    lines.push(
      `Cache read:  ${state.totalCacheReadTokens.toLocaleString()} tokens`,
    );
  }
  if (state.totalCacheWriteTokens > 0) {
    lines.push(
      `Cache write: ${state.totalCacheWriteTokens.toLocaleString()} tokens`,
    );
  }
  lines.push(`Total:       ${total.toLocaleString()} tokens`);
  lines.push(`Requests:    ${state.totalRequests}`);
  lines.push(`Turns:       ${state.totalTurns}`);

  // Estimated session cost based on model list pricing
  const pricing = getModelPricing(state.currentModel);
  if (pricing) {
    // Compute non-cached input: total input minus cache reads
    const nonCachedInput = Math.max(
      0,
      state.totalInputTokens - state.totalCacheReadTokens,
    );
    const sessionCost = estimateCost(
      pricing,
      nonCachedInput,
      state.totalOutputTokens,
      state.totalCacheReadTokens,
      state.totalCacheWriteTokens,
    );
    lines.push("");
    lines.push(
      `${C.label("Est. Cost")}    ~$${sessionCost.toFixed(2)} ${C.dim(`(${pricing.label} list pricing)`)}`,
    );

    // Show what it would have cost without caching
    if (state.totalCacheReadTokens > 0) {
      const noCacheCost = estimateCost(
        pricing,
        state.totalInputTokens,
        state.totalOutputTokens,
        0,
        0,
      );
      const saved = noCacheCost - sessionCost;
      if (saved > 0.01) {
        lines.push(
          `${C.dim(`Cache saved:  ~$${saved.toFixed(2)} (${((saved / noCacheCost) * 100).toFixed(0)}% reduction)`)}`,
        );
      }
    }
  }

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
