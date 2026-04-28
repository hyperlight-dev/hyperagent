# HyperAgent Usage Guide

Complete reference for HyperAgent configuration, features, and commands.

## CLI Flags

| Flag                       | Description                                                    |
| -------------------------- | -------------------------------------------------------------- |
| `--model <name>`           | LLM model (default: `claude-opus-4.6`)                         |
| `--cpu-timeout <ms>`       | CPU time limit per JS execution (default: 1000)                |
| `--wall-timeout <ms>`      | Wall-clock backstop per execution (default: 5000)              |
| `--send-timeout <ms>`      | Agent inactivity timeout (default: 300000)                     |
| `--heap-size <MB>`         | Guest heap size (default: 16)                                  |
| `--scratch-size <MB>`      | Guest scratch size, includes stack (default: 16)               |
| `--profile <name>`         | Apply resource profile at startup (stackable)                  |
| `--skill <name>`           | Invoke skill(s) before the prompt                              |
| `--auto-approve`           | Auto-approve all interactive prompts                           |
| `--prompt "<text>"`        | Non-interactive: send prompt, wait for completion, exit        |
| `--prompt-file <path>`     | Read the non-interactive prompt from a file                    |
| `--show-code`              | Log generated JS to a timestamped file                         |
| `--show-timing`            | Log timing breakdown to a timestamped file                     |
| `--show-reasoning [level]` | Set reasoning effort (low\|medium\|high\|xhigh, default: high) |
| `--verbose`                | Verbose output mode (scrolling reasoning, turn details)        |
| `--transcript`             | Record session transcript to `~/.hyperagent/logs/`             |
| `--tune`                   | Capture LLM decision/reasoning logs to JSONL                   |
| `--plugins-dir <path>`     | Custom plugins directory (default: `./plugins`)                |
| `--list-models`            | List available models and exit                                 |
| `--resume [id]`            | Resume a previous session (latest if no ID given)              |
| `--skip-suggest`           | Skip mandatory suggest_approach/API-discovery enforcement      |
| `--output-threshold <n>`   | Large output threshold in bytes (default: 20480)               |
| `--debug`                  | Enable debug event/lifecycle logging                           |
| `--version`                | Show version and exit                                          |
| `--help`                   | Show help message                                              |

## Environment Variables

All configuration is also available via environment variables (overridden by CLI flags):

| Variable                            | Default           | Description                                                      |
| ----------------------------------- | ----------------- | ---------------------------------------------------------------- |
| `COPILOT_MODEL`                     | `claude-opus-4.6` | Model name for the Copilot SDK session                           |
| `HYPERLIGHT_CPU_TIMEOUT_MS`         | `1000`            | Max CPU time per JS execution (ms)                               |
| `HYPERLIGHT_WALL_TIMEOUT_MS`        | `5000`            | Max wall-clock time per execution (ms)                           |
| `HYPERAGENT_SEND_TIMEOUT_MS`        | `300000`          | Agent inactivity timeout (ms)                                    |
| `HYPERLIGHT_HEAP_SIZE_MB`           | `16`              | Guest heap size (megabytes)                                      |
| `HYPERLIGHT_SCRATCH_SIZE_MB`        | `16`              | Guest scratch size, includes stack (megabytes)                   |
| `HYPERLIGHT_INPUT_BUFFER_KB`        | `1040`            | Input buffer size (kilobytes)                                    |
| `HYPERLIGHT_OUTPUT_BUFFER_KB`       | `1040`            | Output buffer size (kilobytes)                                   |
| `HYPERAGENT_PROFILE`                | _(none)_          | Profile name(s) to apply at startup                              |
| `HYPERAGENT_AUTO_APPROVE`           | _(none)_          | Set to `1` for auto-approve mode                                 |
| `HYPERAGENT_PROMPT`                 | _(none)_          | Non-interactive prompt text                                      |
| `HYPERAGENT_PROMPT_FILE`            | _(none)_          | File containing the non-interactive prompt                       |
| `HYPERAGENT_SKILL`                  | _(none)_          | Skill name(s) to invoke                                          |
| `HYPERAGENT_TUNE`                   | _(none)_          | Set to `1` to capture LLM decision logs                          |
| `HYPERAGENT_SHOW_REASONING`         | _(none)_          | Reasoning effort level (low/medium/high/xhigh)                   |
| `HYPERAGENT_VERBOSE`                | _(none)_          | Set to `1` for verbose output mode                               |
| `HYPERAGENT_LIST_MODELS`            | _(none)_          | Set to `1` to list models and exit                               |
| `HYPERAGENT_RESUME_SESSION`         | _(none)_          | Session ID to resume, or `__last__` for latest                   |
| `HYPERAGENT_PLUGINS_DIR`            | _(none)_          | Custom plugins directory path                                    |
| `HYPERAGENT_SKIP_SUGGEST`           | _(none)_          | Set to `1` to disable suggest_approach/API-discovery enforcement |
| `HYPERAGENT_OUTPUT_THRESHOLD_BYTES` | `20480`           | Large output threshold in bytes                                  |
| `HYPERAGENT_TIMING_LOG`             | _(none)_          | Path to timing log file (default: `~/.hyperagent/logs/`)         |
| `HYPERAGENT_CODE_LOG`               | _(none)_          | Path to code log file (default: `~/.hyperagent/logs/`)           |
| `HYPERAGENT_TRANSCRIPT`             | _(none)_          | Set to `1` to record session transcript                          |
| `HYPERAGENT_DEBUG`                  | _(none)_          | Set to `1` for debug logging to `~/.hyperagent/logs/`            |

