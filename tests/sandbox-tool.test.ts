// ── Shared Sandbox Tool — Integration Tests ─────────────────────────
//
// Lightweight tests for the shared sandbox-tool module. The MCP server
// tests already cover the sandbox in depth; these focus on verifying
// the shared module's API surface and basic lifecycle.
//
// ─────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

import { createSandboxTool, parsePositiveInt } from "../src/sandbox/tool.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BUILTIN_DIR = join(__dirname, "..", "builtin-modules");

/** Read a builtin module source file, stripping the metadata header. */
function readModule(name: string): { name: string; source: string } {
  const raw = readFileSync(join(BUILTIN_DIR, `${name}.js`), "utf-8");
  // Strip leading comment header lines + blank line after
  const lines = raw.split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim().startsWith("//")) i++;
  if (i < lines.length && lines[i].trim() === "") i++;
  return { name, source: lines.slice(i).join("\n") };
}

/**
 * Load the modules required for shared-state auto-preservation.
 * Must be called on any sandbox tool that uses ha:shared-state
 * across recompiles (the auto-save/restore needs _save and _restore modules).
 */
function loadSaveRestoreModules(
  tool: ReturnType<typeof createSandboxTool>,
): void {
  tool.setModules([
    readModule("shared-state"),
    readModule("_save"),
    readModule("_restore"),
  ]);
}

function u16(data: Uint8Array, offset: number): number {
  return data[offset]! | (data[offset + 1]! << 8);
}

function u32(data: Uint8Array, offset: number): number {
  return (
    data[offset]! |
    (data[offset + 1]! << 8) |
    (data[offset + 2]! << 16) |
    (data[offset + 3]! << 24)
  );
}

function parseZipEntries(bytes: readonly number[]): Map<string, Uint8Array> {
  const zip = Uint8Array.from(bytes);
  const entries = new Map<string, Uint8Array>();
  let offset = 0;

  while (offset + 30 <= zip.length && u32(zip, offset) === 0x04034b50) {
    const method = u16(zip, offset + 8);
    const compressedSize = u32(zip, offset + 18);
    const fileNameLength = u16(zip, offset + 26);
    const extraLength = u16(zip, offset + 28);
    const nameStart = offset + 30;
    const nameEnd = nameStart + fileNameLength;
    const dataStart = nameEnd + extraLength;
    const dataEnd = dataStart + compressedSize;
    const name = Buffer.from(zip.subarray(nameStart, nameEnd)).toString("utf8");
    const compressed = zip.subarray(dataStart, dataEnd);

    if (method === 0) {
      entries.set(name, compressed);
    } else if (method === 8) {
      entries.set(name, new Uint8Array(inflateRawSync(compressed)));
    } else {
      throw new Error(
        `Unsupported ZIP compression method ${method} for ${name}`,
      );
    }

    offset = dataEnd;
  }

  return entries;
}

function zipText(entries: Map<string, Uint8Array>, name: string): string {
  const entry = entries.get(name);
  if (!entry) throw new Error(`Missing ZIP entry: ${name}`);
  return Buffer.from(entry).toString("utf8");
}

// ── parsePositiveInt ─────────────────────────────────────────────────

describe("parsePositiveInt", () => {
  it("should return default for undefined", () => {
    expect(parsePositiveInt(undefined, 42)).toBe(42);
  });

  it("should return default for empty string", () => {
    expect(parsePositiveInt("", 42)).toBe(42);
  });

  it("should parse a valid positive integer string", () => {
    expect(parsePositiveInt("100", 42)).toBe(100);
  });

  it("should return default for negative numbers", () => {
    expect(parsePositiveInt("-5", 42)).toBe(42);
  });

  it("should return default for zero", () => {
    expect(parsePositiveInt("0", 42)).toBe(42);
  });

  it("should return default for non-numeric strings", () => {
    expect(parsePositiveInt("not-a-number", 42)).toBe(42);
  });

  it("should return default for floating-point strings", () => {
    expect(parsePositiveInt("3.14", 42)).toBe(42);
  });

  it("should accept numeric values directly", () => {
    expect(parsePositiveInt(7, 42)).toBe(7);
  });
});

// ── createSandboxTool ────────────────────────────────────────────────

describe("createSandboxTool", () => {
  it("should return a frozen config with default values", () => {
    const tool = createSandboxTool();
    expect(tool.config).toBeDefined();
    expect(tool.config.cpuTimeoutMs).toBe(1000);
    expect(tool.config.wallClockTimeoutMs).toBe(5000);
    expect(tool.config.heapSizeMb).toBe(16);
    expect(tool.config.scratchSizeMb).toBe(16);
    expect(tool.config.heapSizeBytes).toBe(16 * 1024 * 1024);
    expect(tool.config.scratchSizeBytes).toBe(16 * 1024 * 1024);
    expect(tool.config.inputBufferKb).toBe(1040);
    expect(tool.config.outputBufferKb).toBe(1040);
    expect(tool.config.inputBufferBytes).toBe(1040 * 1024);
    expect(tool.config.outputBufferBytes).toBe(1040 * 1024);
    expect(Object.isFrozen(tool.config)).toBe(true);
  });

  it("should accept explicit configuration overrides", () => {
    const tool = createSandboxTool({
      cpuTimeoutMs: 500,
      wallClockTimeoutMs: 2000,
      heapSizeMb: 8,
      scratchSizeMb: 5,
      inputBufferKb: 128,
      outputBufferKb: 32,
    });
    expect(tool.config.cpuTimeoutMs).toBe(500);
    expect(tool.config.wallClockTimeoutMs).toBe(2000);
    expect(tool.config.heapSizeMb).toBe(8);
    expect(tool.config.scratchSizeMb).toBe(5);
    expect(tool.config.heapSizeBytes).toBe(8 * 1024 * 1024);
    expect(tool.config.scratchSizeBytes).toBe(5 * 1024 * 1024);
    expect(tool.config.inputBufferKb).toBe(128);
    expect(tool.config.outputBufferKb).toBe(32);
    expect(tool.config.inputBufferBytes).toBe(128 * 1024);
    expect(tool.config.outputBufferBytes).toBe(32 * 1024);
  });

  it("should expose required API functions", () => {
    const tool = createSandboxTool();
    expect(typeof tool.initializeSandbox).toBe("function");
    expect(typeof tool.executeJavaScript).toBe("function");
    expect(typeof tool.writeTiming).toBe("function");
    expect(typeof tool.writeCode).toBe("function");
    expect(typeof tool.setPlugins).toBe("function");
    expect(typeof tool.setBufferSizes).toBe("function");
    expect(typeof tool.resetBufferSizes).toBe("function");
    expect(typeof tool.getEffectiveBufferSizes).toBe("function");
  });

  it("should return a frozen tool instance", () => {
    const tool = createSandboxTool();
    expect(Object.isFrozen(tool)).toBe(true);
  });
});

// ── Buffer Management ────────────────────────────────────────────────

describe("buffer management", () => {
  it("should return config defaults from getEffectiveBufferSizes", () => {
    const tool = createSandboxTool({ inputBufferKb: 64, outputBufferKb: 64 });
    const sizes = tool.getEffectiveBufferSizes();
    expect(sizes.inputKb).toBe(64);
    expect(sizes.outputKb).toBe(64);
  });

  it("should reflect overrides from setBufferSizes", async () => {
    const tool = createSandboxTool({ inputBufferKb: 64, outputBufferKb: 64 });
    await tool.setBufferSizes(128, undefined);
    expect(tool.getEffectiveBufferSizes().inputKb).toBe(128);
    expect(tool.getEffectiveBufferSizes().outputKb).toBe(64);

    await tool.setBufferSizes(undefined, 256);
    expect(tool.getEffectiveBufferSizes().inputKb).toBe(128);
    expect(tool.getEffectiveBufferSizes().outputKb).toBe(256);
  });

  it("should reset overrides to config defaults", async () => {
    const tool = createSandboxTool({ inputBufferKb: 32, outputBufferKb: 48 });
    await tool.setBufferSizes(128, 256);
    expect(tool.getEffectiveBufferSizes().inputKb).toBe(128);
    expect(tool.getEffectiveBufferSizes().outputKb).toBe(256);

    await tool.resetBufferSizes();
    expect(tool.getEffectiveBufferSizes().inputKb).toBe(32);
    expect(tool.getEffectiveBufferSizes().outputKb).toBe(48);
  });

  it("should execute correctly with custom buffer sizes", async () => {
    // Use 128KB buffers — larger than default
    const tool = createSandboxTool({ inputBufferKb: 128, outputBufferKb: 128 });
    await tool.registerHandler("buf", 'return { bufferTest: "working" };');
    const { success, result } = await tool.executeJavaScript("buf");
    expect(success).toBe(true);
    expect(result).toEqual({ bufferTest: "working" });
  });
});

// ── Handler Registration ─────────────────────────────────────────────

describe("registerHandler", () => {
  const tool = createSandboxTool({
    cpuTimeoutMs: 2000,
    wallClockTimeoutMs: 5000,
  });

  it("should register a handler and return handler list", async () => {
    const r = await tool.registerHandler("calc", "return 42;");
    expect(r.success).toBe(true);
    expect(r.handlers).toContain("calc");
  });

  it("should accept module-mode code", async () => {
    const code = [
      "let n = 0;",
      "function handler(event) { n++; return { n }; }",
    ].join("\n");
    const r = await tool.registerHandler("counter", code);
    expect(r.success).toBe(true);
    expect(r.handlers).toContain("counter");
  });

  it("should execute module handlers with custom parameter names", async () => {
    const code = "function handler(input) { return { value: input.value }; }";
    const r = await tool.registerHandler("custom-param", code);
    expect(r.success).toBe(true);

    const exec = await tool.executeJavaScript("custom-param", { value: 42 });
    expect(exec.success).toBe(true);
    expect(exec.result).toEqual({ value: 42 });
  });

  it("should execute module handlers without parameters", async () => {
    const code = 'function handler() { return { value: "no-input" }; }';
    const r = await tool.registerHandler("no-param", code);
    expect(r.success).toBe(true);

    const exec = await tool.executeJavaScript("no-param", { ignored: true });
    expect(exec.success).toBe(true);
    expect(exec.result).toEqual({ value: "no-input" });
  });

  it("should report no-op when same name+code registered again", async () => {
    const r = await tool.registerHandler("calc", "return 42;");
    expect(r.success).toBe(true);
    expect(r.message).toContain("unchanged");
  });

  it("should detect duplicate code under a different name", async () => {
    const r = await tool.registerHandler("calc_copy", "return 42;");
    expect(r.success).toBe(false);
    expect(r.error).toContain("already registered");
    expect(r.error).toContain("calc");
  });

  it("should allow overwriting a handler with new code", async () => {
    const r = await tool.registerHandler("calc", "return 99;");
    expect(r.success).toBe(true);
    expect(r.message).toContain("updated");
  });

  it("should reject empty name", async () => {
    const r = await tool.registerHandler("", "return 1;");
    expect(r.success).toBe(false);
  });

  it("should reject empty code", async () => {
    const r = await tool.registerHandler("empty", "");
    expect(r.success).toBe(false);
  });
});

