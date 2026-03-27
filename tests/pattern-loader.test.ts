import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { loadPatterns } from "../src/agent/pattern-loader.js";

let TMP_DIR: string;

function createPattern(name: string, content: string) {
  const dir = join(TMP_DIR, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "PATTERN.md"), content);
}

describe("pattern-loader", () => {
  beforeEach(() => {
    // Use a unique dir under os.tmpdir() per test to avoid Windows EBUSY locks
    TMP_DIR = join(tmpdir(), `pattern-test-${randomBytes(8).toString("hex")}`);
    mkdirSync(TMP_DIR, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(TMP_DIR, { recursive: true, force: true });
    } catch (err: unknown) {
      // Windows Defender/indexer can hold file locks — only swallow those
      const code = (err as NodeJS.ErrnoException).code;
      if (
        process.platform === "win32" &&
        (code === "EBUSY" || code === "EPERM")
      ) {
        return;
      }
      throw err;
    }
  });

  it("should load a valid pattern with all fields", () => {
    createPattern(
      "test-pattern",
      `---
name: test-pattern
description: A test pattern
modules: [shared-state, pptx]
plugins: [fs-write]
profiles: [file-builder]
heapMb: 128
cpuTimeoutMs: 15000
---

1. First step
2. Second step
3. Third step
`,
    );

    const patterns = loadPatterns(TMP_DIR);
    expect(patterns.size).toBe(1);

    const p = patterns.get("test-pattern")!;
    expect(p.name).toBe("test-pattern");
    expect(p.description).toBe("A test pattern");
    expect(p.modules).toEqual(["shared-state", "pptx"]);
    expect(p.plugins).toEqual(["fs-write"]);
    expect(p.profiles).toEqual(["file-builder"]);
    expect(p.config.heapMb).toBe(128);
    expect(p.config.cpuTimeoutMs).toBe(15000);
    expect(p.steps).toHaveLength(3);
    expect(p.steps[0]).toBe("First step");
  });

  it("should handle missing optional fields with defaults", () => {
    createPattern(
      "minimal",
      `---
name: minimal
description: Minimal pattern
---

1. Just one step
`,
    );

    const patterns = loadPatterns(TMP_DIR);
    const p = patterns.get("minimal")!;
    expect(p.modules).toEqual([]);
    expect(p.plugins).toEqual([]);
    expect(p.profiles).toEqual([]);
    expect(p.config).toEqual({});
    expect(p.steps).toHaveLength(1);
  });

  it("should use directory name when name field is missing", () => {
    createPattern(
      "dir-name-fallback",
      `---
description: No name field
---

1. Step
`,
    );

    const patterns = loadPatterns(TMP_DIR);
    expect(patterns.has("dir-name-fallback")).toBe(true);
  });

  it("should load multiple patterns", () => {
    createPattern(
      "pattern-a",
      `---
name: pattern-a
description: Pattern A
modules: [html]
---

1. Do A
`,
    );
    createPattern(
      "pattern-b",
      `---
name: pattern-b
description: Pattern B
plugins: [fetch]
---

1. Do B
`,
    );

    const patterns = loadPatterns(TMP_DIR);
    expect(patterns.size).toBe(2);
    expect(patterns.get("pattern-a")!.modules).toEqual(["html"]);
    expect(patterns.get("pattern-b")!.plugins).toEqual(["fetch"]);
  });

  it("should return empty map for non-existent directory", () => {
    const patterns = loadPatterns("/tmp/does-not-exist-123456");
    expect(patterns.size).toBe(0);
  });

  it("should skip directories without PATTERN.md", () => {
    mkdirSync(join(TMP_DIR, "empty-dir"), { recursive: true });
    const patterns = loadPatterns(TMP_DIR);
    expect(patterns.size).toBe(0);
  });

  it("should handle YAML list syntax", () => {
    createPattern(
      "list-syntax",
      `---
name: list-syntax
description: Test YAML list syntax
modules:
  - shared-state
  - image
  - base64
plugins:
  - fetch
  - fs-write
---

1. Step one
`,
    );

    const patterns = loadPatterns(TMP_DIR);
    const p = patterns.get("list-syntax")!;
    expect(p.modules).toEqual(["shared-state", "image", "base64"]);
    expect(p.plugins).toEqual(["fetch", "fs-write"]);
  });

  it("should handle no frontmatter", () => {
    createPattern("no-front", "Just some markdown without frontmatter.");
    const patterns = loadPatterns(TMP_DIR);
    const p = patterns.get("no-front")!;
    expect(p.name).toBe("no-front");
    expect(p.description).toBe("");
    expect(p.steps).toEqual([]);
  });
});
