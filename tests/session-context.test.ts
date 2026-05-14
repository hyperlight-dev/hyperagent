// ── Session Context Tests ───────────────────────────────────────────
//
// Covers extractSessionContext + renderSessionContext.  Both are pure
// functions of `AgentState`, so we build a minimal hand-rolled state
// object rather than spinning up a real session.
//
// ─────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import {
  extractSessionContext,
  renderSessionContext,
} from "../src/agent/session-context.js";
import type { AgentState } from "../src/agent/state.js";

/**
 * Build a minimal `AgentState` that satisfies the structural fields the
 * session-context functions read.  Everything else is left as a
 * placeholder cast — never accessed by the code under test.
 */
function makeState(
  overrides: Partial<
    Pick<
      AgentState,
      | "toolCallHistory"
      | "mcpServersUsed"
      | "modulesRegistered"
      | "currentUserPrompt"
    >
  > = {},
): AgentState {
  // Cast through unknown so we don't have to fill in every unrelated
  // field of AgentState — `extractSessionContext` only reads the four
  // fields above.
  return {
    toolCallHistory: [],
    mcpServersUsed: new Set<string>(),
    modulesRegistered: [],
    currentUserPrompt: "",
    ...overrides,
  } as unknown as AgentState;
}

describe("extractSessionContext", () => {
  it("returns empty context for an unused session", () => {
    const ctx = extractSessionContext(makeState());
    expect(ctx.totalToolCalls).toBe(0);
    expect(ctx.failedToolCalls).toBe(0);
    expect(ctx.topTools).toEqual([]);
    expect(ctx.mcpServersUsed).toEqual([]);
    expect(ctx.modulesRegistered).toEqual([]);
    expect(ctx.errorsSeen).toEqual([]);
    expect(ctx.userPrompt).toBe("");
  });

  it("aggregates tool counts and sorts descending by count", () => {
    const ctx = extractSessionContext(
      makeState({
        toolCallHistory: [
          { tool: "execute_javascript", success: true, timestamp: 1 },
          { tool: "execute_javascript", success: true, timestamp: 2 },
          { tool: "execute_javascript", success: true, timestamp: 3 },
          { tool: "register_handler", success: true, timestamp: 4 },
          { tool: "list_modules", success: true, timestamp: 5 },
          { tool: "register_handler", success: true, timestamp: 6 },
        ],
      }),
    );
    expect(ctx.topTools).toEqual([
      { tool: "execute_javascript", count: 3 },
      { tool: "register_handler", count: 2 },
      { tool: "list_modules", count: 1 },
    ]);
    expect(ctx.totalToolCalls).toBe(6);
    expect(ctx.failedToolCalls).toBe(0);
  });

  it("counts failures and deduplicates error summaries", () => {
    const ctx = extractSessionContext(
      makeState({
        toolCallHistory: [
          {
            tool: "execute_javascript",
            success: false,
            errorSummary: "Out of memory",
            timestamp: 1,
          },
          {
            tool: "execute_javascript",
            success: false,
            errorSummary: "Out of memory",
            timestamp: 2,
          },
          {
            tool: "execute_bash",
            success: false,
            errorSummary: "Permission denied",
            timestamp: 3,
          },
          { tool: "list_modules", success: true, timestamp: 4 },
        ],
      }),
    );
    expect(ctx.failedToolCalls).toBe(3);
    expect(ctx.errorsSeen).toEqual(["Out of memory", "Permission denied"]);
  });

  it("sorts mcpServersUsed and modulesRegistered alphabetically", () => {
    const ctx = extractSessionContext(
      makeState({
        mcpServersUsed: new Set(["zebra", "alpha", "mike"]),
        modulesRegistered: ["zebra-mod", "alpha-mod", "mike-mod"],
      }),
    );
    expect(ctx.mcpServersUsed).toEqual(["alpha", "mike", "zebra"]);
    expect(ctx.modulesRegistered).toEqual([
      "alpha-mod",
      "mike-mod",
      "zebra-mod",
    ]);
  });

  it("propagates currentUserPrompt verbatim", () => {
    const ctx = extractSessionContext(
      makeState({ currentUserPrompt: "Find the Teams transcript" }),
    );
    expect(ctx.userPrompt).toBe("Find the Teams transcript");
  });

  it("truncates the user prompt when it exceeds the cap", () => {
    // The cap is an internal constant (MAX_USER_PROMPT_CHARS = 2000),
    // but the contract is: long prompts come back truncated with an
    // ellipsis so a giant paste cannot dominate the saved context.
    const giant = "x".repeat(5000);
    const ctx = extractSessionContext(makeState({ currentUserPrompt: giant }));
    expect(ctx.userPrompt.length).toBeLessThan(giant.length);
    expect(ctx.userPrompt.endsWith("…")).toBe(true);
    // Short prompts pass through untouched (regression guard).
    const short = extractSessionContext(
      makeState({ currentUserPrompt: "short prompt" }),
    );
    expect(short.userPrompt).toBe("short prompt");
  });

  it("caps the topTools list at 10 entries", () => {
    // Build 15 distinct tools each called once, plus one called 20 times.
    const history: AgentState["toolCallHistory"] = [];
    for (let i = 0; i < 20; i++) {
      history.push({ tool: "popular", success: true, timestamp: i });
    }
    for (let i = 0; i < 15; i++) {
      history.push({ tool: `tool-${i}`, success: true, timestamp: 100 + i });
    }
    const ctx = extractSessionContext(makeState({ toolCallHistory: history }));
    expect(ctx.topTools).toHaveLength(10);
    expect(ctx.topTools[0].tool).toBe("popular");
    expect(ctx.topTools[0].count).toBe(20);
  });

  it("does not mutate the input state", () => {
    const state = makeState({
      toolCallHistory: [
        { tool: "execute_javascript", success: true, timestamp: 1 },
      ],
      mcpServersUsed: new Set(["server-a"]),
      modulesRegistered: ["mod-a"],
    });
    const beforeSize = state.mcpServersUsed.size;
    extractSessionContext(state);
    extractSessionContext(state);
    expect(state.toolCallHistory).toHaveLength(1);
    expect(state.mcpServersUsed.size).toBe(beforeSize);
    expect(state.modulesRegistered).toEqual(["mod-a"]);
  });
});

