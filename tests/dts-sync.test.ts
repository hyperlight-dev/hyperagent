/**
 * Test that module.json hash fields are up-to-date with .js/.d.ts files.
 *
 * This catches drift where a .js or .d.ts file was modified but
 * scripts/update-module-hashes.ts wasn't run.
 */

import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import { readdirSync, readFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const BUILTIN_DIR = join(import.meta.dirname, "..", "builtin-modules");
const SRC_DIR = join(BUILTIN_DIR, "src");

function hash(content: Buffer | string): string {
  const h = createHash("sha256").update(content).digest("hex");
  return "sha256:" + h.slice(0, 16);
}

interface ModuleJson {
  name: string;
  description: string;
  author: string;
  mutable: boolean;
  sourceHash?: string;
  dtsHash?: string;
}

describe("module.json hash sync", () => {
  const jsonFiles = readdirSync(BUILTIN_DIR).filter(
    (f) => f.endsWith(".json") && f !== "tsconfig.json",
  );

  // Check if any compiled .js files exist
  const anyJsExists = jsonFiles.some((f) =>
    existsSync(join(BUILTIN_DIR, f.replace(".json", ".js"))),
  );

  if (!anyJsExists) {
    it.skip("compiled files not present (run npm run build:modules first)", () => {});
  } else {
    for (const file of jsonFiles) {
      const name = file.replace(".json", "");
      const jsPath = join(BUILTIN_DIR, `${name}.js`);
      const dtsPath = join(BUILTIN_DIR, `${name}.d.ts`);
      const jsonPath = join(BUILTIN_DIR, file);

      // Skip modules without a .js file (like internal-only modules that might only have .json)
      if (!existsSync(jsPath)) {
        continue;
      }

      it(`${name}: sourceHash matches .js`, () => {
        const meta: ModuleJson = JSON.parse(readFileSync(jsonPath, "utf-8"));
        const jsHash = hash(readFileSync(jsPath));

        expect(meta.sourceHash).toBe(jsHash);
      });

      if (existsSync(dtsPath)) {
        it(`${name}: dtsHash matches .d.ts`, () => {
          const meta: ModuleJson = JSON.parse(readFileSync(jsonPath, "utf-8"));
          const dtsHash = hash(readFileSync(dtsPath));

          expect(meta.dtsHash).toBe(dtsHash);
        });
      }
    }
  }
});

// Non-module JSON files to skip
const NON_MODULE_JSON = new Set(["tsconfig.json"]);

describe("module.json completeness", () => {
  it("all .js modules have a .json metadata file", () => {
    const jsFiles = readdirSync(BUILTIN_DIR).filter(
      (f) => f.endsWith(".js") && !f.endsWith(".shim.js"),
    );

    for (const jsFile of jsFiles) {
      const name = jsFile.replace(".js", "");
      const jsonPath = join(BUILTIN_DIR, `${name}.json`);

      expect(existsSync(jsonPath), `Missing ${name}.json for ${jsFile}`).toBe(
        true,
      );
    }
  });

  it("all module.json files have required fields", () => {
    const jsonFiles = readdirSync(BUILTIN_DIR).filter(
      (f) => f.endsWith(".json") && !NON_MODULE_JSON.has(f),
    );

    for (const file of jsonFiles) {
      const meta = JSON.parse(readFileSync(join(BUILTIN_DIR, file), "utf-8"));

      expect(meta.name, `${file}: missing name`).toBeDefined();
      expect(meta.description, `${file}: missing description`).toBeDefined();
      expect(meta.author, `${file}: missing author`).toBeDefined();
      expect(typeof meta.mutable, `${file}: missing mutable`).toBe("boolean");
    }
  });
});

/**
 * CRITICAL: Verify that .js and .d.ts files match what TypeScript compiles
 * from the .ts source files.
 *
 * This catches the scenario where someone edits a .js or .d.ts file directly
 * instead of editing the .ts source and recompiling. Such edits create drift
 * that is hidden by hash validation (which only checks current files match
 * their stored hashes, not that they match their source).
 *
 * The test compiles to a temp directory and compares output to committed files.
 *
 * NOTE: These tests only run if the compiled files exist (after `npm run build:modules`).
 * The files are gitignored and generated at install time via the `prepare` script.
 */
describe("TypeScript source consistency", () => {
  // Get all .ts files in src/ directory (excluding type definitions)
  const tsFiles = existsSync(SRC_DIR)
    ? readdirSync(SRC_DIR).filter(
        (f) => f.endsWith(".ts") && !f.endsWith(".d.ts"),
      )
    : [];

  // Skip if no TypeScript source files exist
  if (tsFiles.length === 0) {
    it.skip("no TypeScript source files to check", () => {});
    return;
  }

  // Check if any compiled files exist (skip if not built yet)
  const anyCompiledFilesExist = tsFiles.some((f) =>
    existsSync(join(BUILTIN_DIR, f.replace(".ts", ".js"))),
  );
  if (!anyCompiledFilesExist) {
    it.skip("compiled files not present (run npm run build:modules first)", () => {});
    return;
  }

  it("compiled .js matches committed .js files", () => {
    // Run tsc to a temp directory to get fresh compile output
    const tmpDir = join(import.meta.dirname, "..", ".tmp-ts-check");
    try {
      // Clean up any previous temp dir
      rmSync(tmpDir, { recursive: true, force: true });

      // Compile TypeScript to temp directory
      execSync(
        `cd ${BUILTIN_DIR} && npx tsc --project tsconfig.json --outDir ${tmpDir}`,
        { stdio: "pipe" },
      );

      // Format compiled files with Prettier (same as committed files)
      // Use the project's prettier config by running from project root
      const projectRoot = join(import.meta.dirname, "..");
      execSync(
        `npx prettier --config "${projectRoot}/.prettierrc" --write "${tmpDir}/*.js"`,
        {
          stdio: "pipe",
          cwd: projectRoot,
        },
      );

      // For each compiled .js file, compare to committed version
      for (const tsFile of tsFiles) {
        const jsFile = tsFile.replace(".ts", ".js");
        const compiledPath = join(tmpDir, jsFile);
        const committedPath = join(BUILTIN_DIR, jsFile);

        if (!existsSync(compiledPath)) continue;
        if (!existsSync(committedPath)) continue;

        const compiled = readFileSync(compiledPath, "utf-8");
        const committed = readFileSync(committedPath, "utf-8");

        expect(
          compiled,
          `${jsFile}: compiled output differs from committed file. ` +
            `This suggests the .js was edited directly instead of editing ${tsFile} and recompiling. ` +
            `Run: cd builtin-modules && npx tsc && npm run fmt -- --write builtin-modules/${jsFile}`,
        ).toBe(committed);
      }
    } finally {
      // Clean up temp directory
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("compiled .d.ts matches committed .d.ts files", () => {
    const tmpDir = join(import.meta.dirname, "..", ".tmp-ts-check");
    try {
      rmSync(tmpDir, { recursive: true, force: true });
      execSync(
        `cd ${BUILTIN_DIR} && npx tsc --project tsconfig.json --outDir ${tmpDir}`,
        { stdio: "pipe" },
      );

      for (const tsFile of tsFiles) {
        const dtsFile = tsFile.replace(".ts", ".d.ts");
        const moduleName = tsFile.replace(".ts", "");
        const compiledPath = join(tmpDir, dtsFile);
        const committedPath = join(BUILTIN_DIR, dtsFile);
        const jsonPath = join(BUILTIN_DIR, `${moduleName}.json`);

        if (!existsSync(compiledPath)) continue;
        if (!existsSync(committedPath)) continue;
        // Skip native modules — their .d.ts comes from Rust, not tsc
        if (existsSync(jsonPath)) {
          const meta = JSON.parse(readFileSync(jsonPath, "utf-8"));
          if (meta.type === "native") continue;
        }

        const compiled = readFileSync(compiledPath, "utf-8");
        const committed = readFileSync(committedPath, "utf-8");

        expect(
          compiled,
          `${dtsFile}: compiled output differs from committed file. ` +
            `This suggests the .d.ts was edited directly instead of editing ${tsFile} and recompiling. ` +
            `Run: cd builtin-modules && npx tsc`,
        ).toBe(committed);
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

/**
 * Verify that ha-modules.d.ts ambient declarations match actual exports from
 * each TypeScript source module.
 *
 * ha-modules.d.ts contains `declare module "ha:*"` blocks that tell TypeScript
 * what each module exports. If someone changes a module's API (e.g., renames
 * `getState` to `get`) without updating ha-modules.d.ts, LLMs will use the
 * wrong API and get compile errors.
 *
 * This test parses both files and compares export names.
 */
/**
 * Verify that builtin modules don't use APIs that don't exist in the Hyperlight sandbox.
 *
 * The sandbox environment provides these globals:
 * - console.log, console.warn, console.error, console.info, console.debug
 * - TextEncoder, TextDecoder, atob, btoa, queueMicrotask
 *
 * But our builtin modules should use ha:base64 (not atob/btoa) and
 * ha:str-bytes (not TextEncoder) for internal consistency.
 */
describe("builtin modules sandbox compatibility", () => {
  const tsFiles = existsSync(SRC_DIR)
    ? readdirSync(SRC_DIR).filter(
        (f) => f.endsWith(".ts") && !f.endsWith(".d.ts"),
      )
    : [];

  if (tsFiles.length === 0) {
    it.skip("no TypeScript source files to check", () => {});
    return;
  }

  // Patterns forbidden in BUILTIN MODULE SOURCE for internal consistency.
  // These APIs now exist as globals but our modules should use the ha:*
  // equivalents to avoid coupling to globals that may behave differently.
  const FORBIDDEN_PATTERNS = [
    {
      pattern: /\batob\s*\(/g,
      name: "atob()",
      reason: "use ha:base64 decode() instead (Uint8Array, not Latin-1 string)",
    },
    {
      pattern: /\bbtoa\s*\(/g,
      name: "btoa()",
      reason: "use ha:base64 encode() instead (Uint8Array input, not string)",
    },
  ];

  /**
   * Check if a position in content is inside a string literal or comment.
   * This prevents false positives from documentation mentioning these APIs.
   */
  function isInsideStringOrComment(content: string, index: number): boolean {
    // Simple heuristic: check if we're inside a template literal, string, or comment
    // by scanning backwards for unmatched quotes/backticks
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let inTemplateLiteral = false;
    let inLineComment = false;
    let inBlockComment = false;

    for (let i = 0; i < index; i++) {
      const char = content[i];
      const nextChar = content[i + 1];
      const prevChar = content[i - 1];

      // Handle newlines (end line comments)
      if (char === "\n") {
        inLineComment = false;
        continue;
      }

      // Skip if in comment
      if (inLineComment) continue;
      if (inBlockComment) {
        if (char === "*" && nextChar === "/") {
          inBlockComment = false;
          i++; // skip the /
        }
        continue;
      }

      // Check for comment starts (only if not in string)
      if (!inSingleQuote && !inDoubleQuote && !inTemplateLiteral) {
        if (char === "/" && nextChar === "/") {
          inLineComment = true;
          i++;
          continue;
        }
        if (char === "/" && nextChar === "*") {
          inBlockComment = true;
          i++;
          continue;
        }
      }

      // Toggle string states (skip escaped quotes)
      if (prevChar !== "\\") {
        if (char === "'" && !inDoubleQuote && !inTemplateLiteral) {
          inSingleQuote = !inSingleQuote;
        } else if (char === '"' && !inSingleQuote && !inTemplateLiteral) {
          inDoubleQuote = !inDoubleQuote;
        } else if (char === "`" && !inSingleQuote && !inDoubleQuote) {
          inTemplateLiteral = !inTemplateLiteral;
        }
      }
    }

    return (
      inSingleQuote ||
      inDoubleQuote ||
      inTemplateLiteral ||
      inLineComment ||
      inBlockComment
    );
  }

  for (const tsFile of tsFiles) {
    it(`${tsFile}: no forbidden sandbox APIs`, () => {
      const content = readFileSync(join(SRC_DIR, tsFile), "utf-8");
      const lines = content.split("\n");

      for (const { pattern, name, reason } of FORBIDDEN_PATTERNS) {
        // Reset regex state
        pattern.lastIndex = 0;

        let match;
        while ((match = pattern.exec(content)) !== null) {
          // Skip matches inside strings/comments (documentation is OK)
          if (isInsideStringOrComment(content, match.index)) {
            continue;
          }

          // Find line number for better error message
          let charCount = 0;
          let lineNum = 1;
          for (const line of lines) {
            charCount += line.length + 1; // +1 for newline
            if (charCount > match.index) break;
            lineNum++;
          }

          throw new Error(
            `${tsFile}:${lineNum}: Found ${name} which doesn't exist in sandbox (${reason}). ` +
              `Remove this call or use an alternative.`,
          );
        }
      }
    });
  }
});

describe("ha-modules.d.ts matches actual exports", () => {
  const HA_MODULES_DTS = join(SRC_DIR, "types", "ha-modules.d.ts");

  // Skip if files don't exist
  if (!existsSync(HA_MODULES_DTS) || !existsSync(SRC_DIR)) {
    it.skip("ha-modules.d.ts or src/ not found", () => {});
    return;
  }

  // Parse ha-modules.d.ts to extract declared exports per module
  const dtsContent = readFileSync(HA_MODULES_DTS, "utf-8");

  /**
   * Extract module blocks from ha-modules.d.ts using brace counting.
   * Returns Map of moduleName -> block content
   */
  function extractModuleBlocks(content: string): Map<string, string> {
    const blocks = new Map<string, string>();
    const modulePattern = /declare module "ha:([^"]+)"\s*\{/g;
    let match;

    while ((match = modulePattern.exec(content)) !== null) {
      const moduleName = match[1];
      const startIndex = match.index + match[0].length;

      // Count braces to find end of module block
      let depth = 1;
      let i = startIndex;
      while (i < content.length && depth > 0) {
        const ch = content[i];
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
        i++;
      }

      const blockContent = content.slice(startIndex, i - 1);
      blocks.set(moduleName, blockContent);
    }

    return blocks;
  }

  // Extract function/const/type exports from a block
  function extractDeclaredExports(block: string): string[] {
    const exports: string[] = [];
    // Match: export function NAME, export const NAME, export type NAME, export interface NAME
    // Also handle: export declare function NAME (from auto-generated d.ts)
    const exportRegex =
      /export\s+(?:declare\s+)?(?:function|const|type|interface)\s+(\w+)/g;
    let match;
    while ((match = exportRegex.exec(block)) !== null) {
      exports.push(match[1]);
    }
    return exports.sort();
  }

  // Extract actual exports from a .ts source file
  function extractActualExports(tsPath: string): string[] {
    if (!existsSync(tsPath)) return [];
    const content = readFileSync(tsPath, "utf-8");
    const exports: string[] = [];
    // Match: export function NAME, export const NAME, export type NAME, export interface NAME
    const exportRegex = /export\s+(?:function|const|type|interface)\s+(\w+)/g;
    let match;
    while ((match = exportRegex.exec(content)) !== null) {
      exports.push(match[1]);
    }
    return exports.sort();
  }

  // Build map of declared modules using brace counting
  const declaredModules = extractModuleBlocks(dtsContent);
  const declaredExportsMap = new Map<string, string[]>();
  for (const [moduleName, block] of declaredModules) {
    declaredExportsMap.set(moduleName, extractDeclaredExports(block));
  }

  // Test each ha:* module that has a corresponding .ts file
  for (const [moduleName, declaredExports] of declaredExportsMap) {
    // Skip host:* modules (they're not in src/)
    if (moduleName.startsWith("host:") || moduleName.startsWith("_")) continue;

    // Skip native modules — their ha-modules.d.ts block comes from Rust, not TS
    const jsonPath = join(BUILTIN_DIR, `${moduleName}.json`);
    if (existsSync(jsonPath)) {
      const meta = JSON.parse(readFileSync(jsonPath, "utf-8"));
      if (meta.type === "native") continue;
    }

    const tsPath = join(SRC_DIR, `${moduleName}.ts`);
    if (!existsSync(tsPath)) continue;

    it(`ha:${moduleName} declared exports match actual exports`, () => {
      const actualExports = extractActualExports(tsPath);

      // Check that all declared exports exist in actual exports
      const missingInActual = declaredExports.filter(
        (e) => !actualExports.includes(e),
      );
      expect(
        missingInActual,
        `ha-modules.d.ts declares exports that don't exist in ${moduleName}.ts: ${missingInActual.join(", ")}. ` +
          `Update ha-modules.d.ts to match the actual module API.`,
      ).toEqual([]);

      // Check that all actual exports are declared (warning only - some may be intentionally private)
      const missingInDeclared = actualExports.filter(
        (e) => !declaredExports.includes(e) && !e.startsWith("_"),
      );
      if (missingInDeclared.length > 0) {
        console.warn(
          `ha:${moduleName}: exports not in ha-modules.d.ts: ${missingInDeclared.join(", ")}`,
        );
      }
    });
  }
});
