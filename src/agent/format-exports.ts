// ── agent/format-exports.ts — Export formatting utility ───────────────
//
// Pure display utility for formatting export information.
// No parsing logic — all parsing is done in the Rust guest.
// Interface expansion reads .d.ts to show full parameter shapes.
//
// ─────────────────────────────────────────────────────────────────────

/** Parameter information for a function export. */
export interface ParamInfo {
  name: string;
  type?: string;
  description?: string;
  required: boolean;
}

/** Information about a single exported symbol. */
export interface ExportInfo {
  /** Symbol name (e.g. "crc32", "strToBytes"). */
  name: string;
  /** Human-readable signature (e.g. "crc32(data: Uint8Array): number"). */
  signature?: string;
  /** First line of JSDoc or @description, if present. */
  description?: string;
  /** @requires tags - module/plugin dependencies (e.g. ["host:fs-write", "ha:zip-format"]). */
  requires?: string[];
  /** Parameter information with types and descriptions. */
  params?: ParamInfo[];
  /** Return type information. */
  returns?: {
    type?: string;
    description?: string;
  };
}

/**
 * Format ExportInfo array as a compact multi-line string for LLM consumption.
 *
 * Example output:
 *   crc32(data: Uint8Array): number — Calculate CRC32 checksum
 *   deflate(data: Uint8Array): Uint8Array — Compress data
 *   inflate(data: Uint8Array): Uint8Array — Decompress data
 *   PI: number
 *
 * @param exports — Array of export info objects
 * @returns Formatted string, one line per export
 */
export function formatExports(exports: ExportInfo[]): string {
  if (exports.length === 0) return "(no exports found)";
  return exports
    .map((e) => {
      const desc = e.description ? ` — ${e.description}` : "";
      const req = e.requires?.length
        ? ` [requires: ${e.requires.join(", ")}]`
        : "";
      return `${e.signature ?? e.name}${desc}${req}`;
    })
    .join("\n");
}

/**
 * Format exports with full parameter details for API discovery.
 *
 * Example output:
 *   textBox(pres, opts)
 *     pres: Presentation — The presentation object (required)
 *     opts: TextBoxOptions — Text box configuration (required)
 *     returns: Shape — The created text box shape
 *     Description: Create a text box on a slide
 *
 * @param exports — Array of export info objects
 * @returns Formatted string with full parameter details
 */
export function formatSignatures(exports: ExportInfo[]): string {
  if (exports.length === 0) return "(no exports found)";

  return exports
    .map((e) => {
      const lines: string[] = [];

      // Signature line
      lines.push(e.signature ?? e.name);

      // Parameters with types and descriptions
      if (e.params?.length) {
        for (const p of e.params) {
          const typeStr = p.type ? `: ${p.type}` : "";
          const descStr = p.description ? ` — ${p.description}` : "";
          const reqStr = p.required ? "" : " (optional)";
          lines.push(`  ${p.name}${typeStr}${descStr}${reqStr}`);
        }
      }

      // Return type
      if (e.returns?.type) {
        const retDesc = e.returns.description
          ? ` — ${e.returns.description}`
          : "";
        lines.push(`  returns: ${e.returns.type}${retDesc}`);
      }

      // Description (if not already in signature line)
      if (e.description) {
        lines.push(`  Description: ${e.description}`);
      }

      // Requirements
      if (e.requires?.length) {
        lines.push(`  requires: ${e.requires.join(", ")}`);
      }

      return lines.join("\n");
    })
    .join("\n\n");
}

/**
 * Format exports as a compact "cheat sheet" - just names and required params.
 *
 * Example output:
 *   textBox(opts)
 *   rect(opts)
 *   titleSlide(pres, opts)
 *   embedImage(pres, opts)
 *   VERSION
 *
 * Optional params shown in brackets:
 *   table(pres, opts, [theme])
 *
 * @param exports — Array of export info objects
 * @returns Compact one-liner per export
 */
export function formatCompact(exports: ExportInfo[]): string {
  if (exports.length === 0) return "(no exports found)";

  return exports
    .map((e) => {
      // If no params, just return the name
      if (!e.params?.length) {
        return e.name;
      }

      // Build param list: required params plain, optional in brackets
      const required = e.params.filter((p) => p.required).map((p) => p.name);
      const optional = e.params.filter((p) => !p.required).map((p) => p.name);

      let paramStr = required.join(", ");
      if (optional.length > 0) {
        const optStr = optional.map((o) => `[${o}]`).join(", ");
        paramStr = paramStr ? `${paramStr}, ${optStr}` : optStr;
      }

      return `${e.name}(${paramStr})`;
    })
    .join("\n");
}

// ── Interface Expansion ──────────────────────────────────────────────
// Extract and format interface/type definitions from .d.ts content
// so that module_info can show full parameter shapes to the LLM.

/**
 * Extract all exported interface definitions from a .d.ts file content.
 * Returns a Map of interface name → formatted field list.
 *
 * Uses brace-counting to handle nested types correctly (e.g.
 * columns?: { header: string; width?: number }[]).
 */
export function extractInterfaces(dtsContent: string): Map<string, string> {
  const interfaces = new Map<string, string>();
  // Find each "export interface Name {" and extract until matching closing brace
  const startPattern = /export\s+interface\s+(\w+)\s*\{/g;
  let startMatch;

  while ((startMatch = startPattern.exec(dtsContent)) !== null) {
    const name = startMatch[1];
    const bodyStart = startMatch.index + startMatch[0].length;

    // Brace-count to find the matching closing brace
    let depth = 1;
    let pos = bodyStart;
    while (pos < dtsContent.length && depth > 0) {
      if (dtsContent[pos] === "{") depth++;
      else if (dtsContent[pos] === "}") depth--;
      pos++;
    }
    const body = dtsContent.slice(bodyStart, pos - 1);

    // Extract property lines from the body
    const fields: string[] = [];
    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      // Skip empty lines, JSDoc comments, and internal fields
      if (
        !trimmed ||
        trimmed.startsWith("/*") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("//") ||
        trimmed.startsWith("readonly _") // internal fields
      ) {
        continue;
      }
      // Match property declarations: name?: Type; or name: Type;
      // Handle complex types with nested braces by taking everything after the colon
      const propMatch = trimmed.match(
        /^(readonly\s+)?(\w+)(\?)?:\s*(.+?);?\s*$/,
      );
      if (propMatch) {
        const propName = propMatch[2];
        const optional = propMatch[3] ? "?" : "";
        let propType = propMatch[4].replace(/;$/, "").trim();
        // Truncate very long types to keep output readable
        if (propType.length > 80) {
          propType = propType.slice(0, 77) + "...";
        }
        fields.push(`  ${propName}${optional}: ${propType}`);
      }
    }
    if (fields.length > 0) {
      interfaces.set(name, fields.join("\n"));
    }
  }
  return interfaces;
}

/**
 * Expand a parameter's type name to include the full interface definition.
 * If the type matches a known interface from the .d.ts, appends the fields.
 *
 * @param paramType - The type string (e.g. "TableOptions")
 * @param interfaces - Map of interface definitions from extractInterfaces()
 * @returns Expanded string with interface fields, or empty string if not found
 */
export function expandType(
  paramType: string,
  interfaces: Map<string, string>,
): string {
  // Strip generics, arrays, optionality to find the base type name
  const baseType = paramType
    .replace(/\[\]$/, "")
    .replace(/<.*>/, "")
    .replace(/\s*\|.*/, "") // Take first type in union
    .trim();

  const fields = interfaces.get(baseType);
  if (!fields) return "";
  return `  ${baseType} = {\n${fields}\n  }`;
}
