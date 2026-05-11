# Architecture

This document describes Hyperagent's system architecture.

## System Overview

```
┌───────────────────────────────────────────────────────┐
│                  Interactive REPL                     │
├───────────────────────────────────────────────────────┤
│              GitHub Copilot SDK Session               │
│    streaming | infinite sessions | multi-model        │
├───────────────────────────────────────────────────────┤
│                  Tool Gating Layer                    │
│    (blocks SDK built-in tools like edit/grep/write)    │
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
                          │
                          │ Hardware Isolation
                          │ (KVM / MSHV / WHP)
                          ▼
```

## Component Breakdown

### Entry Point (`src/agent/index.ts`)

The main agent file handles:
- CLI parsing and configuration
- REPL loop with readline integration
- Copilot SDK session management
- Tool registration and dispatch
- Slash command processing
- Plugin and skill loading

### Tool Gating (`src/agent/tool-gating.ts`)

Intercepts all tool calls from the LLM and:
- Blocks most GitHub Copilot SDK built-in tools (edit, grep, read, write)
- Allows only registered custom tools (including `execute_bash` which runs
  a sandboxed pure-JS bash interpreter, not a host shell)
- Logs blocked attempts for debugging

### Sandbox Tool (`src/sandbox/tool.js`)

Manages the Hyperlight sandbox lifecycle:
- Creates and destroys micro-VMs
- Registers handlers (named JavaScript functions)
- Executes handlers with event data
- Manages shared state persistence
- Integrates plugin host functions

### Plugin System

**Plugin Manager (`src/plugin-system/manager.ts`)**
- Discovers plugins in `plugins/` directory
- Validates manifests and loads source
- Manages plugin lifecycle (audit → configure → enable)
- Handles approval persistence

**Plugin Auditor (`src/plugin-system/auditor.ts`)**
- Static analysis via Rust guest scanner
- LLM deep audit with canary injection
- Risk classification and finding aggregation

### Validation Guest (`src/agent/analysis-guest.ts`)

TypeScript wrapper for the Rust validation sandbox:
- Validates JavaScript syntax before execution
- Checks imports against available modules
- Extracts module metadata for documentation
- Scans plugins for security issues

### Skills (`src/agent/skill-loader.ts`)

Loads domain expertise from markdown files:
- Discovers skills in `skills/` directory
- Parses YAML frontmatter for metadata
- Injects skill content into system message
- Respects tool restrictions

### Profiles (`src/agent/profiles.ts`)

Bundles resource limits and plugins:
- Defines preset configurations
- Supports profile stacking
- Applied via CLI or slash commands

## Data Flow

### Handler Registration

```
LLM calls register_handler(name, code)
         │
         ▼
┌─────────────────────────┐
│  Validation Guest       │
│  (Rust in micro-VM)     │
│  - Parse with QuickJS   │
│  - Check imports        │
│  - Validate structure   │
└─────────────────────────┘
         │ valid
         ▼
┌─────────────────────────┐
│  Sandbox                │
│  - Compile handler      │
│  - Store in registry    │
│  - Preserve state       │
└─────────────────────────┘
```

### Handler Execution

```
LLM calls execute_javascript(name, event)
         │
         ▼
┌─────────────────────────┐
│  Sandbox                │
│  - Load handler         │
│  - Inject event data    │
│  - Execute in micro-VM  │
│  - Enforce limits       │
└─────────────────────────┘
         │
         ▼
    Result returned
```

### Plugin Enable Flow

```
User: /plugin enable fetch

  1. Load plugin manifest and source
  2. Check if approved (hash-validated)
     │
     ├─ Approved: Skip to step 5
     │
     └─ Not approved:
        3. Run static analysis (Rust)
        4. Run LLM deep audit
           - Inject canaries
           - Classify risk
           - Verify canaries
  5. Interactive configuration
  6. Enable plugin
  7. Mark sandbox dirty
  8. On next execute:
     - Rebuild sandbox
     - Register host functions
```

## Trust Boundaries

```
┌──────────────────────────────────────────────────────────────┐
│                         UNTRUSTED                            │
│                                                              │
│  LLM Output          Guest Code (JavaScript)                 │
│  - prompts           - Runs in Hyperlight micro-VM           │
│  - tool calls        - No direct host access                 │
│                                                              │
└──────────────────────────────────────────────────────────────┘
                             │
                             │ Tool Gating, Validation
                             ▼
┌──────────────────────────────────────────────────────────────┐
│                        CONTROLLED                            │
│                                                              │
│  Plugin Host Functions                                       │
│  - Audited before enable                                     │
│  - Path-jailed, rate-limited                                 │
│  - Scoped by configuration                                   │
│                                                              │
└──────────────────────────────────────────────────────────────┘
                             │
                             │ Config boundaries
                             ▼
┌──────────────────────────────────────────────────────────────┐
│                         TRUSTED                              │
│                                                              │
│  Host (Node.js)                                              │
│  - Agent code                                                │
│  - Copilot SDK                                               │
│  - Full system access                                        │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

## Extension Points

### Plugins

Add new host capabilities:
- Create `plugins/<name>/` directory
- Implement `createHostFunctions(config)`
- Define manifest with `plugin.json`

See [PLUGINS.md](PLUGINS.md) for details.

### Skills

Add domain expertise:
- Create `skills/<name>/SKILL.md`
- Define YAML frontmatter
- Write guidance markdown

See [SKILLS.md](SKILLS.md) for details.

### Modules

Add sandbox utilities:
- System modules in `builtin-modules/src/`
- User modules via `register_module` tool

See [MODULES.md](MODULES.md) for details.

### Patterns

Add code generation guidance:
- Create `patterns/<name>/PATTERN.md`
- Define when to use and structure
- Loaded into system message

## Key Design Decisions

### Hardware Isolation

Hyperlight micro-VMs provide stronger isolation than software sandboxes:
- Guest code cannot access host filesystem
- Guest code cannot make network requests
- CPU and memory limits enforced by hypervisor
- Requires KVM (Linux), MSHV (Azure), or WHP (Windows)

### Tool Gating

SDK built-in tools are blocked entirely:
- Prevents LLM from executing arbitrary commands
- Forces all actions through controlled interfaces
- Audit trail for all operations

### Code Validation

LLM-generated code is validated before execution:
- Same QuickJS parser as runtime
- Catches errors early
- Validates imports against available modules

### Plugin Auditing

Plugins are analyzed before enabling:
- Static analysis catches obvious issues
- LLM audit provides deeper inspection
- Canary verification detects manipulation
- Approval persists with content hashing

## See Also

- [HOW-IT-WORKS.md](HOW-IT-WORKS.md) - User-focused overview
- [SECURITY.md](SECURITY.md) - Detailed security model
- [VALIDATION.md](VALIDATION.md) - Code validation system
- [PLUGINS.md](PLUGINS.md) - Plugin system design
