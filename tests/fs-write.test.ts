// ── fs-write plugin tests ────────────────────────────────────────────
//
// Integration tests for the write-only host functions (writeFile,
// appendFile, mkdir) via a mock proto sandbox. Covers entry creation
// limits, size caps, and config edge cases.
//
// Shared helpers (validatePath, safeNumericConfig) are tested
// thoroughly in fs-read.test.ts — they're identical copies, so we
// don't duplicate those unit tests here. Write-specific validation
// is exercised indirectly through the integration tests.
//
// ─────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

// The createHostFunctions function is the main export
import { createHostFunctions } from "../plugins/fs-write/index.js";

// ── Helpers ──────────────────────────────────────────────────────────

/** Create a unique temp dir for each test to avoid cross-contamination. */
function makeTempDir(): string {
  const dir = join(tmpdir(), `fs-write-test-${randomBytes(8).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ─────────────────────────────────────────────────────────────────────
// createHostFunctions — integration tests for write-only host functions
// ─────────────────────────────────────────────────────────────────────

describe("createHostFunctions", () => {
  let baseDir: string;
  let fns: ReturnType<typeof createHostFunctions>["fs-write"];

  beforeEach(() => {
    baseDir = makeTempDir();
    const hostFuncs = createHostFunctions({
      baseDir,
      maxWriteSizeKb: 256,
    });
    fns = hostFuncs["fs-write"];
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("should return exactly 5 write-only host functions", () => {
    expect(Object.keys(fns)).toEqual(
      expect.arrayContaining([
        "writeFile",
        "appendFile",
        "mkdir",
        "writeFileBinary",
        "appendFileBinary",
      ]),
    );
    expect(Object.keys(fns)).toHaveLength(5);
  });

  // ── writeFile ────────────────────────────────────────────────

  describe("writeFile", () => {
    it("should write content to a new file", () => {
      const result = fns.writeFile("new.txt", "hello");
      expect(result.ok).toBe(true);

      // Verify via node:fs — no read host function in this plugin
      const content = readFileSync(join(baseDir, "new.txt"), "utf8");
      expect(content).toBe("hello");
    });

    it("should overwrite existing file", () => {
      writeFileSync(join(baseDir, "exist.txt"), "old");
      const result = fns.writeFile("exist.txt", "new");
      expect(result.ok).toBe(true);

      const content = readFileSync(join(baseDir, "exist.txt"), "utf8");
      expect(content).toBe("new");
    });

    it("should reject non-string content", () => {
      const result = fns.writeFile("file.txt", 123 as unknown as string);
      expect(result.error).toContain("writeFile expects a string");
    });

    it("should reject content exceeding write limit", () => {
      const tinyFns = createHostFunctions({
        baseDir,
        maxWriteSizeKb: 0, // Zero = block non-empty writes
      })["fs-write"];
      const result = tinyFns.writeFile("file.txt", "x");
      expect(result.error).toContain("Content too large");
    });

    it("should reject writing to non-existent parent", () => {
      const result = fns.writeFile("no/such/dir/file.txt", "content");
      expect(result.error).toContain("does not exist");
    });

    it("should not create parents recursively", () => {
      fns.writeFile("no-parent/file.txt", "content");
      expect(existsSync(join(baseDir, "no-parent"))).toBe(false);
    });

    it("should reject path traversal", () => {
      const result = fns.writeFile("../../etc/evil", "pwned");
      expect(result.error).toContain("Access denied");
    });

    it("should reject dotfiles", () => {
      const result = fns.writeFile(".env", "SECRET=pwned");
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

      const result = fns.writeFile("link.txt", "overwrite via symlink");
      expect(result.error).toContain("symlinks");
    });

    it("should write binary content via base64 encoding", () => {
      const raw = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x42]);
      const b64 = raw.toString("base64");
      const result = fns.writeFile("binary.bin", b64, "base64");
      expect(result.ok).toBe(true);

      const ondisk = readFileSync(join(baseDir, "binary.bin"));
      expect(ondisk).toEqual(raw);
    });

    it("should fall back to utf8 for invalid encoding", () => {
      const result = fns.writeFile("fallback.txt", "plain text", "latin1");
      expect(result.ok).toBe(true);
      const content = readFileSync(join(baseDir, "fallback.txt"), "utf8");
      expect(content).toBe("plain text");
    });

    it("should round-trip binary data through base64", () => {
      // Create some binary data that would be corrupted by utf8
      const raw = Buffer.alloc(256);
      for (let i = 0; i < 256; i++) raw[i] = i;
      const b64 = raw.toString("base64");

      const result = fns.writeFile("roundtrip.bin", b64, "base64");
      expect(result.ok).toBe(true);

      const ondisk = readFileSync(join(baseDir, "roundtrip.bin"));
      expect(ondisk).toEqual(raw);
    });
  });

  // ── appendFile ───────────────────────────────────────────────

  describe("appendFile", () => {
    it("should append to existing file", () => {
      writeFileSync(join(baseDir, "log.txt"), "line1\n");
      const result = fns.appendFile("log.txt", "line2\n");
      expect(result.ok).toBe(true);

      const content = readFileSync(join(baseDir, "log.txt"), "utf8");
      expect(content).toBe("line1\nline2\n");
    });

    it("should create file if it does not exist", () => {
      const result = fns.appendFile("new-log.txt", "first line");
      expect(result.ok).toBe(true);

      const content = readFileSync(join(baseDir, "new-log.txt"), "utf8");
      expect(content).toBe("first line");
    });

    it("should enforce cumulative size limit", () => {
      const tinyFns = createHostFunctions({
        baseDir,
        maxWriteSizeKb: 1, // 1 KB limit
      })["fs-write"];
      // Write 900 bytes
      const first = "x".repeat(900);
      tinyFns.writeFile("big.txt", first);

      // Append 200 more — total 1100 > 1024 limit
      const result = tinyFns.appendFile("big.txt", "y".repeat(200));
      expect(result.error).toContain("Append would exceed");
    });

    it("should reject non-string content", () => {
      const result = fns.appendFile("file.txt", 123 as unknown as string);
      expect(result.error).toContain("appendFile expects a string");
    });

    it("should append binary content via base64 encoding", () => {
      // Start with some binary bytes
      const part1 = Buffer.from([0xca, 0xfe]);
      writeFileSync(join(baseDir, "append-bin.dat"), part1);

      // Append more binary bytes via base64
      const part2 = Buffer.from([0xba, 0xbe]);
      const result = fns.appendFile(
        "append-bin.dat",
        part2.toString("base64"),
        "base64",
      );
      expect(result.ok).toBe(true);

      const ondisk = readFileSync(join(baseDir, "append-bin.dat"));
      expect(ondisk).toEqual(Buffer.concat([part1, part2]));
    });

    it("should reject writing to non-existent parent", () => {
      const result = fns.appendFile("no/such/dir/file.txt", "content");
      expect(result.error).toContain("does not exist");
    });
  });

  // ── writeFileBinary ──────────────────────────────────────────

  describe("writeFileBinary", () => {
    it("should write a Buffer to a new file", () => {
      const data = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      const result = fns.writeFileBinary("img.bin", data);
      expect(result.ok).toBe(true);
      const onDisk = readFileSync(join(baseDir, "img.bin"));
      expect(onDisk[0]).toBe(0x89);
      expect(onDisk[3]).toBe(0x47);
      expect(onDisk.length).toBe(4);
    });

    it("should overwrite existing file", () => {
      writeFileSync(join(baseDir, "old.bin"), Buffer.from([1, 2, 3]));
      const result = fns.writeFileBinary("old.bin", Buffer.from([4, 5]));
      expect(result.ok).toBe(true);
      const onDisk = readFileSync(join(baseDir, "old.bin"));
      expect(onDisk.length).toBe(2);
      expect(onDisk[0]).toBe(4);
    });

    it("should preserve all 256 byte values", () => {
      const allBytes = Buffer.alloc(256);
      for (let i = 0; i < 256; i++) allBytes[i] = i;
      fns.writeFileBinary("allbytes.bin", allBytes);
      const onDisk = readFileSync(join(baseDir, "allbytes.bin"));
      expect(onDisk.length).toBe(256);
      for (let i = 0; i < 256; i++) {
        expect(onDisk[i]).toBe(i);
      }
    });

    it("should throw on path traversal", () => {
      expect(() =>
        fns.writeFileBinary("../escape.bin", Buffer.from([1])),
      ).toThrow();
    });

    it("should throw when data is not a Buffer", () => {
      expect(() =>
        fns.writeFileBinary("test.bin", "not a buffer" as unknown as Buffer),
      ).toThrow("Uint8Array");
    });

    it("should accept a raw Uint8Array (not Buffer)", () => {
      const data = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
      const result = fns.writeFileBinary("raw-u8.bin", data);
      expect(result.ok).toBe(true);
      const onDisk = readFileSync(join(baseDir, "raw-u8.bin"));
      expect(onDisk.length).toBe(4);
      expect(onDisk[0]).toBe(0xde);
      expect(onDisk[3]).toBe(0xef);
    });

    it("should throw when parent directory does not exist", () => {
      expect(() =>
        fns.writeFileBinary("no/such/dir/file.bin", Buffer.from([1])),
      ).toThrow("does not exist");
    });
  });

  // ── appendFileBinary ─────────────────────────────────────────

  describe("appendFileBinary", () => {
    it("should append Buffer to existing file", () => {
      writeFileSync(join(baseDir, "app.bin"), Buffer.from([1, 2]));
      const result = fns.appendFileBinary("app.bin", Buffer.from([3, 4]));
      expect(result.ok).toBe(true);
      const onDisk = readFileSync(join(baseDir, "app.bin"));
      expect(onDisk.length).toBe(4);
      expect(Array.from(onDisk)).toEqual([1, 2, 3, 4]);
    });

    it("should create file if it does not exist", () => {
      const result = fns.appendFileBinary("newapp.bin", Buffer.from([10, 20]));
      expect(result.ok).toBe(true);
      const onDisk = readFileSync(join(baseDir, "newapp.bin"));
      expect(Array.from(onDisk)).toEqual([10, 20]);
    });

    it("should throw when data is not a Buffer", () => {
      expect(() =>
        fns.appendFileBinary("test.bin", "nope" as unknown as Buffer),
      ).toThrow("Uint8Array");
    });
  });

  // ── mkdir ────────────────────────────────────────────────────

  describe("mkdir", () => {
    it("should create a directory", () => {
      const result = fns.mkdir("newdir");
      expect(result.ok).toBe(true);
      expect(existsSync(join(baseDir, "newdir"))).toBe(true);
    });

    it("should reject when parent does not exist", () => {
      const result = fns.mkdir("no/parent");
      expect(result.error).toContain("does not exist");
    });

    it("should reject when directory already exists", () => {
      mkdirSync(join(baseDir, "existing"));
      const result = fns.mkdir("existing");
      expect(result.error).toContain("already exists");
    });

    it("should reject dotfile directories", () => {
      const result = fns.mkdir(".hidden");
      expect(result.error).toContain("dotfile");
    });
  });

  // ── Entry creation limits ────────────────────────────────────

  describe("entry creation limits", () => {
    it("should enforce maxEntries on writeFile (new files)", () => {
      const limitDir = makeTempDir();
      const limitFns = createHostFunctions({
        baseDir: limitDir,
        maxEntries: 3,
      })["fs-write"];
      try {
        for (let i = 0; i < 3; i++) {
          const r = limitFns.writeFile(`file${i}.txt`, `content${i}`);
          expect(r.ok).toBe(true);
        }
        const r4 = limitFns.writeFile("file3.txt", "nope");
        expect(r4.error).toContain("Entry limit reached");
      } finally {
        rmSync(limitDir, { recursive: true, force: true });
      }
    });

    it("should NOT count overwrites against entry limit", () => {
      const limitDir = makeTempDir();
      const limitFns = createHostFunctions({
        baseDir: limitDir,
        maxEntries: 2,
      })["fs-write"];
      try {
        limitFns.writeFile("a.txt", "v1");
        limitFns.writeFile("b.txt", "v1");
        const r = limitFns.writeFile("a.txt", "v2");
        expect(r.ok).toBe(true);
      } finally {
        rmSync(limitDir, { recursive: true, force: true });
      }
    });

    it("should enforce maxEntries on appendFile (new files)", () => {
      const limitDir = makeTempDir();
      const limitFns = createHostFunctions({
        baseDir: limitDir,
        maxEntries: 1,
      })["fs-write"];
      try {
        const r1 = limitFns.appendFile("first.txt", "data");
        expect(r1.ok).toBe(true);
        const r2 = limitFns.appendFile("first.txt", " more");
        expect(r2.ok).toBe(true);
        const r3 = limitFns.appendFile("second.txt", "data");
        expect(r3.error).toContain("Entry limit reached");
      } finally {
        rmSync(limitDir, { recursive: true, force: true });
      }
    });

    it("should enforce maxEntries on mkdir", () => {
      const limitDir = makeTempDir();
      const limitFns = createHostFunctions({
        baseDir: limitDir,
        maxEntries: 2,
      })["fs-write"];
      try {
        limitFns.mkdir("dir1");
        limitFns.mkdir("dir2");
        const r = limitFns.mkdir("dir3");
        expect(r.error).toContain("Entry limit reached");
      } finally {
        rmSync(limitDir, { recursive: true, force: true });
      }
    });

    it("should count files and dirs against the SAME limit", () => {
      const limitDir = makeTempDir();
      const limitFns = createHostFunctions({
        baseDir: limitDir,
        maxEntries: 3,
      })["fs-write"];
      try {
        limitFns.writeFile("file1.txt", "data");
        limitFns.mkdir("dir1");
        limitFns.appendFile("file2.txt", "data");
        const r = limitFns.mkdir("dir2");
        expect(r.error).toContain("Entry limit reached");
      } finally {
        rmSync(limitDir, { recursive: true, force: true });
      }
    });

    it("should default maxEntries to 500", () => {
      const limitDir = makeTempDir();
      const limitFns = createHostFunctions({
        baseDir: limitDir,
      })["fs-write"];
      try {
        for (let i = 0; i < 5; i++) {
          const r = limitFns.writeFile(`f${i}.txt`, `c${i}`);
          expect(r.ok).toBe(true);
        }
      } finally {
        rmSync(limitDir, { recursive: true, force: true });
      }
    });

    it("should handle maxEntries of 0 (block all creation)", () => {
      const limitDir = makeTempDir();
      const limitFns = createHostFunctions({
        baseDir: limitDir,
        maxEntries: 0,
      })["fs-write"];
      try {
        const r = limitFns.writeFile("nope.txt", "blocked");
        expect(r.error).toContain("Entry limit reached");
      } finally {
        rmSync(limitDir, { recursive: true, force: true });
      }
    });
  });

  // ── Config edge cases ────────────────────────────────────────

  describe("config edge cases", () => {
    it("should create temp dir when no baseDir configured", () => {
      const tempFns = createHostFunctions({})["fs-write"];

      const result = tempFns.writeFile("temp.txt", "hello temp");
      expect(result.ok).toBe(true);
    });

    it("should auto-create baseDir when it does not exist", () => {
      const autoDir = join(
        tmpdir(),
        `fs-write-autocreate-${randomBytes(4).toString("hex")}`,
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
        `fs-write-symlink-${randomBytes(4).toString("hex")}`,
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

    it("should handle null/undefined config gracefully", () => {
      const hostFuncs = createHostFunctions(undefined as any);
      expect(Object.keys(hostFuncs["fs-write"])).toHaveLength(5);
    });
  });

  // ── Entry counter correctness ────────────────────────────────

  describe("entry counter correctness", () => {
    it("should not leak counter on mkdir EEXIST", () => {
      const limitDir = makeTempDir();
      const limitFns = createHostFunctions({
        baseDir: limitDir,
        maxEntries: 2,
      })["fs-write"];
      try {
        mkdirSync(join(limitDir, "existing"));
        const r1 = limitFns.mkdir("existing");
        expect(r1.error).toContain("already exists");
        const r2 = limitFns.writeFile("file1.txt", "data");
        expect(r2.ok).toBe(true);
        const r3 = limitFns.writeFile("file2.txt", "data");
        expect(r3.ok).toBe(true);
      } finally {
        rmSync(limitDir, { recursive: true, force: true });
      }
    });

    it("should not double-count overwrites of previously-created files", () => {
      const limitDir = makeTempDir();
      const limitFns = createHostFunctions({
        baseDir: limitDir,
        maxEntries: 2,
      })["fs-write"];
      try {
        limitFns.writeFile("a.txt", "v1");
        limitFns.writeFile("b.txt", "v1");
        const r = limitFns.writeFile("a.txt", "v2");
        expect(r.ok).toBe(true);
        const r2 = limitFns.writeFile("c.txt", "nope");
        expect(r2.error).toContain("Entry limit reached");
      } finally {
        rmSync(limitDir, { recursive: true, force: true });
      }
    });
  });
});
