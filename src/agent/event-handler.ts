// ── agent/event-handler.ts — Session event handler ───────────────────
//
// Extracted from agent.ts. Contains registerEventHandler(),
// resetKeepAliveTimer(), clearKeepAliveState(), and
// sendAndWaitWithKeepAlive().
// ─────────────────────────────────────────────────────────────────────

import type {
  CopilotSession,
  AssistantMessageEvent,
} from "@github/copilot-sdk";
import { C, ANSI } from "./ansi.js";
import type { AgentState } from "./state.js";
import type { Spinner } from "./spinner.js";
import {
  formatUsageStats,
  printUsageStats,
  renderReasoningDelta,
} from "./llm-output.js";
import { suggestBufferIncreaseIfNeeded } from "./buffer-overflow.js";
import type { createSandboxTool } from "../sandbox/tool.js";

// ── Types ────────────────────────────────────────────────────────────

/** Runtime dependencies for the event handler */
export interface EventHandlerDeps {
  state: AgentState;
  spinner: Spinner;
  sandbox: ReturnType<typeof createSandboxTool>;
  SEND_TIMEOUT_MS: number;
  MAX_INACTIVITY_RETRIES: number;
  debugLog: (msg: string) => void;
}

// ── Keep-Alive State ─────────────────────────────────────────────────

/** Map toolCallId -> toolName for correlating start/complete events. */
const pendingTools = new Map<string, string>();

/** Reset the keep-alive inactivity timer. Called on EVERY event. */
export function resetKeepAliveTimer(deps: EventHandlerDeps): void {
  const { state, SEND_TIMEOUT_MS } = deps;
  // Don't start/reset the timer if:
  // - No pending promise (not waiting for model response)
  // - Waiting for user input (approval prompts, config questions, etc.)
  if (!state.pendingReject || state.waitingForUserInput) return;
  if (state.keepAliveTimeoutId) clearTimeout(state.keepAliveTimeoutId);
  const inactivityMs = state.sendTimeoutOverride ?? SEND_TIMEOUT_MS;
  state.keepAliveTimeoutId = setTimeout(() => {
    deps.debugLog(
      `TIMEOUT fired: inactivityRetryCount=${state.inactivityRetryCount}, pendingReject=${!!state.pendingReject}`,
    );
    if (
      state.inactivityRetryCount < deps.MAX_INACTIVITY_RETRIES &&
      state.activeSession
    ) {
      state.inactivityRetryCount++;
      const totalSecs = Math.round(inactivityMs / 1000);
      const timeStr =
        totalSecs >= 60
          ? `${Math.floor(totalSecs / 60)}m ${totalSecs % 60}s`
          : `${totalSecs}s`;
      deps.spinner.stop();
      console.log(
        `\n  ${C.dim(`⏳ No activity for ${timeStr} — nudging model to continue...`)}`,
      );
      deps.spinner.start("Waiting for response...");
      state.activeSession
        .send({
          prompt:
            "The user is still here. Please continue — do not repeat what you already said.",
        })
        .catch(() => {});
      resetKeepAliveTimer(deps);
      return;
    }

    const reject = state.pendingReject;
    clearKeepAliveState(deps);
    const totalSecs = Math.round(inactivityMs / 1000);
    const timeStr =
      totalSecs >= 60
        ? `${Math.floor(totalSecs / 60)}m ${totalSecs % 60}s`
        : `${totalSecs}s`;
    reject?.(
      new Error(
        `The model stopped responding (${timeStr} with no activity). ` +
          `The session may be stale — try sending your message again ` +
          `or use /new for a fresh session.`,
      ),
    );
  }, inactivityMs);
}

/** Clear all keep-alive state. */
export function clearKeepAliveState(deps: EventHandlerDeps): void {
  const { state } = deps;
  if (state.keepAliveTimeoutId) clearTimeout(state.keepAliveTimeoutId);
  state.keepAliveTimeoutId = null;
  state.pendingResolve = null;
  state.pendingReject = null;
}

// ── Event Handler ────────────────────────────────────────────────────

/**
 * Register the event handler on a session. Handles display (deltas,
 * tool calls) and flow control (session idle/error for keep-alive).
 */
