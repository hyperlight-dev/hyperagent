// ── MCP sanitisation ─────────────────────────────────────────────────
//
// Sanitise tool names, descriptions, and env vars before exposing
// them to the LLM or sandbox. Prevents prompt injection and ensures
// valid JavaScript identifiers.

import { MCP_MAX_DESCRIPTION_LENGTH } from "./types.js";

/**
 * Sanitise an MCP tool name to a valid JavaScript identifier.
 * Replaces invalid characters with underscores, ensures it starts
 * with a letter or underscore.
 */
export function sanitiseToolName(name: string): string {
  // Replace non-alphanumeric/underscore chars with underscore
  let sanitised = name.replace(/[^a-zA-Z0-9_$]/g, "_");

  // Ensure starts with letter or underscore
  if (sanitised.length > 0 && /^[0-9]/.test(sanitised)) {
    sanitised = "_" + sanitised;
  }

  // Fallback for empty
  if (sanitised.length === 0) {
    sanitised = "_unnamed";
  }

  return sanitised;
}

/**
 * Sanitise an MCP tool description for safe inclusion in JSDoc
 * and LLM context. Strips dangerous content, escapes JSDoc markers,
 * and truncates to the maximum length.
 */
export function sanitiseDescription(description: string): string {
  let sanitised = description;

  // Strip ANSI escape codes
  sanitised = sanitised.replace(
    // eslint-disable-next-line no-control-regex
    /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
    "",
  );

  // Escape JSDoc closing markers
  sanitised = sanitised.replace(/\*\//g, "*\\/");

  // Truncate
  if (sanitised.length > MCP_MAX_DESCRIPTION_LENGTH) {
    sanitised = sanitised.slice(0, MCP_MAX_DESCRIPTION_LENGTH - 3) + "...";
  }

  return sanitised;
}

/**
 * Mask an environment variable value for display.
 * Shows first 3 chars and last 2 chars with *** in between.
 */
export function maskEnvValue(value: string): string {
  if (value.length <= 8) return "***";
  return value.slice(0, 3) + "***" + value.slice(-2);
}

/** Patterns that suggest prompt injection in tool descriptions. */
const INJECTION_PATTERNS = [
  /you\s+are\s+now/i,
  /ignore\s+(all\s+)?previous/i,
  /ignore\s+(all\s+)?instructions/i,
  /system\s*:\s*/i,
  /\brole\s*:\s*system\b/i,
  /override\s+(any|all)\s+instructions/i,
  /act\s+as\s+(if|though)\s+you/i,
  /pretend\s+(you|to\s+be)/i,
  /new\s+instructions?\s*:/i,
  /forget\s+(everything|all|your)/i,
  /<\/?system>/i,
  /\[INST\]/i,
  /\[\/INST\]/i,
  /<<SYS>>/i,
];

/**
 * Audit a tool description for prompt injection patterns.
 * Returns a list of warnings (empty if clean).
 */
export function auditDescription(
  toolName: string,
  description: string,
): string[] {
  const warnings: string[] = [];

  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(description)) {
      warnings.push(
        `Tool "${toolName}": description contains suspicious pattern matching ${pattern}`,
      );
    }
  }

  // Check for very long descriptions (potential stuffing)
  if (description.length > 1000) {
    warnings.push(
      `Tool "${toolName}": unusually long description (${description.length} chars) — may contain hidden instructions`,
    );
  }

  return warnings;
}
