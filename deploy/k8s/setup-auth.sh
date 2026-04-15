#!/bin/bash
# Set up GitHub authentication for HyperAgent K8s Jobs
#
# Creates a K8s Secret with GITHUB_TOKEN in the hyperagent namespace.
# Idempotent — safe to re-run to rotate/update the token.
#
# Usage: ./deploy/k8s/setup-auth.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/common.sh"

NAMESPACE="hyperagent"

# ── Ensure namespace exists ──────────────────────────────────────────

if ! kubectl get namespace "${NAMESPACE}" &>/dev/null; then
    log_info "Creating namespace: ${NAMESPACE}"
    kubectl apply -f "${SCRIPT_DIR}/manifests/namespace.yaml"
fi

# ── Resolve token ────────────────────────────────────────────────────

TOKEN=""

if [ -n "${GITHUB_TOKEN:-}" ]; then
    TOKEN="$GITHUB_TOKEN"
    log_info "Using GITHUB_TOKEN from environment"
elif [ -n "${GH_TOKEN:-}" ]; then
    TOKEN="$GH_TOKEN"
    log_info "Using GH_TOKEN from environment"
fi

if [ -z "$TOKEN" ]; then
    log_error "No GitHub token found."
    echo ""
    echo "Set GITHUB_TOKEN and re-run:"
    echo ""
    echo "  1. Create a PAT at https://github.com/settings/tokens"
    echo "     → Click 'Generate new token (classic)'"
    echo "     → No extra scopes needed"
    echo ""
    echo "  2. Run:"
    echo "     GITHUB_TOKEN=ghp_your_token_here just k8s-setup-auth"
    echo ""
    exit 1
fi

# ── Validate token format ────────────────────────────────────────────

if [[ ! "$TOKEN" =~ ^(ghp_|gho_|github_pat_|ghu_) ]]; then
    log_warning "Token doesn't match known GitHub token formats (ghp_, gho_, github_pat_, ghu_)"
    log_warning "Proceeding anyway — the Copilot SDK will validate it at runtime"
fi

# ── Create/update secret (idempotent) ────────────────────────────────

log_step "Creating K8s secret: hyperagent-auth"

kubectl create secret generic hyperagent-auth \
    --namespace="${NAMESPACE}" \
    --from-literal=GITHUB_TOKEN="$TOKEN" \
    --dry-run=client -o yaml | kubectl apply -f -

log_success "Secret created/updated in namespace ${NAMESPACE}"
echo ""
log_info "To rotate the token, re-run this script."
log_info "To delete: kubectl delete secret hyperagent-auth -n ${NAMESPACE}"
