---
name: obsidian
description: Read, write, and search notes in the Obsidian vault. Only use when the user explicitly asks about their notes, Obsidian vault, or personal knowledge base — do not use for calendar events, tasks, or general reminders.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(ls:*), Bash(find:*)
---

# Obsidian Vault

The vault is mounted at `/workspace/obsidian`. Use standard file tools to read, edit, and create notes.

## Vault layout

```
/workspace/obsidian/
  attachments/          # Images and file attachments
  audio-journal/        # Audio journal entries
  blog/                 # Blog drafts and posts
  daily notes/          # Daily journal entries
  Day Planners/         # Day planner files
  Household/            # Household tasks and notes
  ideas/                # Idea capture
  Jobs/                 # Job-related notes
  llm-chats/            # LLM conversation logs
  notes/                # General notes
  personal/             # Personal notes
  Projects/             # Project notes and planning
```

## Obsidian markdown conventions

### Frontmatter
All notes start with YAML frontmatter:
```markdown
---
date: 2026-03-22
tags:
  - topic
  - subtopic
---
```

### Wikilinks
Link to other notes using `[[Note Name]]`. The name matches the file without `.md`:
```markdown
See also [[project ideas]] and [[daily notes/2026-03-22]].
```

### Tags
Use `#tag` inline or list in frontmatter under `tags:`.

### Embeds
Embed other notes: `![[Note Name]]`

## Creating a new note

1. Choose the right folder based on content type
2. Name the file descriptively (spaces are fine: `my note.md`)
3. Include frontmatter with at least `date` and `tags`

Example:
```markdown
---
date: 2026-03-22
tags:
  - ideas
---

# My idea title

Content here...
```

## Searching the vault

```bash
# Find notes by name
Glob("**/*.md", "/workspace/obsidian")

# Search note content
Grep("search term", "/workspace/obsidian", type="md")

# List a folder
ls /workspace/obsidian/notes/
```

## Daily notes

Daily notes live in `/workspace/obsidian/daily notes/` and are named `YYYY-MM-DD.md`. Use today's date when creating a new entry.
