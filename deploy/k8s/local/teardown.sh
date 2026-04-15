#!/bin/bash
# Teardown local KIND cluster and registry
#
# Usage: ./deploy/k8s/local/teardown.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../common.sh"

CLUSTER_NAME="${CLUSTER_NAME:-hyperagent}"
REGISTRY_NAME="${REGISTRY_NAME:-hyperagent-registry}"

log_step "Tearing down local K8s environment"

if kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
    kind delete cluster --name "${CLUSTER_NAME}"
    log_success "Cluster deleted"
else
    log_info "Cluster does not exist"
fi

if docker inspect "${REGISTRY_NAME}" &>/dev/null; then
    docker rm -f "${REGISTRY_NAME}"
    log_success "Registry deleted"
else
    log_info "Registry does not exist"
fi

echo ""
log_success "Local environment torn down 👋"
