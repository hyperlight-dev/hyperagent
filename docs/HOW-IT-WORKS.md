# How Hyperagent Works

Hyperagent is an AI agent that writes and executes JavaScript code in a hardware-isolated sandbox. You describe what you want, and the agent handles the rest.

## The Execution Flow

```
┌─────────────┐    ┌──────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   You ask   │───▶│  LLM writes  │───▶│   Code is       │───▶│   Executes in   │
│  a question │    │  JavaScript  │    │   validated     │    │   micro-VM      │
└─────────────┘    └──────────────┘    └─────────────────┘    └─────────────────┘
                                                                      │
                          ┌───────────────────────────────────────────┘
                          ▼
                   ┌─────────────┐
                   │   Result    │
                   │  returned   │
                   └─────────────┘
```

1. **You ask** - Describe what you want in natural language
2. **LLM writes JavaScript** - The AI generates code to accomplish your task
3. **Code is validated** - Syntax and imports are checked in an isolated sandbox
4. **Executes in micro-VM** - Runs in a Hyperlight micro-VM with hardware isolation
5. **Result returned** - Output is returned to you

## What Can Hyperagent Do?

### Computation & Data Processing

Ask the agent to calculate, transform, or analyze data:

```
You: Calculate the first 100 prime numbers

  🔧 Calling execute_javascript...
  ✅ Result: [2, 3, 5, 7, 11, 13, ...]

You: Parse this JSON and extract all email addresses
You: Calculate compound interest over 10 years
You: Sort this data by date and group by category
```

### File Generation

Create complex file formats:

```
You: Create a PowerPoint presentation about cloud architecture

  🔧 Calling execute_javascript...
  ✅ Result: Wrote cloud-architecture.pptx (245 KB)

You: Generate a ZIP archive with multiple CSV files
You: Create an SVG chart from this data
You: Build a markdown report from these findings
```

File generation requires the `fs-write` plugin or `file-builder` profile.

### Web Research (with fetch plugin)

Fetch and process data from APIs:

```
You: Fetch the current Bitcoin price from CoinGecko

  🔧 Calling execute_javascript...
  ✅ Result: Bitcoin: $67,234.56

You: Scrape headlines from this news site
You: Call the GitHub API and list my repositories
You: Download this JSON and transform it
```

Web access requires the `fetch` plugin or `web-research` profile.

### Multi-Step Pipelines

Chain operations together:

```
You: Fetch data from this API, transform it, and create a spreadsheet

  🔧 Calling register_handler (fetcher)...
  🔧 Calling register_handler (transformer)...
  🔧 Calling register_handler (exporter)...
  🔧 Calling execute_javascript...
  ✅ Result: Wrote report.xlsx (128 KB)
```

## Security Model

### Hardware Isolation

All code runs in Hyperlight micro-VMs:

- **No filesystem access** - Cannot read or write files (unless plugin enabled)
- **No network access** - Cannot make HTTP requests (unless plugin enabled)
- **CPU bounded** - Execution time limited (default: 1 second)
- **Memory bounded** - Heap size limited (default: 16 MB)
- **Hardware isolation** - Runs on KVM, MSHV, or WHP hypervisors

### Tool Gating

The LLM cannot escape the sandbox:

- Most GitHub Copilot SDK built-in tools (edit, grep, read, write) are **blocked** the exceptions being `ask_user` (questions) and `report_intent` (protocol)
- The SDK's built-in bash tool is also blocked — HyperAgent provides its own `execute_bash` which runs a pure-JS bash interpreter inside the sandbox
- All functionality comes from custom Hyperagent tools (`execute_javascript`, `register_handler`, `execute_bash`, etc.)
- Even if the LLM tries to use the SDK's bash, it won't work — but `execute_bash` is available for shell-style data processing

### Code Validation

Before execution, code is validated:

- Parsed with QuickJS (same parser as runtime)
- Imports checked against available modules
- Syntax errors caught before execution

See [VALIDATION.md](VALIDATION.md) for details.

### Plugin Security

Plugins extend sandbox capabilities carefully:

- LLM audits plugin source code before enabling
- Path jailing restricts file access to specific directories
- SSRF protection validates fetch targets

See [SECURITY.md](SECURITY.md) for detailed architecture.

## Key Concepts

### Handlers

Handlers are named JavaScript functions registered in the sandbox:

```javascript
// LLM registers a handler
register_handler("calculate", `
  export default function(event) {
    return event.numbers.reduce((a, b) => a + b, 0);
  }
`);

// LLM executes it
execute_javascript("calculate", { numbers: [1, 2, 3, 4, 5] });
// Result: 15
```

Handlers persist across calls, enabling multi-step workflows.

### Modules

Built-in modules provide common functionality:

```javascript
import { encode } from "ha:base64";
import { crc32 } from "ha:crc32";
import { buildPptx } from "ha:pptx";
```

Available modules include: base64, crc32, deflate, xml-escape, zip-format, pptx, and more.

### Shared State

Handlers share data via the `ha:shared-state` module:

```javascript
import { set, get } from "ha:shared-state";

// Handler 1: Store data
set("results", { processed: true, count: 42 });

// Handler 2: Retrieve data
const results = get("results");
```

Shared state persists across handler registrations.

### Plugins

Plugins extend sandbox capabilities:

| Plugin | Provides |
|--------|----------|
| `fs-read` | Read files from configured directories |
| `fs-write` | Write files to configured directories |
| `fetch` | Make HTTPS requests to allowed domains |

Enable plugins via CLI, slash commands, or profiles.

### Profiles

Profiles bundle limits and plugins:

| Profile | Use Case |
|---------|----------|
| `default` | Math, algorithms, data transforms |
| `file-builder` | ZIP, PPTX, CSV generation |
| `web-research` | API calls, web scraping |
| `heavy-compute` | Large datasets, simulations |

```bash
hyperagent --profile file-builder
```

### Skills

Skills inject domain expertise:

```bash
hyperagent --skill pptx-expert
```

Skills provide structured guidance for specific tasks like creating PowerPoint presentations or scraping websites.

## Getting Started

### Interactive Mode

```bash
hyperagent
```

Ask questions, see code execute, iterate on results.

### Non-Interactive Mode

```bash
hyperagent --prompt "Calculate fibonacci(30)" --auto-approve
```

Run a single task and exit.

### With Profiles

```bash
hyperagent --profile web-research --skill web-scraper
```

Enable web access and load scraping expertise.

## Further Reading

- [USAGE.md](USAGE.md) - Complete CLI reference
- [PLUGINS.md](PLUGINS.md) - Plugin system details
- [SKILLS.md](SKILLS.md) - Creating custom skills
- [MODULES.md](MODULES.md) - Module system
- [PROFILES.md](PROFILES.md) - Resource profiles
- [SECURITY.md](SECURITY.md) - Security architecture