describe("renderSessionContext", () => {
  it("omits sections that have no data", () => {
    const text = renderSessionContext({
      userPrompt: "",
      topTools: [],
      mcpServersUsed: [],
      modulesRegistered: [],
      errorsSeen: [],
      totalToolCalls: 0,
      failedToolCalls: 0,
    });
    expect(text).not.toMatch(/Top tools used/);
    expect(text).not.toMatch(/MCP servers used/);
    expect(text).not.toMatch(/Modules registered/);
    expect(text).not.toMatch(/Errors/);
    expect(text).toMatch(/Tool activity: 0 calls/);
  });

  it("emits each populated section in a stable order", () => {
    const text = renderSessionContext({
      userPrompt: "Original task",
      topTools: [{ tool: "execute_javascript", count: 5 }],
      mcpServersUsed: ["workiq"],
      modulesRegistered: ["teams-transcript"],
      errorsSeen: ["Permission denied"],
      totalToolCalls: 10,
      failedToolCalls: 1,
    });
    expect(text).toMatch(/Original prompt: Original task/);
    expect(text).toMatch(/Tool activity: 10 calls \(1 failed\)/);
    expect(text).toMatch(/Top tools used:\n {2}• execute_javascript ×5/);
    expect(text).toMatch(/MCP servers used: workiq/);
    expect(text).toMatch(/Modules registered: teams-transcript/);
    expect(text).toMatch(/Errors \/ dead-ends/);
    expect(text).toMatch(/• Permission denied/);
  });
});
