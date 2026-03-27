#!/usr/bin/env npx tsx
/**
 * Generate host-modules.d.ts from compiled plugin .d.ts files.
 *
 * This script reads all compiled .d.ts files in plugins/<name>/index.d.ts and
 * generates a single host-modules.d.ts file with `declare module "host:*"`
 * blocks for each plugin's host modules.
 *
 * Run: npx tsx scripts/generate-host-modules-dts.ts
 */

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
} from "fs";
import { join, dirname } from "path";

const ROOT = dirname(import.meta.dirname);
const PLUGINS_DIR = join(ROOT, "plugins");
const OUTPUT_PATH = join(PLUGINS_DIR, "host-modules.d.ts");

function main() {
  // Find all plugin directories with index.d.ts
  const pluginDirs = readdirSync(PLUGINS_DIR).filter((name) => {
    const dir = join(PLUGINS_DIR, name);
    return (
      statSync(dir).isDirectory() &&
      name !== "shared" &&
      existsSync(join(dir, "index.d.ts"))
    );
  });

  if (pluginDirs.length === 0) {
    console.error("No plugin .d.ts files found. Run plugin build first.");
    process.exit(1);
  }

  const blocks: string[] = [];

  for (const pluginName of pluginDirs.sort()) {
    const dtsPath = join(PLUGINS_DIR, pluginName, "index.d.ts");
    const content = readFileSync(dtsPath, "utf-8");

    // Extract the host modules from the HostFunctions interface
    const hostModules = extractHostModules(pluginName, content);
    for (const block of hostModules) {
      blocks.push(block);
    }
  }

  // Generate the output
  const output = `// Type declarations for host:* plugin imports
// AUTO-GENERATED from compiled plugin .d.ts files — do not edit manually!
// Run: npx tsx scripts/generate-host-modules-dts.ts

${blocks.join("\n\n")}
`;

  writeFileSync(OUTPUT_PATH, output);
  console.log(`Generated ${OUTPUT_PATH}`);
  console.log(`  ${pluginDirs.length} plugins processed`);
}

/**
 * Extract a brace-balanced block starting at a given index.
 */
function extractBraceBlock(content: string, startIdx: number): string {
  let depth = 0;
  let started = false;
  let endIdx = startIdx;

  for (let i = startIdx; i < content.length; i++) {
    if (content[i] === "{") {
      depth++;
      started = true;
    } else if (content[i] === "}") {
      depth--;
      if (started && depth === 0) {
        endIdx = i + 1;
        break;
      }
    }
  }

  return content.slice(startIdx, endIdx);
}

/**
 * Extract host module declarations from a plugin's .d.ts file.
 *
 * Plugins export createHostFunctions() which returns { moduleName: InterfaceName }.
 * We find the HostFunctions interface to get the module->interface mapping,
 * then wrap each interface's content in a declare module block.
 */
function extractHostModules(pluginName: string, content: string): string[] {
  const blocks: string[] = [];

  // Find the HostFunctions interface (e.g., FetchHostFunctions)
  // This tells us which module name maps to which interface
  const hostFunctionsMatch = content.match(
    /export\s+interface\s+(\w+HostFunctions)\s*\{/,
  );
  if (!hostFunctionsMatch) {
    console.warn(
      `  Warning: No HostFunctions interface found in ${pluginName}`,
    );
    return blocks;
  }

  const hostFunctionsStart = hostFunctionsMatch.index!;
  const hostFunctionsBlock = extractBraceBlock(content, hostFunctionsStart);
  const hostFunctionsBody = hostFunctionsBlock.slice(
    hostFunctionsBlock.indexOf("{") + 1,
    hostFunctionsBlock.lastIndexOf("}"),
  );

  // Extract module name -> interface name mappings
  // e.g., 'fetch: FetchFunctions' or '"fs-read": FsReadFunctions'
  const moduleMatches = hostFunctionsBody.matchAll(
    /["']?([^"'\s:]+)["']?\s*:\s*(\w+)/g,
  );

  for (const [, moduleName, interfaceName] of moduleMatches) {
    // Find the interface definition
    const interfaceRegex = new RegExp(
      `export\\s+interface\\s+${interfaceName}\\s*\\{`,
    );
    const interfaceMatch = content.match(interfaceRegex);
    if (!interfaceMatch) {
      console.warn(
        `  Warning: Interface ${interfaceName} not found in ${pluginName}`,
      );
      continue;
    }

    const interfaceStart = interfaceMatch.index!;
    const interfaceBlock = extractBraceBlock(content, interfaceStart);

    // Extract just the body (between { and })
    const bodyStart = interfaceBlock.indexOf("{") + 1;
    const bodyEnd = interfaceBlock.lastIndexOf("}");
    const interfaceBody = interfaceBlock.slice(bodyStart, bodyEnd);

    // Convert interface methods to export function declarations
    // This is needed so the validator's extract_dts_metadata can find them
    const outputLines = convertToExportFunctions(interfaceBody);

    if (outputLines.length > 0) {
      const block = `declare module "host:${moduleName}" {\n${outputLines.join("\n")}\n}`;
      blocks.push(block);
    }
  }

  return blocks;
}

/**
 * Unwrap Promise<T> to just T, since the host bridge resolves promises
 * synchronously before returning to the guest.
 * Handles nested generics like Promise<A | B> correctly.
 */
function unwrapPromise(type: string): string {
  const trimmed = type.trim();
  // Check if it starts with Promise<
  if (!trimmed.startsWith("Promise<")) {
    return trimmed;
  }
  // Find the matching closing > by tracking depth
  let depth = 0;
  let start = -1;
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === "<") {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (trimmed[i] === ">") {
      depth--;
      if (depth === 0) {
        // Extract the inner type
        return trimmed.slice(start, i);
      }
    }
  }
  return trimmed;
}

