#!/usr/bin/env npx tsx
/**
 * Generate TypeScript declaration (.d.ts) files from native Rust module source.
 *
 * Parses #[rquickjs::module] blocks in Rust source files and generates
 * corresponding .d.ts files with type declarations and doc comments.
 *
 * Usage: npx tsx scripts/generate-native-dts.ts
 *
 * Type mapping (Rust → TypeScript):
 *   f64           → number
 *   i32/u32/etc   → number
 *   String        → string
 *   bool          → boolean
 *   Vec<u8>       → Uint8Array
 *   Value<'_>     → Uint8Array  (binary input convention)
 *   Option<T>     → T | undefined
 *   ()            → void
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { join, basename } from "path";

const RUNTIME_DIR = join(
  import.meta.dirname,
  "..",
  "src",
  "sandbox",
  "runtime",
  "modules",
);
const OUTPUT_DIR = join(import.meta.dirname, "..", "builtin-modules");

// Rust type → TypeScript type mapping
function mapRustType(rustType: string): string {
  const t = rustType.trim();

  // Vec<u8> → Uint8Array (binary data)
  if (t === "Vec<u8>") return "Uint8Array";

  // Value<'_> or Value<'js> or bare Value → Uint8Array (rquickjs binary input convention)
  // In parameter position this means "accepts Uint8Array or String".
  // In return position it's usually an Object — but Uint8Array is the safe default.
  if (/^(rquickjs::)?Value(<'[a-z_]+>)?$/.test(t)) return "Uint8Array";

  // rquickjs container types (after lifetime stripping)
  if (/^(rquickjs::)?Array(<'[a-z_]+>)?$/.test(t)) return "any[]";
  if (/^(rquickjs::)?Object(<'[a-z_]+>)?$/.test(t))
    return "Record<string, any>";

  // QjsResult<T> / Result<T> → unwrap to T (error handling is invisible to JS)
  const resultMatch = t.match(/^(?:Qjs)?Result<(.+)>$/);
  if (resultMatch) return mapRustType(resultMatch[1]);

  // Option<T> → T | undefined
  const optionMatch = t.match(/^Option<(.+)>$/);
  if (optionMatch) return `${mapRustType(optionMatch[1])} | undefined`;

  // Numeric types
  if (
    [
      "f64",
      "f32",
      "i8",
      "i16",
      "i32",
      "i64",
      "u8",
      "u16",
      "u32",
      "u64",
      "usize",
      "isize",
    ].includes(t)
  ) {
    return "number";
  }

  if (t === "String" || t === "&str") return "string";
  if (t === "bool") return "boolean";
  if (t === "()" || t === "") return "void";

  // Unknown type — pass through as-is with a warning
  console.warn(`  ⚠️  Unknown Rust type: ${t} — using 'any'`);
  return "any";
}

// rquickjs parameter types that are auto-injected and invisible to JS callers.
// Includes both lifetime-annotated and stripped forms.
const HIDDEN_PARAMS = new Set(["Ctx<'_>", "Ctx<'js>", "Ctx"]);

interface ParsedFunction {
  name: string;
  params: Array<{ name: string; type: string }>;
  returnType: string;
  docLines: string[];
}

/**
 * Parse a Rust source file for #[rquickjs::module] blocks.
 * Extracts function signatures and doc comments.
 */