// ── Handler Deletion ─────────────────────────────────────────────────

describe("deleteHandler", () => {
  const tool = createSandboxTool({
    cpuTimeoutMs: 2000,
    wallClockTimeoutMs: 5000,
  });

  it("should delete an existing handler", async () => {
    await tool.registerHandler("temp", "return 'bye';");
    const r = await tool.deleteHandler("temp");
    expect(r.success).toBe(true);
    expect(r.handlers).not.toContain("temp");
  });

  it("should error on deleting non-existent handler", async () => {
    const r = await tool.deleteHandler("nonexistent");
    expect(r.success).toBe(false);
    expect(r.error).toContain("not found");
  });
});

// ── getHandlerSource ─────────────────────────────────────────────────

describe("getHandlerSource", () => {
  const tool = createSandboxTool({
    cpuTimeoutMs: 2000,
    wallClockTimeoutMs: 5000,
  });

  it("should return source code for registered handler", async () => {
    await tool.registerHandler("src-test", "return { ok: true };");
    const r = tool.getHandlerSource("src-test");
    expect(r.success).toBe(true);
    expect(r.code).toContain("return { ok: true }");
    expect(r.handlers).toContain("src-test");
  });

  it("should error for non-existent handler", () => {
    const r = tool.getHandlerSource("nonexistent");
    expect(r.success).toBe(false);
    expect(r.error).toContain("not found");
  });

  it("should error for internal handlers", async () => {
    // _save_state exists if modules are loaded
    loadSaveRestoreModules(tool);
    await tool.registerHandler("trigger-internal", "return 1;");
    await tool.executeJavaScript("trigger-internal"); // compiles internal handlers
    const r = tool.getHandlerSource("_save_state");
    expect(r.success).toBe(false);
    expect(r.error).toContain("not accessible");
  });

  it("should error for empty name", () => {
    const r = tool.getHandlerSource("");
    expect(r.success).toBe(false);
    expect(r.error).toContain("non-empty string");
  });

  it("should return line numbers by default", async () => {
    await tool.registerHandler(
      "lined",
      "const a = 1;\nconst b = 2;\nreturn a + b;",
    );
    const r = tool.getHandlerSource("lined");
    expect(r.success).toBe(true);
    expect(r.code).toMatch(/^\s*\d+ \| /m); // Line number format
    expect(r.totalLines).toBeGreaterThan(0);
  });

  it("should support line range extraction", async () => {
    // Use full module mode to avoid wrapper shifting line numbers
    const code = [
      "function handler(event) {",
      ...Array.from(
        { length: 20 },
        (_, i) => `  const line${i + 1} = ${i + 1};`,
      ),
      "  return line1;",
      "}",
      "export { handler };",
    ].join("\n");
    await tool.registerHandler("ranged", code);
    const r = tool.getHandlerSource("ranged", { startLine: 3, endLine: 8 });
    expect(r.success).toBe(true);
    expect(r.startLine).toBe(3);
    expect(r.endLine).toBe(8);
    expect(r.totalLines).toBe(24); // exact count for module code
    // Check range contains lines 3-8 but not line 1
    expect(r.code).toContain("line2"); // line 3 of file
    expect(r.code).toContain("line7"); // line 8 of file
    expect(r.code).not.toContain("function handler"); // line 1 is outside range
  });

  it("should clamp line range to valid bounds", async () => {
    const tool2 = createSandboxTool({
      cpuTimeoutMs: 2000,
      wallClockTimeoutMs: 5000,
    });
    await tool2.registerHandler("clamp-bounds", "return 1;");
    const r = tool2.getHandlerSource("clamp-bounds", {
      startLine: 0,
      endLine: 1000,
    });
    expect(r.success).toBe(true);
    expect(r.startLine).toBe(1);
    expect(r.endLine).toBe(r.totalLines);
  });

  it("should return raw code without line numbers when requested", async () => {
    await tool.registerHandler("raw", "return 42;");
    const r = tool.getHandlerSource("raw", { lineNumbers: false });
    expect(r.success).toBe(true);
    expect(r.code).not.toMatch(/^\s*\d+ \| /m);
  });
});

// ── editHandler ───────────────────────────────────────────────────────

describe("editHandler", () => {
  const tool = createSandboxTool({
    cpuTimeoutMs: 2000,
    wallClockTimeoutMs: 5000,
  });

  it("should edit a handler with unique match", async () => {
    await tool.registerHandler("edit-test", "return { value: 42 };");
    const r = await tool.editHandler("edit-test", "42", "99");
    expect(r.success).toBe(true);
    expect(r.message).toContain("edited");
    expect(r.codeSize).toBeGreaterThan(0);
    // Verify the edit took effect
    const source = tool.getHandlerSource("edit-test", { lineNumbers: false });
    expect(source.code).toContain("99");
    expect(source.code).not.toContain("42");
  });

  it("should fail when oldString not found", async () => {
    await tool.registerHandler("edit-notfound", "return { value: 1 };");
    const r = await tool.editHandler("edit-notfound", "NOTFOUND", "X");
    expect(r.success).toBe(false);
    expect(r.error).toContain("not found");
  });

  it("should fail when oldString matches multiple times", async () => {
    await tool.registerHandler("edit-multi", "return { a: 1, b: 1 };");
    const r = await tool.editHandler("edit-multi", "1", "2");
    expect(r.success).toBe(false);
    expect(r.error).toContain("2 times");
    expect(r.error).toContain("unique");
  });

  it("should fail when handler not found", async () => {
    const r = await tool.editHandler("nonexistent", "a", "b");
    expect(r.success).toBe(false);
    expect(r.error).toContain("not found");
  });

  it("should fail for internal handlers", async () => {
    const r = await tool.editHandler("_save_state", "a", "b");
    expect(r.success).toBe(false);
    expect(r.error).toContain("cannot be edited");
  });

  it("should fail when oldString equals newString", async () => {
    await tool.registerHandler("edit-noop", "return 1;");
    const r = await tool.editHandler("edit-noop", "1", "1");
    expect(r.success).toBe(false);
    expect(r.error).toContain("identical");
  });

  it("should preserve other handlers after edit", async () => {
    await tool.registerHandler("edit-a", "return 'A';");
    await tool.registerHandler("edit-b", "return 'B';");
    await tool.editHandler("edit-a", "'A'", "'AA'");
    const sourceB = tool.getHandlerSource("edit-b", { lineNumbers: false });
    expect(sourceB.code).toContain("'B'");
  });

  it("should return context around the edit", async () => {
    const code = [
      "function handler(event) {",
      "  const x = 1;",
      "  const y = 2;",
      "  const z = 3;",
      "  return x + y + z;",
      "}",
    ].join("\n");
    await tool.registerHandler("edit-context", code);
    const r = await tool.editHandler(
      "edit-context",
      "const y = 2",
      "const y = 22",
    );
    expect(r.success).toBe(true);
    expect(r.contextAfter).toBeDefined();
    expect(r.contextAfter).toContain("22");
  });

  it("should edit a handler by line range", async () => {
    const code = [
      "function handler(event) {",
      "  const title = 'old';",
      "  const height = 0.4;",
      "  return { title, height };",
      "}",
    ].join("\n");
    await tool.registerHandler("edit-lines", code);

    const r = await tool.editHandlerLines(
      "edit-lines",
      3,
      3,
      "  const height = 0.6;",
    );

    expect(r.success).toBe(true);
    expect(r.contextAfter).toContain("0.6");

    const source = tool.getHandlerSource("edit-lines", { lineNumbers: false });
    expect(source.code).toContain("const height = 0.6;");
    expect(source.code).not.toContain("const height = 0.4;");
  });

  it("should reject line edits outside the handler", async () => {
    await tool.registerHandler("edit-lines-range", "return 'range';");
    const r = await tool.editHandlerLines(
      "edit-lines-range",
      20,
      20,
      "return 2;",
    );
    expect(r.success).toBe(false);
    expect(r.error).toContain("outside handler");
  });

  it("should not invalidate loaded sandbox for no-op line edits", async () => {
    const code = [
      "let count = 0;",
      "function handler() {",
      "  count++;",
      "  return { count };",
      "}",
    ].join("\n");
    await tool.registerHandler("edit-lines-noop", code);

    const first = await tool.executeJavaScript("edit-lines-noop");
    expect(first.result).toEqual({ count: 1 });

    const edit = await tool.editHandlerLines(
      "edit-lines-noop",
      3,
      3,
      "  count++;",
    );
    expect(edit.success).toBe(true);
    expect(edit.message).toContain("unchanged");

    const second = await tool.executeJavaScript("edit-lines-noop");
    expect(second.result).toEqual({ count: 2 });
    expect(second.timing!.compileMs).toBe(0);
    expect(second.statePreserved).toBe(true);
  });
});

// ── Execution (Named Handlers) ───────────────────────────────────────

