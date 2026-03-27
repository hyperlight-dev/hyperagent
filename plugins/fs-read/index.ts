// ── fs-read plugin ───────────────────────────────────────────────────
//
// Read-only filesystem access jailed to a SINGLE base directory.
// Guest JavaScript loads via: const fs = require("host:fs-read")
//
// Security model:
//   - ONE base directory. Everything is scoped to it. Period.
//   - If no baseDir is configured, we create a temp dir under
//     os.tmpdir() — you get a sandbox, not the whole filesystem.
//   - All paths are resolved to absolute; path traversal (..) is
//     collapsed by resolve() then rejected if it escapes.
//   - Symlinks are REJECTED outright (lstatSync + O_NOFOLLOW). The
//     pre-check catches known symlinks; O_NOFOLLOW on the actual
//     open() call closes the TOCTOU window for the leaf component.
//   - Dotfiles are ALWAYS blocked — no configuration, no exceptions.
//   - File size is capped on read.
//   - Error messages are sanitised — no raw OS paths leak to the guest.
//
// Split from the original fs-access plugin to allow independent
// approval of read vs write capabilities. This plugin contains ONLY
// read operations (readFile, listDir, stat). For write operations,
// see the companion fs-write plugin.
//
//   (One base directory, that is.)
//
// ─────────────────────────────────────────────────────────────────────

import {
  readFileSync,
  readSync,
  readdirSync,
  lstatSync,
  fstatSync,
  realpathSync,
  existsSync,
  openSync,
  closeSync,
  mkdirSync,
  constants as FS_CONSTANTS,
} from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { validatePath, safeNumericConfig } from "../shared/path-jail.js";
import type { ConfigSchema, ConfigValues } from "../plugin-schema-types.js";

// ── Plugin Schema (source of truth) ─────────────────────────────────

/**
 * Configuration schema for the fs-read plugin.
 * This is the single source of truth — config types are derived from it.
 */
export const SCHEMA = {
  baseDir: {
    type: "string" as const,
    description:
      "Absolute path to the single base directory for all filesystem operations. If omitted, a unique temp directory is created automatically. Must not be a symlink.",
    maxLength: 4096,
    promptKey: true,
  },
  maxFileSizeKb: {
    type: "number" as const,
    description:
      "Maximum total file size allowed for reads in kilobytes. Files larger than this are rejected outright. Clamped to 10240 (10 MB).",
    default: 10240,
    minimum: 0,
    maximum: 10240,
  },
} satisfies ConfigSchema;

// Hints are now in plugin.json (structured metadata).

// ── Configuration Types ─────────────────────────────────────────────

/** Configuration for the fs-read plugin (derived from SCHEMA). */
export type FsReadConfig = ConfigValues<typeof SCHEMA>;

// ── Result Types ────────────────────────────────────────────────────

/** Result from readFile() and readFileChunk(). */
export interface ReadFileResult {
  /** File contents (text or base64 encoded). */
  content?: string;
  /** Error message if read failed. */
  error?: string;
  /** Encoding used ("base64" if binary, omitted for utf8). */
  encoding?: "base64";
  /** Total file size (only for readFileChunk). */
  totalSize?: number;
  /** Whether there's more data to read (only for readFileChunk). */
  hasMore?: boolean;
}

/** A directory entry from listDir(). */
export interface DirEntry {
  /** Entry name (file or directory name). */
  name: string;
  /** Entry type. */
  type: "file" | "directory";
}

/** Result from listDir(). */
export type ListDirResult = DirEntry[] | { error: string };

/** Result from stat(). */
export interface StatResult {
  /** File size in bytes. */
  size?: number;
  /** Whether it's a regular file. */
  isFile?: boolean;
  /** Whether it's a directory. */
  isDirectory?: boolean;
  /** Error message if stat failed. */
  error?: string;
}

// ── Constants ───────────────────────────────────────────────────────

/** Maximum allowed config value for size limits (10 MB). */
const MAX_SIZE_LIMIT_KB = 10240;

/**
 * Maximum data returned by a single readFile call (1 MB).
 *
 * This is a hard limit — NOT configurable. It exists because readFile
 * return values transit the Hyperlight input buffer (host→guest shared
 * memory). The buffer must be at least MAX_READ_CHUNK_KB + 16 KB of
 * protocol framing. Files larger than this should be read via
 * readFileChunk with explicit offset/length.
 *
 * DO NOT raise this without also raising DEFAULT_INPUT_BUFFER_KB in
 * sandbox-tool.js — exceeding the buffer causes a hard VM fault.
 */
const MAX_READ_CHUNK_KB = 1024;

