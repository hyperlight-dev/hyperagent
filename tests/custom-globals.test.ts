// ── Custom Globals Tests ──────────────────────────────────────────────
//
// Tests for the Web API globals provided by native-globals Rust crate:
//   TextEncoder, TextDecoder, atob, btoa, queueMicrotask
//
// These globals are registered via custom_globals! in the hyperagent
// runtime and should be available in all handler code without import.
// ──────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createSandboxTool } from "../src/sandbox/tool.js";

let sandbox: ReturnType<typeof createSandboxTool>;

beforeAll(async () => {
  sandbox = createSandboxTool();
});

afterAll(() => {
  // Sandbox cleanup happens automatically
});

// Helper to run handler code and return result
async function run(code: string): Promise<unknown> {
  const name = `test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const reg = await sandbox.registerHandler(name, code);
  if (!reg.success) {
    throw new Error(`Handler registration failed: ${JSON.stringify(reg)}`);
  }
  const exec = await sandbox.executeJavaScript(name);
  if (!exec.success) {
    throw new Error(`Handler execution failed: ${JSON.stringify(exec)}`);
  }
  return exec.result;
}

describe("TextEncoder", () => {
  it("should be available as a global", async () => {
    const result = await run(`
      function handler() {
        return { exists: typeof TextEncoder === 'function' };
      }
    `);
    expect(result).toEqual({ exists: true });
  });

  it("should encode ASCII to UTF-8 bytes", async () => {
    const result = await run(`
      function handler() {
        const encoder = new TextEncoder();
        const bytes = encoder.encode("hello");
        return {
          length: bytes.length,
          bytes: Array.from(bytes),
          encoding: encoder.encoding
        };
      }
    `);
    expect(result).toEqual({
      length: 5,
      bytes: [104, 101, 108, 108, 111],
      encoding: "utf-8",
    });
  });

  it("should encode Unicode (multi-byte) correctly", async () => {
    const result = (await run(`
      function handler() {
        const bytes = new TextEncoder().encode("café");
        return { length: bytes.length };
      }
    `)) as { length: number };
    // "café" = c(1) + a(1) + f(1) + é(2) = 5 bytes in UTF-8
    expect(result.length).toBe(5);
  });

  it("should encode emoji (4-byte UTF-8)", async () => {
    const result = (await run(`
      function handler() {
        const bytes = new TextEncoder().encode("🎸");
        return { length: bytes.length, bytes: Array.from(bytes) };
      }
    `)) as { length: number; bytes: number[] };
    // 🎸 is U+1F3B8 → 4 bytes in UTF-8: F0 9F 8E B8
    expect(result.length).toBe(4);
    expect(result.bytes).toEqual([0xf0, 0x9f, 0x8e, 0xb8]);
  });

  it("should handle empty string", async () => {
    const result = (await run(`
      function handler() {
        return { length: new TextEncoder().encode("").length };
      }
    `)) as { length: number };
    expect(result.length).toBe(0);
  });

  it("should handle undefined/null input", async () => {
    const result = (await run(`
      function handler() {
        const e = new TextEncoder();
        return {
          undef: e.encode(undefined).length,
          nil: e.encode(null).length,
        };
      }
    `)) as { undef: number; nil: number };
    expect(result.undef).toBe(0);
    expect(result.nil).toBe(0);
  });
});

describe("TextDecoder", () => {
  it("should be available as a global", async () => {
    const result = await run(`
      function handler() {
        return { exists: typeof TextDecoder === 'function' };
      }
    `);
    expect(result).toEqual({ exists: true });
  });

  it("should decode UTF-8 bytes to string", async () => {
    const result = await run(`
      function handler() {
        const decoder = new TextDecoder();
        const bytes = new Uint8Array([104, 101, 108, 108, 111]);
        return {
          text: decoder.decode(bytes),
          encoding: decoder.encoding
        };
      }
    `);
    expect(result).toEqual({ text: "hello", encoding: "utf-8" });
  });

  it("should handle empty input", async () => {
    const result = await run(`
      function handler() {
        const d = new TextDecoder();
        return {
          empty: d.decode(new Uint8Array([])),
          undef: d.decode(undefined),
          nil: d.decode(null),
        };
      }
    `);
    expect(result).toEqual({ empty: "", undef: "", nil: "" });
  });

  it("should reject non-UTF-8 encoding", async () => {
    const result = await run(`
      function handler() {
        try {
          new TextDecoder("latin1");
          return { threw: false };
        } catch (e) {
          return { threw: true, message: e.message };
        }
      }
    `);
    expect((result as { threw: boolean }).threw).toBe(true);
  });
});

describe("TextEncoder + TextDecoder roundtrip", () => {
  it("should roundtrip ASCII", async () => {
    const result = await run(`
      function handler() {
        const original = "Hello, World!";
        const encoded = new TextEncoder().encode(original);
        const decoded = new TextDecoder().decode(encoded);
        return { match: original === decoded };
      }
    `);
    expect(result).toEqual({ match: true });
  });

  it("should roundtrip Unicode with emoji", async () => {
    const result = await run(`
      function handler() {
        const original = "Hello 🌍 café résumé 日本語";
        const encoded = new TextEncoder().encode(original);
        const decoded = new TextDecoder().decode(encoded);
        return { match: original === decoded, original, decoded };
      }
    `);
    expect((result as { match: boolean }).match).toBe(true);
  });
});

describe("atob / btoa", () => {
  it("atob should decode base64", async () => {
    const result = await run(`
      function handler() {
        return { decoded: atob("aGVsbG8=") };
      }
    `);
    expect(result).toEqual({ decoded: "hello" });
  });

  it("btoa should encode to base64", async () => {
    const result = await run(`
      function handler() {
        return { encoded: btoa("hello") };
      }
    `);
    expect(result).toEqual({ encoded: "aGVsbG8=" });
  });

  it("atob + btoa roundtrip", async () => {
    const result = await run(`
      function handler() {
        const original = "Hello, World! 123";
        return { match: atob(btoa(original)) === original };
      }
    `);
    expect(result).toEqual({ match: true });
  });

  it("btoa should throw on chars > 255", async () => {
    const result = await run(`
      function handler() {
        try {
          btoa("emoji 🎸");
          return { threw: false };
        } catch (e) {
          return { threw: true };
        }
      }
    `);
    expect(result).toEqual({ threw: true });
  });

  it("atob should handle padding correctly", async () => {
    const result = await run(`
      function handler() {
        return {
          one: atob("YQ=="),   // "a"
          two: atob("YWI="),   // "ab"
          three: atob("YWJj"), // "abc"
        };
      }
    `);
    expect(result).toEqual({ one: "a", two: "ab", three: "abc" });
  });
});

describe("queueMicrotask", () => {
  it("should be available as a global", async () => {
    const result = await run(`
      function handler() {
        return { exists: typeof queueMicrotask === 'function' };
      }
    `);
    expect(result).toEqual({ exists: true });
  });
});

describe("globals survive handler recompilation", () => {
  it("TextEncoder survives adding a new handler", async () => {
    const name1 = `survive_1_${Date.now()}`;
    const name2 = `survive_2_${Date.now()}`;

    await sandbox.registerHandler(
      name1,
      `function handler() {
        return new TextEncoder().encode("a").length;
      }`,
    );
    // Register second handler (triggers recompile of all handlers)
    await sandbox.registerHandler(
      name2,
      `function handler() {
        return new TextDecoder().decode(new Uint8Array([98]));
      }`,
    );

    const r1 = await sandbox.executeJavaScript(name1);
    const r2 = await sandbox.executeJavaScript(name2);
    expect(r1.result).toBe(1);
    expect(r2.result).toBe("b");
  });

  it("atob/btoa survive handler recompilation", async () => {
    const name1 = `atob_1_${Date.now()}`;
    const name2 = `atob_2_${Date.now()}`;

    await sandbox.registerHandler(
      name1,
      `function handler() { return btoa("test"); }`,
    );
    await sandbox.registerHandler(
      name2,
      `function handler() { return atob("dGVzdA=="); }`,
    );

    const r1 = await sandbox.executeJavaScript(name1);
    const r2 = await sandbox.executeJavaScript(name2);
    expect(r1.result).toBe("dGVzdA==");
    expect(r2.result).toBe("test");
  });
});

describe("console output capture", () => {
  it("should capture console.log output", async () => {
    const name = `console_${Date.now()}`;
    await sandbox.registerHandler(
      name,
      `function handler() {
        console.log("hello from handler");
        return { ok: true };
      }`,
    );
    const result = await sandbox.executeJavaScript(name);
    expect(result.success).toBe(true);
    expect(result.consoleOutput).toBeDefined();
    expect(result.consoleOutput!.length).toBeGreaterThan(0);
    expect(result.consoleOutput!.join("")).toContain("hello from handler");
  });

  it("should capture multiple console.log calls", async () => {
    const name = `console_multi_${Date.now()}`;
    await sandbox.registerHandler(
      name,
      `function handler() {
        console.log("line 1");
        console.log("line 2");
        console.log("line 3");
        return { count: 3 };
      }`,
    );
    const result = await sandbox.executeJavaScript(name);
    expect(result.success).toBe(true);
    const output = result.consoleOutput?.join("") ?? "";
    expect(output).toContain("line 1");
    expect(output).toContain("line 2");
    expect(output).toContain("line 3");
  });

  it("should return undefined consoleOutput when no logs", async () => {
    const name = `console_none_${Date.now()}`;
    await sandbox.registerHandler(
      name,
      `function handler() { return { silent: true }; }`,
    );
    const result = await sandbox.executeJavaScript(name);
    expect(result.success).toBe(true);
    expect(result.consoleOutput).toBeUndefined();
  });

  it("should capture output even on error", async () => {
    const name = `console_error_${Date.now()}`;
    await sandbox.registerHandler(
      name,
      `function handler() {
        console.log("before error");
        throw new Error("intentional");
      }`,
    );
    const result = await sandbox.executeJavaScript(name);
    expect(result.success).toBe(false);
    expect(result.consoleOutput).toBeDefined();
    expect(result.consoleOutput!.join("")).toContain("before error");
  });

  it("should not leak output between executions", async () => {
    const name1 = `leak_1_${Date.now()}`;
    const name2 = `leak_2_${Date.now()}`;
    await sandbox.registerHandler(
      name1,
      `function handler() { console.log("from handler 1"); return 1; }`,
    );
    await sandbox.registerHandler(
      name2,
      `function handler() { console.log("from handler 2"); return 2; }`,
    );
    const r1 = await sandbox.executeJavaScript(name1);
    const r2 = await sandbox.executeJavaScript(name2);

    // Each execution should only have its own output
    const o1 = r1.consoleOutput?.join("") ?? "";
    const o2 = r2.consoleOutput?.join("") ?? "";
    expect(o1).toContain("from handler 1");
    expect(o1).not.toContain("from handler 2");
    expect(o2).toContain("from handler 2");
    expect(o2).not.toContain("from handler 1");
  });
});

describe("console.warn/error/info/debug", () => {
  it("console.warn should work", async () => {
    const result = await run(`
      function handler() {
        console.warn("warn test");
        return { ok: true };
      }
    `);
    expect(result).toEqual({ ok: true });
  });

  it("console.error should work", async () => {
    const result = await run(`
      function handler() {
        console.error("error test");
        return { ok: true };
      }
    `);
    expect(result).toEqual({ ok: true });
  });

  it("console.info should work", async () => {
    const result = await run(`
      function handler() {
        console.info("info test");
        return { ok: true };
      }
    `);
    expect(result).toEqual({ ok: true });
  });

  it("console.debug should work", async () => {
    const result = await run(`
      function handler() {
        console.debug("debug test");
        return { ok: true };
      }
    `);
    expect(result).toEqual({ ok: true });
  });

  it("console.log should still work alongside aliases", async () => {
    const result = await run(`
      function handler() {
        console.log("log");
        console.warn("warn");
        console.error("error");
        console.info("info");
        console.debug("debug");
        return { ok: true };
      }
    `);
    expect(result).toEqual({ ok: true });
  });

  it("console.warn output should be captured", async () => {
    const name = `warn_capture_${Date.now()}`;
    await sandbox.registerHandler(
      name,
      `function handler() {
        console.warn("warning message");
        return { ok: true };
      }`,
    );
    const result = await sandbox.executeJavaScript(name);
    expect(result.success).toBe(true);
    expect(result.consoleOutput).toBeDefined();
    expect(result.consoleOutput!.join("")).toContain("warning message");
  });
});

// ── Native Rust Module Availability ──────────────────────────────────
// Native modules (html, markdown, image, ziplib) are compiled into the
// Hyperlight runtime. They must appear in getAvailableModules() so the
// validator accepts imports, and must actually work when imported.

describe("native module visibility", () => {
  const NATIVE_MODULES = ["ha:html", "ha:markdown", "ha:image", "ha:ziplib"];

  it("getAvailableModules includes all native modules", () => {
    const available = sandbox.getAvailableModules();
    for (const mod of NATIVE_MODULES) {
      expect(available, `${mod} missing from getAvailableModules()`).toContain(
        mod,
      );
    }
  });

  it("ha:html handler registers successfully", async () => {
    const code = `
      import { parse_html, html_to_text, extract_links } from "ha:html";
      function handler() {
        const html = '<h1>Test</h1><p>Hello <a href="https://example.com">link</a></p>';
        const parsed = parse_html(html);
        const text = html_to_text(html);
        return { textLength: text.length, linkCount: parsed.links.length };
      }
    `;
    const reg = await sandbox.registerHandler("test_html_native", code);
    expect(reg.success, `ha:html register failed: ${reg.error}`).toBe(true);
  });

  it("ha:markdown handler registers successfully", async () => {
    const code = `
      import { markdown_to_html, markdown_to_text } from "ha:markdown";
      function handler() {
        const md = "# Hello\\n\\n**bold** text";
        const html = markdown_to_html(md);
        const text = markdown_to_text(md);
        return { htmlLength: html.length, textLength: text.length };
      }
    `;
    const reg = await sandbox.registerHandler("test_md_native", code);
    expect(reg.success, `ha:markdown register failed: ${reg.error}`).toBe(true);
  });

  it("ha:image handler registers successfully", async () => {
    const code = `
      import { detect_image_dimensions } from "ha:image";
      function handler() {
        return { available: typeof detect_image_dimensions === "function" };
      }
    `;
    const reg = await sandbox.registerHandler("test_img_native", code);
    expect(reg.success, `ha:image register failed: ${reg.error}`).toBe(true);
  });
});
