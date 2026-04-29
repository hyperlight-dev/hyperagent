// ── CLI Argument Parsing ─────────────────────────────────────────────
//
// Parses process.argv into a typed config object. CLI flags override
// environment variables, which override hardcoded defaults.
//
// Pure module — no imports from agent state or other agent/* modules.
//
// ─────────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import type { MCPSetupCommand } from "./mcp/setup-commands.js";

export interface CliConfig {
  model: string;
  cpuTimeout: string;
  wallTimeout: string;
  sendTimeout: string;
  heapSize: string;
  scratchSize: string;
  showCode: boolean;
  showTiming: boolean;
  showReasoning: string;
  verbose: boolean;
  transcript: boolean;
  listModels: boolean;
  resumeSession: string;
  pluginsDir: string;
  debug: boolean;
  /** Capture LLM tuning data (decision logs) to a JSONL file. */
  tune: boolean;
  /**
   * Profile(s) to apply at startup (limits only, plugins need interactive
   * enable). Space-separated for stacking: "web-research heavy-compute".
   */
  profile: string;
  /**
   * Auto-approve all interactive prompts (plugin enable, config changes,
   * audit approvals, module registration). YOLO mode. 🎸
   */
  autoApprove: boolean;
  /**
   * Non-interactive prompt — send this message, wait for completion, exit.
   * Combines with --auto-approve for fully autonomous operation.
   */
  prompt: string;
  /**
   * Read prompt from a file instead of CLI arg. Avoids shell quoting
   * hell when the prompt contains quotes, newlines, or special chars.
   * CLI --prompt takes precedence over --prompt-file.
   */
  promptFile: string;
  /**
   * Skill(s) to invoke before the prompt. Space-separated names.
   * Skills inject domain expertise into the conversation.
   */
  skill: string;
  /**
   * Skip suggest_approach mandatory enforcement.
   * When true, the LLM can call any tool without calling suggest_approach first.
   */
  skipSuggest: boolean;
  /**
   * Large tool output threshold in bytes. Results exceeding this size
   * are saved to the results/ directory and the LLM receives a summary
   * with instructions to use read_output for the full data.
   */
  outputThreshold: string;
  /**
   * Show version and exit.
   */
  showVersion: boolean;
  /**
   * Standalone MCP setup/config command. Runs and exits before agent startup.
   */
  mcpSetupCommand?: MCPSetupCommand;
}

function setMCPSetupCommand(config: CliConfig, command: MCPSetupCommand): void {
  if (config.mcpSetupCommand) {
    console.error("Only one MCP setup option can be used per invocation");
    process.exit(1);
  }
  config.mcpSetupCommand = command;
}

function printUsage(): void {
  const defaults: CliConfig = parseCliArgs(["--help-noop"]); // grab defaults
  console.log(`
Usage: npx hyperagent [OPTIONS]

Launch the Hyperlight Copilot SDK Agent — an interactive AI agent
with a sandboxed JavaScript executor.

Options:
  --model <name>         LLM model (default: ${defaults.model})
  --cpu-timeout <ms>     CPU time limit per execution (default: ${defaults.cpuTimeout})
  --wall-timeout <ms>    Wall-clock backstop (default: ${defaults.wallTimeout})
  --send-timeout <ms>    Agent send-and-wait timeout (default: ${defaults.sendTimeout})
  --heap-size <MB>       Guest heap size (default: ${defaults.heapSize})
  --scratch-size <MB>     Guest scratch size (default: ${defaults.scratchSize})
  --show-code            Log generated JS to ~/.hyperagent/logs/
  --show-timing          Log timing breakdown to ~/.hyperagent/logs/
  --show-reasoning [level] Set reasoning effort (low|medium|high|xhigh, default: high)
  --verbose              Verbose output mode (scrolling reasoning, turn details)
  --transcript           Record session transcript to ~/.hyperagent/logs/
  --list-models          List available models and exit
  --resume [id]          Resume previous session (last if no ID given)
  --plugins-dir <path>   Custom plugins directory (default: ./plugins)
  --debug                Enable debug logging to ~/.hyperagent/logs/
  --tune                 Capture LLM decision/reasoning logs to ~/.hyperagent/logs/
  --profile <name>       Apply resource profile at startup (limits only)
                         Stack: --profile "web-research heavy-compute"
                         Profiles: default, file-builder, web-research, heavy-compute, mcp-network
  --auto-approve         Auto-approve all interactive prompts (YOLO mode)
  --prompt "<text>"      Send a prompt non-interactively and exit after completion
  --prompt-file <path>   Read prompt from a file (avoids shell quoting issues)
  --skill <name>         Invoke skill(s) before the prompt (e.g. --skill pptx-expert)
  --output-threshold <bytes>  Large output threshold (default: 20480 = 20KB)
  --version, -v        Show version and exit
  --help, -h           Show this help message

Standalone MCP setup commands (run and exit):
  --mcp-setup-everything       Configure the MCP everything test server
  --mcp-setup-github           Configure the GitHub MCP server (uses GITHUB_TOKEN)
  --mcp-setup-filesystem [dir] Configure the filesystem MCP server (default: /tmp/mcp-fs)
  --mcp-show-config            Show configured MCP servers
  --mcp-setup-workiq           Configure Microsoft Work IQ stdio MCP server
  --mcp-add-http <name> <url> [clientId] [tenantId] [scopes] [flow]
                               Add a generic HTTP MCP server
  --mcp-m365-create-app [args...]  Create/reuse Entra app for M365 HTTP MCP
  --mcp-setup-m365 [args...]       Configure Agent 365 HTTP MCP services
  --mcp-m365-refresh-servers [args...] Refresh the M365 MCP server catalog
  --mcp-m365-show              Show saved M365 app registration details

Plugin commands (at the REPL prompt):
  /plugins               List discovered plugins
  /enable <name>         Audit, configure, and enable a plugin
  /disable <name>        Disable an enabled plugin
  /audit <name>          Force re-audit a plugin

Environment variables (overridden by CLI flags):
  COPILOT_MODEL              Model name
  HYPERLIGHT_CPU_TIMEOUT_MS  CPU time limit (ms)
  HYPERLIGHT_WALL_TIMEOUT_MS Wall-clock limit (ms)
  HYPERAGENT_SEND_TIMEOUT_MS Agent send-and-wait timeout (ms)
  HYPERLIGHT_HEAP_SIZE_MB    Heap size (megabytes)
  HYPERLIGHT_SCRATCH_SIZE_MB   Scratch size (megabytes)
  HYPERAGENT_DEBUG           Set to '1' for debug logging
  HYPERAGENT_VERBOSE         Set to '1' for verbose output mode
  HYPERAGENT_PROFILE         Profile name(s) to apply at startup
  HYPERAGENT_PROMPT          Non-interactive prompt text
  HYPERAGENT_PROMPT_FILE     Path to file containing prompt text
  HYPERAGENT_SKILL           Skill name(s) to invoke before the prompt
  HYPERAGENT_OUTPUT_THRESHOLD_BYTES  Large output threshold (bytes)
`);
  process.exit(0);
}

