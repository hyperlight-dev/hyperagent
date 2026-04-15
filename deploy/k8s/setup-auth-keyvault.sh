#!/bin/bash
# Set up GitHub authentication using Azure Key Vault + CSI Secrets Store Driver
#
# Stores the GITHUB_TOKEN in Azure Key Vault and configures the AKS cluster
# to mount it into HyperAgent pods via the Secrets Store CSI Driver.
#
# This is MORE SECURE than K8s Secrets because:
#   - Token is encrypted at rest in Key Vault (not base64 in etcd)
#   - Access is controlled by Azure RBAC (not just K8s RBAC)
#   - Key Vault has audit logging for all secret access
#   - Token can be rotated in Key Vault without touching K8s
#
# Usage: ./deploy/k8s/setup-auth-keyvault.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/common.sh"

if [ -f "${SCRIPT_DIR}/azure/config.env" ]; then
    source "${SCRIPT_DIR}/azure/config.env"
fi

KEYVAULT_NAME="${KEYVAULT_NAME:-${CLUSTER_NAME}-kv}"
SECRET_NAME="github-token"
NAMESPACE="hyperagent"

# ── Prerequisites ────────────────────────────────────────────────────

log_step "Setting up Key Vault auth for HyperAgent"

require_cmd az || exit 1
require_cmd kubectl || exit 1

# ── Enable CSI Secrets Store Driver on AKS ───────────────────────────

log_step "Enabling Secrets Store CSI Driver on AKS cluster..."

az aks enable-addons \
    -g "${RESOURCE_GROUP}" \
    -n "${CLUSTER_NAME}" \
    --addons azure-keyvault-secrets-provider \
    -o none 2>/dev/null || log_warning "CSI driver may already be enabled"

log_success "CSI Secrets Store Driver enabled"

# ── Create Key Vault ─────────────────────────────────────────────────

log_step "Creating Key Vault: ${KEYVAULT_NAME}"

if az keyvault show --name "${KEYVAULT_NAME}" &>/dev/null; then
    log_warning "Key Vault already exists"
else
    az keyvault create \
        -g "${RESOURCE_GROUP}" \
        -n "${KEYVAULT_NAME}" \
        --location "${LOCATION}" \
        --enable-rbac-authorization \
        -o none
    log_success "Key Vault created"
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
    echo "     GITHUB_TOKEN=ghp_your_token_here just k8s-setup-auth-keyvault"
    echo ""
    exit 1
fi

# ── Store token in Key Vault ─────────────────────────────────────────

log_step "Storing token in Key Vault..."

# Grant current user permission to set secrets.
# Extract user OID from the ARM access token JWT — avoids Graph API dependency
# (az ad signed-in-user / az role assignment --assignee both need Graph scope).
CURRENT_USER_OID=$(az account get-access-token --query "accessToken" -o tsv 2>/dev/null \
    | cut -d. -f2 \
    | base64 -d 2>/dev/null \
    | python3 -c "import sys,json; t=json.load(sys.stdin); print(t.get('oid',''))" 2>/dev/null \
    || true)

KEYVAULT_ID=$(az keyvault show --name "${KEYVAULT_NAME}" --query id -o tsv)

if [ -n "$CURRENT_USER_OID" ]; then
    log_info "Assigning Key Vault Secrets Officer to OID ${CURRENT_USER_OID}..."
    az role assignment create \
        --role "Key Vault Secrets Officer" \
        --assignee-object-id "$CURRENT_USER_OID" \
        --assignee-principal-type "User" \
        --scope "$KEYVAULT_ID" \
        -o none 2>/dev/null || true

    # Azure RBAC propagation can take up to 5 minutes after assignment
    log_info "Waiting for RBAC propagation (up to 60s)..."
    RETRY_MAX=6
    RETRY_DELAY=10
    for i in $(seq 1 $RETRY_MAX); do
        if az keyvault secret set \
            --vault-name "${KEYVAULT_NAME}" \
            --name "${SECRET_NAME}" \
            --value "$TOKEN" \
            -o none 2>/dev/null; then
            break
        fi
        if [ "$i" -eq "$RETRY_MAX" ]; then
            log_error "Failed to set secret after ${RETRY_MAX} retries. RBAC may still be propagating."
            log_error "Wait a few minutes and re-run, or assign 'Key Vault Secrets Officer' manually."
            exit 1
        fi
        log_warning "RBAC not ready yet, retrying in ${RETRY_DELAY}s... (${i}/${RETRY_MAX})"
        sleep "$RETRY_DELAY"
    done
