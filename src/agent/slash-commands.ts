// ── agent/slash-commands.ts — Slash command handlers ─────────────────
//
// Extracted from agent.ts. Contains handleSlashCommand() and its
// dependencies. All runtime singletons are passed via SlashCommandDeps.
// ─────────────────────────────────────────────────────────────────────

import type { Interface as ReadlineInterface } from "node:readline/promises";
import type { CopilotSession, ModelInfo } from "@github/copilot-sdk";
import type { WriteStream } from "node:fs";
import { createWriteStream, mkdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { C } from "./ansi.js";
import type { AgentState } from "./state.js";
import type { Spinner } from "./spinner.js";
import { renderHelp, renderTopicHelp } from "./commands.js";
import { deepAudit, formatAuditResult } from "../plugin-system/auditor.js";
import { makeAuditProgressCallback } from "./audit-progress.js";
import { createAuditAbortHandler } from "./abort-controller.js";
import { closestMatch } from "./fuzzy-match.js";
import type { createSandboxTool } from "../sandbox/tool.js";
import type { createPluginManager } from "../plugin-system/manager.js";
import type { Transcript } from "./transcript.js";
import {
  contentHash,
  loadOperatorConfig,
  exceedsRiskThreshold,
} from "../plugin-system/manager.js";
import type { MCPClientManager } from "./mcp/client-manager.js";
import {
  loadMCPApprovalStore,
  isMCPApproved,
  approveMCPServer,
  revokeMCPApproval,
  auditMCPTools,
} from "./mcp/approval.js";
import { maskEnvValue } from "./mcp/sanitise.js";
import {
  createMCPPluginAdapter,
  generateMCPDeclarations,
} from "./mcp/plugin-adapter.js";

// ── Constants ────────────────────────────────────────────────────────

const SESSION_ID_PREFIX = "hyperagent-";
const SESSIONS_PAGE_SIZE = 10;
function makeSessionId(): string {
  return `${SESSION_ID_PREFIX}${randomUUID()}`;
}
const operatorConfig = loadOperatorConfig();

// ── Types ────────────────────────────────────────────────────────────

/** Runtime dependencies injected from agent.ts */
export interface SlashCommandDeps {
  state: AgentState;
  spinner: Spinner;
  sandbox: ReturnType<typeof createSandboxTool>;
  pluginManager: ReturnType<typeof createPluginManager>;
  transcript: Transcript;
  SEND_TIMEOUT_MS: number;
  debugLog: (msg: string) => void;
  debugStream: WriteStream | null;
  setDebugStream: (stream: WriteStream) => void;
  LOGS_DIR: string;
  formatModelList: (models: ModelInfo[], current?: string) => string;
  buildSessionConfig: () => Record<string, unknown>;
  registerEventHandler: (session: CopilotSession) => void;
  /** Drain buffered paste lines and warn user before critical prompts. */
  drainAndWarn: (rl: ReadlineInterface) => Promise<void>;
  /** MCP client manager (null if MCP plugin not enabled). */
  mcpManager: MCPClientManager | null;
  /** Callback to sync plugins to sandbox after MCP changes. */
  syncPlugins: () => Promise<void>;
}

// ── Handler ──────────────────────────────────────────────────────────

/**
 * Handle a slash command from the REPL.
 *
 * @returns true if the input was handled as a command,
 *          false if it should be forwarded to the LLM.
 */
export async function handleSlashCommand(
  rawInput: string,
  rl: ReadlineInterface,
  deps: SlashCommandDeps,
): Promise<boolean> {
  // Destructure deps so the function body can reference them
  // by their original names — zero code changes in the switch block.
  const {
    state,
    spinner,
    sandbox,
    pluginManager,
    transcript,
    SEND_TIMEOUT_MS,
    debugLog,
    LOGS_DIR,
    drainAndWarn,
  } = deps;
  // Alias deps that shadow variables in agent.ts
  let { debugStream } = deps;
  const formatModelList = deps.formatModelList;
  const buildSessionConfig = deps.buildSessionConfig;
  const registerEventHandler = deps.registerEventHandler;
  const parts = rawInput.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  switch (cmd) {
    case "/show-code":
      state.showCodeEnabled = !state.showCodeEnabled;
      console.log(`  📝 Code display: ${C.onOff(state.showCodeEnabled)}`);
      console.log();
      return true;

    case "/show-timing":
      state.showTimingEnabled = !state.showTimingEnabled;
      console.log(`  ⏱️  Timing display: ${C.onOff(state.showTimingEnabled)}`);
      console.log();
      return true;

    case "/debug":
      state.debugEnabled = !state.debugEnabled;
      if (state.debugEnabled && !debugStream) {
        // Create log file on first enable
        mkdirSync(LOGS_DIR, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const path = join(LOGS_DIR, `agent-debug-${ts}.log`);
        const newStream = createWriteStream(path, { flags: "a" });
        // Update BOTH the local variable AND the module-level stream
        // in agent.ts via the callback — otherwise debugLog() in the
        // event handler still uses the old (null) stream.
        debugStream = newStream;
        deps.setDebugStream(newStream);
        console.log(`  🔍 Debug mode: ${C.ok("ON")}`);
        console.log(`  📝 Debug log: ${path}`);
      } else {
        console.log(`  🔍 Debug mode: ${C.onOff(state.debugEnabled)}`);
      }
      console.log();
      return true;

    case "/reasoning": {
      // /reasoning conversation <level> — set conversation reasoning effort
      // /reasoning audit <level>        — set audit reasoning effort (min: medium)
      // /reasoning                      — show current settings
      const subCmd = parts[1]?.toLowerCase();

      if (subCmd === "conversation" || subCmd === "conv") {
        const level = parts[2]?.toLowerCase();
        const VALID = ["low", "medium", "high", "xhigh"] as const;
        type Effort = (typeof VALID)[number];

        if (level && VALID.includes(level as Effort)) {
          // Validate current model supports reasoning effort
          if (state.cachedModels) {
            const model = state.cachedModels.find(
              (m) => m.id === state.currentModel,
            );
            if (model && !model.capabilities?.supports?.reasoningEffort) {
              console.log(
                `  ⚠️  ${C.val(state.currentModel)} doesn't support reasoning effort`,
              );
              console.log();
              return true;
            }
          }
          state.reasoningEffort = level as Effort;
          state.sessionNeedsRebuild = true;
          console.log(
            `  🧠 Conversation reasoning: ${C.val(level)} ${C.dim("(rebuild on next message)")}`,
          );
        } else if (level === "reset" || level === "off") {
          state.reasoningEffort = null;
          state.sessionNeedsRebuild = true;
          console.log(
            `  🧠 Conversation reasoning: ${C.dim("model default (reset)")}`,
          );
        } else {
          console.log(
            `  🧠 Conversation reasoning: ${
              state.reasoningEffort
                ? C.val(state.reasoningEffort)
                : C.dim("model default")
            }`,
          );
          console.log(
            `  Usage: /reasoning conversation <level>  ${C.dim("— low|medium|high|xhigh")}`,
          );
          console.log(
            `         /reasoning conversation reset    ${C.dim("— use model default")}`,
          );
        }
      } else if (subCmd === "audit") {
        const level = parts[2]?.toLowerCase();
        const VALID_AUDIT = ["medium", "high", "xhigh"] as const;
        type AuditEffort = (typeof VALID_AUDIT)[number];

        if (level && VALID_AUDIT.includes(level as AuditEffort)) {
          state.auditReasoningEffort = level as AuditEffort;
          console.log(`  🔍 Audit reasoning: ${C.val(level)}`);
        } else if (level === "reset" || level === "off") {
          state.auditReasoningEffort = null;
          console.log(`  🔍 Audit reasoning: ${C.dim("medium (default)")}`);
        } else {
          console.log(
            `  🔍 Audit reasoning: ${
              state.auditReasoningEffort
                ? C.val(state.auditReasoningEffort)
                : C.dim("medium (default)")
            }`,
          );
          console.log(
            `  Usage: /reasoning audit <level>  ${C.dim("— medium|high|xhigh (min: medium)")}`,
          );
          console.log(
            `         /reasoning audit reset    ${C.dim("— reset to medium")}`,
          );
        }
      } else {
        // No subcommand or unknown — show both settings + usage
        console.log(
          `  🧠 Conversation: ${
            state.reasoningEffort
              ? C.val(state.reasoningEffort)
              : C.dim("model default")
          }`,
        );
        console.log(
          `  🔍 Audit:        ${
            state.auditReasoningEffort
              ? C.val(state.auditReasoningEffort)
              : C.dim("medium (default)")
          }`,
        );
        console.log();
        console.log(
          `  Usage: /reasoning conversation <level>  ${C.dim("— low|medium|high|xhigh")}`,
        );
        console.log(
          `         /reasoning audit <level>         ${C.dim("— medium|high|xhigh (min: medium)")}`,
        );
      }
      console.log();
      return true;
    }

    case "/verbose": {
      // Toggle verbose output mode — affects reasoning display,
      // turn lifecycle events, and other detailed LLM output.
      state.verboseOutput = !state.verboseOutput;
      spinner.verboseReasoning = state.verboseOutput;
      console.log(
        `  💡 Verbose output: ${state.verboseOutput ? C.ok("ON") : C.err("OFF")}`,
      );
      console.log();
      return true;
    }

    case "/timeout": {
      const kind = parts[1]?.toLowerCase();
      const ms = parseInt(parts[2], 10);

      if (kind === "cpu" && Number.isFinite(ms) && ms > 0) {
        // Validate: CPU should be ≤ wall-clock (wall is the backstop)
        const effectiveWall =
          state.wallTimeoutOverride ?? sandbox.config.wallClockTimeoutMs;
        if (ms > effectiveWall) {
          console.log(
            `  ⚠️  CPU timeout (${ms}ms) > wall-clock (${effectiveWall}ms) — ` +
              `wall-clock will fire first, making CPU limit unreachable.`,
          );
        }
        state.cpuTimeoutOverride = ms;
        console.log(`  ⏱️  CPU timeout set to ${C.val(ms + "ms")}`);
      } else if (kind === "wall" && Number.isFinite(ms) && ms > 0) {
        // Validate: wall-clock should be ≥ CPU (wall is the backstop)
        const effectiveCpu =
          state.cpuTimeoutOverride ?? sandbox.config.cpuTimeoutMs;
        if (ms < effectiveCpu) {
          console.log(
            `  ⚠️  Wall-clock (${ms}ms) < CPU timeout (${effectiveCpu}ms) — ` +
              `wall-clock will fire first, making CPU limit unreachable.`,
          );
        }
        state.wallTimeoutOverride = ms;
        console.log(`  ⏱️  Wall-clock timeout set to ${C.val(ms + "ms")}`);
      } else if (kind === "send" && Number.isFinite(ms) && ms > 0) {
        // Send timeout — how long to wait for the agent to finish
        state.sendTimeoutOverride = ms;
        console.log(`  ⏱️  Send timeout set to ${C.val(ms + "ms")}`);
      } else if (kind === "reset") {
        state.cpuTimeoutOverride = null;
        state.wallTimeoutOverride = null;
        state.sendTimeoutOverride = null;
        console.log(
          `  ⏱️  Timeouts reset to defaults ` +
            `(CPU: ${sandbox.config.cpuTimeoutMs}ms, ` +
            `Wall: ${sandbox.config.wallClockTimeoutMs}ms, ` +
            `Send: ${SEND_TIMEOUT_MS}ms)`,
        );
      } else {
        console.log("  Usage: /timeout cpu|wall|send <ms>  or  /timeout reset");
      }
      console.log();
      return true;
    }

    case "/buffer": {
      const kind = parts[1]?.toLowerCase();
      const kb = parseInt(parts[2], 10);

      if (kind === "input" && Number.isFinite(kb) && kb > 0) {
        state.inputBufferOverride = kb;
        await sandbox.setBufferSizes(kb, undefined);
        state.sessionNeedsRebuild = true;
        console.log(
          `  📦 Input buffer set to ${C.val(kb + "KB")} ${C.dim("(rebuild on next message)")}`,
        );
      } else if (kind === "output" && Number.isFinite(kb) && kb > 0) {
        state.outputBufferOverride = kb;
        await sandbox.setBufferSizes(undefined, kb);
        state.sessionNeedsRebuild = true;
        console.log(
          `  📦 Output buffer set to ${C.val(kb + "KB")} ${C.dim("(rebuild on next message)")}`,
        );
      } else if (kind === "reset") {
        state.inputBufferOverride = null;
        state.outputBufferOverride = null;
        await sandbox.resetBufferSizes();
        state.sessionNeedsRebuild = true;
        console.log(
          `  📦 Buffers reset to defaults ` +
            `(input: ${sandbox.config.inputBufferKb}KB, ` +
            `output: ${sandbox.config.outputBufferKb}KB)`,
        );
      } else {
        console.log("  Usage: /buffer input|output <kb>  or  /buffer reset");
      }
      console.log();
      return true;
    }

    case "/set": {
      const setSub = parts[1]?.toLowerCase();
      const setVal = parseInt(parts[2], 10);

      if (setSub === "heap") {
        if (Number.isFinite(setVal) && setVal > 0) {
          state.heapOverride = setVal;
          await sandbox.setMemorySizes(setVal, undefined);
          state.sessionNeedsRebuild = true;
          console.log(
            `  🧠 Heap set to ${C.val(setVal + "MB")} ${C.dim("(rebuild on next message)")}`,
          );
        } else {
          const current = sandbox.getEffectiveMemorySizes();
          console.log(
            `  Current heap: ${C.val(current.heapMb + "MB")}${state.heapOverride !== null ? C.warn(" (overridden)") : ""}`,
          );
          console.log("  Usage: /set heap <mb>  — e.g. /set heap 32");
        }
      } else if (setSub === "scratch") {
        if (Number.isFinite(setVal) && setVal > 0) {
          state.scratchOverride = setVal;
          await sandbox.setMemorySizes(undefined, setVal);
          state.sessionNeedsRebuild = true;
          console.log(
            `  📚 Scratch set to ${C.val(setVal + "MB")} ${C.dim("(rebuild on next message)")}`,
          );
        } else {
          const current = sandbox.getEffectiveMemorySizes();
          console.log(
            `  Current scratch: ${C.val(current.scratchMb + "MB")}${state.scratchOverride !== null ? C.warn(" (overridden)") : ""}`,
          );
          console.log("  Usage: /set scratch <mb>  — e.g. /set scratch 4");
        }
      } else if (setSub === "reset") {
        state.heapOverride = null;
        state.scratchOverride = null;
        await sandbox.resetMemorySizes();
        state.sessionNeedsRebuild = true;
        console.log(
          `  🧠 Memory reset to defaults ` +
            `(heap: ${sandbox.config.heapSizeMb}MB, ` +
            `scratch: ${sandbox.config.scratchSizeMb}MB)`,
        );
      } else {
        console.log("  Usage: /set heap|scratch <mb>  or  /set reset");
      }
      console.log();
      return true;
    }

    case "/transcript": {
      // Toggle transcript recording on/off.
      if (transcript.active) {
        const paths = await transcript.stop();
        console.log("  📄 Transcript stopped.");
        console.log(`     ANSI log:  ${paths.logPath}`);
        console.log(`     Clean text: ${paths.txtPath}`);
      } else {
        const buffers = sandbox.getEffectiveBufferSizes();
        const logPath = transcript.start({
          model: state.currentModel,
          cpuTimeoutMs: state.cpuTimeoutOverride ?? sandbox.config.cpuTimeoutMs,
          wallClockTimeoutMs:
            state.wallTimeoutOverride ?? sandbox.config.wallClockTimeoutMs,
          heapSizeMb: sandbox.config.heapSizeMb,
          inputBufferKb: buffers.inputKb,
          outputBufferKb: buffers.outputKb,
        });
        console.log(`  📄 Transcript started: ${logPath}`);
      }
      console.log();
      return true;
    }

    case "/models": {
      // List available models from the Copilot API.
      if (!state.copilotClient) {
        console.log(`  ${C.err("❌ Client not connected.")}`);
        console.log();
        return true;
      }
      try {
        const models = await state.copilotClient.listModels();
        state.cachedModels = models;
        console.log(formatModelList(models, state.currentModel));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  ${C.err("❌ Failed to list models:")} ${msg}`);
      }
      console.log();
      return true;
    }

    case "/model": {
      // Switch model mid-session using session.setModel() — the SDK
      // handles everything server-side, no session rebuild needed.
      const newModel = parts[1];
      if (!newModel) {
        console.log(`  🤖 Current model: ${C.val(state.currentModel)}`);
        console.log("  Usage: /model <name>  (use /models to list available)");
        console.log();
        return true;
      }
      if (!state.copilotClient || !state.activeSession) {
        console.log(`  ${C.err("❌ No active session.")}`);
        console.log();
        return true;
      }
      // Validate model name against available models
      try {
        if (!state.cachedModels) {
          state.cachedModels = await state.copilotClient.listModels();
        }
        const valid = state.cachedModels.some((m) => m.id === newModel);
        if (!valid) {
          console.log(`  ${C.err("❌ Unknown model:")} "${newModel}"`);
          console.log("     Use /models to see available models.");
          console.log();
          return true;
        }
        const disabled = state.cachedModels.find((m) => m.id === newModel);
        if (disabled?.policy?.state === "disabled") {
          console.log(
            `  ${C.warn("⚠️  Model")} "${newModel}" ${C.warn("is disabled by policy.")}`,
          );
        }
      } catch {
        // Validation failed — proceed anyway, server will reject if invalid
        console.log("  ⚠️  Could not validate model name — proceeding anyway.");
      }
      try {
        // Use session.setModel() — the SDK switches the model
        // server-side without tearing down the session or
        // re-registering handlers. History is preserved.
        const oldModel = state.currentModel;
        await state.activeSession.setModel(newModel);
        state.currentModel = newModel;
        console.log(
          `  ${C.ok("🔄 Model switched:")} ${C.dim(oldModel)} → ${C.val(state.currentModel)}`,
        );
        console.log("     Conversation history preserved.");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  ${C.err("❌ Failed to switch model:")} ${msg}`);
      }
      console.log();
      return true;
    }

    case "/new": {
      // Start a fresh session — blank slate, same model.
      if (!state.copilotClient || !state.activeSession) {
        console.log(`  ${C.err("❌ No active session.")}`);
        console.log();
        return true;
      }
      try {
        await state.activeSession.destroy();
        state.activeSession = await state.copilotClient.createSession({
          sessionId: makeSessionId(),
          model: state.currentModel,
          ...buildSessionConfig(),
        } as any);
        registerEventHandler(state.activeSession);
        console.log(
          `  ${C.ok("🆕 New session started.")} Conversation history cleared.`,
        );
        console.log(`     Model: ${C.val(state.currentModel)}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  ${C.err("❌ Failed to create new session:")} ${msg}`);
      }
      console.log();
      return true;
    }

    case "/sessions": {
      // List saved hyperagent sessions (filtered by prefix, paginated).
      if (!state.copilotClient) {
        console.log(`  ${C.err("❌ Client not connected.")}`);
        console.log();
        return true;
      }
      const showAll = parts.includes("--all") || parts.includes("-a");
      try {
        const allSessions = await state.copilotClient.listSessions();
        // Filter to only hyperagent-prefixed sessions
        const sessions = allSessions.filter((s) =>
          s.sessionId.startsWith(SESSION_ID_PREFIX),
        );
        if (sessions.length === 0) {
          console.log("  📋 No saved hyperagent sessions found.");
          if (allSessions.length > 0) {
            console.log(
              `     ${C.dim(`(${allSessions.length} session${allSessions.length === 1 ? "" : "s"} from other Copilot clients hidden)`)}`,
            );
          }
        } else {
          // Sort newest first
          sessions.sort((a, b) => {
            const ta = a.modifiedTime ? new Date(a.modifiedTime).getTime() : 0;
            const tb = b.modifiedTime ? new Date(b.modifiedTime).getTime() : 0;
            return tb - ta;
          });

          const displayCount = showAll
            ? sessions.length
            : Math.min(sessions.length, SESSIONS_PAGE_SIZE);
          const hidden = sessions.length - displayCount;

          console.log(`  ${C.label("📋 Sessions")} (${sessions.length}):`);
          for (let i = 0; i < displayCount; i++) {
            const s = sessions[i];
            const current =
              state.activeSession &&
              s.sessionId === state.activeSession.sessionId
                ? ` ${C.ok("← current")}`
                : "";
            const modified = s.modifiedTime
              ? new Date(s.modifiedTime).toLocaleString()
              : "unknown";
            const summary = s.summary
              ? ` — ${s.summary.slice(0, 60)}${s.summary.length > 60 ? "…" : ""}`
              : "";
            // Show the UUID part after the prefix for readability
            const shortId = s.sessionId.slice(
              SESSION_ID_PREFIX.length,
              SESSION_ID_PREFIX.length + 12,
            );
            console.log(`     ${C.val(shortId + "…")}${current}`);
            console.log(`       ${C.dim("Modified:")} ${modified}${summary}`);
          }
          if (hidden > 0) {
            console.log(
              `     ${C.dim(`… ${hidden} more — use /sessions --all to show all`)}`,
            );
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  ${C.err("❌ Failed to list sessions:")} ${msg}`);
      }
      console.log();
      return true;
    }

    case "/resume": {
      // Resume a previous session.
      if (!state.copilotClient) {
        console.log(`  ${C.err("❌ Client not connected.")}`);
        console.log();
        return true;
      }
      try {
        let targetId = parts[1];
        if (!targetId) {
          // No ID given — resume most recent hyperagent session
          const allSessions = await state.copilotClient.listSessions();
          const ours = allSessions
            .filter((s) => s.sessionId.startsWith(SESSION_ID_PREFIX))
            .sort((a, b) => {
              const ta = a.modifiedTime
                ? new Date(a.modifiedTime).getTime()
                : 0;
              const tb = b.modifiedTime
                ? new Date(b.modifiedTime).getTime()
                : 0;
              return tb - ta;
            });
          if (ours.length === 0) {
            console.log(
              `  ${C.err("❌ No previous hyperagent sessions found.")}`,
            );
            console.log();
            return true;
          }
          targetId = ours[0].sessionId;
        } else {
          // Allow partial session ID matching (with or without prefix)
          const allSessions = await state.copilotClient.listSessions();
          const ours = allSessions.filter((s) =>
            s.sessionId.startsWith(SESSION_ID_PREFIX),
          );
          // Try matching with prefix prepended, then without
          const prefixed = SESSION_ID_PREFIX + targetId;
          const match =
            ours.find((s) => s.sessionId.startsWith(prefixed)) ??
            ours.find((s) => s.sessionId.startsWith(targetId!));
          if (match) {
            targetId = match.sessionId;
          }
          // If no match, pass through — the SDK will error if invalid
        }
        if (state.activeSession) {
          await state.activeSession.destroy();
        }
        state.activeSession = await state.copilotClient.resumeSession(
          targetId,
          {
            model: state.currentModel,
            ...buildSessionConfig(),
          } as any,
        );
        registerEventHandler(state.activeSession);
        console.log(
          `  ${C.ok("⏮️  Resumed session:")} ${C.val(targetId.slice(0, 12) + "…")}`,
        );
        console.log(`     Model: ${C.val(state.currentModel)}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  ${C.err("❌ Failed to resume session:")} ${msg}`);
      }
      console.log();
      return true;
    }

    case "/config": {
      const cpuMs = state.cpuTimeoutOverride ?? sandbox.config.cpuTimeoutMs;
      const wallMs =
        state.wallTimeoutOverride ?? sandbox.config.wallClockTimeoutMs;
      const sendMs = state.sendTimeoutOverride ?? SEND_TIMEOUT_MS;
      const buffers = sandbox.getEffectiveBufferSizes();
      const ovr = C.warn(" (override)");
      console.log(`  ${C.label("⚙️  Configuration:")}`);
      console.log(`     Model:         ${C.val(state.currentModel)}`);
      console.log(
        `     CPU timeout:   ${C.val(cpuMs + "ms")}${state.cpuTimeoutOverride !== null ? ovr : ""}`,
      );
      console.log(
        `     Wall timeout:  ${C.val(wallMs + "ms")}${state.wallTimeoutOverride !== null ? ovr : ""}`,
      );
      console.log(
        `     Send timeout:  ${C.val(sendMs + "ms")}${state.sendTimeoutOverride !== null ? ovr : ""}`,
      );
      console.log(
        `     Heap:          ${C.val(sandbox.getEffectiveMemorySizes().heapMb + "MB")}${state.heapOverride !== null ? ovr : ""}`,
      );
      console.log(
        `     Scratch:        ${C.val(sandbox.getEffectiveMemorySizes().scratchMb + "MB")}${state.scratchOverride !== null ? ovr : ""}`,
      );
      console.log(
        `     Input buffer:  ${C.val(buffers.inputKb + "KB")}${state.inputBufferOverride !== null ? ovr : ""}`,
      );
      console.log(
        `     Output buffer: ${C.val(buffers.outputKb + "KB")}${state.outputBufferOverride !== null ? ovr : ""}`,
      );
      console.log(
        `     Transcript:    ${transcript.active ? `${C.ok("ON")} → ${C.val(transcript.rawPath ?? "")}` : C.err("OFF")}`,
      );
      console.log(`     Show code:     ${C.onOff(state.showCodeEnabled)}`);
      console.log(`     Show timing:   ${C.onOff(state.showTimingEnabled)}`);
      console.log(`     Debug:         ${C.onOff(state.debugEnabled)}`);
      console.log(`     Verbose:       ${C.onOff(state.verboseOutput)}`);
      console.log(
        `     Reasoning:     conversation: ${
          state.reasoningEffort
            ? C.val(state.reasoningEffort)
            : C.dim("model default")
        } · audit: ${
          state.auditReasoningEffort
            ? C.val(state.auditReasoningEffort)
            : C.dim("medium")
        }`,
      );
      if (sandbox.config.timingLogPath) {
        console.log(
          `     Timing log:   ${C.val(sandbox.config.timingLogPath)}`,
        );
      }
      if (sandbox.config.codeLogPath) {
        console.log(`     Code log:     ${C.val(sandbox.config.codeLogPath)}`);
      }
      // Plugin summary
      const enabledPlugins = pluginManager.getEnabledPlugins();
      const allPlugins = pluginManager.listPlugins();
      if (allPlugins.length > 0) {
        const audited = allPlugins.filter((p) => p.audit !== null).length;
        const approved = allPlugins.filter((p) => p.approved).length;
        console.log(
          `     Plugins:      ${C.ok(enabledPlugins.length + "/" + allPlugins.length)} enabled, ${audited} audited, ${approved} approved`,
        );
        for (const p of enabledPlugins) {
          const risk = p.audit?.riskLevel ?? "?";
          console.log(
            `       ${C.ok("✅")} ${C.tool(p.manifest.name)} v${p.manifest.version} ${C.dim("[" + risk + "]")}`,
          );
        }
      } else {
        console.log(`     ${C.dim("Plugins:      none discovered")}`);
      }
      console.log(
        `     Risk policy:  ${C.val("max " + operatorConfig.maxRiskLevel)} ${C.dim("(via ~/.hyperagent/config.json)")}`,
      );
      console.log();
      return true;
    }

    case "/history": {
      // Display recent conversation messages from the active session.
      // Uses the SDK's session.getMessages() to retrieve the full
      // event log, then filters for user & assistant messages.
      if (!state.activeSession) {
        console.log(`  ${C.err("❌ No active session.")}`);
        console.log();
        return true;
      }
      const histCount = parseInt(parts[1] ?? "10", 10);
      const showCount =
        Number.isFinite(histCount) && histCount > 0 ? histCount : 10;
      try {
        const events = await state.activeSession.getMessages();
        // Filter to user/assistant messages — skip tool calls, deltas, etc.
        const messages = events
          .filter(
            (e: { type: string }) =>
              e.type === "user.message" || e.type === "assistant.message",
          )
          .slice(-showCount);

        if (messages.length === 0) {
          console.log(`  ${C.dim("No messages in this session yet.")}`);
        } else {
          const MAX_PREVIEW_LEN = 200;
          console.log(`  ${C.label("📜 Last ${messages.length} message(s):")}`);
          for (const msg of messages) {
            const isUser = msg.type === "user.message";
            const role = isUser ? "You" : "Agent";
            const content: string =
              (msg as { data?: { content?: string } }).data?.content ?? "";
            const preview =
              content.length > MAX_PREVIEW_LEN
                ? content.slice(0, MAX_PREVIEW_LEN) + "…"
                : content;
            // Show first line only to keep it compact
            const firstLine = preview.split("\n")[0];
            console.log(
              `     ${C.label(role + ":")} ${isUser ? C.val(firstLine) : firstLine}`,
            );
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  ${C.err("❌ Failed to retrieve history:")} ${msg}`);
      }
      console.log();
      return true;
    }

    // ── Plugin Commands ──────────────────────────────────────
    //
    // All plugin operations live under /plugin <sub>.

    case "/plugin": {
      const subCmd = parts[1]?.toLowerCase();
      // Plugin name sits at parts[2], args at parts[3]+.
      const pluginName = parts[2];

      switch (subCmd) {
        // ── /plugin list ─────────────────────────────────
        case "list": {
          pluginManager.discover();
          const allP = pluginManager.listPlugins();
          if (allP.length === 0) {
            console.log("  🔌 No plugins discovered.");
            console.log(
              "     Create a plugins/ directory with subdirectories containing plugin.json",
            );
          } else {
            // Count states for the legend
            const hasEnabled = allP.some((p) => p.state === "enabled");
            const hasDisabled = allP.some((p) => p.state === "disabled");
            const hasApproved = allP.some((p) => p.approved);
            const enabledCount = allP.filter(
              (p) => p.state === "enabled",
            ).length;

            console.log(
              `  ${C.label("🔌 Plugins")} (${allP.length}` +
                `${enabledCount > 0 ? `, ${C.ok(enabledCount + " active")}` : ""}):`,
            );

            for (const p of allP) {
              // Simple traffic-light: green = on, grey = off, pause = paused
              const icon =
                p.state === "enabled"
                  ? "🟢"
                  : p.state === "disabled"
                    ? "⏸️ "
                    : "⚪";
              const risk = p.audit?.riskLevel
                ? ` ${C.dim("[" + p.audit.riskLevel + "]")}`
                : "";
              const approved = p.approved ? " 🔒" : "";
              console.log(
                `     ${icon} ${C.tool(p.manifest.name)} v${p.manifest.version}` +
                  `${risk}${approved}`,
              );
              console.log(`        ${C.dim(p.manifest.description)}`);
              // Show companion relationships so the LLM (and user)
              // can see which plugins will be auto-enabled together.
              if (p.manifest.companions && p.manifest.companions.length > 0) {
                console.log(
                  `        ${C.dim("🔗 companions: " + p.manifest.companions.join(", "))}`,
                );
              }
            }

            // Legend — only show symbols that actually appear
            console.log();
            const legend: string[] = ["⚪ = available"];
            if (hasEnabled) legend.push("🟢 = enabled");
            if (hasDisabled) legend.push("⏸️  = disabled");
            if (hasApproved) legend.push("🔒 = approved (skip audit)");
            console.log(`     ${C.dim(legend.join("    "))}`);
            if (!hasEnabled) {
              console.log("     Use /plugin info <name> for config options.");
              console.log(
                "     Use /plugin enable <name> to activate a plugin.",
              );
            }
          }
          console.log();
          break;
        }

        // ── /plugin info <name> ─────────────────────────
        // Shows manifest details and config schema so users
        // know what k=v options are available before enabling.
        case "info": {
          if (!pluginName) {
            console.log("  Usage: /plugin info <name>");
            console.log("     Use /plugin list to see available plugins.");
            console.log();
            break;
          }

          pluginManager.discover();
          const infoPlugin = pluginManager.getPlugin(pluginName);
          if (!infoPlugin) {
            console.log(
              `  ${C.err("❌ Plugin")} "${pluginName}" ${C.err("not found.")}`,
            );
            console.log("     Use /plugin list to see available plugins.");
            console.log();
            break;
          }

          // Extract schema and hints from TypeScript source (falls back to manifest)
          await pluginManager.extractSchemaAndHints(pluginName);

          const m = infoPlugin.manifest;
          const stateIcon =
            infoPlugin.state === "enabled"
              ? "🟢"
              : infoPlugin.state === "disabled"
                ? "⏸️ "
                : "⚪";

          // ── Header ───────────────────────────────────────
          console.log(
            `  🔌 ${C.tool(m.name)} v${m.version}  ${stateIcon}${infoPlugin.approved ? " 🔒" : ""}`,
          );
          console.log(`     ${C.dim(m.description)}`);
          console.log();

          // ── Host modules ────────────────────────────────
          console.log(
            `     ${C.label("Host modules:")} ${m.hostModules.map((h) => C.val(`host:${h}`)).join(", ")}`,
          );
          console.log(
            `     ${C.label("State:")}        ${C.val(infoPlugin.state)}${infoPlugin.approved ? C.ok(" (approved)") : ""}`,
          );

          // ── Audit summary (if available) ─────────────────
          if (infoPlugin.audit) {
            const a = infoPlugin.audit;
            console.log(
              `     ${C.label("Risk:")}         ${C.warn(a.riskLevel)}  \u2014  ${a.recommendation.verdict}`,
            );
            console.log(`     ${C.label("Summary:")}      ${a.summary}`);
          }
          console.log();

          // ── Config schema ───────────────────────────────
          // Use extracted schema or fall back to manifest
          const schema = infoPlugin.schema ?? m.configSchema ?? {};
          const schemaEntries = Object.entries(schema);
          if (schemaEntries.length === 0) {
            console.log("     No configurable options.");
          } else {
            // Determine which keys are prompted interactively
            const promptKeysArr = infoPlugin.promptKeys ?? m.promptKeys;
            const promptSet = promptKeysArr ? new Set(promptKeysArr) : null; // null = all prompted

            console.log("     Config options:");
            console.log();
            for (const [key, entry] of schemaEntries) {
              // Type tag with constraints
              const constraints: string[] = [];
              if (entry.minimum !== undefined)
                constraints.push(`min: ${entry.minimum}`);
              if (entry.maximum !== undefined)
                constraints.push(`max: ${entry.maximum}`);
              if (entry.maxLength !== undefined)
                constraints.push(`maxLen: ${entry.maxLength}`);
              const constraintStr =
                constraints.length > 0 ? ` (${constraints.join(", ")})` : "";

              // Default value display
              const hasDefault = entry.default !== undefined;
              const defaultStr = hasDefault
                ? Array.isArray(entry.default)
                  ? `[${(entry.default as string[]).join(", ")}]`
                  : String(entry.default)
                : "none \u2014 required";

              // Prompted-interactively indicator:
              // When promptKeys is defined, clearly distinguish
              // prompted fields from advanced (silently-defaulted) ones.
              let promptTag: string;
              if (promptSet === null) {
                // No promptKeys → all fields are prompted
                promptTag = hasDefault ? "" : " \u2190 prompted";
              } else if (promptSet.has(key)) {
                // Explicitly in promptKeys
                promptTag = hasDefault
                  ? " \u2190 prompted"
                  : " \u2190 prompted (required)";
              } else {
                // Not in promptKeys
                promptTag = hasDefault
                  ? " \u2190 advanced (default applied silently)"
                  : " \u2190 prompted (required, no default)";
              }

              console.log(`       ${key}  (${entry.type}${constraintStr})`);
              console.log(`         ${entry.description}`);
              console.log(`         Default: ${defaultStr}${promptTag}`);
              console.log();
            }
          }

          // ── Hints (concise guidance for LLM) ────────────
          const hints = infoPlugin.hints ?? m.systemMessage;
          if (hints) {
            console.log("     Hints for LLM:");
            console.log();
            // Truncate to first 500 chars for info display
            const truncated =
              hints.length > 500 ? hints.slice(0, 500) + "..." : hints;
            for (const line of truncated.split("\n").slice(0, 10)) {
              console.log(`       ${C.dim(line)}`);
            }
            if (hints.length > 500 || hints.split("\n").length > 10) {
              console.log(
                `       ${C.dim("(truncated - see systemMessage for full text)")}`,
              );
            }
            console.log();
          }

          // ── Example enable command ─────────────────────
          // Build an example showing required fields and
          // one optional override to hint at the syntax.
          const requiredKeys = schemaEntries
            .filter(([, e]) => e.default === undefined)
            .map(
              ([k, e]) =>
                `${k}=${e.type === "array" ? "val1,val2" : `<${e.type}>`}`,
            );
          const optionalKeys = schemaEntries
            .filter(([, e]) => e.default !== undefined)
            .slice(0, 1) // just one example
            .map(([k, e]) => {
              const val = Array.isArray(e.default)
                ? (e.default as string[]).join(",")
                : String(e.default);
              return `${k}=${val}`;
            });
          const exampleArgs = [...requiredKeys, ...optionalKeys].join(" ");
          if (exampleArgs) {
            console.log(
              `     Example: /plugin enable ${m.name} ${exampleArgs}`,
            );
          } else {
            console.log(`     Example: /plugin enable ${m.name}`);
          }
          console.log();
          break;
        }

        // ── /plugin enable <name> [key=value ...] ───────
        case "enable": {
          if (!pluginName) {
            console.log("  Usage: /plugin enable <name> [key=value ...]");
            console.log("     Use /plugin list to see available plugins.");
            console.log("     Use /plugin info <name> to see config options.");
            console.log("     Inline config overrides schema defaults, e.g.:");
            console.log(
              "     /plugin enable fs-read baseDir=/tmp maxFileSizeKb=2048",
            );
            console.log();
            break;
          }

          pluginManager.discover();
          const targetPlugin = pluginManager.getPlugin(pluginName);
          if (!targetPlugin) {
            console.log(
              `  ${C.err("❌ Plugin")} "${pluginName}" ${C.err("not found.")}`,
            );
            console.log("     Use /plugin list to see available plugins.");
            console.log();
            break;
          }

          // Parse inline config args (everything after the plugin name)
          const inlineConfigArgs = parts.slice(3);
          const hasInlineConfig = inlineConfigArgs.length > 0;

          // ── Reconfigure-in-place when already enabled ─────
          // If the user passes inline config overrides to an
          // already-enabled plugin, apply them and rebuild the
          // sandbox rather than silently ignoring the change.
          if (targetPlugin.state === "enabled") {
            if (!hasInlineConfig) {
              console.log(`  ℹ️  "${pluginName}" is already enabled.`);
              console.log(`     To reconfigure, pass key=value overrides:`);
              console.log(
                `     /plugin enable ${pluginName} allowedContentTypes=[application/json,text/plain,text/html]`,
              );
              console.log();
              break;
            }

            // Apply the inline overrides to the running config
            const { parseInlineConfig } =
              await import("../plugin-system/manager.js");
            const inlineKV = parseInlineConfig(inlineConfigArgs);
            const applied = pluginManager.applyInlineConfig(
              pluginName,
              inlineKV,
            );

            if (applied.length === 0) {
              console.log(
                `  ⚠️  No recognised config keys in: ${inlineConfigArgs.join(" ")}`,
              );
              console.log(
                `     Use /plugin info ${pluginName} to see available settings.`,
              );
              console.log();
              break;
            }

            // Mark sandbox dirty so it rebuilds with the new config
            pluginManager.markSandboxDirty();

            console.log(`  🔄 "${pluginName}" reconfigured:`);
            for (const key of applied) {
              const val = targetPlugin.config[key];
              const display = Array.isArray(val)
                ? `[${(val as string[]).join(", ")}]`
                : String(val);
              console.log(`     ${key} = ${display}`);
            }
            console.log("     Changes take effect on the next message.");
            console.log();
            break;
          }

          // ── Fast-path: approved plugins skip audit ───
          // Even approved plugins are checked against the operator's
          // current risk threshold — the config file may have been
          // tightened since the approval was granted.
          if (targetPlugin.approved) {
            const storedRisk = targetPlugin.audit?.riskLevel;
            if (
              storedRisk &&
              exceedsRiskThreshold(storedRisk, operatorConfig.maxRiskLevel)
            ) {
              console.log(
                `  🚫 "${pluginName}" is approved but its risk level (${storedRisk}) exceeds` +
                  ` the operator threshold (max: ${operatorConfig.maxRiskLevel}).`,
              );
              console.log(
                `     Update maxRiskLevel in ~/.hyperagent/config.json to allow ${storedRisk} or above.`,
              );
              console.log();
              break;
            }
            console.log(`  🔒 "${pluginName}" is approved — skipping audit.`);

            // Extract schema and hints from TypeScript source (falls back to manifest)
            await pluginManager.extractSchemaAndHints(pluginName);
            // Refresh plugin reference after extraction
            const refreshedPlugin = pluginManager.getPlugin(pluginName)!;

            if (hasInlineConfig) {
              const { parseInlineConfig } =
                await import("../plugin-system/manager.js");
              const inlineKV = parseInlineConfig(inlineConfigArgs);
              const applied = pluginManager.applyInlineConfig(
                pluginName,
                inlineKV,
              );
              if (applied.length > 0) {
                console.log(`  ${C.label("⚙️  Config overrides:")}`);
                const updatedPlugin = pluginManager.getPlugin(pluginName);
                for (const key of applied) {
                  const val = updatedPlugin?.config[key];
                  const displayVal = Array.isArray(val)
                    ? val.join(", ")
                    : String(val);
                  console.log(`     ${C.dim(key + ":")} ${displayVal}`);
                }
              }
              const coveredKeys = new Set(Object.keys(inlineKV));
              // Use extracted schema (now populated) or fall back to manifest
              const schema =
                refreshedPlugin.schema ??
                refreshedPlugin.manifest.configSchema ??
                {};
              const hasUncovered = Object.keys(schema).some(
                (k) => !coveredKeys.has(k),
              );
              if (hasUncovered) {
                const uncoveredFields = Object.keys(schema).filter(
                  (k) => !coveredKeys.has(k),
                );
                console.log(
                  `\n  ⚙️  Configure remaining fields for "${pluginName}":`,
                );
                console.log(`     Fields: ${uncoveredFields.join(", ")}`);
                await pluginManager.promptConfig(
                  rl,
                  pluginName,
                  coveredKeys,
                  state.autoApprove,
                );
              }
            } else {
              // Use extracted schema (now populated) or fall back to manifest
              const schema =
                refreshedPlugin.schema ??
                refreshedPlugin.manifest.configSchema ??
                {};
              if (Object.keys(schema).length > 0) {
                console.log(`\n  ⚙️  Configure "${pluginName}":`);
                await pluginManager.promptConfig(
                  rl,
                  pluginName,
                  undefined,
                  state.autoApprove,
                );
              }
            }

            // ── Final config summary and approval ─────
            const configSummary = pluginManager.formatConfigSummary(pluginName);
            if (configSummary.length > 0) {
              console.log(`\n  📋 Final configuration for "${pluginName}":`);
              for (const line of configSummary) {
                console.log(`    ${line}`);
              }

              await drainAndWarn(rl);
              const finalApprove = state.autoApprove
                ? "y"
                : await rl.question(
                    `\n  ${C.dim("Enable with this configuration? [y/n] ")}`,
                  );
              if (finalApprove.trim().toLowerCase() !== "y") {
                console.log(`  ${C.dim("Plugin not enabled.")}`);
                console.log();
                break;
              }
            }

            // Load source before enabling — syncPluginsToSandbox needs
            // plugin.source for verifySourceHash(). Without this, the
            // hash check fails and the plugin is silently disabled.
            if (!pluginManager.loadSource(pluginName)) {
              console.log(
                `  ${C.err("❌ Failed to load source for")} "${pluginName}". Plugin will not be enabled.`,
              );
              console.log();
              break;
            }

            pluginManager.enable(pluginName);
            console.log(
              `  ✅ Plugin "${pluginName}" enabled (approved fast-path).`,
            );
            console.log("     Changes take effect on the next message.");

            // Check for companion plugins
            const fastPathCompanions = pluginManager.getCompanions(pluginName);
            if (fastPathCompanions.length > 0) {
              console.log(
                `  🔗 Companion${fastPathCompanions.length > 1 ? "s" : ""} needed: ${fastPathCompanions.join(", ")}`,
              );
              const fpParentConfig =
                pluginManager.getPlugin(pluginName)?.config ?? {};
              for (const comp of fastPathCompanions) {
                const sharedArgs: string[] = [];
                // Pass all parent config through unconditionally.
                // Companions ignore keys they don't understand.
                // This avoids relying on schema extraction timing.
                for (const [key, val] of Object.entries(fpParentConfig)) {
                  if (val !== undefined) {
                    // If baseDir is empty (auto-temp), create a shared temp
                    // dir so both plugins use the same directory.
                    if (
                      key === "baseDir" &&
                      (val === "" || val === undefined)
                    ) {
                      const sharedDir = join(
                        tmpdir(),
                        `hyperlight-fs-${randomUUID().slice(0, 16)}`,
                      );
                      mkdirSync(sharedDir, { recursive: true });
                      sharedArgs.push(`baseDir=${sharedDir}`);
                      // Also update parent to use the same shared dir
                      fpParentConfig.baseDir = sharedDir;
                      const parentPlugin = pluginManager.getPlugin(pluginName);
                      if (parentPlugin) parentPlugin.config.baseDir = sharedDir;
                    } else {
                      sharedArgs.push(`${key}=${val}`);
                    }
                  }
                }
                const inlineConfig =
                  sharedArgs.length > 0 ? ` ${sharedArgs.join(" ")}` : "";
                console.log(`\n  🔗 Auto-enabling companion "${comp}"...`);
                if (sharedArgs.length > 0) {
                  console.log(
                    `     Inheriting config: ${sharedArgs.join(", ")}`,
                  );
                }
                await handleSlashCommand(
                  `/plugin enable ${comp}${inlineConfig}`,
                  rl,
                  deps,
                );
              }
            }

            console.log();
            break;
          }

          // ── Step 1: Load source and audit ────────────
          const source = pluginManager.loadSource(pluginName);
          if (!source) {
            console.log(
              `  ${C.err("❌ Could not load source for")} "${pluginName}".`,
            );
            console.log();
            break;
          }

          // Extract schema and hints from TypeScript source (falls back to manifest)
          await pluginManager.extractSchemaAndHints(pluginName);

          let auditResult = pluginManager.getCachedAudit(source);
          if (auditResult) {
            console.log("     (using cached audit result)");
          } else if (state.copilotClient) {
            // Retry loop — gives the operator a chance to re-run the
            // LLM audit if the first attempt fails (network blip,
            // model timeout, etc.), rather than silently falling back
            // to a low-quality static-only result.
            let attemptAudit = true;
            while (attemptAudit) {
              attemptAudit = false; // one shot unless the user retries
              const { callback: auditProgress, getTracePath } =
                makeAuditProgressCallback(spinner, state.verboseOutput);
              spinner.start(`Auditing "${pluginName}"...`);
              const { controller: auditAbort, cleanup: auditAbortCleanup } =
                createAuditAbortHandler(spinner);
              try {
                auditResult = await deepAudit(
                  state.copilotClient,
                  source,
                  targetPlugin.manifest,
                  state.currentModel,
                  auditProgress,
                  state.debugEnabled,
                  auditAbort.signal,
                  state.auditReasoningEffort ?? undefined,
                );
                auditAbortCleanup();
              } catch (err) {
                auditAbortCleanup();
                spinner.stop();
                console.log(
                  `  ⚠️  LLM audit failed: ${(err as Error).message}`,
                );
                if (getTracePath()) {
                  console.log(`  📝 Trace log: ${getTracePath()}`);
                }

                // Ask the operator what to do — don't silently produce garbage
                await drainAndWarn(rl);
                const answer = state.autoApprove
                  ? "s"
                  : await rl.question(
                      `\n  ${C.warn("What would you like to do?")}\n` +
                        `     ${C.dim("[R]etry / [s]tatic-only / [a]bort: ")}`,
                    );
                const choice = answer.trim().toLowerCase();
                if (choice === "r" || choice === "retry" || choice === "") {
                  console.log(`  🔄 Retrying audit...`);
                  attemptAudit = true;
                  continue;
                } else if (choice === "a" || choice === "abort") {
                  console.log(`  ⏹️  Aborted — plugin not enabled.`);
                  console.log();
                  auditResult = null;
                  break;
                }
                // Fall through: "s" / "static" / anything else → static-only
                console.log("     Proceeding with static scan only.");
                const staticFindings = pluginManager.runStaticScan(pluginName);
                const hasDanger = staticFindings.some(
                  (f) => f.severity === "danger",
                );
                auditResult = {
                  contentHash: contentHash(source),
                  auditedAt: new Date().toISOString(),
                  findings: staticFindings,
                  riskLevel: hasDanger ? ("HIGH" as const) : ("LOW" as const),
                  summary: "Static scan only — LLM audit unavailable",
                  descriptionAccurate: false,
                  capabilities: [],
                  riskReasons: [
                    "LLM audit unavailable — risk assessed from static scan only",
                  ],
                  recommendation: {
                    verdict: hasDanger
                      ? ("reject" as const)
                      : ("approve-with-conditions" as const),
                    reason:
                      "LLM audit failed — review static scan findings manually",
                  },
                };
              } finally {
                spinner.stop();
              }
            }
            // User chose abort — bail out of the enable flow entirely
            if (!auditResult) break;
          } else {
            const staticFindings = pluginManager.runStaticScan(pluginName);
            const hasDanger = staticFindings.some(
              (f) => f.severity === "danger",
            );
            auditResult = {
              contentHash: contentHash(source),
              auditedAt: new Date().toISOString(),
              findings: staticFindings,
              riskLevel: hasDanger ? ("HIGH" as const) : ("LOW" as const),
              summary: "Static scan only — no client available",
              descriptionAccurate: false,
              capabilities: [],
              riskReasons: [
                "No audit client available — risk assessed from static scan only",
              ],
              recommendation: {
                verdict: hasDanger
                  ? ("reject" as const)
                  : ("approve-with-conditions" as const),
                reason: "No LLM client — review static scan findings manually",
              },
            };
          }

          pluginManager.setAuditResult(pluginName, auditResult);
          console.log(formatAuditResult(auditResult, pluginName));

          // ── Step 2: User approval after audit ──────────
          // The user has seen the audit report — now ask them
          // explicitly whether they want to enable this plugin.
          const verdict = auditResult.recommendation?.verdict ?? "unknown";
          const approvalPrompt =
            verdict === "reject"
              ? `  ${C.warn("⚠️  Auditor recommends REJECTION.")} Enable anyway? [y/n] `
              : verdict === "approve-with-conditions"
                ? `  ${C.dim("Auditor recommends APPROVE WITH CONDITIONS. Enable? [y/n] ")}`
                : `  ${C.dim("Enable plugin based on audit? [y/n] ")}`;
          await drainAndWarn(rl);
          const approveAnswer = state.autoApprove
            ? "y"
            : await rl.question(approvalPrompt);
          if (approveAnswer.trim().toLowerCase() !== "y") {
            console.log(`  ${C.dim("Plugin not enabled.")}`);
            console.log();
            break;
          }

          // ── Step 3: Enforce operator risk threshold ─────
          if (
            exceedsRiskThreshold(
              auditResult.riskLevel,
              operatorConfig.maxRiskLevel,
            )
          ) {
            console.log(
              `  🚫 Plugin "${pluginName}" rated ${auditResult.riskLevel} — exceeds` +
                ` operator threshold (max: ${operatorConfig.maxRiskLevel}).`,
            );
            console.log(
              `     This plugin cannot be enabled under the current policy.`,
            );
            console.log(
              `     To allow ${auditResult.riskLevel}-risk plugins, update maxRiskLevel` +
                ` in ~/.hyperagent/config.json`,
            );
            console.log();
            break;
          }

          // ── Step 4: Configure ────────────────────────
          if (hasInlineConfig) {
            const { parseInlineConfig } =
              await import("../plugin-system/manager.js");
            const inlineKV = parseInlineConfig(inlineConfigArgs);
            const applied = pluginManager.applyInlineConfig(
              pluginName,
              inlineKV,
            );
            if (applied.length > 0) {
              console.log(`  ${C.label("⚙️  Config overrides:")}`);
              const updatedPlugin = pluginManager.getPlugin(pluginName);
              for (const key of applied) {
                const val = updatedPlugin?.config[key];
                const displayVal = Array.isArray(val)
                  ? val.join(", ")
                  : String(val);
                console.log(`     ${C.dim(key + ":")} ${displayVal}`);
              }
            }
            const coveredKeys = new Set(Object.keys(inlineKV));
            // Use extracted schema or fall back to manifest
            const schema =
              targetPlugin.schema ?? targetPlugin.manifest.configSchema ?? {};
            const hasUncovered = Object.keys(schema).some(
              (k) => !coveredKeys.has(k),
            );
            if (hasUncovered) {
              const uncoveredFields = Object.keys(schema).filter(
                (k) => !coveredKeys.has(k),
              );
              console.log(
                `\n  ⚙️  Configure remaining fields for "${pluginName}":`,
              );
              console.log(`     Fields: ${uncoveredFields.join(", ")}`);
              await pluginManager.promptConfig(
                rl,
                pluginName,
                coveredKeys,
                state.autoApprove,
              );
            }
          } else {
            // Use extracted schema or fall back to manifest
            const schema =
              targetPlugin.schema ?? targetPlugin.manifest.configSchema ?? {};
            if (Object.keys(schema).length > 0) {
              console.log(`\n  ⚙️  Configure "${pluginName}":`);
              await pluginManager.promptConfig(
                rl,
                pluginName,
                undefined,
                state.autoApprove,
              );
            }
          }

          // ── Step 5: Final config summary and approval ──
          const configSummary = pluginManager.formatConfigSummary(pluginName);
          if (configSummary.length > 0) {
            console.log(`\n  📋 Final configuration for "${pluginName}":`);
            for (const line of configSummary) {
              console.log(`    ${line}`);
            }

            await drainAndWarn(rl);
            const finalApprove = state.autoApprove
              ? "y"
              : await rl.question(
                  `\n  ${C.dim("Enable with this configuration? [y/n] ")}`,
                );
            if (finalApprove.trim().toLowerCase() !== "y") {
              console.log(`  ${C.dim("Plugin not enabled.")}`);
              console.log();
              break;
            }
          }

          // ── Step 6: Enable ───────────────────────────
          pluginManager.enable(pluginName);
          console.log(`  ✅ Plugin "${pluginName}" enabled.`);
          console.log("     Changes take effect on the next message.");

          // Check for companion plugins
          const companions = pluginManager.getCompanions(pluginName);
          if (companions.length > 0) {
            console.log(
              `\n  🔗 Companion plugin${companions.length > 1 ? "s" : ""}: ${companions.join(", ")}`,
            );
            console.log(
              `     ${C.dim(`"${pluginName}" requires ${companions.length > 1 ? "these plugins" : "this plugin"} — enabling automatically.`)}`,
            );
            // Build inline config from parent's config — share common
            // keys (e.g. baseDir) so companions use the same directory.
            const parentConfig =
              pluginManager.getPlugin(pluginName)?.config ?? {};
            for (const comp of companions) {
              const sharedArgs: string[] = [];
              // Pass all parent config through unconditionally.
              // Companions ignore keys they don't understand.
              // This avoids relying on schema extraction timing.
              for (const [key, val] of Object.entries(parentConfig)) {
                if (val !== undefined) {
                  // If baseDir is empty (auto-temp), create a shared temp
                  // dir so both plugins use the same directory.
                  if (key === "baseDir" && (val === "" || val === undefined)) {
                    const sharedDir = join(
                      tmpdir(),
                      `hyperlight-fs-${randomUUID().slice(0, 16)}`,
                    );
                    mkdirSync(sharedDir, { recursive: true });
                    sharedArgs.push(`baseDir=${sharedDir}`);
                    // Also update parent to use the same shared dir
                    parentConfig.baseDir = sharedDir;
                    const parentPlugin = pluginManager.getPlugin(pluginName);
                    if (parentPlugin) parentPlugin.config.baseDir = sharedDir;
                  } else {
                    sharedArgs.push(`${key}=${val}`);
                  }
                }
              }
              const inlineConfig =
                sharedArgs.length > 0 ? ` ${sharedArgs.join(" ")}` : "";
              console.log(`\n  🔗 Auto-enabling companion "${comp}"...`);
              if (sharedArgs.length > 0) {
                console.log(`     Inheriting config: ${sharedArgs.join(", ")}`);
              }
              await handleSlashCommand(
                `/plugin enable ${comp}${inlineConfig}`,
                rl,
                deps,
              );
            }
          }

          console.log();
          break;
        }

        // ── /plugin disable <name> ──────────────────────
        case "disable": {
          if (!pluginName) {
            console.log("  Usage: /plugin disable <name>");
            console.log();
            break;
          }
          const success = pluginManager.disable(pluginName);
          if (success) {
            console.log(`  ⏸️  Plugin "${pluginName}" disabled.`);
            console.log("     Changes take effect on the next message.");
          } else {
            const p = pluginManager.getPlugin(pluginName);
            if (!p) {
              console.log(
                `  ${C.err("❌ Plugin")} "${pluginName}" ${C.err("not found.")}`,
              );
            } else {
              console.log(
                `  ℹ️  "${pluginName}" is not enabled (state: ${p.state}).`,
              );
            }
          }
          console.log();
          break;
        }

        // ── /plugin approve <name> ──────────────────────
        case "approve": {
          if (!pluginName) {
            console.log("  Usage: /plugin approve <name>");
            console.log(
              "     Approved plugins skip audit on /plugin enable (fast-path).",
            );
            console.log(
              "     Approval is invalidated if the plugin source changes.",
            );
            console.log();
            break;
          }

          pluginManager.discover();
          const approveTarget = pluginManager.getPlugin(pluginName);
          if (!approveTarget) {
            console.log(
              `  ${C.err("❌ Plugin")} "${pluginName}" ${C.err("not found.")}`,
            );
            console.log();
            break;
          }

          if (approveTarget.approved) {
            console.log(`  ℹ️  "${pluginName}" is already approved.`);
            console.log();
            break;
          }

          if (!approveTarget.audit) {
            console.log(
              `  ${C.err("❌")} "${pluginName}" ${C.err("must be audited before approval.")}`,
            );
            console.log("     Run /plugin audit or /plugin enable first.");
            console.log();
            break;
          }

          // Check risk threshold before granting approval
          if (
            exceedsRiskThreshold(
              approveTarget.audit.riskLevel,
              operatorConfig.maxRiskLevel,
            )
          ) {
            console.log(
              `  🚫 "${pluginName}" rated ${approveTarget.audit.riskLevel} — exceeds` +
                ` operator threshold (max: ${operatorConfig.maxRiskLevel}).`,
            );
            console.log(
              `     Cannot approve plugins above ${operatorConfig.maxRiskLevel} risk.`,
            );
            console.log(
              `     Update maxRiskLevel in ~/.hyperagent/config.json to change.`,
            );
            console.log();
            break;
          }

          const approved = pluginManager.approve(pluginName);
          if (approved) {
            console.log(`  🔒 Plugin "${pluginName}" approved.`);
            console.log(
              "     Approval persists across sessions until the source changes or you /plugin unapprove.",
            );
          } else {
            console.log(`  ${C.err("❌ Could not approve")} "${pluginName}".`);
          }
          console.log();
          break;
        }

        // ── /plugin unapprove <name> ────────────────────
        case "unapprove": {
          if (!pluginName) {
            console.log("  Usage: /plugin unapprove <name>");
            console.log();
            break;
          }

          const unapproved = pluginManager.unapprove(pluginName);
          if (unapproved) {
            console.log(`  🔓 Plugin "${pluginName}" approval removed.`);
            console.log("     Next /plugin enable will require a full audit.");
          } else {
            const p = pluginManager.getPlugin(pluginName);
            if (!p) {
              console.log(
                `  ${C.err("❌ Plugin")} "${pluginName}" ${C.err("not found.")}`,
              );
            } else {
              console.log(`  ℹ️  "${pluginName}" is not currently approved.`);
            }
          }
          console.log();
          break;
        }

        // ── /plugin audit <name> [--verbose|-v] ────────
        case "audit": {
          // Parse flags — --verbose or -v anywhere in parts[2:]
          const auditArgs = parts.slice(2);
          const verboseAudit =
            auditArgs.includes("--verbose") || auditArgs.includes("-v");
          // Plugin name is the first non-flag arg
          const auditPluginName = auditArgs.find((a) => !a.startsWith("-"));
          if (!auditPluginName) {
            console.log("  Usage: /plugin audit <name> [--verbose]");
            console.log();
            break;
          }
          const auditTarget = pluginManager.getPlugin(auditPluginName);
          if (!auditTarget) {
            console.log(
              `  ${C.err("❌ Plugin")} "${auditPluginName}" ${C.err("not found.")}`,
            );
            console.log();
            break;
          }
          const auditSource = pluginManager.loadSource(auditPluginName);
          if (!auditSource) {
            console.log(
              `  ${C.err("❌ Could not load source for")} "${auditPluginName}".`,
            );
            console.log();
            break;
          }
          console.log(`  🔍 Auditing "${auditPluginName}"...`);
          if (state.copilotClient) {
            // Retry loop — operator gets a chance to re-run the audit
            // on transient failures instead of losing all progress.
            let attemptAudit = true;
            while (attemptAudit) {
              attemptAudit = false;
              const { callback: auditProgress, getTracePath } =
                makeAuditProgressCallback(spinner, state.verboseOutput);
              spinner.start(`Auditing "${auditPluginName}"...`);
              const { controller: auditAbort, cleanup: auditAbortCleanup } =
                createAuditAbortHandler(spinner);
              try {
                const result = await deepAudit(
                  state.copilotClient,
                  auditSource,
                  auditTarget.manifest,
                  state.currentModel,
                  auditProgress,
                  state.debugEnabled,
                  auditAbort.signal,
                  state.auditReasoningEffort ?? undefined,
                );
                auditAbortCleanup();
                spinner.stop();
                if (getTracePath()) {
                  console.log(`  📝 Trace log: ${getTracePath()}`);
                }
                pluginManager.setAuditResult(auditPluginName, result);
                console.log(
                  formatAuditResult(result, auditPluginName, {
                    verbose: verboseAudit,
                  }),
                );
              } catch (err) {
                auditAbortCleanup();
                spinner.stop();
                const errObj = err as Error;
                console.log(`  ${C.err("❌ Audit failed:")} ${errObj.message}`);
                // Always log the full stack to stderr for tracing.
                console.error("[audit-trace] Full error:");
                console.error(errObj.stack ?? errObj);

                await drainAndWarn(rl);
                const answer = state.autoApprove
                  ? "n"
                  : await rl.question(
                      `\n  ${C.warn("Retry the audit?")} ${C.dim("[Y]es / [n]o: ")}`,
                    );
                const choice = answer.trim().toLowerCase();
                if (
                  choice === "" ||
                  choice === "y" ||
                  choice === "yes" ||
                  choice === "r" ||
                  choice === "retry"
                ) {
                  console.log(`  🔄 Retrying audit...`);
                  attemptAudit = true;
                  continue;
                }
              }
            }
          } else {
            const findings = pluginManager.runStaticScan(auditPluginName);
            console.log("  📋 Static scan only (no client):");
            for (const f of findings) {
              const icon =
                f.severity === "danger"
                  ? "🔴"
                  : f.severity === "warning"
                    ? "⚠️ "
                    : "ℹ️ ";
              console.log(
                `     ${icon} ${f.message}${f.line ? ` (line ${f.line})` : ""}`,
              );
            }
            if (findings.length === 0) {
              console.log("     ✅ No issues found.");
            }
          }
          console.log();
          break;
        }

        // ── /plugin (no subcommand or unknown) ──────────
        default: {
          // Fuzzy-match the typo against known subcommands.
          const PLUGIN_SUBS = [
            "list",
            "enable",
            "disable",
            "approve",
            "unapprove",
            "audit",
          ];
          if (subCmd) {
            const best = closestMatch(subCmd, PLUGIN_SUBS);
            if (best) {
              console.log(
                `  ${C.warn("❓ Unknown subcommand")} "${subCmd}". Did you mean ${C.info('"' + best + '"')}?`,
              );
              console.log(
                `     /plugin ${best} ${parts.slice(2).join(" ")}`.trimEnd(),
              );
            } else {
              console.log(`  ❓ Unknown subcommand "${subCmd}".`);
            }
          }
          console.log(
            "  Usage: /plugin <list|enable|disable|approve|unapprove|audit>",
          );
          console.log("     Type /help for details.");
          console.log();
          break;
        }
      }

      return true;
    }

    case "/skills": {
      // Resolve skills dir: in dev mode go up two levels (src/agent/ → repo root),
      // in binary mode runtime content is alongside the bundle.
      const __scDirname = dirname(new URL(import.meta.url).pathname);
      const skillsDir = existsSync(join(__scDirname, "skills"))
        ? join(__scDirname, "skills")
        : resolve(__scDirname, "../..", "skills");
      const skillArg = parts[1]?.trim();

      if (!skillArg) {
        // List available skills
        try {
          const { readdirSync, readFileSync, existsSync } =
            await import("node:fs");
          if (!existsSync(skillsDir)) {
            console.log("  No skills directory found.");
            return true;
          }
          const dirs = readdirSync(skillsDir, { withFileTypes: true }).filter(
            (d) => d.isDirectory(),
          );
          if (dirs.length === 0) {
            console.log("  No skills found.");
            return true;
          }
          console.log(
            `  ${C.label("📚 Available skills")} (${dirs.length}):\n`,
          );
          for (const dir of dirs) {
            const skillFile = join(skillsDir, dir.name, "SKILL.md");
            if (existsSync(skillFile)) {
              const content = readFileSync(skillFile, "utf8");
              // Extract description from YAML frontmatter
              const descMatch = content.match(/^description:\s*(.+)$/m);
              const desc = descMatch ? descMatch[1] : "(no description)";
              console.log(`     /${dir.name}`);
              console.log(`     ${C.dim(desc)}\n`);
            }
          }
          console.log(`  ${C.dim("Invoke: /skills <name> or /<name>")}`);
        } catch {
          console.log("  Error reading skills directory.");
        }
        return true;
      }

      // Invoke a specific skill by name — delegate to the SDK's
      // skill handling via the slash command
      console.log(`  ${C.info("📚")} Invoking skill: ${C.tool(skillArg)}`);
      // The SDK handles /skill-name natively — just fall through
      return false;
    }

    case "/clear": {
      // ANSI escape: clear screen + move cursor to top-left
      process.stderr.write("\x1b[2J\x1b[H");
      return true;
    }

    case "/profile": {
      const subCmd = parts[1]?.toLowerCase() ?? "";
      const profileArg = parts.slice(2).join(" ").trim();

      if (subCmd === "" || subCmd === "list") {
        // /profile or /profile list — show all profiles
        const { formatAllProfiles } = await import("./profiles.js");
        console.log(`\n  📋 Available profiles:\n`);
        console.log(
          formatAllProfiles()
            .split("\n")
            .map((l) => `  ${l}`)
            .join("\n"),
        );
        console.log(
          `\n  ${C.dim("Use /profile apply <name> [name2 ...] to apply.")}`,
        );
        console.log(
          `  ${C.dim("The LLM can also call apply_profile() directly.")}`,
        );
        console.log();
      } else if (subCmd === "apply") {
        if (!profileArg) {
          console.log(
            `  ${C.warn("Usage:")} /profile apply <name> [name2 ...]`,
          );
          console.log(
            `  ${C.dim("Stack multiple: /profile apply web-research heavy-compute")}`,
          );
          console.log();
          return true;
        }
        // Parse profile names (space-separated)
        const names = profileArg.split(/\s+/);
        const { mergeProfiles, getProfileNames } =
          await import("./profiles.js");
        const merged = mergeProfiles(names);
        if (merged.error) {
          console.log(`  ${C.err("❌ " + merged.error)}`);
          console.log();
          return true;
        }

        // Apply limits
        const { applySandboxConfig, getEffectiveConfig } =
          await import("./config-actions.js");

        const currentConfig = getEffectiveConfig(deps.sandbox, deps.state);
        const limitsToApply: Record<string, number> = {};

        if (
          merged.limits.cpuTimeoutMs !== undefined &&
          merged.limits.cpuTimeoutMs > currentConfig.cpuTimeoutMs
        )
          limitsToApply.cpuTimeout = merged.limits.cpuTimeoutMs;
        if (
          merged.limits.wallTimeoutMs !== undefined &&
          merged.limits.wallTimeoutMs > currentConfig.wallTimeoutMs
        )
          limitsToApply.wallTimeout = merged.limits.wallTimeoutMs;
        if (
          merged.limits.heapMb !== undefined &&
          merged.limits.heapMb > currentConfig.heapMb
        )
          limitsToApply.heap = merged.limits.heapMb;
        if (
          merged.limits.scratchMb !== undefined &&
          merged.limits.scratchMb > currentConfig.scratchMb
        )
          limitsToApply.scratch = merged.limits.scratchMb;
        if (
          merged.limits.inputBufferKb !== undefined &&
          merged.limits.inputBufferKb > currentConfig.inputBufferKb
        )
          limitsToApply.inputBuffer = merged.limits.inputBufferKb;
        if (
          merged.limits.outputBufferKb !== undefined &&
          merged.limits.outputBufferKb > currentConfig.outputBufferKb
        )
          limitsToApply.outputBuffer = merged.limits.outputBufferKb;

        if (Object.keys(limitsToApply).length > 0) {
          const configResult = await applySandboxConfig(
            deps.sandbox,
            deps.state,
            limitsToApply,
          );
          if (configResult.success) {
            console.log(
              `  ${C.ok("✅ Limits applied:")} ${configResult.message}`,
            );
            if (configResult.sandboxRebuilt) {
              deps.state.sessionNeedsRebuild = true;
            }
          } else {
            console.log(`  ${C.err("❌ " + configResult.error)}`);
          }
        } else {
          console.log(
            `  ${C.dim("Limits: current values already meet or exceed profile.")}`,
          );
        }

        // Enable required plugins
        for (const plugin of merged.plugins) {
          const existing = deps.pluginManager.getPlugin(plugin.name);
          if (existing?.state === "enabled") {
            console.log(`  ${C.dim(`Plugin ${plugin.name}: already enabled`)}`);
            continue;
          }
          // Delegate to /plugin enable
          const configStr = plugin.defaultConfig
            ? " " +
              Object.entries(plugin.defaultConfig)
                .map(([k, v]) => {
                  if (Array.isArray(v)) return `${k}=[${v.join(",")}]`;
                  return `${k}=${v}`;
                })
                .join(" ")
            : "";
          await handleSlashCommand(
            `/plugin enable ${plugin.name}${configStr}`,
            rl,
            deps,
          );
        }

        const profileLabel = merged.appliedProfiles.join(" + ");
        console.log(`  ${C.ok("📋 Profile applied:")} ${profileLabel}`);
        console.log();
      } else if (subCmd === "show") {
        // /profile show — show current effective config
        const { getEffectiveConfig } = await import("./config-actions.js");
        const config = getEffectiveConfig(deps.sandbox, deps.state);
        console.log(`\n  📋 Current effective configuration:`);
        console.log(`     CPU timeout:    ${config.cpuTimeoutMs}ms`);
        console.log(`     Wall timeout:   ${config.wallTimeoutMs}ms`);
        console.log(`     Heap:           ${config.heapMb}MB`);
        console.log(`     Scratch:        ${config.scratchMb}MB`);
        console.log(`     Input buffer:   ${config.inputBufferKb}KB`);
        console.log(`     Output buffer:  ${config.outputBufferKb}KB`);

        // Show enabled plugins
        const enabled = deps.pluginManager
          .listPlugins()
          .filter((p) => p.state === "enabled");
        if (enabled.length > 0) {
          console.log(
            `     Plugins:        ${enabled.map((p) => p.manifest.name).join(", ")}`,
          );
        } else {
          console.log(`     Plugins:        none`);
        }
        console.log();
      } else {
        console.log(`  ${C.warn("Usage:")} /profile [list|apply|show]`);
        console.log(
          `  ${C.dim("/profile list              — show available profiles")}`,
        );
        console.log(
          `  ${C.dim("/profile apply <name> ...  — apply profile(s)")}`,
        );
        console.log(
          `  ${C.dim("/profile show              — show current config")}`,
        );
        console.log();
      }
      return true;
    }

    case "/module": {
      const subCmd = parts[1]?.toLowerCase() ?? "";
      const moduleArg = parts.slice(2).join(" ").trim();

      if (subCmd === "" || subCmd === "list") {
        // /module list — show all modules
        const { listModules } = await import("./module-store.js");
        const { formatExports } = await import("./format-exports.js");
        const modules = listModules();
        if (modules.length === 0) {
          console.log(`\n  ${C.dim("No modules registered.")}`);
        } else {
          console.log(`\n  📦 Modules (${modules.length}):\n`);
          for (const m of modules) {
            const badge = m.author === "system" ? C.dim("[system]") : "[user]";
            const lock = m.mutable ? "" : " 🔒";
            console.log(
              `  ${C.tool(m.name)} ${badge}${lock} — ${m.description}`,
            );
            const exStr = formatExports(m.exports);
            if (exStr !== "(no exports found)") {
              for (const line of exStr.split("\n")) {
                console.log(`    ${C.dim(line)}`);
              }
            }
          }
        }
        console.log(
          `\n  ${C.dim('Import in handlers: import { fn } from "ha:<name>"')}`,
        );
        console.log();
      } else if (subCmd === "info") {
        if (!moduleArg) {
          console.log(`  ${C.warn("Usage:")} /module info <name>`);
          console.log();
          return true;
        }
        const { loadModule } = await import("./module-store.js");
        const { formatExports } = await import("./format-exports.js");
        const info = loadModule(moduleArg);
        if (!info) {
          console.log(`  ${C.err("❌ Module not found:")} ${moduleArg}`);
          console.log();
          return true;
        }
        const badge = info.author === "system" ? "[system]" : "[user]";
        console.log(`\n  📦 ${C.tool(info.name)} ${badge}`);
        console.log(`     ${info.description}`);
        console.log(`     Author: ${info.author}`);
        console.log(`     Mutable: ${info.mutable}`);
        console.log(`     Created: ${info.created}`);
        console.log(`     Modified: ${info.modified}`);
        console.log(`     Size: ${info.sizeBytes} bytes`);
        console.log(`     Import: import { ... } from "ha:${info.name}"`);
        console.log(`\n     Exports:`);
        const exStr = formatExports(info.exports);
        for (const line of exStr.split("\n")) {
          console.log(`       ${line}`);
        }
        console.log(`\n     Source:`);
        for (const line of info.source.split("\n").slice(0, 30)) {
          console.log(`       ${C.dim(line)}`);
        }
        if (info.source.split("\n").length > 30) {
          console.log(
            `       ${C.dim(`... (${info.source.split("\n").length - 30} more lines)`)}`,
          );
        }
        console.log();
      } else if (subCmd === "delete") {
        if (!moduleArg) {
          console.log(`  ${C.warn("Usage:")} /module delete <name>`);
          console.log();
          return true;
        }
        const { loadModule, deleteModuleFromDisk } =
          await import("./module-store.js");
        const info = loadModule(moduleArg);
        if (!info) {
          console.log(`  ${C.err("❌ Module not found:")} ${moduleArg}`);
          console.log();
          return true;
        }
        if (info.author === "system") {
          console.log(
            `  ${C.err("❌ Cannot delete system module:")} ${moduleArg}`,
          );
          console.log();
          return true;
        }
        try {
          deleteModuleFromDisk(moduleArg);
          // Also remove from sandbox cache so it's no longer importable
          await deps.sandbox.deleteModule(moduleArg);
          console.log(`  ${C.ok("🗑️  Module deleted:")} ${moduleArg}`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`  ${C.err("❌ " + msg)}`);
        }
        console.log();
      } else if (subCmd === "lock") {
        if (!moduleArg) {
          console.log(`  ${C.warn("Usage:")} /module lock <name>`);
          console.log();
          return true;
        }
        const { setModuleMutable } = await import("./module-store.js");
        try {
          setModuleMutable(moduleArg, false);
          console.log(`  ${C.ok("🔒 Module locked:")} ${moduleArg}`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`  ${C.err("❌ " + msg)}`);
        }
        console.log();
      } else if (subCmd === "unlock") {
        if (!moduleArg) {
          console.log(`  ${C.warn("Usage:")} /module unlock <name>`);
          console.log();
          return true;
        }
        const { setModuleMutable } = await import("./module-store.js");
        try {
          setModuleMutable(moduleArg, true);
          console.log(`  ${C.ok("🔓 Module unlocked:")} ${moduleArg}`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`  ${C.err("❌ " + msg)}`);
        }
        console.log();
      } else {
        console.log(
          `  ${C.warn("Usage:")} /module [list|info|delete|lock|unlock]`,
        );
        console.log(
          `  ${C.dim("/module list              — show all modules")}`,
        );
        console.log(
          `  ${C.dim("/module info <name>       — detailed module info")}`,
        );
        console.log(
          `  ${C.dim("/module delete <name>     — delete user module")}`,
        );
        console.log(
          `  ${C.dim("/module lock <name>       — protect from modification")}`,
        );
        console.log(
          `  ${C.dim("/module unlock <name>     — allow modification")}`,
        );
        console.log();
      }
      return true;
    }

    // ── MCP Commands ─────────────────────────────────────────
    //
    // MCP server management. Only available when the mcp plugin is enabled.

    case "/mcp": {
      // Gate: MCP plugin must be enabled
      const mcpPlugin = deps.pluginManager.getPlugin("mcp");
      if (!mcpPlugin || mcpPlugin.state !== "enabled") {
        console.log(
          `  ${C.err("MCP plugin not enabled.")} Run ${C.info("/plugin enable mcp")} first.`,
        );
        console.log();
        return true;
      }

      if (!deps.mcpManager) {
        console.log(`  ${C.err("MCP manager not initialised.")}`);
        console.log();
        return true;
      }

      const mcpSubCmd = parts[1]?.toLowerCase();
      const mcpName = parts[2];

      switch (mcpSubCmd) {
        // ── /mcp list ────────────────────────────────────
        case "list": {
          const servers = deps.mcpManager.listServers();
          if (servers.length === 0) {
            console.log(
              `  No MCP servers configured. Add servers to ${C.dim("~/.hyperagent/config.json")}`,
            );
          } else {
            console.log(`  ${C.label("MCP Servers")} (${servers.length}):\n`);
            for (const s of servers) {
              const stateColor =
                s.state === "connected"
                  ? C.ok(s.state)
                  : s.state === "error"
                    ? C.err(s.state)
                    : C.dim(s.state);
              const tools =
                s.state === "connected" ? ` — ${s.tools.length} tool(s)` : "";
              console.log(`  ${C.label(s.name)}  [${stateColor}]${tools}`);
              console.log(
                `    ${C.dim(`${s.config.command} ${(s.config.args ?? []).join(" ")}`)}`,
              );
            }
          }
          console.log();
          return true;
        }

        // ── /mcp enable <name> ───────────────────────────
        case "enable": {
          if (!mcpName) {
            console.log(`  Usage: ${C.info("/mcp enable <server-name>")}`);
            console.log();
            return true;
          }

          const conn = deps.mcpManager.getConnection(mcpName);
          if (!conn) {
            console.log(
              `  ${C.err(`Unknown MCP server: "${mcpName}"`)}. Check ~/.hyperagent/config.json`,
            );
            console.log();
            return true;
          }

          if (conn.state === "connected") {
            console.log(`  ${C.ok(`"${mcpName}" is already connected.`)}`);
            console.log();
            return true;
          }

          try {
            // Connect and discover tools
            console.log(`  Connecting to ${C.label(mcpName)}...`);
            const connected = await deps.mcpManager.connect(mcpName);

            // Audit tool descriptions
            const warnings = auditMCPTools(connected.tools);

            // Check approval
            const approvalStore = loadMCPApprovalStore();
            const approved = isMCPApproved(mcpName, conn.config, approvalStore);

            if (!approved) {
              // Show approval prompt
              console.log();
              console.log(`  ${C.label("MCP Server Approval Required")}`);
              console.log();
              console.log(`  Server:  ${C.label(mcpName)}`);
              console.log(
                `  Command: ${C.dim(`${conn.config.command} ${(conn.config.args ?? []).join(" ")}`)}`,
              );

              if (conn.config.env) {
                console.log(`  Env vars:`);
                for (const [k, v] of Object.entries(conn.config.env)) {
                  console.log(`    ${k}=${C.dim(maskEnvValue(v))}`);
                }
              }

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
              console.log(
                `  ${C.err("⚠️  This MCP server runs as a full OS process with YOUR permissions.")}`,
              );
              console.log(`  ${C.err("   It is NOT sandboxed.")}`);
              console.log();

              // Auto-approve in auto-approve mode
              if (deps.state.autoApprove) {
                console.log(`  ${C.ok("Auto-approved")} (--auto-approve mode)`);
              } else {
                await deps.drainAndWarn(rl);
                const answer = await rl.question(
                  `  Approve "${mcpName}"? (y/n) `,
                );
                if (answer.trim().toLowerCase() !== "y") {
                  console.log(`  ${C.dim("Cancelled.")}`);
                  await deps.mcpManager.disconnect(mcpName);
                  console.log();
                  return true;
                }
              }

              // Store approval
              approveMCPServer(
                mcpName,
                conn.config,
                connected.tools.map((t) => t.name),
                warnings,
                approvalStore,
              );
            }

            // Sync to sandbox
            await deps.syncPlugins();

            console.log(
              `  ${C.ok(`✓ "${mcpName}" enabled`)} — ${connected.tools.length} tool(s) available as ${C.dim(`host:mcp-${mcpName}`)}`,
            );
          } catch (err) {
            console.log(
              `  ${C.err(`Failed to enable "${mcpName}": ${(err as Error).message}`)}`,
            );
          }
          console.log();
          return true;
        }

        // ── /mcp disable <name> ──────────────────────────
        case "disable": {
          if (!mcpName) {
            console.log(`  Usage: ${C.info("/mcp disable <server-name>")}`);
            console.log();
            return true;
          }

          await deps.mcpManager.disconnect(mcpName);
          await deps.syncPlugins();
          console.log(`  ${C.ok(`"${mcpName}" disconnected.`)}`);
          console.log();
          return true;
        }

        // ── /mcp info <name> ─────────────────────────────
        case "info": {
          if (!mcpName) {
            console.log(`  Usage: ${C.info("/mcp info <server-name>")}`);
            console.log();
            return true;
          }

          const info = deps.mcpManager.getConnection(mcpName);
          if (!info) {
            console.log(`  ${C.err(`Unknown MCP server: "${mcpName}"`)}`);
            console.log();
            return true;
          }

          console.log(`  ${C.label(mcpName)}`);
          console.log(`  State:   ${info.state}`);
          console.log(
            `  Command: ${info.config.command} ${(info.config.args ?? []).join(" ")}`,
          );
          if (info.config.allowTools) {
            console.log(`  Allow:   ${info.config.allowTools.join(", ")}`);
          }
          if (info.config.denyTools) {
            console.log(`  Deny:    ${info.config.denyTools.join(", ")}`);
          }

          if (info.tools.length > 0) {
            console.log();
            console.log(`  Tools (${info.tools.length}):`);
            for (const tool of info.tools) {
              console.log(`    ${C.label(tool.name)}`);
              console.log(`      ${C.dim(tool.description.slice(0, 120))}`);
            }

            console.log();
            console.log(`  ${C.dim("TypeScript declarations:")}`);
            console.log(C.dim(generateMCPDeclarations(mcpName, info.tools)));
          }
          console.log();
          return true;
        }

        // ── /mcp approve <name> ──────────────────────────
        case "approve": {
          if (!mcpName) {
            console.log(`  Usage: ${C.info("/mcp approve <server-name>")}`);
            console.log();
            return true;
          }

          const conn2 = deps.mcpManager.getConnection(mcpName);
          if (!conn2) {
            console.log(`  ${C.err(`Unknown MCP server: "${mcpName}"`)}`);
            console.log();
            return true;
          }

          const store = loadMCPApprovalStore();
          approveMCPServer(mcpName, conn2.config, [], [], store);
          console.log(`  ${C.ok(`"${mcpName}" pre-approved.`)}`);
          console.log();
          return true;
        }

        // ── /mcp revoke <name> ───────────────────────────
        case "revoke": {
          if (!mcpName) {
            console.log(`  Usage: ${C.info("/mcp revoke <server-name>")}`);
            console.log();
            return true;
          }

          const store2 = loadMCPApprovalStore();
          if (revokeMCPApproval(mcpName, store2)) {
            console.log(`  ${C.ok(`Approval revoked for "${mcpName}".`)}`);
          } else {
            console.log(`  ${C.dim(`"${mcpName}" was not approved.`)}`);
          }
          console.log();
          return true;
        }

        default: {
          console.log(`  ${C.label("MCP Commands:")}`);
          console.log(
            `  ${C.dim("/mcp list              — show configured servers")}`,
          );
          console.log(
            `  ${C.dim("/mcp enable <name>     — approve and connect")}`,
          );
          console.log(`  ${C.dim("/mcp disable <name>    — disconnect")}`);
          console.log(
            `  ${C.dim("/mcp info <name>       — show tools and details")}`,
          );
          console.log(`  ${C.dim("/mcp approve <name>    — pre-approve")}`);
          console.log(`  ${C.dim("/mcp revoke <name>     — remove approval")}`);
          console.log();
          return true;
        }
      }
    }

    case "/help": {
      const helpTopic = parts.slice(1).join(" ").trim();
      if (helpTopic) {
        const topicHelp = renderTopicHelp(helpTopic);
        if (topicHelp) {
          console.log(topicHelp);
        } else {
          console.log(`  ❓ No help found for "${helpTopic}".`);
          console.log(
            "     Try /help plugin, /help timeout, or /help <command>.",
          );
          console.log();
        }
      } else {
        console.log(renderHelp());
      }
      return true;
    }

    default: {
      // Check if it's a skill invocation — skills are handled by the SDK,
      // not by our slash command handler. Return false to pass through.
      const __scDir = dirname(new URL(import.meta.url).pathname);
      const skillsDir = existsSync(join(__scDir, "skills"))
        ? join(__scDir, "skills")
        : resolve(__scDir, "../..", "skills");
      try {
        const { existsSync } = await import("node:fs");
        const skillName = cmd.slice(1); // remove leading /
        const skillPath = join(skillsDir, skillName, "SKILL.md");
        if (existsSync(skillPath)) {
          console.log(`  ${C.info("📚")} Invoking skill: ${C.tool(skillName)}`);
          return false; // Let SDK handle it
        }
      } catch {
        // Ignore — fall through to unknown command
      }

      console.log(
        `  ${C.warn("❓ Unknown command:")} ${cmd}. Type ${C.info("/help")} for available commands.`,
      );
      console.log();
      return true;
    }
  }
}
