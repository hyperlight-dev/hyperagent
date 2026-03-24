#!/usr/bin/env npx tsx
/**
 * Extract available builtins from hyperlight-js-runtime source.
 *
 * This script parses the Rust source to find what globals and native modules
 * are available in the QuickJS sandbox. The output should be used to update
 * BUILTIN_METHODS and BUILTIN_FUNCTIONS in validator.rs.
 *
 * Run with: npx tsx scripts/extract-hyperlight-builtins.ts
 */

import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { execSync } from "child_process";

// Resolve hyperlight-js-runtime source from Cargo's git checkout via cargo metadata.
// The runtime crate is a dependency of our custom runtime, so cargo metadata knows where it is.
function resolveRuntimeSrc(): string {
  const metadata = JSON.parse(
    execSync(
      "cargo +1.89 metadata --format-version 1 --manifest-path src/sandbox/runtime/Cargo.toml",
      {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: 20 * 1024 * 1024,
        cwd: join(import.meta.dirname, ".."),
      },
    ),
  );
  const pkg = metadata.packages.find(
    (p: { name: string }) => p.name === "hyperlight-js-runtime",
  );
  if (!pkg) {
    console.error("❌ hyperlight-js-runtime not found in cargo metadata");
    process.exit(1);
  }
  return join(dirname(pkg.manifest_path), "src");
}

const RUNTIME_SRC = resolveRuntimeSrc();

interface Builtins {
  globals: string[];
  globalMethods: Record<string, string[]>;
  modules: Record<string, string[]>;
}

function extractFunctions(source: string): string[] {
  // Match #[rquickjs::function] pub fn name(...)
  const funcRegex = /#\[rquickjs::function(?:\([^)]*\))?\]\s*pub\s+fn\s+(\w+)/g;
  const funcs: string[] = [];
  let match;
  while ((match = funcRegex.exec(source)) !== null) {
    const name = match[1];
    if (name !== "default") funcs.push(name);
  }
  return funcs;
}

function extractMethods(source: string): string[] {
  // Match pub fn name(...) inside #[rquickjs::methods] impl blocks
  const methodsBlockRegex =
    /#\[rquickjs::methods\]\s*impl\s+\w+\s*\{([\s\S]*?)\n\}/g;
  const methodRegex = /pub\s+fn\s+(\w+)/g;
  const methods: string[] = [];
  let blockMatch;
  while ((blockMatch = methodsBlockRegex.exec(source)) !== null) {
    const block = blockMatch[1];
    let methodMatch;
    while ((methodMatch = methodRegex.exec(block)) !== null) {
      const name = methodMatch[1];
      if (name !== "new") methods.push(name);
    }
  }
  return methods;
}

function extractClasses(source: string): string[] {
  // Match #[rquickjs::class()] pub struct Name
  const classRegex =
    /#\[rquickjs::class(?:\([^)]*\))?\]\s*(?:#\[[^\]]*\]\s*)*pub\s+struct\s+(\w+)/g;
  const classes: string[] = [];
  let match;
  while ((match = classRegex.exec(source)) !== null) {
    classes.push(match[1]);
  }
  return classes;
}

const builtins: Builtins = {
  globals: [],
  globalMethods: {},
  modules: {},
};

// Parse modules directory
const modulesDir = join(RUNTIME_SRC, "modules");
for (const file of readdirSync(modulesDir)) {
  if (file === "mod.rs" || !file.endsWith(".rs")) continue;

  const moduleName = file.replace(".rs", "");
  const source = readFileSync(join(modulesDir, file), "utf-8");

  const funcs = extractFunctions(source);
  const methods = extractMethods(source);
  const classes = extractClasses(source);

  builtins.modules[moduleName] = [...funcs, ...classes];

  // Track class methods separately
  if (classes.length > 0 && methods.length > 0) {
    for (const cls of classes) {
      builtins.globalMethods[cls] = methods;
    }
  }
}

