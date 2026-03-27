#!/usr/bin/env node

// ── Build HyperAgent Standalone Distribution ───────────────────────────
//
// Creates a standalone hyperagent distribution with bundled JS and native addons.
// The result is a self-contained directory that can be added to PATH.
//
// Usage:
//   node scripts/build-binary.js [--release]
//
// Output:
//   dist/bin/hyperagent       - Launcher script (add to PATH or symlink)
//   dist/lib/                 - Bundled JS and native addons
//
// After build:
//   export PATH="$PWD/dist/bin:$PATH"
//   hyperagent
//
// Or create a symlink:
//   sudo ln -sf $PWD/dist/bin/hyperagent /usr/local/bin/hyperagent
//
// ────────────────────────────────────────────────────────────────────────

import { spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  chmodSync,
  existsSync,
  readdirSync,
  statSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DIST = join(ROOT, "dist");
const BIN_DIR = join(DIST, "bin");
const LIB_DIR = join(DIST, "lib");

const isRelease = process.argv.includes("--release");
const mode = isRelease ? "release" : "debug";

console.log(`\n🔨 Building HyperAgent (${mode} mode)...\n`);

// ── Step 1: Prepare directories ────────────────────────────────────────
mkdirSync(BIN_DIR, { recursive: true });
mkdirSync(LIB_DIR, { recursive: true });

// ── Step 2: Calculate version (MinVer-style) ───────────────────────────
function parseGitDescribe(describe) {
  const dirty = describe.endsWith("-dirty");
  const clean = describe.replace(/-dirty$/, "");

  // Just a commit hash (no tags exist)
  if (/^[a-f0-9]+$/i.test(clean)) {
    try {
      const countResult = spawnSync("git", ["rev-list", "--count", "HEAD"], {
        cwd: ROOT,
        encoding: "utf-8",
      });
      const count = countResult.status === 0 ? countResult.stdout.trim() : "0";
      return `0.0.0-alpha.${count}+${clean}${dirty ? ".dirty" : ""}`;
    } catch {
      return `0.0.0-alpha.0+${clean}${dirty ? ".dirty" : ""}`;
    }
  }

  // v0.1.0-5-gabc1234 format (git describe --tags --long output)
  const match = clean.match(/^v?(\d+\.\d+\.\d+)-(\d+)-g([a-f0-9]+)$/i);
  if (match) {
    const [, version, height, commit] = match;
    if (height === "0") {
      // Exactly on tag
      return dirty ? `${version}+dirty` : version;
    }
    // Bump patch for prerelease
    const [major, minor, patch] = version.split(".").map(Number);
    return `${major}.${minor}.${patch + 1}-alpha.${height}+${commit}${dirty ? ".dirty" : ""}`;
  }

  // Just a tag (git describe --tags without --long)
  const tagMatch = clean.match(/^v?(\d+\.\d+\.\d+)$/);
  if (tagMatch) {
    return dirty ? `${tagMatch[1]}+dirty` : tagMatch[1];
  }

  return "0.0.0-dev";
}

function calculateMinVer() {
  // Allow override via environment (for Docker/CI)
  if (process.env.VERSION) {
    // Strip leading "v" if present — callers add their own prefix
    return process.env.VERSION.replace(/^v/i, "");
  }
  try {
    const result = spawnSync(
      "git",
      ["describe", "--tags", "--long", "--always", "--dirty"],
      {
        cwd: ROOT,
        encoding: "utf-8",
      },
    );
    if (result.status !== 0) return "0.0.0-dev";
    return parseGitDescribe(result.stdout.trim());
  } catch {
    return "0.0.0-dev";
  }
}

const version = calculateMinVer();
console.log(`📦 Version: ${version}`);

// ── Step 3: Bundle TypeScript to single JS file ────────────────────────
console.log("📦 Bundling with esbuild...");

// Use esbuild API directly (cross-platform, no npx/cmd issues)
const esbuild = await import("esbuild");
const bannerJs = [
  "const __bundled_import_meta_url = require('url').pathToFileURL(__filename).href;",
  "const __bundled_import_meta_resolve = (specifier) => {",
  "  const LIB_DIR = process.env.HYPERAGENT_LIB_DIR || require('path').dirname(__filename);",
  "  if (specifier === '@github/copilot/sdk') {",
  "    return require('url').pathToFileURL(require('path').join(LIB_DIR, 'node_modules/@github/copilot/sdk/index.js')).href;",
  "  }",
  "  const { createRequire } = require('node:module');",
  "  const req = createRequire(__filename);",
  "  return require('url').pathToFileURL(req.resolve(specifier)).href;",
  "};",
].join("");

try {
  await esbuild.build({
    entryPoints: [join(ROOT, "src/agent/index.ts")],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    outfile: join(LIB_DIR, "hyperagent.cjs"),
    banner: { js: bannerJs },
    define: {
      "import.meta.url": "__bundled_import_meta_url",
      "import.meta.resolve": "__bundled_import_meta_resolve",
      __HYPERAGENT_VERSION__: JSON.stringify(version),
    },
    external: ["@hyperlight/js-host-api", "hyperlight-analysis", "fsevents"],
    ...(isRelease ? { minify: true, treeShaking: true } : {}),
    ...(!isRelease ? { keepNames: true, sourcemap: "inline" } : {}),
  });
} catch (e) {
  console.error("❌ esbuild bundling failed:", e.message);
  process.exit(1);
}

// ── Step 4: Copy native addons ─────────────────────────────────────────
console.log("📋 Copying native addons...");

// Detect napi-rs triple for the current platform
const tripleMap = {
  "linux-x64-gnu": "linux-x64-gnu",
  "linux-x64-musl": "linux-x64-musl",
  "win32-x64": "win32-x64-msvc",
};

// Detect musl vs glibc on Linux (same logic as napi-rs generated index.js)
function isMusl() {
  if (process.platform !== "linux") return false;
  try {
    const result = spawnSync("ldd", ["--version"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const output = (result.stdout || "") + (result.stderr || "");
    return output.includes("musl");
  } catch {
    return false;
  }
}

const platformKey =
  process.platform === "linux"
    ? `linux-${process.arch}-${isMusl() ? "musl" : "gnu"}`
    : `${process.platform}-${process.arch}`;
const napiTriple = tripleMap[platformKey];
if (!napiTriple) {
  console.error(`❌ Unsupported platform: ${platformKey}`);
  console.error("   Supported: linux-x64 (glibc/musl), win32-x64");
  process.exit(1);
}
console.log(`  Platform: ${platformKey} → ${napiTriple}`);

const hyperlightNode = join(
  ROOT,
  `deps/js-host-api/js-host-api.${napiTriple}.node`,
);
const analysisNode = join(
  ROOT,
  `src/code-validator/guest/host/hyperlight-analysis.${napiTriple}.node`,
);

if (!existsSync(hyperlightNode)) {
  console.error(
    `❌ hyperlight-js native addon not found at:\n   ${hyperlightNode}\n   Run 'just build' first.`,
  );
  process.exit(1);
}
if (!existsSync(analysisNode)) {
  console.error(
    `❌ hyperlight-analysis native addon not found at:\n   ${analysisNode}\n   Run 'just build' first.`,
  );
  process.exit(1);
}

copyFileSync(hyperlightNode, join(LIB_DIR, `js-host-api.${napiTriple}.node`));
copyFileSync(
  analysisNode,
  join(LIB_DIR, `hyperlight-analysis.${napiTriple}.node`),
);

// Create a proper node_modules package structure for hyperlight-analysis
// so both require() and import() can resolve it in the bundled binary.
const analysisPkgDir = join(LIB_DIR, "node_modules", "hyperlight-analysis");
mkdirSync(analysisPkgDir, { recursive: true });
copyFileSync(
  analysisNode,
  join(analysisPkgDir, `hyperlight-analysis.${napiTriple}.node`),
);
// Copy the index.js and index.d.ts from the source package
const analysisIndex = join(ROOT, "src/code-validator/guest/index.js");
const analysisTypes = join(ROOT, "src/code-validator/guest/index.d.ts");
const analysisPkg = join(ROOT, "src/code-validator/guest/package.json");
if (existsSync(analysisIndex))
  copyFileSync(analysisIndex, join(analysisPkgDir, "index.js"));
if (existsSync(analysisTypes))
  copyFileSync(analysisTypes, join(analysisPkgDir, "index.d.ts"));
if (existsSync(analysisPkg))
  copyFileSync(analysisPkg, join(analysisPkgDir, "package.json"));

// Copy the JS wrapper (lib.js) that provides Promise wrappers, error
// enrichment, and Buffer conversion for host function callbacks.
// Without this, the native addon's HostModule.register() receives raw
// return values instead of Promises, causing napi-rs validate_promise
// failures ("InvalidArg, Call the PromiseRaw::then failed").
// Files are renamed to .cjs because the host package.json has "type": "module"
// which makes Node.js treat .js as ESM — but lib.js uses require().
const hyperlightLibJs = join(ROOT, "deps/js-host-api/lib.js");
const hyperlightHostApiDir = join(LIB_DIR, "js-host-api");
mkdirSync(hyperlightHostApiDir, { recursive: true });
copyFileSync(
  hyperlightNode,
  join(hyperlightHostApiDir, `js-host-api.${napiTriple}.node`),
);
// Copy lib.js as lib.cjs, patching the require('./index.js') to './index.cjs'
const libJsContent = readFileSync(hyperlightLibJs, "utf-8").replace(
  "require('./index.js')",
  "require('./index.cjs')",
);
writeFileSync(join(hyperlightHostApiDir, "lib.cjs"), libJsContent);
// Create a minimal index.cjs shim that loads the .node addon from the
// same directory. Platform-specific .node file is resolved at build time.
writeFileSync(
  join(hyperlightHostApiDir, "index.cjs"),
  `'use strict';\nmodule.exports = require('./js-host-api.${napiTriple}.node');\n`,
);

// ── Step 5: Copy runtime resources ─────────────────────────────────────
console.log("📁 Copying runtime resources...");

// Copy builtin-modules (needed at runtime for sandbox)
const builtinSrc = join(ROOT, "builtin-modules");
const builtinDst = join(LIB_DIR, "builtin-modules");
mkdirSync(builtinDst, { recursive: true });

function copyDirRecursive(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const dstPath = join(dst, entry);
    const stat = statSync(srcPath);
    if (stat.isDirectory()) {
      copyDirRecursive(srcPath, dstPath);
    } else {
      copyFileSync(srcPath, dstPath);
    }
  }
}

if (existsSync(builtinSrc)) {
  copyDirRecursive(builtinSrc, builtinDst);
}

// Copy plugins
const pluginsSrc = join(ROOT, "plugins");
const pluginsDst = join(LIB_DIR, "plugins");
if (existsSync(pluginsSrc)) {
  copyDirRecursive(pluginsSrc, pluginsDst);
}

// Validate copied plugins — every plugin must have a compiled index.js
// and shared utilities must have .js companions. The binary uses Node
// (not tsx) so .ts files can't be imported without a .js counterpart.
console.log("🔍 Validating plugins...");
const copiedPlugins = readdirSync(pluginsDst).filter((name) => {
  const dir = join(pluginsDst, name);
  return statSync(dir).isDirectory() && existsSync(join(dir, "plugin.json"));
});
let pluginValidationErrors = 0;
for (const name of copiedPlugins) {
  const jsPath = join(pluginsDst, name, "index.js");
  if (!existsSync(jsPath)) {
    console.error(
      `   ❌ plugins/${name}/index.js missing in dist — run 'npm run build:modules' first`,
    );
    pluginValidationErrors++;
  }
}
const sharedDst = join(pluginsDst, "shared");
if (existsSync(sharedDst)) {
  const tsFiles = readdirSync(sharedDst).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".d.ts"),
  );
  for (const tsFile of tsFiles) {
    const jsFile = tsFile.replace(/\.ts$/, ".js");
    if (!existsSync(join(sharedDst, jsFile))) {
      console.error(
        `   ❌ plugins/shared/${jsFile} missing in dist — run 'npm run build:modules' first`,
      );
      pluginValidationErrors++;
    }
  }
}
if (pluginValidationErrors > 0) {
  console.error(
    `\n❌ ${pluginValidationErrors} plugin file(s) missing compiled JS in dist.`,
  );
  console.error("   Run 'npm run build:modules' before building the binary.");
  process.exit(1);
}
console.log(`   ✓ ${copiedPlugins.length} plugins validated`);

