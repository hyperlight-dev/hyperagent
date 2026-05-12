// ── Module Store Tests ───────────────────────────────────────────────
//
// Tests for module persistence, validation, and metadata.
// Uses a temporary directory to avoid polluting ~/.hyperagent/modules/.
//
// ─────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import {
  mkdirSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  readdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  validateModuleName,
  findOverlappingExports,
  loadModule,
  loadModuleAsync,
  saveModule,
  getModulesDir,
  listModules,
} from "../src/agent/module-store.js";

// Get paths for builtin module syncing
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BUILTIN_DIR = join(__dirname, "..", "builtin-modules");

// ── Name Validation ──────────────────────────────────────────────────

describe("validateModuleName", () => {
  it("should accept valid kebab-case names", () => {
    expect(validateModuleName("str-bytes")).toBeNull();
    expect(validateModuleName("crc32")).toBeNull();
    expect(validateModuleName("my-utils")).toBeNull();
    expect(validateModuleName("a")).toBeNull();
  });

  it("should reject empty name", () => {
    expect(validateModuleName("")).toBeTruthy();
  });

  it("should reject names starting with a digit", () => {
    expect(validateModuleName("123abc")).toBeTruthy();
  });

  it("should reject names with uppercase", () => {
    expect(validateModuleName("MyModule")).toBeTruthy();
  });

  it("should reject names with underscores", () => {
    expect(validateModuleName("my_module")).toBeTruthy();
  });

  it("should reject names with dots", () => {
    expect(validateModuleName("my.module")).toBeTruthy();
  });

  it("should reject names with path traversal", () => {
    expect(validateModuleName("../evil")).toBeTruthy();
  });

  it("should reject names longer than 64 characters", () => {
    expect(validateModuleName("a".repeat(65))).toBeTruthy();
  });

  it("should accept max-length name (64 chars)", () => {
    expect(validateModuleName("a".repeat(64))).toBeNull();
  });
});

// ── Structured Hints ──────────────────────────────────────────────────

describe("structuredHints from JSON metadata", () => {
  // Sync builtin modules to ~/.hyperagent/modules/ before running tests
  beforeAll(() => {
    const modulesDir = getModulesDir();
    const builtins = readdirSync(BUILTIN_DIR).filter(
      (f) => f.endsWith(".js") || f.endsWith(".json"),
    );
    for (const file of builtins) {
      copyFileSync(join(BUILTIN_DIR, file), join(modulesDir, file));
    }
  });

  it("should load structuredHints from pptx module JSON", async () => {
    const mod = await loadModuleAsync("pptx");
    expect(mod).not.toBeNull();
    expect(mod!.structuredHints).toBeDefined();
    expect(mod!.structuredHints!.overview).toContain("PPTX");
    expect(mod!.structuredHints!.relatedModules).toContain("ha:pptx-charts");
  });

  it("should load structuredHints from shared-state module JSON", async () => {
    const mod = await loadModuleAsync("shared-state");
    expect(mod).not.toBeNull();
    expect(mod!.structuredHints).toBeDefined();
    expect(mod!.structuredHints!.criticalRules).toBeDefined();
    expect(mod!.structuredHints!.criticalRules!.length).toBeGreaterThan(0);
  });

  it("should load structuredHints from crc32 module JSON", async () => {
    const mod = await loadModuleAsync("crc32");
    expect(mod).not.toBeNull();
    expect(mod!.structuredHints).toBeDefined();
    expect(mod!.structuredHints!.overview).toBeTruthy();
  });

  it("should no longer have legacy _HINTS string (removed from source)", async () => {
    const mod = await loadModuleAsync("pptx");
    expect(mod).not.toBeNull();
    // Legacy _HINTS was removed from source, should be undefined
    expect(mod!.hints).toBeUndefined();
  });
});

// ── Metadata Cache ────────────────────────────────────────────────────

