# Development Setup

This guide covers setting up a development environment for Hyperagent.

For contribution guidelines (issues, PRs, DCO), see [CONTRIBUTING.md](../CONTRIBUTING.md).

## Prerequisites

- **Linux with KVM**, **Azure Linux with MSHV**, or **Windows 11 with WHP**
- **Node.js 22+**
- **Rust toolchain** (for building native components)
- **just** command runner (`cargo install just`)
- **GitHub CLI** (`gh`) authenticated

## Build

```bash
git clone https://github.com/hyperlight-dev/hyperagent
cd hyperagent

# First-time setup — builds native addons, installs npm deps
just setup

# Verify setup
just test
```

## Running from Source

```bash
# Development mode (uses tsx for TypeScript)
npm start

# With flags
npm start -- --debug --verbose

# Run tests
npm test

# Type check
npm run typecheck

# Format code
npm run fmt

# Full quality gate (fmt + typecheck + test)
npm run check
```

## Project Structure

```
hyperagent/
├── src/                     # Source code (organised by domain)
│   ├── agent/               # CLI agent — REPL, commands, UI
│   │   ├── index.ts         # Main entry point (Copilot SDK, REPL loop)
│   │   ├── cli-parser.ts    # CLI argument parsing
│   │   ├── analysis-guest.ts # Code validation interface
│   │   ├── version.ts       # MinVer version calculation
│   │   ├── profiles.ts      # Resource profiles
│   │   ├── skill-loader.ts  # Skill discovery and loading
│   │   ├── tool-gating.ts   # SDK tool blocking
│   │   ├── transcript.ts    # Session transcript recording
│   │   ├── command-suggestions.ts # Slash command suggestions
│   │   ├── ansi.ts          # Terminal colors/formatting
│   │   ├── reverse-search.ts # Ctrl+R history search
│   │   └── ...
│   │
│   ├── plugin-system/       # Plugin lifecycle management
│   │   ├── manager.ts       # Plugin discovery and lifecycle
│   │   ├── auditor.ts       # LLM-based plugin security analysis
│   │   ├── types.ts         # Plugin type definitions
│   │   └── schema-types.ts  # Config schema types
│   │
│   ├── sandbox/             # Sandbox execution layer
│   │   ├── tool.js          # Sandbox tool (native binding)
│   │   ├── tool.d.ts        # Type declarations
│   │   └── runtime/         # Rust runtime with native modules
│   │
│   └── code-validator/      # Static code analysis
│       └── guest/           # Rust NAPI addon (code validation sandbox)
│
├── plugins/                 # Plugin implementations
│   ├── fs-read/             # Read-only filesystem access
│   ├── fs-write/            # Write-only filesystem access
│   ├── fetch/               # HTTPS fetch with SSRF protection
│   └── shared/              # Shared utilities (path-jail)
│
├── skills/                  # Domain expertise (markdown)
│   ├── pptx-expert/
│   ├── web-scraper/
│   ├── research-synthesiser/
│   └── ...
│
├── builtin-modules/         # Sandbox ES modules
│   ├── src/                 # TypeScript source (edit these)
│   └── *.json               # Compiled bundles (generated)
│
├── patterns/                # LLM code patterns
│   ├── file-generation/
│   ├── fetch-and-process/
│   └── ...
│
├── scripts/                 # Build utilities
│   ├── build-binary.js      # Binary builder (esbuild)
│   └── hyperagent-docker    # Docker wrapper script
│
├── tests/                   # Test suite
│   ├── *.test.ts            # Test files
│   └── fixtures/            # Test fixtures
│
├── docs/                    # Documentation
├── .github/workflows/       # CI/CD workflows
├── Dockerfile               # Multi-stage Docker build
├── Justfile                 # Task runner commands
├── package.json             # npm package config
└── tsconfig.json            # TypeScript config
```

## Key Files

