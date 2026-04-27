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

# Install PDF visual test dependencies (poppler-utils + fonts-dejavu-core).
# On Windows, installs into WSL. Pass a distro name to target a specific one
# that matches the CI runner (e.g. just install-pdf-deps Ubuntu-22.04).
[linux]
install-pdf-deps:
    sudo apt-get update -qq && sudo apt-get install -y -qq poppler-utils qpdf fonts-dejavu-core

[windows]
install-pdf-deps distro="":
    {{ if distro == "" { "wsl" } else { "wsl -d " + distro } }} bash -c "sudo apt-get update -qq && sudo apt-get install -y -qq poppler-utils qpdf fonts-dejavu-core"

# PDF visual regression tests.
# On Windows, pass a WSL distro name to match CI (e.g. just test-pdf-visual Ubuntu-22.04).
[linux]
test-pdf-visual:
    npx vitest run tests/pdf-visual.test.ts

[windows]
test-pdf-visual distro="":
    {{ if distro == "" { "" } else { "$env:PDF_WSL_DISTRO = '" + distro + "';" } }} npx vitest run tests/pdf-visual.test.ts

# Update PDF golden baselines (run after intentional visual changes).
# On Windows, pass a WSL distro name to match CI (e.g. just update-pdf-golden Ubuntu-22.04).
[linux]
update-pdf-golden:
    UPDATE_GOLDEN=1 npx vitest run tests/pdf-visual.test.ts

[windows]
update-pdf-golden distro="":
    {{ if distro == "" { "" } else { "$env:PDF_WSL_DISTRO = '" + distro + "';" } }} $env:UPDATE_GOLDEN = "1"; npx vitest run tests/pdf-visual.test.ts

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
#
# Removes:
#   - node_modules and dist (npm/binary outputs)
#   - generated builtin-modules/*.{js,d.ts,d.ts.map} (preserves
#     _save.js / _restore.js which ARE committed)
#   - generated plugin .d.ts files and plugins/shared/*.js
#   - generated plugins/host-modules.d.ts
#
# Use this when a previous build failed mid-way and left stale
# generated files that confuse `just setup` / `just build`.
[unix]
clean:
    #!/usr/bin/env bash
    set -euo pipefail
    rm -rf dist node_modules
    # Wipe gitignored builtin-modules build outputs (keep _save.js / _restore.js)
    find builtin-modules -maxdepth 1 \
      \( -name '*.js' -o -name '*.d.ts' -o -name '*.d.ts.map' \) \
      ! -name '_save.js' ! -name '_restore.js' -delete 2>/dev/null || true
    # Wipe gitignored plugin build outputs
    find plugins -maxdepth 3 -name '*.d.ts' -delete 2>/dev/null || true
    find plugins/shared -maxdepth 1 -name '*.js' -delete 2>/dev/null || true
    rm -f plugins/host-modules.d.ts plugins/plugin-schema-types.d.ts
    # Restore committed ha-modules.d.ts in case a failed build clobbered it
    git checkout -- builtin-modules/src/types/ha-modules.d.ts 2>/dev/null || true
    echo "🧹 Cleaned build artefacts"

[windows]
clean:
    if (Test-Path dist) { Remove-Item -Recurse -Force dist }; if (Test-Path node_modules) { Remove-Item -Recurse -Force node_modules }; Get-ChildItem builtin-modules -File | Where-Object { ($_.Extension -in '.js','.ts','.map') -and ($_.Name -notin '_save.js','_restore.js') } | Remove-Item -Force -ErrorAction SilentlyContinue; Get-ChildItem plugins -Recurse -Filter '*.d.ts' | Remove-Item -Force -ErrorAction SilentlyContinue; Get-ChildItem plugins/shared -Filter '*.js' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue; if (Test-Path plugins/host-modules.d.ts) { Remove-Item plugins/host-modules.d.ts }; if (Test-Path plugins/plugin-schema-types.d.ts) { Remove-Item plugins/plugin-schema-types.d.ts }; git checkout -- builtin-modules/src/types/ha-modules.d.ts 2>$null; Write-Output "🧹 Cleaned build artefacts"

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

# ── Kubernetes Deployment ─────────────────────────────────────────────