// Parse globals directory
const globalsDir = join(RUNTIME_SRC, "globals");
for (const file of readdirSync(globalsDir)) {
  if (file === "mod.rs" || !file.endsWith(".rs")) continue;

  const source = readFileSync(join(globalsDir, file), "utf-8");

  // Check what's added to globals
  if (source.includes('globals.prop("print"')) {
    builtins.globals.push("print");
  }
  if (source.includes('globals.prop("console"')) {
    builtins.globals.push("console");
    // Only log is available
    builtins.globalMethods["console"] = ["log"];
  }
  if (source.includes('globals.prop("require"')) {
    builtins.globals.push("require");
  }
  if (source.includes('string.prop("bytesFrom"')) {
    builtins.globalMethods["String"] = builtins.globalMethods["String"] || [];
    builtins.globalMethods["String"].push("bytesFrom");
  }
}

// Standard QuickJS builtins from Context::full()
const quickjsBuiltins = {
  globals: [
    // Constructors
    "Array",
    "Object",
    "String",
    "Number",
    "Boolean",
    "Symbol",
    "BigInt",
    "Function",
    "Error",
    "TypeError",
    "RangeError",
    "SyntaxError",
    "ReferenceError",
    "Date",
    "RegExp",
    "Promise",
    "Map",
    "Set",
    "WeakMap",
    "WeakSet",
    "Uint8Array",
    "Int8Array",
    "Uint16Array",
    "Int16Array",
    "Uint32Array",
    "Int32Array",
    "Float32Array",
    "Float64Array",
    "BigInt64Array",
    "BigUint64Array",
    "ArrayBuffer",
    "DataView",
    // Static objects
    "Math",
    "JSON",
    "Reflect",
    "Proxy",
    // Global functions
    "parseInt",
    "parseFloat",
    "isNaN",
    "isFinite",
    "decodeURI",
    "encodeURI",
    "decodeURIComponent",
    "encodeURIComponent",
    "eval",
  ],
  methods: {
    // Array methods
    Array: [
      "push",
      "pop",
      "shift",
      "unshift",
      "slice",
      "splice",
      "concat",
      "join",
      "map",
      "filter",
      "reduce",
      "reduceRight",
      "forEach",
      "find",
      "findIndex",
      "includes",
      "indexOf",
      "lastIndexOf",
      "every",
      "some",
      "flat",
      "flatMap",
      "fill",
      "sort",
      "reverse",
      "at",
      "entries",
      "keys",
      "values",
      "copyWithin",
      "toSorted",
      "toReversed",
      "toSpliced",
      "with",
    ],
    // String methods
    String: [
      "split",
      "trim",
      "trimStart",
      "trimEnd",
      "toLowerCase",
      "toUpperCase",
      "substring",
      "substr",
      "slice",
      "replace",
      "replaceAll",
      "match",
      "matchAll",
      "search",
      "charAt",
      "charCodeAt",
      "codePointAt",
      "startsWith",
      "endsWith",
      "padStart",
      "padEnd",
      "repeat",
      "normalize",
      "localeCompare",
      "includes",
      "indexOf",
      "lastIndexOf",
      "at",
      "concat",
    ],
    // Object methods
    Object: [
      "hasOwnProperty",
      "toString",
      "valueOf",
      "toJSON",
      "toLocaleString",
      "keys",
      "values",
      "entries",
      "assign",
      "freeze",
      "seal",
      "create",
      "defineProperty",
      "defineProperties",
      "getOwnPropertyDescriptor",
      "getOwnPropertyNames",
      "getOwnPropertySymbols",
      "getPrototypeOf",
      "setPrototypeOf",
      "is",
      "fromEntries",
    ],
    // Promise methods
    Promise: [
      "then",
      "catch",
      "finally",
      "all",
      "allSettled",
      "any",
      "race",
      "resolve",
      "reject",
    ],
    // JSON methods
    JSON: ["parse", "stringify"],
    // Math methods
    Math: [
      "abs",
      "ceil",
      "floor",
      "round",
      "max",
      "min",
      "random",
      "sqrt",
      "pow",
      "sign",
      "trunc",
      "log",
      "log10",
      "log2",
      "exp",
      "sin",
      "cos",
      "tan",
      "asin",
      "acos",
      "atan",
      "atan2",
      "sinh",
      "cosh",
      "tanh",
      "hypot",
      "cbrt",
    ],
    // Map/Set methods
    Map: [
      "get",
      "set",
      "has",
      "delete",
      "clear",
      "keys",
      "values",
      "entries",
      "forEach",
    ],
    Set: [
      "add",
      "has",
      "delete",
      "clear",
      "keys",
      "values",
      "entries",
      "forEach",
    ],
    // Date methods
    Date: [
      "getTime",
      "getFullYear",
      "getMonth",
      "getDate",
      "getDay",
      "getHours",
      "getMinutes",
      "getSeconds",
      "getMilliseconds",
      "setTime",
      "setFullYear",
      "setMonth",
      "setDate",
      "setHours",
      "setMinutes",
      "setSeconds",
      "setMilliseconds",
      "toISOString",
      "toJSON",
      "toDateString",
      "toTimeString",
      "toLocaleString",
    ],
    // RegExp methods
    RegExp: ["test", "exec", "toString"],
    // TypedArray methods (same for all typed arrays)
    TypedArray: [
      "set",
      "subarray",
      "slice",
      "fill",
      "copyWithin",
      "find",
      "findIndex",
      "indexOf",
      "lastIndexOf",
      "includes",
      "every",
      "some",
      "filter",
      "map",
      "reduce",
      "reduceRight",
      "forEach",
      "join",
      "reverse",
      "sort",
      "at",
    ],
    // ArrayBuffer methods
    ArrayBuffer: ["slice"],
    // DataView methods
    DataView: [
      "getInt8",
      "getUint8",
      "getInt16",
      "getUint16",
      "getInt32",
      "getUint32",
      "getFloat32",
      "getFloat64",
      "getBigInt64",
      "getBigUint64",
      "setInt8",
      "setUint8",
      "setInt16",
      "setUint16",
      "setInt32",
      "setUint32",
      "setFloat32",
      "setFloat64",
      "setBigInt64",
      "setBigUint64",
    ],
  },
};

