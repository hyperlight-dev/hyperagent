# Skills

Skills inject domain expertise into Hyperagent conversations. A skill is a markdown file with structured guidance for the LLM, enabling it to accomplish specific types of tasks more effectively.

## What Are Skills?

Skills are not code — they're knowledge. When you load a skill, its content is injected into the system message, giving the LLM:

- Domain-specific knowledge
- Best practices and anti-patterns
- Tool usage guidance
- Workflow patterns

## Using Skills

### Via CLI

```bash
# Load a skill at startup
hyperagent --skill pptx-expert

# Load multiple skills
hyperagent --skill pptx-expert --skill web-scraper

# Combine with profile
hyperagent --skill pptx-expert --profile file-builder
```

### Via Slash Command

```
You: /skill pptx-expert
  📚 Loaded skill: pptx-expert
     Expert at building professional PowerPoint presentations
```

## Built-in Skills

| Skill | Description |
|-------|-------------|
| `api-explorer` | Discover, test, and document REST/GraphQL/JSON APIs |
| `data-processor` | Transform, filter, and analyse data using sandbox handlers |
| `kql-expert` | KQL expertise for Kusto queries via Fabric RTI MCP tools |
| `mcp-services` | Connect and use external MCP servers (M365, GitHub, custom) |
| `pdf-expert` | Professional PDF documents using sandbox modules |
| `pptx-expert` | Professional PowerPoint presentations using sandbox modules |
| `report-builder` | Generate documents, reports, and formatted output |
| `research-synthesiser` | Multi-source research synthesised into structured reports |
| `web-scraper` | Extract data from web pages using fetch plugin |
| `xlsx-expert` | Excel XLSX workbooks using sandbox modules |

## Skill File Format

Skills live in `skills/<name>/SKILL.md`. The file has two parts:

### 1. YAML Frontmatter

```yaml
---
name: my-skill
description: One-line description of what this skill does
triggers:
  - keyword1
  - keyword2
patterns:
  - relevant-pattern-name
antiPatterns:
  - Don't do X
  - Avoid Y
allowed-tools:
  - register_handler
  - execute_javascript
requires-mcp:
  - mcp-server-name
---
```

### 2. Markdown Content

The rest of the file is markdown that gets injected into the system message:

```markdown
# My Skill

You are an expert at doing X. You have deep knowledge of Y
and always produce high-quality Z.

## Key Principles

1. Always do A before B
2. Use C for D
3. Never E

## Workflow

### Step 1: Analyze
...

### Step 2: Implement
...
```

## Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Skill identifier (must match directory name) |
| `description` | Yes | One-line description shown in listings |
| `triggers` | No | Keywords that suggest this skill |
| `patterns` | No | Code patterns relevant to this skill |
| `antiPatterns` | No | Common mistakes to avoid |
| `allowed-tools` | No | Tools the LLM can use with this skill |
| `requires-mcp` | No | MCP server names that must be connected for this skill |

### MCP Server Dependencies

If `requires-mcp` is specified, the skill declares which MCP servers it needs. The approach resolver checks whether required servers are connected and shows their status:

```yaml
requires-mcp:
  - fabric-rti-mcp
```

When the skill is matched, the agent enriches the guidance with MCP connection status so the LLM knows whether to prompt the user to connect the server first.

### Tool Restrictions

If `allowed-tools` is specified, only those tools are available when the skill is active. This provides security boundaries:

```yaml
allowed-tools:
  - register_handler
  - execute_javascript
  - list_modules
  - module_info
```

The LLM cannot call tools not on this list, even if they're normally available.

## Creating a Skill

### 1. Create Directory

```bash
mkdir -p skills/my-skill
```

### 2. Create SKILL.md

```markdown
---
name: my-skill
description: Expert at doing something specific
triggers:
  - something
  - specific
allowed-tools:
  - register_handler
  - execute_javascript
---

# My Skill

You are an expert at doing something specific.

## How to Use This Skill

Explain the workflow, best practices, and common patterns.

## Examples

Show typical use cases and expected outputs.
```

### 3. Test the Skill

```bash
hyperagent --skill my-skill
```

Verify the skill content appears in the conversation context.

## Skill Design Guidelines

### Be Specific

Skills work best when focused on a specific domain:
- ✅ "PowerPoint presentation expert"
- ✅ "Web scraping specialist"
- ❌ "General coding helper"

### Include Anti-Patterns

Tell the LLM what NOT to do:

```yaml
antiPatterns:
  - Don't hardcode values that should be configurable
  - Avoid monolithic handlers — split into phases
  - Never skip error handling
```

### Reference Patterns

Link to code patterns in the `patterns/` directory:

```yaml
patterns:
  - two-handler-pipeline
  - file-generation
```

### Define Workflows

Structure the skill content around workflows:

```markdown
## Workflow

### Phase 1: Research
Gather information before implementing.

### Phase 2: Implement
Build the solution using gathered data.

### Phase 3: Validate
Verify the output meets requirements.
```

## Skill Discovery

Skills are discovered automatically from:
1. `skills/` directory in the project
2. User skills in `~/.hyperagent/skills/`

List available skills:
```
You: /skill list
  📚 Available skills (10):
     api-explorer - Discover, test, and document REST/GraphQL/JSON APIs
     data-processor - Transform, filter, and analyse data
     kql-expert - KQL expertise for Kusto queries via Fabric RTI MCP
     ...
```

## Auto-Matching (Triggers)

Skills can be automatically suggested based on user intent. The `triggers` field in the frontmatter defines keywords that activate matching:

```yaml
triggers:
  - presentation
  - PPTX
  - slides
  - deck
  - PowerPoint
```

### How Matching Works

1. User types a message: "Create a PowerPoint presentation about AI"
2. Intent matcher tokenizes the message
3. Tokens are compared against each skill's triggers
4. Skills with matching triggers are ranked by score (number of matches)
5. Best match is suggested to the user

### Example

```yaml
# pptx-expert skill triggers
triggers:
  - presentation
  - PPTX
  - pptx
  - slides
  - deck
  - PowerPoint
  - slideshow
```

User says: "Build me a slide deck"
- "slide" matches → 1 point
- "deck" matches → 1 point
- Score: 2 → pptx-expert suggested

### Trigger Guidelines

- **Include variations**: "pptx", "PPTX", "PowerPoint"
- **Include synonyms**: "slides", "deck", "presentation"
- **Be specific**: Avoid generic words like "create" or "build"
- **Multi-word triggers**: "slide deck" works as substring match

## Combining Skills and Profiles

Skills and profiles serve different purposes:

- **Skills**: Domain knowledge and guidance
- **Profiles**: Resource limits and plugin presets

They work well together:

```bash
# Web scraping needs fetch plugin (profile) and scraping expertise (skill)
hyperagent --skill web-scraper --profile web-research
```

## See Also

- [PATTERNS.md](PATTERNS.md) - Code generation patterns
- [PROFILES.md](PROFILES.md) - Resource profiles
- [MODULES.md](MODULES.md) - Available modules
- [HOW-IT-WORKS.md](HOW-IT-WORKS.md) - System overview