# Internal: check common K8s prerequisites
_k8s-check-common:
    #!/usr/bin/env bash
    source deploy/k8s/common.sh
    require_cmd docker "https://docs.docker.com/get-docker/" || exit 1
    require_cmd kubectl "https://kubernetes.io/docs/tasks/tools/" || exit 1

# Internal: check Azure prerequisites
_k8s-check-azure:
    #!/usr/bin/env bash
    source deploy/k8s/common.sh
    require_cmd az "https://docs.microsoft.com/en-us/cli/azure/install-azure-cli" || exit 1
    require_cmd kubectl "https://kubernetes.io/docs/tasks/tools/" || exit 1
    require_cmd envsubst "apt install gettext-base" || exit 1
    if ! az account show &>/dev/null; then
      log_error "Not logged in to Azure CLI. Run 'az login' first."
      exit 1
    fi

# Internal: check local (KIND) prerequisites
_k8s-check-local:
    #!/usr/bin/env bash
    source deploy/k8s/common.sh
    require_cmd docker "https://docs.docker.com/get-docker/" || exit 1
    require_cmd kind "go install sigs.k8s.io/kind@latest" || exit 1
    require_cmd kubectl "https://kubernetes.io/docs/tasks/tools/" || exit 1
    if [ ! -e /dev/kvm ]; then
      log_error "/dev/kvm not found — Hyperlight requires hardware virtualisation"
      exit 1
    fi

# ── Local (KIND) ──────────────────────────────────────────────────────

# Create local KIND cluster with /dev/kvm and local registry
k8s-local-up: _k8s-check-local
    ./deploy/k8s/local/setup.sh

# Tear down local KIND cluster and registry
k8s-local-down: _k8s-check-common
    ./deploy/k8s/local/teardown.sh

# Build and load image into local KIND cluster
k8s-local-build version="0.0.0-dev": _k8s-check-common
    #!/usr/bin/env bash
    # Resolve symlinks for Docker COPY
    if [ -L deps/js-host-api ]; then
      target=$(readlink -f deps/js-host-api)
      rm deps/js-host-api
      cp -r "$target" deps/js-host-api
      trap 'rm -rf deps/js-host-api && ln -sfn "'"$target"'" deps/js-host-api' EXIT
    fi
    docker build -t hyperagent --build-arg VERSION="{{version}}" .
    docker build -f deploy/k8s/Dockerfile -t hyperagent-k8s .
    # Push to local registry
    docker tag hyperagent-k8s localhost:5000/hyperagent:latest
    docker push localhost:5000/hyperagent:latest

# Deploy device plugin to local KIND cluster
k8s-local-deploy-plugin: _k8s-check-common
    #!/usr/bin/env bash
    source deploy/k8s/common.sh
    export IMAGE="ghcr.io/hyperlight-dev/hyperlight-device-plugin:latest" DEVICE_COUNT="2000" DEVICE_UID="65534" DEVICE_GID="65534"
    envsubst < deploy/k8s/manifests/device-plugin.yaml | kubectl apply -f -
    kubectl apply -f deploy/k8s/manifests/namespace.yaml
    echo "Waiting for device plugin pods..."
    kubectl rollout status daemonset/hyperlight-device-plugin -n hyperlight-system --timeout=120s

# Run a prompt on local KIND cluster
k8s-local-run +ARGS:
    HYPERAGENT_K8S_IMAGE=localhost:5000/hyperagent:latest ./scripts/hyperagent-k8s {{ARGS}}

# ── Azure (AKS) ──────────────────────────────────────────────────────

# Create AKS cluster + ACR + KVM node pool
k8s-infra-up: _k8s-check-azure
    ./deploy/k8s/azure/setup.sh

# Tear down all Azure resources (only requires az CLI)
k8s-infra-down:
    #!/usr/bin/env bash
    command -v az >/dev/null 2>&1 || { echo "Azure CLI (az) is required"; exit 1; }
    az account show >/dev/null 2>&1 || { echo "Please log in: az login"; exit 1; }
    ./deploy/k8s/azure/teardown.sh