// Copy skills
const skillsSrc = join(ROOT, "skills");
const skillsDst = join(LIB_DIR, "skills");
if (existsSync(skillsSrc)) {
  copyDirRecursive(skillsSrc, skillsDst);
}

// Copy @github/copilot CLI (needed by copilot-sdk at runtime)
// The SDK uses import.meta.resolve("@github/copilot/sdk") to find the CLI
console.log("📦 Copying Copilot CLI runtime...");
const copilotSrc = join(ROOT, "node_modules/@github/copilot");
const copilotDst = join(LIB_DIR, "node_modules/@github/copilot");
if (existsSync(copilotSrc)) {
  copyDirRecursive(copilotSrc, copilotDst);
}

// ── Step 6: Create launcher script ─────────────────────────────────────
console.log("📝 Creating launcher...");

// The launcher needs to set up module resolution for native addons
// We use a shell wrapper that invokes node with explicit CommonJS treatment
const launcher = `#!/bin/sh
# HyperAgent Launcher - resolves native addons from lib/ directory
# When invoked via PATH, $0 may be a bare name (no slash). Resolve it first.
SELF="$0"
case "$SELF" in */*) ;; *) SELF="$(command -v -- "$SELF")" ;; esac
# Resolve symlinks so this works when npm links the bin globally
SELF="$(readlink -f "$SELF" 2>/dev/null || realpath "$SELF" 2>/dev/null || echo "$SELF")"
SCRIPT_DIR="$(cd "$(dirname "$SELF")" && pwd)"
exec node --no-warnings "\${SCRIPT_DIR}/../lib/hyperagent-launcher.cjs" "$@"
`;