else
    log_error "Could not extract user OID from access token"
    exit 1
fi

log_success "Token stored in Key Vault"

# ── Grant AKS managed identity access to Key Vault ───────────────────

log_step "Granting AKS identity access to Key Vault..."

# Get the user-assigned managed identity used by the CSI driver
# clientId is needed for the SecretProviderClass, objectId for role assignment
CLIENT_ID=$(az aks show \
    -g "${RESOURCE_GROUP}" \
    -n "${CLUSTER_NAME}" \
    --query "addonProfiles.azureKeyvaultSecretsProvider.identity.clientId" \
    -o tsv)

CSI_OBJECT_ID=$(az aks show \
    -g "${RESOURCE_GROUP}" \
    -n "${CLUSTER_NAME}" \
    --query "addonProfiles.azureKeyvaultSecretsProvider.identity.objectId" \
    -o tsv)

KEYVAULT_ID=$(az keyvault show --name "${KEYVAULT_NAME}" --query id -o tsv)

# Use --assignee-object-id to avoid Graph API dependency
az role assignment create \
    --role "Key Vault Secrets User" \
    --assignee-object-id "$CSI_OBJECT_ID" \
    --assignee-principal-type "ServicePrincipal" \
    --scope "$KEYVAULT_ID" \
    -o none 2>/dev/null || true

log_success "AKS identity granted Key Vault access"

# ── Get tenant ID ────────────────────────────────────────────────────

TENANT_ID=$(az account show --query tenantId -o tsv)

# ── Create SecretProviderClass ───────────────────────────────────────

log_step "Creating SecretProviderClass in namespace ${NAMESPACE}..."

kubectl apply -f - <<EOF
apiVersion: v1
kind: Namespace
metadata:
  name: ${NAMESPACE}
---
apiVersion: secrets-store.csi.x-k8s.io/v1
kind: SecretProviderClass
metadata:
  name: hyperagent-keyvault
  namespace: ${NAMESPACE}
spec:
  provider: azure
  parameters:
    usePodIdentity: "false"
    useVMManagedIdentity: "true"
    userAssignedIdentityID: "${CLIENT_ID}"
    keyvaultName: "${KEYVAULT_NAME}"
    tenantId: "${TENANT_ID}"
    objects: |
      array:
        - |
          objectName: ${SECRET_NAME}
          objectType: secret
  # Sync to a K8s Secret so it can be used as an env var in the pod
  secretObjects:
    - secretName: hyperagent-auth
      type: Opaque
      data:
        - objectName: ${SECRET_NAME}
          key: GITHUB_TOKEN
EOF

log_success "SecretProviderClass created"

# ── Summary ──────────────────────────────────────────────────────────

echo ""
echo "========================================"
echo "  Key Vault Auth Setup Complete"
echo "========================================"
echo ""
echo "Key Vault:            ${KEYVAULT_NAME}"
echo "Secret:               ${SECRET_NAME}"
echo "SecretProviderClass:  hyperagent-keyvault"
echo "Synced K8s Secret:    hyperagent-auth"
echo ""
echo "The token is stored in Azure Key Vault and will be"
echo "automatically mounted into HyperAgent pods."
echo ""
echo "To rotate the token:"
echo "  az keyvault secret set --vault-name ${KEYVAULT_NAME} --name ${SECRET_NAME} --value <new-token>"
echo ""
