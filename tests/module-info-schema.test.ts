import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import ts from "typescript";

import { moduleInfoParameters } from "../src/agent/module-info-schema.js";

// ── Background ────────────────────────────────────────────────────────
// Reproduces the production failure:
//
//   400 Invalid schema for function 'module_info': In context=('properties',
//   'functionName', 'type', '1'), array schema missing items.
//
// The CAPI/OpenAI tool-schema validator rejects any schema node whose `type`
// resolves to (or includes) "array" unless an `items` schema is also present.
// Standard JSON Schema treats `items` as optional, so a generic validator like
// ajv does NOT catch this — these tests encode the CAPI-specific rule directly.

/** JSON Schema keywords whose values are themselves schemas (or schema maps). */
const SCHEMA_CHILD_KEYS = [
  "items",
  "additionalProperties",
  "contains",
  "propertyNames",
  "if",
  "then",
  "else",
  "not",
] as const;

const SCHEMA_LIST_KEYS = ["anyOf", "oneOf", "allOf", "prefixItems"] as const;

const SCHEMA_MAP_KEYS = [
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
] as const;

/** Does a `type` value (string or string[]) declare an array? */
function declaresArray(type: unknown): boolean {
  if (type === "array") return true;
  if (Array.isArray(type)) return type.includes("array");
  return false;
}

/**
 * Walk a JSON-Schema-shaped object and return the dotted paths of every node
 * that declares an `array` type without an accompanying `items` schema. An
 * empty result means the schema satisfies the CAPI "array needs items" rule.
 */
function findArrayTypesMissingItems(
  schema: unknown,
  path = "$",
  found: string[] = [],
): string[] {
  if (schema === null || typeof schema !== "object") return found;

  if (Array.isArray(schema)) {
    schema.forEach((entry, index) =>
      findArrayTypesMissingItems(entry, `${path}[${index}]`, found),
    );
    return found;
  }

  const node = schema as Record<string, unknown>;

  if (declaresArray(node.type) && node.items === undefined) {
    found.push(path);
  }

  for (const key of SCHEMA_CHILD_KEYS) {
    if (node[key] !== undefined) {
      findArrayTypesMissingItems(node[key], `${path}.${key}`, found);
    }
  }
  for (const key of SCHEMA_LIST_KEYS) {
    if (node[key] !== undefined) {
      findArrayTypesMissingItems(node[key], `${path}.${key}`, found);
    }
  }
  for (const key of SCHEMA_MAP_KEYS) {
    const map = node[key];
    if (map && typeof map === "object" && !Array.isArray(map)) {
      for (const [childName, childSchema] of Object.entries(map)) {
        findArrayTypesMissingItems(
          childSchema,
          `${path}.${key}.${childName}`,
          found,
        );
      }
    }
  }

  return found;
}

describe("CAPI array-schema rule checker", () => {
  it("flags the original broken module_info shape (regression guard)", () => {
    // This is the exact shape that triggered the 400 in production.
    const broken = {
      type: "object",
      properties: {
        functionName: { type: ["string", "array"] },
      },
    };
    expect(findArrayTypesMissingItems(broken)).toEqual([
      "$.properties.functionName",
    ]);
  });

  it("accepts an array type once items is supplied", () => {
    const fixed = {
      type: "object",
      properties: {
        functionName: {
          anyOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
        },
      },
    };
    expect(findArrayTypesMissingItems(fixed)).toEqual([]);
  });
});

describe("module_info parameter schema (real shipped object)", () => {
  it("does not declare an array type without items", () => {
    // Validates the ACTUAL object exported and used by the module_info tool —
    // not a re-declaration — so this proves the production schema is valid.
    expect(findArrayTypesMissingItems(moduleInfoParameters)).toEqual([]);
  });

  it("models functionName as a string or an array of strings via anyOf", () => {
    const functionName = (
      moduleInfoParameters.properties as Record<string, unknown>
    ).functionName;
    expect(functionName).toMatchObject({
      anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
    });
  });
});

// ── Static safety net across every tool schema ───────────────────────
// Parses the real source under src/agent and asserts that no tool schema
// (inline `defineTool` parameters or extracted schema literal) reintroduces an
// array type without items. Catches the whole class of bug for all tools,
// present and future, without booting the agent.

const AGENT_SRC_DIR = fileURLToPath(new URL("../src/agent", import.meta.url));

function collectTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectTsFiles(full, acc);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      acc.push(full);
    }
  }
  return acc;
}

/** AST equivalent of `declaresArray` for a `type` property initializer. */
function astTypeDeclaresArray(initializer: ts.Expression): boolean {
  if (ts.isStringLiteral(initializer)) {
    return initializer.text === "array";
  }
  if (ts.isArrayLiteralExpression(initializer)) {
    return initializer.elements.some(
      (el) => ts.isStringLiteral(el) && el.text === "array",
    );
  }
  return false;
}

function findSchemaViolationsInSource(
  filePath: string,
  source: string,
): string[] {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
  );
  const violations: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      let typeProp: ts.PropertyAssignment | undefined;
      let hasItems = false;
      for (const prop of node.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const name = prop.name.getText(sourceFile);
        if (name === "type") typeProp = prop;
        if (name === "items") hasItems = true;
      }
      if (typeProp && astTypeDeclaresArray(typeProp.initializer) && !hasItems) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(
          typeProp.getStart(sourceFile),
        );
        violations.push(`${filePath}:${line + 1}:${character + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

describe("all agent tool schemas (static source scan)", () => {
  it("no schema literal declares an array type without items", () => {
    const files = collectTsFiles(AGENT_SRC_DIR);
    // Sanity: ensure the scan actually found source to inspect.
    expect(files.length).toBeGreaterThan(0);

    const violations = files.flatMap((file) =>
      findSchemaViolationsInSource(file, readFileSync(file, "utf8")),
    );
    expect(violations).toEqual([]);
  });
});