export function registerEventHandler(
  session: CopilotSession,
  deps: EventHandlerDeps,
): void {
  const { state, spinner, sandbox, debugLog } = deps;

  if (state.eventHandlerUnsub) {
    state.eventHandlerUnsub();
    state.eventHandlerUnsub = null;
  }
  clearKeepAliveState(deps);

  const myGeneration = ++state.handlerGeneration;

  // Workaround: every SessionEvent has a unique `id: string`.
  // We track seen IDs in a Map and drop events we've already
  // dispatched. The Map is bounded by evicting entries older than
  // DEDUP_WINDOW_MS to prevent unbounded memory growth.
  //
  const anySession = session as any;
  if (!anySession.__dedupPatched) {
    const origDispatch = anySession._dispatchEvent.bind(anySession);

    /** Seen event IDs with their timestamp for eviction. */
    const seenEvents = new Map<string, number>();
    /** How long to remember an event ID before evicting (ms). */
    const DEDUP_WINDOW_MS = 30_000;

    anySession._dispatchEvent = (event: { id?: string; type: string }) => {
      if (event.id) {
        const now = Date.now();

        // Drop duplicate — we've already dispatched this event
        if (seenEvents.has(event.id)) {
          return;
        }

        // Record this event ID
        seenEvents.set(event.id, now);

        // Evict stale entries to bound memory (lazy sweep)
        if (seenEvents.size > 500) {
          const cutoff = now - DEDUP_WINDOW_MS;
          for (const [id, ts] of seenEvents) {
            if (ts < cutoff) seenEvents.delete(id);
          }
        }
      }
      origDispatch(event);
    };
    anySession.__dedupPatched = true;
  }

  state.eventHandlerUnsub = session.on((event) => {
    // Stale handler guard — if another registerEventHandler call
    // has superseded us, bail immediately. This closes all possible
    // SDK-level handler duplication paths (session resume, infinite
    // sessions compaction, etc.) that could lead to doubled output.
    if (myGeneration !== state.handlerGeneration) {
      return;
    }

    // Log every event type in debug mode for diagnostics
    if (state.debugEnabled) {
      debugLog(
        `event: ${event.type} ${JSON.stringify(event.data ?? {}).slice(0, 200)}`,
      );
    }

    // Reset keep-alive timer on EVERY event — proves agent is alive
    resetKeepAliveTimer(deps);

    switch (event.type) {
      case "assistant.turn_start":
        // New turn — record start time and reset reasoning state
        spinner.resetTurnStart();
        spinner.clearReasoning();
        spinner.start("Thinking...");
        break;

      case "assistant.intent": {
        // Model declared an intent — show what it's planning.
        // Truncate long intents so the spinner line stays tidy.
        const MAX_INTENT_LEN = 30;
        const intent = (event.data as { intent?: string })?.intent ?? "";
        if (intent) {
          const truncated =
            intent.length > MAX_INTENT_LEN
              ? intent.slice(0, MAX_INTENT_LEN) + "…"
              : intent;
          // start() not updateLabel() — spinner may have been
          // stopped by a preceding message_delta in the same turn.
          spinner.start(`Planning: ${truncated}`);
        }
        break;
      }

      case "assistant.reasoning_delta":
        // Model is actively reasoning — delegate to shared renderer.
        if (event.data?.deltaContent) {
          renderReasoningDelta(
            spinner,
            event.data.deltaContent,
            state.verboseOutput,
          );
        }
        break;

      case "assistant.message_delta": {
        // First delta kills the spinner — we have content flowing.
        // Capture reasoning length BEFORE stop() clears it.
        const hadReasoning = spinner.reasoningLength > 0;
        // Skip whitespace-only deltas before real content — the model
        // can emit "\n\n" before reasoning starts (undocumented).
        // Once real content has started, all deltas pass through.
        if (!state.streamedContent && event.data?.deltaContent?.trim() === "") {
          break;
        }
        spinner.stop();
        // If verbose reasoning was scrolling, emit a visual
        // separator before the response text starts.
        if (state.verboseOutput && hadReasoning && !state.streamedContent) {
          process.stdout.write(`${ANSI.reset}\n\n`);
        }
        // Stream response text token-by-token to stdout
        if (event.data?.deltaContent) {
          process.stdout.write(event.data.deltaContent);
          state.streamedContent = true;
          state.streamedText += event.data.deltaContent;
        }
        break;
      }

      case "assistant.message":
        // Capture the final message for sendAndWaitWithKeepAlive
        state.lastAssistantMessage = event as AssistantMessageEvent;
        if (state.debugEnabled && event.data?.content) {
          debugLog(`final message: ${event.data.content.slice(0, 200)}`);
        }
        break;

      case "session.idle":
        // Agent finished — stop spinner and resolve
        spinner.stop();
        if (state.pendingResolve) {
          const resolve = state.pendingResolve;
          clearKeepAliveState(deps);
          resolve(state.lastAssistantMessage);
        }
        break;

      case "abort":
        // User pressed ESC — session.abort() was called, SDK confirms.
        // Treat like session.idle: resolve the pending promise with
        // whatever partial content we captured.
        spinner.stop();
        if (state.pendingResolve) {
          const resolve = state.pendingResolve;
          clearKeepAliveState(deps);
          resolve(state.lastAssistantMessage);
        }
        break;

      case "session.error": {
        // Agent errored — stop spinner and reject
        spinner.stop();
        if (state.pendingReject) {
          const reject = state.pendingReject;
          clearKeepAliveState(deps);
          const data = event.data as { message: string; stack?: string };
          const error = new Error(data.message);
          if (data.stack) error.stack = data.stack;
          reject(error);
        }
        break;
      }

      case "tool.execution_start": {
        // Tool is executing — swap the label to show which tool
        const toolName = event.data?.toolName ?? "unknown";
        const callId = event.data?.toolCallId;
        if (callId) pendingTools.set(callId, toolName);

        if (toolName === "execute_javascript") {
          // Our sandbox tool — stop spinner, show explicit line
          spinner.stop();
          console.log(`\n  ${C.tool("🔧 Running code...")}`);
        } else {
          // SDK protocol tool — restart spinner with tool label.
          // start() not updateLabel() — spinner may be stopped.
          spinner.start(`Running ${toolName}...`);
        }
        break;
      }

      case "tool.execution_complete": {
        const callId = event.data?.toolCallId;
        const toolName = callId
          ? (pendingTools.get(callId) ?? "unknown")
          : "unknown";
        if (callId) pendingTools.delete(callId);

        // Skip noisy protocol tools in non-debug mode
        if (toolName !== "execute_javascript") {
          if (state.debugEnabled) {
            const status = event.data?.success ? "✅" : "❌";
            debugLog(`${status} ${toolName} complete`);
          }
          break;
        }

        // Show result summary for our sandbox tool
        if (event.data?.success) {
          const content = event.data?.result?.content ?? "";
          let parsed;
          try {
            parsed = JSON.parse(content);
          } catch {
            // Not JSON — show raw
          }

          if (parsed?.error) {
            // If _userDisplayed is set, the tool handler already
            // printed the clean error — don't re-display it.
            if (!parsed._userDisplayed) {
              console.log(`  ${C.err("❌ " + parsed.error)}`);
              suggestBufferIncreaseIfNeeded(parsed.error);
            }
          } else {
            const resultValue = parsed?.result;

            // If the tool handler already displayed the full
            // result (large output), skip re-display here.
            const wasTruncated =
              typeof resultValue === "string" &&
              resultValue.endsWith("[TRUNCATED_FOR_LLM]");
            if (wasTruncated) {
              // Already displayed by the tool handler — nothing to do.
            } else if (resultValue !== undefined) {
              let displayValue;
              try {
                displayValue = JSON.parse(resultValue);
              } catch {
                displayValue = resultValue;
              }

              if (typeof displayValue === "string") {
                if (displayValue.includes("\n")) {
                  console.log(`  ${C.ok("✅ Result:")}`);
                  console.log(C.dim(displayValue));
                } else {
                  console.log(`  ${C.ok("✅ Result:")} ${displayValue}`);
                }
              } else if (
                displayValue !== null &&
                typeof displayValue === "object"
              ) {
                const pretty = JSON.stringify(displayValue, null, 2);
                if (pretty.length > 500) {
                  console.log(`  ${C.ok("✅ Result:")}`);
                  console.log(C.dim(pretty));
                } else {
                  console.log(`  ${C.ok("✅ Result:")} ${C.dim(pretty)}`);
                }
              } else {
                console.log(`  ${C.ok("✅ Result:")} ${String(displayValue)}`);
              }
            } else if (content) {
              const preview =
                content.length > 300 ? content.slice(0, 300) + "…" : content;
              console.log(`  ${C.ok("✅ Result:")} ${C.dim(preview)}`);
            } else {
              console.log(`  ${C.ok("✅ Tool complete")}`);
            }
          }
        } else {
          // Check if the tool handler already displayed the error to the user
          // (indicated by _userDisplayed flag in the result content). If so,
          // suppress the generic SDK error to avoid duplicate error messages.
          let alreadyDisplayed = false;
          try {
            const content = event.data?.result?.content;
            if (content) {
              const parsed = JSON.parse(content);
              alreadyDisplayed = !!parsed?._userDisplayed;
            }
          } catch {
            // Content isn't JSON or missing — that's fine
          }
          if (!alreadyDisplayed) {
            const errMsg = event.data?.error?.message ?? "unknown error";
            const errCode = event.data?.error?.code;
            if (errCode === "denied") {
              console.log(`  ${C.warn("🚫 Tool denied by policy")}`);
            } else {
              console.log(`  ${C.err("❌ Error:")} ${errMsg}`);
              suggestBufferIncreaseIfNeeded(errMsg);
            }
          }
        }
        console.log();

        // After tool completes the model will process the result —
        // restart spinner so the user sees continued activity.
        spinner.start("Thinking...");
        break;
      }

      case "assistant.usage": {
        // Token usage stats — use shared renderer for consistency.
        // Stop spinner first to avoid ANSI cursor conflicts that break
        // readline's up-arrow history recall.
        spinner.stop();
        const usageData = event.data as {
          model?: string;
          inputTokens?: number;
          outputTokens?: number;
          cacheReadTokens?: number;
          cacheWriteTokens?: number;
          cost?: number;
          duration?: number;
        };

        // Accumulate session totals. Count one request per usage event;
        // usageData.cost is premium request count, not a reliable API-call counter.
        state.totalInputTokens += usageData.inputTokens ?? 0;
        state.totalOutputTokens += usageData.outputTokens ?? 0;
        state.totalCacheReadTokens += usageData.cacheReadTokens ?? 0;
        state.totalCacheWriteTokens += usageData.cacheWriteTokens ?? 0;
        state.totalRequests += 1;

        // Ensure stats appear on a new line — streamed
        // message_delta writes don't end with \n.
        if (state.streamedContent) {
          process.stdout.write("\n");
        }
        const statsStr = formatUsageStats(usageData);
        if (statsStr) {
          printUsageStats(statsStr, "  ");
        }
        break;
      }

      case "tool.execution_progress": {
        // Tool progress update — show progress in the spinner label.
        // Data: { toolCallId, progressMessage }
        const progressMsg = (event.data as { progressMessage?: string })
          ?.progressMessage;
        if (progressMsg) {
          spinner.updateLabel(progressMsg);
        }
        break;
      }

      case "tool.execution_partial_result": {
        // Partial tool output — log in debug mode for diagnostics.
        // Data: { toolCallId, partialOutput }
        if (state.debugEnabled) {
          const partial =
            (event.data as { partialOutput?: string })?.partialOutput ?? "";
          debugLog(`partial result: ${partial.slice(0, 200)}`);
        }
        break;
      }

      // ── SDK Events — P1: UX-critical signals ──────────────────
      // These events were previously unhandled. The SDK fires them
      // for session lifecycle visibility — ignoring them leaves the
      // user blind during compaction, truncation, and errors.

      case "session.warning": {
        // Warnings the SDK/CLI wants the user to see (rate limits,
        // approaching quota, etc.). Always surface these.
        const warnData = event.data as {
          warningType?: string;
          message?: string;
        };
        if (warnData.message) {
          spinner.stop();
          console.log(`  ${C.warn("⚠️  " + warnData.message)}`);
        }
        break;
      }

      case "session.info": {
        // Informational messages from the SDK — surface dimmed so
        // they don't steal focus from the main conversation.
        const infoData = event.data as {
          infoType?: string;
          message?: string;
        };
        if (infoData.message) {
          // Suppress "Disabled tools:" message — it lists SDK built-ins
          // that we've whitelisted away via availableTools. Showing this
          // list confuses the model into thinking those are real
          // capabilities that are merely "turned off", leading to
          // hallucinated claims like "SQL-backed to-do lists".
          if (infoData.message.startsWith("Disabled tools:")) {
            if (state.debugEnabled) {
              debugLog(`Suppressed: ${infoData.message}`);
            }
            break;
          }
          spinner.stop();
          console.log(`  ${C.dim("ℹ️  " + infoData.message)}`);
        }
        break;
      }

      case "session.compaction_start": {
        // Infinite sessions: context window is filling up, the SDK
        // is summarising old messages in the background.
        spinner.start("Compacting context…");
        break;
      }

      case "session.compaction_complete": {
        // Compaction finished — show how much context was freed.
        spinner.stop();
        const compData = event.data as {
          success?: boolean;
          error?: string;
          preCompactionTokens?: number;
          postCompactionTokens?: number;
          tokensRemoved?: number;
        };
        if (compData.success) {
          const pre = compData.preCompactionTokens ?? 0;
          const post = compData.postCompactionTokens ?? 0;
          const freed = compData.tokensRemoved ?? pre - post;
          console.log(
            `  ${C.dim(`📦 Context compacted: ${pre.toLocaleString()} → ${post.toLocaleString()} tokens (${freed.toLocaleString()} freed)`)}`,
          );
        } else {
          console.log(
            `  ${C.warn("⚠️  Context compaction failed: " + (compData.error ?? "unknown error"))}`,
          );
        }
        break;
      }

      case "session.truncation": {
        // Hard truncation — messages were evicted to stay within
        // token limits. More aggressive than compaction.
        const truncData = event.data as {
          tokenLimit?: number;
          tokensRemovedDuringTruncation?: number;
          messagesRemovedDuringTruncation?: number;
        };
        const tokensFreed = truncData.tokensRemovedDuringTruncation ?? 0;
        const msgsRemoved = truncData.messagesRemovedDuringTruncation ?? 0;
        console.log(
          `  ${C.dim(`✂️  Context truncated: ${msgsRemoved} messages, ${tokensFreed.toLocaleString()} tokens freed`)}`,
        );
        break;
      }

      case "session.task_complete": {
        // The SDK signals that a logical task unit is done.
        // Surface the summary if present.
        const taskData = event.data as { summary?: string };
        if (taskData.summary) {
          console.log(`  ${C.ok("✅ Task complete:")} ${taskData.summary}`);
        }
        break;
      }

      case "session.usage_info": {
        // Context window health — token utilisation snapshot.
        // Only show when utilisation exceeds 60% to avoid noise.
        const USAGE_VISIBILITY_THRESHOLD = 0.6;
        const usageData = event.data as {
          tokenLimit?: number;
          currentTokens?: number;
          messagesLength?: number;
        };
        const limit = usageData.tokenLimit ?? 0;
        const current = usageData.currentTokens ?? 0;
        if (limit > 0) {
          const pct = current / limit;
          if (pct >= USAGE_VISIBILITY_THRESHOLD) {
            const pctStr = (pct * 100).toFixed(0);
            const color = pct >= 0.9 ? C.warn : C.dim;
            console.log(
              `  ${color(`📊 Context: ${current.toLocaleString()}/${limit.toLocaleString()} tokens (${pctStr}%)`)}`,
            );
          }
        }
        break;
      }

      case "session.shutdown": {
        // End-of-session stats — premium requests, token totals,
        // code changes. Show a compact summary.
        const shutdownData = event.data as {
          totalPremiumRequests?: number;
          totalApiDurationMs?: number;
          codeChanges?: {
            linesAdded?: number;
            linesRemoved?: number;
            filesModified?: string[];
          };
        };
        const parts: string[] = [];
        if (shutdownData.totalPremiumRequests) {
          parts.push(`${shutdownData.totalPremiumRequests} API calls`);
        }
        if (shutdownData.totalApiDurationMs) {
          const secs = (shutdownData.totalApiDurationMs / 1000).toFixed(1);
          parts.push(`${secs}s total API time`);
        }
        if (shutdownData.codeChanges) {
          const cc = shutdownData.codeChanges;
          const added = cc.linesAdded ?? 0;
          const removed = cc.linesRemoved ?? 0;
          const files = cc.filesModified?.length ?? 0;
          if (added || removed || files) {
            parts.push(`+${added}/-${removed} lines in ${files} files`);
          }
        }
        if (parts.length > 0) {
          console.log(`  ${C.dim("📈 Session stats: " + parts.join(" · "))}`);
        }
        break;
      }

      // ── P2 Events — Nice-to-have signals ─────────────────────

      case "session.model_change": {
        // Confirmation when session.setModel() or model switch
        // takes effect server-side.
        const modelData = event.data as {
          previousModel?: string;
          newModel?: string;
        };
        if (modelData.newModel) {
          console.log(
            `  ${C.dim(`🔄 Model: ${modelData.previousModel ?? "?"} → ${modelData.newModel}`)}`,
          );
        }
        break;
      }

      case "session.resume": {
        // Session was resumed — show how many history events loaded.
        const resumeData = event.data as { eventCount?: number };
        if (resumeData.eventCount !== undefined) {
          console.log(
            `  ${C.dim(`⏮️  Resumed with ${resumeData.eventCount} history events`)}`,
          );
        }
        break;
      }

      case "session.title_changed": {
        // SDK auto-generates conversation titles. Set the terminal
        // title so tab/window management is easier.
        const titleData = event.data as { title?: string };
        if (titleData.title) {
          // OSC escape: \x1b]2;TITLE\x07 sets the terminal title
          process.stdout.write(`\x1b]2;HyperAgent: ${titleData.title}\x07`);
        }
        break;
      }

      // ── Debug-only events — log but don't display ────────────
      // These fire frequently during normal operation. Only
      // surface them when --debug is active.

      case "session.start":
      case "session.context_changed":
      case "session.mode_changed":
      case "session.plan_changed":
      case "session.snapshot_rewind":
      case "session.workspace_file_changed":
      case "session.handoff":
      case "assistant.turn_end":
      case "assistant.reasoning":
      case "assistant.streaming_delta":
      case "pending_messages.modified":
      case "system.message":
      case "skill.invoked":
      case "hook.start":
      case "hook.end":
      case "subagent.started":
      case "subagent.completed":
      case "subagent.failed":
      case "subagent.selected":
      case "subagent.deselected":
      case "tool.user_requested":
      case "user.message":
        // Handled by debug logging at the top of the handler
        break;
    }
  });
}

