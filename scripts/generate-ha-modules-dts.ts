#!/usr/bin/env npx tsx
/**
 * Generate ha-modules.d.ts from the compiled .d.ts files.
 *
 * This script reads all compiled .d.ts files in builtin-modules/ and
 * generates a single ha-modules.d.ts file with `declare module "ha:*"`
 * blocks for each module.
 *
 * Run: npx tsx scripts/generate-ha-modules-dts.ts
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join, basename } from "path";

const BUILTIN_DIR = join(import.meta.dirname, "..", "builtin-modules");
const TYPES_DIR = join(BUILTIN_DIR, "src", "types");
const OUTPUT_PATH = join(TYPES_DIR, "ha-modules.d.ts");

// Modules that should NOT be exposed in ha-modules.d.ts
const SKIP_MODULES = new Set(["_restore", "_save"]);

// Host module declarations (not generated from source)
const HOST_MODULES = `
// Host module type declarations
declare module "host:_binary-state" {
  export function set(key: string, value: Uint8Array): void;
  export function get(key: string): Uint8Array | undefined;
  export function del(key: string): boolean;
  export function clear(): void;
}
`;

function main() {
  // Find all .d.ts files in builtin-modules/
  const dtsFiles = readdirSync(BUILTIN_DIR)
    .filter((f) => f.endsWith(".d.ts"))
    .filter((f) => !SKIP_MODULES.has(basename(f, ".d.ts")));

  if (dtsFiles.length === 0) {
    console.error("No .d.ts files found. Run `npm run build:modules` first.");
    process.exit(1);
  }

  const blocks: string[] = [];

  for (const file of dtsFiles.sort()) {
    const moduleName = basename(file, ".d.ts");
    const content = readFileSync(join(BUILTIN_DIR, file), "utf-8");

    // Generate declare module block from the .d.ts content
    const block = generateDeclareBlock(moduleName, content);
    if (block) {
      blocks.push(block);
    }
  }

  // Generate the output
  const output = `// Type declarations for ha:* module imports
// AUTO-GENERATED from compiled .d.ts files — do not edit manually!
// Run: npx tsx scripts/generate-ha-modules-dts.ts

${blocks.join("\n\n")}
${HOST_MODULES}`;

  writeFileSync(OUTPUT_PATH, output);
  console.log(`Generated ${OUTPUT_PATH}`);
  console.log(`  ${dtsFiles.length} modules processed`);
}

/**
 * Generate a `declare module "ha:xxx" { ... }` block from a .d.ts file.
 *
 * Simply wraps the entire .d.ts content (minus imports) in a declare module block.
 * The .d.ts files already have proper export declarations.
 */
function generateDeclareBlock(moduleName: string, content: string): string {
  const lines = content.split("\n");
  const outputLines: string[] = [];

  for (const line of lines) {
    // Skip import statements
    if (line.trim().startsWith("import ")) continue;
    // Include everything else
    outputLines.push("  " + line);
  }

  // Remove trailing empty lines
  while (
    outputLines.length > 0 &&
    outputLines[outputLines.length - 1].trim() === ""
  ) {
    outputLines.pop();
  }

  if (outputLines.length === 0) {
    console.warn(`  Warning: no content found in ${moduleName}.d.ts`);
    return "";
  }

  return `declare module "ha:${moduleName}" {\n${outputLines.join("\n")}\n}`;
}

main();
