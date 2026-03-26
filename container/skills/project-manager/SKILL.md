---
name: project-manager
description: Manage projects in Obsidian under /workspace/obsidian/Projects/nanoclaw/. Use when the user asks to create a project, add or move tasks, update project status, log progress, or review what projects exist. Do NOT use for general vault notes or calendar events.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(ls:*), Bash(find:*)
---

# Project Manager

Manages structured projects in the Obsidian vault. Each project lives under:

```
/workspace/obsidian/Projects/nanoclaw/<project-name>/
  kanban.md          # Task board with Backlog / In Progress / Done columns
  status.md          # Goals, completion summary, what's next
  daily/
    YYYY-MM-DD.md    # Per-project daily progress log
```

## Scanning projects

```bash
# List all projects
ls /workspace/obsidian/Projects/nanoclaw/

# Check a specific project
ls /workspace/obsidian/Projects/nanoclaw/<project-name>/

# Search tasks by keyword across all projects
Grep("keyword", "/workspace/obsidian/Projects/nanoclaw", type="md")

# Find all kanban files
Glob("**/kanban.md", "/workspace/obsidian/Projects/nanoclaw")

# List all active projects
Grep("^status: active", "/workspace/obsidian/Projects/nanoclaw", type="md")

# Find all high-priority tasks across all projects
Grep("#prio-high", "/workspace/obsidian/Projects/nanoclaw", type="md")
```

## Creating a new project

Create three files using `Write` — it creates intermediate directories automatically.

### kanban.md template

```markdown
---
date: YYYY-MM-DD
tags:
  - project
  - nanoclaw
---

## Backlog



## In Progress



## Done

%% kanban:settings
{"kanban-plugin":"board","list-collapse":[false,false,false],"show-checkboxes":true}
%%
```

**Task line format:**
```
- [ ] Task description #prio-high #effort-med
- [x] Completed task ✅ YYYY-MM-DD
```

Tags: `#prio-high` / `#prio-med` / `#prio-low` and `#effort-high` / `#effort-med` / `#effort-low`

**Critical rules:**
- The `%% kanban:settings ... %%` block MUST be the last thing in the file. Never append content after it.
- `list-collapse` array length must match the number of `##` column headings (3 columns → `[false,false,false]`).
- Mark completed tasks with `[x]` and append ` ✅ YYYY-MM-DD`.

### status.md template

```markdown
---
date: YYYY-MM-DD
tags:
  - project
  - nanoclaw
project: <project-name>
status: active
---

# <Project Name>

## Goal

What this project is trying to achieve.

## Summary

Running log of what has been accomplished (most recent at top).

## What's Next

The immediate next action(s).
```

`status` field values: `active`, `paused`, `complete`

### First daily note (`daily/YYYY-MM-DD.md`)

```markdown
---
date: YYYY-MM-DD
tags:
  - project-log
  - nanoclaw
project: <project-name>
---

# <Project Name> — YYYY-MM-DD

## HH:MM — <session label>

What was done, searched, attempted, or discovered in this session.

- Key finding or result
- Code attempted or approach tried
- Reference: [[Note Name]] or URL
```

Use 24-hour timestamps (`HH:MM`). Append new sessions to the same day's file rather than creating a new one.

## Updating an existing project

### Add a task

Read `kanban.md`, insert the task line under the target column heading, write it back. Keep the `%% kanban:settings %%` block at the end.

### Move a task between columns

Edit `kanban.md`: remove the line from its current column, add it under the target column. When moving to Done, change `[ ]` → `[x]` and append ` ✅ YYYY-MM-DD`.

### Log daily progress

1. Check if today's file exists: `ls /workspace/obsidian/Projects/nanoclaw/<project-name>/daily/YYYY-MM-DD.md`
2. If exists → append a new `## HH:MM — <label>` section at the bottom.
3. If not → create it using the daily note template above.

Things to log: web searches and their key findings, code attempts (failures and successes), analysis and interpretations, decisions made, external references found.

### Update status.md

- Change `status:` frontmatter if project state changed.
- Prepend a new entry to **Summary** (most recent first).
- Rewrite **What's Next** to reflect the current next action.

## When to update which file

| Situation | File |
|-----------|------|
| New task identified | `kanban.md` → add to Backlog |
| Starting a task | `kanban.md` → move to In Progress |
| Task completed | `kanban.md` → move to Done with ✅ |
| Research / code session | `daily/YYYY-MM-DD.md` |
| Milestone or goal update | `status.md` |
| Project paused or finished | `status.md` (`status:` field) |
| "What's next?" | Read `status.md` → What's Next |
| "Show me tasks" | Read `kanban.md` |
| "What happened on X?" | Read `daily/YYYY-MM-DD.md` |
