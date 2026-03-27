// ── tests/path-jail.test.ts — Tests for shared path-jail module ──────

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

import { validatePath, isOutsideJail } from "../plugins/shared/path-jail.js";

// ── Helpers ──────────────────────────────────────────────────────────

function makeTempDir(): string {
  const dir = join(tmpdir(), `jail-test-${randomBytes(8).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ─────────────────────────────────────────────────────────────────────
// isOutsideJail
// ─────────────────────────────────────────────────────────────────────

describe("isOutsideJail", () => {
  it("should return false for paths inside the jail", () => {
    expect(isOutsideJail("/base/dir/file.txt", "/base/dir")).toBe(false);
  });

  it("should return false for the jail root itself", () => {
    expect(isOutsideJail("/base/dir", "/base/dir")).toBe(false);
  });

  it("should return true for paths above the jail", () => {
    expect(isOutsideJail("/base/other", "/base/dir")).toBe(true);
  });

  it("should return true for sibling directories", () => {
    expect(isOutsideJail("/base/dir2/file", "/base/dir")).toBe(true);
  });

  it("should return true for root", () => {
    expect(isOutsideJail("/", "/base/dir")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// validatePath — basic validation
// ─────────────────────────────────────────────────────────────────────

describe("validatePath", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("should accept a simple filename", () => {
    const result = validatePath("file.txt", baseDir);
    expect(result.valid).toBe(true);
    expect(result.realPath).toBeDefined();
  });

  it("should accept nested paths", () => {
    mkdirSync(join(baseDir, "subdir"));
    const result = validatePath("subdir/file.txt", baseDir);
    expect(result.valid).toBe(true);
  });

  it("should reject empty string", () => {
    const result = validatePath("", baseDir);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("non-empty string");
  });

  it("should reject null", () => {
    const result = validatePath(null as unknown as string, baseDir);
    expect(result.valid).toBe(false);
  });

  it("should reject undefined", () => {
    const result = validatePath(undefined as unknown as string, baseDir);
    expect(result.valid).toBe(false);
  });

  it("should reject non-string types", () => {
    const result = validatePath(42 as unknown as string, baseDir);
    expect(result.valid).toBe(false);
  });

  // ── Path traversal ────────────────────────────────────────

  it("should reject path traversal with ..", () => {
    const result = validatePath("../../../etc/passwd", baseDir);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("outside allowed directory");
  });

  it("should reject path traversal in middle of path", () => {
    const result = validatePath("subdir/../../etc/passwd", baseDir);
    expect(result.valid).toBe(false);
  });

  // ── Null bytes ────────────────────────────────────────────

  it("should reject null bytes", () => {
    const result = validatePath("file\0.txt", baseDir);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("invalid path character");
  });

  // ── Path length ───────────────────────────────────────────

  it("should reject extremely long paths", () => {
    const longPath = "a".repeat(5000);
    const result = validatePath(longPath, baseDir);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("maximum length");
  });

  // ── Dotfiles ──────────────────────────────────────────────

  it("should reject dotfiles", () => {
    const result = validatePath(".env", baseDir);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("dotfile");
  });

  it("should reject dotfile directories", () => {
    const result = validatePath(".git/config", baseDir);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("dotfile");
  });

  it("should reject nested dotfiles", () => {
    const result = validatePath("subdir/.ssh/keys", baseDir);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("dotfile");
  });

  // ── Symlinks ──────────────────────────────────────────────

  // Symlink tests — skip on Windows when symlink creation requires admin
  it("should reject symlinks", () => {
    const target = join(baseDir, "real-file.txt");
    const link = join(baseDir, "link-file.txt");
    writeFileSync(target, "content");
    try {
      symlinkSync(target, link);
    } catch (e: any) {
      if (e.code === "EPERM") return; // Skip — no symlink privileges on Windows
      throw e;
    }

    const result = validatePath("link-file.txt", baseDir);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("symlinks");
  });

  // ── Absolute paths ────────────────────────────────────────

  it("should reject absolute paths outside jail", () => {
    const result = validatePath("/etc/passwd", baseDir);
    expect(result.valid).toBe(false);
  });

  it("should accept absolute paths inside jail", () => {
    const absInside = join(baseDir, "inside.txt");
    const result = validatePath(absInside, baseDir);
    expect(result.valid).toBe(true);
  });

  // ── Error message sanitisation ────────────────────────────

  it("should not leak the base directory in error messages", () => {
    const result = validatePath("../../../etc/passwd", baseDir);
    expect(result.valid).toBe(false);
    // Error should NOT contain the actual baseDir path
    expect(result.error).not.toContain(baseDir);
  });
});