Example:

```bash
COPILOT_MODEL=gpt-5.1 HYPERLIGHT_CPU_TIMEOUT_MS=2000 hyperagent
```

## Slash Commands

Toggle options at runtime without restarting. Type `/` and press Tab for completion.

| Command                       | Effect                                                          |
| ----------------------------- | --------------------------------------------------------------- |
| `/show-code`                  | Toggle inline display of generated JavaScript                   |
| `/show-timing`                | Toggle execution timing breakdown                               |
| `/debug`                      | Toggle debug event logging                                      |
| `/timeout cpu <ms>`           | Override CPU timeout for subsequent calls                       |
| `/timeout wall <ms>`          | Override wall-clock timeout for subsequent calls                |
| `/timeout send <ms>`          | Override agent inactivity timeout                               |
| `/timeout reset`              | Reset all timeouts to defaults                                  |
| `/buffer input <kb>`          | Override input buffer size (kilobytes)                          |
| `/buffer output <kb>`         | Override output buffer size (kilobytes)                         |
| `/buffer reset`               | Reset buffer sizes to defaults                                  |
| `/transcript`                 | Toggle session transcript recording on/off                      |
| `/models`                     | List available models with capability icons                     |
| `/model <name>`               | Switch to a different model (preserves conversation)            |
| `/new`                        | Start a fresh session (blank context, same model)               |
| `/sessions`                   | List saved sessions with summaries                              |
| `/resume [id]`                | Resume a previous session (latest if no ID)                     |
| `/plugin list`                | List discovered plugins with state, risk, and approval status   |
| `/plugin enable <name> [k=v]` | Audit, configure, and enable a plugin (inline config supported) |
| `/plugin disable <name>`      | Disable an enabled plugin                                       |
| `/plugin approve <name>`      | Approve a plugin (persists until source changes or unapproved)  |
| `/plugin unapprove <name>`    | Remove plugin approval                                          |
| `/plugin audit <name>`        | Force re-audit a plugin (after source changes)                  |
| `/profile list`               | List available resource profiles                                |
| `/profile apply <name> ...`   | Apply profile limits and request required plugins               |
| `/mcp list`                   | List configured MCP servers                                     |
| `/mcp enable <name>`          | Approve and connect an MCP server                               |
| `/config`                     | Show current configuration (model, timeouts, buffers, plugins)  |
| `/help`                       | List available commands                                         |
| `/exit`                       | Exit the agent (or just type `exit`)                            |

## LLM Tools

The agent registers custom tools that the LLM can call. All SDK built-in tools
(bash, grep, edit, etc.) are **blocked** by the tool gating layer.

