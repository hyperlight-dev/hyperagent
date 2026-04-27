#!/usr/bin/env tsx
// ── Print saved Microsoft 365 / Agent 365 app registration details ───
//
// Cross-platform replacement for the bash `just mcp-m365-show` recipe.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface SavedState {
  clientId?: string;
  tenantId?: string;
  appName?: string;
  callbackPort?: number;
}

function main(): void {
  const stateFile = join(homedir(), ".hyperagent", "m365.json");
  if (!existsSync(stateFile)) {
    console.log("No saved M365 app. Run: just mcp-m365-create-app");
    return;
  }

  let state: SavedState;
  try {
    state = JSON.parse(readFileSync(stateFile, "utf8")) as SavedState;
  } catch (err) {
    console.error(`❌ Failed to read ${stateFile}: ${(err as Error).message}`);
    process.exit(1);
  }

  console.log("M365 app registration:");
  console.log(`  App name:      ${state.appName ?? "(unset)"}`);
  console.log(`  Client ID:     ${state.clientId ?? "(unset)"}`);
  console.log(`  Tenant ID:     ${state.tenantId ?? "(unset)"}`);
  console.log(`  Callback port: ${state.callbackPort ?? 8080}`);
  console.log(`  State file:    ${stateFile}`);
}

main();
