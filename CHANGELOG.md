# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [v0.1.2] - 2026-03-23

### Fixed

- **npm global install** — Launcher script now resolves symlinks before computing lib/ path, fixing `Cannot find module 'hyperagent-launcher.cjs'` when installed via `npm install -g` (symlink from npm bin dir broke relative path resolution)
- **PATH invocation** — Handle bare command name (no slash in `$0`) by resolving via `command -v` before symlink resolution

## [v0.1.1] - 2026-03-23

### Fixed

- **Version display** — Strip leading "v" prefix from `VERSION` env var and build-time injection to prevent "vv0.1.0" in banner display
- **Plugin validation** — Reject plugin manifest versions with "v" prefix (e.g. "v1.0.0") to prevent double-prefix in display
- **npm install** — Skip `postinstall`/`prepare` scripts gracefully when installed as a published npm package (scripts only exist in the source repo)
- **Rust lint** — Fix clippy errors: `unwrap_used`, `manual_strip`, dead code, `needless_range_loop`; allow `expect_used` on static regex patterns in plugin scanner

### Changed

- **CI quality gate** — PR validation now runs `just lint-all` + `just test-all`, adding Rust clippy and fmt checks that were previously missing
- **npm registry** — Publish to npmjs.org (public) instead of GitHub Packages (required custom registry config)
- **Just recipes renamed** — `lint-rust` → `lint-analysis-guest`, `fmt-rust` → `fmt-analysis-guest`, `test-rust` → `test-analysis-guest` for clarity
- **Rust formatting** — Applied `cargo fmt` across all Rust workspaces (analysis-guest and sandbox runtime)
- **cfg(hyperlight)** — Added `check-cfg` to `native-globals` Cargo.toml to silence warnings

## [v0.1.0] - 2026-03-20

Initial public release.

### Added

- **Core Agent**
  - Interactive REPL with GitHub Copilot SDK integration
  - Sandboxed JavaScript execution in Hyperlight micro-VMs
  - MinVer-style versioning from git tags
  - Session management with persistence and resume
  - Context compaction for infinite conversations
  - Multi-model support with mid-conversation switching

- **Plugin System**
  - `fs-read` - Read-only filesystem access (path-jailed)
  - `fs-write` - Write-only filesystem access (path-jailed)
  - `fetch` - HTTPS fetch with SSRF protection
  - LLM-based plugin security auditing with canary verification
  - Plugin approval persistence with content-hash invalidation

- **Skills System**
  - Domain expertise via markdown files with YAML frontmatter
  - Auto-matching via trigger keywords
  - Tool restrictions per skill
  - Built-in skills: pptx-expert, web-scraper, research-synthesiser, data-processor, report-builder, api-explorer

- **Patterns System**
  - Code generation templates for common tasks
  - Built-in patterns: two-handler-pipeline, file-generation, fetch-and-process, data-transformation, data-extraction, image-embed

- **Resource Profiles**
  - Bundled limit and plugin presets
  - Stackable profiles (max limits, union of plugins)
  - Built-in profiles: default, file-builder, web-research, heavy-compute

- **Module System**
  - Built-in modules: str-bytes, crc32, base64, xml-escape, deflate, zip-format, ooxml-core, pptx, pptx-charts, pptx-tables
  - User-defined modules persisted to ~/.hyperagent/modules/
  - Shared state across handler recompiles via ha:shared-state

- **Code Validation**
  - Pre-execution validation in isolated Rust guest (hyperlight-analysis-guest)
  - QuickJS parser for syntax checking
  - Import validation against available modules
  - Plugin source scanning for dangerous patterns

- **CLI Features**
  - Non-interactive mode with `--prompt` and `--auto-approve`
  - Slash commands for runtime configuration
  - Command suggestions extracted from LLM output
  - Ctrl+R reverse history search
  - Session transcript recording

### Security

- Hardware isolation via Hyperlight micro-VMs (KVM/MSHV/WHP)
- Tool gating blocks all SDK built-in tools (bash, edit, grep, read, write)
- LLM-based plugin security auditing with anti-prompt-injection canaries
- Code validation before execution in isolated sandbox
- Path jailing for filesystem plugins
- SSRF protection for fetch plugin (DNS + post-connect IP validation)

[v0.1.2]: https://github.com/hyperlight-dev/hyperagent/releases/tag/v0.1.2
[v0.1.1]: https://github.com/hyperlight-dev/hyperagent/releases/tag/v0.1.1
[v0.1.0]: https://github.com/hyperlight-dev/hyperagent/releases/tag/v0.1.0
