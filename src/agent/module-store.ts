// ── agent/module-store.ts — User module persistence ──────────────────
//
// Manages the lifecycle of user modules on disk:
//   - Save / load / list / delete modules in ~/.hyperagent/modules/
//   - Metadata stored as comment headers in .js files
//   - Auto-extract exports via analysis-guest (Hyperlight sandbox)
//   - System vs user module distinction (author field)
//
// ─────────────────────────────────────────────────────────────────────

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
  existsSync,
  statSync,
} from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import {
  extractModuleMetadata as extractModuleMetadataGuest,
  type ExportInfo,
  type ModuleMetadataResponse,
} from "./analysis-guest.js";

// ── Constants ────────────────────────────────────────────────────────

/** Default modules directory — ~/.hyperagent/modules/ */
const DEFAULT_MODULES_DIR = join(homedir(), ".hyperagent", "modules");

/** Maximum module source size in bytes (512KB). */
const MAX_MODULE_SIZE_BYTES = 512 * 1024;

/** Regex for valid module names: lowercase, digits, hyphens. */
const VALID_NAME_RE = /^[a-z][a-z0-9-]*$/;

// ── Types ────────────────────────────────────────────────────────────

/** Class information extracted from module source (Phase 4.5). */
export interface ClassInfo {
  /** Class name */
  name: string;
  /** Instance method names */
  methods: string[];
  /** Method return types (Phase 4.5.4): maps method name → return type name. */
  methodReturns?: Record<string, string>;
  /** Instance property names (for property access validation). */
  properties?: string[];
}

/** Full module metadata returned by load/list operations. */
export interface ModuleInfo {
  /** Module name (without namespace prefix). */
  name: string;
  /** One-line description. */
  description: string;
  /** ISO timestamp when first created. */
  created: string;
  /** ISO timestamp of last modification. */
  modified: string;
  /** Source code size in bytes. */
  sizeBytes: number;
  /** JavaScript source code. */
  source: string;
  /** Auto-extracted export signatures. */
  exports: ExportInfo[];
  /** Auto-extracted class definitions with methods (Phase 4.5). */
  classes: ClassInfo[];
  /** Whether the module can be modified/deleted by the LLM. */
  mutable: boolean;
  /** Who created it: "system" (ships with HyperAgent) or "user" (LLM-created). */
  author: "system" | "user";
  /** Module-specific hints for LLM usage (from _HINTS export — legacy). */
  hints?: string;
  /** Structured hints from JSON metadata (preferred over legacy _HINTS). */
  structuredHints?: ModuleHints;
  /** Recommended import style: "named" for import { x }, "namespace" for import * as x. */
  importStyle?: "named" | "namespace";
}

// ── Metadata Loading ─────────────────────────────────────────────────
//
// System modules have a companion .json file with metadata:
//   { "name": "...", "description": "...", "author": "system", "mutable": false }
// User modules use comment headers in the .js file (legacy format):
//   // @module <name>
//   // @description <one-liner>
//   // @mutable <true|false>
//   // @author <system|user>

/** Cached metadata extracted from source (Phase 3 caching). */
interface MetadataCache {
  /** Hash of source when metadata was extracted. */
  extractedFromHash: string;
  /** Cached export signatures. */
  exports: ExportInfo[];
  /** Cached class definitions. */
  classes: ClassInfo[];
  /** Cached hints string. */
  hints?: string;
}

/** Module metadata from .json file (system modules). */
interface ModuleJsonMeta {
  name: string;
  description: string;
  author: "system" | "user";
  mutable: boolean;
  /** Module type: "native" for Rust-compiled modules, undefined for TypeScript/JS. */
  type?: "native";
  sourceHash?: string;
  dtsHash?: string;
  /** Recommended import style: "named" or "namespace". */
  importStyle?: "named" | "namespace";
  /** Cached metadata - invalidated when sourceHash changes. */
  metadataCache?: MetadataCache;
  /** Structured hints — replaces _HINTS export for system modules. */
  hints?: ModuleHints;
}

/**
 * Structured hints for a module, stored in the companion .json file.
 * Surfaced by module_info() and used by suggest_approach guidance.
 * Replaces the free-text _HINTS export with queryable structured data.
 */
