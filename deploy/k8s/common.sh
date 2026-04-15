#!/bin/bash
#
# Common utilities for HyperAgent K8s deploy scripts
#
# Source this file in other scripts:
#   SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#   source "${SCRIPT_DIR}/common.sh"

# ── Colours ───────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# ── Logging ───────────────────────────────────────────────────────────

log_info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $1"; }
log_step()    { echo -e "${BOLD}==>${NC} $1"; }
# Print a kubectl command before running it (dimmed, prefixed with $)
log_cmd()     { echo -e "${BLUE}\$ $*${NC}"; "$@"; }

# ── Utilities ─────────────────────────────────────────────────────────

# Check if a command exists
require_cmd() {
    local cmd="$1"
    local install_hint="${2:-}"

    if ! command -v "$cmd" &> /dev/null; then
        log_error "$cmd is not installed"
        [ -n "$install_hint" ] && log_info "Install: $install_hint"
        return 1
    fi
    return 0
}

# Wait for a condition with timeout
wait_for() {
    local description="$1"
    local check_cmd="$2"
    local timeout="${3:-120}"
    local interval="${4:-5}"

    log_info "Waiting for $description..."
    local elapsed=0
    while ! eval "$check_cmd" &>/dev/null; do
        if [ $elapsed -ge $timeout ]; then
            log_error "Timeout waiting for $description (${timeout}s)"
            return 1
        fi
        sleep $interval
        elapsed=$((elapsed + interval))
    done
    log_success "$description ready"
    return 0
}
