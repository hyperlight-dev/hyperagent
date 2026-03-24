# Hyperagent - Claude Code Instructions

## Generated Files - DO NOT EDIT DIRECTLY

These files are auto-generated. Editing them directly will cause test failures.

### builtin-modules/*.js and *.d.ts

Generated from `builtin-modules/src/*.ts` by TypeScript compiler.

- **To modify**: Edit source in `builtin-modules/src/*.ts`
- **To regenerate**: Run `npm run build:modules`
- **Enforced by**: `tests/dts-sync.test.ts` compares compiled output to committed files

### src/code-validator/guest/index.d.ts

Generated from Rust source. Do not edit.

## Plugins - TypeScript Only

Plugins MUST be TypeScript files. The test suite enforces this.

- **Plugin source**: `plugins/<name>/index.ts`
- **Shared utilities**: `plugins/shared/*.ts`
- **Test fixtures**: `tests/fixtures/<name>/index.ts`
- **Enforced by**: `tests/plugin-source.test.ts` fails if `.js` files exist

### Current plugins:
- `plugins/fs-read/index.ts` - Read-only filesystem access
- `plugins/fs-write/index.ts` - Write-only filesystem access
- `plugins/fetch/index.ts` - Secure HTTPS fetching

## Build & Test

Use `just` commands for development (preferred) or npm scripts:

```bash
# ── Development ──
just setup         # First-time setup: build native addons, npm install
just build         # Rebuild native addons and install deps
just start         # Run agent (tsx src/agent/index.ts)

# ── Testing ──
just test          # Run TypeScript tests
just test-analysis-guest  # Run Rust tests (analysis-guest)
just test-all            # Run all tests (TS + Rust)

# ── Formatting ──
just fmt                 # Format TypeScript/JavaScript
just fmt-analysis-guest  # Format Rust (analysis-guest)
just fmt-runtime         # Format Rust (sandbox/runtime)
just fmt-all             # Format all code

# ── Linting ──
just lint                # TypeScript: fmt-check + typecheck
just lint-analysis-guest # Rust: clippy + fmt-check (analysis-guest)
just lint-runtime        # Rust: clippy + fmt-check (runtime)
just lint-all            # All lints

# ── Quality Gate ──
just check         # Full quality gate: lint-all + test-all

# ── npm equivalents ──
npm run start      # Run agent (tsx src/agent/index.ts)
npm run test       # Run TypeScript tests
npm run typecheck  # TypeScript type checking
npm run fmt        # Format with Prettier
npm run check      # fmt:check + typecheck + test
```