// The actual launcher logic in CommonJS
const launcherCjs = `// HyperAgent Launcher - resolves native addons from lib/ directory
const { dirname, join } = require('node:path');
const Module = require('node:module');

const LIB_DIR = __dirname;

// Add our bundled node_modules to the search path
// This is needed for import.meta.resolve to find @github/copilot
const bundledNodeModules = join(LIB_DIR, 'node_modules');
if (!process.env.NODE_PATH) {
  process.env.NODE_PATH = bundledNodeModules;
} else {
  process.env.NODE_PATH = bundledNodeModules + (process.platform === 'win32' ? ';' : ':') + process.env.NODE_PATH;
}
// Re-initialize module paths after updating NODE_PATH
Module._initPaths();

// Patch module resolution to find native addons in our lib/ directory
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === '@hyperlight/js-host-api') {
    // Load via lib.cjs (not the raw .node) to get Promise wrappers,
    // error enrichment, and Buffer conversion for host function callbacks.
    return originalLoad.call(this, join(LIB_DIR, 'js-host-api', 'lib.cjs'), parent, isMain);
  }
  if (request === 'hyperlight-analysis') {
    return originalLoad.call(this, join(LIB_DIR, 'hyperlight-analysis.${napiTriple}.node'), parent, isMain);
  }
  return originalLoad.apply(this, arguments);
};

// Set environment for resource discovery
process.env.HYPERAGENT_LIB_DIR = LIB_DIR;

// Run the bundled agent
require(join(LIB_DIR, 'hyperagent.cjs'));
`;

