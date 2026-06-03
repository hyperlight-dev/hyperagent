// Parameter schema for the `module_info` tool.
//
// Extracted into its own module so the exact JSON Schema object that ships to
// the Copilot/CAPI backend can be imported and validated by tests without
// booting the agent (src/agent/index.ts runs main() on import).
//
// IMPORTANT: `functionName` accepts either a single string or an array of
// strings. This MUST be expressed with `anyOf` rather than
// `type: ["string", "array"]`. The CAPI schema validator rejects a union
// `type` that includes "array" unless an `items` schema is also present,
// producing: 400 Invalid schema ... array schema missing items.

/**
 * JSON Schema for the `module_info` tool parameters.
 *
 * Kept as a plain JSON Schema object (not Zod) to mirror exactly what is sent
 * to the backend.
 */
export const moduleInfoParameters = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description: "Module name (e.g. 'str-bytes', 'pptx')",
    },
    functionName: {
      anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
      description:
        "Optional: get info for specific function(s). Accepts single name, comma-separated list, or array (e.g. 'chartSlide' or 'chartSlide,heroSlide,table' or ['chartSlide', 'heroSlide'])",
    },
    signatures: {
      type: "boolean",
      description:
        "Optional: return full parameter types and descriptions for ALL functions (better for API discovery)",
    },
    compact: {
      type: "boolean",
      description:
        "Optional: return condensed one-liner per export (just names + required params, no descriptions)",
    },
  },
  required: ["name"],
} as const;
