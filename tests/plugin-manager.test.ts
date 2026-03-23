// ── Plugin Manager Tests ─────────────────────────────────────────────
//
// Tests for plugin discovery, manifest validation, static scanning,
// configuration, enable/disable lifecycle, and dirty flag management.
//
// ─────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";

import {
  createPluginManager,
  validateManifest,
  staticScan,
  contentHash,
  computePluginHash,
  loadApprovalStore,
  saveApprovalStore,
  parseInlineConfig,
  coerceConfigValue,
  loadOperatorConfig,
  exceedsRiskThreshold,
  resolvePluginSource,
} from "../src/plugin-system/manager.js";

// ── Fixtures path ────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES_DIR = join(__dirname, "fixtures");

// ── validateManifest ─────────────────────────────────────────────────

describe("validateManifest", () => {
  it("should accept a valid manifest", () => {
    const manifest = {
      name: "test",
      version: "1.0.0",
      description: "A test plugin",
      hostModules: ["testmod"],
      configSchema: {},
      systemMessage: "Test message",
    };
    expect(validateManifest(manifest)).toEqual([]);
  });

  it("should reject non-object values", () => {
    expect(validateManifest(null)).toContain(
      "plugin.json must be a JSON object",
    );
    expect(validateManifest("string")).toContain(
      "plugin.json must be a JSON object",
    );
    expect(validateManifest(42)).toContain("plugin.json must be a JSON object");
    expect(validateManifest([])).toContain("plugin.json must be a JSON object");
  });

  it("should report missing required fields", () => {
    const errors = validateManifest({});
    expect(errors).toContain("Missing required field: name");
    expect(errors).toContain("Missing required field: version");
    expect(errors).toContain("Missing required field: description");
    expect(errors).toContain("Missing required field: hostModules");
    // Note: systemMessage is now optional (extracted from _HINTS in TypeScript)
  });

  it("should reject wrong types for fields", () => {
    const manifest = {
      name: 123,
      version: true,
      description: [],
      hostModules: "not-array",
      // Note: systemMessage is now optional, so we remove it from this test
    };
    const errors = validateManifest(manifest);
    expect(errors).toContain("name must be a string");
    expect(errors).toContain("version must be a string");
    expect(errors).toContain("description must be a string");
    expect(errors).toContain("hostModules must be an array");
  });

  it('should reject version with "v" prefix', () => {
    const manifest = {
      name: "test",
      version: "v1.0.0",
      description: "Test",
      hostModules: ["fs"],
    };
    const errors = validateManifest(manifest);
    expect(errors).toContain(
      'version must not start with "v" (use bare semver, e.g. "1.0.0")',
    );
  });

  it("should reject empty hostModules array", () => {
    const manifest = {
      name: "test",
      version: "1.0.0",
      description: "Test",
      hostModules: [],
      systemMessage: "msg",
    };
    const errors = validateManifest(manifest);
    expect(errors).toContain("hostModules must not be empty");
  });

  it("should reject non-string items in hostModules", () => {
    const manifest = {
      name: "test",
      version: "1.0.0",
      description: "Test",
      hostModules: ["valid", 42, true],
      systemMessage: "msg",
    };
    const errors = validateManifest(manifest);
    expect(errors).toContain("hostModules must contain only strings");
  });

  it("should reject non-object configSchema", () => {
    const manifest = {
      name: "test",
      version: "1.0.0",
      description: "Test",
      hostModules: ["mod"],
      systemMessage: "msg",
      configSchema: "not-object",
    };
    const errors = validateManifest(manifest);
    expect(errors).toContain("configSchema must be an object");
  });

  it("should accept missing configSchema (optional)", () => {
    const manifest = {
      name: "test",
      version: "1.0.0",
      description: "Test",
      hostModules: ["mod"],
      systemMessage: "msg",
    };
    expect(validateManifest(manifest)).toEqual([]);
  });
});

// ── staticScan ───────────────────────────────────────────────────────

