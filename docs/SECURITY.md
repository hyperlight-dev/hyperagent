# Security Architecture

This document describes Hyperagent's security model in detail.

## Overview

Hyperagent implements defense-in-depth security through multiple layers. No single layer is sufficient — they work together to provide comprehensive protection.

## Security Layers

### Layer 1: Tool Gating

The Copilot SDK provides built-in tools (bash, edit, grep, read, write) that would allow arbitrary code execution. Hyperagent blocks most of them, allowing only safe tools like `ask_user` (for user interaction) and `report_intent` (protocol).

Hyperagent provides its own `execute_bash` tool — a pure-JS bash interpreter (just-bash) running **inside** the Hyperlight sandbox. This is NOT the SDK's bash tool and does NOT have host shell access. It supports ~50 common commands (ls, grep, jq, curl, sed, awk, etc.) with the same isolation guarantees as `execute_javascript`.

**Implementation** (`src/agent/tool-gating.ts`):
- Intercepts all tool calls from the LLM
- Maintains an allowlist of custom tools plus safe SDK tools
- Rejects any tool not on the allowlist
- Logs blocked attempts for debugging

**Effect**: The LLM cannot escape the sandbox by calling SDK tools. Even if prompted to "run bash", the SDK's bash tool is rejected. The sandboxed `execute_bash` runs inside a micro-VM with no host shell access.

### Layer 2: Hyperlight Micro-VMs

JavaScript executes in hardware-isolated micro-VMs powered by Hyperlight.

**Isolation Properties**:
- No filesystem access (no `fs`, no `__dirname`)
- No network access (no `fetch`, no `net`)
- No process access (no `child_process`, no `exec`)
- No environment access (no `process.env`)

**Resource Limits**:
| Resource | Default | Configurable |
|----------|---------|--------------|
| CPU time | 1000ms | `--cpu-timeout` |
| Wall clock | 5000ms | `--wall-timeout` |
| Heap size | 16MB | `--heap-size` |
| Scratch size | 16MB | `--scratch-size` |

**Hypervisor Support**:
- KVM (Linux)
- MSHV (Azure Linux)
- WHP (Windows 11/ Windows Server 2025 Hyper-V)

### Layer 3: Code Validation

LLM-generated code is validated before execution in an isolated Rust guest.

**Validation Steps**:
1. Parse with QuickJS (same parser as runtime)
2. Check syntax validity
3. Validate imports against available modules
4. Verify handler structure (default export function)

**Implementation** (`src/agent/analysis-guest.ts`):
- Wraps the native Rust validation sandbox
- Runs in its own Hyperlight micro-VM
- Returns structured validation results

**Why Validate?**:
- Catch syntax errors before execution
- Ensure imports will resolve
- Same parser = perfect fidelity
- Validation itself is sandboxed

See [VALIDATION.md](VALIDATION.md) for details.

### Layer 4: Plugin Security

Plugins extend sandbox capabilities with host functions. Since plugins run on the host with full privileges, they require careful security.

**Static Analysis**:
- Pattern matching via Rust (`plugin_scan.rs`)
- Linear-time regex (ReDoS-safe)
- Detects dangerous APIs: `eval`, `exec`, `spawn`, `require`

**LLM Deep Audit**:
- Full source analysis by LLM
- Risk classification (LOW → CRITICAL)
- Description accuracy verification
- Finding aggregation

**Anti-Prompt-Injection**:
- Canary injection with unique UUIDs
- LLM must report canaries as injections
- Missing canaries = compromised audit
- Hallucinated canaries = unreliable audit

**Approval Persistence**:
- SHA-256 content hash stored with approval
- Approval revoked if source changes
- Forces re-audit on modification

See [PLUGINS.md](PLUGINS.md) for full details.

### Layer 5: Path Jailing

Filesystem plugins restrict access to configured directories.

**Implementation** (`plugins/shared/path-jail.ts`):
- Resolves symlinks before checking
- Validates path is within allowed directories
- Blocks traversal attacks (`../`)
- Prevents access outside jail

**Configuration**:
```
/plugin enable fs-read basePath=/home/user/data
```

Only files under `/home/user/data` are accessible.

### Layer 6: SSRF Protection

The fetch plugin validates network requests to prevent Server-Side Request Forgery.

**DNS Validation**:
- Resolves hostname before connecting
- Blocks private IPs (10.x, 172.16-31.x, 192.168.x)
- Blocks localhost and link-local
- Blocks IPv6 private ranges