function parseRustModule(source: string): ParsedFunction[] {
  const functions: ParsedFunction[] = [];
  const lines = source.split("\n");

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();

    // Look for #[rquickjs::function] annotation
    if (line === "#[rquickjs::function]") {
      // Collect preceding /// doc comments
      const docLines: string[] = [];
      let j = i - 1;
      while (j >= 0 && lines[j].trim().startsWith("///")) {
        docLines.unshift(lines[j].trim().replace(/^\/\/\/\s?/, ""));
        j--;
      }

      // Next non-empty line should be the function signature start
      i++;
      while (i < lines.length && lines[i].trim() === "") i++;

      // Collect the full signature (may span multiple lines until '{')
      let sigLines = "";
      while (i < lines.length && !lines[i].includes("{")) {
        sigLines += " " + lines[i].trim();
        i++;
      }
      if (i < lines.length) {
        sigLines += " " + lines[i].trim(); // include the line with '{'
      }
      const fnLine = sigLines.trim();

      // Strip lifetime generics: fn name<'js>(...) → fn name(...)
      const cleanedLine = fnLine.replace(/<'[a-z_]+>/g, "");

      const fnMatch = cleanedLine.match(
        /pub\s+fn\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*(.+?))?\s*\{/,
      );

      if (fnMatch) {
        const name = fnMatch[1];
        const paramsStr = fnMatch[2];
        const returnTypeRust = fnMatch[3] ?? "()";

        // Parse parameters, skip &self, hidden rquickjs params, and cfg attributes
        const params: Array<{ name: string; type: string }> = [];
        if (paramsStr.trim()) {
          for (const param of paramsStr.split(",")) {
            const p = param.trim();
            // Skip &self, skip cfg attributes
            if (p === "&self" || p === "self" || p.startsWith("#[")) continue;
            const paramMatch = p.match(/(\w+)\s*:\s*(.+)/);
            if (paramMatch) {
              const rustType = paramMatch[2].trim();
              // Skip rquickjs context params (auto-injected, invisible to JS)
              if (HIDDEN_PARAMS.has(rustType)) continue;
              params.push({
                name: paramMatch[1],
                type: mapRustType(rustType),
              });
            }
          }
        }

        functions.push({
          name,
          params,
          returnType: mapRustType(returnTypeRust),
          docLines,
        });
      }
    }
    i++;
  }

  return functions;
}

/**
 * Generate .d.ts content from parsed functions.
 */
function generateDts(functions: ParsedFunction[]): string {
  const parts: string[] = [];

  for (const fn of functions) {
    // Doc comment
    if (fn.docLines.length > 0) {
      if (fn.docLines.length === 1) {
        parts.push(`/** ${fn.docLines[0]} */`);
      } else {
        parts.push("/**");
        for (const line of fn.docLines) {
          parts.push(` * ${line}`);
        }
        parts.push(" */");
      }
    }

    // Function declaration
    const params = fn.params.map((p) => `${p.name}: ${p.type}`).join(", ");
    parts.push(
      `export declare function ${fn.name}(${params}): ${fn.returnType};`,
    );
  }

  return parts.join("\n") + "\n";
}

// ── Main ──────────────────────────────────────────────────────────────

function main() {
  if (!existsSync(RUNTIME_DIR)) {
    console.log("No native modules directory found. Skipping.");
    return;
  }

  const moduleDirs = readdirSync(RUNTIME_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  let generated = 0;

  for (const moduleDir of moduleDirs) {
    const libPath = join(RUNTIME_DIR, moduleDir, "src", "lib.rs");
    if (!existsSync(libPath)) continue;

    const source = readFileSync(libPath, "utf-8");
    const functions = parseRustModule(source);

    if (functions.length === 0) {
      console.warn(`  ⚠️  No #[rquickjs::function] found in ${moduleDir}`);
      continue;
    }

    // Module name: read from companion .json in builtin-modules/
    // Match by directory base name (native-deflate → deflate.json or ziplib.json)
    const dirBaseName = moduleDir.replace(/^native-/, "");
    let moduleName = dirBaseName;

    // Check .json files for one with type: "native" whose name matches this directory
    const jsonFiles = readdirSync(OUTPUT_DIR).filter(
      (f) => f.endsWith(".json") && f !== "tsconfig.json",
    );
    // First try exact match (native-image → image.json)
    const exactMatch = jsonFiles.find((f) => f === `${dirBaseName}.json`);
    if (exactMatch) {
      const meta = JSON.parse(
        readFileSync(join(OUTPUT_DIR, exactMatch), "utf-8"),
      );
      if (meta.type === "native") {
        moduleName = meta.name;
      }
    } else {
      // No exact match — scan for any native .json that hasn't been claimed
      // This handles renames (native-deflate → ziplib.json)
      for (const jf of jsonFiles) {
        const meta = JSON.parse(readFileSync(join(OUTPUT_DIR, jf), "utf-8"));
        if (
          meta.type === "native" &&
          !moduleDirs.some(
            (d) => d.replace(/^native-/, "") === jf.replace(".json", ""),
          )
        ) {
          moduleName = meta.name;
          break;
        }
      }
    }

    const outputPath = join(OUTPUT_DIR, `${moduleName}.d.ts`);
    const dts = generateDts(functions);

    writeFileSync(outputPath, dts);
    console.log(
      `  📝 ${moduleName}.d.ts (${functions.length} function${functions.length > 1 ? "s" : ""})`,
    );
    generated++;
  }

  console.log(
    `Generated ${generated} native module .d.ts file${generated !== 1 ? "s" : ""}`,
  );
}

main();