describe("execute_javascript (named handlers)", () => {
  const tool = createSandboxTool({
    cpuTimeoutMs: 2000,
    wallClockTimeoutMs: 5000,
  });

  it("should error when handler not registered", async () => {
    const r = await tool.executeJavaScript("nope");
    expect(r.success).toBe(false);
    expect(r.error).toContain("not registered");
  });

  it("should execute a simple handler", async () => {
    await tool.registerHandler("math", "return { answer: 6 * 7 };");
    const r = await tool.executeJavaScript("math");
    expect(r.success).toBe(true);
    expect(r.result).toEqual({ answer: 42 });
    expect(r.timing).toBeDefined();
    expect(r.stats).toBeDefined();
  });

  it("should pass event data to handler", async () => {
    await tool.registerHandler(
      "greeter",
      [
        "function handler(event) {",
        "  return { hello: event.name };",
        "}",
      ].join("\n"),
    );
    const r = await tool.executeJavaScript("greeter", { name: "World" });
    expect(r.success).toBe(true);
    expect(r.result).toEqual({ hello: "World" });
  });

  it("should accumulate state across calls (module mode)", async () => {
    await tool.registerHandler(
      "accumulator",
      [
        "let items = [];",
        "function handler(event) {",
        "  if (event.action === 'add') { items.push(event.v); return { count: items.length }; }",
        "  if (event.action === 'get') { return { items }; }",
        "}",
      ].join("\n"),
    );

    const r1 = await tool.executeJavaScript("accumulator", {
      action: "add",
      v: "A",
    });
    expect(r1.result).toEqual({ count: 1 });
    expect(r1.statePreserved).toBe(false); // first call after registration

    const r2 = await tool.executeJavaScript("accumulator", {
      action: "add",
      v: "B",
    });
    expect(r2.result).toEqual({ count: 2 });
    expect(r2.statePreserved).toBe(true); // state preserved!

    const r3 = await tool.executeJavaScript("accumulator", { action: "get" });
    expect(r3.result).toEqual({ items: ["A", "B"] });
  });

  it("should handle runtime errors gracefully", async () => {
    await tool.registerHandler(
      "thrower",
      'throw new Error("intentional boom");',
    );
    const r = await tool.executeJavaScript("thrower");
    expect(r.success).toBe(false);
    expect(r.error).toContain("intentional boom");
  });

  it("should enforce CPU timeout", async () => {
    await tool.registerHandler("looper", "while (true) {}");
    const r = await tool.executeJavaScript("looper");
    expect(r.success).toBe(false);
    expect(r.error).toContain("timed out");
  });

  it("should recover after timeout", async () => {
    // Previous test triggered a timeout — verify recovery
    await tool.registerHandler("ok", "return { back: true };");
    const r = await tool.executeJavaScript("ok");
    expect(r.success).toBe(true);
    expect(r.result).toEqual({ back: true });
  });

  it("should execute multiple different handlers", async () => {
    await tool.registerHandler("add", "return event.a + event.b;");
    await tool.registerHandler("mul", "return event.a * event.b;");

    const r1 = await tool.executeJavaScript("add", { a: 3, b: 4 });
    expect(r1.result).toBe(7);

    const r2 = await tool.executeJavaScript("mul", { a: 3, b: 4 });
    expect(r2.result).toBe(12);
  });

  it("should skip compilation when handlers unchanged", async () => {
    // Execute again — handlers haven't changed since last call
    const r = await tool.executeJavaScript("add", { a: 1, b: 2 });
    expect(r.timing!.compileMs).toBe(0);
    expect(r.timing!.setupMs).toBe(0);
    expect(r.statePreserved).toBe(true);
  });

  it("should include stats in result", async () => {
    const r = await tool.executeJavaScript("add", { a: 10, b: 20 });
    expect(r.stats).toBeDefined();
    expect(typeof r.stats!.wallClockMs).toBe("number");
    expect(r.stats!.terminatedBy).toBeNull();
  });
});

// ── Recompile Resets Module-Level Variables ──────────────────────────
//
// Module-level variables (let n = 0) are part of the compiled code and
// reset to their declared initial values on ANY recompile. This is
// distinct from ha:shared-state which is auto-preserved across rebuilds.

describe("recompile resets module-level variables", () => {
  const tool = createSandboxTool({
    cpuTimeoutMs: 2000,
    wallClockTimeoutMs: 5000,
  });

  it("should reset module-level variables when a new handler is added", async () => {
    // Register a handler with a module-level counter (let n = 0)
    await tool.registerHandler(
      "counter",
      ["let n = 0;", "function handler(event) { n++; return { n }; }"].join(
        "\n",
      ),
    );
    await tool.executeJavaScript("counter");
    const r2 = await tool.executeJavaScript("counter");
    expect(r2.result).toEqual({ n: 2 }); // accumulated

    // Add a NEW handler — this changes the handler set
    await tool.registerHandler("other", "return 'hi';");

    // Module-level `let n` re-initialises to 0 after recompile
    const r3 = await tool.executeJavaScript("counter");
    expect(r3.result).toEqual({ n: 1 }); // n starts from 0 again
    expect(r3.statePreserved).toBe(false);
  });

  it("should reset module-level variables when a handler is deleted", async () => {
    // Fresh tool for isolation
    const t = createSandboxTool({
      cpuTimeoutMs: 2000,
      wallClockTimeoutMs: 5000,
    });
    await t.registerHandler(
      "cnt",
      ["let n=0;", "function handler(e) { n++; return {n}; }"].join("\n"),
    );
    await t.registerHandler("extra", "return 1;");

    // Accumulate state
    await t.executeJavaScript("cnt");
    const r = await t.executeJavaScript("cnt");
    expect(r.result).toEqual({ n: 2 });

    // Delete the other handler — handler set changes
    await t.deleteHandler("extra");

    // Module-level `let n` re-initialises to 0 after recompile
    const r2 = await t.executeJavaScript("cnt");
    expect(r2.result).toEqual({ n: 1 }); // n starts from 0 again
  });

  it("should reset module-level variables when handler code is updated", async () => {
    // Fresh tool for isolation
    const t = createSandboxTool({
      cpuTimeoutMs: 2000,
      wallClockTimeoutMs: 5000,
    });
    await t.registerHandler(
      "cnt",
      ["let n=0;", "function handler(e) { n++; return {n}; }"].join("\n"),
    );

    await t.executeJavaScript("cnt");
    const r = await t.executeJavaScript("cnt");
    expect(r.result).toEqual({ n: 2 });

    // Update counter with new code — handler set changes
    await t.registerHandler(
      "cnt",
      ["let n=100;", "function handler(e) { n++; return {n}; }"].join("\n"),
    );

    const r2 = await t.executeJavaScript("cnt");
    expect(r2.result).toEqual({ n: 101 }); // fresh start with new code
  });
});

// ── resetSandbox ─────────────────────────────────────────────────────

describe("resetSandbox", () => {
  const tool = createSandboxTool({
    cpuTimeoutMs: 2000,
    wallClockTimeoutMs: 5000,
  });

  it("should return success", async () => {
    const r = await tool.resetSandbox();
    expect(r.success).toBe(true);
    expect(r.message).toContain("reset");
  });

  it("should preserve handler code but reset module-level variables", async () => {
    await tool.registerHandler(
      "c",
      ["let n=0;", "function handler(e) { n++; return {n}; }"].join("\n"),
    );
    await tool.executeJavaScript("c");
    const r1 = await tool.executeJavaScript("c");
    expect(r1.result).toEqual({ n: 2 });

    // Reset
    const reset = await tool.resetSandbox();
    expect(reset.success).toBe(true);
    expect(reset.handlers).toContain("c"); // handler preserved!

    // Module-level `let n` re-initialises to 0 after recompile
    const r2 = await tool.executeJavaScript("c");
    expect(r2.result).toEqual({ n: 1 }); // n starts from 0 again
  });
});

// ── Internal Handler Protection ──────────────────────────────────────

describe("internal handler protection", () => {
  const tool = createSandboxTool({
    cpuTimeoutMs: 2000,
    wallClockTimeoutMs: 5000,
  });

  it("should block registration of _ prefix handler names", async () => {
    const r = await tool.registerHandler("_sneaky", "return 1;");
    expect(r.success).toBe(false);
    expect(r.error).toContain("reserved");
  });

  it("should block deletion of internal handlers", async () => {
    const r = await tool.deleteHandler("_save_state");
    expect(r.success).toBe(false);
    expect(r.error).toContain("cannot be deleted");
  });

  it("should not include _ handlers in public handler listings", async () => {
    await tool.registerHandler("visible", "return 'I am seen';");
    const r = await tool.registerHandler("also-visible", "return 'me too';");
    expect(r.handlers).toContain("visible");
    expect(r.handlers).toContain("also-visible");
    expect(r.handlers).not.toContain("_save_state");
    expect(r.handlers).not.toContain("_restore_state");
  });

  it("should not include _ handlers in delete response", async () => {
    const r = await tool.deleteHandler("also-visible");
    expect(r.handlers).toContain("visible");
    expect(r.handlers).not.toContain("_save_state");
    expect(r.handlers).not.toContain("_restore_state");
  });

  it("should not include _ handlers in resetSandbox response", async () => {
    const r = await tool.resetSandbox();
    expect(r.handlers).not.toContain("_save_state");
    expect(r.handlers).not.toContain("_restore_state");
  });
});

// ── Auto Shared-State Preservation ───────────────────────────────────