**Post-Connect Validation**:
- Re-validates after connection
- Catches DNS rebinding attacks
- Validates the actual connected IP

**Domain Allowlist**:
```
/plugin enable fetch allowedDomains=api.github.com,example.com
```

Only requests to allowed domains succeed.

## Threat Model

### Threat 1: Malicious LLM Output

The LLM might be manipulated (via prompt injection) to generate harmful code.

**Mitigations**:
- Tool gating blocks dangerous tools
- Sandbox isolates code execution
- Resource limits prevent DoS
- Validation catches errors early

### Threat 2: Malicious Plugin Author

A plugin might intentionally do harm.

**Mitigations**:
- Static analysis flags dangerous patterns
- LLM audit classifies risk
- Canary verification detects manipulation
- Human review before enable
- Approval requires explicit action

### Threat 3: Plugin Prompt Injection

Plugin source might contain strings that manipulate the LLM auditor.

**Mitigations**:
- Canary injection with unique UUIDs
- Auditor must report both canaries
- Missing canaries = CRITICAL risk
- Full source visible (no hiding)

### Threat 4: Host Escape

Guest code might attempt to access host resources.

**Mitigations**:
- Hardware isolation via hypervisor
- No filesystem/network access
- Plugins are audited before enable
- Path jailing for file plugins
- SSRF protection for network plugins

### Threat 5: Supply Chain Attack

External packages might contain malicious code.

**Mitigations**:
- Plugins must not import npm packages
- Static analysis flags external imports
- Only Node.js builtins allowed
- Builtin modules are vendored

## Trust Boundaries

```
┌──────────────────────────────────────────────────────────────┐
│                         UNTRUSTED                            │
│                                                              │
│  LLM Output       Guest JavaScript       Plugin Source       │
│  (any prompt)     (any code)             (any content)       │
└──────────────────────────────────────────────────────────────┘
                             │
           ┌─────────────────┴─────────────────┐
           │        SECURITY BOUNDARY          │
           │                                   │
           │  Tool Gating                      │
           │  Code Validation                  │
           │  Hardware Isolation               │
           │  Plugin Auditing                  │
           │  Path Jailing                     │
           │  SSRF Protection                  │
           └─────────────────┬─────────────────┘
                             │
┌──────────────────────────────────────────────────────────────┐
│                          TRUSTED                             │
│                                                              │
│  Agent Code        Copilot SDK         Node.js Runtime       │
│  (reviewed)        (GitHub)            (system)              │
└──────────────────────────────────────────────────────────────┘
```

## Defense Summary

| Attack Vector | Defense |
|---------------|---------|
| Arbitrary command execution | Tool gating blocks SDK tools |
| Filesystem access | Sandbox isolation + path jailing |
| Network access | Sandbox isolation + SSRF protection |
| Resource exhaustion | CPU/memory limits |
| Malicious plugin | Static + LLM audit + approval |
| Prompt injection in plugin | Canary verification |
| Code injection | Validation before execution |
| Supply chain | No external packages allowed |

## Configuration Security

### Environment Variables

Sensitive configuration should use environment variables:
- `GITHUB_TOKEN` - GitHub authentication
- Other secrets via `process.env` (not in code)

### Plugin Configuration

Plugin configuration is session-scoped:
- Not persisted across sessions
- Must be re-entered each time
- User controls what plugins can access

### Approval Storage

Plugin approvals stored in `~/.hyperagent/approved-plugins.json`:
- Content hash invalidates on change
- Machine-local (not shared)
- Can be cleared manually

## Limitations

### Pre-Release Software

Hyperagent is pre-release software:
- Not audited for production use
- Security model is experimental
- Run in a container for additional isolation
- Docker image runs as non-root user (defence in depth against VM escape)

### LLM Reliability

LLM auditing is not perfect:
- May miss subtle issues
- Canaries provide verification
- Human review is important

### Plugin Trust

Plugins run with host privileges:
- Only enable plugins you trust
- Review source before approval
- Understand what you're enabling

## See Also

- [ARCHITECTURE.md](ARCHITECTURE.md) - System architecture
- [VALIDATION.md](VALIDATION.md) - Code validation details
- [PLUGINS.md](PLUGINS.md) - Plugin security model
- [HOW-IT-WORKS.md](HOW-IT-WORKS.md) - User overview
