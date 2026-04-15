#!/bin/bash
# Set up local KIND cluster with local registry for HyperAgent
#
# Everything stays on your machine — no cloud, no costs.
# Requires: docker, kind, kubectl, /dev/kvm
#
# Usage: ./deploy/k8s/local/setup.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../common.sh"

CLUSTER_NAME="${CLUSTER_NAME:-hyperagent}"
REGISTRY_NAME="${REGISTRY_NAME:-hyperagent-registry}"
REGISTRY_PORT="${REGISTRY_PORT:-5000}"

# ── Prerequisites ────────────────────────────────────────────────────

check_prerequisites() {
    log_step "Checking prerequisites..."

    require_cmd docker "https://docs.docker.com/get-docker/" || exit 1
    require_cmd kind "go install sigs.k8s.io/kind@latest" || exit 1
    require_cmd kubectl "https://kubernetes.io/docs/tasks/tools/" || exit 1

    if [ ! -e /dev/kvm ]; then
        log_error "/dev/kvm not found — Hyperlight requires hardware virtualisation"
        log_info "Enable KVM: sudo modprobe kvm_intel (or kvm_amd)"
        exit 1
    fi

    log_success "Prerequisites OK"
}

# ── Local Registry ───────────────────────────────────────────────────

create_registry() {
    log_step "Creating local registry: ${REGISTRY_NAME}:${REGISTRY_PORT}"

    if docker inspect "${REGISTRY_NAME}" &>/dev/null; then
        log_warning "Registry already exists"
    else
        docker run -d --restart=always \
            -p "127.0.0.1:${REGISTRY_PORT}:5000" \
            --network bridge \
            --name "${REGISTRY_NAME}" \
            registry:2
        log_success "Registry created"
    fi
}

# ── KIND Cluster ─────────────────────────────────────────────────────

create_cluster() {
    log_step "Creating KIND cluster: ${CLUSTER_NAME}"

    if kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
        log_warning "Cluster already exists"
        return
    fi

    kind create cluster --config "${SCRIPT_DIR}/kind-config.yaml"

    # Connect registry to cluster network
    if [ "$(docker inspect -f='{{json .NetworkSettings.Networks.kind}}' "${REGISTRY_NAME}")" = 'null' ]; then
        docker network connect "kind" "${REGISTRY_NAME}"
    fi

    # Configure containerd to use local registry and enable CDI
    for node in $(kind get nodes --name "${CLUSTER_NAME}"); do
        # Local registry config
        docker exec "${node}" mkdir -p "/etc/containerd/certs.d/localhost:${REGISTRY_PORT}"
        cat <<EOF | docker exec -i "${node}" tee "/etc/containerd/certs.d/localhost:${REGISTRY_PORT}/hosts.toml" > /dev/null
[host."http://${REGISTRY_NAME}:5000"]
EOF

        # Enable CDI in containerd for device injection
        log_info "Enabling CDI on ${node}..."
        docker exec "${node}" mkdir -p /var/run/cdi
        docker exec "${node}" sed -i \
            '/\[plugins."io.containerd.grpc.v1.cri"\]/a\    enable_cdi = true\n    cdi_spec_dirs = ["/var/run/cdi", "/etc/cdi"]' \
            /etc/containerd/config.toml

        # Restart containerd to apply changes
        docker exec "${node}" systemctl restart containerd
    done

    log_info "Waiting for containerd to restart..."
    sleep 5

    # Document the registry for kubectl
    cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: ConfigMap
metadata:
  name: local-registry-hosting
  namespace: kube-public
data:
  localRegistryHosting.v1: |
    host: "localhost:${REGISTRY_PORT}"
    help: "https://kind.sigs.k8s.io/docs/user/local-registry/"
EOF

    log_success "Cluster created"
}

# ── Summary ──────────────────────────────────────────────────────────

print_summary() {
    echo ""
    echo "========================================"
    echo "  Local K8s Environment Ready"
    echo "========================================"
    echo ""
    echo "Cluster:   ${CLUSTER_NAME}"
    echo "Registry:  localhost:${REGISTRY_PORT}"
    echo "Context:   kind-${CLUSTER_NAME}"
    echo ""
    echo "Next steps:"
    echo "  1. Deploy device plugin:  just k8s-local-deploy-plugin"
    echo "  2. Build & push image:    just k8s-local-build && just k8s-local-push"
    echo "  3. Set up auth:           just k8s-setup-auth"
    echo "  4. Run a prompt:          just k8s-run --prompt \"your prompt\""
    echo ""
}

# ── Main ─────────────────────────────────────────────────────────────

main() {
    echo ""
    log_step "Setting up local HyperAgent K8s environment"
    echo ""

    check_prerequisites
    create_registry
    create_cluster
    print_summary
}

main "$@"
