# ── HyperAgent Justfile ───────────────────────────────────────────────
#
# Build, test, lint, and run the HyperAgent standalone project.
#
# Prerequisites:
#   - Node.js >= 18
#   - npm
#   - Rust toolchain (for building the native hyperlight-js addon)
#   - KVM support (for running the Hyperlight micro-VM)
#
# First-time setup:
#   just setup       # builds native addons, installs npm deps
#
# ─────────────────────────────────────────────────────────────────────

# Windows: use PowerShell
set windows-shell := ["pwsh.exe", "-NoLogo", "-Command"]

# On Windows, use Ninja generator for CMake to avoid aws-lc-sys build issues
export CMAKE_GENERATOR := if os() == "windows" { "Ninja" } else { "" }

# The hyperlight-js workspace root, discovered from Cargo's git checkout.
# The runtime's Cargo.toml uses a git dep on hyperlight-js-runtime, so Cargo
# already clones the full workspace — we reuse that checkout to build the
# NAPI addon (js-host-api) without a separate git clone.
# Resolved lazily by the resolve-hyperlight-dir recipe.
hyperlight-link   := justfile_dir() / "deps" / "js-host-api"

# Hyperlight analysis guest (secure code validation in micro-VM)
analysis-guest-dir := justfile_dir() / "src" / "code-validator" / "guest"

# HyperAgent custom runtime (native Rust modules for the sandbox)
runtime-dir := justfile_dir() / "src" / "sandbox" / "runtime"

# HYPERLIGHT_CFLAGS needed for building guests that link rquickjs/QuickJS:
# The hyperlight target has no libc, so QuickJS needs stub headers plus
# -D__wasi__=1 to disable pthreads. Uses cargo metadata to find the
# include/ dir from the hyperlight-js-runtime dependency.
# Fails loudly if resolution fails — empty CFLAGS causes cryptic build errors.
runtime-cflags := `node -e "var m=JSON.parse(require('child_process').execSync('cargo +1.89 metadata --format-version 1 --manifest-path src/sandbox/runtime/Cargo.toml',{encoding:'utf8',stdio:['pipe','pipe','inherit'],maxBuffer:20*1024*1024}));var p=m.packages.find(function(p){return p.name==='hyperlight-js-runtime'});if(!p){process.stderr.write('ERROR: hyperlight-js-runtime not found in cargo metadata\n');process.exit(1)}var inc=require('path').join(require('path').dirname(p.manifest_path),'include').split(require('path').sep).join('/');console.log('-I'+inc+' -D__wasi__=1')"`

# Export HYPERLIGHT_CFLAGS so cargo-hyperlight picks them up when building runtimes
export HYPERLIGHT_CFLAGS := runtime-cflags

# Custom runtime binary path — exported so hyperlight-js build.rs embeds it.
# This ensures ALL builds (setup, build, npm install) use the native module runtime.
# Without this, the default runtime (no ha:ziplib) would be embedded.
export HYPERLIGHT_JS_RUNTIME_PATH := runtime-dir / "target" / "x86_64-hyperlight-none" / "release" / "hyperagent-runtime"

# Resolve the hyperlight-js workspace root from Cargo's git checkout.
# Uses cargo metadata to find where hyperlight-js-runtime lives, then
# derives the workspace src/ dir (js-host-api is a sibling crate).
# Outputs the workspace root path (parent of src/).
[private]
[unix]
resolve-hyperlight-dir:
    #!/usr/bin/env bash
    set -euo pipefail
    dir=$(node -e "\
      var m=JSON.parse(require('child_process').execSync(\
        'cargo +1.89 metadata --format-version 1 --manifest-path src/sandbox/runtime/Cargo.toml',\
        {encoding:'utf8',stdio:['pipe','pipe','pipe'],maxBuffer:20*1024*1024}));\
      var p=m.packages.find(function(p){return p.name==='hyperlight-js-runtime'});\
      if(p)console.log(require('path').resolve(require('path').dirname(p.manifest_path),'..','..'));\
      else{process.stderr.write('hyperlight-js-runtime not found in cargo metadata');process.exit(1)}")
    js_host_api="${dir}/src/js-host-api"
    if [ ! -d "$js_host_api" ]; then
      echo "❌ js-host-api not found at ${js_host_api}"
      echo "   Run: cargo +1.89 fetch --manifest-path src/sandbox/runtime/Cargo.toml"
      exit 1
    fi
    echo "$dir"

