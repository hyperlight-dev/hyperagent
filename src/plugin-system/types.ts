// ── Plugin System — Type Definitions ─────────────────────────────────
//
// Core types for the plugin system. Plugins extend the Hyperlight
// sandbox with host functions that guest JavaScript can import.
//
// ─────────────────────────────────────────────────────────────────────

import type { ConfigSchema, SchemaField } from "./schema-types.js";

// Re-export schema types for consumers
export type { ConfigSchema, SchemaField };

// ── Plugin Manifest ──────────────────────────────────────────────────
//
// Parsed from plugin.json. Deliberately slim — the auditor derives
// capabilities, risk level, and author trustworthiness from the source
// code itself. Self-declared metadata can lie; code can't hide.

/**
 * Schema entry for a single config field in plugin.json.
 * Drives interactive prompts during /enable.
 *
 * @deprecated Use SchemaField from plugin-schema-types.ts instead.
 * This type is kept for backward compatibility with old plugin.json files.
 */
export interface ConfigSchemaEntry {
  /** JSON-ish type hint for validation and prompt rendering. */
  type: "string" | "number" | "boolean" | "array";
  /** Human-readable description shown during config prompts. */
  description: string;
  /** Default value used when the user accepts the default. */
  default?: string | number | boolean | string[];
  /** For array types, describes the element type. */
  items?: { type: string };
  /**
   * Whether the field is required (must have a non-empty value).
   * Fields with no default that are required will re-prompt until
   * the user provides a value. Prevents empty config causing
   * registration failures at sandbox build time.
   */
  required?: boolean;
  /** Minimum value (for number type). */
  minimum?: number;
  /** Maximum value (for number type). */
  maximum?: number;
  /** Maximum string length (for string type). */
  maxLength?: number;
  /** Whether to include in interactive prompts (from TypeScript SCHEMA). */
  promptKey?: boolean;
}

/**
 * The plugin.json manifest — what the plugin author provides.
 * Everything else (risk, capabilities, author trust) is derived
 * by the auditor from the actual source code.
 *
 * Note: configSchema, promptKeys, and systemMessage are now extracted
 * from the TypeScript source at runtime. They remain optional here
 * for backward compatibility with legacy plugin.json files.
 */
export interface PluginManifest {
  /** Unique plugin name (kebab-case, matches directory name). */
  name: string;
  /** SemVer version string (bare, no "v" prefix — e.g. "1.0.0" not "v1.0.0"). */
  version: string;
  /** One-line description of what the plugin does. */
  description: string;
  /**
   * Host module names this plugin registers. Guest JS imports
   * them as `import * as x from "host:<name>"`.
   */
  hostModules: string[];
  /**
   * Configuration schema — drives interactive prompts during
   * the /enable flow. Each key is a config field name.
   *
   * @deprecated Now extracted from SCHEMA export in index.ts.
   * Kept for backward compatibility.
   */
  configSchema?: Record<string, ConfigSchemaEntry>;
  /**
   * Subset of configSchema field names to prompt interactively.
   * Fields not listed here that have defaults are applied silently.
   * Fields without defaults are always prompted regardless.
   * Omit to prompt all fields.
   *
   * @deprecated Now derived from promptKey field in SCHEMA export.
   * Kept for backward compatibility.
   */
  promptKeys?: string[];
  /**
   * Additional system message text injected when the plugin is
   * enabled. Tells the model what new capabilities are available.
   *
   * @deprecated Now uses _HINTS export from index.ts.
   * Kept for backward compatibility.
   */
  systemMessage?: string;
  /**
   * Optional list of companion plugin names that should be
   * auto-enabled alongside this plugin. Each companion goes
   * through its own audit/approval flow.
   */
  companions?: string[];
  /**
   * Structured hints for the plugin. Stored in plugin.json and
   * surfaced by plugin_info. Replaces systemMessage for new plugins.
   */
  hints?: {
    overview?: string;
    relatedModules?: string[];
    requiredPlugins?: string[];
    optionalPlugins?: string[];
    criticalRules?: string[];
    antiPatterns?: string[];
    commonPatterns?: string[];
  };
}

// ── Audit Results ────────────────────────────────────────────────────

/** Severity level for a static scan finding. */
export type FindingSeverity = "info" | "warning" | "danger";

/** A single finding from the static scanner or LLM auditor. */
export interface AuditFinding {
  severity: FindingSeverity;
  /** Short description of what was found. */
  message: string;
  /** Line number in the source (1-based), if applicable. */
  line?: number;
}

/** Risk level assigned by the LLM auditor. */
export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

/** Recommendation verdict for a plugin audit. */
export type AuditVerdict = "approve" | "approve-with-conditions" | "reject";

/** An injection attempt found by the LLM auditor. */
export interface InjectionAttempt {
  /** Excerpt or exact text of the injection attempt. */
  excerpt: string;
  /** Why this appears to be an injection attempt. */
  reason: string;
}

