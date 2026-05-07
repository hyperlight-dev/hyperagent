# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [v0.5.0] - 2026-05-07

### Added

- **Estimated cost in token display** — Per-request and session-level cost estimates based on model list pricing (Claude, OpenAI, Gemini). Shows cache savings breakdown. New `getModelPricing()` and `estimateCost()` exports for reuse (#114)
- **Actionable limit error messages** — Every plugin error about a breached configurable limit now tells the LLM which config field to increase via `manage_plugin` (21 messages across fs-read, fs-write, fetch) (#112)
- **Configurable plugin limits** — Previously hardcoded ceilings (per-call chunk sizes, rate limits, session budgets, etc.) are now user-configurable with no artificial maximums. Includes `maxReadChunkKb`, `maxListResults`, `maxWriteChunkKb`, `maxRedirects`, `maxJsonResponseBytes`, `maxTextResponseBytes` and more (#106)
- **Clarifying questions for skills** — pptx-expert, pdf-expert, xlsx-expert skills now include structured "Clarifying Questions" sections that tell the LLM what to ask when details are missing (#110)
- **Cache write token tracking** — `cacheWriteTokens` from the SDK is now accumulated in session state for accurate cost calculation (#114)

### Fixed

- **PPTX hex colour XML injection** — `hexColor()` did no validation, allowing non-hex strings (like gradient XML) to be embedded as `srgbClr val` attributes, producing corrupt OOXML that PowerPoint would repair by stripping entire slides. Now validates with `HEX_RE` and throws descriptive errors (#115)
- **ha:pdf import validation failure** — Native module resolution loop broke early when a transitive dependency (e.g. `ha:ziplib`) had no JS source, producing a cryptic empty error. Now checks `moduleJsons` and `dtsSources` alongside `sources` before breaking (#111)
- **PPTX shape ID collision on restore** — `restorePresentation()` set the shape ID counter AFTER `createPresentation()`, causing duplicate IDs when shapes were created between the two calls. Counter is now restored FIRST. Includes fallback max-ID scan for legacy serialized data (#113)
- **Plugin config silently clamped** — `safeNumericConfig` from `path-jail.ts` defaults to a 10 MB ceiling. Plugin code that omitted the ceiling arg had values like `maxWriteSizeKb: 20480` silently clamped to 10240 (#106)
- **fetchJSON/fetchText byte counting** — Used `body.length` (UTF-16 code units) instead of `Buffer.byteLength(body, 'utf8')` for the configured byte limit check (#106)

### Changed

- **Handler validation guidance** — Stricter handler shape requirements with better error messages; nested helper functions no longer trigger false-positive misnamed-handler errors; `function(` expressions properly skipped in return detection (#105, #101)
- **SDK forward compatibility** — Use SDK `SessionEvent` type for forward compat with copilot-sdk 0.3.0 (#100)

## [v0.4.2] - 2026-04-29

### Added

- **MSAL M365 server discovery** — Bootstrap MCP server discovery for Microsoft 365 services using MSAL authentication (#97)

## [v0.4.1] - 2026-04-29

### Fixed

- **Release smoke test** — Removed fragile package size check from post-publish smoke test (#96)

## [v0.4.0] - 2026-04-29

### Fixed

- **MCP tool discovery flow** — Improved MCP tool discovery and connection lifecycle (#95)
- **Bold slash command detection** — Detect suggested slash commands wrapped in markdown bold formatting (#94)
- **npm package size** — Reduced published package size and hardened post-publish smoke test (#93)

## [v0.3.0] - 2026-04-28

### Added

- **Excel XLSX module** — Promoted `ha:xlsx` to a builtin module with workbook, sheet, chart, pivot table, and conditional formatting APIs (#86)
- **M365 MCP integration** — Microsoft 365 MCP server support for calendar, email, and Teams (#83)
- **`/plugins` alias** — `/plugins` now works as an alias for `/plugin` (#84)

### Fixed

- **Handler edits and MCP gateway** — Improved handler edit flow and MCP gateway module loading (#88)

### Changed

- **README** — Restructured to be capabilities-first (#87)
- **CI** — Added post-publish smoke test job (#85)

## [v0.2.3] - 2026-04-23

### Fixed

- **npm install** — Fixed package installation issues (#79)

## [v0.2.2] - 2026-04-23

### Fixed

- **Publish workflow** — Fixed npm publishing workflow and updated release documentation (#77, #78)

## [v0.2.1] - 2026-04-23

### Added

- **PDF document support** — Full PDF generation with flow layout, charts, themes, and font embedding via `ha:pdf`, `ha:pdf-charts`, and `ha:doc-core` modules (#51)
- **MCP integration** — Model Context Protocol support for external tool servers with SSE and stdio transports (#57)
- **Kubernetes deployment** — AKS and KIND deployment manifests with Hyperlight DaemonSet and agent pods (#54)
- **Token usage tracking** — Per-request and session-total token counts with cache hit reporting (#58)
- **Trusted npm publishing** — OIDC-based publishing with `--provenance` (#62)
- **Dependabot automation** — Enhanced Dependabot config with auto-approval for patch updates (#20, #45)

### Fixed

- **Hyperlight dependency alignment** — Aligned code-validator Hyperlight deps with hyperlight-js to prevent version skew (#64)
- **npm publish** — Fixed publish workflow issues (#76)

## [v0.1.6] - 2026-03-27

### Added

- **Cross-platform npm publishing** — Publish workflow now builds native addons on Linux (glibc + musl) and Windows in parallel, uploads artifacts, and combines them into a single cross-platform npm package
- **musl/Alpine support** — Added `x86_64-unknown-linux-musl` NAPI build target for `hyperlight-analysis`; CI cross-compiles musl from glibc runner with `musl-tools`
- **Runtime NAPI platform detection** — Binary launcher uses napi-rs generated `index.js` for `js-host-api` (full musl/glibc/win32 detection) and probes `ldd` for `hyperlight-analysis` musl vs glibc resolution
- **ha-modules.d.ts sync test** — New test in `dts-sync.test.ts` regenerates `ha-modules.d.ts` and compares to committed version, catching drift when module exports/types change without re-running the generator

### Fixed

- **Cross-platform .node loading** — `build-binary.js` no longer hardcodes the NAPI triple at build time; copies all available platform `.node` files and uses runtime detection to load the correct one
- **postinstall script** — Fixed missing closing brace in `package.json` `node -e` snippet that caused SyntaxError during `npm install`
- **Publish artifact ordering** — Download artifacts AFTER `just setup` to avoid symlink/junction clobber when `build-hyperlight` re-creates `deps/js-host-api`
- **ha-modules.d.ts stale types** — Regenerated with `ShapeFragment` return types (was `string`) to match upstream ShapeFragment safety system
- **Node.js launcher URL** — Use `pathToFileURL(cjs).href` instead of manual `file://` concatenation (fixes invalid URLs on Windows)
- **Unix PATH instructions** — Removed backslash escaping of `$PATH` in post-build output
- **pattern-loader test cleanup** — `afterEach` only swallows `EBUSY`/`EPERM` on Windows; rethrows real errors on other platforms

### Changed

- **Publish workflow** — Replaced single-platform `ubuntu-latest` publish with multi-platform matrix build (Linux KVM, Linux musl, Windows WHP) followed by artifact-combining publish job on self-hosted runner
- **Publish runner** — `publish-npm` job now runs on self-hosted `hld-kvm-amd` runner (needs Rust toolchain for `just setup`)

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

[v0.5.0]: https://github.com/hyperlight-dev/hyperagent/releases/tag/v0.5.0
[v0.4.2]: https://github.com/hyperlight-dev/hyperagent/releases/tag/v0.4.2
[v0.4.1]: https://github.com/hyperlight-dev/hyperagent/releases/tag/v0.4.1
[v0.4.0]: https://github.com/hyperlight-dev/hyperagent/releases/tag/v0.4.0
[v0.3.0]: https://github.com/hyperlight-dev/hyperagent/releases/tag/v0.3.0
[v0.2.3]: https://github.com/hyperlight-dev/hyperagent/releases/tag/v0.2.3
[v0.2.2]: https://github.com/hyperlight-dev/hyperagent/releases/tag/v0.2.2
[v0.2.1]: https://github.com/hyperlight-dev/hyperagent/releases/tag/v0.2.1
[v0.1.6]: https://github.com/hyperlight-dev/hyperagent/releases/tag/v0.1.6
[v0.1.5]: https://github.com/hyperlight-dev/hyperagent/releases/tag/v0.1.5
[v0.1.4]: https://github.com/hyperlight-dev/hyperagent/releases/tag/v0.1.4
[v0.1.3]: https://github.com/hyperlight-dev/hyperagent/releases/tag/v0.1.3
[v0.1.2]: https://github.com/hyperlight-dev/hyperagent/releases/tag/v0.1.2
[v0.1.1]: https://github.com/hyperlight-dev/hyperagent/releases/tag/v0.1.1
[v0.1.0]: https://github.com/hyperlight-dev/hyperagent/releases/tag/v0.1.0
