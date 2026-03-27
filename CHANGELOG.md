# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [v0.1.5] - 2026-03-27

### Added

- **Windows WHP support** — HyperAgent now runs on Windows with hardware-isolated Hyperlight micro-VMs via Windows Hypervisor Platform (WHP)
  - Justfile: `[windows]` recipes for `build-hyperlight`, `resolve-hyperlight-dir`, `start-debug`
  - Justfile: `runtime-cflags` forward-slash fix for clang cross-compilation on Windows
  - `build-binary.js`: `.cmd` launcher and platform-aware post-build output with PowerShell instructions
  - `agent/index.ts`: `pathToFileURL()` for ESM plugin imports on Windows
  - `build.rs`: forward-slash CFLAGS for clang on Windows
  - `code-validator/guest`: `win32-x64-msvc` NAPI build target
  - `.gitattributes`: enforce LF line endings across platforms
  - `README.md`: document Windows WHP as supported prerequisite
- **CI Windows matrix** — `pr-validate.yml` now includes Windows WHP build/test entries; `publish.yml` updated for Windows builds
- **Deterministic VM dispose** — `invalidateSandbox()` now calls `dispose()` on `LoadedJSSandbox` and `JSSandbox` for deterministic VM resource cleanup instead of relying on V8 GC
- **PPTX ShapeFragment safety system** — Branded opaque type for shape builders with validation engine (#14)

### Fixed

- **Duplicate error messages** — `event-handler.ts` now suppresses duplicate "Tool execution failed" output when the handler has already displayed the error
- **MMIO error detection** — `sandbox/tool.js` detects MMIO unmapped-address errors in both compilation and runtime paths, providing clearer error messages
- **Plugin O_NOFOLLOW on Windows** — `fs-read` and `fs-write` plugins fall back gracefully when `O_NOFOLLOW` is unavailable (Windows), relying on `lstatSync` pre-check for symlink safety
- **Test Windows compatibility** — Symlink tests skip with EPERM on Windows (`path-jail`, `fs-read`, `fs-write`); `dts-sync` uses `rmSync` instead of shell `rm -rf`; `pattern-loader` uses unique `os.tmpdir()` paths to avoid Windows Defender EBUSY locks
- **CI docs-only job** — Added missing checkout step to docs-pr CI job (#12)
- **postinstall script** — Fixed missing closing brace in `package.json` postinstall `node -e` snippet

### Changed

- **Surrogate pool env vars** — `agent/index.ts` sets `HYPERLIGHT_INITIAL_SURROGATES=2` and `HYPERLIGHT_MAX_SURROGATES=24` on Windows
- **hyperlight-js dependency** — Updated to include `dispose()` API and npm audit fixes
- **Build system** — Eliminated `deps/hyperlight-js` git clone; Cargo dep now resolves hyperlight-js checkout via Cargo's git cache (#13)
- **npm scripts** — `prepare` and `postinstall` use `node -e` instead of POSIX shell for cross-platform compatibility

### Security

- **npm audit fixes** — Updated `picomatch` and `brace-expansion` across all workspaces (root, `code-validator/guest`, `deps/js-host-api`)

## [v0.1.4] - 2026-03-24

### Fixed

- **Plugin schema extraction** — Schema extraction failed on compiled `.js` files, causing `applyInlineConfig` to find no recognised keys and `allowedDomains` to never be set. Now prefers `.ts` source for schema parsing (read-only) with TOCTOU-safe fallback to `.js`
- **Pre-approved plugin enable** — Fast-path (approved plugins skip audit) failed to call `loadSource()`, leaving `plugin.source` null. `verifySourceHash()` then returned false, silently disabling the plugin on sandbox rebuild
- **CI docs-only skip** — PR validation now skips heavy CI jobs (lint, build, test) when only markdown files change. `skills/**` and `patterns/**` are treated as code (they have integrity tests)

## [v0.1.3] - 2026-03-24

### Fixed

- **Plugin loading under npm** — Plugins failed with "Stripping types is currently unsupported for files under node_modules" when installed via npm. Plugin loader now prefers compiled `.js` over `.ts` when running under `node_modules`, while still using `.ts` in dev mode for live editing
- **Plugin hash/approval consistency** — `computePluginHash()`, `loadSource()`, and `verifySourceHash()` now use centralised `resolvePluginSource()` helper to ensure hashing and import use the same file

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

[v0.1.4]: https://github.com/hyperlight-dev/hyperagent/releases/tag/v0.1.4
[v0.1.3]: https://github.com/hyperlight-dev/hyperagent/releases/tag/v0.1.3
[v0.1.2]: https://github.com/hyperlight-dev/hyperagent/releases/tag/v0.1.2
[v0.1.1]: https://github.com/hyperlight-dev/hyperagent/releases/tag/v0.1.1
[v0.1.0]: https://github.com/hyperlight-dev/hyperagent/releases/tag/v0.1.0