# Stop AKS cluster (save costs when not in use)
k8s-stop:
    #!/usr/bin/env bash
    source deploy/k8s/azure/config.env
    az aks stop -g "${RESOURCE_GROUP}" -n "${CLUSTER_NAME}"

# Start AKS cluster
k8s-start:
    #!/usr/bin/env bash
    source deploy/k8s/azure/config.env
    az aks start -g "${RESOURCE_GROUP}" -n "${CLUSTER_NAME}"

# Get AKS credentials for kubectl
k8s-credentials:
    #!/usr/bin/env bash
    source deploy/k8s/azure/config.env
    az aks get-credentials -g "${RESOURCE_GROUP}" -n "${CLUSTER_NAME}" --overwrite-existing

# Deploy hyperlight device plugin to cluster
k8s-deploy-plugin: _k8s-check-common
    #!/usr/bin/env bash
    source deploy/k8s/azure/config.env
    export IMAGE="${DEVICE_PLUGIN_IMAGE}" DEVICE_COUNT="${DEVICE_COUNT}" DEVICE_UID="${DEVICE_UID}" DEVICE_GID="${DEVICE_GID}"
    envsubst < deploy/k8s/manifests/device-plugin.yaml | kubectl apply -f -
    kubectl apply -f deploy/k8s/manifests/namespace.yaml
    echo "Waiting for device plugin pods..."
    kubectl rollout status daemonset/hyperlight-device-plugin -n hyperlight-system --timeout=120s

# Build HyperAgent K8s image (builds base image first)
k8s-build version="0.0.0-dev": _k8s-check-common
    #!/usr/bin/env bash
    # Resolve symlinks for Docker COPY
    if [ -L deps/js-host-api ]; then
      target=$(readlink -f deps/js-host-api)
      rm deps/js-host-api
      cp -r "$target" deps/js-host-api
      trap 'rm -rf deps/js-host-api && ln -sfn "'"$target"'" deps/js-host-api' EXIT
    fi
    docker build -t hyperagent --build-arg VERSION="{{version}}" .
    docker build -f deploy/k8s/Dockerfile -t hyperagent-k8s .

# Push HyperAgent K8s image to ACR
k8s-push: _k8s-check-azure
    #!/usr/bin/env bash
    source deploy/k8s/azure/config.env
    az acr login --name "${ACR_NAME}"
    docker tag hyperagent-k8s "${ACR_NAME}.azurecr.io/${HYPERAGENT_IMAGE_NAME}:${HYPERAGENT_IMAGE_TAG}"
    docker push "${ACR_NAME}.azurecr.io/${HYPERAGENT_IMAGE_NAME}:${HYPERAGENT_IMAGE_TAG}"

# Set up GitHub authentication (K8s Secret — simple but less secure)
k8s-setup-auth:
    ./deploy/k8s/setup-auth.sh

# Set up GitHub authentication via Azure Key Vault
k8s-setup-auth-keyvault:
    ./deploy/k8s/setup-auth-keyvault.sh

# Run a prompt as a K8s Job
k8s-run +ARGS:
    ./scripts/hyperagent-k8s {{ARGS}}

# Show cluster, device plugin, and job status
k8s-status:
    #!/usr/bin/env bash
    source deploy/k8s/common.sh
    echo ""
    log_step "Cluster nodes:"
    kubectl get nodes -o custom-columns='NAME:.metadata.name,HYPERVISOR:.metadata.labels.hyperlight\.dev/hypervisor,CAPACITY:.status.allocatable.hyperlight\.dev/hypervisor' 2>/dev/null || echo "  (not connected)"
    echo ""
    log_step "Device plugin:"
    kubectl get pods -n hyperlight-system -l app.kubernetes.io/name=hyperlight-device-plugin 2>/dev/null || echo "  (not deployed)"
    echo ""
    log_step "HyperAgent jobs:"
    kubectl get jobs -n hyperagent -l hyperagent.dev/type=prompt-job 2>/dev/null || echo "  (none)"
    echo ""