/** Complete audit result — static scan + LLM deep analysis. */
export interface AuditResult {
  /** SHA-256 hash of the source file — cache key. */
  contentHash: string;
  /** Timestamp of the audit (ISO 8601). */
  auditedAt: string;
  /** Combined findings from static scan and LLM analysis. */
  findings: AuditFinding[];
  /** Risk level from LLM analysis. */
  riskLevel: RiskLevel;
  /** One-sentence LLM summary of what the plugin does. */
  summary: string;
  /** Whether the LLM thinks the manifest description is accurate. */
  descriptionAccurate: boolean;
  /** Human-readable list of capabilities this plugin exposes to guests. */
  capabilities: string[];
  /** Short reasons justifying the risk level rating. */
  riskReasons: string[];
  /** Recommendation: approve, approve-with-conditions, or reject. */
  recommendation: {
    verdict: AuditVerdict;
    /** Explanation for the verdict — conditions or rejection reason. */
    reason: string;
  };
  /** Injection attempts found in source (canaries filtered by host). */
  injectionAttempts?: InjectionAttempt[];
}

// ── Plugin State Machine ─────────────────────────────────────────────

/**
 * Plugin lifecycle states:
 *
 *   discovered ──audit──▶ audited ──configure──▶ configured ──enable──▶ enabled
 *                                                                         │
 *                                                              disable ◀──┘
 *                                                                 │
 *                                                                 ▼
 *                                                             disabled
 *
 * Approval is orthogonal — it's a trust flag, not a lifecycle stage.
 * A plugin can be approved AND in any lifecycle state. Approval is
 * long-lived (persisted to disk), enablement is session-scoped.
 */
export type PluginState =
  "discovered" | "audited" | "configured" | "enabled" | "disabled";

// ── Approval ─────────────────────────────────────────────────────────

/**
 * A persisted approval record. Stored on disk, keyed by plugin name.
 * Automatically invalidated when the source content hash changes.
 */
export interface ApprovalRecord {
  /** SHA-256 of the approved source — if source changes, approval is void. */
  contentHash: string;
  /** When the plugin was approved (ISO 8601). */
  approvedAt: string;
  /** Risk level at time of approval — informational. */
  auditRiskLevel: RiskLevel;
  /** Verdict at time of approval — informational. */
  auditVerdict: AuditVerdict;
}

/**
 * Full approval store — serialised to disk as JSON.
 * Keyed by plugin name.
 */
export type ApprovalStore = Record<string, ApprovalRecord>;

// ── Operator Config ──────────────────────────────────────────────────
//
// Operator-level settings loaded from ~/.hyperagent/config.json.
// These control security policy across all sessions. Not accessible
// from the agent REPL — only editable by changing the file.

/**
 * Ordered risk levels from least to most severe.
 * Used for threshold comparisons.
 */
export const RISK_LEVEL_ORDER: readonly RiskLevel[] = [
  "LOW",
  "MEDIUM",
  "HIGH",
  "CRITICAL",
] as const;

/**
 * Operator-level configuration. Controls security policy.
 * Loaded from ~/.hyperagent/config.json.
 */
export interface OperatorConfig {
  /**
   * Maximum risk level that can be enabled or approved.
   * Plugins with a risk level above this are blocked.
   * Default: "MEDIUM" — blocks HIGH and CRITICAL.
   */
  maxRiskLevel: RiskLevel;

  /**
   * Maximum audit log file size in megabytes before rotation.
   * Applies to all plugin audit logs (e.g. fetch-log.jsonl).
   * When exceeded, the log is truncated to the newest half.
   * Set to 0 to disable rotation entirely.
   * Default: 10 (MB).
   */
  maxAuditLogSizeMb: number;
}

/** Default operator config — used when no config file exists. */
export const DEFAULT_OPERATOR_CONFIG: Readonly<OperatorConfig> = {
  maxRiskLevel: "MEDIUM",
  maxAuditLogSizeMb: 10,
};

// ── Plugin Record ────────────────────────────────────────────────────

/** Resolved configuration values from interactive prompts. */
export type PluginConfig = Record<string, string | number | boolean | string[]>;

/**
 * Complete plugin record — everything we know about a plugin.
 * Created during discovery, enriched through audit and configuration.
 */
export interface Plugin {
  /** Parsed manifest from plugin.json. */
  manifest: PluginManifest;
  /** Absolute path to the plugin directory. */
  dir: string;
  /** Current lifecycle state. */
  state: PluginState;
  /** Resolved configuration (populated after interactive prompts). */
  config: PluginConfig;
  /** Audit result (populated after audit completes). */
  audit: AuditResult | null;
  /** Source code of index.ts (loaded for auditing). */
  source: string | null;
  /**
   * Whether this plugin has a valid, current approval.
   * Derived at runtime from the persisted approval store —
   * true only when the stored content hash matches the
   * current source. Orthogonal to lifecycle state.
   */
  approved: boolean;
  /**
   * Config schema extracted from TypeScript SCHEMA export.
   * Loaded via Rust analysis guest at discovery time.
   * Falls back to manifest.configSchema for legacy plugins.
   */
  schema: ConfigSchema | null;
  /**
   * Usage hints extracted from TypeScript _HINTS export.
   * Loaded via Rust analysis guest at discovery time.
   * Falls back to manifest.systemMessage for legacy plugins.
   */
  hints: string | null;
  /**
   * Prompt keys derived from schema (fields with promptKey: true).
   * Falls back to manifest.promptKeys for legacy plugins.
   */
  promptKeys: string[] | null;
}