/**
 * Parse CLI arguments (process.argv) into a typed config object.
 * CLI flags override environment variables, which override defaults.
 *
 * @param argv — Argument array (default: process.argv.slice(2))
 * @returns Parsed CLI config
 */
export function parseCliArgs(
  argv: string[] = process.argv.slice(2),
): CliConfig {
  const config: CliConfig = {
    model: process.env.COPILOT_MODEL || "claude-opus-4.6",
    cpuTimeout: process.env.HYPERLIGHT_CPU_TIMEOUT_MS || "1000",
    wallTimeout: process.env.HYPERLIGHT_WALL_TIMEOUT_MS || "5000",
    sendTimeout: process.env.HYPERAGENT_SEND_TIMEOUT_MS || "300000",
    heapSize: process.env.HYPERLIGHT_HEAP_SIZE_MB || "16",
    scratchSize: process.env.HYPERLIGHT_SCRATCH_SIZE_MB || "16",
    showCode: false,
    showTiming: false,
    showReasoning: process.env.HYPERAGENT_SHOW_REASONING || "",
    verbose: process.env.HYPERAGENT_VERBOSE === "1",
    transcript: process.env.HYPERAGENT_TRANSCRIPT === "1",
    listModels: process.env.HYPERAGENT_LIST_MODELS === "1",
    resumeSession: process.env.HYPERAGENT_RESUME_SESSION || "",
    pluginsDir: process.env.HYPERAGENT_PLUGINS_DIR || "",
    debug: process.env.HYPERAGENT_DEBUG === "1",
    tune: process.env.HYPERAGENT_TUNE === "1",
    profile: process.env.HYPERAGENT_PROFILE || "",
    autoApprove: process.env.HYPERAGENT_AUTO_APPROVE === "1",
    prompt: process.env.HYPERAGENT_PROMPT || "",
    promptFile: process.env.HYPERAGENT_PROMPT_FILE || "",
    skill: process.env.HYPERAGENT_SKILL || "",
    skipSuggest: process.env.HYPERAGENT_SKIP_SUGGEST === "1",
    outputThreshold: process.env.HYPERAGENT_OUTPUT_THRESHOLD_BYTES || "20480",
    showVersion: false,
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    switch (arg) {
      case "--model":
        config.model = argv[++i] ?? "";
        if (!config.model) {
          console.error("--model requires a value");
          process.exit(1);
        }
        break;
      case "--cpu-timeout":
        config.cpuTimeout = argv[++i] ?? "";
        if (!config.cpuTimeout) {
          console.error("--cpu-timeout requires a value");
          process.exit(1);
        }
        break;
      case "--wall-timeout":
        config.wallTimeout = argv[++i] ?? "";
        if (!config.wallTimeout) {
          console.error("--wall-timeout requires a value");
          process.exit(1);
        }
        break;
      case "--send-timeout":
        config.sendTimeout = argv[++i] ?? "";
        if (!config.sendTimeout) {
          console.error("--send-timeout requires a value");
          process.exit(1);
        }
        break;
      case "--heap-size":
        config.heapSize = argv[++i] ?? "";
        if (!config.heapSize) {
          console.error("--heap-size requires a value");
          process.exit(1);
        }
        break;
      case "--scratch-size":
        config.scratchSize = argv[++i] ?? "";
        if (!config.scratchSize) {
          console.error("--scratch-size requires a value");
          process.exit(1);
        }
        break;
      case "--show-code":
        config.showCode = true;
        break;
      case "--show-timing":
        config.showTiming = true;
        break;
      case "--show-reasoning": {
        // --show-reasoning can optionally take an effort level argument
        const nextArg = argv[i + 1];
        const validEfforts = ["low", "medium", "high", "xhigh"];
        if (nextArg && validEfforts.includes(nextArg.toLowerCase())) {
          config.showReasoning = nextArg.toLowerCase();
          i++;
        } else {
          // No argument or invalid → default to "high"
          config.showReasoning = "high";
        }
        break;
      }
      case "--verbose":
        config.verbose = true;
        break;
      case "--transcript":
        config.transcript = true;
        break;
      case "--list-models":
        config.listModels = true;
        break;
      case "--resume": {
        // --resume can optionally take a session ID argument
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          config.resumeSession = next;
          i++;
        } else {
          config.resumeSession = "__last__";
        }
        break;
      }
      case "--plugins-dir":
        config.pluginsDir = argv[++i] ?? "";
        if (!config.pluginsDir) {
          console.error("--plugins-dir requires a value");
          process.exit(1);
        }
        break;
      case "--debug":
        config.debug = true;
        break;
      case "--tune":
        config.tune = true;
        break;
      case "--profile":
        config.profile = argv[++i] ?? "";
        if (!config.profile) {
          console.error("--profile requires a value");
          process.exit(1);
        }
        break;
      case "--auto-approve":
      case "--yolo":
        config.autoApprove = true;
        break;
      case "--prompt":
        config.prompt = argv[++i] ?? "";
        if (!config.prompt) {
          console.error("--prompt requires a value");
          process.exit(1);
        }
        break;
      case "--prompt-file":
        config.promptFile = argv[++i] ?? "";
        if (!config.promptFile) {
          console.error("--prompt-file requires a value");
          process.exit(1);
        }
        break;
      case "--skill":
        config.skill = argv[++i] ?? "";
        if (!config.skill) {
          console.error("--skill requires a value");
          process.exit(1);
        }
        break;
      case "--skip-suggest":
        config.skipSuggest = true;
        break;
      case "--output-threshold":
        config.outputThreshold = argv[++i] ?? "";
        if (!config.outputThreshold) {
          console.error("--output-threshold requires a value");
          process.exit(1);
        }
        break;
      case "--version":
      case "-v":
        config.showVersion = true;
        break;
      case "--mcp-setup-everything":
        setMCPSetupCommand(config, { kind: "setup-everything" });
        break;
      case "--mcp-setup-github":
        setMCPSetupCommand(config, { kind: "setup-github" });
        break;
      case "--mcp-setup-filesystem": {
        const next = argv[i + 1];
        const dir = next && !next.startsWith("--") ? next : "/tmp/mcp-fs";
        if (dir === next) i++;
        setMCPSetupCommand(config, { kind: "setup-filesystem", dir });
        break;
      }
      case "--mcp-show-config":
        setMCPSetupCommand(config, { kind: "show-config" });
        break;
      case "--mcp-setup-workiq":
        setMCPSetupCommand(config, { kind: "setup-workiq" });
        break;
      case "--mcp-add-http":
        setMCPSetupCommand(config, {
          kind: "add-http",
          args: argv.slice(i + 1),
        });
        i = argv.length;
        break;
      case "--mcp-m365-create-app":
        setMCPSetupCommand(config, {
          kind: "m365-create-app",
          args: argv.slice(i + 1),
        });
        i = argv.length;
        break;
      case "--mcp-setup-m365":
        setMCPSetupCommand(config, {
          kind: "m365-setup",
          args: argv.slice(i + 1),
        });
        i = argv.length;
        break;
      case "--mcp-m365-refresh-servers":
        setMCPSetupCommand(config, {
          kind: "m365-refresh-servers",
          args: argv.slice(i + 1),
        });
        i = argv.length;
        break;
      case "--mcp-m365-show":
        setMCPSetupCommand(config, { kind: "m365-show" });
        break;
      case "--help":
      case "-h":
        printUsage();
        break;
      default:
        if (arg !== "--help-noop") {
          console.error(`Unknown option: ${arg} (use --help for usage)`);
          process.exit(1);
        }
    }
    i++;
  }

  // Resolve --prompt-file: read prompt from file if --prompt wasn't given directly.
  // CLI --prompt always wins over --prompt-file.
  if (!config.prompt && config.promptFile) {
    try {
      config.prompt = readFileSync(config.promptFile, "utf-8").trim();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `Failed to read prompt file "${config.promptFile}": ${msg}`,
      );
      process.exit(1);
    }
  }

  return config;
}