// Merge hyperlight-specific builtins with QuickJS builtins
const allGlobals = new Set([...quickjsBuiltins.globals, ...builtins.globals]);
const allMethods = new Set<string>();

// Add QuickJS methods
for (const methods of Object.values(quickjsBuiltins.methods)) {
  for (const m of methods) allMethods.add(m);
}

// Add hyperlight-specific methods
for (const methods of Object.values(builtins.globalMethods)) {
  for (const m of methods) allMethods.add(m);
}

// Output
console.log("=== HYPERLIGHT-JS SANDBOX BUILTINS ===\n");

console.log("// Available globals (BUILTIN_FUNCTIONS):");
console.log("const BUILTIN_FUNCTIONS: &[&str] = &[");
for (const g of [...allGlobals].sort()) {
  console.log(`    "${g}",`);
}
console.log("];\n");

console.log("// Available methods (BUILTIN_METHODS):");
console.log("const BUILTIN_METHODS: &[&str] = &[");
for (const m of [...allMethods].sort()) {
  console.log(`    "${m}",`);
}
console.log("];\n");

console.log("=== NOT AVAILABLE (do not assume these exist) ===");
console.log("// These are commonly assumed but NOT in hyperlight-js:");
const notAvailable = [
  "setTimeout",
  "setInterval",
  "clearTimeout",
  "clearInterval",
  "fetch",
  "Request",
  "Response",
  "Headers",
  "console.warn",
  "console.error",
  "console.info",
  "console.debug",
  "console.trace",
  "console.table",
  "atob",
  "btoa",
  "TextEncoder",
  "TextDecoder",
  "URL",
  "URLSearchParams",
  "queueMicrotask",
  "structuredClone",
  "crypto.getRandomValues",
  "crypto.randomUUID",
];
for (const na of notAvailable) {
  console.log(`//   - ${na}`);
}

console.log("\n=== HYPERLIGHT-SPECIFIC ===");
console.log("// Custom globals added by hyperlight-js:");
for (const g of builtins.globals) {
  console.log(`//   - ${g}`);
}
console.log("// Custom modules:");
for (const [mod, funcs] of Object.entries(builtins.modules)) {
  console.log(`//   - ${mod}: ${funcs.join(", ")}`);
}
console.log("// Custom methods:");
for (const [obj, methods] of Object.entries(builtins.globalMethods)) {
  console.log(`//   - ${obj}.${methods.join(", ")}`);
}