/**
 * Allowed encoding values for read operations.
 * "utf8" (default) returns text; "base64" returns raw bytes as a
 * base64-encoded string — essential for binary files (images, PPTX,
 * PDF, etc.) that would corrupt as UTF-8.
 */
const ALLOWED_ENCODINGS = new Set(["utf8", "base64"]);

/** Maximum number of entries returned by listDir. */
const MAX_LIST_RESULTS = 1000;

/** Length of random suffix for temp directory names. */
const TEMP_DIR_RANDOM_BYTES = 8;

// ── Host Function Interfaces ────────────────────────────────────────

/** The fs-read host functions interface. */
export interface FsReadFunctions {
  /** Read a file's contents. */
  readFile: (path: string, encoding?: string) => ReadFileResult;
  /** Read a chunk of a file. */
  readFileChunk: (
    path: string,
    offsetBytes: number,
    lengthBytes: number,
    encoding?: string,
  ) => ReadFileResult;
  /** List directory contents. */
  listDir: (path: string) => ListDirResult;
  /** Get file/directory metadata. */
  stat: (path: string) => StatResult;
  /** Read file as raw bytes (throws on error). */
  readFileBinary: (path: string) => Buffer;
  /** Read a chunk of a file as raw bytes (throws on error). */
  readFileChunkBinary: (
    path: string,
    offsetBytes: number,
    lengthBytes: number,
  ) => Buffer;
}

/** Return type of createHostFunctions. */
export interface FsReadHostFunctions {
  "fs-read": FsReadFunctions;
}

// ── Main Factory ────────────────────────────────────────────────────

/**
 * Create the host functions for the fs-read plugin.
 *
 * SECURITY: This is a declarative API — the host calls this function
 * and registers the returned functions itself. The plugin never gets
 * access to the proto/sandbox object, closing the GAP 2 attack vector.
 *
 * @param config — Resolved plugin configuration
 * @returns Host functions keyed by module name
 */
