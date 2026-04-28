# HyperAgent

HyperAgent is a sandboxed code-acting AI agent runtime: it writes JavaScript handlers, validates them, and runs them inside hardware-isolated [Hyperlight](https://github.com/hyperlight-dev/hyperlight) micro-VMs using the [GitHub Copilot SDK](https://github.com/github/copilot-sdk).

It is built for useful, bounded work: data analysis, document generation, API workflows, secure file output, and tool use through plugins and MCP servers. The model can write code, but the code runs in a sandbox with no direct filesystem, shell, or network access unless you explicitly enable narrowly scoped host capabilities.

> **Warning:** HyperAgent is pre-release software created by AI. Not for production use. Be careful where you run it and what you do with it. Consider running it in a container.
>
> **Platform note:** HyperAgent requires hardware virtualization: Linux with KVM, Azure Linux with MSHV, Windows with WHP, or WSL2 with KVM. It does not currently run on macOS [because of this Hyperlight issue](https://github.com/hyperlight-dev/hyperlight/issues/45).

## Why HyperAgent?

Most agent CLIs are powerful because they can touch your machine directly: shell commands, file edits, network calls, local tools, credentials, and long-lived process state. That is useful, but it also means a bad instruction, hallucinated command, or prompt-injected webpage can become real host activity very quickly.

HyperAgent takes a different route. The model acts by writing JavaScript handlers, and those handlers run inside a hardware-isolated Hyperlight micro-VM. By default there is no shell, no filesystem, no network, and no process access. When the task needs host capabilities, they are added deliberately through plugins, profiles, or MCP servers.

Because handlers can fetch, parse, filter, aggregate, and validate data before returning, the model does not have to read every raw API response, file, or plugin result itself. Well-written handlers can reduce large tool outputs into compact, relevant results, keeping more of the conversation focused on decisions instead of data plumbing and often dramatically reducing token consumption during research, repair, and analysis loops.

What that gets you:

| Instead of                | HyperAgent gives you                                                |
| ------------------------- | ------------------------------------------------------------------- |
| Shell-first automation    | Code-first handlers that are validated and run in a micro-VM        |
| Ambient filesystem access | Path-jailed read/write plugins                                      |
| Ambient network access    | Domain-scoped fetch with SSRF checks                                |
| Ad hoc tool calls         | Normal JavaScript APIs for approved capabilities                    |
| One-off generated scripts | Reusable handlers and modules                                       |
| Hidden agent state        | Explicit shared state, transcript logs, debug logs, and timing logs |
| Trust-me execution        | Tool gating, code validation, plugin approval, and MCP review       |

The goal is not to make AI automation risk-free. It is to make the boundary obvious: model-generated code runs in the sandbox; host capabilities are explicit decisions.

## What Can You Do With HyperAgent?

Ask HyperAgent for an outcome, not a script. It will plan the workflow, register sandboxed JavaScript handlers, use built-in modules, ask for plugins or MCP servers when needed, and produce files or structured results.

| Ask for          | HyperAgent can                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Reports          | Fetch data, transform it, summarise it, and write Markdown, JSON, CSV, PDF, PPTX, or other generated outputs               |
| Presentations    | Build PowerPoint decks with themes, layouts, tables, charts, notes, transitions, and images                                |
| PDFs             | Generate structured PDF reports with text, tables, charts, callouts, metadata, and visual layout checks                    |
| Spreadsheets     | Build XLSX workbooks with typed workbook APIs for sheets, styles, pivots, charts, validation, and print settings           |
| Data pipelines   | Chain fetch, parse, validate, transform, and output steps inside reusable handlers                                         |
| External systems | Connect approved MCP servers for Microsoft 365, GitHub, databases, internal APIs, SaaS tools, or local business systems    |
| API exploration  | Discover API shapes, call endpoints through the fetch plugin or MCP tools, normalise results, and create reusable handlers |
| Safer automation | Keep generated code away from your shell by default; host capabilities are explicit, audited, and gated                    |

## Example Prompts

These are the kinds of jobs HyperAgent is designed to handle.

### Build a PowerPoint Deck

```bash
hyperagent --skill pptx-expert --profile web-research \
  --prompt "Create a presentation on the NASA Artemis II mission include lots of statistics and data, use an appropriate theme and color scheme for the subject, your aim is to inspire the audience to find out more and get involved, make sure you go to the Internet to get the very latest mission information from https://www.nasa.gov/mission/artemis-ii and images/multimedia from https://www.nasa.gov/artemis-ii-multimedia/, ensure you include photos taken by the crew during the mission, make it stunning"
```

The agent can use `ha:pptx`, `ha:pptx-charts`, and `ha:pptx-tables` to create editable PowerPoint files instead of screenshots glued into slides.

The `web-research` profile gives the run enough room for image-heavy work. HyperAgent still has to use approved fetch and file-output capabilities before it can download NASA images or save the deck.

### Create a PDF Report

```bash
hyperagent --skill pdf-expert --profile file-builder \
  --prompt "Create a polished PDF report for API latency this month. Include a title page, summary callouts, percentile table, line chart, and recommendations. Save it as latency-report.pdf."
```

PDF work uses document modules rather than shelling out to arbitrary tools, so the generated code remains inspectable and sandboxed.

### Produce an Excel Workbook

```bash
hyperagent --skill xlsx-expert --profile file-builder \
  --prompt "Create an Excel workbook from the quarterly sales data. Include a formatted data sheet, frozen header row, filters, a pivot table by region, a revenue chart, conditional formatting, and validation lists. Save it as sales-analysis.xlsx."
```

The agent uses `ha:xlsx`, a typed workbook API for sheets, cells, styles, pivots, charts, sparklines, validation, hyperlinks, images, protection, print settings, and named ranges.

### Work With Microsoft 365 Through MCP

```bash
hyperagent --profile web-research \
  --prompt "Connect to the Microsoft 365 MCP server, find the latest Teams channel posts about the launch plan, summarise blockers, create a PDF status brief, and draft a follow-up message for the owners. Ask before sending anything."
```

MCP servers run outside the Hyperlight sandbox, so HyperAgent treats them differently from in-VM code: servers must be configured and approved, tool schemas are exposed as typed `host:mcp-*` modules, and write/destructive actions can be gated.

### Analyse an API and Save the Output

```bash
hyperagent --profile web-research \
  --prompt "Call the public GitHub API for this repo, summarise open PRs by risk, generate a Markdown report, and save the raw JSON plus report to disk."
```

The model can discover plugins, enable `fetch` with a domain allowlist, register handlers, and write outputs through the path-jailed `fs-write` plugin.

Add `--auto-approve` for trusted non-interactive runs. It skips approval prompts, so treat it as yolo mode. Without it, HyperAgent can pause for approval before enabling plugins, connecting MCP servers, or taking write-capable actions.

## How It Works

HyperAgent gives the model custom tools instead of raw shell access. The usual flow is:

1. The model decides what code it needs.
2. It registers a named JavaScript handler with `register_handler`.
3. HyperAgent validates the code and compiles it for the sandbox.
4. The handler runs inside a Hyperlight micro-VM.
5. If host access is needed, the model must use explicit plugins or MCP modules.
6. Results come back as structured data or files written through approved paths.

```text
User prompt
  -> GitHub Copilot SDK session
  -> HyperAgent tool gate
  -> Code validation
  -> Hyperlight JavaScript sandbox
  -> Built-in modules + approved plugins + approved MCP tools
  -> Result, report, workbook, deck, or file output
```

The sandbox has no direct filesystem, network, shell, or process access. Capabilities are added deliberately:

| Capability       | How it is exposed                                                |
| ---------------- | ---------------------------------------------------------------- |
| Files            | `fs-read` and `fs-write` plugins with path jails                 |
| HTTP             | `fetch` plugin with domain allowlists and SSRF checks            |
| Reusable code    | `ha:*` system and user modules                                   |
| External systems | MCP servers exposed as typed `host:mcp-*` modules                |
| Bigger jobs      | Profiles that raise limits; profile tools can enable plugin sets |

## Built-In Modules

Handlers import system modules with `ha:<name>` specifiers.

| Module                                                   | What it is for                                            |
| -------------------------------------------------------- | --------------------------------------------------------- |
| `ha:shared-state`                                        | Cross-handler state preserved across sandbox recompiles   |
| `ha:zip-format`                                          | ZIP archive creation for document formats                 |
| `ha:pptx`                                                | PowerPoint deck generation                                |
| `ha:pptx-charts`                                         | Editable PowerPoint charts                                |
| `ha:pptx-tables`                                         | PowerPoint table and comparison helpers                   |
| `ha:xlsx`                                                | Excel workbook generation with sheets, pivots, and charts |
| `ha:pdf`                                                 | PDF generation                                            |
| `ha:pdf-charts`                                          | PDF chart rendering                                       |
| `ha:markdown`                                            | Markdown utilities                                        |
| `ha:html`                                                | HTML-to-text and link extraction                          |
| `ha:image`                                               | Image helpers                                             |
| `ha:base64`, `ha:str-bytes`, `ha:crc32`, `ha:xml-escape` | Binary, encoding, checksum, and XML utilities             |

User modules can also be created at runtime with `register_module` and imported as `ha:<module-name>` in later handlers.

## Skills and Profiles

Skills inject domain guidance into the session. Profiles bundle resource limits and plugin requirements.

On the CLI, `--profile` applies resource limits at startup. It does not silently grant host access. During a run, HyperAgent can use `/profile apply` or the `apply_profile` tool to request the profile's plugin requirements, with approval unless you deliberately use `--auto-approve`.

```bash
# Presentation specialist with file-building limits
hyperagent --skill pptx-expert --profile file-builder

# API/data workflow with web-research limits
hyperagent --skill api-explorer --profile web-research

# Multiple profiles stack by taking the max startup limits
hyperagent --profile "web-research heavy-compute"
```

Useful skills include:

| Skill            | Use it for                                    |
| ---------------- | --------------------------------------------- |
| `pptx-expert`    | Professional PowerPoint decks                 |
| `pdf-expert`     | Structured PDF reports                        |
| `xlsx-expert`    | Excel workbook generation                     |
| `report-builder` | Multi-format reports and document output      |
| `data-processor` | Data cleaning, joins, aggregation, and export |
| `api-explorer`   | Understanding and calling APIs                |
| `web-scraper`    | Fetching and extracting web content           |
| `mcp-services`   | Working with configured MCP servers           |

## MCP Servers

HyperAgent can connect to [Model Context Protocol](https://modelcontextprotocol.io/) servers and expose their tools inside sandbox code as typed host modules. MCP is how HyperAgent can reach services such as Microsoft 365, GitHub, databases, internal APIs, SaaS tools, or local business systems without giving the model raw shell access.

Install and authenticate the MCP server you want to use first; HyperAgent does not bundle third-party service servers. After the server is installed, add it to `~/.hyperagent/config.json`:

This example uses a Microsoft 365 MCP server, but the same pattern applies to any configured MCP server:

```json
{
  "mcpServers": {
    "m365": {
      "command": "node",
      "args": ["/path/to/your/microsoft-365-mcp-server.js"],
      "env": {
        "M365_TOKEN": "${M365_TOKEN}"
      },
      "denyTools": ["delete_user", "send_mail"]
    }
  }
}
```

Then in HyperAgent:

```text
/mcp list
/mcp enable m365
```

Or ask naturally:

```text
Use the Microsoft 365 MCP server to list unread launch-plan emails, group them by owner, and create a follow-up tracker workbook. Do not send messages without asking me first.
```

The LLM discovers configured MCP servers with `list_mcp_servers`, connects with `manage_mcp`, reads TypeScript declarations with `mcp_server_info`, and then writes normal handler code like:

```javascript
import { searchMail, listDriveItems } from "host:mcp-m365";

export function handler() {
  const mail = searchMail({ query: "launch plan", unreadOnly: true });
  const docs = listDriveItems({ path: "/Launch" });
  return { mail, docs };
}
```

MCP servers are not Hyperlight-sandboxed; they run as normal host processes. Review MCP server configuration carefully and use `allowTools` / `denyTools` for anything connected to real business systems.

## Security Model

HyperAgent is designed to make generated-code execution less terrifying, not magically safe.

- **Hardware isolation:** JavaScript runs in Hyperlight micro-VMs.
- **Tool gating:** SDK built-ins like shell, edit, and grep are blocked; the model gets HyperAgent-specific tools.
- **Code validation:** Generated JavaScript is checked before execution.
- **No ambient host access:** Files, network, and external systems require explicit plugins or MCP connections.
- **Plugin auditing:** Plugin code is audited before use.
- **Path jailing:** File plugins are restricted to configured base directories.
- **SSRF protection:** The fetch plugin validates domains and resolved IPs.
- **MCP approval:** MCP servers and potentially write-capable tools require explicit trust decisions.

Read [SECURITY.md](SECURITY.md) and [docs/SECURITY.md](docs/SECURITY.md) before using HyperAgent with sensitive data or real tenant systems.

## Install and Run

### Prerequisites

- Linux with KVM, Azure Linux with MSHV, Windows with WHP, or WSL2 with KVM
- GitHub account with Copilot access
- GitHub CLI for authentication, or a `GITHUB_TOKEN`
- Docker for the container option
- Node.js 22+ for npm/source installs
- Rust toolchain and `just` for source development

### GitHub Authentication

```bash
gh auth login
gh auth status
```

Or set a token directly:

```bash
export GITHUB_TOKEN="ghp_your_token_here"
```

### Docker

```bash
docker pull ghcr.io/hyperlight-dev/hyperagent:latest

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
```

For Azure Linux with MSHV, replace `/dev/kvm` with `/dev/mshv`.

For a less manual Docker flow, use [scripts/hyperagent-docker](scripts/hyperagent-docker). It auto-detects the hypervisor, handles auth, and forwards HyperAgent/Hyperlight environment variables.

Non-interactive container run:

```bash
export HYPERAGENT_PROMPT="Create a Markdown report from the input data and save it to disk"

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

### npm

```bash
npm install -g @hyperlight-dev/hyperagent
hyperagent
```

### Build From Source

```bash
git clone https://github.com/hyperlight-dev/hyperagent.git
cd hyperagent

just setup
just start
```

Build a standalone binary:

```bash
just binary-release
dist/bin/hyperagent
```

Key development commands:

| Command               | What it does                                                   |
| --------------------- | -------------------------------------------------------------- |
| `just setup`          | First-time setup: build native addons and install npm packages |
| `just build`          | Rebuild native addons after Rust changes                       |
| `just start`          | Run the agent with `tsx`                                       |
| `just fmt`            | Format source                                                  |
| `just lint`           | Formatting check, TypeScript, Rust lint checks                 |
| `just test`           | Run TypeScript tests                                           |
| `just check`          | Full quality gate: lints plus TypeScript and Rust tests        |
| `just binary-release` | Build an optimised standalone binary                           |

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the full development guide.

## CLI Reference

```bash
# Interactive mode
hyperagent

# Use a specific model
hyperagent --model gpt-4.1

# Non-interactive mode
hyperagent --prompt "Calculate the first 100 prime numbers" --auto-approve

# Load a skill and profile
hyperagent --skill pptx-expert --profile file-builder
```

Common options:

| Flag                | Description                                    |
| ------------------- | ---------------------------------------------- |
| `--model <name>`    | LLM model                                      |
| `--prompt "<text>"` | Run one prompt and exit                        |
| `--auto-approve`    | Auto-approve interactive prompts for scripting |
| `--skill <name>`    | Invoke a domain skill                          |
| `--profile <name>`  | Apply resource profile limits at startup       |
| `--show-code`       | Log generated JavaScript                       |
| `--show-timing`     | Show execution timing                          |
| `--transcript`      | Save session transcript                        |
| `--version`         | Show version                                   |
| `--help`            | Show all options                               |

See [docs/USAGE.md](docs/USAGE.md) for the complete CLI and environment variable reference.

## Slash Commands

Type `/help` in the REPL for the full list.

| Command                 | Description                       |
| ----------------------- | --------------------------------- |
| `/model <name>`         | Switch models mid-conversation    |
| `/models`               | List available models             |
| `/plugin list`          | List plugins                      |
| `/plugin enable <name>` | Enable a plugin                   |
| `/mcp list`             | List configured MCP servers       |
| `/mcp enable <name>`    | Approve and connect an MCP server |
| `/config`               | Show current configuration        |
| `/new`                  | Start a fresh session             |
| `/resume [id]`          | Resume a saved session            |
| `/exit`                 | Exit                              |

## Documentation

| Document                             | Description                        |
| ------------------------------------ | ---------------------------------- |
| [How It Works](docs/HOW-IT-WORKS.md) | User-focused system overview       |
| [Usage Guide](docs/USAGE.md)         | Complete CLI and feature reference |
| [Architecture](docs/ARCHITECTURE.md) | System design and components       |
| [Security Model](docs/SECURITY.md)   | Detailed security architecture     |
| [MCP](docs/MCP.md)                   | Model Context Protocol integration |
| [Plugins](docs/PLUGINS.md)           | Plugin system and authoring guide  |
| [Skills](docs/SKILLS.md)             | Domain expertise system            |
| [Patterns](docs/PATTERNS.md)         | Workflow pattern system            |
| [Modules](docs/MODULES.md)           | Built-in and user module system    |
| [Profiles](docs/PROFILES.md)         | Resource and plugin profiles       |
| [Development](docs/DEVELOPMENT.md)   | Development environment setup      |
| [Releasing](docs/RELEASING.md)       | Release process                    |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.

For development setup, see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## License

Apache 2.0 - see [LICENSE.txt](LICENSE.txt).
