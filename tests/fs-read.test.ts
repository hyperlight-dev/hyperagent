// ── fs-read plugin tests ─────────────────────────────────────────────
//
// Unit tests for validatePath, safeNumericConfig, and the registered
// read-only host functions (readFile, listDir, stat) via a mock proto
// sandbox.
//
// Shared helpers (validatePath, safeNumericConfig) are tested here
// since they're naturally grouped with the read plugin. The identical
// copies in fs-write are exercised indirectly via write integration
// tests — no need to duplicate these unit tests.
//
// ─────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

// Test-only exports from the plugin
import {
  _validatePath as validatePath,
  _safeNumericConfig as safeNumericConfig,
} from "../plugins/fs-read/index.js";

// The createHostFunctions function is the main export
import { createHostFunctions } from "../plugins/fs-read/index.js";

// ── Helpers ──────────────────────────────────────────────────────────

/** Create a unique temp dir for each test to avoid cross-contamination. */
function makeTempDir(): string {
  const dir = join(tmpdir(), `fs-read-test-${randomBytes(8).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ─────────────────────────────────────────────────────────────────────
// safeNumericConfig
// ─────────────────────────────────────────────────────────────────────

describe("safeNumericConfig", () => {
  it("should return value when valid", () => {
    expect(safeNumericConfig(100, 512)).toBe(100);
  });

  it("should return default for null", () => {
    expect(safeNumericConfig(null, 512)).toBe(512);
  });

  it("should return default for undefined", () => {
    expect(safeNumericConfig(undefined, 512)).toBe(512);
  });

  it("should return default for NaN", () => {
    expect(safeNumericConfig(NaN, 512)).toBe(512);
  });

  it("should return default for Infinity", () => {
    expect(safeNumericConfig(Infinity, 512)).toBe(512);
  });

  it("should return default for negative values", () => {
    expect(safeNumericConfig(-1, 512)).toBe(512);
  });

  it("should clamp to ceiling", () => {
    expect(safeNumericConfig(99999, 512, 10240)).toBe(10240);
  });

  it("should accept zero", () => {
    expect(safeNumericConfig(0, 512)).toBe(0);
  });

  it("should use custom ceiling", () => {
    expect(safeNumericConfig(500, 256, 100)).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────────
// validatePath
// ─────────────────────────────────────────────────────────────────────

describe("validatePath", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  // ── Type guards ──────────────────────────────────────────────

  describe("type guards", () => {
    it("should reject non-string paths", () => {
      const result = validatePath(42 as any, baseDir);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("non-empty string");
    });

    it("should reject null paths", () => {
      const result = validatePath(null as any, baseDir);
      expect(result.valid).toBe(false);
    });

    it("should reject undefined paths", () => {
      const result = validatePath(undefined as any, baseDir);
      expect(result.valid).toBe(false);
    });

    it("should reject empty string", () => {
      const result = validatePath("", baseDir);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("non-empty string");
    });
  });

  // ── CRITICAL: Relative path resolution ───────────────────────

  describe("path resolution (CRITICAL fix)", () => {
    it("should resolve relative paths against baseDir, not CWD", () => {
      const testFile = join(baseDir, "test.txt");
      writeFileSync(testFile, "hello");

      const result = validatePath("test.txt", baseDir);
      expect(result.valid).toBe(true);
      expect(result.realPath).toBe(testFile);
    });

    it("should resolve nested relative paths against baseDir", () => {
      const subDir = join(baseDir, "sub");
      mkdirSync(subDir);
      const testFile = join(subDir, "nested.txt");
      writeFileSync(testFile, "hello");

      const result = validatePath("sub/nested.txt", baseDir);
      expect(result.valid).toBe(true);
      expect(result.realPath).toBe(testFile);
    });

    it("should accept absolute paths within baseDir", () => {
      const testFile = join(baseDir, "abs.txt");
      writeFileSync(testFile, "hello");

      const result = validatePath(testFile, baseDir);
      expect(result.valid).toBe(true);
    });

    it("should allow paths to non-existent files (for writes)", () => {
      const result = validatePath("new-file.txt", baseDir);
      expect(result.valid).toBe(true);
      expect(result.realPath).toBe(join(baseDir, "new-file.txt"));
    });
  });

  // ── CRITICAL: Boundary check ─────────────────────────────────

  describe("boundary check (CRITICAL fix)", () => {
    it("should reject paths outside baseDir", () => {
      const result = validatePath("/etc/passwd", baseDir);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("outside allowed directory");
    });

    it("should reject path traversal with ..", () => {
      const result = validatePath("../../../etc/passwd", baseDir);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Access denied");
    });

    it("should reject traversal that normalises outside jail", () => {
      const result = validatePath("sub/../../escape.txt", baseDir);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Access denied");
    });

    it("should allow baseDir itself (for listDir)", () => {
      const result = validatePath(".", baseDir);
      expect(result.valid).toBe(true);
      expect(result.realPath).toBe(baseDir);
    });
  });

  // ── Dotfile check ────────────────────────────────────────────

  describe("dotfile check", () => {
    it("should reject dotfiles in path", () => {
      const result = validatePath(".env", baseDir);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("dotfile");
    });

    it("should reject dotfiles in nested path", () => {
      const result = validatePath("config/.secret/file.txt", baseDir);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("dotfile");
    });

    it("should reject .git", () => {
      const result = validatePath(".git/config", baseDir);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("dotfile");
    });

    it("should NOT reject baseDir with dotfile ancestors", () => {
      const testFile = join(baseDir, "normal.txt");
      writeFileSync(testFile, "ok");

      const result = validatePath("normal.txt", baseDir);
      expect(result.valid).toBe(true);
    });
  });

  // ── Symlink check ────────────────────────────────────────────

  describe("symlink check", () => {
    it("should reject symlinks", () => {
      const realFile = join(baseDir, "real.txt");
      writeFileSync(realFile, "real content");
      const link = join(baseDir, "link.txt");
      try {
        symlinkSync(realFile, link);
      } catch (e: any) {
        if (e.code === "EPERM") return; // Skip — no symlink privileges on Windows
        throw e;
      }

      const result = validatePath("link.txt", baseDir);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("symlinks are not permitted");
    });

    it("should reject symlinks in ancestor path", () => {
      const realDir = join(baseDir, "realdir");
      mkdirSync(realDir);
      writeFileSync(join(realDir, "file.txt"), "content");

      const linkDir = join(baseDir, "linkdir");
      try {
        symlinkSync(realDir, linkDir);
      } catch (e: any) {
        if (e.code === "EPERM") return; // Skip — no symlink privileges on Windows
        throw e;
      }

      const result = validatePath("linkdir/file.txt", baseDir);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("symlinks are not permitted");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// register — integration tests for read-only host functions
// ─────────────────────────────────────────────────────────────────────

describe("createHostFunctions", () => {
  let baseDir: string;
  let fns: ReturnType<typeof createHostFunctions>["fs-read"];

  beforeEach(() => {
    baseDir = makeTempDir();
    const hostFuncs = createHostFunctions({
      baseDir,
      maxFileSizeKb: 512,
    });
    fns = hostFuncs["fs-read"];
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("should return exactly 6 read-only host functions", () => {
    expect(Object.keys(fns)).toEqual(
      expect.arrayContaining([
        "readFile",
        "readFileChunk",
        "listDir",
        "stat",
        "readFileBinary",
        "readFileChunkBinary",
      ]),
    );
    expect(Object.keys(fns)).toHaveLength(6);
  });

  // ── readFile ─────────────────────────────────────────────────

  describe("readFile", () => {
    it("should read file content as JSON envelope", () => {
      writeFileSync(join(baseDir, "hello.txt"), "Hello World");
      const result = fns.readFile("hello.txt");
      expect(result.content).toBe("Hello World");
    });

    it("should default to utf8 when encoding omitted", () => {
      writeFileSync(join(baseDir, "plain.txt"), "just text");
      const result = fns.readFile("plain.txt");
      expect(result.content).toBe("just text");
      expect(result.encoding).toBeUndefined();
    });

    it("should return base64 when encoding is 'base64'", () => {
      const raw = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x42]);
      writeFileSync(join(baseDir, "binary.bin"), raw);
      const result = fns.readFile("binary.bin", "base64");
      expect(result.encoding).toBe("base64");
      expect(Buffer.from(result.content!, "base64")).toEqual(raw);
    });

    it("should fall back to utf8 for invalid encoding", () => {
      writeFileSync(join(baseDir, "fallback.txt"), "safe");
      const result = fns.readFile("fallback.txt", "latin1");
      expect(result.content).toBe("safe");
      expect(result.encoding).toBeUndefined();
    });

    it("should return error for non-existent file", () => {
      const result = fns.readFile("nope.txt");
      expect(result.error).toBeDefined();
    });

    it("should reject path traversal", () => {
      const result = fns.readFile("../../etc/passwd");
      expect(result.error).toContain("Access denied");
    });

    it("should reject dotfiles", () => {
      const result = fns.readFile(".env");
      expect(result.error).toContain("dotfile");
    });

    it("should reject symlinks", () => {
      const real = join(baseDir, "real.txt");
      writeFileSync(real, "real");
      try {
        symlinkSync(real, join(baseDir, "link.txt"));
      } catch (e: any) {
        if (e.code === "EPERM") return; // Skip — no symlink privileges on Windows
        throw e;
      }

      const result = fns.readFile("link.txt");
      expect(result.error).toContain("symlinks");
    });

    it("should reject non-string path", () => {
      const result = fns.readFile(42 as unknown as string);
      expect(result.error).toBeDefined();
    });

    it("should reject files exceeding size limit", () => {
      const tinyFns = createHostFunctions({
        baseDir,
        maxFileSizeKb: 0, // Zero = block non-empty files
      })["fs-read"];
      writeFileSync(join(baseDir, "big.txt"), "x");
      const result = tinyFns.readFile("big.txt");
      expect(result.error).toContain("File too large");
    });

    it("should reject reading a directory", () => {
      mkdirSync(join(baseDir, "subdir"));
      const result = fns.readFile("subdir");
      expect(result.error).toBeDefined();
    });
  });

  // ── readFileChunk ────────────────────────────────────────────

  describe("readFileChunk", () => {
    it("should read a chunk from the beginning of a file", () => {
      writeFileSync(join(baseDir, "data.txt"), "ABCDEFGHIJ");
      const result = fns.readFileChunk("data.txt", 0, 5);
      expect(result.content).toBe("ABCDE");
      expect(result.totalSize).toBe(10);
      expect(result.hasMore).toBe(true);
    });

    it("should read a chunk from an offset", () => {
      writeFileSync(join(baseDir, "data.txt"), "ABCDEFGHIJ");
      const result = fns.readFileChunk("data.txt", 5, 5);
      expect(result.content).toBe("FGHIJ");
      expect(result.totalSize).toBe(10);
      expect(result.hasMore).toBe(false);
    });

    it("should clamp length to remaining bytes at EOF", () => {
      writeFileSync(join(baseDir, "short.txt"), "ABC");
      const result = fns.readFileChunk("short.txt", 1, 100);
      expect(result.content).toBe("BC");
      expect(result.hasMore).toBe(false);
    });

    it("should return empty content when offset >= file size", () => {
      writeFileSync(join(baseDir, "tiny.txt"), "X");
      const result = fns.readFileChunk("tiny.txt", 999, 10);
      expect(result.content).toBe("");
      expect(result.hasMore).toBe(false);
    });

    it("should support base64 encoding", () => {
      const raw = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
      writeFileSync(join(baseDir, "binary.dat"), raw);
      const result = fns.readFileChunk("binary.dat", 0, 4, "base64");
      expect(result.encoding).toBe("base64");
      expect(Buffer.from(result.content!, "base64")).toEqual(raw);
    });

    it("should support base64 encoding with offset", () => {
      const raw = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
      writeFileSync(join(baseDir, "offset-bin.dat"), raw);
      const result = fns.readFileChunk("offset-bin.dat", 2, 3, "base64");
      expect(result.encoding).toBe("base64");
      expect(Buffer.from(result.content!, "base64")).toEqual(
        Buffer.from([0x03, 0x04, 0x05]),
      );
      expect(result.hasMore).toBe(true);
    });

    it("should reject negative offset", () => {
      writeFileSync(join(baseDir, "neg.txt"), "test");
      const result = fns.readFileChunk("neg.txt", -1, 10);
      expect(result.error).toContain("non-negative");
    });

    it("should reject zero length", () => {
      writeFileSync(join(baseDir, "zero.txt"), "test");
      const result = fns.readFileChunk("zero.txt", 0, 0);
      expect(result.error).toContain("positive");
    });

    it("should reject negative length", () => {
      writeFileSync(join(baseDir, "neg-len.txt"), "test");
      const result = fns.readFileChunk("neg-len.txt", 0, -5);
      expect(result.error).toContain("positive");
    });

    it("should reject files exceeding maxFileSizeKb", () => {
      const tinyFns = createHostFunctions({ baseDir, maxFileSizeKb: 0 })[
        "fs-read"
      ];
      writeFileSync(join(baseDir, "big-chunk.txt"), "x");
      const result = tinyFns.readFileChunk("big-chunk.txt", 0, 1);
      expect(result.error).toContain("File too large");
    });

    it("should reject path traversal", () => {
      const result = fns.readFileChunk("../../etc/passwd", 0, 100);
      expect(result.error).toContain("Access denied");
    });

    it("should reject dotfiles", () => {
      const result = fns.readFileChunk(".secret", 0, 100);
      expect(result.error).toContain("dotfile");
    });

    it("should reject symlinks", () => {
      const real = join(baseDir, "real-chunk.txt");
      writeFileSync(real, "real content");
      try {
        symlinkSync(real, join(baseDir, "link-chunk.txt"));
      } catch (e: any) {
        if (e.code === "EPERM") return; // Skip — no symlink privileges on Windows
        throw e;
      }
      const result = fns.readFileChunk("link-chunk.txt", 0, 10);
      expect(result.error).toContain("symlinks");
    });

    it("should reject non-string path", () => {
      const result = fns.readFileChunk(42 as unknown as string, 0, 10);
      expect(result.error).toBeDefined();
    });

    it("should iterate through entire file in chunks", () => {
      const fullText = "The quick brown fox jumps over the lazy dog";
      writeFileSync(join(baseDir, "iterate.txt"), fullText);

      let assembled = "";
      let offset = 0;
      const chunkSize = 10;

      // Read in chunks until done
      for (let i = 0; i < 10; i++) {
        const chunk = fns.readFileChunk("iterate.txt", offset, chunkSize);
        if (chunk.error) throw new Error(chunk.error);
        assembled += chunk.content;
        if (!chunk.hasMore) break;
        offset += chunkSize;
      }

      expect(assembled).toBe(fullText);
    });
  });

  // ── per-call chunk limit ─────────────────────────────────────

  describe("per-call chunk limit", () => {
    it("should reject readFile when file exceeds per-call chunk limit", () => {
      // Create host functions with large maxFileSizeKb but let the per-call
      // chunk limit (MAX_READ_CHUNK_KB = 1024) do the rejecting.
      const largeFns = createHostFunctions({ baseDir, maxFileSizeKb: 10240 })[
        "fs-read"
      ];

      // Create file slightly over 1 MB (1024 * 1024 + 1 bytes)
      const overChunkLimit = Buffer.alloc(1024 * 1024 + 1, 0x41);
      writeFileSync(join(baseDir, "over-chunk.bin"), overChunkLimit);

      const result = largeFns.readFile("over-chunk.bin");
      expect(result.error).toContain("readFileChunk");
    });
  });

  // ── readFileBinary ───────────────────────────────────────────

  describe("readFileBinary", () => {
    it("should return a Buffer for binary file", () => {
      const raw = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
      writeFileSync(join(baseDir, "header.bin"), raw);
      const result = fns.readFileBinary("header.bin");
      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result.length).toBe(6);
      expect(result[0]).toBe(0x89);
      expect(result[3]).toBe(0x47);
    });

    it("should preserve all 256 byte values", () => {
      const allBytes = Buffer.alloc(256);
      for (let i = 0; i < 256; i++) allBytes[i] = i;
      writeFileSync(join(baseDir, "allbytes.bin"), allBytes);
      const result = fns.readFileBinary("allbytes.bin");
      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result.length).toBe(256);
      for (let i = 0; i < 256; i++) {
        expect(result[i]).toBe(i);
      }
    });

    it("should throw on non-existent file", () => {
      expect(() => fns.readFileBinary("nope.bin")).toThrow("File not found");
    });

    it("should throw on path traversal", () => {
      expect(() => fns.readFileBinary("../escape.bin")).toThrow();
    });

    it("should throw on directory", () => {
      mkdirSync(join(baseDir, "subdir2"));
      expect(() => fns.readFileBinary("subdir2")).toThrow("Not a file");
    });
  });

  // ── readFileChunkBinary ──────────────────────────────────────

  describe("readFileChunkBinary", () => {
    it("should read a chunk as Buffer", () => {
      const data = Buffer.from([10, 20, 30, 40, 50, 60, 70, 80]);
      writeFileSync(join(baseDir, "chunks.bin"), data);
      const result = fns.readFileChunkBinary("chunks.bin", 2, 4);
      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result.length).toBe(4);
      expect(result[0]).toBe(30);
      expect(result[3]).toBe(60);
    });

    it("should return empty Buffer when offset beyond EOF", () => {
      writeFileSync(join(baseDir, "small.bin"), Buffer.from([1, 2]));
      const result = fns.readFileChunkBinary("small.bin", 999, 10);
      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result.length).toBe(0);
    });

    it("should clamp length to remaining bytes", () => {
      writeFileSync(join(baseDir, "three.bin"), Buffer.from([1, 2, 3]));
      const result = fns.readFileChunkBinary("three.bin", 1, 100);
      expect(result.length).toBe(2);
      expect(result[0]).toBe(2);
      expect(result[1]).toBe(3);
    });

    it("should throw on non-existent file", () => {
      expect(() => fns.readFileChunkBinary("nope.bin", 0, 10)).toThrow(
        "File not found",
      );
    });

    it("should throw on invalid offset", () => {
      writeFileSync(join(baseDir, "x.bin"), Buffer.from([1]));
      expect(() => fns.readFileChunkBinary("x.bin", -1, 10)).toThrow(
        "offsetBytes",
      );
    });
  });

  // ── listDir ──────────────────────────────────────────────────

  describe("listDir", () => {
    it("should list directory contents", () => {
      writeFileSync(join(baseDir, "a.txt"), "a");
      writeFileSync(join(baseDir, "b.txt"), "b");
      mkdirSync(join(baseDir, "subdir"));

      const result = fns.listDir(".");
      expect(result).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "a.txt", type: "file" }),
          expect.objectContaining({ name: "b.txt", type: "file" }),
          expect.objectContaining({ name: "subdir", type: "directory" }),
        ]),
      );
    });

    it("should filter dotfiles from listing", () => {
      writeFileSync(join(baseDir, ".hidden"), "secret");
      writeFileSync(join(baseDir, "visible.txt"), "pub");

      const result = fns.listDir(".");
      expect(Array.isArray(result)).toBe(true);
      const names = (result as Array<{ name: string }>).map((e) => e.name);
      expect(names).not.toContain(".hidden");
      expect(names).toContain("visible.txt");
    });

    it("should filter symlinks from listing", () => {
      writeFileSync(join(baseDir, "real.txt"), "real");
      try {
        symlinkSync(join(baseDir, "real.txt"), join(baseDir, "link.txt"));
      } catch (e: any) {
        if (e.code === "EPERM") return; // Skip — no symlink privileges on Windows
        throw e;
      }

      const result = fns.listDir(".");
      expect(Array.isArray(result)).toBe(true);
      const names = (result as Array<{ name: string }>).map((e) => e.name);
      expect(names).not.toContain("link.txt");
      expect(names).toContain("real.txt");
    });

    it("should reject non-directory path", () => {
      writeFileSync(join(baseDir, "file.txt"), "content");
      const result = fns.listDir("file.txt");
      expect(!Array.isArray(result) && result.error).toContain(
        "Not a directory",
      );
    });

    it("should return error for non-existent directory", () => {
      const result = fns.listDir("nonexistent");
      expect(!Array.isArray(result) && result.error).toBeDefined();
    });
  });

  // ── stat ─────────────────────────────────────────────────────

  describe("stat", () => {
    it("should return file metadata", () => {
      writeFileSync(join(baseDir, "info.txt"), "hello");
      const result = fns.stat("info.txt");
      expect(result.size).toBe(5);
      expect(result.isFile).toBe(true);
      expect(result.isDirectory).toBe(false);
      // mtime deliberately omitted — fingerprinting risk
      expect((result as Record<string, unknown>).modified).toBeUndefined();
    });

    it("should return directory metadata", () => {
      mkdirSync(join(baseDir, "subdir"));
      const result = fns.stat("subdir");
      expect(result.isDirectory).toBe(true);
      expect(result.isFile).toBe(false);
    });

    it("should reject symlinks", () => {
      writeFileSync(join(baseDir, "real.txt"), "real");
      try {
        symlinkSync(join(baseDir, "real.txt"), join(baseDir, "link.txt"));
      } catch (e: any) {
        if (e.code === "EPERM") return; // Skip — no symlink privileges on Windows
        throw e;
      }
      const result = fns.stat("link.txt");
      expect(result.error).toContain("symlinks");
    });

    it("should return error for non-existent path", () => {
      const result = fns.stat("nope.txt");
      expect(result.error).toBeDefined();
    });
  });

  // ── Config edge cases ────────────────────────────────────────

  describe("config edge cases", () => {
    it("should create temp dir when no baseDir configured", () => {
      const tempFns = createHostFunctions({})["fs-read"];

      // Should be able to list the auto-created temp dir
      const result = tempFns.listDir(".");
      expect(Array.isArray(result)).toBe(true);
    });

    it("should auto-create baseDir when it does not exist", () => {
      const autoDir = join(
        tmpdir(),
        `fs-read-autocreate-${randomBytes(4).toString("hex")}`,
      );
      try {
        expect(existsSync(autoDir)).toBe(false);
        createHostFunctions({ baseDir: autoDir });
        expect(existsSync(autoDir)).toBe(true);
      } finally {
        rmSync(autoDir, { recursive: true, force: true });
      }
    });

    it("should throw when baseDir is a symlink", () => {
      const realDir = makeTempDir();
      const symlinkDir = join(
        tmpdir(),
        `fs-read-symlink-${randomBytes(4).toString("hex")}`,
      );
      try {
        symlinkSync(realDir, symlinkDir);
      } catch (e: any) {
        if (e.code === "EPERM") {
          rmSync(realDir, { recursive: true, force: true });
          return; // Skip — no symlink privileges on Windows
        }
        throw e;
      }
      try {
        expect(() => {
          createHostFunctions({ baseDir: symlinkDir });
        }).toThrow("symlink");
      } finally {
        rmSync(symlinkDir, { force: true });
        rmSync(realDir, { recursive: true, force: true });
      }
    });

    it("should handle NaN config values by falling back to defaults", () => {
      const nanFns = createHostFunctions({
        baseDir,
        maxFileSizeKb: NaN,
      })["fs-read"];
      writeFileSync(join(baseDir, "test.txt"), "hello");
      const result = nanFns.readFile("test.txt");
      expect(result.content).toBe("hello");
    });

    it("should handle null/undefined config gracefully", () => {
      const hostFuncs = createHostFunctions(undefined as any);
      expect(Object.keys(hostFuncs["fs-read"])).toHaveLength(6);
    });
  });

  // ── validatePath hardening ───────────────────────────────────

  describe("validatePath hardening", () => {
    it("should reject null bytes in path", () => {
      const result = fns.readFile("safe.txt\x00../../etc/passwd");
      expect(result.error).toContain("invalid path character");
    });

    it("should reject extremely long paths", () => {
      const longPath = "a".repeat(5000) + ".txt";
      const result = fns.readFile(longPath);
      expect(result.error).toContain("maximum length");
    });
  });
});