describe("auto shared-state preservation", () => {
  it("should auto-preserve shared-state across handler registration", async () => {
    const tool = createSandboxTool({
      cpuTimeoutMs: 2000,
      wallClockTimeoutMs: 5000,
    });
    loadSaveRestoreModules(tool);

    // Step 1: Register a "researcher" handler that stores data in shared-state
    await tool.registerHandler(
      "researcher",
      [
        'import { set } from "ha:shared-state";',
        "export function handler(event) {",
        "  set('city', event.city);",
        "  set('population', event.population);",
        "  return { stored: true };",
        "}",
      ].join("\n"),
    );

    // Execute researcher to populate shared-state
    const r1 = await tool.executeJavaScript("researcher", {
      city: "London",
      population: 8_800_000,
    });
    expect(r1.success).toBe(true);
    expect(r1.result).toEqual({ stored: true });

    // Step 2: Register a new handler — this triggers recompile
    // Shared-state should be AUTO-PRESERVED (no manual save/restore)
    await tool.registerHandler(
      "builder",
      [
        'import { get } from "ha:shared-state";',
        "export function handler() {",
        "  return { city: get('city'), population: get('population') };",
        "}",
      ].join("\n"),
    );

    // Step 3: Builder sees the auto-preserved data
    const r2 = await tool.executeJavaScript("builder");
    expect(r2.success).toBe(true);
    expect(r2.result).toEqual({ city: "London", population: 8_800_000 });
    expect(r2.statePreserved).toBe(true); // auto-restored
  });

  it("should auto-preserve across reset_sandbox", async () => {
    const tool = createSandboxTool({
      cpuTimeoutMs: 2000,
      wallClockTimeoutMs: 5000,
    });
    loadSaveRestoreModules(tool);

    // Store data
    await tool.registerHandler(
      "store",
      [
        'import { set } from "ha:shared-state";',
        "export function handler() {",
        "  set('key', 'value');",
        "  return { ok: true };",
        "}",
      ].join("\n"),
    );
    await tool.executeJavaScript("store");

    // Reset sandbox — should auto-preserve shared-state
    await tool.resetSandbox();

    // Register reader and verify data is restored
    await tool.registerHandler(
      "reader",
      [
        'import { get } from "ha:shared-state";',
        "export function handler() { return { key: get('key') }; }",
      ].join("\n"),
    );
    const r = await tool.executeJavaScript("reader");
    expect(r.success).toBe(true);
    expect(r.result).toEqual({ key: "value" });
  });

  it("should auto-preserve across multiple handler registrations", async () => {
    const tool = createSandboxTool({
      cpuTimeoutMs: 2000,
      wallClockTimeoutMs: 5000,
    });
    loadSaveRestoreModules(tool);

    // Store data in shared-state
    await tool.registerHandler(
      "storer",
      [
        'import { set } from "ha:shared-state";',
        "export function handler() {",
        "  set('counter', 42);",
        "  return { ok: true };",
        "}",
      ].join("\n"),
    );
    await tool.executeJavaScript("storer");

    // Register multiple new handlers — each triggers recompile
    await tool.registerHandler("h1", "return 'one';");
    await tool.registerHandler("h2", "return 'two';");
    await tool.registerHandler("h3", "return 'three';");

    // Verify data survives all the recompiles
    await tool.registerHandler(
      "checker",
      [
        'import { get } from "ha:shared-state";',
        "export function handler() { return { counter: get('counter') }; }",
      ].join("\n"),
    );
    const r = await tool.executeJavaScript("checker");
    expect(r.success).toBe(true);
    expect(r.result).toEqual({ counter: 42 });
  });

  it("should auto-preserve across handler deletion", async () => {
    const tool = createSandboxTool({
      cpuTimeoutMs: 2000,
      wallClockTimeoutMs: 5000,
    });
    loadSaveRestoreModules(tool);

    // Store data and register disposable handler
    await tool.registerHandler(
      "worker",
      [
        'import { set } from "ha:shared-state";',
        "export function handler() {",
        "  set('result', 'important');",
        "  return true;",
        "}",
      ].join("\n"),
    );
    await tool.registerHandler("temp", "return 'temporary';");

    // Execute worker to populate shared-state (triggers recompile first)
    await tool.executeJavaScript("worker");

    // Delete temp handler — triggers recompile
    await tool.deleteHandler("temp");

    // Verify data survives
    await tool.registerHandler(
      "reader",
      [
        'import { get } from "ha:shared-state";',
        "export function handler() { return { result: get('result') }; }",
      ].join("\n"),
    );
    const r = await tool.executeJavaScript("reader");
    expect(r.success).toBe(true);
    expect(r.result).toEqual({ result: "important" });
  });

  it("should update auto-saved state on each execution", async () => {
    const tool = createSandboxTool({
      cpuTimeoutMs: 2000,
      wallClockTimeoutMs: 5000,
    });
    loadSaveRestoreModules(tool);

    // Handler that increments a counter
    await tool.registerHandler(
      "counter",
      [
        'import { get, set } from "ha:shared-state";',
        "export function handler() {",
        "  const prev = get('count') ?? 0;",
        "  set('count', prev + 1);",
        "  return { count: prev + 1 };",
        "}",
      ].join("\n"),
    );

    // Execute 3 times — state accumulates
    await tool.executeJavaScript("counter"); // count = 1
    await tool.executeJavaScript("counter"); // count = 2
    await tool.executeJavaScript("counter"); // count = 3

    // Register a new handler — auto-save should have captured count=3
    await tool.registerHandler(
      "reader",
      [
        'import { get } from "ha:shared-state";',
        "export function handler() { return { count: get('count') }; }",
      ].join("\n"),
    );
    const r = await tool.executeJavaScript("reader");
    expect(r.success).toBe(true);
    expect(r.result).toEqual({ count: 3 });
  });

  it("should auto-preserve Uint8Array binary data across handler registration", async () => {
    const tool = createSandboxTool({
      cpuTimeoutMs: 2000,
      wallClockTimeoutMs: 5000,
    });
    loadSaveRestoreModules(tool);

    // Handler that stores binary data
    await tool.registerHandler(
      "store-binary",
      [
        'import { set } from "ha:shared-state";',
        "export function handler() {",
        "  const arr = new Uint8Array([1, 2, 3, 255, 0, 128]);",
        "  set('binary', arr);",
        "  return { stored: true, length: arr.length };",
        "}",
      ].join("\n"),
    );

    const r1 = await tool.executeJavaScript("store-binary");
    expect(r1.success).toBe(true);
    expect(r1.result).toEqual({ stored: true, length: 6 });

    // Register NEW handler — triggers recompile
    // Binary data should survive via Hyperlight native serialization
    await tool.registerHandler(
      "read-binary",
      [
        'import { get } from "ha:shared-state";',
        "export function handler() {",
        "  const arr = get('binary');",
        "  if (!arr) return { error: 'binary not found' };",
        "  return {",
        "    type: arr.constructor.name,",
        "    length: arr.length,",
        "    values: Array.from(arr)",
        "  };",
        "}",
      ].join("\n"),
    );

    const r2 = await tool.executeJavaScript("read-binary");
    expect(r2.success).toBe(true);
    expect(r2.result).toEqual({
      type: "Uint8Array",
      length: 6,
      values: [1, 2, 3, 255, 0, 128],
    });
    expect(r2.statePreserved).toBe(true);
  });

  it("should report statePreserved=false on initial compile", async () => {
    const tool = createSandboxTool({
      cpuTimeoutMs: 2000,
      wallClockTimeoutMs: 5000,
    });
    loadSaveRestoreModules(tool);

    await tool.registerHandler("first", "return 'hello';");
    const r = await tool.executeJavaScript("first");
    expect(r.success).toBe(true);
    // First compile ever — no saved state to restore
    expect(r.statePreserved).toBe(false);
  });

  it("should report statePreserved=true on reuse (no recompile)", async () => {
    const tool = createSandboxTool({
      cpuTimeoutMs: 2000,
      wallClockTimeoutMs: 5000,
    });
    loadSaveRestoreModules(tool);

    await tool.registerHandler("same", "return 'hello';");
    await tool.executeJavaScript("same"); // first call
    const r2 = await tool.executeJavaScript("same"); // second call
    expect(r2.statePreserved).toBe(true);
  });

  it("should auto-preserve multiple Uint8Array binary values across handler registration", async () => {
    const tool = createSandboxTool({
      cpuTimeoutMs: 2000,
      wallClockTimeoutMs: 5000,
    });
    loadSaveRestoreModules(tool);

    // Handler that stores multiple binary values
    await tool.registerHandler(
      "store-multiple",
      [
        'import { set } from "ha:shared-state";',
        "export function handler() {",
        "  set('img1', new Uint8Array([1, 2, 3]));",
        "  set('img2', new Uint8Array([4, 5, 6, 7, 8]));",
        "  set('img3', new Uint8Array([255, 0, 128]));",
        "  return { stored: 3 };",
        "}",
      ].join("\n"),
    );

    const r1 = await tool.executeJavaScript("store-multiple");
    expect(r1.success).toBe(true);

    // Register NEW handler — triggers recompile
    await tool.registerHandler(
      "read-multiple",
      [
        'import { get, keys } from "ha:shared-state";',
        "export function handler() {",
        "  const allKeys = keys();",
        "  const img1 = get('img1');",
        "  const img2 = get('img2');",
        "  const img3 = get('img3');",
        "  return {",
        "    keyCount: allKeys.length,",
        "    img1: { type: img1?.constructor.name, values: Array.from(img1 || []) },",
        "    img2: { type: img2?.constructor.name, values: Array.from(img2 || []) },",
        "    img3: { type: img3?.constructor.name, values: Array.from(img3 || []) },",
        "  };",
        "}",
      ].join("\n"),
    );

    const r2 = await tool.executeJavaScript("read-multiple");
    expect(r2.success).toBe(true);
    expect(r2.result).toEqual({
      keyCount: 3,
      img1: { type: "Uint8Array", values: [1, 2, 3] },
      img2: { type: "Uint8Array", values: [4, 5, 6, 7, 8] },
      img3: { type: "Uint8Array", values: [255, 0, 128] },
    });
    expect(r2.statePreserved).toBe(true);
  });

  it("should auto-preserve shared-state across setPlugins", async () => {
    const tool = createSandboxTool({
      cpuTimeoutMs: 2000,
      wallClockTimeoutMs: 5000,
    });
    loadSaveRestoreModules(tool);

    // Store data in shared-state
    await tool.registerHandler(
      "store",
      [
        'import { set } from "ha:shared-state";',
        "export function handler() {",
        "  set('key', 'important-data');",
        "  return { stored: true };",
        "}",
      ].join("\n"),
    );
    await tool.executeJavaScript("store");

    // Call setPlugins — this triggers sandbox invalidation
    // The bug was: setPlugins didn't save state before invalidating
    await tool.setPlugins([]);

    // Register reader and verify data is restored
    await tool.registerHandler(
      "reader",
      [
        'import { get } from "ha:shared-state";',
        "export function handler() { return { key: get('key') }; }",
      ].join("\n"),
    );
    const r = await tool.executeJavaScript("reader");
    expect(r.success).toBe(true);
    expect(r.result).toEqual({ key: "important-data" });
    expect(r.statePreserved).toBe(true);
  });

  it("should auto-preserve shared-state across setBufferSizes", async () => {
    const tool = createSandboxTool({
      cpuTimeoutMs: 2000,
      wallClockTimeoutMs: 5000,
      inputBufferKb: 64,
      outputBufferKb: 64,
    });
    loadSaveRestoreModules(tool);

    // Store data in shared-state
    await tool.registerHandler(
      "store",
      [
        'import { set } from "ha:shared-state";',
        "export function handler() {",
        "  set('buffer-test', 42);",
        "  return { stored: true };",
        "}",
      ].join("\n"),
    );
    await tool.executeJavaScript("store");

    // Call setBufferSizes — this triggers sandbox invalidation
    await tool.setBufferSizes(128, 128);

    // Register reader and verify data is restored
    await tool.registerHandler(
      "reader",
      [
        'import { get } from "ha:shared-state";',
        "export function handler() { return { val: get('buffer-test') }; }",
      ].join("\n"),
    );
    const r = await tool.executeJavaScript("reader");
    expect(r.success).toBe(true);
    expect(r.result).toEqual({ val: 42 });
    expect(r.statePreserved).toBe(true);
  });

  it("should auto-preserve shared-state across setMemorySizes", async () => {
    const tool = createSandboxTool({
      cpuTimeoutMs: 2000,
      wallClockTimeoutMs: 5000,
      heapSizeMb: 16,
      scratchSizeMb: 16,
    });
    loadSaveRestoreModules(tool);

    // Store data in shared-state
    await tool.registerHandler(
      "store",
      [
        'import { set } from "ha:shared-state";',
        "export function handler() {",
        "  set('memory-test', 'preserved');",
        "  return { stored: true };",
        "}",
      ].join("\n"),
    );
    await tool.executeJavaScript("store");

    // Call setMemorySizes — triggers sandbox invalidation
    await tool.setMemorySizes(32, 32);

    // Register reader and verify data is restored
    await tool.registerHandler(
      "reader",
      [
        'import { get } from "ha:shared-state";',
        "export function handler() { return { val: get('memory-test') }; }",
      ].join("\n"),
    );
    const r = await tool.executeJavaScript("reader");
    expect(r.success).toBe(true);
    expect(r.result).toEqual({ val: "preserved" });
    expect(r.statePreserved).toBe(true);
  });

  it("should auto-preserve shared-state across resetBufferSizes", async () => {
    const tool = createSandboxTool({
      cpuTimeoutMs: 2000,
      wallClockTimeoutMs: 5000,
      inputBufferKb: 64,
      outputBufferKb: 64,
    });
    loadSaveRestoreModules(tool);

    // Set non-default buffer sizes first
    await tool.setBufferSizes(128, 128);

    // Store data in shared-state
    await tool.registerHandler(
      "store",
      [
        'import { set } from "ha:shared-state";',
        "export function handler() {",
        "  set('reset-buffer-test', 123);",
        "  return { stored: true };",
        "}",
      ].join("\n"),
    );
    await tool.executeJavaScript("store");

    // Reset buffer sizes — triggers sandbox invalidation
    await tool.resetBufferSizes();

    // Register reader and verify data is restored
    await tool.registerHandler(
      "reader",
      [
        'import { get } from "ha:shared-state";',
        "export function handler() { return { val: get('reset-buffer-test') }; }",
      ].join("\n"),
    );
    const r = await tool.executeJavaScript("reader");
    expect(r.success).toBe(true);
    expect(r.result).toEqual({ val: 123 });
    expect(r.statePreserved).toBe(true);
  });

  it("should auto-preserve shared-state across resetMemorySizes", async () => {
    const tool = createSandboxTool({
      cpuTimeoutMs: 2000,
      wallClockTimeoutMs: 5000,
      heapSizeMb: 16,
      scratchSizeMb: 16,
    });
    loadSaveRestoreModules(tool);

    // Set non-default memory sizes first
    await tool.setMemorySizes(32, 32);

    // Store data in shared-state
    await tool.registerHandler(
      "store",
      [
        'import { set } from "ha:shared-state";',
        "export function handler() {",
        "  set('reset-memory-test', { nested: 'object' });",
        "  return { stored: true };",
        "}",
      ].join("\n"),
    );
    await tool.executeJavaScript("store");

    // Reset memory sizes — triggers sandbox invalidation
    await tool.resetMemorySizes();

    // Register reader and verify data is restored
    await tool.registerHandler(
      "reader",
      [
        'import { get } from "ha:shared-state";',
        "export function handler() { return { val: get('reset-memory-test') }; }",
      ].join("\n"),
    );
    const r = await tool.executeJavaScript("reader");
    expect(r.success).toBe(true);
    expect(r.result).toEqual({ val: { nested: "object" } });
    expect(r.statePreserved).toBe(true);
  });

  it("should auto-preserve shared-state across registerModule", async () => {
    const tool = createSandboxTool({
      cpuTimeoutMs: 2000,
      wallClockTimeoutMs: 5000,
    });
    loadSaveRestoreModules(tool);

    // Store data in shared-state
    await tool.registerHandler(
      "store",
      [
        'import { set } from "ha:shared-state";',
        "export function handler() {",
        "  set('module-test', [1, 2, 3]);",
        "  return { stored: true };",
        "}",
      ].join("\n"),
    );
    await tool.executeJavaScript("store");

    // Register a new module — triggers sandbox invalidation
    await tool.registerModule(
      "test-util",
      "export function double(x) { return x * 2; }",
    );

    // Register reader and verify data is restored
    await tool.registerHandler(
      "reader",
      [
        'import { get } from "ha:shared-state";',
        "export function handler() { return { val: get('module-test') }; }",
      ].join("\n"),
    );
    const r = await tool.executeJavaScript("reader");
    expect(r.success).toBe(true);
    expect(r.result).toEqual({ val: [1, 2, 3] });
    expect(r.statePreserved).toBe(true);
  });

  it("should auto-preserve shared-state across deleteModule", async () => {
    const tool = createSandboxTool({
      cpuTimeoutMs: 2000,
      wallClockTimeoutMs: 5000,
    });
    loadSaveRestoreModules(tool);

    // Register a module first so we can delete it
    await tool.registerModule(
      "temp-module",
      "export function noop() { return null; }",
    );

    // Store data in shared-state
    await tool.registerHandler(
      "store",
      [
        'import { set } from "ha:shared-state";',
        "export function handler() {",
        "  set('delete-module-test', true);",
        "  return { stored: true };",
        "}",
      ].join("\n"),
    );
    await tool.executeJavaScript("store");

    // Delete the module — triggers sandbox invalidation
    await tool.deleteModule("temp-module");

    // Register reader and verify data is restored
    await tool.registerHandler(
      "reader",
      [
        'import { get } from "ha:shared-state";',
        "export function handler() { return { val: get('delete-module-test') }; }",
      ].join("\n"),
    );
    const r = await tool.executeJavaScript("reader");
    expect(r.success).toBe(true);
    expect(r.result).toEqual({ val: true });
    expect(r.statePreserved).toBe(true);
  });

  // ── Binary data preservation tests for all invalidation triggers ────

  it("should auto-preserve Uint8Array across setPlugins", async () => {
    const tool = createSandboxTool({
      cpuTimeoutMs: 2000,
      wallClockTimeoutMs: 5000,
    });
    loadSaveRestoreModules(tool);

    // Store binary data in shared-state
    await tool.registerHandler(
      "store-binary",
      [
        'import { set } from "ha:shared-state";',
        "export function handler() {",
        "  set('binary-plugin-test', new Uint8Array([10, 20, 30, 40]));",
        "  return { stored: true };",
        "}",
      ].join("\n"),
    );
    await tool.executeJavaScript("store-binary");

    // Call setPlugins — triggers sandbox invalidation
    await tool.setPlugins([]);

    // Register reader and verify binary data is restored
    await tool.registerHandler(
      "read-binary",
      [
        'import { get } from "ha:shared-state";',
        "export function handler() {",
        "  const arr = get('binary-plugin-test');",
        "  return { type: arr?.constructor.name, values: Array.from(arr || []) };",
        "}",
      ].join("\n"),
    );
    const r = await tool.executeJavaScript("read-binary");
    expect(r.success).toBe(true);
    expect(r.result).toEqual({
      type: "Uint8Array",
      values: [10, 20, 30, 40],
    });
    expect(r.statePreserved).toBe(true);
  });

  it("should auto-preserve Uint8Array across setMemorySizes", async () => {
    const tool = createSandboxTool({
      cpuTimeoutMs: 2000,
      wallClockTimeoutMs: 5000,
      heapSizeMb: 16,
      scratchSizeMb: 16,
    });
    loadSaveRestoreModules(tool);

    // Store binary data in shared-state
    await tool.registerHandler(
      "store-binary",
      [
        'import { set } from "ha:shared-state";',
        "export function handler() {",
        "  set('binary-memory-test', new Uint8Array([255, 128, 64, 32, 16]));",
        "  return { stored: true };",
        "}",
      ].join("\n"),
    );
    await tool.executeJavaScript("store-binary");

    // Call setMemorySizes — triggers sandbox invalidation
    await tool.setMemorySizes(32, 32);

    // Register reader and verify binary data is restored
    await tool.registerHandler(
      "read-binary",
      [
        'import { get } from "ha:shared-state";',
        "export function handler() {",
        "  const arr = get('binary-memory-test');",
        "  return { type: arr?.constructor.name, values: Array.from(arr || []) };",
        "}",
      ].join("\n"),
    );
    const r = await tool.executeJavaScript("read-binary");
    expect(r.success).toBe(true);
    expect(r.result).toEqual({
      type: "Uint8Array",
      values: [255, 128, 64, 32, 16],
    });
    expect(r.statePreserved).toBe(true);
  });

  it("should auto-preserve Uint8Array across reset_sandbox", async () => {
    const tool = createSandboxTool({
      cpuTimeoutMs: 2000,
      wallClockTimeoutMs: 5000,
    });
    loadSaveRestoreModules(tool);

    // Store binary data in shared-state
    await tool.registerHandler(
      "store-binary",
      [
        'import { set } from "ha:shared-state";',
        "export function handler() {",
        "  set('binary-reset-test', new Uint8Array([1, 1, 2, 3, 5, 8]));",
        "  return { stored: true };",
        "}",
      ].join("\n"),
    );
    await tool.executeJavaScript("store-binary");

    // Reset sandbox — should auto-preserve shared-state including binary
    await tool.resetSandbox();

    // Register reader and verify binary data is restored
    await tool.registerHandler(
      "read-binary",
      [
        'import { get } from "ha:shared-state";',
        "export function handler() {",
        "  const arr = get('binary-reset-test');",
        "  return { type: arr?.constructor.name, values: Array.from(arr || []) };",
        "}",
      ].join("\n"),
    );
    const r = await tool.executeJavaScript("read-binary");
    expect(r.success).toBe(true);
    expect(r.result).toEqual({
      type: "Uint8Array",
      values: [1, 1, 2, 3, 5, 8],
    });
    expect(r.statePreserved).toBe(true);
  });

  it("should auto-preserve shared-state across multiple setPlugins calls", async () => {
    // This test covers the tune scenario where:
    // 1. apply_profile("web-research") → setPlugins
    // 2. Execute handler that stores data
    // 3. apply_profile("file-builder") → setPlugins AGAIN
    // 4. Register new handler
    // 5. Execute → should see preserved state
    const tool = createSandboxTool({
      cpuTimeoutMs: 2000,
      wallClockTimeoutMs: 5000,
    });
    loadSaveRestoreModules(tool);

    // Initial plugin config (simulates apply_profile "web-research")
    await tool.setPlugins([]);

    // Store binary data in shared-state
    await tool.registerHandler(
      "researcher",
      [
        'import { set } from "ha:shared-state";',
        "export function handler() {",
        "  set('image1', new Uint8Array([1, 2, 3, 4]));",
        "  set('image2', new Uint8Array([5, 6, 7, 8]));",
        "  set('metadata', { title: 'Test', count: 2 });",
        "  return { stored: 3 };",
        "}",
      ].join("\n"),
    );
    const r1 = await tool.executeJavaScript("researcher");
    expect(r1.success).toBe(true);
    expect(r1.result).toEqual({ stored: 3 });

    // Change plugins (simulates apply_profile "file-builder")
    // This should save state before invalidating
    await tool.setPlugins([]);

    // Register a new handler (triggers another invalidation)
    await tool.registerHandler(
      "builder",
      [
        'import { get, keys } from "ha:shared-state";',
        "export function handler() {",
        "  const img1 = get('image1');",
        "  const img2 = get('image2');",
        "  const meta = get('metadata');",
        "  return {",
        "    keyCount: keys().length,",
        "    img1: img1 ? { type: img1.constructor.name, values: Array.from(img1) } : null,",
        "    img2: img2 ? { type: img2.constructor.name, values: Array.from(img2) } : null,",
        "    metadata: meta,",
        "  };",
        "}",
      ].join("\n"),
    );

    // Execute builder — should see all preserved state
    const r2 = await tool.executeJavaScript("builder");
    expect(r2.success).toBe(true);
    expect(r2.result).toEqual({
      keyCount: 3,
      img1: { type: "Uint8Array", values: [1, 2, 3, 4] },
      img2: { type: "Uint8Array", values: [5, 6, 7, 8] },
      metadata: { title: "Test", count: 2 },
    });
    expect(r2.statePreserved).toBe(true);
  });

  it("should auto-preserve mixed data types across all invalidation paths", async () => {
    const tool = createSandboxTool({
      cpuTimeoutMs: 2000,
      wallClockTimeoutMs: 5000,
      heapSizeMb: 16,
      scratchSizeMb: 16,
    });
    loadSaveRestoreModules(tool);

    // Store multiple types: string, number, boolean, null, array, object, Uint8Array
    await tool.registerHandler(
      "store-all",
      [
        'import { set } from "ha:shared-state";',
        "export function handler() {",
        "  set('str', 'hello');",
        "  set('num', 42);",
        "  set('bool', true);",
        "  set('nil', null);",
        "  set('arr', [1, 'two', 3]);",
        "  set('obj', { a: 1, b: { c: 2 } });",
        "  set('bin', new Uint8Array([0, 127, 255]));",
        "  return { stored: 7 };",
        "}",
      ].join("\n"),
    );
    await tool.executeJavaScript("store-all");

    // Trigger multiple invalidation paths sequentially
    await tool.setMemorySizes(32, 32);
    await tool.setBufferSizes(128, 128);
    await tool.setPlugins([]);
    await tool.registerModule("dummy", "export const x = 1;");
    await tool.deleteModule("dummy");
    await tool.resetSandbox();

    // Register reader and verify ALL types are restored correctly
    await tool.registerHandler(
      "read-all",
      [
        'import { get } from "ha:shared-state";',
        "export function handler() {",
        "  const bin = get('bin');",
        "  return {",
        "    str: get('str'),",
        "    num: get('num'),",
        "    bool: get('bool'),",
        "    nil: get('nil'),",
        "    arr: get('arr'),",
        "    obj: get('obj'),",
        "    bin: { type: bin?.constructor.name, values: Array.from(bin || []) },",
        "  };",
        "}",
      ].join("\n"),
    );
    const r = await tool.executeJavaScript("read-all");
    expect(r.success).toBe(true);
    expect(r.result).toEqual({
      str: "hello",
      num: 42,
      bool: true,
      nil: null,
      arr: [1, "two", 3],
      obj: { a: 1, b: { c: 2 } },
      bin: { type: "Uint8Array", values: [0, 127, 255] },
    });
  });

  it("should report statePreserved=true on runtime errors (no rebuild)", async () => {
    // Bug regression test: runtime errors were returning statePreserved: false
    // even though the sandbox wasn't rebuilt. This caused the LLM to
    // unnecessarily re-download data after OOM or other runtime errors.
    const tool = createSandboxTool({
      cpuTimeoutMs: 2000,
      wallClockTimeoutMs: 5000,
      heapSizeMb: 8,
      scratchSizeMb: 8,
    });
    loadSaveRestoreModules(tool);

    // Register both handlers upfront
    await tool.registerHandler(
      "store-data",
      [
        'import { set } from "ha:shared-state";',
        "export function handler() {",
        "  set('important', 'preserved');",
        "  return { ok: true };",
        "}",
      ].join("\n"),
    );
    await tool.registerHandler(
      "crasher",
      [
        "export function handler() {",
        "  throw new Error('Runtime boom!');",
        "}",
      ].join("\n"),
    );

    // Execute store-data first - this compiles the sandbox
    const r1 = await tool.executeJavaScript("store-data");
    expect(r1.success).toBe(true);
    // First execution after registration - statePreserved is false because
    // there was nothing to restore (no prior state)
    // This is expected behavior.

    // Execute store-data again - NOW statePreserved should be true
    // because sandbox is already compiled and state exists
    const r1b = await tool.executeJavaScript("store-data");
    expect(r1b.success).toBe(true);
    expect(r1b.statePreserved).toBe(true);

    // Execute crasher - should fail but statePreserved should STILL be TRUE
    // because the sandbox wasn't rebuilt (handlers haven't changed)
    const r2 = await tool.executeJavaScript("crasher");
    expect(r2.success).toBe(false);
    expect(r2.error).toMatch(/Runtime boom/);
    // THIS is the actual bug fix being tested:
    // Before fix: was false (hardcoded in error path)
    // After fix: true (uses actual statePreserved from execution context)
    expect(r2.statePreserved).toBe(true);

    // Verify state is actually preserved by reading it back
    await tool.registerHandler(
      "verify",
      [
        'import { get } from "ha:shared-state";',
        "export function handler() {",
        "  return { important: get('important') };",
        "}",
      ].join("\n"),
    );
    const r3 = await tool.executeJavaScript("verify");
    expect(r3.success).toBe(true);
    expect(r3.result).toEqual({ important: "preserved" });
  });

  it("should preserve shared-state across CPU timeout (poisoned sandbox)", async () => {
    // CPU timeouts poison the sandbox. The sandbox attempts to restore from
    // snapshot, but if that fails, it invalidates. We need to ensure
    // shared-state survives this scenario.
    const tool = createSandboxTool({
      cpuTimeoutMs: 100, // Short timeout to trigger quickly
      wallClockTimeoutMs: 5000,
      heapSizeMb: 8,
      scratchSizeMb: 8,
    });
    loadSaveRestoreModules(tool);

    // Store data first
    await tool.registerHandler(
      "store-data",
      [
        'import { set } from "ha:shared-state";',
        "export function handler() {",
        "  set('critical', 'must-survive-timeout');",
        "  set('binary', new Uint8Array([1, 2, 3, 4, 5]));",
        "  return { stored: true };",
        "}",
      ].join("\n"),
    );
    await tool.registerHandler("infinite-loop", "while (true) {}");

    // Execute store-data to save state
    const r1 = await tool.executeJavaScript("store-data");
    expect(r1.success).toBe(true);

    // Trigger CPU timeout - this poisons the sandbox
    const r2 = await tool.executeJavaScript("infinite-loop");
    expect(r2.success).toBe(false);
    expect(r2.error).toContain("timed out");

    // Register a reader handler - this triggers a rebuild
    await tool.registerHandler(
      "read-data",
      [
        'import { get } from "ha:shared-state";',
        "export function handler() {",
        "  const bin = get('binary');",
        "  return {",
        "    critical: get('critical'),",
        "    binary: bin ? Array.from(bin) : null,",
        "  };",
        "}",
      ].join("\n"),
    );

    // Verify state survived the timeout and rebuild
    const r3 = await tool.executeJavaScript("read-data");
    expect(r3.success).toBe(true);
    expect(r3.result).toEqual({
      critical: "must-survive-timeout",
      binary: [1, 2, 3, 4, 5],
    });
  });

  it("should preserve LATEST state across multiple executions then timeout", async () => {
    // Verify that if handler A sets state, handler B updates it, then
    // handler C times out, we get B's state (not A's).
    const tool = createSandboxTool({
      cpuTimeoutMs: 100,
      wallClockTimeoutMs: 5000,
      heapSizeMb: 8,
      scratchSizeMb: 8,
    });
    loadSaveRestoreModules(tool);

    // Register all handlers upfront
    await tool.registerHandler(
      "set-v1",
      [
        'import { set } from "ha:shared-state";',
        "export function handler() {",
        "  set('version', 1);",
        "  set('data', 'from-v1');",
        "  return { set: 'v1' };",
        "}",
      ].join("\n"),
    );
    await tool.registerHandler(
      "set-v2",
      [
        'import { set } from "ha:shared-state";',
        "export function handler() {",
        "  set('version', 2);",
        "  set('data', 'from-v2');",
        "  return { set: 'v2' };",
        "}",
      ].join("\n"),
    );
    await tool.registerHandler("infinite-loop", "while (true) {}");
    await tool.registerHandler(
      "read-state",
      [
        'import { get } from "ha:shared-state";',
        "export function handler() {",
        "  return { version: get('version'), data: get('data') };",
        "}",
      ].join("\n"),
    );

    // Execute v1 - state should be saved
    const r1 = await tool.executeJavaScript("set-v1");
    expect(r1.success).toBe(true);

    // Execute v2 - state should be UPDATED
    const r2 = await tool.executeJavaScript("set-v2");
    expect(r2.success).toBe(true);

    // Verify v2 is current
    const check1 = await tool.executeJavaScript("read-state");
    expect(check1.result).toEqual({ version: 2, data: "from-v2" });

    // Timeout - this will poison and restore
    const r3 = await tool.executeJavaScript("infinite-loop");
    expect(r3.success).toBe(false);
    expect(r3.error).toContain("timed out");

    // After timeout, we should still have v2's state (not v1's)
    const check2 = await tool.executeJavaScript("read-state");
    expect(check2.success).toBe(true);
    expect(check2.result).toEqual({ version: 2, data: "from-v2" });
  });

  it("should preserve binary data as native Uint8Array, not base64 or JSON array", async () => {
    // This test verifies the sidecar mechanism preserves binary data natively.
    // If it were using base64 or JSON arrays internally, we'd see:
    // - String type instead of Uint8Array
    // - Or massive memory overhead with large binaries
    const tool = createSandboxTool({
      cpuTimeoutMs: 2000,
      wallClockTimeoutMs: 10000,
      heapSizeMb: 16,
      scratchSizeMb: 16,
    });
    loadSaveRestoreModules(tool);

    // Store binary data with specific byte patterns that would be mangled by base64
    await tool.registerHandler(
      "store-binary",
      [
        'import { set } from "ha:shared-state";',
        "export function handler() {",
        "  // Create 1KB of binary data with all byte values 0-255 repeated",
        "  const arr = new Uint8Array(1024);",
        "  for (let i = 0; i < 1024; i++) arr[i] = i % 256;",
        "  set('large-binary', arr);",
        "  return { stored: true, length: arr.length };",
        "}",
      ].join("\n"),
    );
    await tool.executeJavaScript("store-binary");

    // Trigger sandbox rebuild to force save/restore cycle
    await tool.setPlugins([]);

    // Verify the data comes back as a real Uint8Array with correct values
    await tool.registerHandler(
      "verify-binary",
      [
        'import { get } from "ha:shared-state";',
        "export function handler() {",
        "  const arr = get('large-binary');",
        "  if (!arr) return { error: 'not found' };",
        "  // Verify type is Uint8Array, not string (base64) or plain array",
        "  const typeName = arr.constructor.name;",
        "  const isTypedArray = arr instanceof Uint8Array;",
        "  // Verify values are correct (not corrupted by encoding)",
        "  let correctValues = true;",
        "  for (let i = 0; i < arr.length; i++) {",
        "    if (arr[i] !== i % 256) { correctValues = false; break; }",
        "  }",
        "  // Check first and last few bytes explicitly",
        "  return {",
        "    typeName,",
        "    isTypedArray,",
        "    length: arr.length,",
        "    correctValues,",
        "    firstBytes: [arr[0], arr[1], arr[2], arr[3]],",
        "    lastBytes: [arr[1020], arr[1021], arr[1022], arr[1023]],",
        "  };",
        "}",
      ].join("\n"),
    );
    const r = await tool.executeJavaScript("verify-binary");
    expect(r.success).toBe(true);
    expect(r.result).toEqual({
      typeName: "Uint8Array",
      isTypedArray: true,
      length: 1024,
      correctValues: true,
      firstBytes: [0, 1, 2, 3],
      lastBytes: [252, 253, 254, 255], // 1020%256=252, etc.
    });
  });
});