const launcherCjsPath = join(LIB_DIR, "hyperagent-launcher.cjs");
writeFileSync(launcherCjsPath, launcherCjs);

// Create all three launchers so the package works on any platform:
// 1. hyperagent     — Node.js ESM script (npm bin entry point)
// 2. hyperagent.sh  — Unix shell wrapper
// 3. hyperagent.cmd — Windows batch wrapper

// Node.js launcher (works everywhere, used as npm bin entry)
const nodeLauncher = `#!/usr/bin/env node
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const cjs = join(__dirname, '..', 'lib', 'hyperagent-launcher.cjs');
await import(pathToFileURL(cjs).href);
`;
const nodeLauncherPath = join(BIN_DIR, "hyperagent");
writeFileSync(nodeLauncherPath, nodeLauncher);
try {
  chmodSync(nodeLauncherPath, 0o755);
} catch {
  /* Windows */
}

// Shell launcher
const shellPath = join(BIN_DIR, "hyperagent.sh");
writeFileSync(shellPath, launcher);
try {
  chmodSync(shellPath, 0o755);
} catch {
  /* Windows */
}

// Windows batch launcher
const launcherCmd = `@echo off\r\nnode --no-warnings "%~dp0..\\lib\\hyperagent-launcher.cjs" %*\r\n`;
const cmdPath = join(BIN_DIR, "hyperagent.cmd");
writeFileSync(cmdPath, launcherCmd);

const launcherPath = nodeLauncherPath;

// ── Step 7: Report results ─────────────────────────────────────────────
function dirSize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      total += dirSize(path);
    } else {
      total += stat.size;
    }
  }
  return total;
}

const bundleSize = (
  statSync(join(LIB_DIR, "hyperagent.cjs")).size / 1024
).toFixed(0);
const totalSize = (dirSize(DIST) / 1024 / 1024).toFixed(1);

const isWindows = process.platform === "win32";
const libDisplay = isWindows ? `${LIB_DIR}\\` : `${LIB_DIR}/`;
// On Windows, the .cmd launcher is the primary entry point
const primaryLauncher = isWindows ? cmdPath : launcherPath;

const runInstructions = isWindows
  ? `To run (option 1 - direct):
  ${cmdPath}

To run (option 2 - add to PATH in PowerShell):
  $env:PATH = "${BIN_DIR};$env:PATH"
  hyperagent

To run (option 3 - add to PATH permanently via System Properties):
  Add "${BIN_DIR}" to your PATH environment variable`
  : `To run (option 1 - direct):
  ${launcherPath}

To run (option 2 - add to PATH):
  export PATH="${BIN_DIR}:$PATH"
  hyperagent

To run (option 3 - symlink):
  sudo ln -sf ${launcherPath} /usr/local/bin/hyperagent
  hyperagent`;

console.log(`
✅ Build complete!

Launcher:  ${primaryLauncher}
Libraries: ${libDisplay}
Bundle:    ${bundleSize} KB (${mode})
Total:     ${totalSize} MB

${runInstructions}

${isRelease ? "🚀 Release build - optimized and minified" : "🐛 Debug build - includes sourcemaps"}
`);
