#!/bin/bash
# Azure Infrastructure Teardown for HyperAgent
#
# Destroys all Azure resources created by setup.sh.
#
# Usage: ./teardown.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../common.sh"

if [ -f "${SCRIPT_DIR}/config.env" ]; then
    source "${SCRIPT_DIR}/config.env"
fi

log_step "Tearing down Azure infrastructure for HyperAgent"
log_warning "This will delete ALL resources in resource group: ${RESOURCE_GROUP}"

read -p "Are you sure? (y/N): " answer
if [[ ! "$answer" =~ ^[Yy] ]]; then
    log_info "Aborted"
    exit 0
fi

if az group show --name "${RESOURCE_GROUP}" &> /dev/null; then
    log_info "Deleting resource group: ${RESOURCE_GROUP} (this may take a few minutes)..."
    az group delete --name "${RESOURCE_GROUP}" --yes --no-wait
    log_success "Resource group deletion initiated (running in background)"
else
    log_warning "Resource group ${RESOURCE_GROUP} does not exist"
fi
