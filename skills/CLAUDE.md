# Skills Directory

Skills are domain-specific expertise modules that the agent can invoke. Each skill is defined by a `SKILL.md` file with YAML frontmatter.

## Skill Structure

```
skills/<skill-name>/
└── SKILL.md          # Skill definition with frontmatter + instructions
```

## SKILL.md Format

```yaml
---
name: skill-name
description: One-line description
triggers:
  - keyword1
  - keyword2
patterns:
  - pattern-name
antiPatterns:
  - "Don't do X"
allowed-tools:
  - tool_name
requires-mcp:
  - mcp-server-name
---

# Skill Title

Detailed instructions for the LLM when this skill is active.
```

## Current Skills

| Skill | Purpose |
|-------|---------|
| `api-explorer` | API discovery, testing, and documentation |
| `data-processor` | Data processing workflows |
| `kql-expert` | KQL/Kusto queries via Fabric RTI MCP |
| `mcp-services` | External MCP server integration |
| `pdf-expert` | PDF document building |
| `pptx-expert` | PowerPoint presentation building |
| `report-builder` | Report and document generation |
| `research-synthesiser` | Research and synthesis |
| `web-scraper` | Web scraping |
| `xlsx-expert` | Excel workbook generation |

## Triggers

Skills are activated when user input matches trigger keywords. Multiple skills can match — the agent decides which to use.

## Allowed Tools

The `allowed-tools` frontmatter restricts which tools the skill can use. This provides a security boundary for domain-specific operations.