| Tool                 | Purpose                                                              |
| -------------------- | -------------------------------------------------------------------- |
| `register_handler`   | Register named JavaScript handler code in the sandbox                |
| `execute_javascript` | Execute a registered handler with optional event data                |
| `delete_handler`     | Remove a handler from the sandbox                                    |
| `get_handler_source` | Retrieve handler source for inspection or editing                    |
| `edit_handler`       | Surgically edit an existing handler                                  |
| `list_handlers`      | List registered handlers with line counts                            |
| `reset_sandbox`      | Clear sandbox state, keep handlers registered                        |
| `configure_sandbox`  | Change resource limits at runtime (heap, scratch, timeouts, buffers) |
| `register_module`    | Create a reusable ES module (persisted to `~/.hyperagent/modules/`)  |
| `list_modules`       | List available modules (system + user)                               |
| `module_info`        | Get module exports, JSDoc, and metadata                              |
| `delete_module`      | Delete a user-created module                                         |
| `write_output`       | Write text content through the `fs-write` plugin                     |
| `read_input`         | Read text content through the `fs-read` plugin                       |
| `read_output`        | Read content previously written as output                            |
| `manage_plugin`      | Enable/disable plugins with configuration                            |
| `list_plugins`       | Discover available plugins                                           |
| `plugin_info`        | Detailed plugin information and config schema                        |
| `apply_profile`      | Apply named resource profiles (limits + plugins in one step)         |
| `list_mcp_servers`   | List configured MCP servers and connection status                    |
| `mcp_server_info`    | Inspect MCP server tools and generated declarations                  |
| `manage_mcp`         | Connect or disconnect MCP servers                                    |
| `sandbox_help`       | On-demand guidance: patterns, state, binary I/O, fetch, debugging    |
| `report_intent`      | Protocol tool used by the model to signal intent                     |
| `ask_user`           | Ask the user structured questions (free-form or multiple choice)     |
| `llm_thought`        | _(tune mode only)_ Log structured reasoning for prompt engineering   |

## Profiles

Profiles bundle resource limits and plugin requirements into named presets.
Profiles are **additive** — stacking multiple takes the max of each limit
and the union of all plugins when applied during a session.

CLI `--profile` applies CPU, wall-clock, heap, and scratch limits at startup.
It does not silently enable plugins, and input/output buffer profile limits are
only applied at runtime. During a run, use `/profile apply` or let the LLM call
`apply_profile` to request the profile's plugin requirements.

| Profile         | Heap  | CPU     | Wall | Plugins         | Use case                                |
| --------------- | ----- | ------- | ---- | --------------- | --------------------------------------- |
| `default`       | 16MB  | 1000ms  | 5s   | _(none)_        | Math, algorithms, data transforms       |
| `file-builder`  | 128MB | 15000ms | 60s  | fs-write        | ZIP, PPTX, PDF, CSV, image generation   |
| `web-research`  | 64MB  | 2000ms  | 120s | fetch, fs-write | API calls, web scraping, data pipelines |
| `heavy-compute` | 64MB  | 10000ms | 15s  | _(none)_        | Large datasets, crypto, simulations     |

```bash
# Single profile
hyperagent --profile file-builder

# Stacked at startup — takes max of each limit
hyperagent --profile "web-research heavy-compute"
```

## Skills

Skills inject domain expertise into the conversation. A skill is a markdown
file (`skills/<name>/SKILL.md`) with YAML frontmatter specifying metadata
and allowed tools, followed by structured guidance for the LLM.

```yaml
---
name: pptx-expert
description: Expert at building professional PowerPoint presentations
allowed-tools:
  - register_handler
  - execute_javascript
---
# PowerPoint Presentation Expert
You are an expert at building professional, polished PowerPoint presentations...
```

```bash
# Interactive — load the skill and start a conversation
hyperagent --skill pptx-expert

# Autonomous — skill + prompt + auto-approve
hyperagent --skill pptx-expert --auto-approve \
  --prompt "Build a 10-slide deck on cloud architecture"
```

## Shared State & Persistence

Handlers share data via `ha:shared-state` — an in-sandbox key-value store.
**`ha:shared-state` is automatically preserved** across all sandbox recompiles.
No manual save/restore steps are needed.

```
1. Research handler stores data in shared-state
2. register_handler("builder")  ← recompile (shared-state auto-preserved)
3. execute_javascript("builder") ← builder sees all shared-state data
```

## User Modules

The LLM can create reusable ES modules at runtime via `register_module`.
User modules are persisted to `~/.hyperagent/modules/` and survive across
sessions. They're importable via `import { fn } from "ha:<name>"`.

| Tool              | Action                                                        |
| ----------------- | ------------------------------------------------------------- |
| `register_module` | Create or update a module (name, source, author, description) |
| `list_modules`    | List all modules — system + user, with size and mutability    |
| `module_info`     | Exports + JSDoc; optionally query one function by name        |
| `delete_module`   | Delete a user module (system modules are immutable)           |

## System Modules

Builtin ES modules available to handler code via `import { fn } from "ha:<name>"`:

