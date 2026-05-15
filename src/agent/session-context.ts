// ── agent/session-context.ts — Session learning summariser ──────────
//
// Extracts a concise, LLM-friendly summary of "what happened in this
// session" from `AgentState`.  The summary is fed back into the LLM
// via the `/save-skill` slash command so the model can author a
// well-grounded SKILL.md instead of guessing.
//
// Design goals:
//   • Bounded output (no transcripts; just structured rollups).
//   • Deterministic ordering so test snapshots stay stable.
//   • Zero side effects — pure function of `AgentState`.
//
// ─────────────────────────────────────────────────────────────────────

import type { AgentState } from "./state.js";

// ── Constants ────────────────────────────────────────────────────────

/**
 * Maximum number of distinct error summaries surfaced in the context.
 * Beyond this the user is unlikely to remember individual failures and
 * the LLM gets enough signal from the leading examples to know that
 * "errors happened repeatedly" — adding more dilutes the prompt.
 */
const MAX_ERRORS_REPORTED = 8;

/**
 * Maximum tool names shown in the leading-tools list.  Keeps the
 * prompt focused on the dominant verbs of the workflow.
 */
const MAX_TOP_TOOLS = 10;

/**
 * Maximum characters of the user's most-recent prompt kept in the
 * session-context summary.  Anything longer is truncated with an
 * ellipsis — the LLM only needs the gist of the original task to
 * anchor the SKILL.md it writes, and a 50-KB paste here would
 * dominate the prompt and crowd out the actual session history.
 */
const MAX_USER_PROMPT_CHARS = 2000;

// ── Types ────────────────────────────────────────────────────────────

/**
 * A summary of the agent's activity in the current conversation,
 * suitable for inclusion in an LLM prompt that asks the model to
 * author a SKILL.md.
 */
export interface SessionContext {
  /**
   * The user's most recent prompt — anchors the LLM on the task the
   * user wants captured.  May be empty in tests or fresh sessions.
   */
  userPrompt: string;
  /**
   * Tool names sorted by call count (descending), each with a count.
   * Capped at `MAX_TOP_TOOLS` to keep the prompt focused.
   */
  topTools: Array<{ tool: string; count: number }>;
  /** MCP server names whose tools the LLM actually invoked. */
  mcpServersUsed: string[];
  /** Module names the LLM registered via register_module. */
  modulesRegistered: string[];
  /**
   * First N distinct error messages (deduplicated by summary text)
   * to give the LLM signal about what dead-ends were hit.
   */
  errorsSeen: string[];
  /** Total number of tool invocations in the bounded history. */
  totalToolCalls: number;
  /** Count of failed tool invocations in the bounded history. */
  failedToolCalls: number;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Build a {@link SessionContext} from the current {@link AgentState}.
 *
 * Pure function — does NOT mutate state.  Safe to call multiple times.
 *
 * @param state - The agent's runtime state (typically `state` in index.ts).
 */
export function extractSessionContext(state: AgentState): SessionContext {
  // Count tool invocations.  Map preserves first-seen order, which we
  // use as a stable tiebreaker when counts are equal.
  const toolCounts = new Map<string, number>();
  const errorSet = new Set<string>();
  let failedToolCalls = 0;

  for (const entry of state.toolCallHistory) {
    toolCounts.set(entry.tool, (toolCounts.get(entry.tool) ?? 0) + 1);
    if (!entry.success) {
      failedToolCalls++;
      if (entry.errorSummary && errorSet.size < MAX_ERRORS_REPORTED) {
        errorSet.add(entry.errorSummary);
      }
    }
  }

  // Convert to sorted array — count descending, then first-seen order.
  const topTools = Array.from(toolCounts.entries())
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_TOP_TOOLS);

  // Truncate the user prompt so a giant paste doesn't dominate the
  // session-context summary.  We keep the head — the leading phrase
  // is the strongest signal of intent.
  const userPrompt =
    state.currentUserPrompt.length > MAX_USER_PROMPT_CHARS
      ? state.currentUserPrompt.slice(0, MAX_USER_PROMPT_CHARS) + "…"
      : state.currentUserPrompt;

  return {
    userPrompt,
    topTools,
    mcpServersUsed: Array.from(state.mcpServersUsed).sort(),
    modulesRegistered: [...state.modulesRegistered].sort(),
    errorsSeen: Array.from(errorSet),
    totalToolCalls: state.toolCallHistory.length,
    failedToolCalls,
  };
}

/**
 * Render a {@link SessionContext} as a markdown block suitable for
 * dropping into an LLM prompt.  Sections with no data are omitted so
 * the LLM doesn't see "Errors: (none)" style noise.
 */
export function renderSessionContext(ctx: SessionContext): string {
  const lines: string[] = [];

  if (ctx.userPrompt.trim().length > 0) {
    lines.push(`Original prompt: ${ctx.userPrompt.trim()}`);
    lines.push("");
  }

  lines.push(
    `Tool activity: ${ctx.totalToolCalls} calls (${ctx.failedToolCalls} failed)`,
  );

  if (ctx.topTools.length > 0) {
    lines.push("Top tools used:");
    for (const { tool, count } of ctx.topTools) {
      lines.push(`  • ${tool} ×${count}`);
    }
  }

  if (ctx.mcpServersUsed.length > 0) {
    lines.push("");
    lines.push(`MCP servers used: ${ctx.mcpServersUsed.join(", ")}`);
  }

  if (ctx.modulesRegistered.length > 0) {
    lines.push("");
    lines.push(`Modules registered: ${ctx.modulesRegistered.join(", ")}`);
  }

  if (ctx.errorsSeen.length > 0) {
    lines.push("");
    lines.push("Errors / dead-ends encountered:");
    for (const e of ctx.errorsSeen) {
      lines.push(`  • ${e}`);
    }
  }

  return lines.join("\n");
}