# Resolve hyperlight-js workspace root (Windows variant).
[private]
[windows]
resolve-hyperlight-dir:
    node -e "var m=JSON.parse(require('child_process').execSync('cargo +1.89 metadata --format-version 1 --manifest-path src/sandbox/runtime/Cargo.toml',{encoding:'utf8',stdio:['pipe','pipe','pipe'],maxBuffer:20*1024*1024}));var p=m.packages.find(function(p){return p.name==='hyperlight-js-runtime'});if(p)console.log(require('path').resolve(require('path').dirname(p.manifest_path),'..','..'));else{process.stderr.write('hyperlight-js-runtime not found');process.exit(1)}"

# Install required Rust toolchains and cargo subcommands.
# Cross-platform (Linux/macOS/Windows) — no bash required.
[private]
ensure-tools:
    cargo install cargo-hyperlight --locked --version 0.1.7
    rustup toolchain install 1.89 --no-self-update
    rustup toolchain install nightly --no-self-update

# Build the native hyperlight-js NAPI addon.
# 1. Builds the custom runtime (Cargo git dep fetches hyperlight-js automatically)
# 2. Discovers the hyperlight-js workspace from Cargo's checkout
# 3. Builds the NAPI addon with our custom runtime embedded
# 4. Symlinks deps/js-host-api → checkout/src/js-host-api for npm file: dep
# NOTE: [unix] only — add [windows] variant below for Windows WHP support.
[private]
[unix]
build-hyperlight target="debug": (build-runtime-release)
    #!/usr/bin/env bash
    set -euo pipefail
    hl_dir=$(just resolve-hyperlight-dir)
    # Clean stale hyperlight-js builds so build.rs re-embeds the runtime
    cd "${hl_dir}/src/hyperlight-js" && cargo clean -p hyperlight-js 2>/dev/null || true
    # Build the NAPI addon (inherits HYPERLIGHT_JS_RUNTIME_PATH from env)
    cd "${hl_dir}" && just build {{ if target == "debug" { "" } else { target } }}
    # Symlink for npm file: dependency resolution
    mkdir -p "{{justfile_dir()}}/deps"
    ln -sfn "${hl_dir}/src/js-host-api" "{{hyperlight-link}}"
    echo "🔗 deps/js-host-api → ${hl_dir}/src/js-host-api"

# Build hyperlight-js NAPI addon (Windows variant — PowerShell + junction link).
# All statements on one line because just runs each line as a separate pwsh -Command.
[private]
[windows]
build-hyperlight target="debug": (build-runtime-release)
    $hl_dir = just resolve-hyperlight-dir; Push-Location (Join-Path $hl_dir "src" "hyperlight-js"); cargo clean -p hyperlight-js 2>$null; Pop-Location; Push-Location $hl_dir; just build {{ if target == "debug" { "" } else { target } }}; Pop-Location; $linkPath = [IO.Path]::GetFullPath("{{hyperlight-link}}"); $targetPath = Join-Path $hl_dir "src" "js-host-api"; New-Item -ItemType Directory -Path (Split-Path $linkPath) -Force | Out-Null; if (Test-Path $linkPath) { cmd /c rmdir /q $linkPath 2>$null }; cmd /c mklink /J $linkPath $targetPath; Write-Output "🔗 deps/js-host-api → $targetPath"

# Build the hyperlight-analysis-guest NAPI addon (debug)
[private]
build-analysis-guest:
    cd "{{analysis-guest-dir}}" && just build debug && just build-napi debug