// ── ZIP deduplication ───────────────────────────────────────────────────

describe("zip-format deduplication", () => {
  it("should deduplicate entries with same path (last wins)", async () => {
    const tool = createSandboxTool();
    tool.setModules([
      readModule("str-bytes"),
      readModule("crc32"),
      readModule("zip-format"),
    ]);

    // Register a handler that creates a ZIP with duplicate entries
    await tool.registerHandler(
      "zip-dedup-test",
      [
        'import { createZip } from "ha:zip-format";',
        "export function handler() {",
        "  // Create ZIP with 3 entries where file.txt appears twice",
        "  const entries = [",
        '    { name: "file.txt", data: "first content" },',
        '    { name: "other.txt", data: "other content" },',
        '    { name: "file.txt", data: "second content" },', // duplicate - should win
        "  ];",
        "  const zip = createZip(entries);",
        "  // Return info about the zip (can't extract here but verify no crash)",
        "  return { size: zip.length, isUint8Array: zip instanceof Uint8Array };",
        "}",
      ].join("\n"),
    );

    const r = await tool.executeJavaScript("zip-dedup-test");
    expect(r.success).toBe(true);
    expect(r.result.isUint8Array).toBe(true);
    expect(r.result.size).toBeGreaterThan(0);
  });
});

// ── XLSX workbook generation ─────────────────────────────────────────

