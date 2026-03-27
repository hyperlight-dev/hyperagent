#!/usr/bin/env npx tsx
/**
 * Update source/DTS hashes in builtin-modules/*.json files.
 *
 * Run with: npx tsx scripts/update-module-hashes.ts
 *
 * This script scans builtin-modules/ for .json files and updates
 * their sourceHash and dtsHash fields based on the corresponding
 * .js and .d.ts file contents.
 */

import { createHash } from "crypto";
import { readdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const BUILTIN_DIR = join(import.meta.dirname, "..", "builtin-modules");

interface ModuleJson {
  name: string;
  description: string;
  author: string;
  mutable: boolean;
  sourceHash?: string;
  dtsHash?: string;
  // Structured hints — preserved on hash updates
  hints?: Record<string, unknown>;
  [key: string]: unknown; // preserve any other fields
}

function hash(content: Buffer | string): string {
  const h = createHash("sha256").update(content).digest("hex");
  return "sha256:" + h.slice(0, 16);
}

let updated = 0;
let unchanged = 0;

for (const file of readdirSync(BUILTIN_DIR)) {
  if (!file.endsWith(".json")) continue;
  // Skip _restore.json and other internal modules that don't have .js files
  const name = file.replace(".json", "");
  const jsPath = join(BUILTIN_DIR, `${name}.js`);
  const dtsPath = join(BUILTIN_DIR, `${name}.d.ts`);
  const jsonPath = join(BUILTIN_DIR, file);

  if (!existsSync(jsPath)) {
    // Native module (no .js file) — still update dtsHash if .d.ts exists
    const meta: ModuleJson = JSON.parse(readFileSync(jsonPath, "utf-8"));
    if (existsSync(dtsPath)) {
      const dtsContent = readFileSync(dtsPath);
      const newDtsHash = hash(dtsContent);
      if (meta.dtsHash !== newDtsHash) {
        meta.dtsHash = newDtsHash;
        // Remove sourceHash if present (native modules have no .js)
        delete meta.sourceHash;
        writeFileSync(jsonPath, JSON.stringify(meta, null, 2) + "\n");
        console.log(`Updated: ${file} (native module)`);
        updated++;
      } else {
        unchanged++;
      }
    } else {
      unchanged++;
    }
    continue;
  }

  const meta: ModuleJson = JSON.parse(readFileSync(jsonPath, "utf-8"));

  const jsContent = readFileSync(jsPath);
  const newSourceHash = hash(jsContent);

  let newDtsHash: string | undefined;
  if (existsSync(dtsPath)) {
    const dtsContent = readFileSync(dtsPath);
    newDtsHash = hash(dtsContent);
  }

  let changed = false;
  if (meta.sourceHash !== newSourceHash) {
    meta.sourceHash = newSourceHash;
    changed = true;
  }
  if (newDtsHash && meta.dtsHash !== newDtsHash) {
    meta.dtsHash = newDtsHash;
    changed = true;
  } else if (!newDtsHash && meta.dtsHash) {
    // .d.ts was removed, clear hash
    delete meta.dtsHash;
    changed = true;
  }

  if (changed) {
    writeFileSync(jsonPath, JSON.stringify(meta, null, 2) + "\n");
    console.log(`Updated: ${file}`);
    updated++;
  } else {
    unchanged++;
  }
}

console.log(`\nDone: ${updated} updated, ${unchanged} unchanged`);