# Build the hyperlight-analysis-guest NAPI addon (release)
[private]
build-analysis-guest-release:
    cd "{{analysis-guest-dir}}" && just build release && just build-napi release

# Install npm deps (builds native addons, symlinks js-host-api)
[private]
install: (build-hyperlight) build-analysis-guest
    npm install

# Install npm deps with release-built native addons
[private]
install-release: (build-hyperlight "release") build-analysis-guest-release
    npm install

# ── First-time setup ─────────────────────────────────────────────────

# First-time setup: build native addons, install npm deps
setup: ensure-tools install
    @echo "✅ Setup complete — run 'just start' to launch the agent"

# ── Development ──────────────────────────────────────────────────────

# Build/rebuild the native hyperlight-js addon and install deps
build: install
    @echo "✅ Build complete — run 'just start' to launch the agent"

# Build everything in release mode (hyperlight-js, guest runtime, NAPI addon)
build-release: install-release
    @echo "✅ Release build complete — run 'just start-release' to launch"

# ── Standalone Binary ───────────────────────────────────────────────────

# Build standalone hyperagent binary (debug mode)
# After build: dist/bin/hyperagent or add dist/bin to PATH
binary: install
    node scripts/build-binary.js
    @echo "💡 Run: dist/bin/hyperagent  OR  export PATH=\"$PWD/dist/bin:\$PATH\" && hyperagent"

# Build standalone hyperagent binary (release mode — minified, no sourcemaps)
binary-release: install-release
    node scripts/build-binary.js --release
    @echo "💡 Run: dist/bin/hyperagent  OR  export PATH=\"$PWD/dist/bin:\$PATH\" && hyperagent"

# Run the standalone binary (builds first if needed)
run *ARGS: binary
    dist/bin/hyperagent {{ARGS}}

# Run the standalone release binary (builds first if needed)
run-release *ARGS: binary-release
    dist/bin/hyperagent {{ARGS}}

# ────────────────────────────────────────────────────────────────────────

# Run the agent (tsx transpiles on the fly — no build step needed)
start *ARGS: install
    npx tsx src/agent/index.ts {{ARGS}}

# Run with crash diagnostics (generates crash report .json files on SIGSEGV)
[unix]
start-debug *ARGS: install
    NODE_OPTIONS="--report-on-signal --report-on-fatalerror --report-directory=$HOME/.hyperagent/logs" npx tsx src/agent/index.ts {{ARGS}}

# Run with crash diagnostics (Windows variant)
[windows]
start-debug *ARGS: install
    $env:NODE_OPTIONS="--report-on-signal --report-on-fatalerror --report-directory=$env:USERPROFILE/.hyperagent/logs"; npx tsx src/agent/index.ts {{ARGS}}

# Run the agent with release-built native addon (faster sandbox execution)
start-release *ARGS: install-release
    npx tsx src/agent/index.ts {{ARGS}}

# Run tests
test: install
    npm test

# Type-check (must be zero errors — no excuses)
typecheck: install
    npm run typecheck

# Format code
fmt: install
    npm run fmt

# Check formatting
fmt-check: install
    npm run fmt:check

# Lint: format check + type check (no tests — fast feedback)
lint: fmt-check typecheck
    @echo "✅ Lint passed — looking sharp"

# Lint Rust code in analysis-guest
lint-analysis-guest:
    cd "{{analysis-guest-dir}}" && cargo fmt --check && cargo clippy --workspace -- -D warnings
    @echo "✅ Analysis-guest lint passed"

# Format Rust code in analysis-guest
fmt-analysis-guest:
    cd "{{analysis-guest-dir}}" && cargo fmt

# Test Rust code in analysis-guest
# Note: --test-threads=1 required because QuickJS context isn't thread-safe
test-analysis-guest:
    cd "{{analysis-guest-dir}}" && cargo test --workspace -- --test-threads=1

# ── HyperAgent Runtime (native modules) ──────────────────────────────

# Build the custom runtime for the hyperlight target (debug)
build-runtime:
    cd "{{runtime-dir}}" && cargo +1.89 hyperlight build --target-dir target