# Smoke test: verify cluster, device plugin, auth, and image are all working
k8s-smoke-test:
    #!/usr/bin/env bash
    source deploy/k8s/common.sh
    PASS=0
    FAIL=0
    echo ""
    log_step "Running K8s smoke tests..."
    echo ""

    # 1. kubectl connected?
    if kubectl cluster-info &>/dev/null; then
      log_success "✅ kubectl connected to cluster"
      PASS=$((PASS + 1))
    else
      log_error "❌ kubectl not connected — run 'just k8s-credentials' or 'just k8s-local-up'"
      FAIL=$((FAIL + 1))
    fi

    # 2. KVM nodes available?
    KVM_NODES=$(kubectl get nodes -l hyperlight.dev/hypervisor=kvm -o name 2>/dev/null | wc -l)
    if [ "$KVM_NODES" -gt 0 ]; then
      log_success "✅ ${KVM_NODES} KVM node(s) available"
      PASS=$((PASS + 1))
    else
      log_error "❌ No KVM nodes found — check node pool labels"
      FAIL=$((FAIL + 1))
    fi

    # 3. Device plugin running?
    PLUGIN_READY=$(kubectl get pods -n hyperlight-system -l app.kubernetes.io/name=hyperlight-device-plugin -o jsonpath='{.items[*].status.phase}' 2>/dev/null)
    if echo "$PLUGIN_READY" | grep -q "Running"; then
      log_success "✅ Device plugin running"
      PASS=$((PASS + 1))
    else
      log_error "❌ Device plugin not running — run 'just k8s-deploy-plugin' or 'just k8s-local-deploy-plugin'"
      FAIL=$((FAIL + 1))
    fi

    # 4. Hypervisor resource allocatable?
    CAPACITY=$(kubectl get nodes -o jsonpath='{.items[*].status.allocatable.hyperlight\.dev/hypervisor}' 2>/dev/null | tr ' ' '\n' | grep -v '^$' | head -1)
    if [ -n "$CAPACITY" ] && [ "$CAPACITY" != "0" ]; then
      log_success "✅ hyperlight.dev/hypervisor resource available (capacity: ${CAPACITY})"
      PASS=$((PASS + 1))
    else
      log_error "❌ No hyperlight.dev/hypervisor resource — device plugin may not be working"
      FAIL=$((FAIL + 1))
    fi

    # 5. Namespace exists?
    if kubectl get namespace hyperagent &>/dev/null; then
      log_success "✅ hyperagent namespace exists"
      PASS=$((PASS + 1))
    else
      log_error "❌ hyperagent namespace missing — run 'just k8s-deploy-plugin' (creates namespace)"
      FAIL=$((FAIL + 1))
    fi

    # 6. Auth secret exists?
    if kubectl get secret hyperagent-auth -n hyperagent &>/dev/null; then
      log_success "✅ hyperagent-auth secret exists"
      PASS=$((PASS + 1))
    else
      log_error "❌ hyperagent-auth secret missing — run 'just k8s-setup-auth'"
      FAIL=$((FAIL + 1))
    fi

    # Summary
    echo ""
    echo "════════════════════════════════════════"
    if [ "$FAIL" -eq 0 ]; then
      log_success "All ${PASS} checks passed — ready to run prompts! 🚀"
    else
      log_error "${FAIL} check(s) failed, ${PASS} passed"
      echo ""
      log_info "Fix the issues above, then re-run: just k8s-smoke-test"
    fi
    echo "════════════════════════════════════════"
    echo ""
    [ "$FAIL" -eq 0 ]

# ── MCP Setup Recipes ───────────────────────────────────────────────
#
# Helper recipes to configure MCP servers for testing and examples.
# These write to ~/.hyperagent/config.json (gitignored).
#
# For Work IQ (Microsoft 365), the sanctioned setup is the Microsoft-published
# stdio MCP server:
#   just mcp-setup-workiq
# See the "Work IQ (Microsoft 365)" section below for prerequisites.

