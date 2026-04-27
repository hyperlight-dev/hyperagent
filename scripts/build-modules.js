#!/usr/bin/env node
/**
 * Build builtin-modules and plugins from TypeScript source.
 *
 * This script:
 * 1. Generates .d.ts for native Rust modules
 * 2. Regenerates ha-modules.d.ts (so tsc can resolve native module imports)
 * 3. Compiles src/*.ts to .js and .d.ts
 * 4. Formats .js files with Prettier
 * 5. Auto-updates hashes in .json metadata files
 * 6. Compiles plugins to .d.ts
 * 7. Regenerates host-modules.d.ts
 */

import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, unlinkSync, readdirSync, statSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const BUILTIN_DIR = join(ROOT, "builtin-modules");
const PLUGINS_DIR = join(ROOT, "plugins");

console.log("Building builtin-modules from TypeScript source...");

// Step 0: Clean up stale files from renamed/removed modules (e.g. deflate → ziplib)
const STALE_FILES = [
  "deflate.js",
  "deflate.d.ts",
  "deflate.d.ts.map",
  "deflate.json",
];
for (const file of STALE_FILES) {
  const path = join(BUILTIN_DIR, file);
  if (existsSync(path)) {
    unlinkSync(path);
    console.log(`  🗑️  Removed stale: ${file}`);
  }
}

// Step 1: Generate .d.ts for native Rust modules (before tsc — needed for type resolution)
console.log("Generating native module .d.ts files...");
execSync("npx tsx scripts/generate-native-dts.ts", {
  cwd: ROOT,
  stdio: "inherit",
});

// Step 2: Compile TypeScript using the committed ha-modules.d.ts (which is
// up to date — enforced by tests/dts-sync.test.ts). tsc emits fresh .d.ts
// files for every src/*.ts module.
//
// This MUST run before regenerating ha-modules.d.ts. On a fresh checkout
// the gitignored builtin-modules/*.d.ts files don't exist yet — if we
// regenerated ha-modules.d.ts first it would be a partial file (only
// the 4 native modules are present), and tsc would then fail because
// the ambient `declare module "ha:ooxml-core"` block (etc) was wiped.
execSync("tsc --project tsconfig.json", { cwd: BUILTIN_DIR, stdio: "inherit" });

// Step 3: Regenerate ha-modules.d.ts from the now-fresh .d.ts files.
// Output should match the committed ha-modules.d.ts byte-for-byte, modulo
// any actual API changes the user just made — which is exactly what
// tests/dts-sync.test.ts catches.
console.log("\nGenerating ha-modules.d.ts...");
execSync("npx tsx scripts/generate-ha-modules-dts.ts", {
  cwd: ROOT,
  stdio: "inherit",
});

// Step 4: Format with Prettier
execSync(`prettier --write "${BUILTIN_DIR}/*.js"`, {
  cwd: ROOT,
  stdio: "inherit",
});

console.log("\nUpdating module hashes...");

// Step 5: Auto-update hashes in .json metadata files
execSync("npx tsx scripts/update-module-hashes.ts", {
  cwd: ROOT,
  stdio: "inherit",
});

// Step 6: Compile plugins (TypeScript → JS + declarations)
console.log("\nBuilding plugins...");
execSync("tsc --project tsconfig.json", { cwd: PLUGINS_DIR, stdio: "inherit" });

// Step 7: Validate plugin build output
// Every plugin index.ts and shared utility must have a compiled .js.
// Without this, plugins fail to load at runtime under the binary build
// (which uses Node, not tsx, and can't resolve .js → .ts).
console.log("\nValidating plugin build...");

const pluginDirs = readdirSync(PLUGINS_DIR).filter((name) => {
  const dir = join(PLUGINS_DIR, name);
  return statSync(dir).isDirectory() && existsSync(join(dir, "plugin.json"));
});

let pluginErrors = 0;
for (const name of pluginDirs) {
  const jsPath = join(PLUGINS_DIR, name, "index.js");
  if (!existsSync(jsPath)) {
    console.error(
      `  ❌ plugins/${name}/index.js missing — tsc did not emit JS`,
    );
    pluginErrors++;
  }
}

// Check shared utilities
const sharedDir = join(PLUGINS_DIR, "shared");
if (existsSync(sharedDir)) {
  const tsFiles = readdirSync(sharedDir).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".d.ts"),
  );
  for (const tsFile of tsFiles) {
    const jsFile = tsFile.replace(/\.ts$/, ".js");
    if (!existsSync(join(sharedDir, jsFile))) {
      console.error(
        `  ❌ plugins/shared/${jsFile} missing — tsc did not emit JS`,
      );
      pluginErrors++;
    }
  }
}

if (pluginErrors > 0) {
  console.error(`\n❌ ${pluginErrors} plugin file(s) missing compiled JS.`);
  console.error(
    "   Check plugins/tsconfig.json — emitDeclarationOnly must NOT be set.",
  );
  process.exit(1);
}
console.log(`  ✓ ${pluginDirs.length} plugins validated`);

// Step 8: Regenerate host-modules.d.ts
console.log("\nGenerating host-modules.d.ts...");
execSync("npx tsx scripts/generate-host-modules-dts.ts", {
  cwd: ROOT,
  stdio: "inherit",
});

console.log("✓ Build complete");
