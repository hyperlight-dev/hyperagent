# Hyperagent Docker image
# Builds the binary fresh during docker build (no stale dist/ issues)
#
# Build:   docker build -t hyperagent .
# Run:     ./scripts/hyperagent-docker [args]
#
# REQUIRES: Hypervisor access (--device=/dev/kvm or --device=/dev/mshv)

# ============================================
# Stage 1: Build binary
# ============================================
FROM node:22-slim AS builder

# Version can be passed from CI (e.g., from git tag)
ARG VERSION

# Install build tools for native module compilation
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Copy package files first for layer caching
COPY package*.json ./

# Copy the NAPI addon (must be a real directory, not a symlink —
# use `just docker-build` or resolve symlinks before `docker build`)
COPY deps/js-host-api/ ./deps/js-host-api/
COPY src/code-validator/guest/ ./src/code-validator/guest/

# Install dependencies
RUN npm install --ignore-scripts

# Patch vscode-jsonrpc (postinstall step)
COPY scripts/ ./scripts/
RUN node scripts/patch-vscode-jsonrpc.js || true

# Copy all source for bundling
COPY src/agent/ ./src/agent/
COPY src/plugin-system/ ./src/plugin-system/
COPY src/sandbox/tool.js src/sandbox/tool.d.ts ./src/sandbox/
COPY builtin-modules/ ./builtin-modules/
COPY plugins/ ./plugins/
COPY skills/ ./skills/
COPY tsconfig.json ./

# Build the binary. VERSION must be provided via --build-arg.
ARG VERSION
RUN if [ -z "$VERSION" ]; then echo "ERROR: VERSION build arg is required. Use: docker build --build-arg VERSION=x.y.z" && exit 1; fi
RUN VERSION="${VERSION}" node scripts/build-binary.js --release

# ============================================
# Stage 2: Runtime image (minimal)
# ============================================
FROM node:22-slim

# Install CA certificates for HTTPS (Copilot SDK needs them)
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

# Create non-root user for runtime
# Hypervisor device access (kvm/mshv) is granted at runtime via --group-add
RUN groupadd --gid 1001 hyperagent && \
    useradd --uid 1001 --gid hyperagent --shell /bin/bash --create-home hyperagent

WORKDIR /app

# Copy ONLY the built binary distribution
COPY --from=builder /build/dist/bin/ ./dist/bin/
COPY --from=builder /build/dist/lib/ ./dist/lib/

# Ensure hyperagent user owns the app directory
RUN chown -R hyperagent:hyperagent /app

# Switch to non-root user
USER hyperagent

# Document required device access
# Container runs as non-root; hypervisor access requires --group-add at runtime:
#   docker run --device=/dev/kvm --group-add $(stat -c '%g' /dev/kvm) ...
#   docker run --device=/dev/mshv --group-add $(stat -c '%g' /dev/mshv) ...
LABEL hypervisor.required="true"
LABEL hypervisor.devices="/dev/kvm or /dev/mshv"

ENTRYPOINT ["/app/dist/bin/hyperagent"]