# Set up the MCP "everything" test server (reference/test server with echo, add, etc.)
[unix]
mcp-setup-everything:
    #!/usr/bin/env bash
    set -euo pipefail
    CONFIG_DIR="$HOME/.hyperagent"
    CONFIG_FILE="$CONFIG_DIR/config.json"
    mkdir -p "$CONFIG_DIR"

    if [ -f "$CONFIG_FILE" ]; then
      # Merge into existing config using node
      node -e "
        const fs = require('fs');
        const cfg = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf8'));
        cfg.mcpServers = cfg.mcpServers || {};
        cfg.mcpServers.everything = {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-everything']
        };
        fs.writeFileSync('$CONFIG_FILE', JSON.stringify(cfg, null, 2) + '\n');
      "
    else
      echo '{ "mcpServers": { "everything": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-everything"] } } }' \
        | node -e "process.stdout.write(JSON.stringify(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')),null,2)+'\n')" \
        > "$CONFIG_FILE"
    fi
    echo "✅ MCP 'everything' server configured in $CONFIG_FILE"
    echo "   Start the agent and run: /plugin enable mcp && /mcp enable everything"

# Set up the MCP GitHub server (uses GITHUB_TOKEN — get one via: gh auth token)
[unix]
mcp-setup-github:
    #!/usr/bin/env bash
    set -euo pipefail
    CONFIG_DIR="$HOME/.hyperagent"
    CONFIG_FILE="$CONFIG_DIR/config.json"
    mkdir -p "$CONFIG_DIR"

    if [ -z "${GITHUB_TOKEN:-}" ]; then
      echo "⚠️  GITHUB_TOKEN not set. Trying 'gh auth token'..."
      if command -v gh &>/dev/null; then
        export GITHUB_TOKEN=$(gh auth token 2>/dev/null || true)
      fi
      if [ -z "${GITHUB_TOKEN:-}" ]; then
        echo "   Could not get token. Run: export GITHUB_TOKEN=\$(gh auth token)"
        echo "   Continuing with config anyway..."
      else
        echo "   ✅ Got token from gh CLI"
      fi
    fi

    node -e "
      const fs = require('fs');
      const path = '$CONFIG_FILE';
      const cfg = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, 'utf8')) : {};
      cfg.mcpServers = cfg.mcpServers || {};
      cfg.mcpServers.github = {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: '\${GITHUB_TOKEN}' },
        allowTools: [
          'list_issues', 'get_issue', 'search_issues',
          'list_pull_requests', 'get_pull_request',
          'search_repositories', 'get_file_contents'
        ],
        denyTools: ['merge_pull_request', 'delete_branch', 'push_files']
      };
      fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
    "
    echo "✅ MCP 'github' server configured in $CONFIG_FILE"
    echo "   Tip: export GITHUB_TOKEN=\$(gh auth token)"
    echo "   Start the agent and run: /plugin enable mcp && /mcp enable github"

# Set up the MCP filesystem server (read-only access to a directory)
[unix]
mcp-setup-filesystem dir="/tmp/mcp-fs":
    #!/usr/bin/env bash
    set -euo pipefail
    CONFIG_DIR="$HOME/.hyperagent"
    CONFIG_FILE="$CONFIG_DIR/config.json"
    DIR="{{ dir }}"
    mkdir -p "$CONFIG_DIR" "$DIR"

    node -e "
      const fs = require('fs');
      const path = '$CONFIG_FILE';
      const cfg = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, 'utf8')) : {};
      cfg.mcpServers = cfg.mcpServers || {};
      cfg.mcpServers.filesystem = {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '$DIR']
      };
      fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
    "
    echo "✅ MCP 'filesystem' server configured in $CONFIG_FILE"
    echo "   Root directory: $DIR"
    echo "   Start the agent and run: /plugin enable mcp && /mcp enable filesystem"

# Show current MCP config (if any)
[unix]
mcp-show-config:
    #!/usr/bin/env bash
    CONFIG_FILE="$HOME/.hyperagent/config.json"
    if [ -f "$CONFIG_FILE" ]; then
      node -e "
        const cfg = JSON.parse(require('fs').readFileSync('$CONFIG_FILE', 'utf8'));
        if (cfg.mcpServers) {
          console.log('Configured MCP servers:');
          for (const [name, s] of Object.entries(cfg.mcpServers)) {
            if (s.type === 'http') {
              const auth = s.auth ? ' [' + s.auth.method + ']' : '';
              console.log('  ' + name + ': ' + s.url + auth);
            } else {
              console.log('  ' + name + ': ' + (s.command || '?') + ' ' + (s.args || []).join(' '));
            }
          }
        } else {
          console.log('No MCP servers configured.');
        }
      "
    else
      echo "No config file found at $CONFIG_FILE"
      echo "Run: just mcp-setup-everything"
    fi