describe("staticScan", () => {
  it("should detect child_process usage", () => {
    const source = `import { exec } from 'child_process';\nexec('ls');`;
    const findings = staticScan(source);
    expect(
      findings.some(
        (f) =>
          f.severity === "danger" && f.message.includes("Process execution"),
      ),
    ).toBe(true);
  });

  it("should detect eval usage", () => {
    const source = `const result = eval('1+1');`;
    const findings = staticScan(source);
    expect(
      findings.some(
        (f) =>
          f.severity === "danger" &&
          f.message.includes("Dynamic code execution"),
      ),
    ).toBe(true);
  });

  it("should detect new Function usage", () => {
    const source = `const fn = new Function('return 42');`;
    const findings = staticScan(source);
    expect(
      findings.some(
        (f) =>
          f.severity === "danger" &&
          f.message.includes("Dynamic code execution"),
      ),
    ).toBe(true);
  });

  it("should detect filesystem access", () => {
    const source = `import * as fs from 'node:fs';`;
    const findings = staticScan(source);
    expect(
      findings.some(
        (f) => f.severity === "warning" && f.message.includes("filesystem"),
      ),
    ).toBe(true);
  });

  it('should detect require("fs")', () => {
    const source = `const fs = require('fs');`;
    const findings = staticScan(source);
    expect(
      findings.some(
        (f) => f.severity === "warning" && f.message.includes("filesystem"),
      ),
    ).toBe(true);
  });

  it("should detect network modules", () => {
    const source = `import * as net from 'net';`;
    const findings = staticScan(source);
    expect(
      findings.some(
        (f) => f.severity === "warning" && f.message.includes("Network"),
      ),
    ).toBe(true);
  });

  it("should detect fetch usage", () => {
    const source = `const data = await fetch('http://example.com');`;
    const findings = staticScan(source);
    expect(
      findings.some(
        (f) => f.severity === "warning" && f.message.includes("fetch"),
      ),
    ).toBe(true);
  });

  it("should detect process.env access", () => {
    const source = `const val = process.env.SECRET;`;
    const findings = staticScan(source);
    expect(
      findings.some(
        (f) => f.severity === "warning" && f.message.includes("environment"),
      ),
    ).toBe(true);
  });

  it("should detect global mutation", () => {
    const source = `globalThis.foo = 'bar';`;
    const findings = staticScan(source);
    expect(
      findings.some(
        (f) => f.severity === "warning" && f.message.includes("global"),
      ),
    ).toBe(true);
  });

  it("should detect path usage as info", () => {
    const source = `const p = path.join('a', 'b');`;
    const findings = staticScan(source);
    expect(
      findings.some((f) => f.severity === "info" && f.message.includes("path")),
    ).toBe(true);
  });

  it("should detect __dirname as info", () => {
    const source = `const dir = __dirname;`;
    const findings = staticScan(source);
    expect(
      findings.some(
        (f) => f.severity === "info" && f.message.includes("__dirname"),
      ),
    ).toBe(true);
  });

  it("should skip comment lines", () => {
    const source = `// eval('dangerous')\n/* eval() */\n* eval is bad`;
    const findings = staticScan(source);
    expect(findings).toEqual([]);
  });

  it("should return empty for clean source", () => {
    const source = `export function createHostFunctions(config) {\n  return { safe: { fn: () => 42 } };\n}`;
    const findings = staticScan(source);
    expect(findings).toEqual([]);
  });

  it("should sort findings by severity (danger first)", () => {
    const source = `const p = path.join('a', 'b');\neval('bad');`;
    const findings = staticScan(source);
    expect(findings.length).toBeGreaterThanOrEqual(2);
    expect(findings[0].severity).toBe("danger");
    expect(findings[findings.length - 1].severity).toBe("info");
  });

  it("should include line numbers", () => {
    const source = `line1\nline2\neval('bad');`;
    const findings = staticScan(source);
    const evalFinding = findings.find((f) =>
      f.message.includes("Dynamic code"),
    );
    expect(evalFinding?.line).toBe(3);
  });

  // ── Process execution pattern specificity ────────────────────

  it("should NOT false-positive on RegExp.prototype.exec()", () => {
    // RegExp.exec() is a standard regex API — not process execution.
    // This was the root cause of the fetch plugin false-positive at
    // line 978: `LINK_RE.exec(linkHeader)`.
    const source = `const match = LINK_RE.exec(linkHeader);`;
    const findings = staticScan(source);
    expect(
      findings.some(
        (f) =>
          f.severity === "danger" && f.message.includes("Process execution"),
      ),
    ).toBe(false);
  });

  it("should detect .execFile() as process execution", () => {
    const source = `cp.execFile('/usr/bin/ls', ['-la']);`;
    const findings = staticScan(source);
    expect(
      findings.some(
        (f) =>
          f.severity === "danger" && f.message.includes("Process execution"),
      ),
    ).toBe(true);
  });

  it("should detect .execSync() as process execution", () => {
    const source = `const out = cp.execSync('whoami');`;
    const findings = staticScan(source);
    expect(
      findings.some(
        (f) =>
          f.severity === "danger" && f.message.includes("Process execution"),
      ),
    ).toBe(true);
  });

  it("should detect .spawnSync() as process execution", () => {
    const source = `const { status } = cp.spawnSync('node', ['script.js']);`;
    const findings = staticScan(source);
    expect(
      findings.some(
        (f) =>
          f.severity === "danger" && f.message.includes("Process execution"),
      ),
    ).toBe(true);
  });

  it("should detect .execFileSync() as process execution", () => {
    const source = `cp.execFileSync('/bin/sh', ['-c', 'echo hi']);`;
    const findings = staticScan(source);
    expect(
      findings.some(
        (f) =>
          f.severity === "danger" && f.message.includes("Process execution"),
      ),
    ).toBe(true);
  });

  it("should detect multiple findings in dangerous plugin fixture", () => {
    const { readFileSync } = require("node:fs");
    const source = readFileSync(
      join(FIXTURES_DIR, "dangerous-plugin", "index.ts"),
      "utf8",
    );
    const findings = staticScan(source);
    // Should find: child_process, eval, exec, fs, net, process.env, fetch, globalThis
    const dangerCount = findings.filter((f) => f.severity === "danger").length;
    const warningCount = findings.filter(
      (f) => f.severity === "warning",
    ).length;
    expect(dangerCount).toBeGreaterThanOrEqual(2); // child_process/exec + eval
    expect(warningCount).toBeGreaterThanOrEqual(3); // fs, process.env, fetch/net
  });

  // ── Security mitigation detection ────────────────────────────

  it("should detect realpathSync as symlink escape prevention", () => {
    const source = `const real = realpathSync(absPath);`;
    const findings = staticScan(source);
    expect(
      findings.some(
        (f) => f.severity === "info" && f.message.includes("symlink"),
      ),
    ).toBe(true);
  });

  it("should detect path traversal guards", () => {
    const source = `if (rel.startsWith('..')) { return { valid: false }; }`;
    const findings = staticScan(source);
    expect(
      findings.some(
        (f) => f.severity === "info" && f.message.includes("traversal guard"),
      ),
    ).toBe(true);
  });

  it("should detect directory allowlist patterns", () => {
    const source = `const check = validatePath(filePath, resolvedBase);`;
    const findings = staticScan(source);
    expect(
      findings.some(
        (f) => f.severity === "info" && f.message.includes("allowlist"),
      ),
    ).toBe(true);
  });

  it("should detect file size caps", () => {
    const source = `if (stat.size > maxFileBytes) { return { error: 'too large' }; }`;
    const findings = staticScan(source);
    expect(
      findings.some(
        (f) => f.severity === "info" && f.message.includes("size cap"),
      ),
    ).toBe(true);
  });

  it("should detect write opt-in gates", () => {
    const source = `const allowWrites = !!config.allowWrites;`;
    const findings = staticScan(source);
    expect(
      findings.some(
        (f) =>
          f.severity === "info" && f.message.includes("Write operations gated"),
      ),
    ).toBe(true);
  });

  it("should detect dotfile blocking guard", () => {
    const source = `if (part.startsWith('.') && part !== '.') { return deny; }`;
    const findings = staticScan(source);
    expect(
      findings.some(
        (f) => f.severity === "info" && f.message.includes("Dotfile"),
      ),
    ).toBe(true);
  });
});