export interface ModuleHints {
  /** One-liner context for quick discovery. */
  overview: string;
  /** Other ha:* modules commonly used alongside this one. */
  relatedModules?: string[];
  /** Plugins that MUST be enabled to use this module. */
  requiredPlugins?: string[];
  /** Plugins that are often useful alongside this module. */
  optionalPlugins?: string[];
  /** Rules that WILL cause errors if ignored. */
  criticalRules?: string[];
  /** Common mistakes to avoid. */
  antiPatterns?: string[];
  /** Typical usage recipes. */
  commonPatterns?: string[];
}

/**
 * Try to load metadata from companion .json file.
 * Returns null if no .json file exists (user module).
 */
function loadJsonMetadata(dir: string, name: string): ModuleJsonMeta | null {
  const jsonPath = join(dir, `${name}.json`);
  if (!existsSync(jsonPath)) return null;
  try {
    const content = readFileSync(jsonPath, "utf-8");
    return JSON.parse(content) as ModuleJsonMeta;
  } catch {
    return null;
  }
}

/**
 * Save module JSON metadata to companion .json file.
 */
function saveJsonMetadata(
  dir: string,
  name: string,
  meta: ModuleJsonMeta,
): void {
  const jsonPath = join(dir, `${name}.json`);
  writeFileSync(jsonPath, JSON.stringify(meta, null, 2), "utf-8");
}

/**
 * Compute SHA256 hash of source code for cache invalidation.
 * Returns "sha256:<hex>" format.
 */
function computeSourceHash(source: string): string {
  const hash = createHash("sha256").update(source, "utf-8").digest("hex");
  return `sha256:${hash}`;
}

/**
 * Compute truncated SHA256 hash matching the format used in module.json.
 * Returns "sha256:<16-char-hex>" format.
 */
function computeTruncatedHash(content: string | Buffer): string {
  const hash = createHash("sha256").update(content).digest("hex");
  return `sha256:${hash.slice(0, 16)}`;
}

/** Parse metadata from comment header lines at the top of a .js file (legacy). */
function parseMetadata(source: string): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("//")) break; // stop at first non-comment line
    const match = trimmed.match(/^\/\/\s*@(\w+)\s+(.*)/);
    if (match) {
      meta[match[1]] = match[2].trim();
    }
  }
  return meta;
}

/** Build a metadata comment header string. */
function buildMetadataHeader(info: {
  name: string;
  description: string;
  created: string;
  modified: string;
  mutable: boolean;
  author: "system" | "user";
}): string {
  return [
    `// @module ${info.name}`,
    `// @description ${info.description}`,
    `// @created ${info.created}`,
    `// @modified ${info.modified}`,
    `// @mutable ${info.mutable}`,
    `// @author ${info.author}`,
    "",
  ].join("\n");
}

/** Strip the metadata comment header from source, returning just the code. */
function stripMetadataHeader(source: string): string {
  const lines = source.split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim().startsWith("//")) i++;
  // Skip blank line after header
  if (i < lines.length && lines[i].trim() === "") i++;
  return lines.slice(i).join("\n");
}

// ── Module Metadata Extraction ────────────────────────────────────────

/**
 * Extract module metadata (exports, classes, hints) from source.
 * Uses Rust guest (secure, ReDoS-safe) - no legacy fallback.
 */
async function extractMetadata(source: string): Promise<{
  exports: ExportInfo[];
  classes: ClassInfo[];
  hints?: string;
}> {
  const result = await extractModuleMetadataGuest(source);
  // Convert guest response to our types (with defensive null handling)
  const classes: ClassInfo[] = (result.classes ?? []).map(
    (c: {
      name: string;
      methods: string[];
      methodReturns?: Record<string, string>;
      properties?: string[];
    }) => ({
      name: c.name,
      methods: c.methods,
      methodReturns: c.methodReturns,
      properties: c.properties,
    }),
  );
  return {
    exports: (result.exports ?? []) as ExportInfo[],
    classes,
    hints: result.hints,
  };
}

// ── Validation ───────────────────────────────────────────────────────