# Build the custom runtime for the hyperlight target (release)
build-runtime-release:
    cd "{{runtime-dir}}" && cargo +1.89 hyperlight build --target-dir target --release

# Lint Rust code in the custom runtime
lint-runtime:
    cd "{{runtime-dir}}" && cargo +1.89 clippy --workspace -- -D warnings
    cd "{{runtime-dir}}" && cargo +1.89 fmt --check
    @echo "✅ Runtime lint passed"

# Format Rust code in the custom runtime
fmt-runtime:
    cd "{{runtime-dir}}" && cargo +1.89 fmt --all

# Full lint: TypeScript + Rust (analysis-guest + runtime)
lint-all: lint lint-analysis-guest lint-runtime
    @echo "✅ All lints passed"

# Full format: TypeScript + Rust
fmt-all: fmt fmt-analysis-guest fmt-runtime
    @echo "✅ All code formatted"

# Full test: TypeScript + Rust
test-all: test test-analysis-guest
    @echo "✅ All tests passed"

# ── OOXML Validation ─────────────────────────────────────────────────

# Validate a PPTX file against the OpenXML SDK schema.
# Uses @xarsh/ooxml-validator (bundled native binary — no dotnet needed).
validate-pptx FILE:
    npx ooxml-validator {{FILE}}

# ── Quality Gate ─────────────────────────────────────────────────────

# Run ALL checks: format, types, tests (TS + Rust)
check: lint-all test-all
    @echo "✅ All checks passed — you may proceed to commit"

# Clean build artifacts (keeps deps/)
clean:
    rm -rf dist node_modules

# Clean everything including deps/ symlinks
clean-all: clean
    rm -rf deps

# ── Docker ───────────────────────────────────────────────────────────

# Build the Docker image (version calculated using MinVer rules from git tags)
docker-build:
    #!/usr/bin/env bash
    set -euo pipefail
    # Calculate MinVer-style version from git tags
    describe=$(git describe --tags --long --always --dirty 2>/dev/null || echo "unknown")
    if [[ "$describe" =~ ^v?([0-9]+\.[0-9]+\.[0-9]+)-([0-9]+)-g([a-f0-9]+)(-dirty)?$ ]]; then
        tag="${BASH_REMATCH[1]}"
        height="${BASH_REMATCH[2]}"
        commit="${BASH_REMATCH[3]}"
        dirty="${BASH_REMATCH[4]}"
        if [ "$height" = "0" ]; then
            version="${tag}${dirty:++dirty}"
        else
            IFS='.' read -r major minor patch <<< "$tag"
            version="${major}.${minor}.$((patch + 1))-alpha.${height}+${commit}${dirty:+.dirty}"
        fi
    elif [[ "$describe" =~ ^v?([0-9]+\.[0-9]+\.[0-9]+)(-dirty)?$ ]]; then
        version="${BASH_REMATCH[1]}${BASH_REMATCH[2]:++dirty}"
    elif [[ "$describe" =~ ^[a-f0-9]+(-dirty)?$ ]]; then
        count=$(git rev-list --count HEAD 2>/dev/null || echo "0")
        commit="${describe%-dirty}"
        version="0.0.0-alpha.${count}+${commit}${BASH_REMATCH[1]:+.dirty}"
    else
        version="0.0.0-dev"
    fi
    echo "📦 Docker build version: ${version}"
    # Dereference symlinks — Docker COPY can't follow symlinks outside the build context
    if [ -L deps/js-host-api ]; then
      target=$(readlink -f deps/js-host-api)
      rm deps/js-host-api
      cp -r "$target" deps/js-host-api
      trap 'rm -rf deps/js-host-api && ln -sfn "'"$target"'" deps/js-host-api' EXIT
    fi
    docker build -t hyperagent --build-arg VERSION="${version}" .

# Run hyperagent in Docker (requires /dev/kvm or /dev/mshv)
docker-run *ARGS:
    ./scripts/hyperagent-docker {{ARGS}}
