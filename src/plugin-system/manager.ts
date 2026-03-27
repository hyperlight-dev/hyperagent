// ── Plugin Manager ───────────────────────────────────────────────────
//
// Discovery, loading, static scanning, configuration, and lifecycle
// management for plugins. Plugins extend the Hyperlight sandbox with
// host functions that guest JavaScript can import via "host:<module>".
//
// ─────────────────────────────────────────────────────────────────────

import {
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import * as readline from "node:readline/promises";

import type {
  PluginManifest,
  PluginConfig,
  Plugin,
  AuditResult,
  AuditFinding,
  FindingSeverity,
  ConfigSchemaEntry,
  ApprovalRecord,
  ApprovalStore,
  RiskLevel,
  OperatorConfig,
  ConfigSchema,
} from "./types.js";
import { RISK_LEVEL_ORDER, DEFAULT_OPERATOR_CONFIG } from "./types.js";
import {
  extractPluginMetadata,
  isAnalysisGuestEnabled,
} from "../agent/analysis-guest.js";

// Re-export types for consumers
export type {
  Plugin,
  PluginManifest,
  PluginConfig,
  AuditResult,
  AuditFinding,
  ApprovalRecord,
  OperatorConfig,
};

// ── Static Scan Patterns ─────────────────────────────────────────────
//
// Regex patterns for detecting potentially dangerous APIs in plugin
// source code. Each pattern has a severity and explanation.

interface ScanPattern {
  pattern: RegExp;
  severity: FindingSeverity;
  message: string;
}

/**
 * Static scan patterns — ordered from most to least dangerous.
 * Applied line-by-line against plugin source code.
 */
const SCAN_PATTERNS: readonly ScanPattern[] = Object.freeze([
  // ── Process execution (DANGER) ───────────────────────────────
  //
  // The `child_process` literal catches imports/requires of the module.
  // We match `.spawn(`, `.fork(`, `.execFile(`, `.execSync(`, and
  // `.execFileSync(` directly. Bare `.exec(` is intentionally excluded
  // because it false-positives on `RegExp.prototype.exec()` — and any
  // real child_process.exec() usage is already caught by the
  // `child_process` literal on the import/require line.
  {
    pattern:
      /child_process|\.execFile\s*\(|\.execSync\s*\(|\.execFileSync\s*\(|\.spawn\s*\(|\.spawnSync\s*\(|\.fork\s*\(/,
    severity: "danger",
    message: "Process execution — can run arbitrary commands on the host",
  },
  {
    pattern: /\beval\s*\(|new\s+Function\s*\(/,
    severity: "danger",
    message: "Dynamic code execution — eval() or Function constructor",
  },
  // ── Filesystem access (WARNING) ──────────────────────────────
  {
    pattern: /require\s*\(\s*['"]fs['"]\s*\)|from\s+['"]fs['"]/,
    severity: "warning",
    message: "Direct filesystem access via Node.js fs module",
  },
  {
    pattern: /require\s*\(\s*['"]node:fs['"]\s*\)|from\s+['"]node:fs['"]/,
    severity: "warning",
    message: "Direct filesystem access via Node.js node:fs module",
  },
  // ── Network access (WARNING) ─────────────────────────────────
  {
    pattern:
      /require\s*\(\s*['"](?:net|http|https|dgram)['"]\s*\)|from\s+['"](?:net|http|https|dgram)['"]/,
    severity: "warning",
    message: "Network access — net, http, https, or dgram module",
  },
  {
    pattern: /\bfetch\s*\(/,
    severity: "warning",
    message: "Network access via fetch()",
  },
  // ── Environment / global access (WARNING) ─────────────────────
  {
    pattern: /process\.env/,
    severity: "warning",
    message: "Reads host environment variables",
  },
  {
    pattern: /\bglobalThis\b.*=|global\s*\[|global\.\w+\s*=/,
    severity: "warning",
    message: "Modifies global scope",
  },
  // ── Informational ────────────────────────────────────────────
  {
    pattern: /\b__dirname\b|\b__filename\b/,
    severity: "info",
    message: "References host path variables (__dirname / __filename)",
  },
  {
    pattern: /path\.(resolve|join|dirname|basename)\s*\(/,
    severity: "info",
    message: "Uses path manipulation functions",
  },
  // ── Security mitigations (positive indicators) ───────────────
  //
  // These detect when a plugin implements security measures like
  // path-jailing, size caps, or allowlists. Show up as info-level
  // findings so the user sees the full picture — not just the scary
  // bits.
  {
    pattern:
      /realpathSync\s*\(|realpathSync\b|lstatSync\s*\(|isSymbolicLink\s*\(/,
    severity: "info",
    message:
      "🛡️ Symlink detection — checks or rejects symlinks to prevent escapes",
  },
  {
    pattern: /\.startsWith\s*\(\s*['"]\.\.['"]/,
    severity: "info",
    message:
      "🛡️ Path traversal guard — rejects attempts to escape allowed directories",
  },
  {
    pattern:
      /allowedPaths|basePaths|writePaths|allowedDirs|resolvedBases|baseDir|resolvedBase/,
    severity: "info",
    message: "🛡️ Directory allowlist — filesystem access is explicitly scoped",
  },
  {
    pattern: /\.size\s*>|maxFileSize|maxWriteSize|maxFileBytes|maxWriteBytes/,
    severity: "info",
    message: "🛡️ File size cap — prevents memory exhaustion attacks",
  },
  {
    pattern: /allowWrites\b|config\.allowWrites|\ballowWrites\s*[!=]/,
    severity: "info",
    message: "🛡️ Write operations gated behind explicit opt-in flag",
  },
  {
    pattern: /\.startsWith\s*\(\s*['"]\./,
    severity: "info",
    message: "🛡️ Dotfile / path-component guard — blocks dotfiles or traversal",
  },
]);

// ── Manifest Validation ──────────────────────────────────────────────

/** Required top-level fields in plugin.json. */
const REQUIRED_MANIFEST_FIELDS: readonly (keyof PluginManifest)[] = [
  "name",
  "version",
  "description",
  "hostModules",
];

/**
 * Validate a parsed plugin.json manifest. Returns an array of error
 * messages — empty array means the manifest is valid.
 */
export function validateManifest(raw: unknown): string[] {
  const errors: string[] = [];

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return ["plugin.json must be a JSON object"];
  }

  const obj = raw as Record<string, unknown>;

  // Check required fields
  for (const field of REQUIRED_MANIFEST_FIELDS) {
    if (!(field in obj)) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  // Type checks for present fields
  if ("name" in obj && typeof obj.name !== "string") {
    errors.push("name must be a string");
  }
  if ("version" in obj && typeof obj.version !== "string") {
    errors.push("version must be a string");
  }
  if (
    "version" in obj &&
    typeof obj.version === "string" &&
    /^v/i.test(obj.version)
  ) {
    // Callers prepend "v" for display — a prefixed version causes "vv1.0.0"
    errors.push(
      'version must not start with "v" (use bare semver, e.g. "1.0.0")',
    );
  }
  if ("description" in obj && typeof obj.description !== "string") {
    errors.push("description must be a string");
  }
  // systemMessage is now optional (extracted from _HINTS in index.ts)
  if ("systemMessage" in obj && typeof obj.systemMessage !== "string") {
    errors.push("systemMessage must be a string if present");
  }

  // hostModules must be a non-empty string array
  if ("hostModules" in obj) {
    if (!Array.isArray(obj.hostModules)) {
      errors.push("hostModules must be an array");
    } else if (obj.hostModules.length === 0) {
      errors.push("hostModules must not be empty");
    } else if (!obj.hostModules.every((m: unknown) => typeof m === "string")) {
      errors.push("hostModules must contain only strings");
    }
  }

  // configSchema is optional but must be an object if present
  if ("configSchema" in obj && obj.configSchema !== undefined) {
    if (
      typeof obj.configSchema !== "object" ||
      obj.configSchema === null ||
      Array.isArray(obj.configSchema)
    ) {
      errors.push("configSchema must be an object");
    }
  }

  return errors;
}

// ── Static Scanner ───────────────────────────────────────────────────

/**
 * Run a static scan over plugin source code. Returns findings sorted
 * by severity (danger → warning → info).
 *
 * This is a quick heuristic pass — it catches obvious dangerous
 * patterns but can't understand intent. That's what the LLM auditor
 * is for.
 */
export function staticScan(source: string): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const lines = source.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip comment-only lines (single-line // and block /* */)
    const trimmed = line.trim();
    if (
      trimmed.startsWith("//") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("/*")
    ) {
      continue;
    }

    for (const { pattern, severity, message } of SCAN_PATTERNS) {
      if (pattern.test(line)) {
        findings.push({ severity, message, line: i + 1 });
      }
    }
  }

  // Sort: danger first, then warning, then info
  const severityOrder: Record<FindingSeverity, number> = {
    danger: 0,
    warning: 1,
    info: 2,
  };
  findings.sort(
    (a, b) => severityOrder[a.severity] - severityOrder[b.severity],
  );

  return findings;
}

// ── Hash Computation ─────────────────────────────────────────────────

/**
 * Compute SHA-256 hash of a string. Used as the audit cache key
 * and approval fingerprint.
 */
export function contentHash(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

/**
 * Resolve the source file for a plugin directory.
 *
 * In dev mode (source repo), prefers .ts so edits are reflected immediately
 * without a rebuild. Under node_modules (npm install / bundled binary),
 * Node.js refuses to strip types from .ts files, so we always use .js.
 */
export function resolvePluginSource(pluginDir: string): string {
  const tsPath = join(pluginDir, "index.ts");
  const jsPath = join(pluginDir, "index.js");

  // Under node_modules, Node.js can't type-strip .ts — always use .js.
  // Use path-segment check to avoid false positives on dirs named "node_modules_foo".
  const underNodeModules =
    /[\\/]node_modules[\\/]/.test(pluginDir) ||
    pluginDir.startsWith("node_modules/");
  return underNodeModules ? jsPath : existsSync(tsPath) ? tsPath : jsPath;
}

/**
 * Compute combined hash of plugin source and manifest.
 * Used for approval fingerprint and tamper detection.
 * Any change to either file invalidates the approval.
 *
 * Note: approvals are scoped to the install context. A plugin approved
 * in dev (from .ts) must be re-approved when loaded from node_modules
 * (.js), since the source content differs. This is intentional —
 * the compiled output should be verified independently.
 */
export function computePluginHash(pluginDir: string): string | null {
  const sourcePath = resolvePluginSource(pluginDir);
  const jsonPath = join(pluginDir, "plugin.json");

  try {
    const sourceContent = readFileSync(sourcePath, "utf8");
    const jsonContent = readFileSync(jsonPath, "utf8");

    // Hash both files together — any change invalidates
    return createHash("sha256")
      .update(sourceContent, "utf8")
      .update(jsonContent, "utf8")
      .digest("hex");
  } catch {
    return null;
  }
}

// ── Approval Store Persistence ───────────────────────────────────────
//
// Approvals are persisted to ~/.hyperagent/approved-plugins.json.
// This survives process restarts. Approvals are keyed by plugin name
// and invalidated automatically when the source content hash changes.

/** Directory for persistent approval data. */
const APPROVAL_DIR = join(homedir(), ".hyperagent");

/** Path to the approval store JSON file. */
const APPROVAL_FILE = join(APPROVAL_DIR, "approved-plugins.json");

/**
 * Load the approval store from disk.
 * Returns an empty store if the file doesn't exist or is invalid.
 */
export function loadApprovalStore(): ApprovalStore {
  try {
    if (!existsSync(APPROVAL_FILE)) return {};
    const raw = readFileSync(APPROVAL_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {};
    }
    return parsed as ApprovalStore;
  } catch {
    return {};
  }
}

/**
 * Save the approval store to disk. Creates the directory if needed.
 * Failures are logged but do not throw — approval is best-effort.
 */
export function saveApprovalStore(store: ApprovalStore): void {
  try {
    if (!existsSync(APPROVAL_DIR)) {
      // 0o700 — owner-only access to the approval directory.
      // Contains security-sensitive approval hashes.
      mkdirSync(APPROVAL_DIR, { recursive: true, mode: 0o700 });
    }
    // 0o600 — owner read/write only. Prevents other users on
    // multi-user hosts from reading or tampering with approvals.
    writeFileSync(APPROVAL_FILE, JSON.stringify(store, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch (err) {
    console.error(
      `[plugins] Warning: failed to save approval store: ${(err as Error).message}`,
    );
  }
}

// ── Operator Config ───────────────────────────────────────────────────
//
// Security policy loaded from ~/.hyperagent/config.json.
// Controls what risk levels the operator is willing to accept.

/** Path to the operator config file. */
const CONFIG_FILE = join(APPROVAL_DIR, "config.json");

/**
 * Load operator config from disk. Returns defaults for missing
 * or invalid files. Validates that maxRiskLevel is a known value.
 * Creates a default config file on first run so operators can
 * discover and customise the available settings.
 */
export function loadOperatorConfig(): OperatorConfig {
  try {
    if (!existsSync(CONFIG_FILE)) {
      // First run — create a well-documented default config so operators
      // know what settings are available without reading the source.
      const defaults = { ...DEFAULT_OPERATOR_CONFIG };
      mkdirSync(APPROVAL_DIR, { recursive: true, mode: 0o700 });
      writeFileSync(CONFIG_FILE, JSON.stringify(defaults, null, 2) + "\n", {
        encoding: "utf8",
        mode: 0o600,
      });
      return defaults;
    }
    const raw = readFileSync(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return { ...DEFAULT_OPERATOR_CONFIG };
    }
    const config: OperatorConfig = { ...DEFAULT_OPERATOR_CONFIG };
    if (
      typeof parsed.maxRiskLevel === "string" &&
      RISK_LEVEL_ORDER.includes(parsed.maxRiskLevel as RiskLevel)
    ) {
      config.maxRiskLevel = parsed.maxRiskLevel as RiskLevel;
    }
    // Audit log size limit (megabytes).  0 = disabled, negative = default.
    if (
      Number.isFinite(parsed.maxAuditLogSizeMb) &&
      parsed.maxAuditLogSizeMb >= 0
    ) {
      config.maxAuditLogSizeMb = parsed.maxAuditLogSizeMb;
    }
    return config;
  } catch {
    return { ...DEFAULT_OPERATOR_CONFIG };
  }
}

/**
 * Check if a risk level exceeds the operator's configured threshold.
 * Returns true if the risk is ABOVE the maximum allowed level.
 *
 * @param riskLevel - The plugin's assessed risk level
 * @param maxRisk - The operator's maximum allowed risk level
 * @returns true if the plugin should be blocked
 */
export function exceedsRiskThreshold(
  riskLevel: RiskLevel,
  maxRisk: RiskLevel,
): boolean {
  return (
    RISK_LEVEL_ORDER.indexOf(riskLevel) > RISK_LEVEL_ORDER.indexOf(maxRisk)
  );
}

// ── Inline Config Parsing ────────────────────────────────────────────

/**
 * Parse key=value pairs from command arguments.
 * e.g. ["baseDir=/tmp", "maxFileSize=2048", "allowWrites=true"]
 *
 * Values are kept as strings — type coercion happens when merged
 * with the config schema during enable.
 */
export function parseInlineConfig(args: string[]): Record<string, string> {
  const config: Record<string, string> = {};
  for (const arg of args) {
    const eqIdx = arg.indexOf("=");
    if (eqIdx > 0) {
      const key = arg.slice(0, eqIdx).trim();
      const value = arg.slice(eqIdx + 1).trim();
      if (key) config[key] = value;
    }
  }
  return config;
}

/**
 * Coerce an inline string value to the correct type based on the
 * config schema entry. Used when merging inline config overrides.
 */
export function coerceConfigValue(
  value: string,
  entry: ConfigSchemaEntry,
): string | number | boolean | string[] {
  switch (entry.type) {
    case "boolean":
      return (
        value.toLowerCase() === "yes" ||
        value.toLowerCase() === "true" ||
        value.toLowerCase() === "y" ||
        value === "1"
      );
    case "number": {
      const n = Number(value);
      if (!Number.isFinite(n)) {
        console.error(
          `    ⚠️  Invalid number "${value}" for ${entry.description}, using default`,
        );
        return (entry.default as number) ?? 0;
      }
      return n;
    }
    case "array": {
      // Strip optional surrounding brackets so users can write
      // key=[a,b,c] or key=a,b,c — both produce ['a','b','c'].
      let raw = value;
      if (raw.startsWith("[") && raw.endsWith("]")) {
        raw = raw.slice(1, -1);
      }
      return raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
    case "string":
    default:
      return value;
  }
}

// ── Plugin Manager ───────────────────────────────────────────────────

/**
 * Create a new PluginManager instance. Manages plugin discovery,
 * auditing, configuration, and lifecycle.
 *
 * @param pluginsDir — absolute path to the plugins/ directory
 */
export function createPluginManager(pluginsDir: string) {
  /** All discovered plugins, keyed by name. */
  const plugins = new Map<string, Plugin>();

  /** Audit cache — keyed by SHA-256 of source, avoids redundant LLM calls. */
  const auditCache = new Map<string, AuditResult>();

  /** Persisted approval store — loaded from disk on creation. */
  const approvalStore: ApprovalStore = loadApprovalStore();

  /** Dirty flag — set when plugin state changes require sandbox rebuild. */
  let sandboxDirty = false;

  /** Dirty flag — set when system message needs updating (new session). */
  let sessionDirty = false;

  // ── Discovery ────────────────────────────────────────────────

  /**
   * Scan the plugins directory for valid plugin.json manifests.
   * Returns the number of plugins discovered.
   *
   * Non-destructive — preserves state of already-discovered plugins
   * that haven't changed. New directories are added, removed
   * directories are cleaned up.
   */
  function discover(): number {
    if (!existsSync(pluginsDir)) {
      return 0;
    }

    const stat = statSync(pluginsDir);
    if (!stat.isDirectory()) {
      return 0;
    }

    // Track which plugins we find this scan
    const foundNames = new Set<string>();

    const entries = readdirSync(pluginsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const manifestPath = join(pluginsDir, entry.name, "plugin.json");
      if (!existsSync(manifestPath)) continue;

      // Parse and validate manifest
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(manifestPath, "utf8"));
      } catch {
        console.error(`[plugins] Warning: invalid JSON in ${manifestPath}`);
        continue;
      }

      const errors = validateManifest(raw);
      if (errors.length > 0) {
        console.error(`[plugins] Warning: invalid manifest ${manifestPath}:`);
        for (const err of errors) {
          console.error(`  • ${err}`);
        }
        continue;
      }

      const manifest = raw as PluginManifest;
      // Ensure configSchema exists (optional in manifest)
      if (!manifest.configSchema) {
        manifest.configSchema = {};
      }

      foundNames.add(manifest.name);

      // If already discovered with same name, keep existing state
      if (plugins.has(manifest.name)) {
        // Update manifest in case it changed on disk
        const existing = plugins.get(manifest.name)!;
        existing.manifest = manifest;
        existing.dir = resolve(pluginsDir, entry.name);
        continue;
      }

      // New plugin — create record with null schema/hints (loaded later)
      plugins.set(manifest.name, {
        manifest,
        dir: resolve(pluginsDir, entry.name),
        state: "discovered",
        config: {},
        audit: null,
        source: null,
        approved: false,
        schema: null,
        hints: null,
        promptKeys: null,
      });
    }

    // Remove plugins that are no longer on disk (but not enabled ones)
    for (const [name, plugin] of plugins) {
      if (!foundNames.has(name) && plugin.state !== "enabled") {
        plugins.delete(name);
      }
    }

    // Refresh approval status for all plugins — checks content hashes
    refreshAllApprovals();

    return plugins.size;
  }

  // ── Source Loading ────────────────────────────────────────────

  /**
   * Load the source code of a plugin for auditing.
   * Resolves .ts (dev) or .js (npm/dist) via resolvePluginSource().
   * Returns the source string, or null if the file doesn't exist.
   */
  function loadSource(name: string): string | null {
    const plugin = plugins.get(name);
    if (!plugin) return null;

    const indexPath = resolvePluginSource(plugin.dir);
    if (!existsSync(indexPath)) {
      console.error(`[plugins] Warning: ${indexPath} not found`);
      return null;
    }

    try {
      const source = readFileSync(indexPath, "utf8");
      plugin.source = source;
      return source;
    } catch (err) {
      console.error(
        `[plugins] Warning: failed to read ${name} source: ${(err as Error).message}`,
      );
      return null;
    }
  }

  // ── Schema & Hints Extraction ─────────────────────────────────

  /**
   * Extract schema and hints from plugin TypeScript source.
   * Uses the Rust analysis guest for safe parsing (no code execution).
   *
   * Falls back to manifest.configSchema and manifest.systemMessage
   * for legacy plugins that don't have SCHEMA/_HINTS exports.
   *
   * @returns true if extraction succeeded, false on error
   */
  async function extractSchemaAndHints(name: string): Promise<boolean> {
    const plugin = plugins.get(name);
    if (!plugin) return false;

    // For schema extraction, prefer .ts source — it's the canonical
    // schema definition and the Rust parser handles it best. Under
    // node_modules, only .js exists so we fall back gracefully.
    // try/catch guards against TOCTOU (file deleted between exists check and read).
    const tsPath = join(plugin.dir, "index.ts");
    let extractionSource: string | null = null;
    if (existsSync(tsPath)) {
      try {
        extractionSource = readFileSync(tsPath, "utf8");
      } catch {
        // Fall through to plugin.source / loadSource
      }
    }
    if (!extractionSource) {
      extractionSource = plugin.source ?? loadSource(name);
    }
    if (!extractionSource) return false;

    // Also ensure plugin.source is loaded for hash verification
    if (!plugin.source) {
      if (!loadSource(name)) return false;
    }

    // If analysis guest is not enabled, fall back to manifest.
    // This path should never be reached — the agent exits on startup
    // if the analysis guest is unavailable.
    if (!isAnalysisGuestEnabled()) {
      plugin.schema = convertManifestSchema(plugin.manifest.configSchema);
      plugin.hints = plugin.manifest.systemMessage ?? null;
      plugin.promptKeys = plugin.manifest.promptKeys ?? null;
      return true;
    }

    try {
      const metadata = await extractPluginMetadata(extractionSource);

      // Use extracted schema or fall back to manifest
      if (metadata.schema) {
        plugin.schema = metadata.schema as ConfigSchema;
        // Derive promptKeys from schema fields with promptKey: true
        plugin.promptKeys = Object.entries(metadata.schema)
          .filter(([, field]) => (field as { promptKey?: boolean }).promptKey)
          .map(([key]) => key);
      } else {
        plugin.schema = convertManifestSchema(plugin.manifest.configSchema);
        plugin.promptKeys = plugin.manifest.promptKeys ?? null;
      }

      // Use extracted hints or fall back to manifest systemMessage
      plugin.hints = metadata.hints ?? plugin.manifest.systemMessage ?? null;

      return true;
    } catch (err) {
      console.error(
        `[plugins] Warning: failed to extract schema from ${name}: ${(err as Error).message}`,
      );
      // Fall back to manifest
      plugin.schema = convertManifestSchema(plugin.manifest.configSchema);
      plugin.hints = plugin.manifest.systemMessage ?? null;
      plugin.promptKeys = plugin.manifest.promptKeys ?? null;
      return true;
    }
  }

  /**
   * Convert legacy manifest configSchema to the new ConfigSchema format.
   */
  function convertManifestSchema(
    manifestSchema: Record<string, ConfigSchemaEntry> | undefined,
  ): ConfigSchema | null {
    if (!manifestSchema || Object.keys(manifestSchema).length === 0) {
      return null;
    }
    // The formats are compatible, just need to cast
    return manifestSchema as unknown as ConfigSchema;
  }

  // ── Audit Integration ────────────────────────────────────────

  /**
   * Run a static scan on a plugin and store the results.
   * Returns the findings array. Does NOT run the LLM auditor —
   * call setAuditResult() separately after the LLM pass.
   */
  function runStaticScan(name: string): AuditFinding[] {
    const plugin = plugins.get(name);
    if (!plugin) return [];

    // Load source if not already loaded
    if (!plugin.source) {
      const source = loadSource(name);
      if (!source) return [];
    }

    return staticScan(plugin.source!);
  }

  /**
   * Set the complete audit result (static + LLM) for a plugin.
   * Transitions the plugin to 'audited' state.
   */
  function setAuditResult(name: string, result: AuditResult): void {
    const plugin = plugins.get(name);
    if (!plugin) return;

    plugin.audit = result;
    if (plugin.state === "discovered") {
      plugin.state = "audited";
    }

    // Cache by content hash
    auditCache.set(result.contentHash, result);
  }

  /**
   * Check if we have a cached audit for the given source content.
   */
  function getCachedAudit(source: string): AuditResult | null {
    const hash = contentHash(source);
    return auditCache.get(hash) ?? null;
  }

  // ── Approval Management ──────────────────────────────────────
  //
  // Approval is a long-lived trust decision, persisted to disk.
  // It is keyed by plugin name and content hash — if the source
  // changes, the approval is automatically void. Enablement is
  // session-scoped and NOT persisted.

  /**
   * Approve a plugin. Requires an existing audit result.
   * Persists the approval to disk immediately.
   *
   * Uses combined hash (plugin source + plugin.json) for tamper detection.
   *
   * @returns true if approved, false if plugin not found or not audited
   */
  function approve(name: string): boolean {
    const plugin = plugins.get(name);
    if (!plugin) return false;
    if (!plugin.audit) return false;

    // Compute combined hash of both files
    const hash = computePluginHash(plugin.dir);
    if (!hash) return false;

    const record: ApprovalRecord = {
      contentHash: hash,
      approvedAt: new Date().toISOString(),
      auditRiskLevel: plugin.audit.riskLevel,
      auditVerdict: plugin.audit.recommendation.verdict,
    };

    approvalStore[name] = record;
    saveApprovalStore(approvalStore);
    plugin.approved = true;
    return true;
  }

  /**
   * Remove approval for a plugin.
   * If the plugin is currently enabled, it stays enabled for this
   * session — but won't get the fast-path on the next session.
   *
   * @returns true if unapproved, false if not found or not approved
   */
  function unapprove(name: string): boolean {
    const plugin = plugins.get(name);
    if (!plugin) return false;

    if (!(name in approvalStore)) return false;

    delete approvalStore[name];
    saveApprovalStore(approvalStore);
    plugin.approved = false;
    return true;
  }

  /**
   * Check if a plugin has a valid, current approval.
   * Compares the stored content hash against combined hash (plugin source + plugin.json).
   */
  function isApproved(name: string): boolean {
    const plugin = plugins.get(name);
    if (!plugin) return false;

    const record = approvalStore[name];
    if (!record) return false;

    // Compute combined hash to verify approval
    const currentHash = computePluginHash(plugin.dir);
    if (!currentHash) return false;

    return record.contentHash === currentHash;
  }

  /**
   * Refresh the `approved` flag on all plugins based on the
   * persisted approval store and current combined hash (plugin source + plugin.json).
   * Called after discover() to sync runtime flags with disk state.
   */
  function refreshAllApprovals(): void {
    for (const [name, plugin] of plugins) {
      const record = approvalStore[name];
      if (!record) {
        plugin.approved = false;
        continue;
      }

      // Compute combined hash to verify approval
      const currentHash = computePluginHash(plugin.dir);
      if (!currentHash) {
        plugin.approved = false;
        continue;
      }

      plugin.approved = record.contentHash === currentHash;
    }
  }

  /**
   * Get the approval record for a plugin, if one exists.
   */
  function getApprovalRecord(name: string): ApprovalRecord | undefined {
    return approvalStore[name];
  }

  /**
   * Apply inline config overrides to a plugin, coercing values
   * based on the config schema. Only sets keys that exist in the
   * schema — unknown keys are silently ignored.
   *
   * Uses plugin.schema (extracted from TypeScript) with fallback
   * to manifest.configSchema for legacy plugins.
   *
   * @returns list of keys that were set
   */
  function applyInlineConfig(
    name: string,
    inlineConfig: Record<string, string>,
  ): string[] {
    const plugin = plugins.get(name);
    if (!plugin) return [];

    // Use extracted schema or fall back to manifest
    const schema =
      plugin.schema ?? plugin.manifest.configSchema ?? ({} as ConfigSchema);
    const applied: string[] = [];

    for (const [key, rawValue] of Object.entries(inlineConfig)) {
      const entry = schema[key];
      if (!entry) continue; // Ignore unknown keys
      plugin.config[key] = coerceConfigValue(
        rawValue,
        entry as ConfigSchemaEntry,
      );
      applied.push(key);
    }

    return applied;
  }

  // ── Configuration ────────────────────────────────────────────

  /**
   * Interactively prompt the user for plugin configuration values
   * based on the plugin's config schema.
   *
   * Uses plugin.schema (extracted from TypeScript) with fallback
   * to manifest.configSchema for legacy plugins.
   *
   * If promptKeys is defined, only those keys are prompted
   * interactively — all other fields with defaults are applied
   * silently. This avoids config fatigue for plugins with many
   * tuneable fields (e.g. 17-field fetch vs 2-field fs-read).
   *
   * @param rl — readline interface for user input
   * @param name — plugin name
   * @param skipKeys — keys to skip (already provided via inline config)
   * @returns resolved config, or null if plugin not found
   */
  async function promptConfig(
    rl: readline.Interface,
    name: string,
    skipKeys?: ReadonlySet<string>,
    autoApprove?: boolean,
  ): Promise<PluginConfig | null> {
    const plugin = plugins.get(name);
    if (!plugin) return null;

    // Use extracted schema or fall back to manifest
    const schema =
      plugin.schema ?? plugin.manifest.configSchema ?? ({} as ConfigSchema);
    const config: PluginConfig = { ...plugin.config };

    // Use extracted promptKeys or fall back to manifest
    const promptKeysArr = plugin.promptKeys ?? plugin.manifest.promptKeys;
    const promptSet = promptKeysArr ? new Set(promptKeysArr) : null;

    for (const [key, entry] of Object.entries(schema)) {
      if (skipKeys?.has(key)) continue;

      // If promptKeys is defined, only prompt essential fields.
      // Fields NOT in promptSet get their default silently.
      if (promptSet && !promptSet.has(key)) {
        if (entry.default !== undefined) {
          config[key] = entry.default;
          continue;
        }
        // No default AND not in promptKeys — still must prompt
        // (safety: required fields without defaults always prompt)
      }

      const value = await promptSingleField(
        rl,
        key,
        entry as ConfigSchemaEntry,
        autoApprove,
      );
      config[key] = value;
    }

    // Silent fields are shown in the final config summary, not here

    plugin.config = config;
    if (plugin.state === "audited" || plugin.state === "discovered") {
      plugin.state = "configured";
    }

    return config;
  }

  /**
   * Set plugin config programmatically (for testing or non-interactive use).
   */
  function setConfig(name: string, config: PluginConfig): boolean {
    const plugin = plugins.get(name);
    if (!plugin) return false;

    plugin.config = config;
    if (plugin.state === "audited" || plugin.state === "discovered") {
      plugin.state = "configured";
    }
    return true;
  }

  /**
   * Format a summary of all config values (prompted and defaulted)
   * for display before final approval.
   */
  function formatConfigSummary(name: string): string[] {
    const plugin = plugins.get(name);
    if (!plugin) return [];

    // Use extracted schema or fall back to manifest
    const schema =
      plugin.schema ?? plugin.manifest.configSchema ?? ({} as ConfigSchema);
    const config = plugin.config;
    const lines: string[] = [];

    for (const [key, entry] of Object.entries(schema)) {
      const value = config[key] ?? entry.default;
      const display = Array.isArray(value)
        ? `[${(value as string[]).join(", ")}]`
        : value === undefined
          ? "(not set)"
          : String(value);

      // Tag to show how this value was set:
      // - If value is explicitly set in config, no tag (it was configured)
      // - If value comes from schema default, tag as "(default)"
      const isFromConfig = key in config && config[key] !== undefined;
      const tag = isFromConfig ? "" : " (default)";

      lines.push(`  ${key}: ${display}${tag}`);
    }

    return lines;
  }

  // ── Enable / Disable ─────────────────────────────────────────

  /**
   * Enable a plugin. Sets dirty flags so the sandbox and session
   * will rebuild on next use.
   *
   * The plugin must have been audited (or at minimum discovered).
   * Configuration is optional — defaults from schema are used
   * for any unconfigured fields.
   */
  function enable(name: string): boolean {
    const plugin = plugins.get(name);
    if (!plugin) return false;

    // Use extracted schema or fall back to manifest
    const schema =
      plugin.schema ?? plugin.manifest.configSchema ?? ({} as ConfigSchema);

    // Apply defaults for any unconfigured fields
    for (const [key, entry] of Object.entries(schema)) {
      if (!(key in plugin.config) && entry.default !== undefined) {
        plugin.config[key] = entry.default;
      }
    }

    plugin.state = "enabled";
    sandboxDirty = true;
    sessionDirty = true;
    return true;
  }

  /**
   * Get companion plugins that need enabling for a given plugin.
   * Returns names of companions that exist but are NOT already enabled.
   * Detects circular dependencies (A→B→A) and skips them.
   *
   * @param name — Plugin name to check companions for
   * @param seen — Set of already-visited names (for circular detection)
   * @returns Array of companion plugin names needing enable
   */
  function getCompanions(
    name: string,
    seen: Set<string> = new Set(),
  ): string[] {
    const plugin = plugins.get(name);
    if (!plugin?.manifest.companions) return [];

    seen.add(name);
    const result: string[] = [];

    for (const companion of plugin.manifest.companions) {
      // Skip circular dependencies
      if (seen.has(companion)) continue;

      // Skip if companion doesn't exist or is already enabled
      const companionPlugin = plugins.get(companion);
      if (!companionPlugin) {
        console.error(
          `[plugins] Warning: companion "${companion}" declared by "${name}" not found`,
        );
        continue;
      }
      if (companionPlugin.state === "enabled") continue;

      result.push(companion);

      // Recursively check the companion's companions
      const nested = getCompanions(companion, seen);
      for (const n of nested) {
        if (!result.includes(n)) result.push(n);
      }
    }

    return result;
  }

  /**
   * Disable an enabled plugin. Sets dirty flags.
   */
  function disable(name: string): boolean {
    const plugin = plugins.get(name);
    if (!plugin || plugin.state !== "enabled") return false;

    plugin.state = "disabled";
    sandboxDirty = true;
    sessionDirty = true;
    return true;
  }

  // ── Accessors ────────────────────────────────────────────────

  /** Get a plugin by name. */
  function getPlugin(name: string): Plugin | undefined {
    return plugins.get(name);
  }

  /** List all discovered plugins. */
  function listPlugins(): Plugin[] {
    return Array.from(plugins.values());
  }

  /** Get only enabled plugins. */
  function getEnabledPlugins(): Plugin[] {
    return Array.from(plugins.values()).filter((p) => p.state === "enabled");
  }

  /**
   * Verify that a plugin's source hasn't changed since it was loaded.
   * Re-reads the source from disk and compares to stored source.
   *
   * @returns true if source matches, false if mismatch or error
   */
  function verifySourceHash(name: string): boolean {
    const plugin = plugins.get(name);
    if (!plugin || !plugin.source) return false;

    const indexPath = resolvePluginSource(plugin.dir);
    try {
      const currentSource = readFileSync(indexPath, "utf8");
      return currentSource === plugin.source;
    } catch {
      return false;
    }
  }

  /**
   * Check if a plugin has any danger-level findings from static analysis.
   * Used as a hard gate before importing plugin code.
   *
   * SECURITY: This prevents the register() function from ever running
   * if the static scanner detected dangerous patterns like eval, require,
   * child_process, etc. This closes GAP 2 (host code execution risk).
   *
   * @returns array of danger-level finding messages, empty if none
   */
  function getDangerFindings(name: string): string[] {
    const plugin = plugins.get(name);
    if (!plugin?.audit?.findings) return [];

    return plugin.audit.findings
      .filter((f) => f.severity === "danger")
      .map((f) => f.message);
  }

  /**
   * Collect system message additions from all enabled plugins.
   * Returns a single string to append to the base system message.
   *
   * Uses plugin.hints (extracted from _HINTS in TypeScript) with
   * fallback to manifest.systemMessage for legacy plugins.
   *
   * A global preamble is auto-injected explaining that guest code
   * runs as a function body and must use require("host:<name>")
   * rather than import — so individual plugins don't need to state this.
   */
  function getSystemMessageAdditions(): string {
    const enabled = getEnabledPlugins();
    const all = listPlugins();

    // Always tell the LLM what plugins exist so it uses the CORRECT
    // names when suggesting /plugin enable commands. Without this,
    // the model hallucinates names like "write-fs" instead of "fs-write".
    let availableSection = "";
    if (all.length > 0) {
      const pluginList = all.map((p) => {
        const status = p.state === "enabled" ? "(enabled)" : "(available)";
        const desc = p.manifest.description ?? "";
        return `- ${p.manifest.name} ${status}${desc ? ` — ${desc}` : ""}`;
      });
      availableSection =
        "\n\n--- Available Plugins ---\n" +
        "These are the EXACT plugin names. Use them verbatim in /plugin enable commands.\n" +
        pluginList.join("\n");
    }

    if (enabled.length === 0) return availableSection;

    // Auto-inject the require-not-import preamble once, so every plugin
    // author doesn't have to repeat it in their systemMessage.
    const moduleNames = enabled.flatMap((p) => p.manifest.hostModules);
    const preamble =
      "\n\n--- Hyperlight Guest Runtime ---\n" +
      "Guest code runs as a **function body** (not an ES module). " +
      'Load host modules with `require("host:<name>")`, NOT `import`. ' +
      `Available host modules: ${moduleNames.map((m) => "`host:" + m + "`").join(", ")}.`;

    const sections = enabled.map((p) => {
      // Prefer structured hints from manifest, then extracted _HINTS, then legacy systemMessage
      let hintsText: string;
      if (p.manifest.hints) {
        // Format structured hints for system message injection
        const h = p.manifest.hints;
        const parts: string[] = [];
        if (h.overview) parts.push(h.overview);
        if (h.criticalRules?.length) {
          parts.push("Critical rules:");
          for (const rule of h.criticalRules) parts.push(`  • ${rule}`);
        }
        if (h.antiPatterns?.length) {
          parts.push("Avoid:");
          for (const ap of h.antiPatterns) parts.push(`  ✗ ${ap}`);
        }
        if (h.commonPatterns?.length) {
          parts.push("Common patterns:");
          for (const cp of h.commonPatterns) parts.push(`  → ${cp}`);
        }
        hintsText = parts.join("\n");
      } else {
        hintsText =
          p.hints ?? p.manifest.systemMessage ?? "(no documentation available)";
      }

      // Start with the hints
      let section = `\n\n--- Plugin: ${p.manifest.name} ---\n${hintsText}`;

      // Use extracted schema or fall back to manifest
      const schema =
        p.schema ?? p.manifest.configSchema ?? ({} as ConfigSchema);

      // Append the active config so the LLM knows actual limits,
      // not just the generic defaults from the manifest description.
      const configEntries = Object.entries(p.config);
      if (configEntries.length > 0) {
        const lines = configEntries.map(([k, v]) => {
          const schemaEntry = schema[k];
          const desc = schemaEntry?.description ?? "";
          const displayVal = Array.isArray(v) ? v.join(", ") : String(v);
          return `- **${k}**: ${displayVal}${desc ? ` — ${desc}` : ""}`;
        });
        section +=
          "\n\n**Active configuration for this session:**\n" + lines.join("\n");
        section +=
          `\n\nIf any of these limits block the user's task, tell them the exact ` +
          `command to reconfigure. Example:\n` +
          `\`/plugin enable ${p.manifest.name} <key>=<new-value>\`\n` +
          `This works even while the plugin is already enabled — it ` +
          `reconfigures in-place. The user can change these settings directly.`;
      }

      return section;
    });
    return availableSection + preamble + sections.join("");
  }

  // ── Dirty Flag Management ────────────────────────────────────

  /**
   * Set the sandbox dirty flag so the sandbox rebuilds
   * on the next message. Used when reconfiguring an
   * already-enabled plugin in-place.
   */
  function markSandboxDirty(): void {
    sandboxDirty = true;
    sessionDirty = true;
  }

  /** Check and clear the sandbox dirty flag. */
  function consumeSandboxDirty(): boolean {
    const was = sandboxDirty;
    sandboxDirty = false;
    return was;
  }

  /** Check and clear the session dirty flag. */
  function consumeSessionDirty(): boolean {
    const was = sessionDirty;
    sessionDirty = false;
    return was;
  }

  /** Check dirty flags without consuming them. */
  function isDirty(): { sandbox: boolean; session: boolean } {
    return { sandbox: sandboxDirty, session: sessionDirty };
  }

  // ── Public API ───────────────────────────────────────────────

  return Object.freeze({
    // Discovery & loading
    discover,
    loadSource,
    extractSchemaAndHints,

    // Audit integration
    runStaticScan,
    setAuditResult,
    getCachedAudit,

    // Approval management
    approve,
    unapprove,
    isApproved,
    getApprovalRecord,
    applyInlineConfig,

    // Configuration
    promptConfig,
    setConfig,
    formatConfigSummary,

    // Lifecycle
    enable,
    disable,
    getCompanions,

    // Accessors
    getPlugin,
    listPlugins,
    getEnabledPlugins,
    verifySourceHash,
    getDangerFindings,
    getSystemMessageAdditions,

    // Dirty flags
    markSandboxDirty,
    consumeSandboxDirty,
    consumeSessionDirty,
    isDirty,

    // Exposed for testing
    _plugins: plugins,
    _auditCache: auditCache,
    _approvalStore: approvalStore,
  });
}

// ── Config Prompt Helper ─────────────────────────────────────────────

/**
 * Prompt the user for a single config field value.
 * Handles type coercion and default values.
 *
 * @param rl — readline interface
 * @param key — config field name
 * @param entry — schema entry describing the field
 * @returns resolved value
 */
async function promptSingleField(
  rl: readline.Interface,
  key: string,
  entry: ConfigSchemaEntry,
  autoApprove?: boolean,
): Promise<string | number | boolean | string[]> {
  const defaultDisplay = formatDefault(entry.default);
  // Show field key clearly, with description if available
  const prompt = entry.description
    ? `    ${key} (${entry.description})${defaultDisplay}: `
    : `    ${key}${defaultDisplay}: `;

  // In auto-approve mode, use defaults without prompting.
  // Required fields with no default get a placeholder to avoid hanging.
  if (autoApprove) {
    if (entry.default !== undefined) {
      const displayVal = Array.isArray(entry.default)
        ? (entry.default as string[]).join(",")
        : String(entry.default);
      console.log(`${prompt}${displayVal} (auto)`);
      return entry.default;
    }
    // No default — fallback to empty-ish value
    console.log(`${prompt}(auto — no default)`);
    switch (entry.type) {
      case "array":
        return [];
      case "boolean":
        return false;
      case "number":
        return 0;
      default:
        return "";
    }
  }

  const answer = await rl.question(prompt);
  const trimmed = answer.trim();

  // Required field with empty answer — re-prompt until non-empty.
  // Fields are required when they have no default AND have required: true.
  if (trimmed === "" && entry.default === undefined) {
    if (entry.required) {
      console.error(`    ⚠️  This field is required — cannot be empty.`);
      return promptSingleField(rl, key, entry);
    }
    // No default, not required — return type-appropriate empty value
    switch (entry.type) {
      case "array":
        return [];
      case "boolean":
        return false;
      case "number":
        return 0;
      default:
        return "";
    }
  }

  // Empty answer → use default
  if (trimmed === "" && entry.default !== undefined) {
    return entry.default;
  }

  // Type coercion
  switch (entry.type) {
    case "boolean":
      return (
        trimmed.toLowerCase() === "yes" ||
        trimmed.toLowerCase() === "true" ||
        trimmed.toLowerCase() === "y" ||
        trimmed === "1"
      );

    case "number": {
      const n = Number(trimmed);
      if (!Number.isFinite(n)) {
        console.error(`    ⚠️  Invalid number "${trimmed}", using default`);
        return (entry.default as number) ?? 0;
      }
      return n;
    }

    case "array":
      // Comma-separated values
      return trimmed
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

    case "string":
    default:
      return trimmed || ((entry.default as string) ?? "");
  }
}

/**
 * Format a default value for display in prompt brackets.
 */
function formatDefault(value: unknown): string {
  if (value === undefined) return "";
  if (Array.isArray(value)) return ` [${value.join(", ")}]`;
  if (typeof value === "boolean") return ` [${value ? "yes" : "no"}]`;
  return ` [${value}]`;
}
