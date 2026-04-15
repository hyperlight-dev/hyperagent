# HyperAgent on Kubernetes

Deploy HyperAgent as Kubernetes Jobs with `/dev/kvm` access via the [hyperlight device plugin](https://github.com/hyperlight-dev/hyperlight-on-kubernetes). Works on **local KIND clusters** (everything stays on your machine) or **Azure AKS** (cloud scale).

## Choose Your Environment

| | Local (KIND) | Azure (AKS) |
|---|---|---|
| **Where it runs** | Your machine | Azure cloud |
| **Cost** | Free | AKS + VM costs |
| **Requires** | Docker, kind, `/dev/kvm` | Azure subscription |
| **Best for** | Development, testing, demos | Production, batch processing |
| **Setup time** | ~2 minutes | ~15 minutes |

## Quick Start (Local — KIND)

```bash
# 1. Create local cluster with /dev/kvm and registry
just k8s-local-up

# 2. Deploy the hyperlight device plugin
just k8s-local-deploy-plugin

# 3. Build and push image to local registry
just k8s-local-build

# 4. Create a GitHub fine-grained PAT at https://github.com/settings/tokens?type=beta
#    No special permissions needed.
#    Then set up auth:
GITHUB_TOKEN=github_pat_your_token just k8s-setup-auth

# 5. Verify everything is working
just k8s-smoke-test

# 6. Run a prompt — nothing leaves your machine!
just k8s-local-run --prompt "Create a presentation on the NASA Artemis II mission. Include crew details, mission timeline, spacecraft specs. Use a space-themed dark colour scheme. 8-10 slides." --skill pptx-expert --timeout 900
```

## Quick Start (Azure — AKS)

```bash
# 1. Create Azure infrastructure (AKS + ACR + KVM node pool)
just k8s-infra-up

# 2. Connect kubectl to the cluster
just k8s-credentials

# 3. Deploy the hyperlight device plugin
just k8s-deploy-plugin

# 4a. Use published image (no build needed):
export HYPERAGENT_K8S_IMAGE="ghcr.io/hyperlight-dev/hyperagent:latest"
# 4b. OR build and push your own:
#     just k8s-build && just k8s-push

# 5. Create a GitHub fine-grained PAT at https://github.com/settings/tokens?type=beta
#    No special permissions needed.
#    Then set up auth via Key Vault:
GITHUB_TOKEN=github_pat_your_token just k8s-setup-auth-keyvault

# 6. Verify everything is working
just k8s-smoke-test

# 7. Run a prompt!
just k8s-run --prompt "Create a presentation on the NASA Artemis II mission. Include crew details, mission timeline, spacecraft specs. Fetch the latest images and info from the web. Use a space-themed dark colour scheme. 8-10 slides." --skill pptx-expert --timeout 900
```

## Prerequisites

**All environments:**
- [Docker](https://docs.docker.com/get-docker/)
- [kubectl](https://kubernetes.io/docs/tasks/tools/)
- [just](https://github.com/casey/just) command runner
- `/dev/kvm` (hardware virtualisation)
- GitHub account with active **Copilot license** (Business or Individual)

**Local (KIND) only:**
- [KIND](https://kind.sigs.k8s.io/) 0.20+ (`go install sigs.k8s.io/kind@latest`)

**Azure (AKS) only:**
- [Azure CLI](https://docs.microsoft.com/en-us/cli/azure/install-azure-cli) (`az`)
- `envsubst` (`apt install gettext-base` on Ubuntu)
- Azure subscription with permissions to create resources

## 1. Create Azure Infrastructure

```bash
just k8s-infra-up
```

This creates:

| Resource | Name | Description |
|----------|------|-------------|
| Resource Group | `hyperagent-rg` | Container for all resources |
| Container Registry | `hyperagentacr` | Docker images |
| AKS Cluster | `hyperagent-cluster` | Kubernetes cluster |
| KVM Node Pool | `kvmpool` | Ubuntu nodes with nested virtualisation (`Standard_D4s_v3`) |

After creation, connect kubectl to the cluster:

```bash
just k8s-credentials
```

Verify the connection:

```bash
kubectl get nodes
```

Override defaults with environment variables:

```bash
export RESOURCE_GROUP="my-rg"
export CLUSTER_NAME="my-cluster"
export ACR_NAME="myacr"           # Must be globally unique
export LOCATION="eastus"
just k8s-infra-up
```

Or edit `deploy/k8s/azure/config.env` to set permanent defaults. All `just k8s-*` commands read from this file.

**Full configuration reference** (`deploy/k8s/azure/config.env`):

| Variable | Default | Description |
|----------|---------|-------------|
| `RESOURCE_GROUP` | `hyperagent-rg` | Azure resource group name |
| `LOCATION` | `westus3` | Azure region |
| `ACR_NAME` | `hyperagentacr` | Container registry name (must be globally unique) |
| `CLUSTER_NAME` | `hyperagent-cluster` | AKS cluster name |
| `SYSTEM_NODE_VM_SIZE` | `Standard_D2s_v3` | System node pool VM size |
| `KVM_NODE_VM_SIZE` | `Standard_D4s_v3` | KVM node pool VM size (needs nested virt) |
| `KVM_NODE_MIN_COUNT` | `1` | Autoscaler minimum nodes |
| `KVM_NODE_MAX_COUNT` | `5` | Autoscaler maximum nodes |
| `SUBSCRIPTION` | *(current)* | Azure subscription ID or name |

> **Tip:** Set `SUBSCRIPTION` if you have multiple Azure subscriptions to avoid deploying to the wrong one.

## 2. Build & Push Image

You have two options: use the pre-built image from GHCR (simplest) or build from source.

### Option A: Use published image from GHCR (recommended)

No build required. Just set the image in your config:

```bash
export HYPERAGENT_K8S_IMAGE="ghcr.io/hyperlight-dev/hyperagent:latest"
```

> **Note:** The GHCR image uses the base entrypoint. Output file retrieval via `kubectl cp` will need to target `/tmp/hyperlight-fs-*/` instead of `/output/`. The K8s-specific image (Option B) adds a wrapper that collects output to a predictable `/output/` path.

### Option B: Build from source (includes output wrapper)

```bash
# Build base image + K8s wrapper
just k8s-build

# Push to ACR
just k8s-push
```

The K8s image extends the base HyperAgent image with an entrypoint that copies output files to `/output/` for easy retrieval via `kubectl cp`.

### Which to use?

| | GHCR (Option A) | Build from source (Option B) |
|---|---|---|
| Setup | Zero build steps | Requires Docker + ACR |
| Output retrieval | Manual (`kubectl cp` with temp dir path) | Automatic (predictable `/output/` path) |
| Version | Latest published release | Whatever's in your repo |
| Best for | Quick start, testing | Production, custom builds |

## 3. Deploy Device Plugin

```bash
just k8s-deploy-plugin
```

This deploys the [hyperlight device plugin](https://github.com/hyperlight-dev/hyperlight-on-kubernetes) as a DaemonSet. It exposes `hyperlight.dev/hypervisor` as a schedulable resource via CDI, giving pods access to `/dev/kvm` without privileged containers.

Verify it's running:

```bash
just k8s-status
```

## 4. Set Up Authentication

HyperAgent needs a GitHub token with Copilot access.

### Create a Personal Access Token

1. Go to https://github.com/settings/tokens?type=beta
2. Click **"Generate new token"** (fine-grained)
3. Set an expiration and repository access (any)
4. No special permissions needed — the Copilot SDK handles its own auth channel
5. Copy the `github_pat_...` token

> **Important:** Classic PATs (`ghp_`) do NOT work — the Copilot SDK requires fine-grained PATs.

### Option A: Azure Key Vault (recommended)

Stores the token in Azure Key Vault, encrypted at rest, with RBAC access control and audit logging. The CSI Secrets Store Driver mounts it into pods automatically.

```bash
GITHUB_TOKEN=github_pat_your_token just k8s-setup-auth-keyvault
```

This:
- Enables the CSI Secrets Store Driver addon on AKS
- Creates a Key Vault in your resource group
- Stores the token as a Key Vault secret
- Grants the AKS managed identity read access
- Creates a `SecretProviderClass` that syncs the secret to the pod

**To rotate:** just update the token in Key Vault:

```bash
az keyvault secret set --vault-name <vault-name> --name github-token --value <new-token>
```

### Option B: K8s Secret (quick start)

Simpler but less secure — the token is stored base64-encoded in etcd (not encrypted by default).

```bash
GITHUB_TOKEN=github_pat_your_token just k8s-setup-auth
```

Or manually:

```bash
kubectl create secret generic hyperagent-auth \
    -n hyperagent \
    --from-literal=GITHUB_TOKEN=github_pat_your_token
```

**To rotate:** re-run `just k8s-setup-auth` (idempotent).

### Which to use?

| | Key Vault (Option A) | K8s Secret (Option B) |
|---|---|---|
| Encryption at rest | ✅ AES-256 in Key Vault | ❌ base64 in etcd (unless you enable etcd encryption) |
| Access control | ✅ Azure RBAC | ⚠️ K8s RBAC (anyone with namespace access can read) |
| Audit logging | ✅ Key Vault audit logs | ❌ None by default |
| Rotation | ✅ Update in Key Vault, pods pick up changes | ⚠️ Must re-run setup script |
| Setup complexity | More steps (one-time) | One command |
| Best for | Production | Development / quick testing |

### Troubleshooting Auth

| Error | Cause | Fix |
|-------|-------|-----|
| 401 Unauthorized | Token expired or revoked | Rotate the token (see above) |
| 403 Forbidden | No Copilot license on the account | Ensure Copilot Business/Individual is active |

## 5. Run a Prompt

```bash
# 🚀 Create a presentation on NASA's Artemis II mission with live data and images
just k8s-run --prompt "Create a presentation on the NASA Artemis II mission. Include statistics on the mission timeline, crew details, spacecraft specs, and key milestones. Fetch the latest images from the mission and crew photos. Use a space-themed dark colour scheme. 8-10 slides." --show-code --verbose --timeout 900

# 📄 Generate a professional quarterly report with charts
just k8s-run --prompt "Create a Q1 2026 report for NovaTech Industries. Include an executive summary, bar chart of monthly revenue (Jan 1.2M, Feb 1.4M, Mar 1.8M), a comparison table of Q1 2026 vs Q1 2025, and 5 operational highlights. Add page numbers and a confidential footer."

# 🌐 Research a topic and produce a PDF report with web data
just k8s-run --prompt "Research the current state of quantum computing from the web. Create a 3-page PDF covering key players (IBM, Google, IonQ), recent breakthroughs, a comparison table of qubit counts, and predictions for 2027. Include a references section." --skill research-synthesiser --timeout 900

# 📊 Build a data dashboard PDF with multiple chart types
just k8s-run --prompt "Create a data dashboard PDF for an e-commerce company called ShopWave. Include KPI cards (Revenue 8.2M, Orders 142K, AOV 57.75), a bar chart of monthly revenue, a pie chart of revenue by category, and a line chart of weekly active users over 12 weeks." --skill pdf-expert

# Keep the job after completion (for debugging)
just k8s-run --prompt "Say hello world" --no-cleanup

# Custom output directory
just k8s-run --prompt "Create a 5-slide intro to Kubernetes" --skill pptx-expert --output-dir ./k8s-deck

# Provide input files (copied into the pod before the agent starts)
just k8s-run --prompt "Analyse the CSV data and create a summary report" --input-dir ./data/ --skill pdf-expert
```

### Providing Input Files

Use `--input-dir` to copy local files into the pod before the agent starts:

```bash
just k8s-run --prompt "Process these files" --input-dir ./my-files/
```

Files are copied to `/input/` in the pod via an init container. The agent can access them with the `fs-read` plugin (`read_input` tool).

### What Happens

1. A unique K8s Job is created in the `hyperagent` namespace
2. The pod gets `/dev/kvm` injected via the device plugin
3. HyperAgent runs the prompt with `--auto-approve`
4. On completion, output files are copied from the pod to your local machine
5. Logs are streamed to stdout
6. The job is cleaned up (unless `--no-cleanup`)

### Monitoring a Running Job

The `k8s-run` script waits and streams output automatically. To monitor from another terminal:

```bash
# Stream live logs (finds the latest running job automatically)
kubectl logs -n hyperagent -l hyperagent.dev/type=prompt-job -f

# Watch pod status (Pending → Running → Succeeded/Failed)
kubectl get pods -n hyperagent -l hyperagent.dev/type=prompt-job -w

# Watch job status
kubectl get jobs -n hyperagent -w

# Full pod details (scheduling, image pull, device injection events)
kubectl describe pod -n hyperagent -l hyperagent.dev/type=prompt-job
```

If you have multiple jobs running, target a specific one by name (printed by `k8s-run` on startup):

```bash
kubectl logs -n hyperagent -l job-name=hyperagent-1776253555-6427d230 -f
```

### Retrieving Output Files

The `k8s-run` script retrieves files automatically to `./output-<jobname>/`. To retrieve manually:

```bash
# Find the pod name
kubectl get pods -n hyperagent -l job-name=<jobname> -o name

# Copy all output files
kubectl cp hyperagent/<pod-name>:/output/ ./my-output/

# Copy a specific file
kubectl cp hyperagent/<pod-name>:/output/invoice.pdf ./invoice.pdf
```

> **Note:** Completed pods are kept for **10 minutes** (`ttlSecondsAfterFinished: 600`) to allow file retrieval. After that, K8s garbage collects them.

### Timeouts

There are **two timeouts** to be aware of:

| Timeout | Default | What it controls | Override |
|---------|---------|-----------------|----------|
| **Job timeout** | 600s (10 min) | How long `kubectl wait` waits for the Job to complete | `--timeout 900` on `k8s-run` |
| **Agent send timeout** | 300s (5 min) | How long HyperAgent waits for the LLM to respond before giving up | `HYPERAGENT_SEND_TIMEOUT_MS` env var in Job manifest |

The agent's default `--send-timeout` of **5 minutes** may be too short for complex prompts (PDF generation, research). To increase it, set the env var in the Job manifest or pass it via `EXTRA_ARGS`:

```bash
# For long-running prompts, increase both timeouts:
just k8s-run --prompt "Research and write a 10-page report" --skill research-synthesiser --timeout 1200
```

To permanently increase the agent timeout, add to the job manifest (`deploy/k8s/manifests/hyperagent-job.yaml` or `hyperagent-job-keyvault.yaml`):

```yaml
env:
  - name: HYPERAGENT_SEND_TIMEOUT_MS
    value: "900000"  # 15 minutes
```

## 6. Cost Management

AKS nodes don't scale to zero. Stop the cluster when not in use:

```bash
# Stop (saves compute costs, keeps config)
just k8s-stop

# Start when needed
just k8s-start

# Destroy everything when done
just k8s-infra-down
```

## Command Reference

### Local (KIND)

| Command | Description |
|---------|-------------|
| `just k8s-local-up` | Create KIND cluster + local registry |
| `just k8s-local-down` | Tear down KIND cluster + registry |
| `just k8s-local-build` | Build image + push to local registry |
| `just k8s-local-deploy-plugin` | Deploy device plugin to KIND |
| `just k8s-local-run` | Run a prompt on KIND |

### Azure (AKS)

| Command | Description |
|---------|-------------|
| `just k8s-infra-up` | Create AKS + ACR + KVM node pool |
| `just k8s-infra-down` | Delete all Azure resources |
| `just k8s-stop` | Stop AKS cluster (save costs) |
| `just k8s-start` | Start AKS cluster |
| `just k8s-credentials` | Get kubectl credentials |
| `just k8s-deploy-plugin` | Deploy hyperlight device plugin |
| `just k8s-build` | Build K8s Docker image |
| `just k8s-push` | Push image to ACR |
| `just k8s-run` | Run a prompt as a K8s Job |

### Shared

| Command | Description |
|---------|-------------|
| `just k8s-setup-auth` | Create/update GitHub token (K8s Secret — dev/testing) |
| `just k8s-setup-auth-keyvault` | Set up auth via Azure Key Vault (recommended for AKS) |
| `just k8s-smoke-test` | Verify cluster, plugin, auth, and resources are all working |
| `just k8s-status` | Show cluster/plugin/job status |

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `No hypervisor resource available` | Device plugin not deployed or not running. Run `just k8s-deploy-plugin` |
| `ImagePullBackOff` | ACR not attached or image not pushed. Run `just k8s-push` |
| Job timeout | Increase with `--timeout`. Check pod events: `kubectl describe pod -n hyperagent -l job-name=<name>` |
| Pod OOMKilled | The prompt needs more memory. Edit job manifest `resources.limits.memory` |
| `connection refused` | Cluster stopped. Run `just k8s-start` |

## Security

- **Non-root**: Pods run as UID 1001 (hyperagent user)
- **No privilege escalation**: `allowPrivilegeEscalation: false`
- **Capabilities dropped**: `drop: ["ALL"]`
- **Seccomp**: `RuntimeDefault` profile
- **No K8s API access**: `automountServiceAccountToken: false`
- **Namespace isolation**: All jobs in `hyperagent` namespace
- **Token storage**: K8s Secrets are base64-encoded, **not encrypted at rest by default**. For production, enable [etcd encryption](https://kubernetes.io/docs/tasks/administer-cluster/encrypt-data/) or use [Azure Key Vault CSI driver](https://learn.microsoft.com/en-us/azure/aks/csi-secrets-store-driver).

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│ Your Machine                                            │
│                                                         │
│  hyperagent-k8s CLI                                     │
│    ├── kubectl create job → renders manifest template    │
│    ├── kubectl wait        → polls for completion        │
│    ├── kubectl cp          → retrieves output files      │
│    ├── kubectl logs        → streams agent output        │
│    └── kubectl delete job  → cleanup                     │
└──────────────────────┬──────────────────────────────────┘
                       │ kubectl
                       ▼
┌─────────────────────────────────────────────────────────┐
│ K8s Cluster (KIND local or AKS cloud)                   │
│                                                         │
│  hyperlight-system namespace                            │
│    └── device-plugin DaemonSet (exposes /dev/kvm)       │
│                                                         │
│  hyperagent namespace                                   │
│    ├── hyperagent-auth Secret (GITHUB_TOKEN)            │
│    └── hyperagent-<id> Job                              │
│         └── Pod (non-root, seccomp, caps dropped)       │
│              ├── /dev/kvm (injected by device plugin)   │
│              ├── /output/ (emptyDir for file retrieval) │
│              └── HyperAgent binary                      │
│                   └── Hyperlight micro-VM sandbox       │
└─────────────────────────────────────────────────────────┘
```