describe("metadata cache", () => {
  const testModuleName = "test-cache-module";
  const modulesDir = getModulesDir();
  const jsonPath = join(modulesDir, `${testModuleName}.json`);
  const jsPath = join(modulesDir, `${testModuleName}.js`);

  afterEach(() => {
    // Clean up test module
    if (existsSync(jsonPath)) rmSync(jsonPath);
    if (existsSync(jsPath)) rmSync(jsPath);
  });

  it("should write cache to .json file after saveModule", async () => {
    const source = `export function greet(name) { return "Hello " + name; }`;
    await saveModule(testModuleName, source, "Test module");

    // Check .json file exists and has metadataCache
    expect(existsSync(jsonPath)).toBe(true);
    const json = JSON.parse(readFileSync(jsonPath, "utf-8"));
    expect(json.metadataCache).toBeDefined();
    expect(json.metadataCache.extractedFromHash).toMatch(/^sha256:/);
    expect(json.metadataCache.exports).toHaveLength(1);
    expect(json.metadataCache.exports[0].name).toBe("greet");
  });

  it("should use cached metadata in sync loadModule", async () => {
    const source = `export function cached() { return 42; }`;
    await saveModule(testModuleName, source, "Test module");

    // Sync loadModule should return cached exports (not empty)
    const mod = loadModule(testModuleName);
    expect(mod).not.toBeNull();
    expect(mod!.exports).toHaveLength(1);
    expect(mod!.exports[0].name).toBe("cached");
  });

  it("should return empty exports from sync loadModule on cache miss", async () => {
    const source = `export function nocache() { return 1; }`;
    await saveModule(testModuleName, source, "Test module");

    // Corrupt the cache hash to simulate cache miss
    const json = JSON.parse(readFileSync(jsonPath, "utf-8"));
    json.metadataCache.extractedFromHash = "sha256:invalid";
    writeFileSync(jsonPath, JSON.stringify(json));

    // Sync loadModule should return empty exports on cache miss
    const mod = loadModule(testModuleName);
    expect(mod).not.toBeNull();
    expect(mod!.exports).toHaveLength(0);
  });

  it("should re-extract and update cache on async load after cache miss", async () => {
    const source = `export function reextract() { return 2; }`;
    await saveModule(testModuleName, source, "Test module");

    // Corrupt the cache hash
    const json = JSON.parse(readFileSync(jsonPath, "utf-8"));
    const originalHash = json.metadataCache.extractedFromHash;
    json.metadataCache.extractedFromHash = "sha256:invalid";
    writeFileSync(jsonPath, JSON.stringify(json));

    // Async loadModuleAsync should re-extract and update cache
    const mod = await loadModuleAsync(testModuleName);
    expect(mod).not.toBeNull();
    expect(mod!.exports).toHaveLength(1);
    expect(mod!.exports[0].name).toBe("reextract");

    // Cache should be updated with correct hash
    const updatedJson = JSON.parse(readFileSync(jsonPath, "utf-8"));
    expect(updatedJson.metadataCache.extractedFromHash).toBe(originalHash);
  });

  it("should invalidate cache when source changes", async () => {
    // Save initial version
    const source1 = `export function v1() { return 1; }`;
    await saveModule(testModuleName, source1, "Test module v1");

    let mod = loadModule(testModuleName);
    expect(mod!.exports[0].name).toBe("v1");

    // Save updated version (different source = different hash)
    const source2 = `export function v2() { return 2; }`;
    await saveModule(testModuleName, source2, "Test module v2");

    mod = loadModule(testModuleName);
    expect(mod!.exports[0].name).toBe("v2");
  });
});

// ── Native Rust Module Discovery ─────────────────────────────────────
// Native modules (html, markdown, image, ziplib) are compiled into the
// runtime. They have .json + .d.ts metadata but no .js file. Both
// listModules() and loadModule() must find them.

describe("native module discovery", () => {
  // Ensure native module metadata files (.json, .d.ts) are in the modules dir.
  // In CI, loadAllModules() hasn't run yet, so we copy them from builtin-modules/.
  beforeAll(() => {
    const modsDir = getModulesDir();
    if (!existsSync(modsDir)) {
      mkdirSync(modsDir, { recursive: true });
    }
    for (const ext of [".json", ".d.ts"]) {
      const files = readdirSync(BUILTIN_DIR).filter(
        (f) => f.endsWith(ext) && f !== "tsconfig.json",
      );
      for (const file of files) {
        const dest = join(modsDir, file);
        if (!existsSync(dest)) {
          copyFileSync(join(BUILTIN_DIR, file), dest);
        }
      }
    }
  });

  it("listModules includes native Rust modules", () => {
    const modules = listModules();
    const names = modules.map((m) => m.name);
    expect(names, "ha:html missing from listModules()").toContain("html");
    expect(names, "ha:markdown missing from listModules()").toContain(
      "markdown",
    );
    expect(names, "ha:image missing from listModules()").toContain("image");
    expect(names, "ha:ziplib missing from listModules()").toContain("ziplib");
  });

  it("native modules have correct metadata", () => {
    const html = listModules().find((m) => m.name === "html");
    expect(html).toBeDefined();
    expect(html!.author).toBe("system");
    expect(html!.mutable).toBe(false);
    expect(html!.description).toBeTruthy();
    expect(html!.exports.length).toBeGreaterThan(0);
  });

  it("loadModule returns native module info", () => {
    const html = loadModule("html");
    expect(html).not.toBeNull();
    expect(html!.name).toBe("html");
    expect(html!.author).toBe("system");
    expect(html!.exports.length).toBeGreaterThan(0);
    // Native modules have function exports parsed from .d.ts
    const exportNames = html!.exports.map((e) => e.name);
    expect(exportNames).toContain("parse_html");
    expect(exportNames).toContain("html_to_text");
    expect(exportNames).toContain("extract_links");
  });

  it("loadModule returns null for nonexistent module", () => {
    expect(loadModule("nonexistent_module_xyz")).toBeNull();
  });
});
