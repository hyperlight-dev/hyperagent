---
applyTo: "skills/**"
---

# Skills

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
---

# Skill Title

Detailed instructions for the LLM when this skill is active.
```

## Current Skills

| Skill | Purpose |
|-------|---------|
| `pptx-expert` | PowerPoint presentation building |
| `pdf-expert` | PDF document building |
| `research-synthesiser` | Research and synthesis |
| `data-processor` | Data processing workflows |
| `web-scraper` | Web scraping |
| `report-builder` | Report generation |
| `api-explorer` | API exploration |

## Triggers

Skills are activated when user input matches trigger keywords. Multiple skills can match — the agent decides which to use.

## Allowed Tools

The `allowed-tools` frontmatter restricts which tools the skill can use. This provides a security boundary for domain-specific operations.