/**
 * Convert interface method declarations to export function declarations.
 *
 * Transforms:
 *   methodName(params): ReturnType;
 *   methodName: (params) => ReturnType;
 *
 * Into:
 *   export declare function methodName(params): ReturnType;
 *
 * NOTE: Promise<T> return types are unwrapped to just T because the host bridge
 * resolves promises synchronously before returning to the guest. The guest code
 * receives the resolved value directly, not a Promise object.
 */
function convertToExportFunctions(interfaceBody: string): string[] {
  const outputLines: string[] = [];

  // Collect entries: { comment?, signature }
  const entries: Array<{ comment?: string; signature: string }> = [];

  let i = 0;
  const src = interfaceBody;

  while (i < src.length) {
    // Skip whitespace
    while (i < src.length && /\s/.test(src[i])) i++;
    if (i >= src.length) break;

    // Collect JSDoc comment
    let comment: string | undefined;
    if (src[i] === "/" && src[i + 1] === "*" && src[i + 2] === "*") {
      let c = "";
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        c += src[i];
        i++;
      }
      c += "*/";
      i += 2;
      comment = c;

      // Skip whitespace after comment
      while (i < src.length && /\s/.test(src[i])) i++;
    }

    // Collect method signature until semicolon (tracking depth)
    if (i < src.length && /[a-zA-Z_]/.test(src[i])) {
      let sig = "";
      let depth = 0;
      while (i < src.length) {
        const c = src[i];
        // Track depth for (), {}, <> but NOT for => arrow
        if (c === "(" || c === "{") depth++;
        if (c === ")" || c === "}") depth--;
        // Only count < and > if they're not part of => or >=, <=
        if (c === "<" && src[i - 1] !== "=" && src[i - 1] !== "!") depth++;
        if (c === ">" && src[i + 1] !== "=" && src[i - 1] !== "=") depth--;
        sig += c;
        i++;
        if (c === ";" && depth === 0) break;
      }
      entries.push({ comment, signature: sig.trim() });
    } else {
      i++;
    }
  }

  // Convert each entry
  for (const entry of entries) {
    if (entry.comment) {
      const indented = entry.comment
        .split("\n")
        .map((l) => "  " + l.trim())
        .join("\n");
      outputLines.push(indented);
    }

    const sig = entry.signature.replace(/;$/, "");

    // Check if it's arrow syntax: name: (params) => ReturnType
    const arrowIdx = sig.indexOf("=>");
    if (arrowIdx !== -1) {
      // Arrow syntax
      const colonIdx = sig.indexOf(":");
      if (colonIdx !== -1 && colonIdx < arrowIdx) {
        const name = sig.slice(0, colonIdx).trim();
        const rest = sig.slice(colonIdx + 1).trim(); // (params) => ReturnType

        // Find the params part - from ( to the matching )
        const parenStart = rest.indexOf("(");
        if (parenStart !== -1) {
          let depth = 0;
          let parenEnd = -1;
          for (let j = parenStart; j < rest.length; j++) {
            if (rest[j] === "(") depth++;
            if (rest[j] === ")") {
              depth--;
              if (depth === 0) {
                parenEnd = j;
                break;
              }
            }
          }
          if (parenEnd !== -1) {
            const params = rest.slice(parenStart, parenEnd + 1);
            const returnType = unwrapPromise(
              rest.slice(rest.indexOf("=>") + 2).trim(),
            );
            outputLines.push(
              `  export declare function ${name}${params}: ${returnType};`,
            );
            continue;
          }
        }
      }
    }

    // Method syntax: name(params): ReturnType
    const parenIdx = sig.indexOf("(");
    if (parenIdx !== -1) {
      const name = sig.slice(0, parenIdx).trim();

      // Find params end
      let depth = 0;
      let parenEnd = -1;
      for (let j = parenIdx; j < sig.length; j++) {
        if (sig[j] === "(") depth++;
        if (sig[j] === ")") {
          depth--;
          if (depth === 0) {
            parenEnd = j;
            break;
          }
        }
      }

      if (parenEnd !== -1) {
        const params = sig.slice(parenIdx, parenEnd + 1);
        // After params should be ": ReturnType"
        const afterParams = sig.slice(parenEnd + 1).trim();
        if (afterParams.startsWith(":")) {
          const returnType = unwrapPromise(afterParams.slice(1).trim());
          outputLines.push(
            `  export declare function ${name}${params}: ${returnType};`,
          );
        }
      }
    }
  }

  return outputLines;
}

main();
