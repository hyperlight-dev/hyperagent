#!/bin/bash
# Azure Infrastructure Setup for HyperAgent
#
# Creates AKS cluster with KVM node pool and ACR.
# Reuses patterns from hyperlight-on-kubernetes.
#
# Usage: ./setup.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../common.sh"

# Load configuration
if [ -f "${SCRIPT_DIR}/config.env" ]; then
    source "${SCRIPT_DIR}/config.env"
fi

# ── Prerequisites ─────────────────────────────────────────────────────

check_prerequisites() {
    log_step "Checking prerequisites..."
    require_cmd az "https://docs.microsoft.com/en-us/cli/azure/install-azure-cli" || exit 1
    require_cmd kubectl "https://kubernetes.io/docs/tasks/tools/" || exit 1
    require_cmd envsubst "apt install gettext-base" || exit 1

    if ! az account show &> /dev/null; then
        log_error "Not logged in to Azure CLI. Run 'az login' first."
        exit 1
    fi

    log_success "Prerequisites OK"
}

# ── Subscription ──────────────────────────────────────────────────────

set_subscription() {
    if [ -n "${SUBSCRIPTION}" ]; then
        log_info "Setting subscription: ${SUBSCRIPTION}"
        az account set --subscription "${SUBSCRIPTION}"
    fi
    log_info "Using subscription: $(az account show --query name -o tsv)"
}

# ── Resource Group ────────────────────────────────────────────────────

create_resource_group() {
    log_step "Creating resource group: ${RESOURCE_GROUP} in ${LOCATION}"

    if az group show --name "${RESOURCE_GROUP}" &> /dev/null; then
        log_warning "Resource group already exists"
    else
        az group create --name "${RESOURCE_GROUP}" --location "${LOCATION}" -o none
        log_success "Resource group created"
    fi
}

# ── ACR ───────────────────────────────────────────────────────────────

create_acr() {
    log_step "Creating ACR: ${ACR_NAME}"

    if az acr show --name "${ACR_NAME}" &> /dev/null; then
        log_warning "ACR already exists"
    else
        az acr create \
            -g "${RESOURCE_GROUP}" \
            -n "${ACR_NAME}" \
            --sku Basic \
            -o none
        log_success "ACR created"
    fi
}

# ── AKS Cluster ──────────────────────────────────────────────────────

create_aks_cluster() {
    log_step "Creating AKS cluster: ${CLUSTER_NAME}"

    if az aks show -g "${RESOURCE_GROUP}" -n "${CLUSTER_NAME}" &> /dev/null; then
        log_warning "Cluster already exists"
    else
        local k8s_version
        k8s_version=$(az aks get-versions --location "${LOCATION}" --query "values[?isDefault].version" -o tsv | tr -d '\r')
        log_info "  Using Kubernetes version: ${k8s_version}"

        az aks create \
            -g "${RESOURCE_GROUP}" \
            -n "${CLUSTER_NAME}" \
            --location "${LOCATION}" \
            --kubernetes-version "${k8s_version}" \
            --node-count "${SYSTEM_NODE_COUNT}" \
            --node-vm-size "${SYSTEM_NODE_VM_SIZE}" \
            --nodepool-name "system" \
            --generate-ssh-keys \
            --enable-managed-identity \
            --network-plugin azure \
            -o none
        log_success "Cluster created"
    fi
}

# ── KVM Node Pool ────────────────────────────────────────────────────

create_kvm_nodepool() {
    log_step "Creating KVM node pool: ${KVM_NODE_POOL_NAME}"
    log_info "  OS: ${KVM_OS_SKU}, VM: ${KVM_NODE_VM_SIZE}"

    if az aks nodepool show -g "${RESOURCE_GROUP}" --cluster-name "${CLUSTER_NAME}" -n "${KVM_NODE_POOL_NAME}" &> /dev/null; then
        log_warning "KVM node pool already exists"
    else
        az aks nodepool add \
            -g "${RESOURCE_GROUP}" \
            --cluster-name "${CLUSTER_NAME}" \
            -n "${KVM_NODE_POOL_NAME}" \
            --node-count "${KVM_NODE_COUNT}" \
            --node-vm-size "${KVM_NODE_VM_SIZE}" \
            --os-sku "${KVM_OS_SKU}" \
            --enable-cluster-autoscaler \
            --min-count "${KVM_NODE_MIN_COUNT}" \
            --max-count "${KVM_NODE_MAX_COUNT}" \
            --labels "hyperlight.dev/hypervisor=kvm" "hyperlight.dev/enabled=true" \
            --mode User \
            -o none
        log_success "KVM node pool created"
    fi
}