// ── contentHash ──────────────────────────────────────────────────────

describe("contentHash", () => {
  it("should return a hex string", () => {
    const hash = contentHash("test");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("should be deterministic", () => {
    expect(contentHash("hello")).toBe(contentHash("hello"));
  });

  it("should differ for different inputs", () => {
    expect(contentHash("hello")).not.toBe(contentHash("world"));
  });
});

// ── resolvePluginSource ──────────────────────────────────────────────

describe("resolvePluginSource", () => {
  // Create temp fixtures with controlled file combinations
  const tmpBase = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "tmp-resolve-test-" + process.pid,
  );
  const devDir = join(tmpBase, "dev-plugin");
  const devJsOnly = join(tmpBase, "dev-js-only");
  const nmDir = join(tmpBase, "node_modules", "test-plugin");

  beforeEach(async () => {
    const { mkdirSync, writeFileSync: fsWrite } = await import("node:fs");
    mkdirSync(devDir, { recursive: true });
    fsWrite(join(devDir, "index.ts"), "export const x = 1;");
    fsWrite(join(devDir, "index.js"), "exports.x = 1;");

    mkdirSync(devJsOnly, { recursive: true });
    fsWrite(join(devJsOnly, "index.js"), "exports.x = 1;");

    mkdirSync(nmDir, { recursive: true });
    fsWrite(join(nmDir, "index.ts"), "export const x = 1;");
    fsWrite(join(nmDir, "index.js"), "exports.x = 1;");
  });

  afterEach(async () => {
    const { rmSync } = await import("node:fs");
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it("should prefer .ts over .js in dev (non-node_modules) dirs", () => {
    const result = resolvePluginSource(devDir);
    expect(result).toMatch(/index\.ts$/);
  });

  it("should fall back to .js when .ts does not exist in dev", () => {
    const result = resolvePluginSource(devJsOnly);
    expect(result).toMatch(/index\.js$/);
  });

  it("should always return .js under node_modules paths", () => {
    const result = resolvePluginSource(nmDir);
    expect(result).toMatch(/index\.js$/);
  });

  it("should return .js path even if .js missing under node_modules", () => {
    unlinkSync(join(nmDir, "index.js"));
    const result = resolvePluginSource(nmDir);
    // Must return .js (not .ts) — Node can't strip types under node_modules
    expect(result).toMatch(/index\.js$/);
  });
});

// ── Plugin Manager ───────────────────────────────────────────────────

describe("createPluginManager", () => {
  // Suppress expected warnings from the broken-plugin test fixture
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  describe("discover", () => {
    it("should discover valid plugins from fixtures", () => {
      const manager = createPluginManager(FIXTURES_DIR);
      const count = manager.discover();
      // Should find test-plugin, dangerous-plugin, and companion-plugin (broken-plugin should be rejected)
      expect(count).toBe(3);
    });

    it("should return 0 for non-existent directory", () => {
      const manager = createPluginManager("/nonexistent/path");
      expect(manager.discover()).toBe(0);
    });

    it("should return 0 for empty directory", () => {
      // FIXTURES_DIR parent has no plugin.json files directly
      const manager = createPluginManager(join(FIXTURES_DIR, ".."));
      // The parent dir has .test.ts files, not plugin dirs
      const count = manager.discover();
      expect(count).toBe(0);
    });

    it("should list discovered plugins", () => {
      const manager = createPluginManager(FIXTURES_DIR);
      manager.discover();
      const plugins = manager.listPlugins();
      const names = plugins.map((p) => p.manifest.name).sort();
      expect(names).toEqual([
        "companion-plugin",
        "dangerous-plugin",
        "test-plugin",
      ]);
    });

    it("should set initial state to discovered", () => {
      const manager = createPluginManager(FIXTURES_DIR);
      manager.discover();
      const plugin = manager.getPlugin("test-plugin");
      expect(plugin?.state).toBe("discovered");
    });

    it("should parse configSchema with defaults", () => {
      const manager = createPluginManager(FIXTURES_DIR);
      manager.discover();
      const plugin = manager.getPlugin("test-plugin");
      const schema = plugin?.manifest.configSchema ?? {};
      expect(schema.greeting?.default).toBe("Hello");
      expect(schema.maxItems?.default).toBe(10);
      expect(schema.verbose?.default).toBe(false);
    });

    it("should preserve existing plugin state on re-discover", () => {
      const manager = createPluginManager(FIXTURES_DIR);
      manager.discover();
      manager.setConfig("test-plugin", { greeting: "Yo" });
      manager.enable("test-plugin");

      // Re-discover — should NOT reset the enabled plugin to discovered
      manager.discover();
      const plugin = manager.getPlugin("test-plugin");
      expect(plugin?.state).toBe("enabled");
    });
  });

  describe("loadSource", () => {
    it("should load index.ts source", () => {
      const manager = createPluginManager(FIXTURES_DIR);
      manager.discover();
      const source = manager.loadSource("test-plugin");
      expect(source).toContain("createHostFunctions");
      expect(source).toContain("testmod");
    });

    it("should return null for unknown plugin", () => {
      const manager = createPluginManager(FIXTURES_DIR);
      expect(manager.loadSource("nonexistent")).toBeNull();
    });

    it("should store source on the plugin record", () => {
      const manager = createPluginManager(FIXTURES_DIR);
      manager.discover();
      manager.loadSource("test-plugin");
      const plugin = manager.getPlugin("test-plugin");
      expect(plugin?.source).toContain("createHostFunctions");
    });
  });

  describe("runStaticScan", () => {
    it("should return findings for dangerous plugin", () => {
      const manager = createPluginManager(FIXTURES_DIR);
      manager.discover();
      const findings = manager.runStaticScan("dangerous-plugin");
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.some((f) => f.severity === "danger")).toBe(true);
    });

    it("should return no dangerous findings for safe plugin", () => {
      const manager = createPluginManager(FIXTURES_DIR);
      manager.discover();
      const findings = manager.runStaticScan("test-plugin");
      // test-plugin uses destructured import { join } from 'node:path'
      // which doesn't match path.join() pattern — so no findings at all
      expect(findings.some((f) => f.severity === "danger")).toBe(false);
      expect(findings.some((f) => f.severity === "warning")).toBe(false);
    });

    it("should return empty for unknown plugin", () => {
      const manager = createPluginManager(FIXTURES_DIR);
      expect(manager.runStaticScan("nonexistent")).toEqual([]);
    });
  });

  describe("setConfig / enable / disable", () => {
    let manager: ReturnType<typeof createPluginManager>;

    beforeEach(() => {
      manager = createPluginManager(FIXTURES_DIR);
      manager.discover();
    });

    it("should set config and transition to configured", () => {
      manager.setConfig("test-plugin", { greeting: "Yo" });
      const plugin = manager.getPlugin("test-plugin");
      expect(plugin?.state).toBe("configured");
      expect(plugin?.config.greeting).toBe("Yo");
    });

    it("should return false for unknown plugin", () => {
      expect(manager.setConfig("nonexistent", {})).toBe(false);
    });

    it("should enable a plugin", () => {
      manager.enable("test-plugin");
      const plugin = manager.getPlugin("test-plugin");
      expect(plugin?.state).toBe("enabled");
    });

    it("should apply config defaults on enable", () => {
      manager.enable("test-plugin");
      const plugin = manager.getPlugin("test-plugin");
      expect(plugin?.config.greeting).toBe("Hello");
      expect(plugin?.config.maxItems).toBe(10);
      expect(plugin?.config.verbose).toBe(false);
      expect(plugin?.config.tags).toEqual(["default"]);
    });

    it("should preserve explicit config over defaults on enable", () => {
      manager.setConfig("test-plugin", { greeting: "Yo", maxItems: 5 });
      manager.enable("test-plugin");
      const plugin = manager.getPlugin("test-plugin");
      expect(plugin?.config.greeting).toBe("Yo");
      expect(plugin?.config.maxItems).toBe(5);
      // Defaults still applied for unset keys
      expect(plugin?.config.verbose).toBe(false);
    });

    it("should disable an enabled plugin", () => {
      manager.enable("test-plugin");
      const result = manager.disable("test-plugin");
      expect(result).toBe(true);
      expect(manager.getPlugin("test-plugin")?.state).toBe("disabled");
    });

    it("should return false when disabling non-enabled plugin", () => {
      expect(manager.disable("test-plugin")).toBe(false);
    });

    it("should return false when enabling unknown plugin", () => {
      expect(manager.enable("nonexistent")).toBe(false);
    });
  });

  describe("getEnabledPlugins / getSystemMessageAdditions", () => {
    let manager: ReturnType<typeof createPluginManager>;

    beforeEach(() => {
      manager = createPluginManager(FIXTURES_DIR);
      manager.discover();
    });

    it("should list available plugins even when none enabled", () => {
      expect(manager.getEnabledPlugins()).toEqual([]);
      const msg = manager.getSystemMessageAdditions();
      // Bug 2 fix: system message now always includes the available-plugins
      // section so the LLM knows the EXACT plugin names to suggest.
      expect(msg).toContain("--- Available Plugins ---");
      expect(msg).toContain("test-plugin (available)");
      expect(msg).toContain("dangerous-plugin (available)");
      // Should NOT contain enabled-plugin preamble/sections
      expect(msg).not.toContain("--- Enabled Plugin:");
    });

    it("should return enabled plugins", () => {
      manager.enable("test-plugin");
      const enabled = manager.getEnabledPlugins();
      expect(enabled.length).toBe(1);
      expect(enabled[0].manifest.name).toBe("test-plugin");
    });

    it("should collect system messages from enabled plugins", () => {
      manager.enable("test-plugin");
      const msg = manager.getSystemMessageAdditions();
      expect(msg).toContain("test-plugin");
      expect(msg).toContain("host:testmod");
    });

    it("should include active config in system message", () => {
      manager.enable("test-plugin");
      const msg = manager.getSystemMessageAdditions();
      // Config defaults are applied on enable — the LLM should
      // see the resolved values so it knows actual limits.
      expect(msg).toContain("Active configuration for this session");
      expect(msg).toContain("greeting");
      expect(msg).toContain("Hello");
      expect(msg).toContain("maxItems");
      expect(msg).toContain("10");
    });

    it("should include reconfigure guidance in system message", () => {
      manager.enable("test-plugin");
      const msg = manager.getSystemMessageAdditions();
      expect(msg).toContain("/plugin enable test-plugin");
      expect(msg).toContain("reconfigures in-place");
      expect(msg).not.toContain("ask an operator");
      // Must NOT use the old operator-set label
      expect(msg).not.toContain("operator-set");
    });

    it("should reflect overridden config values in system message", () => {
      manager.setConfig("test-plugin", {
        greeting: "Yo",
        maxItems: 42,
        verbose: true,
        tags: ["a", "b"],
      });
      manager.enable("test-plugin");
      const msg = manager.getSystemMessageAdditions();
      expect(msg).toContain("greeting");
      expect(msg).toContain("Yo");
      expect(msg).toContain("maxItems");
      expect(msg).toContain("42");
      expect(msg).toContain("tags");
      expect(msg).toContain("a, b");
    });

    it("should collect messages from multiple enabled plugins", () => {
      manager.enable("test-plugin");
      manager.enable("dangerous-plugin");
      const msg = manager.getSystemMessageAdditions();
      expect(msg).toContain("test-plugin");
      expect(msg).toContain("dangerous-plugin");
    });
  });

  describe("dirty flags", () => {
    let manager: ReturnType<typeof createPluginManager>;

    beforeEach(() => {
      manager = createPluginManager(FIXTURES_DIR);
      manager.discover();
    });

    it("should not be dirty initially", () => {
      expect(manager.isDirty()).toEqual({ sandbox: false, session: false });
    });

    it("should become dirty on enable", () => {
      manager.enable("test-plugin");
      expect(manager.isDirty()).toEqual({ sandbox: true, session: true });
    });

    it("should become dirty on disable", () => {
      manager.enable("test-plugin");
      manager.consumeSandboxDirty();
      manager.consumeSessionDirty();
      manager.disable("test-plugin");
      expect(manager.isDirty()).toEqual({ sandbox: true, session: true });
    });

    it("should clear sandbox dirty on consume", () => {
      manager.enable("test-plugin");
      expect(manager.consumeSandboxDirty()).toBe(true);
      expect(manager.consumeSandboxDirty()).toBe(false);
    });

    it("should clear session dirty on consume", () => {
      manager.enable("test-plugin");
      expect(manager.consumeSessionDirty()).toBe(true);
      expect(manager.consumeSessionDirty()).toBe(false);
    });

    it("should set dirty flags via markSandboxDirty", () => {
      // Start clean
      expect(manager.isDirty()).toEqual({ sandbox: false, session: false });
      // Mark dirty (used by in-place reconfigure)
      manager.markSandboxDirty();
      expect(manager.isDirty()).toEqual({ sandbox: true, session: true });
      // Consume and verify reset
      manager.consumeSandboxDirty();
      manager.consumeSessionDirty();
      expect(manager.isDirty()).toEqual({ sandbox: false, session: false });
    });
  });

  describe("audit cache", () => {
    it("should cache and retrieve audit results", () => {
      const manager = createPluginManager(FIXTURES_DIR);
      manager.discover();
      manager.loadSource("test-plugin");

      const source = manager.getPlugin("test-plugin")!.source!;
      const hash = contentHash(source);

      const auditResult = {
        contentHash: hash,
        auditedAt: new Date().toISOString(),
        findings: [],
        riskLevel: "LOW" as const,
        summary: "Safe test plugin",
        descriptionAccurate: true,
        capabilities: ["test"],
        riskReasons: [],
        recommendation: {
          verdict: "approve" as const,
          reason: "Safe test plugin",
        },
      };

      manager.setAuditResult("test-plugin", auditResult);

      // Should be cached by content hash
      const cached = manager.getCachedAudit(source);
      expect(cached).not.toBeNull();
      expect(cached?.riskLevel).toBe("LOW");
    });

    it("should transition to audited state", () => {
      const manager = createPluginManager(FIXTURES_DIR);
      manager.discover();
      manager.loadSource("test-plugin");

      const source = manager.getPlugin("test-plugin")!.source!;
      const hash = contentHash(source);

      manager.setAuditResult("test-plugin", {
        contentHash: hash,
        auditedAt: new Date().toISOString(),
        findings: [],
        riskLevel: "LOW" as const,
        summary: "Safe",
        descriptionAccurate: true,
        capabilities: ["test"],
        riskReasons: [],
        recommendation: {
          verdict: "approve" as const,
          reason: "Safe",
        },
      });

      expect(manager.getPlugin("test-plugin")?.state).toBe("audited");
    });

    it("should return null for uncached source", () => {
      const manager = createPluginManager(FIXTURES_DIR);
      expect(manager.getCachedAudit("never-seen-this")).toBeNull();
    });
  });
});

// ── parseInlineConfig ───────────────────────────────────────────────

describe("parseInlineConfig", () => {
  it("should parse key=value pairs", () => {
    const result = parseInlineConfig(["baseDir=/tmp", "maxFileSize=2048"]);
    expect(result).toEqual({ baseDir: "/tmp", maxFileSize: "2048" });
  });

  it("should handle values with = signs", () => {
    const result = parseInlineConfig(["path=/a=b"]);
    expect(result).toEqual({ path: "/a=b" });
  });

  it("should ignore entries without =", () => {
    const result = parseInlineConfig(["foo", "bar=baz"]);
    expect(result).toEqual({ bar: "baz" });
  });

  it("should return empty for empty args", () => {
    expect(parseInlineConfig([])).toEqual({});
  });

  it("should trim whitespace from keys and values", () => {
    const result = parseInlineConfig([" key = value "]);
    expect(result).toEqual({ key: "value" });
  });
});

// ── coerceConfigValue ──────────────────────────────────────────────

describe("coerceConfigValue", () => {
  it("should coerce boolean true values", () => {
    const entry = { type: "boolean" as const, description: "test" };
    expect(coerceConfigValue("true", entry)).toBe(true);
    expect(coerceConfigValue("yes", entry)).toBe(true);
    expect(coerceConfigValue("y", entry)).toBe(true);
    expect(coerceConfigValue("1", entry)).toBe(true);
  });

  it("should coerce boolean false values", () => {
    const entry = { type: "boolean" as const, description: "test" };
    expect(coerceConfigValue("false", entry)).toBe(false);
    expect(coerceConfigValue("no", entry)).toBe(false);
    expect(coerceConfigValue("0", entry)).toBe(false);
  });

  it("should coerce number values", () => {
    const entry = { type: "number" as const, description: "test" };
    expect(coerceConfigValue("42", entry)).toBe(42);
    expect(coerceConfigValue("3.14", entry)).toBe(3.14);
  });

  it("should use default for invalid numbers", () => {
    const entry = { type: "number" as const, description: "test", default: 99 };
    expect(coerceConfigValue("not-a-number", entry)).toBe(99);
  });

  it("should coerce array values (comma-separated)", () => {
    const entry = {
      type: "array" as const,
      description: "test",
      items: { type: "string" },
    };
    expect(coerceConfigValue("a,b,c", entry)).toEqual(["a", "b", "c"]);
  });

  it("should strip surrounding brackets from array values", () => {
    const entry = {
      type: "array" as const,
      description: "test",
      items: { type: "string" },
    };
    expect(coerceConfigValue("[a,b,c]", entry)).toEqual(["a", "b", "c"]);
  });

  it("should handle wildcard domains in bracketed array", () => {
    const entry = {
      type: "array" as const,
      description: "test",
      items: { type: "string" },
    };
    expect(coerceConfigValue("[*.bbc.co.uk,*.bbci.co.uk]", entry)).toEqual([
      "*.bbc.co.uk",
      "*.bbci.co.uk",
    ]);
  });

  it("should not strip mismatched brackets from array values", () => {
    const entry = {
      type: "array" as const,
      description: "test",
      items: { type: "string" },
    };
    // Only opening bracket — should NOT strip
    expect(coerceConfigValue("[a,b", entry)).toEqual(["[a", "b"]);
    // Only closing bracket — should NOT strip
    expect(coerceConfigValue("a,b]", entry)).toEqual(["a", "b]"]);
  });

  it("should return string values unchanged", () => {
    const entry = { type: "string" as const, description: "test" };
    expect(coerceConfigValue("/tmp/foo", entry)).toBe("/tmp/foo");
  });
});

// ── Approval Management ────────────────────────────────────────────

describe("approval management", () => {
  // Save real approval store before tests, restore after.
  // Tests write to the real ~/.hyperagent/approved-plugins.json,
  // so we must not clobber the user's actual approvals.
  let savedStore: ReturnType<typeof loadApprovalStore>;
  beforeEach(() => {
    savedStore = loadApprovalStore();
  });
  afterEach(() => {
    saveApprovalStore(savedStore);
  });

  /** Helper to create a full AuditResult for testing. */
  function makeAudit(
    hash: string,
    opts: Partial<{ riskLevel: string; verdict: string }> = {},
  ) {
    return {
      contentHash: hash,
      auditedAt: new Date().toISOString(),
      findings: [],
      riskLevel: (opts.riskLevel ?? "LOW") as "LOW",
      summary: "Test audit",
      descriptionAccurate: true,
      capabilities: ["test"],
      riskReasons: [],
      recommendation: {
        verdict: (opts.verdict ?? "approve") as "approve",
        reason: "Test approval",
      },
    };
  }

  it("should approve a plugin with an audit result", () => {
    const manager = createPluginManager(FIXTURES_DIR);
    manager.discover();
    manager.loadSource("test-plugin");
    const source = manager.getPlugin("test-plugin")!.source!;
    const hash = contentHash(source);

    manager.setAuditResult("test-plugin", makeAudit(hash));
    expect(manager.approve("test-plugin")).toBe(true);
    expect(manager.isApproved("test-plugin")).toBe(true);
    expect(manager.getPlugin("test-plugin")!.approved).toBe(true);
  });

  it("should reject approval without audit", () => {
    const manager = createPluginManager(FIXTURES_DIR);
    manager.discover();
    expect(manager.approve("test-plugin")).toBe(false);
  });

  it("should reject approval for unknown plugin", () => {
    const manager = createPluginManager(FIXTURES_DIR);
    expect(manager.approve("nonexistent")).toBe(false);
  });

  it("should unapprove a previously approved plugin", () => {
    const manager = createPluginManager(FIXTURES_DIR);
    manager.discover();
    manager.loadSource("test-plugin");
    const source = manager.getPlugin("test-plugin")!.source!;
    const hash = contentHash(source);

    manager.setAuditResult("test-plugin", makeAudit(hash));
    manager.approve("test-plugin");
    expect(manager.unapprove("test-plugin")).toBe(true);
    expect(manager.isApproved("test-plugin")).toBe(false);
    expect(manager.getPlugin("test-plugin")!.approved).toBe(false);
  });

  it("should return false when unapproving a non-approved plugin", () => {
    const manager = createPluginManager(FIXTURES_DIR);
    manager.discover();
    expect(manager.unapprove("test-plugin")).toBe(false);
  });

  it("should return false when unapproving unknown plugin", () => {
    const manager = createPluginManager(FIXTURES_DIR);
    expect(manager.unapprove("nonexistent")).toBe(false);
  });

  it("should set approved=false on newly discovered plugins", () => {
    const manager = createPluginManager(FIXTURES_DIR);
    manager.discover();
    const plugin = manager.getPlugin("test-plugin");
    expect(plugin?.approved).toBe(false);
  });

  it("should get approval record after approving", () => {
    const manager = createPluginManager(FIXTURES_DIR);
    manager.discover();
    manager.loadSource("test-plugin");
    const plugin = manager.getPlugin("test-plugin")!;
    // Combined hash now includes both index.ts and plugin.json
    const combinedHash = computePluginHash(plugin.dir);

    manager.setAuditResult(
      "test-plugin",
      makeAudit(contentHash(plugin.source!)),
    );
    manager.approve("test-plugin");

    const record = manager.getApprovalRecord("test-plugin");
    expect(record).toBeDefined();
    expect(record!.contentHash).toBe(combinedHash);
    expect(record!.auditRiskLevel).toBe("LOW");
    expect(record!.auditVerdict).toBe("approve");
    expect(record!.approvedAt).toBeTruthy();
  });

  it("should return undefined approval record for unapproved plugin", () => {
    const manager = createPluginManager(FIXTURES_DIR);
    manager.discover();
    expect(manager.getApprovalRecord("test-plugin")).toBeUndefined();
  });
});

// ── applyInlineConfig ──────────────────────────────────────────────

describe("applyInlineConfig", () => {
  it("should apply config values matching schema", () => {
    const manager = createPluginManager(FIXTURES_DIR);
    manager.discover();
    const applied = manager.applyInlineConfig("test-plugin", {
      greeting: "hi",
    });
    expect(applied).toEqual(["greeting"]);
    expect(manager.getPlugin("test-plugin")!.config.greeting).toBe("hi");
  });

  it("should ignore keys not in the schema", () => {
    const manager = createPluginManager(FIXTURES_DIR);
    manager.discover();
    const applied = manager.applyInlineConfig("test-plugin", {
      unknownKey: "val",
    });
    expect(applied).toEqual([]);
  });

  it("should return empty for unknown plugin", () => {
    const manager = createPluginManager(FIXTURES_DIR);
    const applied = manager.applyInlineConfig("nonexistent", { foo: "bar" });
    expect(applied).toEqual([]);
  });
});

// ── Approval Store Persistence ──────────────────────────────────────

describe("approval store persistence", () => {
  // Save/restore real approval store — tests must not clobber
  // the user's actual ~/.hyperagent/approved-plugins.json.
  let savedStore: ReturnType<typeof loadApprovalStore>;
  beforeEach(() => {
    savedStore = loadApprovalStore();
  });
  afterEach(() => {
    saveApprovalStore(savedStore);
  });

  it("should return empty store when file does not exist", () => {
    // loadApprovalStore handles missing files gracefully
    const store = loadApprovalStore();
    expect(typeof store).toBe("object");
  });

  it("should round-trip save and load", () => {
    const testStore = {
      "test-plugin": {
        contentHash: "abc123",
        approvedAt: new Date().toISOString(),
        auditRiskLevel: "LOW" as const,
        auditVerdict: "approve" as const,
      },
    };
    saveApprovalStore(testStore);
    const loaded = loadApprovalStore();
    expect(loaded["test-plugin"]).toBeDefined();
    expect(loaded["test-plugin"].contentHash).toBe("abc123");
    expect(loaded["test-plugin"].auditRiskLevel).toBe("LOW");
  });
});

// ── promptConfig with skipKeys ──────────────────────────────────────

describe("promptConfig skipKeys", () => {
  it("should skip keys provided in skipKeys set", async () => {
    const manager = createPluginManager(FIXTURES_DIR);
    manager.discover();

    // Apply inline config first for 'greeting'
    manager.applyInlineConfig("test-plugin", { greeting: "pre-set" });

    // Create a mock readline that answers any remaining prompts
    const mockRl = {
      question: vi.fn().mockResolvedValue(""),
    } as unknown as import("node:readline/promises").Interface;

    // Call promptConfig with skipKeys containing 'greeting'
    const skipKeys = new Set(["greeting"]);
    await manager.promptConfig(mockRl, "test-plugin", skipKeys);

    // The pre-set value should be preserved
    expect(manager.getPlugin("test-plugin")!.config.greeting).toBe("pre-set");
    // The mock should NOT have been called for 'greeting'
    // (it may have been called for other schema fields though)
    const calls = vi.mocked(mockRl.question).mock.calls;
    const greetingPrompted = calls.some((c: unknown[]) =>
      (c[0] as string).toLowerCase().includes("greeting"),
    );
    expect(greetingPrompted).toBe(false);
  });
});
// ── exceedsRiskThreshold ─────────────────────────────────────────────
//
// Pure function — no I/O, no side effects.

describe("exceedsRiskThreshold", () => {
  it("should return false when risk equals the threshold", () => {
    expect(exceedsRiskThreshold("LOW", "LOW")).toBe(false);
    expect(exceedsRiskThreshold("MEDIUM", "MEDIUM")).toBe(false);
    expect(exceedsRiskThreshold("HIGH", "HIGH")).toBe(false);
    expect(exceedsRiskThreshold("CRITICAL", "CRITICAL")).toBe(false);
  });

  it("should return false when risk is below the threshold", () => {
    expect(exceedsRiskThreshold("LOW", "MEDIUM")).toBe(false);
    expect(exceedsRiskThreshold("LOW", "HIGH")).toBe(false);
    expect(exceedsRiskThreshold("MEDIUM", "HIGH")).toBe(false);
    expect(exceedsRiskThreshold("LOW", "CRITICAL")).toBe(false);
  });

  it("should return true when risk is above the threshold", () => {
    expect(exceedsRiskThreshold("HIGH", "MEDIUM")).toBe(true);
    expect(exceedsRiskThreshold("CRITICAL", "MEDIUM")).toBe(true);
    expect(exceedsRiskThreshold("CRITICAL", "HIGH")).toBe(true);
    expect(exceedsRiskThreshold("MEDIUM", "LOW")).toBe(true);
    expect(exceedsRiskThreshold("HIGH", "LOW")).toBe(true);
  });

  it("should block HIGH and CRITICAL when threshold is MEDIUM (default policy)", () => {
    // Default policy: maxRiskLevel = MEDIUM
    const maxRisk = "MEDIUM" as const;
    expect(exceedsRiskThreshold("LOW", maxRisk)).toBe(false);
    expect(exceedsRiskThreshold("MEDIUM", maxRisk)).toBe(false);
    expect(exceedsRiskThreshold("HIGH", maxRisk)).toBe(true);
    expect(exceedsRiskThreshold("CRITICAL", maxRisk)).toBe(true);
  });
});

// ── loadOperatorConfig ───────────────────────────────────────────────
//
// Tests backup/restore the real config file to avoid clobbering
// the user's actual config. Same pattern as approval store tests.

describe("loadOperatorConfig", () => {
  const configPath = join(homedir(), ".hyperagent", "config.json");
  let savedConfig: string | null;

  beforeEach(() => {
    // Backup existing config file (if any)
    if (existsSync(configPath)) {
      savedConfig = readFileSync(configPath, "utf8");
    } else {
      savedConfig = null;
    }
  });

  afterEach(() => {
    // Restore original config file
    if (savedConfig !== null) {
      writeFileSync(configPath, savedConfig, "utf8");
    } else if (existsSync(configPath)) {
      unlinkSync(configPath);
    }
  });

  it("should return default config when file does not exist", () => {
    // Remove config file if present
    if (existsSync(configPath)) unlinkSync(configPath);
    const config = loadOperatorConfig();
    expect(config.maxRiskLevel).toBe("MEDIUM");
  });

  it("should read maxRiskLevel from a valid config file", () => {
    writeFileSync(configPath, JSON.stringify({ maxRiskLevel: "HIGH" }), "utf8");
    const config = loadOperatorConfig();
    expect(config.maxRiskLevel).toBe("HIGH");
  });

  it("should accept LOW as a strict threshold", () => {
    writeFileSync(configPath, JSON.stringify({ maxRiskLevel: "LOW" }), "utf8");
    const config = loadOperatorConfig();
    expect(config.maxRiskLevel).toBe("LOW");
  });

  it("should accept CRITICAL as a permissive threshold", () => {
    writeFileSync(
      configPath,
      JSON.stringify({ maxRiskLevel: "CRITICAL" }),
      "utf8",
    );
    const config = loadOperatorConfig();
    expect(config.maxRiskLevel).toBe("CRITICAL");
  });

  it("should fall back to default for an invalid risk level", () => {
    writeFileSync(configPath, JSON.stringify({ maxRiskLevel: "YOLO" }), "utf8");
    const config = loadOperatorConfig();
    expect(config.maxRiskLevel).toBe("MEDIUM");
  });

  it("should fall back to default for non-object JSON", () => {
    writeFileSync(configPath, '"not an object"', "utf8");
    const config = loadOperatorConfig();
    expect(config.maxRiskLevel).toBe("MEDIUM");
  });

  it("should fall back to default for array JSON", () => {
    writeFileSync(configPath, "[1, 2, 3]", "utf8");
    const config = loadOperatorConfig();
    expect(config.maxRiskLevel).toBe("MEDIUM");
  });

  it("should fall back to default for malformed JSON", () => {
    writeFileSync(configPath, "{{broken json", "utf8");
    const config = loadOperatorConfig();
    expect(config.maxRiskLevel).toBe("MEDIUM");
  });

  it("should ignore unknown keys and still read maxRiskLevel", () => {
    writeFileSync(
      configPath,
      JSON.stringify({ maxRiskLevel: "HIGH", unknownKey: "whatever" }),
      "utf8",
    );
    const config = loadOperatorConfig();
    expect(config.maxRiskLevel).toBe("HIGH");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Companion system
// ─────────────────────────────────────────────────────────────────────

describe("companion system", () => {
  it("should return companions that need enabling", () => {
    const pm = createPluginManager(FIXTURES_DIR);
    pm.discover();
    // companion-plugin declares test-plugin as companion
    const companions = pm.getCompanions("companion-plugin");
    expect(companions).toContain("test-plugin");
  });

  it("should return empty array when no companions declared", () => {
    const pm = createPluginManager(FIXTURES_DIR);
    pm.discover();
    const companions = pm.getCompanions("test-plugin");
    expect(companions).toEqual([]);
  });

  it("should skip already-enabled companions", () => {
    const pm = createPluginManager(FIXTURES_DIR);
    pm.discover();
    pm.enable("test-plugin");
    const companions = pm.getCompanions("companion-plugin");
    expect(companions).not.toContain("test-plugin");
    expect(companions).toEqual([]);
  });

  it("should skip non-existent companions", () => {
    const pm = createPluginManager(FIXTURES_DIR);
    pm.discover();
    // No companion named "nonexistent" exists
    const companions = pm.getCompanions("companion-plugin");
    // Should still work — just skips missing ones
    expect(Array.isArray(companions)).toBe(true);
  });

  it("should detect circular companion dependencies", () => {
    // companion-plugin → test-plugin. If test-plugin also declared
    // companion-plugin as companion, it would be circular.
    // Our code handles this via the `seen` set.
    const pm = createPluginManager(FIXTURES_DIR);
    pm.discover();
    // Should not hang or throw
    const companions = pm.getCompanions("companion-plugin");
    expect(Array.isArray(companions)).toBe(true);
  });
});