# ── Work IQ (Microsoft 365) ──────────────────────────────────────────
#
# Adds the Microsoft-published Work IQ MCP stdio server
# (https://github.com/microsoft/work-iq) to your HyperAgent config.
#
# The server is spawned on demand via `npx -y @microsoft/workiq@latest mcp`.
# It exposes the `ask_work_iq`, `accept_eula`, and `get_debug_link` tools,
# which speak to the Microsoft 365 Copilot Chat API on your behalf.
#
# Prerequisites:
#   • Node.js 22+ (required by HyperAgent; also satisfies workiq's 18+ minimum)
#   • A Microsoft 365 Copilot licence on the signing-in user
#   • Tenant admin consent for the "Work IQ CLI" enterprise app. Admins: see
#     https://github.com/microsoft/work-iq/blob/main/ADMIN-INSTRUCTIONS.md
#   • Run `npx -y @microsoft/workiq@latest accept-eula` once (interactive) to
#     accept the EULA before the MCP server will serve requests.
#
# Auth: the `workiq` binary performs its own Entra interactive sign-in on
# first call and caches tokens in the user's MSAL cache. HyperAgent does
# NOT need to be told about clientId/tenantId.

# Set up the Microsoft Work IQ MCP stdio server
[unix]
mcp-setup-workiq:
    #!/usr/bin/env bash
    set -euo pipefail
    CONFIG_DIR="$HOME/.hyperagent"
    CONFIG_FILE="$CONFIG_DIR/config.json"
    mkdir -p "$CONFIG_DIR"

    echo "▸ Pre-fetching @microsoft/workiq (~188 MB on first run)…"
    # Primes the npx cache and downloads the platform binary so the first
    # /mcp enable workiq inside HyperAgent doesn't block for minutes.
    npx -y @microsoft/workiq@latest version

    echo "▸ Accepting EULA (interactive)…"
    # accept-eula writes per-user acceptance state. Safe to re-run; idempotent.
    npx -y @microsoft/workiq@latest accept-eula

    echo "▸ Writing MCP config entry…"
    node -e "
      const fs = require('fs');
      const path = '$CONFIG_FILE';
      const cfg = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, 'utf8')) : {};
      cfg.mcpServers = cfg.mcpServers || {};
      // Remove any stale HTTP Work IQ entries from previous setups
      for (const k of Object.keys(cfg.mcpServers)) {
        if (k.startsWith('work-iq-')) delete cfg.mcpServers[k];
      }
      cfg.mcpServers.workiq = {
        command: 'npx',
        args: ['-y', '@microsoft/workiq@latest', 'mcp']
      };
      fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
    "
    echo ""
    echo "✅ Work IQ stdio MCP server ready in $CONFIG_FILE"
    echo ""
    echo "   Next:"
    echo "     just start"
    echo "     /plugin enable mcp"
    echo "     /mcp enable workiq"
    echo ""
    echo "   First tool call opens a browser for Microsoft sign-in."

# ── Generic HTTP MCP server recipe ───────────────────────────────────
#
# Adds a single HTTP MCP server entry to ~/.hyperagent/config.json. Used
# directly for ad-hoc HTTP MCP servers, and also called per-service by
# `mcp-setup-m365` below.
#
# Args:
#   NAME           Config key (becomes the alias for /mcp enable <NAME>).
#   URL            HTTPS endpoint of the MCP server.
#   CLIENT_ID      Optional. If set, OAuth is configured (and FLOW becomes required).
#   TENANT_ID      Optional. Defaults to the auth-side default ('organizations').
#   SCOPES         Optional, comma-separated. If empty + CLIENT_ID set,
#                  defaults to '<URL-origin>/.default'.
#   FLOW           REQUIRED when CLIENT_ID is set. "browser" or "device-code".
#
# Add an HTTP MCP server entry to ~/.hyperagent/config.json. Used by
# `mcp-setup-m365` and intended for direct use when wiring custom HTTP
# MCP servers (any vendor — not M365-specific).
#
# Examples:
#   just mcp-add-http example https://mcp.example.com/sse
#   just mcp-add-http work-iq-mail \
#       https://agent365.svc.cloud.microsoft/agents/servers/mcp_MailRemoteServer \
#       <client-id> <tenant-id> "" browser
mcp-add-http NAME URL CLIENT_ID="" TENANT_ID="" SCOPES="" FLOW="":
    npx tsx scripts/mcp-add-http.ts "{{ NAME }}" "{{ URL }}" "{{ CLIENT_ID }}" "{{ TENANT_ID }}" "{{ SCOPES }}" "{{ FLOW }}"