// ── REPL ─────────────────────────────────────────────────────────────
//
// A readline-based interactive loop. The agent streams responses token
// by token, with tool invocations shown inline.

// ── Keep-Alive sendAndWait ────────────────────────────────────────────
//
// The SDK's built-in sendAndWait() uses a FIXED absolute timeout —
// if set to 60s and the model chains 5 tool calls at 20s each, it
// fires mid-execution even though the agent is actively working.
//
// We use send() + the single consolidated event handler and shared
// module-level state (pendingResolve/pendingReject). The handler
// resets the INACTIVITY timer on every event, captures the final
// assistant message, and resolves/rejects the promise on idle/error.
//
// NO SECOND session.on() CALL — the single handler does it all.
//
// We don't need fixed timeouts.

/**
 * Send a message and wait for session.idle, with an INACTIVITY timeout
 * that resets every time any session event arrives.
 *
 * Uses the single consolidated handler registered by registerEventHandler —
 * no additional session.on() call, no second listener, no doubled output.
 *
 * @param session           — The active CopilotSession
 * @param prompt            — User message text
 * @param _inactivityMs     — Unused (timeout read from state.sendTimeoutOverride ?? SEND_TIMEOUT_MS)
  });
}

// ── Send and Wait ────────────────────────────────────────────────────

/**
 * Send a message and wait for session.idle, with keep-alive timeout.
 */
export function sendAndWaitWithKeepAlive(
  session: CopilotSession,
  prompt: string,
  deps: EventHandlerDeps,
): Promise<AssistantMessageEvent | undefined> {
  const { state } = deps;
  return new Promise<AssistantMessageEvent | undefined>((resolve, reject) => {
    state.lastAssistantMessage = undefined;
    state.pendingResolve = resolve;
    state.pendingReject = reject;
    resetKeepAliveTimer(deps);
    session.send({ prompt }).catch((err: unknown) => {
      clearKeepAliveState(deps);
      reject(err);
    });
  });
}
