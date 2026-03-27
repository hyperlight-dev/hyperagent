// ── fs-write plugin ──────────────────────────────────────────────────
//
// Write-only filesystem access jailed to a SINGLE base directory.
// Guest JavaScript loads via: const fs = require("host:fs-write")
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
//   - File size is capped and enforced cumulatively on append.
//   - Entry creation is capped (maxEntries) — prevents inode/disk
//     exhaustion from runaway writes. Tracks files + dirs combined.
//   - mkdir creates a SINGLE directory — no recursive creation.
//   - No delete operations — writes are create/overwrite/append only.
//   - No read operations — use the companion fs-read plugin.
//   - Error messages are sanitised — no raw OS paths leak to the guest.
//
// Split from the original fs-access plugin to allow independent
// approval of read vs write capabilities. This plugin contains ONLY
// write operations (writeFile, appendFile, mkdir). For read operations,
// see the companion fs-read plugin.
//
//
// ─────────────────────────────────────────────────────────────────────

import {
  writeFileSync,
  mkdirSync,
  lstatSync,
  fstatSync,
  realpathSync,
  existsSync,
  openSync,
  closeSync,
  constants as FS_CONSTANTS,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { validatePath, safeNumericConfig } from "../shared/path-jail.js";
import type { ConfigSchema, ConfigValues } from "../plugin-schema-types.js";

// ── Plugin Schema (source of truth) ─────────────────────────────────

/**
 * Configuration schema for the fs-write plugin.
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
  maxWriteSizeKb: {
    type: "number" as const,
    description:
      "Maximum per-file cumulative size for writes/appends in kilobytes. Cumulative for appends (existing + new). Set to 0 to block non-empty writes. Clamped to 51200 (50 MB).",
    default: 20480,
    minimum: 0,
    maximum: 51200,
  },
  maxEntries: {
    type: "number" as const,
    description:
      "Maximum number of files and directories that can be created (combined total). Prevents inode/disk exhaustion from runaway writes. Set to 0 to block all creation. Clamped to 10000.",
    default: 1000,
    minimum: 0,
    maximum: 10000,
  },
} satisfies ConfigSchema;

// Hints are now in plugin.json (structured metadata).

// ── Configuration Types ─────────────────────────────────────────────

/** Configuration for the fs-write plugin (derived from SCHEMA). */
export type FsWriteConfig = ConfigValues<typeof SCHEMA>;

// ── Result Types ────────────────────────────────────────────────────

/** Result from writeFile() and appendFile(). */
export interface WriteResult {
  /** True if write succeeded. */
  ok?: boolean;
  /** Error message if write failed. */
  error?: string;
}

/** Result from mkdir(). */
export interface MkdirResult {
  /** True if mkdir succeeded. */
  ok?: boolean;
  /** Error message if mkdir failed. */
  error?: string;
}

// ── Constants ───────────────────────────────────────────────────────

/** Maximum allowed config value for size limits (50 MB). */
const MAX_SIZE_LIMIT_KB = 51200;

/**
 * Maximum data accepted by a single writeFile/appendFile call (2 MB).
 * Increased from 1MB to support larger single writes when output buffer is configured.
 */
const MAX_WRITE_CHUNK_KB = 2048;

/**
 * Allowed encoding values for write operations.
 */
const ALLOWED_ENCODINGS = new Set(["utf8", "base64"]);

/** Maximum allowed config value for entry creation limit. */
const MAX_ENTRIES_LIMIT = 10000;

/** File creation mode — owner read/write only. */
const FILE_MODE = 0o600;

/** Length of random suffix for temp directory names. */
const TEMP_DIR_RANDOM_BYTES = 8;

// ── Host Function Interfaces ────────────────────────────────────────

/** The fs-write host functions interface. */
export interface FsWriteFunctions {
  /** Write content to a file (creates or overwrites). */
  writeFile: (path: string, content: string, encoding?: string) => WriteResult;
  /** Append content to a file (creates if doesn't exist). */
  appendFile: (path: string, content: string, encoding?: string) => WriteResult;
  /** Write binary data to a file (throws on error). */
  writeFileBinary: (
    path: string,
    data: Buffer | Uint8Array | ArrayBuffer,
  ) => WriteResult;
  /** Append binary data to a file (throws on error). */
  appendFileBinary: (
    path: string,
    data: Buffer | Uint8Array | ArrayBuffer,
  ) => WriteResult;
  /** Create a directory (non-recursive). */
  mkdir: (path: string) => MkdirResult;
}

/** Return type of createHostFunctions. */
export interface FsWriteHostFunctions {
  "fs-write": FsWriteFunctions;
}

// ── Main Factory ────────────────────────────────────────────────────

/**
 * Create the host functions for the fs-write plugin.
 *
 * SECURITY: This is a declarative API — the host calls this function
 * and registers the returned functions itself. The plugin never gets
 * access to the proto/sandbox object, closing the GAP 2 attack vector.
 *
 * @param config — Resolved plugin configuration
 * @returns Host functions keyed by module name
 */
export function createHostFunctions(
  config?: FsWriteConfig,
): FsWriteHostFunctions {
  const cfg = config ?? {};

  // ── Resolve the ONE base directory ───────────────────────────
  let resolvedBase: string;
  if (typeof cfg.baseDir === "string" && cfg.baseDir.trim().length > 0) {
    const abs = resolve(cfg.baseDir.trim());
    if (!existsSync(abs)) {
      mkdirSync(abs, { recursive: true });
      console.error(`[fs-write] Created baseDir: ${abs}`);
    }
    const lst = lstatSync(abs);
    if (lst.isSymbolicLink()) {
      throw new Error("[fs-write] baseDir must not be a symlink");
    }
    resolvedBase = realpathSync(abs);
  } else {
    const suffix = randomBytes(TEMP_DIR_RANDOM_BYTES).toString("hex");
    resolvedBase = join(tmpdir(), `hyperlight-fs-${suffix}`);
    mkdirSync(resolvedBase, { recursive: true });
    console.error(
      `[fs-write] No baseDir configured — using temp: ${resolvedBase}`,
    );
  }

  const maxWriteBytes =
    safeNumericConfig(cfg.maxWriteSizeKb, 20480, MAX_SIZE_LIMIT_KB) * 1024;
  const maxWriteChunkBytes = MAX_WRITE_CHUNK_KB * 1024;

  // O_NOFOLLOW atomically rejects symlinks at open() on POSIX.
  // On Windows it doesn't exist — we rely on the lstatSync pre-check
  // in validatePath() plus a post-open fstatSync/lstatSync comparison.
  // The residual TOCTOU window is narrow and requires symlink creation
  // privileges (SeCreateSymbolicLinkPrivilege or Developer Mode).
  const O_NOFOLLOW = FS_CONSTANTS.O_NOFOLLOW ?? 0;

  const maxEntries = Math.floor(
    safeNumericConfig(cfg.maxEntries, 500, MAX_ENTRIES_LIMIT),
  );
  let entriesCreated = 0;

  // ── Host function implementations ────────────────────────────

  function writeFile(
    filePath: string,
    content: string,
    encoding?: string,
  ): WriteResult {
    const enc =
      typeof encoding === "string" && ALLOWED_ENCODINGS.has(encoding)
        ? encoding
        : "utf8";

    const check = validatePath(filePath, resolvedBase);
    if (!check.valid) {
      return { error: check.error };
    }

    if (typeof content !== "string") {
      return {
        error:
          "writeFile expects a string. For binary data (Uint8Array from " +
          "createZip, etc.), use writeFileBinary(path, data) instead.",
      };
    }

    const contentBytes =
      enc === "base64"
        ? Math.ceil((content.length * 3) / 4)
        : Buffer.byteLength(content, "utf8");

    if (contentBytes > maxWriteChunkBytes) {
      return {
        error: `Content too large for single write: ${contentBytes} bytes exceeds per-call limit of ${MAX_WRITE_CHUNK_KB}KB. Split into multiple appendFile calls.`,
      };
    }
    if (contentBytes > maxWriteBytes) {
      return {
        error: `Content too large: exceeds cumulative file write limit of ${maxWriteBytes / 1024}KB`,
      };
    }

    let fd: number | undefined;
    let isNew = false;
    try {
      const parentDir = dirname(check.realPath!);
      if (!existsSync(parentDir)) {
        return { error: "Parent directory does not exist" };
      }
      isNew = !existsSync(check.realPath!);
      if (isNew) {
        if (entriesCreated >= maxEntries) {
          return {
            error: `Entry limit reached: cannot create more than ${maxEntries} files/directories`,
          };
        }
        entriesCreated++;
      }
      fd = openSync(
        check.realPath!,
        FS_CONSTANTS.O_WRONLY |
          FS_CONSTANTS.O_CREAT |
          FS_CONSTANTS.O_TRUNC |
          FS_CONSTANTS.O_NOFOLLOW,
        FILE_MODE,
      );
      const fdStat = fstatSync(fd);
      if (!isNew && !fdStat.isFile()) {
        return { error: "Not a regular file" };
      }

      if (enc === "base64") {
        const buf = Buffer.from(content, "base64");
        writeFileSync(fd, buf);
      } else {
        writeFileSync(fd, content, "utf8");
      }
      return { ok: true };
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException | null;
      if (isNew && !existsSync(check.realPath!)) entriesCreated--;
      if (e?.code === "ENOENT") {
        return { error: "Parent directory does not exist" };
      }
      if (e?.code === "ELOOP") {
        return { error: "Access denied: symlinks are not permitted" };
      }
      return { error: "Write operation failed" };
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  function appendFile(
    filePath: string,
    content: string,
    encoding?: string,
  ): WriteResult {
    const enc =
      typeof encoding === "string" && ALLOWED_ENCODINGS.has(encoding)
        ? encoding
        : "utf8";

    const check = validatePath(filePath, resolvedBase);
    if (!check.valid) {
      return { error: check.error };
    }

    if (typeof content !== "string") {
      return {
        error:
          "appendFile expects a string. For binary data (Uint8Array), " +
          "use appendFileBinary(path, data) instead.",
      };
    }

    const contentBytes =
      enc === "base64"
        ? Math.ceil((content.length * 3) / 4)
        : Buffer.byteLength(content, "utf8");

    if (contentBytes > maxWriteChunkBytes) {
      return {
        error: `Append content too large for single call: ${contentBytes} bytes exceeds per-call limit of ${MAX_WRITE_CHUNK_KB}KB. Split into smaller appendFile calls.`,
      };
    }
    if (contentBytes > maxWriteBytes) {
      return {
        error: `Append would exceed cumulative file write limit of ${maxWriteBytes / 1024}KB`,
      };
    }

    let fd: number | undefined;
    let isNew = false;
    try {
      const parentDir = dirname(check.realPath!);
      if (!existsSync(parentDir)) {
        return { error: "Parent directory does not exist" };
      }
      isNew = !existsSync(check.realPath!);
      if (isNew) {
        if (entriesCreated >= maxEntries) {
          return {
            error: `Entry limit reached: cannot create more than ${maxEntries} files/directories`,
          };
        }
        entriesCreated++;
      }
      fd = openSync(
        check.realPath!,
        FS_CONSTANTS.O_WRONLY |
          FS_CONSTANTS.O_CREAT |
          FS_CONSTANTS.O_APPEND |
          FS_CONSTANTS.O_NOFOLLOW,
        FILE_MODE,
      );
      const fdStat = fstatSync(fd);
      if (!isNew && !fdStat.isFile()) {
        return { error: "Not a regular file" };
      }
      if (fdStat.size + contentBytes > maxWriteBytes) {
        return {
          error: `Append would exceed cumulative file write limit of ${maxWriteBytes / 1024}KB (current: ${fdStat.size} bytes + new: ${contentBytes} bytes)`,
        };
      }

      if (enc === "base64") {
        const buf = Buffer.from(content, "base64");
        writeFileSync(fd, buf);
      } else {
        writeFileSync(fd, content, "utf8");
      }
      return { ok: true };
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException | null;
      if (isNew && !existsSync(check.realPath!)) entriesCreated--;
      if (e?.code === "ENOENT") {
        return { error: "Parent directory does not exist" };
      }
      if (e?.code === "ELOOP") {
        return { error: "Access denied: symlinks are not permitted" };
      }
      return { error: "Append operation failed" };
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  function writeFileBinary(
    filePath: string,
    data: Buffer | Uint8Array | ArrayBuffer | ArrayBufferView,
  ): WriteResult {
    const check = validatePath(filePath, resolvedBase);
    if (!check.valid) {
      throw new Error(check.error);
    }

    let buf: Buffer;
    if (Buffer.isBuffer(data)) {
      buf = data;
    } else if (data instanceof Uint8Array || ArrayBuffer.isView(data)) {
      buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    } else if (data instanceof ArrayBuffer) {
      buf = Buffer.from(data);
    } else {
      throw new Error(
        "writeFileBinary expects binary data (Uint8Array from createZip, " +
          "buildZip, etc.). For string content, use writeFile instead.",
      );
    }

    const contentBytes = buf.length;

    if (contentBytes > maxWriteChunkBytes) {
      // Suggest exportToFile for PPTX/XLSX/DOCX files which can auto-chunk
      const isPptx = filePath.toLowerCase().endsWith(".pptx");
      const isOffice =
        isPptx ||
        filePath.toLowerCase().endsWith(".xlsx") ||
        filePath.toLowerCase().endsWith(".docx");
      const hint = isOffice
        ? ` For ${isPptx ? "PPTX" : "Office"} files, use exportToFile(pres, filename, fsWrite) from ha:pptx which handles chunking automatically.`
        : " Split into multiple appendFileBinary calls.";
      throw new Error(
        `Content too large for single write: ${contentBytes} bytes exceeds ` +
          `per-call limit of ${MAX_WRITE_CHUNK_KB}KB.${hint}`,
      );
    }
    if (contentBytes > maxWriteBytes) {
      throw new Error(
        `Content too large: exceeds cumulative file write limit of ${maxWriteBytes / 1024}KB`,
      );
    }

    let fd: number | undefined;
    let isNew = false;
    try {
      const parentDir = dirname(check.realPath!);
      if (!existsSync(parentDir)) {
        throw new Error("Parent directory does not exist");
      }
      isNew = !existsSync(check.realPath!);
      if (isNew) {
        if (entriesCreated >= maxEntries) {
          throw new Error(
            `Entry limit reached: cannot create more than ${maxEntries} files/directories`,
          );
        }
        entriesCreated++;
      }
      fd = openSync(
        check.realPath!,
        FS_CONSTANTS.O_WRONLY |
          FS_CONSTANTS.O_CREAT |
          FS_CONSTANTS.O_TRUNC |
          FS_CONSTANTS.O_NOFOLLOW,
        FILE_MODE,
      );
      const fdStat = fstatSync(fd);
      if (!isNew && !fdStat.isFile()) {
        throw new Error("Not a regular file");
      }

      writeFileSync(fd, buf);
      return { ok: true };
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException | null;
      if (isNew && !existsSync(check.realPath!)) entriesCreated--;
      if (e?.code === "ENOENT") {
        throw new Error("Parent directory does not exist");
      }
      if (e?.code === "ELOOP") {
        throw new Error("Access denied: symlinks are not permitted");
      }
      if (err instanceof Error && !("code" in err)) throw err;
      throw new Error("Write operation failed");
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  function appendFileBinary(
    filePath: string,
    data: Buffer | Uint8Array | ArrayBuffer | ArrayBufferView,
  ): WriteResult {
    const check = validatePath(filePath, resolvedBase);
    if (!check.valid) {
      throw new Error(check.error);
    }

    let buf: Buffer;
    if (Buffer.isBuffer(data)) {
      buf = data;
    } else if (data instanceof Uint8Array || ArrayBuffer.isView(data)) {
      buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    } else if (data instanceof ArrayBuffer) {
      buf = Buffer.from(data);
    } else {
      throw new Error(
        "appendFileBinary expects binary data (Uint8Array). " +
          "For string content, use appendFile instead.",
      );
    }

    const contentBytes = buf.length;

    if (contentBytes > maxWriteChunkBytes) {
      throw new Error(
        `Append content too large for single call: ${contentBytes} bytes exceeds ` +
          `per-call limit of ${MAX_WRITE_CHUNK_KB}KB. ` +
          `Split into smaller appendFileBinary calls.`,
      );
    }
    if (contentBytes > maxWriteBytes) {
      throw new Error(
        `Append would exceed cumulative file write limit of ${maxWriteBytes / 1024}KB`,
      );
    }

    let fd: number | undefined;
    let isNew = false;
    try {
      const parentDir = dirname(check.realPath!);
      if (!existsSync(parentDir)) {
        throw new Error("Parent directory does not exist");
      }
      isNew = !existsSync(check.realPath!);
      if (isNew) {
        if (entriesCreated >= maxEntries) {
          throw new Error(
            `Entry limit reached: cannot create more than ${maxEntries} files/directories`,
          );
        }
        entriesCreated++;
      }
      fd = openSync(
        check.realPath!,
        FS_CONSTANTS.O_WRONLY |
          FS_CONSTANTS.O_CREAT |
          FS_CONSTANTS.O_APPEND |
          FS_CONSTANTS.O_NOFOLLOW,
        FILE_MODE,
      );
      const fdStat = fstatSync(fd);
      if (!isNew && !fdStat.isFile()) {
        throw new Error("Not a regular file");
      }
      if (fdStat.size + contentBytes > maxWriteBytes) {
        throw new Error(
          `Append would exceed cumulative file write limit of ` +
            `${maxWriteBytes / 1024}KB (current: ${fdStat.size} bytes + new: ${contentBytes} bytes)`,
        );
      }

      writeFileSync(fd, buf);
      return { ok: true };
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException | null;
      if (isNew && !existsSync(check.realPath!)) entriesCreated--;
      if (e?.code === "ENOENT") {
        throw new Error("Parent directory does not exist");
      }
      if (e?.code === "ELOOP") {
        throw new Error("Access denied: symlinks are not permitted");
      }
      if (err instanceof Error && !("code" in err)) throw err;
      throw new Error("Append operation failed");
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  function mkdir(dirPath: string): MkdirResult {
    const check = validatePath(dirPath, resolvedBase);
    if (!check.valid) {
      return { error: check.error };
    }

    try {
      const parentDir = dirname(check.realPath!);
      if (!existsSync(parentDir)) {
        return { error: "Parent directory does not exist" };
      }
      if (entriesCreated >= maxEntries) {
        return {
          error: `Entry limit reached: cannot create more than ${maxEntries} files/directories`,
        };
      }
      entriesCreated++;
      mkdirSync(check.realPath!);
      return { ok: true };
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException | null;
      if (entriesCreated > 0) entriesCreated--;
      if (e?.code === "ENOENT") {
        return { error: "Parent directory does not exist" };
      }
      if (e?.code === "EEXIST") {
        return { error: "Directory already exists" };
      }
      return { error: "Mkdir operation failed" };
    }
  }

  // Return the host functions keyed by module name
  return {
    "fs-write": {
      writeFile,
      appendFile,
      writeFileBinary,
      appendFileBinary,
      mkdir,
    },
  };
}

// ── Test-only exports ────────────────────────────────────────────────
export {
  validatePath as _validatePath,
  safeNumericConfig as _safeNumericConfig,
};