# ── Microsoft 365 / Agent 365 HTTP MCP servers ───────────────────────
#
# Alternative to the stdio `mcp-setup-workiq` recipe above: direct
# HTTP+OAuth to the Agent 365 per-service MCP endpoints (mail, calendar,
# teams, sharepoint, onedrive, user, copilot, word, …). Requires either
# a per-tenant Entra app registration (`mcp-m365-create-app`) or a
# pre-existing client id passed explicitly.
#
# Flow:
#   1. just mcp-m365-create-app           # one-time: Entra app registration
#   2. just mcp-m365-setup                # writes one entry per M365 service
#   3. just start → /plugin enable mcp → /mcp enable work-iq-<service>
#
# State lives at ~/.hyperagent/m365.json (clientId, tenantId).
# The server catalog (alias → mcp_* id mapping) lives at
# scripts/m365-mcp-servers.json — refresh via `just mcp-m365-refresh-servers`.

# Create (or reuse) the Entra app registration for the Agent 365 MCP servers.
# Optional: --service-ref GUID for corporate tenants that require one.
# Optional: --client-id ID to adopt an existing app.
# Requires `az` CLI installed and `az login`'d. Cross-platform (Linux,
# macOS, Windows native, Git Bash, WSL) — runs via tsx.
mcp-m365-create-app *ARGS:
    npx tsx scripts/setup-m365-app.ts {{ ARGS }}

# Write the M365 HTTP MCP server entries into ~/.hyperagent/config.json
# by looping over scripts/m365-mcp-servers.json. Reads clientId/tenantId
# from ~/.hyperagent/m365.json by default; override with explicit args.
#
# Each server uses the URL and per-server scope discovered from
# Agent 365 (see catalog file). The catalog stores the discovery URL
# (/agents/servers/<name>); the setup script injects the caller's
# tenantId at config-write time to produce the actual gateway URL
# (/agents/tenants/<tid>/servers/<name>) that the gateway requires —
# without it the server returns EndpointInvalid / TenantIdInvalid.
#
# Args:
#   SERVICES        "all" (default), comma-separated alias list ("mail,teams"),
#                   or "list" to print all known service aliases and exit.
#   CLIENT_ID       Override Entra app client id
#   TENANT_ID       Override Entra tenant id (used for OAuth authority)
#   SCOPE_OVERRIDE  Optional: force a single scope for every server
#                   (default: each server uses its catalogued scope)
#   FLOW            REQUIRED. "browser" or "device-code". Picks which
#                   user-interaction OAuth flow gets baked into every
#                   server entry. There is no default — different
#                   environments (laptop vs SSH vs FOCI app) need
#                   different flows so the recipe forces an explicit
#                   choice.
mcp-setup-m365 SERVICES="all" CLIENT_ID="" TENANT_ID="" SCOPE_OVERRIDE="" FLOW="":
    npx tsx scripts/m365-setup.ts "{{ SERVICES }}" "{{ CLIENT_ID }}" "{{ TENANT_ID }}" "{{ SCOPE_OVERRIDE }}" "{{ FLOW }}"

# Refresh scripts/m365-mcp-servers.json from the live Agent 365 catalog.
# Existing alias→server-id mappings are preserved; new server ids appear
# under a derived alias.
mcp-m365-refresh-servers *ARGS:
    npx tsx scripts/m365-refresh-servers.ts {{ ARGS }}

# Print the saved M365 app details (if any).
mcp-m365-show:
    npx tsx scripts/m365-show.ts