# ── Wait for cluster to be ready ─────────────────────────────────────

wait_for_cluster_ready() {
    log_step "Waiting for cluster to finish provisioning..."
    local max_attempts=30
    local attempt=0
    while [ $attempt -lt $max_attempts ]; do
        local state
        state=$(az aks show -g "${RESOURCE_GROUP}" -n "${CLUSTER_NAME}" --query "provisioningState" -o tsv 2>/dev/null || echo "Unknown")
        if [ "$state" = "Succeeded" ]; then
            log_success "Cluster ready (provisioningState: Succeeded)"
            return 0
        fi
        log_info "  Cluster state: ${state} (attempt $((attempt + 1))/${max_attempts})"
        sleep 10
        attempt=$((attempt + 1))
    done
    log_error "Cluster did not reach Succeeded state after $((max_attempts * 10))s"
    return 1
}

# ── Attach ACR ───────────────────────────────────────────────────────

attach_acr() {
    log_step "Attaching ACR to cluster: ${ACR_NAME}"
    # Retry — cluster may still be running background operations after creation
    local max_retries=3
    local attempt=0
    while [ $attempt -lt $max_retries ]; do
        if az aks update \
            -g "${RESOURCE_GROUP}" \
            -n "${CLUSTER_NAME}" \
            --attach-acr "${ACR_NAME}" \
            -o none 2>/dev/null; then
            log_success "ACR attached"
            return 0
        fi
        attempt=$((attempt + 1))
        if [ $attempt -lt $max_retries ]; then
            log_warning "ACR attach failed (attempt ${attempt}/${max_retries}) — retrying in 30s..."
            sleep 30
        fi
    done
    log_error "Failed to attach ACR after ${max_retries} attempts"
    return 1
}

# ── Get Credentials ──────────────────────────────────────────────────

get_credentials() {
    log_step "Getting cluster credentials..."
    az aks get-credentials \
        -g "${RESOURCE_GROUP}" \
        -n "${CLUSTER_NAME}" \
        --overwrite-existing \
        -o none
    log_success "Credentials configured (context: ${CLUSTER_NAME})"
}

# ── Summary ──────────────────────────────────────────────────────────

print_summary() {
    echo ""
    echo "========================================"
    echo "  Azure Infrastructure Ready"
    echo "========================================"
    echo ""
    echo "Cluster:        ${CLUSTER_NAME}"
    echo "Resource Group: ${RESOURCE_GROUP}"
    echo "Location:       ${LOCATION}"
    echo "ACR:            ${ACR_NAME}.azurecr.io"
    echo "Node Pool:      ${KVM_NODE_POOL_NAME} (KVM, ${KVM_NODE_VM_SIZE})"
    echo ""
    echo "Next steps:"
    echo "  1. Deploy device plugin:  just k8s-deploy-plugin"
    echo "  2. Build & push image:    just k8s-build && just k8s-push"
    echo "  3. Set up auth:           just k8s-setup-auth"
    echo "  4. Run a prompt:          just k8s-run prompt=\"your prompt\""
    echo ""
}

# ── Main ─────────────────────────────────────────────────────────────

main() {
    echo ""
    log_step "Setting up Azure infrastructure for HyperAgent"
    echo ""

    check_prerequisites
    set_subscription
    create_resource_group
    create_acr
    create_aks_cluster
    create_kvm_nodepool
    wait_for_cluster_ready
    attach_acr
    get_credentials
    print_summary
}

main "$@"