/** Validate a module name. Returns error string or null if valid. */
export function validateModuleName(name: string): string | null {
  if (!name) return "Module name must not be empty";
  if (name.length > 64) return "Module name must be ≤64 characters";
  if (!VALID_NAME_RE.test(name))
    return "Module name must be lowercase letters, digits, and hyphens (e.g. 'str-bytes', 'crc32')";
  if (name.includes("..") || name.includes("/") || name.includes("\\"))
    return "Module name must not contain path traversal characters";
  return null;
}

// ── Public API ───────────────────────────────────────────────────────

/** Get (and create if needed) the modules directory path. */
export function getModulesDir(): string {
  mkdirSync(DEFAULT_MODULES_DIR, { recursive: true });
  return DEFAULT_MODULES_DIR;
}

/**
 * Save a module to disk with metadata header.
 * Uses Rust guest for secure metadata extraction.
 *
 * @param name — Module name (kebab-case, no prefix)
 * @param source — ES module JavaScript source code
 * @param description — One-line description
 * @param opts — Optional: author, mutable overrides
 * @returns ModuleInfo with extracted exports
 * @throws On validation failure
 */
export async function saveModule(
  name: string,
  source: string,
  description: string,
  opts?: { mutable?: boolean; author?: "system" | "user" },
): Promise<ModuleInfo> {
  const nameError = validateModuleName(name);
  if (nameError) throw new Error(nameError);

  if (!source || source.trim().length === 0) {
    throw new Error("Module source must not be empty");
  }
  if (!description || description.trim().length === 0) {
    throw new Error("Module description must not be empty");
  }
  if (source.length > MAX_MODULE_SIZE_BYTES) {
    throw new Error(
      `Module source exceeds maximum size (${source.length} bytes > ${MAX_MODULE_SIZE_BYTES} bytes)`,
    );
  }

  const dir = getModulesDir();
  const filePath = join(dir, `${name}.js`);
  const now = new Date().toISOString();

  // Check if updating an existing module
  let created = now;
  if (existsSync(filePath)) {
    const existingMeta = parseMetadata(readFileSync(filePath, "utf-8"));
    if (existingMeta.created) created = existingMeta.created;
    // Check mutability — system modules cannot be overwritten
    if (existingMeta.author === "system") {
      throw new Error(
        `Module "${name}" is a system module and cannot be modified`,
      );
    }
    if (existingMeta.mutable === "false") {
      throw new Error(
        `Module "${name}" is locked (mutable=false). Use /module unlock first.`,
      );
    }
  }

  const author = opts?.author ?? "user";
  const mutable = opts?.mutable ?? author !== "system";

  const header = buildMetadataHeader({
    name,
    description,
    created,
    modified: now,
    mutable,
    author,
  });

  const fullSource = header + source;
  writeFileSync(filePath, fullSource, "utf-8");

  // Extract metadata using Rust guest (secure, ReDoS-safe)
  const { exports, classes, hints } = await extractMetadata(source);

  // Write .json cache for fast subsequent loads
  const currentHash = computeSourceHash(source);
  const jsonMeta: ModuleJsonMeta = {
    name,
    description,
    author,
    mutable,
    // Keep sourceHash in sync so the validator doesn't flag a mismatch
    sourceHash: computeTruncatedHash(source),
    metadataCache: {
      extractedFromHash: currentHash,
      exports,
      classes,
      ...(hints ? { hints } : {}),
    },
  };
  saveJsonMetadata(dir, name, jsonMeta);

  return {
    name,
    description,
    created,
    modified: now,
    sizeBytes: source.length,
    source,
    exports,
    classes,
    mutable,
    author,
    ...(hints ? { hints } : {}),
  };
}

/**
 * Load a module from disk by name (sync version).
 * Uses cached metadata from .json file when available.
 * If no cache exists, returns module with empty exports/classes.
 * Use loadModuleAsync() to ensure full metadata extraction.
 */
