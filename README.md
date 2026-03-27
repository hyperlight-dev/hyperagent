# HyperAgent

An AI agent with a sandboxed JavaScript executor, powered by [Hyperlight](https://github.com/hyperlight-dev/hyperlight) micro-VMs and the [GitHub Copilot SDK](https://github.com/github/copilot-sdk).

Ask the agent to compute things, and it writes & runs JavaScript in a hardware-isolated micro-VM — no filesystem, no network, no escape.

> **Warning:** HyperAgent is pre-release software created by AI. Not for production use. Be careful where you run it and what you do with it. Consider running in a container.

## Quick Start

### Prerequisites

- **Linux with KVM**, **Azure Linux with MSHV**, **Windows with WHP**, or **WSL2 with KVM** (hardware virtualization required)
- **GitHub authentication** (see [below](#github-authentication))
- **Docker** (for containerized option)
- **Node.js 22+** (for npm install / source builds only)
- **Rust + just** (for source builds only — see [Contributing](#contributing))

**NOTE:** HyperAgent does not currently run on macOS [due to this issue](https://github.com/hyperlight-dev/hyperlight/issues/45).

### GitHub Authentication

HyperAgent uses the GitHub Copilot SDK, which requires a GitHub account with Copilot access. Authenticate before running:

```bash
# Install the GitHub CLI if you don't have it
# https://cli.github.com/

# Log in to GitHub (select HTTPS, authenticate via browser)
gh auth login

# Verify it worked
gh auth status
```

Alternatively, set `GITHUB_TOKEN` directly:
```bash
export GITHUB_TOKEN="ghp_your_token_here"
```

### Option 1: Docker (recommended)

```bash
# Pull the image
docker pull ghcr.io/hyperlight-dev/hyperagent:latest

# Run with KVM (Linux / bash)
docker run -it --rm \
  --device=/dev/kvm \
  --group-add $(stat -c '%g' /dev/kvm) \
  --user "$(id -u):$(id -g)" \
  -e HOME=/home/hyperagent \
  -e GITHUB_TOKEN="$(gh auth token)" \
  -v "$HOME/.hyperagent:/home/hyperagent/.hyperagent" \
  -v "$HOME/.hyperagent/tmp:/tmp" \
  -v "$(pwd)":/workspace -w /workspace \
  ghcr.io/hyperlight-dev/hyperagent:latest

# Run with MSHV (Azure Linux / bash)
docker run -it --rm \
  --device=/dev/mshv \
  --group-add $(stat -c '%g' /dev/mshv) \
  --user "$(id -u):$(id -g)" \
  -e HOME=/home/hyperagent \
  -e GITHUB_TOKEN="$(gh auth token)" \
  -v "$HOME/.hyperagent:/home/hyperagent/.hyperagent" \
  -v "$HOME/.hyperagent/tmp:/tmp" \
  -v "$(pwd)":/workspace -w /workspace \
  ghcr.io/hyperlight-dev/hyperagent:latest
```

**Non-interactive mode with environment variables (Linux / bash):**

```bash
# Set a prompt via env var — the container picks up HYPERAGENT_* and HYPERLIGHT_* automatically
export HYPERAGENT_PROMPT="Create a summary report of today's top tech news"
docker run -it --rm \
  --device=/dev/kvm \
  --group-add $(stat -c '%g' /dev/kvm) \
  --user "$(id -u):$(id -g)" \
  -e HOME=/home/hyperagent \
  -e GITHUB_TOKEN="$(gh auth token)" \
  -e HYPERAGENT_PROMPT \
  -v "$HOME/.hyperagent:/home/hyperagent/.hyperagent" \
  -v "$HOME/.hyperagent/tmp:/tmp" \
  -v "$(pwd)":/workspace -w /workspace \
  ghcr.io/hyperlight-dev/hyperagent:latest --auto-approve --profile file-builder
```

**Non-interactive mode (Windows / PowerShell with WSL2 + KVM):**

```powershell
$env:HYPERAGENT_PROMPT = "Create a summary report of today's top tech news"
docker run -it --rm `
  --device=/dev/kvm `
  -e HOME=/home/hyperagent `
  -e GITHUB_TOKEN="$(gh auth token)" `
  -e HYPERAGENT_PROMPT="$env:HYPERAGENT_PROMPT" `
  -v "$HOME/.hyperagent:/home/hyperagent/.hyperagent" `
  -v "$HOME/.hyperagent/tmp:/tmp" `
  -v "${PWD}:/workspace" -w /workspace `
  ghcr.io/hyperlight-dev/hyperagent:latest --auto-approve --profile file-builder
```

> **Environment variables:** `COPILOT_MODEL`, `HYPERAGENT_*`, and `HYPERLIGHT_*` env vars control the model, prompt, and sandbox settings. When using `docker run` directly, pass each with `-e VAR_NAME`. The [wrapper script](scripts/hyperagent-docker) forwards them all automatically.
>
> **Tip:** For convenience, the [wrapper script](scripts/hyperagent-docker) auto-detects the hypervisor, handles auth, and forwards all config env vars.

### Option 2: npm package

```bash
# Install globally
npm install -g @hyperlight-dev/hyperagent

# Run (requires KVM/MSHV and GitHub auth)
hyperagent
```

### Option 3: Build from source

Requires Node.js 22+, Rust toolchain, and [just](https://github.com/casey/just) task runner.

```bash
# Clone the repo
git clone https://github.com/hyperlight-dev/hyperagent.git
cd hyperagent

# First-time setup — builds native Rust addons, installs npm packages
just setup

# Run the agent (tsx transpiles on the fly — no build step needed)
just start

# Or build a standalone binary
just binary-release
dist/bin/hyperagent
```

Key `just` commands:

| Command | What it does |
|---------|-------------|
| `just setup` | First-time setup (build native addons, npm install) |
| `just build` | Rebuild native addons after Rust changes |
| `just start` | Run agent with tsx (fast iteration) |
| `just binary-release` | Build optimised standalone binary to `dist/bin/hyperagent` |
| `just test` | Run TypeScript test suite |
| `just check` | Full quality gate (lint + typecheck + test) |

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the full development guide.

## Usage

```bash
# Interactive mod
hyperagent

# With a specific model
hyperagent --model gpt-4.1

# Non-interactive mode
hyperagent --prompt "Calculate the first 100 prime numbers" --auto-approve

# With skills and profiles
hyperagent --skill pptx-expert --profile file-builder
```

### Example Session

```
  ╔════════════════════════════════════════════════╗
  ║                                                ║
  ║    H Y P E R A G E N T                         ║
  ║       v0.0.0-alpha.362+abc1234                 ║
  ║                                                ║
  ║    Hyperlight × Copilot SDK Agent              ║
  ║    Sandboxed JavaScript Execution              ║
  ║                                                ║
  ╚════════════════════════════════════════════════╝

  ⚠  WARNING: Pre-release software created by AI.
     Not for production use. Be careful where you run it and what you do with it.

You: Calculate fibonacci(30)

  🔧 Calling execute_javascript...
  ✅ Result: 832040

The 30th Fibonacci number is 832040.
```

### Try These Out

#### Write a Markdown report:

**Linux (bash):**
```bash
export HYPERAGENT_PROMPT="Write a report comparing the latest iPhone and Android phones, with a summary table of specs and pros/cons. Write the report as a markdown file and save it to disk."
```

**Windows (PowerShell):**
```powershell
$env:HYPERAGENT_PROMPT = "Write a report comparing the latest iPhone and Android phones, with a summary table of specs and pros/cons. Write the report as a markdown file and save it to disk."
```

```shell
hyperagent --auto-approve --show-code --verbose
```

#### Build a PPTX presentation:

**Linux (bash):**
```bash
export HYPERAGENT_PROMPT="Research the JWT spec (header, payload, signature). Include:
- Title slide
- ""What is JWT?"" with bullet list of key points
- Code block showing a decoded JWT structure
- Flow diagram slide (use arrows and boxes to show auth flow)
- Security best practices numbered list
- Common vulnerabilities comparison table
- Resources/links slide
Use 'light-clean' theme, minimal transitions."
```

**Windows (PowerShell):**
```powershell
$env:HYPERAGENT_PROMPT = @"
Research the JWT spec (header, payload, signature). Include:
- Title slide
- "What is JWT?" with bullet list of key points
- Code block showing a decoded JWT structure
- Flow diagram slide (use arrows and boxes to show auth flow)
- Security best practices numbered list
- Common vulnerabilities comparison table
- Resources/links slide
Use 'light-clean' theme, minimal transitions.
"@
```

```shell
hyperagent --auto-approve --show-code --verbose
```

## CLI Options

Run `hyperagent --help` for full list. See [docs/USAGE.md](docs/USAGE.md) for complete reference.

Key options:

| Flag | Description |
|------|-------------|
| `--model <name>` | LLM model (default: `claude-opus-4.6`) |
| `--prompt "<text>"` | Non-interactive mode: run prompt and exit |
| `--auto-approve` | Auto-approve all prompts (for scripting) |
| `--skill <name>` | Load domain expertise (e.g., `pptx-expert`) |
| `--profile <name>` | Apply resource profile (`file-builder`, `web-research`, etc.) |
| `--version` | Show version and exit |
| `--help` | Show all options |

## Slash Commands

Type `/help` in the REPL for full list. Key commands:

| Command | Description |
|---------|-------------|
| `/model <name>` | Switch models mid-conversation |
| `/plugin enable <name>` | Enable a plugin (fs-read, fs-write, fetch) |
| `/config` | Show current configuration |
| `/new` | Start fresh session |
| `/exit` | Exit |

## Architecture

```
┌───────────────────────────────────────────────────────┐
│                  Interactive REPL                     │
├───────────────────────────────────────────────────────┤
│              GitHub Copilot SDK Session               │
│    streaming | infinite sessions | multi-model        │
├───────────────────────────────────────────────────────┤
│                  Tool Gating Layer                    │
│    (blocks all SDK built-in tools like bash/edit)     │
├───────────────────────────────────────────────────────┤
│                   Custom Tools                        │
│    register_handler, execute_javascript, ask_user     │
│    manage_plugin, apply_profile, sandbox_help ...     │
├──────────────────────────┬────────────────────────────┤
│  Hyperlight Sandbox      │  Plugin System (HOST)      │
│  ┌────────────────────┐  │                            │
│  │  QuickJS VM        │  │  - fs-read, fs-write       │
│  │  - No FS/Net       │<-│  - fetch (SSRF-safe)       │
│  │  - CPU bounded     │  │  - LLM-audited             │
│  │  - Memory safe     │  │                            │
│  └────────────────────┘  │  Runs on Node.js host,     │
│                          │  not inside the VM.        │
├──────────────────────────┴────────────────────────────┤
│              Hyperlight Validation Sandbox            │
│    (validates generated code before execution)        │
└───────────────────────────────────────────────────────┘
```

## Plugins

Plugins extend the sandbox with host capabilities:

| Plugin | Description |
|--------|-------------|
| `fs-read` | Read files (path-jailed) |
| `fs-write` | Write files (path-jailed) |
| `fetch` | HTTPS fetch (domain allowlist, SSRF protection) |

Enable with `/plugin enable <name>` or via profiles.

See [docs/PLUGINS.md](docs/PLUGINS.md) for authoring your own plugins.

## Security

- **Hardware isolation**: JavaScript runs in Hyperlight micro-VMs
- **Tool gating**: SDK tools (bash, edit, etc.) are blocked
- **Code validation**: LLM-generated code validated before execution
- **Plugin auditing**: LLM analyzes plugin code before enabling
- **Path jailing**: File plugins restricted to configured directories
- **SSRF protection**: Fetch plugin validates DNS and post-connect IPs

See [SECURITY.md](SECURITY.md) and [docs/SECURITY.md](docs/SECURITY.md) for details.

## Documentation

| Document | Description |
|----------|-------------|
| [How It Works](docs/HOW-IT-WORKS.md) | User-focused system overview |
| [Usage Guide](docs/USAGE.md) | Complete CLI and feature reference |
| [Architecture](docs/ARCHITECTURE.md) | System design and components |
| [Security Model](docs/SECURITY.md) | Detailed security architecture |
| [Code Validation](docs/VALIDATION.md) | Pre-execution code validation |
| [Plugins](docs/PLUGINS.md) | Plugin system and authoring guide |
| [Skills](docs/SKILLS.md) | Domain expertise system |
| [Patterns](docs/PATTERNS.md) | Code generation patterns |
| [Modules](docs/MODULES.md) | ES module system |
| [Profiles](docs/PROFILES.md) | Resource profiles |
| [Development](docs/DEVELOPMENT.md) | Development environment setup |
| [Releasing](docs/RELEASING.md) | Release process |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.

For development setup, see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Releasing

See [docs/RELEASING.md](docs/RELEASING.md) for release process.

## License

Apache 2.0 — see [LICENSE.txt](LICENSE.txt)