export function createHostFunctions(
  config?: FsReadConfig,
): FsReadHostFunctions {
  // Guard against null/undefined config — the plugin system might
  // pass nothing if configSchema is empty.
  const cfg = config ?? {};

  // ── Resolve the ONE base directory ───────────────────────────
  // If no baseDir is configured, create an isolated temp directory.
  let resolvedBase: string;
  if (typeof cfg.baseDir === "string" && cfg.baseDir.trim().length > 0) {
    const abs = resolve(cfg.baseDir.trim());
    if (!existsSync(abs)) {
      // Operator asked for this dir — create it, same as the
      // temp-dir path. The operator chose the location; refusing
      // to create it is just annoying. Parent must exist though.
      mkdirSync(abs, { recursive: true });
      console.error(`[fs-read] Created baseDir: ${abs}`);
    }
    // Reject symlinked base dirs too — no funny business
    const lst = lstatSync(abs);
    if (lst.isSymbolicLink()) {
      throw new Error("[fs-read] baseDir must not be a symlink");
    }
    resolvedBase = realpathSync(abs);
  } else {
    // No baseDir configured — create a unique temp directory
    const suffix = randomBytes(TEMP_DIR_RANDOM_BYTES).toString("hex");
    resolvedBase = join(tmpdir(), `hyperlight-fs-${suffix}`);
    mkdirSync(resolvedBase, { recursive: true });
    console.error(
      `[fs-read] No baseDir configured — using temp: ${resolvedBase}`,
    );
  }

  // safeNumericConfig rejects NaN/Infinity/negative and clamps to ceiling.
  const maxFileBytes =
    safeNumericConfig(cfg.maxFileSizeKb, MAX_SIZE_LIMIT_KB) * 1024;

  // Per-call chunk limit — hard cap tied to sandbox buffer size.
  // readFile rejects files above this; readFileChunk enforces it
  // on the length parameter. Not configurable by design.
  const maxReadChunkBytes = MAX_READ_CHUNK_KB * 1024;

  // O_NOFOLLOW atomically rejects symlinks at open() on POSIX.
  // On Windows it doesn't exist — we rely on the lstatSync pre-check
  // in validatePath() plus a post-open fstatSync/lstatSync comparison.
  // The residual TOCTOU window is narrow and requires symlink creation
  // privileges (SeCreateSymbolicLinkPrivilege or Developer Mode).
  const O_NOFOLLOW = FS_CONSTANTS.O_NOFOLLOW ?? 0;

  // ── Host function implementations ────────────────────────────

  /**
   * readFile(path, encoding?) — Read a file's contents.
   * Uses O_NOFOLLOW to atomically reject symlinks at open time.
   */
  function readFile(filePath: string, encoding?: string): ReadFileResult {
    const enc =
      typeof encoding === "string" && ALLOWED_ENCODINGS.has(encoding)
        ? encoding
        : "utf8";

    const check = validatePath(filePath, resolvedBase);
    if (!check.valid) {
      return { error: check.error };
    }

    let fd: number | undefined;
    try {
      fd = openSync(
        check.realPath!,
        FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW,
      );
      const fileStat = fstatSync(fd);
      if (!fileStat.isFile()) {
        return { error: "Not a file" };
      }
      if (fileStat.size > maxFileBytes) {
        return {
          error: `File too large: exceeds read limit of ${maxFileBytes / 1024}KB`,
        };
      }
      if (fileStat.size > maxReadChunkBytes) {
        return {
          error: `File too large for single read: ${fileStat.size} bytes exceeds per-call limit of ${MAX_READ_CHUNK_KB}KB. Use readFileChunk(path, offsetBytes, lengthBytes) to read in chunks.`,
        };
      }

      if (enc === "base64") {
        const buf = readFileSync(fd);
        return { content: buf.toString("base64"), encoding: "base64" };
      }
      const content = readFileSync(fd, "utf8");
      return { content };
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException | null;
      if (e?.code === "ENOENT") {
        return { error: "File not found" };
      }
      if (e?.code === "ELOOP") {
        return { error: "Access denied: symlinks are not permitted" };
      }
      return { error: "Read operation failed" };
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  /**
   * readFileChunk(path, offsetBytes, lengthBytes, encoding?) — Chunked read.
   */
  function readFileChunk(
    filePath: string,
    offsetBytes: number,
    lengthBytes: number,
    encoding?: string,
  ): ReadFileResult {
    const enc =
      typeof encoding === "string" && ALLOWED_ENCODINGS.has(encoding)
        ? encoding
        : "utf8";

    const check = validatePath(filePath, resolvedBase);
    if (!check.valid) {
      return { error: check.error };
    }

    const offset = Number(offsetBytes);
    const length = Number(lengthBytes);
    if (!Number.isFinite(offset) || offset < 0) {
      return { error: "offsetBytes must be a non-negative number" };
    }
    if (!Number.isFinite(length) || length <= 0) {
      return { error: "lengthBytes must be a positive number" };
    }

    const clampedLength = Math.min(length, maxReadChunkBytes);

    let fd: number | undefined;
    try {
      fd = openSync(
        check.realPath!,
        FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW,
      );
      const fileStat = fstatSync(fd);
      if (!fileStat.isFile()) {
        return { error: "Not a file" };
      }
      if (fileStat.size > maxFileBytes) {
        return {
          error: `File too large: exceeds read limit of ${maxFileBytes / 1024}KB`,
        };
      }

      const totalSize = fileStat.size;

      if (offset >= totalSize) {
        const result: ReadFileResult = {
          content: "",
          totalSize,
          hasMore: false,
        };
        if (enc === "base64") result.encoding = "base64";
        return result;
      }

      const bytesToRead = Math.min(clampedLength, totalSize - offset);
      const buf = Buffer.alloc(bytesToRead);
      const bytesRead = readSync(fd, buf, 0, bytesToRead, offset);

      const actualBuf =
        bytesRead < bytesToRead ? buf.subarray(0, bytesRead) : buf;
      const hasMore = offset + bytesRead < totalSize;

      if (enc === "base64") {
        return {
          content: actualBuf.toString("base64"),
          encoding: "base64",
          totalSize,
          hasMore,
        };
      }
      return {
        content: actualBuf.toString("utf8"),
        totalSize,
        hasMore,
      };
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException | null;
      if (e?.code === "ENOENT") {
        return { error: "File not found" };
      }
      if (e?.code === "ELOOP") {
        return { error: "Access denied: symlinks are not permitted" };
      }
      return { error: "Read operation failed" };
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  /**
   * listDir(path) — List directory contents.
   */
  function listDir(dirPath: string): ListDirResult {
    const check = validatePath(dirPath, resolvedBase);
    if (!check.valid) {
      return { error: check.error! };
    }

    try {
      const dirStat = lstatSync(check.realPath!);
      if (dirStat.isSymbolicLink()) {
        return { error: "Access denied: symlinks are not permitted" };
      }
      if (!dirStat.isDirectory()) {
        return { error: "Not a directory" };
      }

      const entries = readdirSync(check.realPath!, { withFileTypes: true });
      const results: DirEntry[] = [];
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        if (entry.isSymbolicLink()) continue;
        if (!entry.isFile() && !entry.isDirectory()) continue;
        if (results.length >= MAX_LIST_RESULTS) break;

        results.push({
          name: entry.name,
          type: entry.isDirectory() ? "directory" : "file",
        });
      }
      return results;
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException | null;
      if (e?.code === "ENOENT") {
        return { error: "Directory not found" };
      }
      return { error: "List operation failed" };
    }
  }

  /**
   * stat(path) — Get file/directory metadata.
   */
  function stat(filePath: string): StatResult {
    const check = validatePath(filePath, resolvedBase);
    if (!check.valid) {
      return { error: check.error };
    }

    try {
      const st = lstatSync(check.realPath!);
      if (st.isSymbolicLink()) {
        return { error: "Access denied: symlinks are not permitted" };
      }
      return {
        size: st.size,
        isFile: st.isFile(),
        isDirectory: st.isDirectory(),
      };
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException | null;
      if (e?.code === "ENOENT") {
        return { error: "File not found" };
      }
      return { error: "Stat operation failed" };
    }
  }

  /**
   * readFileBinary(path) — Read file as raw bytes.
   */
  function readFileBinary(filePath: string): Buffer {
    const check = validatePath(filePath, resolvedBase);
    if (!check.valid) {
      throw new Error(check.error);
    }

    let fd: number | undefined;
    try {
      fd = openSync(
        check.realPath!,
        FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW,
      );
      const fileStat = fstatSync(fd);
      if (!fileStat.isFile()) {
        throw new Error("Not a file");
      }
      if (fileStat.size > maxFileBytes) {
        throw new Error(
          `File too large: exceeds read limit of ${maxFileBytes / 1024}KB`,
        );
      }
      if (fileStat.size > maxReadChunkBytes) {
        throw new Error(
          `File too large for single read: ${fileStat.size} bytes exceeds ` +
            `per-call limit of ${MAX_READ_CHUNK_KB}KB. ` +
            `Use readFileChunkBinary(path, offsetBytes, lengthBytes) to read in chunks.`,
        );
      }

      return readFileSync(fd);
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException | null;
      if (e?.code === "ENOENT") {
        throw new Error("File not found");
      }
      if (e?.code === "ELOOP") {
        throw new Error("Access denied: symlinks are not permitted");
      }
      if (err instanceof Error && !("code" in err)) throw err;
      throw new Error("Read operation failed");
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  /**
   * readFileChunkBinary(path, offsetBytes, lengthBytes) — Chunked binary read.
   */
  function readFileChunkBinary(
    filePath: string,
    offsetBytes: number,
    lengthBytes: number,
  ): Buffer {
    const check = validatePath(filePath, resolvedBase);
    if (!check.valid) {
      throw new Error(check.error);
    }

    const offset = Number(offsetBytes);
    const length = Number(lengthBytes);
    if (!Number.isFinite(offset) || offset < 0) {
      throw new Error("offsetBytes must be a non-negative number");
    }
    if (!Number.isFinite(length) || length <= 0) {
      throw new Error("lengthBytes must be a positive number");
    }

    const clampedLength = Math.min(length, maxReadChunkBytes);

    let fd: number | undefined;
    try {
      fd = openSync(
        check.realPath!,
        FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW,
      );
      const fileStat = fstatSync(fd);
      if (!fileStat.isFile()) {
        throw new Error("Not a file");
      }
      if (fileStat.size > maxFileBytes) {
        throw new Error(
          `File too large: exceeds read limit of ${maxFileBytes / 1024}KB`,
        );
      }

      if (offset >= fileStat.size) {
        return Buffer.alloc(0);
      }

      const bytesToRead = Math.min(clampedLength, fileStat.size - offset);
      const buf = Buffer.alloc(bytesToRead);
      const bytesRead = readSync(fd, buf, 0, bytesToRead, offset);

      if (bytesRead < bytesToRead) {
        return Buffer.from(buf.subarray(0, bytesRead));
      }
      return buf;
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException | null;
      if (e?.code === "ENOENT") {
        throw new Error("File not found");
      }
      if (e?.code === "ELOOP") {
        throw new Error("Access denied: symlinks are not permitted");
      }
      if (err instanceof Error && !("code" in err)) throw err;
      throw new Error("Read operation failed");
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  // Return the host functions keyed by module name
  return {
    "fs-read": {
      readFile,
      readFileChunk,
      listDir,
      stat,
      readFileBinary,
      readFileChunkBinary,
    },
  };
}

// ── Test-only exports ────────────────────────────────────────────────
// Exported for unit tests. NOT part of the public API.
export {
  validatePath as _validatePath,
  safeNumericConfig as _safeNumericConfig,
};