export function loadModule(name: string): ModuleInfo | null {
  const dir = getModulesDir();
  const filePath = join(dir, `${name}.js`);

  // Native Rust modules have .json metadata but no .js file.
  // They're compiled into the Hyperlight runtime (html, markdown, image, ziplib).
  if (!existsSync(filePath)) {
    const jsonMeta = loadJsonMetadata(dir, name);
    if (jsonMeta && jsonMeta.type === "native") {
      const dtsPath = join(dir, `${name}.d.ts`);
      let exports: ExportInfo[] = [];
      if (existsSync(dtsPath)) {
        const dtsContent = readFileSync(dtsPath, "utf-8");
        const fns = [
          ...dtsContent.matchAll(/export\s+declare\s+function\s+(\w+)/g),
        ];
        exports = fns.map((m) => ({
          name: m[1],
          kind: "function" as const,
        }));
      }
      return {
        name,
        description: jsonMeta.description,
        created: "",
        modified: "",
        sizeBytes: 0,
        source: "",
        exports,
        classes: [],
        mutable: false,
        author: "system" as const,
        ...(jsonMeta.hints ? { structuredHints: jsonMeta.hints } : {}),
        ...(jsonMeta.importStyle
          ? { importStyle: jsonMeta.importStyle as "named" | "namespace" }
          : {}),
      };
    }
    return null;
  }

  const raw = readFileSync(filePath, "utf-8");
  const stat = statSync(filePath);

  // Try .json metadata first, fall back to comment headers
  const jsonMeta = loadJsonMetadata(dir, name);
  if (jsonMeta) {
    // System modules: source is the entire file (no header)
    // User modules with .json: source has header that needs stripping
    const isSystemModule = jsonMeta.author === "system";
    const source = isSystemModule ? raw : stripMetadataHeader(raw);
    const currentHash = computeSourceHash(source);

    // Check if we have valid cached metadata
    if (jsonMeta.metadataCache?.extractedFromHash === currentHash) {
      return {
        name,
        description: jsonMeta.description,
        created: stat.birthtime.toISOString(),
        modified: stat.mtime.toISOString(),
        sizeBytes: source.length,
        source,
        exports: jsonMeta.metadataCache.exports,
        classes: jsonMeta.metadataCache.classes,
        mutable: jsonMeta.mutable,
        author: jsonMeta.author,
        ...(jsonMeta.metadataCache.hints
          ? { hints: jsonMeta.metadataCache.hints }
          : {}),
        ...(jsonMeta.importStyle ? { importStyle: jsonMeta.importStyle } : {}),
      };
    }

    // Cache miss - return with empty exports (caller should use loadModuleAsync for full metadata)
    return {
      name,
      description: jsonMeta.description,
      created: stat.birthtime.toISOString(),
      modified: stat.mtime.toISOString(),
      sizeBytes: source.length,
      source,
      exports: [],
      classes: [],
      mutable: jsonMeta.mutable,
      author: jsonMeta.author,
      ...(jsonMeta.hints ? { structuredHints: jsonMeta.hints } : {}),
      ...(jsonMeta.importStyle ? { importStyle: jsonMeta.importStyle } : {}),
    };
  }

  // User module without .json: parse comment headers and strip them from source
  const meta = parseMetadata(raw);
  const source = stripMetadataHeader(raw);

  // Return with empty exports - caller should use loadModuleAsync() for full metadata extraction
  return {
    name,
    description: meta.description ?? "",
    created: meta.created ?? stat.birthtime.toISOString(),
    modified: meta.modified ?? stat.mtime.toISOString(),
    sizeBytes: source.length,
    source,
    exports: [],
    classes: [],
    mutable: meta.mutable !== "false",
    author: (meta.author as "system" | "user") ?? "user",
  };
}

/**
 * Load a module from disk by name (async version).
 * Uses Rust guest for secure metadata extraction.
 * Updates .json cache on cache miss for faster subsequent loads.
 * Returns null if the module doesn't exist.
 */