| Module         | Description                                                       |
| -------------- | ----------------------------------------------------------------- |
| `shared-state` | Cross-handler state preserved across sandbox recompiles           |
| `ziplib`       | Native DEFLATE compression/decompression                          |
| `zip-format`   | ZIP archive builder for document formats                          |
| `doc-core`     | Shared document themes, colour validation, and input guards       |
| `ooxml-core`   | Shared OOXML units, colours, themes, content types, and rels      |
| `pptx`         | PowerPoint presentation generation                                |
| `pptx-charts`  | Editable PowerPoint charts                                        |
| `pptx-tables`  | PowerPoint tables, comparisons, and timeline helpers              |
| `xlsx`         | Excel workbook generation with sheets, pivots, charts, and styles |
| `pdf`          | PDF document generation                                           |
| `pdf-charts`   | PDF chart rendering                                               |
| `markdown`     | Markdown to HTML or plain text conversion                         |
| `html`         | HTML text and link extraction                                     |
| `image`        | PNG/JPEG/GIF/BMP dimension reading                                |
| `base64`       | Base64 encode/decode for binary data                              |
| `str-bytes`    | String and byte conversion utilities                              |
| `crc32`        | CRC-32 checksums for ZIP/PNG/gzip                                 |
| `xml-escape`   | XML escaping and simple element building                          |

## Model Management

Switch models mid-conversation with `/model <name>` — the conversation
history is preserved via the SDK's `resumeSession` API.

```
You: /models
  🤖 Available models (17):
     claude-opus-4.6 ← current 👁️🧠
     gpt-5.1 👁️🧠
     gpt-4.1 👁️
     ...

     👁️ = vision  🧠 = reasoning effort

You: /model gpt-5.1
  🔄 Model switched: claude-opus-4.6 → gpt-5.1
     Conversation history preserved.
```

## Infinite Sessions

Context compaction is enabled by default. When the context window fills up,
the SDK automatically summarises older context in the background so
conversations can continue indefinitely without hitting token limits.

- **Background compaction** triggers at 80% context usage
- **Blocking compaction** triggers at 95% (pauses briefly to compact)

## Session Management

Sessions are persisted by the SDK. You can list, resume, and create new
sessions without losing previous conversations.

```
You: /sessions
  📋 Sessions (3):
     a1b2c3d4e5f6…
       Modified: 25/02/2026, 12:30:00 — Fibonacci calculation and sorting demo
     f7e8d9c0b1a2… ← current
       Modified: 25/02/2026, 12:45:00 — Data processing pipeline

You: /resume a1b2
  ⏮️  Resumed session: a1b2c3d4e5f6…
     Model: claude-opus-4.6
```

Resume from the CLI with `--resume` (latest session) or `--resume <id>`.

## Session Transcript

Record the full session (input, output, tool calls) to a file:

```bash
# Via CLI flag
hyperagent --transcript

# Via slash command during a session
You: /transcript
  📄 Transcript started: ~/.hyperagent/logs/hyperagent-20260225-123456.log
```

Transcripts are written as ANSI-coloured `.log` files during the session,
then auto-stripped to clean `.txt` on exit.

## Non-Interactive / Scripted Mode

Combine `--prompt`, `--auto-approve`, and `--skill` for fully autonomous
operation — no interactive prompts, no human in the loop. Treat this as yolo
mode for trusted prompts only:

```bash
# Autonomous PPTX generation
hyperagent --auto-approve --skill pptx-expert \
  --profile "web-research file-builder" \
  --prompt "Build a deck comparing AWS, Azure, and GCP pricing"

# Simple computation — no plugins needed
hyperagent --auto-approve \
  --prompt "Calculate the first 100 prime numbers and return them as JSON"
```

In auto-approve mode:

- Plugin enables are approved automatically
- `ask_user` questions select the first option
- Config changes are applied without confirmation
- Module registration proceeds without review

## Command Suggestions

After each LLM response, HyperAgent scans the output for actionable slash
commands (e.g. `"/plugin enable fetch allowedDomains=api.github.com"`) and
presents them as one-keystroke suggestions. Accept with a single keypress
instead of typing the full command.

## Tuning Mode

When `--tune` is enabled, an additional `llm_thought` tool becomes available.
The LLM can log structured reasoning data (decisions, concerns, constraints,
rejected alternatives) to a JSONL file. This is useful for prompt engineering
and improving the system message guidance.

```bash
hyperagent --tune --transcript
# Decision logs written to ~/.hyperagent/tune-logs/
```

## Keep-Alive Timeout

The agent uses a custom keep-alive mechanism that resets the inactivity timer
on every session event (tool start, tool complete, message deltas). This means
long-running tool chains stay alive as long as events keep flowing — the
timeout only fires if the agent truly goes silent.

Default: 300s. Override with `--send-timeout <ms>` or `/timeout send <ms>`.