| File | Purpose |
|------|---------|
| `src/agent/index.ts` | Main REPL loop, Copilot SDK integration |
| `src/plugin-system/manager.ts` | Plugin discovery, auditing, and lifecycle |
| `src/plugin-system/auditor.ts` | LLM-based plugin security analysis |
| `src/agent/analysis-guest.ts` | Code validation interface |
| `src/agent/tool-gating.ts` | Blocks SDK built-in tools |

## Generated Files - DO NOT EDIT

These files are auto-generated from source:

- `builtin-modules/*.json` — compiled from `builtin-modules/src/*.ts`
- `src/code-validator/guest/index.d.ts` — generated from Rust

To regenerate builtin modules:

```bash
npm run build:modules
```

## Plugins Must Be TypeScript

All plugins in `plugins/` must be `.ts` files. The test suite enforces this.

## Testing

```bash
# TypeScript tests only
just test                    # or: npm test

# Run specific test file
npm test -- tests/plugin-manager.test.ts

# Run with coverage
npm test -- --coverage

# Rust tests only
just test-analysis-guest      # Tests analysis-guest

# All tests (TS + Rust)
just test-all
```

### CI Platforms

Tests run on multiple hypervisors:
- Linux with KVM
- Azure Linux with MSHV
- Windows 11 with WHP (Hyper-V)

## Code Style

- **TypeScript**: Strict mode, Prettier formatting
- **Rust**: Standard rustfmt, clippy with `-D warnings`
- **Comments**: Use `// ──` section headers for organization

### Formatting & Linting

```bash
# TypeScript only
just fmt           # Format TS/JS
just lint          # Check format + typecheck

# Rust only
just fmt-analysis-guest  # Format analysis-guest Rust
just lint-analysis-guest # Clippy + format check for analysis-guest
just fmt-runtime         # Format runtime Rust
just lint-runtime        # Clippy + format check for runtime

# Everything (TS + Rust)
just fmt-all       # Format all code
just lint-all      # Lint all code
just test-all      # Run all tests
just check         # Full quality gate (lint-all + test-all)
```

## Building the Binary

```bash
# Development build
node scripts/build-binary.js

# Release build (optimized)
node scripts/build-binary.js --release

# Output: dist/bin/hyperagent
```

## Docker

```bash
# Build image (VERSION is required)
docker build --build-arg VERSION=0.0.0-dev -t hyperagent .

# Run with wrapper script (auto-detects hypervisor, recommended)
./scripts/hyperagent-docker

# Or manually with KVM
docker run -it --rm \
  --device=/dev/kvm \
  --group-add $(stat -c '%g' /dev/kvm) \
  --user "$(id -u):$(id -g)" \
  -e HOME=/home/hyperagent \
  -e GITHUB_TOKEN="$(gh auth token)" \
  -v "$HOME/.hyperagent:/home/hyperagent/.hyperagent" \
  -v "$HOME/.hyperagent/tmp:/tmp" \
  -v "$(pwd)":/workspace -w /workspace \
  hyperagent

# Or manually with MSHV (Azure Linux)
docker run -it --rm \
  --device=/dev/mshv \
  --group-add $(stat -c '%g' /dev/mshv) \
  --user "$(id -u):$(id -g)" \
  -e HOME=/home/hyperagent \
  -e GITHUB_TOKEN="$(gh auth token)" \
  -v "$HOME/.hyperagent:/home/hyperagent/.hyperagent" \
  -v "$HOME/.hyperagent/tmp:/tmp" \
  -v "$(pwd)":/workspace -w /workspace \
  hyperagent
```

> **Note:** The container runs as a non-root user for security. The `--user` flag maps the host UID/GID so volume mounts have correct permissions. The `--group-add` flag grants access to the hypervisor device.

## Further Reading

- [RELEASING.md](RELEASING.md) - Release process
- [../CONTRIBUTING.md](../CONTRIBUTING.md) - Contribution guidelines
- [ARCHITECTURE.md](ARCHITECTURE.md) - System architecture