export async function loadModuleAsync(
  name: string,
): Promise<ModuleInfo | null> {
  const dir = getModulesDir();
  const filePath = join(dir, `${name}.js`);
  if (!existsSync(filePath)) return null;

  const raw = readFileSync(filePath, "utf-8");
  const stat = statSync(filePath);

  // Try .json metadata first, fall back to comment headers
  let jsonMeta = loadJsonMetadata(dir, name);
  if (jsonMeta) {
    // System modules: source is the entire file (no header)
    // User modules with .json: source has header that needs stripping
    const isSystemModule = jsonMeta.author === "system";
    const source = isSystemModule ? raw : stripMetadataHeader(raw);
    const currentHash = computeSourceHash(source);

    // Check if we have valid cached metadata
    if (jsonMeta.metadataCache?.extractedFromHash === currentHash) {
      return {
        name,
        description: jsonMeta.description,
        created: stat.birthtime.toISOString(),
        modified: stat.mtime.toISOString(),
        sizeBytes: source.length,
        source,
        exports: jsonMeta.metadataCache.exports,
        classes: jsonMeta.metadataCache.classes,
        mutable: jsonMeta.mutable,
        author: jsonMeta.author,
        ...(jsonMeta.metadataCache.hints
          ? { hints: jsonMeta.metadataCache.hints }
          : {}),
        ...(jsonMeta.hints ? { structuredHints: jsonMeta.hints } : {}),
        ...(jsonMeta.importStyle ? { importStyle: jsonMeta.importStyle } : {}),
      };
    }

    // Cache miss - extract via Rust and update cache
    const { exports, classes, hints } = await extractMetadata(source);
    jsonMeta.metadataCache = {
      extractedFromHash: currentHash,
      exports,
      classes,
      ...(hints ? { hints } : {}),
    };
    // Also update sourceHash to match current source (in case builtin was updated)
    // Use truncated hash format (first 16 hex chars) to match build:modules format
    jsonMeta.sourceHash = currentHash.slice(0, 23); // "sha256:" + 16 hex chars
    saveJsonMetadata(dir, name, jsonMeta);

    return {
      name,
      description: jsonMeta.description,
      created: stat.birthtime.toISOString(),
      modified: stat.mtime.toISOString(),
      sizeBytes: source.length,
      source,
      exports,
      classes,
      mutable: jsonMeta.mutable,
      author: jsonMeta.author,
      ...(hints ? { hints } : {}),
      ...(jsonMeta.hints ? { structuredHints: jsonMeta.hints } : {}),
      ...(jsonMeta.importStyle ? { importStyle: jsonMeta.importStyle } : {}),
    };
  }

  // User module without .json: parse comment headers and strip them from source
  const meta = parseMetadata(raw);
  const source = stripMetadataHeader(raw);
  const currentHash = computeSourceHash(source);
  const { exports, classes, hints } = await extractMetadata(source);

  // Create .json file with cache for user modules too
  const newJsonMeta: ModuleJsonMeta = {
    name,
    description: meta.description ?? "",
    author: (meta.author as "system" | "user") ?? "user",
    mutable: meta.mutable !== "false",
    metadataCache: {
      extractedFromHash: currentHash,
      exports,
      classes,
      ...(hints ? { hints } : {}),
    },
  };
  saveJsonMetadata(dir, name, newJsonMeta);

  return {
    name,
    description: meta.description ?? "",
    created: meta.created ?? stat.birthtime.toISOString(),
    modified: meta.modified ?? stat.mtime.toISOString(),
    sizeBytes: source.length,
    source,
    exports,
    classes,
    mutable: meta.mutable !== "false",
    author: (meta.author as "system" | "user") ?? "user",
    ...(hints ? { hints } : {}),
  };
}

/**
 * List all modules from disk.
 * Returns ModuleInfo for each .js file in the modules directory,
 * plus native Rust modules that have .json metadata but no .js file
 * (html, markdown, image, ziplib — compiled into the Hyperlight runtime).
 */