describe("xlsx builtin module", () => {
  function loadXlsxModules(tool: ReturnType<typeof createSandboxTool>): void {
    tool.setModules([
      readModule("xml-escape"),
      readModule("str-bytes"),
      readModule("crc32"),
      readModule("zip-format"),
      readModule("xlsx"),
    ]);
  }

  it("should build a workbook with styles, formulas, validation, chart, and pivot data", async () => {
    const tool = createSandboxTool({ inputBufferKb: 256, outputBufferKb: 256 });
    loadXlsxModules(tool);

    await tool.registerHandler(
      "xlsx-smoke-test",
      [
        'import { createWorkbook } from "ha:xlsx";',
        "export function handler() {",
        "  const wb = createWorkbook();",
        "  const data = wb.addSheet('Data');",
        "  data.addRow(1, ['Region', 'Quarter', 'Revenue', 'Active'], { bold: true, fill: '#4472C4', color: '#FFFFFF', border: 'thin' });",
        "  data.addRow(2, ['North', 'Q1', 120, true], { border: 'thin' });",
        "  data.addRow(3, ['South', 'Q1', 90, false], { border: 'thin' });",
        "  data.addRow(4, ['North', 'Q2', 150, true], { border: 'thin' });",
        "  data.setCell('E1', 'Total', { bold: true });",
        "  data.setCell('E2', '=SUM(C2:C4)', { numFmt: '#,##0' });",
        "  data.setCell('F2', new Date(2026, 3, 28));",
        "  data.setColumnWidth('A', 18).setColumnWidth('C', 12);",
        "  data.freezeRows(1).setAutoFilter('A1:D4');",
        "  data.addConditionalFormat('C2:C4', { type: 'dataBar', color: '#70AD47' });",
        "  data.addDataValidation('B2:B100', { type: 'list', values: ['Q1', 'Q2', 'Q3', 'Q4'] });",
        "  data.addChart({ type: 'column', title: 'Revenue', categories: ['North Q1', 'South Q1', 'North Q2'], series: [{ name: 'Revenue', values: [120, 90, 150] }] });",
        "  const pivots = wb.addSheet('Pivots');",
        "  wb.addPivotTable({ sourceSheet: data, targetSheet: pivots, sourceRange: 'A1:D4', targetCell: 'A3', rows: ['Region'], values: [{ field: 'Revenue', func: 'sum' }] });",
        "  const bytes = wb.build();",
        "  return {",
        "    isUint8Array: bytes instanceof Uint8Array,",
        "    size: bytes.length,",
        "    signature: [bytes[0], bytes[1], bytes[2], bytes[3]],",
        "    pivotNorth: pivots.getCellValue('A4'),",
        "    pivotTotal: pivots.getCellValue('B6'),",
        "  };",
        "}",
      ].join("\n"),
    );

    const r = await tool.executeJavaScript("xlsx-smoke-test");
    expect(r.success).toBe(true);
    expect(r.result).toMatchObject({
      isUint8Array: true,
      signature: [0x50, 0x4b, 0x03, 0x04],
      pivotNorth: "North",
      pivotTotal: 360,
    });
    expect(r.result.size).toBeGreaterThan(2000);
  });

  it("should build a simple formatted table with tableToWorkbook", async () => {
    const tool = createSandboxTool({ inputBufferKb: 128, outputBufferKb: 128 });
    loadXlsxModules(tool);

    await tool.registerHandler(
      "xlsx-table-test",
      [
        'import { tableToWorkbook } from "ha:xlsx";',
        "export function handler() {",
        "  const wb = tableToWorkbook({",
        "    sheetName: 'Sales',",
        "    headers: ['name', 'value'],",
        "    data: [{ name: 'Alpha', value: 10 }, { name: 'Beta', value: 20 }],",
        "    columnWidths: [20, 12],",
        "  });",
        "  const bytes = wb.build();",
        "  return { size: bytes.length, signature: [bytes[0], bytes[1], bytes[2], bytes[3]] };",
        "}",
      ].join("\n"),
    );

    const r = await tool.executeJavaScript("xlsx-table-test");
    expect(r.success).toBe(true);
    expect(r.result.signature).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(r.result.size).toBeGreaterThan(1000);
  });

  it("should expose cell reference and date helper functions", async () => {
    const tool = createSandboxTool();
    loadXlsxModules(tool);

    await tool.registerHandler(
      "xlsx-helper-test",
      [
        'import { colToNum, numToCol, parseCellRef, cellRef, dateToSerial } from "ha:xlsx";',
        "export function handler() {",
        "  let invalidRef = '';",
        "  try { parseCellRef('not-a-cell'); } catch (err) { invalidRef = err.message; }",
        "  return {",
        "    colAA: colToNum('AA'),",
        "    colXfd: colToNum('XFD'),",
        "    num703: numToCol(703),",
        "    parsed: parseCellRef('BC42'),",
        "    ref: cellRef(99, 28),",
        "    serial: dateToSerial(new Date(1900, 0, 1)),",
        "    leapBugSerial: dateToSerial(new Date(1900, 2, 1)),",
        "    invalidRef,",
        "  };",
        "}",
      ].join("\n"),
    );

    const r = await tool.executeJavaScript("xlsx-helper-test");
    expect(r.success).toBe(true);
    expect(r.result).toEqual({
      colAA: 27,
      colXfd: 16384,
      num703: "AAA",
      parsed: { col: 55, row: 42 },
      ref: "AB99",
      serial: 1,
      leapBugSerial: 61,
      invalidRef: "Invalid cell ref: not-a-cell",
    });
  });

  it("should write accurate dimensions and safe validation list XML", async () => {
    const tool = createSandboxTool({
      inputBufferKb: 512,
      outputBufferKb: 1024,
    });
    loadXlsxModules(tool);

    await tool.registerHandler(
      "xlsx-validation-xml-test",
      [
        'import { createWorkbook } from "ha:xlsx";',
        "export function handler() {",
        "  const wb = createWorkbook();",
        "  const sh = wb.addSheet('Validation');",
        "  sh.setCell('C3', 'First');",
        "  sh.setCell('D4', 'Last');",
        "  sh.addDataValidation('C3:C10', { type: 'list', values: ['R&D', '<Open>'] });",
        "  const bytes = wb.build();",
        "  let invalidMessage = '';",
        "  try {",
        "    const bad = createWorkbook();",
        "    bad.addSheet('Bad').addDataValidation('A1:A2', { type: 'list', values: ['Needs, comma'] });",
        "    bad.build();",
        "  } catch (err) { invalidMessage = err.message; }",
        "  return { bytes: Array.from(bytes), invalidMessage };",
        "}",
      ].join("\n"),
    );

    const r = await tool.executeJavaScript("xlsx-validation-xml-test");
    expect(r.success).toBe(true);
    const entries = parseZipEntries(r.result.bytes);
    const sheetXml = zipText(entries, "xl/worksheets/sheet1.xml");
    expect(sheetXml).toContain('<dimension ref="C3:D4"/>');
    expect(sheetXml).toContain('<formula1>"R&amp;D,&lt;Open&gt;"</formula1>');
    expect(r.result.invalidMessage).toContain("use a formula range instead");
  });

  it("should write core workbook entries and worksheet layout XML", async () => {
    const tool = createSandboxTool({
      inputBufferKb: 512,
      outputBufferKb: 1024,
    });
    loadXlsxModules(tool);

    await tool.registerHandler(
      "xlsx-worksheet-xml-test",
      [
        'import { createWorkbook } from "ha:xlsx";',
        "export function handler() {",
        "  const wb = createWorkbook();",
        "  const sh = wb.addSheet('Ops & Plan');",
        "  sh.addRow(1, ['Merged title', null, null], { bold: true, fill: '#D9EAD3' });",
        "  sh.addRow(2, ['Team', 'Count', 'Revenue'], { bold: true });",
        "  sh.addRow(3, ['North', 2, 30]);",
        "  sh.addRow(4, ['South', 1, 5]);",
        "  sh.addRow(5, ['Total', 3, '=SUM(C3:C4)']);",
        "  sh.setColumnWidth('A', 22).setRowHeight(1, 24);",
        "  sh.mergeCells('A1', 'C1').freezeRows(1).freezeColumns(1).setAutoFilter('A2:C5');",
        "  sh.groupRows(3, 4, { level: 2, collapsed: true }).groupColumns('B', 'C', { level: 1, collapsed: true });",
        "  sh.setTabColor('#FFAA00');",
        "  sh.protect({ password: 'secret', allowSort: true, allowFilter: true });",
        "  sh.setPrintArea('A1:C5');",
        "  sh.setPageSetup({ orientation: 'landscape', paperSize: 9, fitToWidth: 1, fitToHeight: 0 });",
        "  sh.setPageMargins({ left: 0.5, right: 0.5, top: 0.6, bottom: 0.6, header: 0.2, footer: 0.2 });",
        "  sh.setHeaderFooter({ header: '&CReport', footer: '&P of &N' });",
        "  wb.addNamedRange('Totals', \"'Ops & Plan'!$C$5\");",
        "  const bytes = wb.build();",
        "  return { bytes: Array.from(bytes) };",
        "}",
      ].join("\n"),
    );

    const r = await tool.executeJavaScript("xlsx-worksheet-xml-test");
    expect(r.success).toBe(true);
    const entries = parseZipEntries(r.result.bytes);
    expect([...entries.keys()]).toEqual(
      expect.arrayContaining([
        "[Content_Types].xml",
        "_rels/.rels",
        "xl/workbook.xml",
        "xl/_rels/workbook.xml.rels",
        "xl/worksheets/sheet1.xml",
        "xl/styles.xml",
        "xl/sharedStrings.xml",
      ]),
    );

    const workbookXml = zipText(entries, "xl/workbook.xml");
    expect(workbookXml).toContain('sheet name="Ops &amp; Plan"');
    expect(workbookXml).toContain('<definedName name="Totals">');
    expect(workbookXml).toContain("'Ops &amp; Plan'!$C$5");
    expect(workbookXml).toContain('name="_xlnm.Print_Area" localSheetId="0"');

    const sheetXml = zipText(entries, "xl/worksheets/sheet1.xml");
    expect(sheetXml).toContain('<tabColor rgb="FFFFAA00"/>');
    expect(sheetXml).toContain('<pane xSplit="1" ySplit="1" topLeftCell="B2"');
    expect(sheetXml).toContain(
      '<col min="1" max="1" width="22" customWidth="1"/>',
    );
    expect(sheetXml).toContain(
      '<col min="2" max="2" width="8.43" outlineLevel="1" collapsed="1"/>',
    );
    expect(sheetXml).toContain('<row r="1" ht="24" customHeight="1"');
    expect(sheetXml).toContain('<row r="3" outlineLevel="2" collapsed="1"');
    expect(sheetXml).toContain(
      '<sheetProtection sheet="1" objects="1" scenarios="1"',
    );
    expect(sheetXml).toContain(' sort="1"');
    expect(sheetXml).toContain(' autoFilter="1"');
    expect(sheetXml).toContain('<autoFilter ref="A2:C5"/>');
    expect(sheetXml).toContain('<mergeCell ref="A1:C1"/>');
    expect(sheetXml).toContain(
      '<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.2" footer="0.2"/>',
    );
    expect(sheetXml).toContain(
      '<pageSetup orientation="landscape" paperSize="9" fitToWidth="1" fitToHeight="0"/>',
    );
    expect(sheetXml).toContain("<oddHeader>&amp;CReport</oddHeader>");
    expect(sheetXml).toContain("<oddFooter>&amp;P of &amp;N</oddFooter>");
  });

  it("should write relationships for hyperlinks, drawings, charts, images, and sparklines", async () => {
    const tool = createSandboxTool({
      inputBufferKb: 512,
      outputBufferKb: 1024,
    });
    loadXlsxModules(tool);

    await tool.registerHandler(
      "xlsx-relationship-xml-test",
      [
        'import { createWorkbook } from "ha:xlsx";',
        "export function handler() {",
        "  const wb = createWorkbook();",
        "  const data = wb.addSheet('Data');",
        "  wb.addSheet('Other').setCell('B2', 'Target');",
        "  data.addRow(1, ['Metric', 'Q1', 'Q2', 'Q3']);",
        "  data.addRow(2, ['Revenue', 10, 20, 30]);",
        "  data.addRow(3, ['Cost', 4, 8, 12]);",
        "  data.addHyperlink('A5', 'https://example.com/report', { display: 'External report', tooltip: 'Open report' });",
        "  data.addHyperlink('A6', { sheet: 'Other', cell: 'B2' }, { display: 'Internal target' });",
        "  data.addChart({ type: 'line', title: 'Trend', categories: ['Q1', 'Q2', 'Q3'], series: [{ name: 'Revenue', values: [10, 20, 30] }], dataLabels: true, anchor: { from: 'F2', to: 'M16' } });",
        "  data.addSparklines({ type: 'line', dataRange: 'B2:D3', locationRange: 'E2:E3', markers: true, showHigh: true, showLow: true });",
        "  data.addImage(new Uint8Array([0x89, 0x50, 0x4E, 0x47, 1, 2, 3, 4]), { from: 'F18', to: 'H24' });",
        "  const bytes = wb.build();",
        "  return { bytes: Array.from(bytes) };",
        "}",
      ].join("\n"),
    );

    const r = await tool.executeJavaScript("xlsx-relationship-xml-test");
    expect(r.success).toBe(true);
    const entries = parseZipEntries(r.result.bytes);
    expect([...entries.keys()]).toEqual(
      expect.arrayContaining([
        "xl/worksheets/sheet1.xml",
        "xl/worksheets/_rels/sheet1.xml.rels",
        "xl/drawings/drawing1.xml",
        "xl/drawings/_rels/drawing1.xml.rels",
        "xl/charts/chart1.xml",
        "xl/media/image1.png",
      ]),
    );

    const sheetXml = zipText(entries, "xl/worksheets/sheet1.xml");
    expect(sheetXml).toContain(
      '<hyperlink ref="A5" r:id="rId2" display="External report" tooltip="Open report"/>',
    );
    expect(sheetXml).toContain(
      '<hyperlink ref="A6" location="Other!B2" display="Internal target"/>',
    );
    expect(sheetXml).toContain('<drawing r:id="rId1"/>');
    expect(sheetXml).toContain("<x14:sparklineGroups");
    expect(sheetXml).toContain(
      "<xm:f>Data!B2:D2</xm:f><xm:sqref>E2</xm:sqref>",
    );

    const sheetRels = zipText(entries, "xl/worksheets/_rels/sheet1.xml.rels");
    expect(sheetRels).toContain(
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"',
    );
    expect(sheetRels).toContain(
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/report" TargetMode="External"',
    );

    const drawingRels = zipText(entries, "xl/drawings/_rels/drawing1.xml.rels");
    expect(drawingRels).toContain('Target="../charts/chart1.xml"');
    expect(drawingRels).toContain('Target="../media/image1.png"');

    const chartXml = zipText(entries, "xl/charts/chart1.xml");
    expect(chartXml).toContain("<c:lineChart>");
    expect(chartXml).toContain("<a:t>Trend</a:t>");
    expect(chartXml).toContain("<c:v>Revenue</c:v>");
    expect(entries.get("xl/media/image1.png")).toEqual(
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]),
    );
  });

  it("should compute pivot aggregators for sum, count, average, min, and max", async () => {
    const tool = createSandboxTool({ inputBufferKb: 256, outputBufferKb: 256 });
    loadXlsxModules(tool);

    await tool.registerHandler(
      "xlsx-pivot-aggregator-test",
      [
        'import { createWorkbook } from "ha:xlsx";',
        "export function handler() {",
        "  const wb = createWorkbook();",
        "  const data = wb.addSheet('Data');",
        "  data.addRow(1, ['Region', 'Revenue']);",
        "  data.addRow(2, ['North', 10]);",
        "  data.addRow(3, ['North', 20]);",
        "  data.addRow(4, ['South', 5]);",
        "  const pivot = wb.addSheet('Pivot');",
        "  wb.addPivotTable({",
        "    sourceSheet: data,",
        "    targetSheet: pivot,",
        "    sourceRange: 'A1:B4',",
        "    targetCell: 'A3',",
        "    rows: ['Region'],",
        "    values: [",
        "      { field: 'Revenue', func: 'sum' },",
        "      { field: 'Revenue', func: 'count' },",
        "      { field: 'Revenue', func: 'average' },",
        "      { field: 'Revenue', func: 'min' },",
        "      { field: 'Revenue', func: 'max' },",
        "    ],",
        "  });",
        "  return {",
        "    headers: ['B3', 'C3', 'D3', 'E3', 'F3'].map((ref) => pivot.getCellValue(ref)),",
        "    north: ['A4', 'B4', 'C4', 'D4', 'E4', 'F4'].map((ref) => pivot.getCellValue(ref)),",
        "    south: ['A5', 'B5', 'C5', 'D5', 'E5', 'F5'].map((ref) => pivot.getCellValue(ref)),",
        "    total: ['A6', 'B6', 'C6', 'D6', 'E6', 'F6'].map((ref) => pivot.getCellValue(ref)),",
        "  };",
        "}",
      ].join("\n"),
    );

    const r = await tool.executeJavaScript("xlsx-pivot-aggregator-test");
    expect(r.success).toBe(true);
    expect(r.result.headers).toEqual([
      "Sum of Revenue",
      "Count of Revenue",
      "Average of Revenue",
      "Min of Revenue",
      "Max of Revenue",
    ]);
    expect(r.result.north).toEqual(["North", 30, 2, 15, 10, 20]);
    expect(r.result.south).toEqual(["South", 5, 1, 5, 5, 5]);
    expect(r.result.total[0]).toBe("Grand Total");
    expect(r.result.total[1]).toBe(35);
    expect(r.result.total[2]).toBe(3);
    expect(r.result.total[3]).toBeCloseTo(35 / 3);
    expect(r.result.total[4]).toBe(5);
    expect(r.result.total[5]).toBe(20);
  });
});
