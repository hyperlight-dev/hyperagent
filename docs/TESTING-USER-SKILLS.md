# Testing the User-Generated Skills Feature

A walkthrough for verifying the **user skills** feature end-to-end. The
feature lets a user persist what HyperAgent learned in a session as a
reusable skill at `~/.hyperagent/skills/<name>/SKILL.md`, surviving
upgrades and overriding system skills with the same name.

---

## Prerequisites

- A working HyperAgent checkout
- `just setup` already run (Rust addons built, deps installed) — see the
  project [README](../README.md) and [DEVELOPMENT.md](DEVELOPMENT.md)
- A terminal where `just start` launches the agent successfully
- A working GitHub Copilot login for the agent's LLM calls

---

## 1. Smoke Test (~2 minutes)

This is the minimum bar — if this works, the feature is wired up
end-to-end.

```bash
# Use a throwaway skills dir so you don't pollute ~/.hyperagent/skills/
export HYPERAGENT_USER_SKILLS_DIR=/tmp/ha-skills-test
mkdir -p "$HYPERAGENT_USER_SKILLS_DIR"

just start
```

In the agent REPL:

```text
> /skills
```

Confirms baseline — only **system** skills should appear, none with the
👤 (user) badge.

Now do some work the agent will remember:

```text
> use the fetch plugin to grab https://example.com and tell me the title
```

Let it run to completion. Then ask the agent to save what it learned:

```text
> /save-skill fetch-page-title
```

**Expected behaviour:**

1. The agent receives a synthetic prompt summarising the session
   context (tools used, MCP servers, modules registered, recent errors)
2. The LLM calls the `generate_skill(...)` tool
3. You see an interactive approval prompt showing a **summary** — the
   skill name, the one-line description, a preview of the first few
   triggers, the allowed-tools list, and a byte count for the guidance
   body. (The full content is *not* echoed to stdout.)
4. Hit `y` to approve

Verify the file landed on disk:

```bash
cat /tmp/ha-skills-test/fetch-page-title/SKILL.md
```

You should see a valid SKILL.md with YAML frontmatter (`name`,
`description`, `triggers`, etc.) and a markdown guidance body.

If that file exists, **the feature works.** 🎉

---

## 2. Full Workout

Exercise every command path. From a fresh `just start`:

```text
> /skills                                 # list both system + user skills
> /skills info kql-expert                 # show full detail for a bundled system skill
> /save-skill                             # no name → LLM picks one
> /skills                                 # user skill now shows with 👤
> /skills info fetch-page-title           # user skill detail
> /skills edit fetch-page-title           # prints the user-skill path; open it in your editor
> exit
```

> `/skills edit <name>` does **not** spawn `$EDITOR`. It just prints
> the absolute path to the user-skill `SKILL.md` so you can open it
> in your own editor of choice. Save the file, then restart (or run
> `/suggest_approach`) and the change takes effect.

Then restart the agent and repeat the original task — the matching
`/suggest_approach` should surface the saved skill via its triggers.

---

## 3. Override Test

User skills must override system skills with the same name. Drop a user
skill that shadows an existing system one (pick any skill that `ls
skills/` shows — here we use `kql-expert`):

```bash
mkdir -p "$HYPERAGENT_USER_SKILLS_DIR/kql-expert"
cat > "$HYPERAGENT_USER_SKILLS_DIR/kql-expert/SKILL.md" << 'EOF'
---
name: kql-expert
description: My customised KQL skill
triggers: [kql, kusto, query]
allowed-tools: [execute_javascript]
---
This overrides the system version.
EOF

just start
```

In the REPL:

```text
> /skills
```

**Expected:** the `kql-expert` row appears with the **`👤 (overrides
built-in)`** badge in the list view. Running `/skills info kql-expert`
then shows the **user** description ("My customised KQL skill").

---

## 4. Negative / Boundary Tests

Validation should reject bad input cleanly without crashing the agent:

| Input | Expected outcome |
|-------|------------------|
| `/save-skill BadName` | Rejected — not kebab-case |
| `/save-skill ../escape` | Rejected — path traversal |
| `/save-skill thisnameisreallylongandshouldfailitsbeyondsixtyfourcharactersnowforsure` | Rejected — exceeds 64 chars |
| `/save-skill info` | Rejected — reserved subcommand name |
| `/save-skill fetch-page-title` (second time, fresh session) | `generate_skill` first errors with "already exists — set overwrite=true"; the LLM retries with `overwrite=true`, and you get an **"Overwrite existing user skill?"** confirmation before the file is replaced |

---

## 5. Cleanup

```bash
rm -rf /tmp/ha-skills-test
unset HYPERAGENT_USER_SKILLS_DIR
```

---

## Verification Checklist

| Symptom | Confirms |
|---------|----------|
| `generate_skill` appears in the tool log after `/save-skill` | LLM picked up the system-message guidance ✅ |
| Approval prompt shows a skill preview | Tool handler validation working ✅ |
| `.md` file lands on disk under `$HYPERAGENT_USER_SKILLS_DIR` | `writeUserSkill()` working ✅ |
| `/skills` shows the 👤 badge for the new skill | Multi-dir loader + `source` field working ✅ |
| `/skills` shows `👤 (overrides built-in)` for shadowed system skills | Name-collision detection working ✅ |
| Restarting the agent matches the skill on similar prompts | `loadSkillsFromDirs` + boot wiring working ✅ |

---

## Likely Failure Modes & Where to Look

- **`/save-skill` runs but the LLM never calls `generate_skill`** — the
  synthetic prompt from `submitToLLM` may be too weak. See
  [src/agent/slash-commands.ts](../src/agent/slash-commands.ts) (the
  `/save-skill` handler) and
  [src/agent/system-message.ts](../src/agent/system-message.ts)
  ("SAVING WHAT YOU LEARN" section).
- **Tool not allowed** — every new tool needs registration at THREE
  points: `tools[]` array, `ALLOWED_TOOLS` in
  [src/agent/tool-gating.ts](../src/agent/tool-gating.ts), and
  `availableTools[]` in the session config. Triple-check.
- **File written but `/skills` doesn't list it** —
  `loadSkillsFromDirs()` in
  [src/agent/skill-loader.ts](../src/agent/skill-loader.ts) may not be
  reading the user dir. Verify `skillDirectories` in
  [src/agent/index.ts](../src/agent/index.ts) includes
  `getUserSkillsDir()`.

---

## Reporting Results

If something doesn't work, please capture:

1. The full agent REPL transcript
2. Contents of `$HYPERAGENT_USER_SKILLS_DIR` after the test (`ls -laR`)
3. The agent's debug log (`~/.hyperagent/logs/debug-*.log`)
4. The output of `just check` from the same checkout

…and share with the implementer. Good hunting. 🎯