export function listModules(): ModuleInfo[] {
  const dir = getModulesDir();
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .sort();
  const modules: ModuleInfo[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    const name = basename(file, ".js");
    const info = loadModule(name);
    if (info) {
      modules.push(info);
      seen.add(name);
    }
  }

  // Include native Rust modules that have .json metadata but no .js file.
  // These are compiled into the Hyperlight runtime (html, markdown, image, ziplib).
  const jsonFiles = readdirSync(dir).filter((f) => f.endsWith(".json"));
  for (const jsonFile of jsonFiles) {
    const name = basename(jsonFile, ".json");
    if (seen.has(name)) continue; // already loaded from .js
    const jsonMeta = loadJsonMetadata(dir, name);
    if (jsonMeta && jsonMeta.type === "native") {
      // Load .d.ts for exports if available
      const dtsPath = join(dir, `${name}.d.ts`);
      let exports: ExportInfo[] = [];
      if (existsSync(dtsPath)) {
        const dtsContent = readFileSync(dtsPath, "utf-8");
        // Parse function names from .d.ts: export declare function foo(...)
        const fns = [
          ...dtsContent.matchAll(/export\s+declare\s+function\s+(\w+)/g),
        ];
        exports = fns.map((m) => ({
          name: m[1],
          kind: "function" as const,
        }));
      }
      modules.push({
        name,
        description: jsonMeta.description,
        created: "",
        modified: "",
        sizeBytes: 0,
        source: "", // native — no JS source
        exports,
        classes: [],
        mutable: false,
        author: "system" as const,
        ...(jsonMeta.hints ? { structuredHints: jsonMeta.hints } : {}),
        ...(jsonMeta.importStyle
          ? { importStyle: jsonMeta.importStyle as "named" | "namespace" }
          : {}),
      });
    }
  }

  return modules;
}

/**
 * Delete a module from disk.
 * Refuses to delete system modules.
 *
 * @returns true if deleted, false if not found
 * @throws If module is a system module
 */
export function deleteModuleFromDisk(name: string): boolean {
  const dir = getModulesDir();
  const filePath = join(dir, `${name}.js`);
  if (!existsSync(filePath)) return false;

  // Check if system module via .json file first, then comment headers
  const jsonMeta = loadJsonMetadata(dir, name);
  if (jsonMeta?.author === "system") {
    throw new Error(
      `Module "${name}" is a system module and cannot be deleted`,
    );
  }

  // Fall back to checking comment headers for legacy modules
  if (!jsonMeta) {
    const raw = readFileSync(filePath, "utf-8");
    const meta = parseMetadata(raw);
    if (meta.author === "system") {
      throw new Error(
        `Module "${name}" is a system module and cannot be deleted`,
      );
    }
  }

  unlinkSync(filePath);
  // Also clean up companion files (.json metadata, .d.ts declarations)
  const jsonPath = join(dir, `${name}.json`);
  if (existsSync(jsonPath)) unlinkSync(jsonPath);
  const dtsPath = join(dir, `${name}.d.ts`);
  if (existsSync(dtsPath)) unlinkSync(dtsPath);
  return true;
}

/**
 * Set the mutable flag on a module (lock/unlock).
 * System modules cannot be unlocked.
 *
 * @returns Updated ModuleInfo
 * @throws If module not found or is a system module
 */
export async function setModuleMutable(
  name: string,
  mutable: boolean,
): Promise<ModuleInfo> {
  const info = loadModule(name);
  if (!info) throw new Error(`Module "${name}" not found`);
  if (info.author === "system" && mutable) {
    throw new Error(`System module "${name}" cannot be unlocked`);
  }

  // Re-save with updated mutable flag
  return await saveModule(name, info.source, info.description, {
    author: info.author,
    mutable,
  });
}

/**
 * Find modules that export functions with similar names.
 * Used for duplicate detection when registering new modules.
 *
 * @param exportNames — Export names to check for overlap
 * @param excludeModule — Module name to exclude from the check
 * @returns Array of {moduleName, overlappingExports} for modules with overlap
 */
export function findOverlappingExports(
  exportNames: string[],
  excludeModule?: string,
): Array<{ moduleName: string; overlappingExports: string[] }> {
  const modules = listModules();
  const results: Array<{ moduleName: string; overlappingExports: string[] }> =
    [];

  for (const mod of modules) {
    if (mod.name === excludeModule) continue;
    const modExportNames = mod.exports.map((e) => e.name);
    const overlap = exportNames.filter((n) => modExportNames.includes(n));
    if (overlap.length > 0) {
      results.push({ moduleName: mod.name, overlappingExports: overlap });
    }
  }

  return results;
}
