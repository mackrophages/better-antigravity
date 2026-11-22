---
name: timeline
description: >-
  Browse, rewind, undo, or redo working-tree git snapshots captured by Time
  Machine across every turn (including Bash commands). Use when the user
  invokes /timeline.
disable-model-invocation: true
---

# Time Machine (`/timeline`)

Run `scripts/timeline-cli.mjs` in the user's current workspace directory using `run_command`:

```bash
node "<skill_dir>/../../scripts/timeline-cli.mjs" --cwd "<workspace_cwd>" <args>
```

## Supported Arguments

- *(no arguments)* or `list`: Displays all recorded states (`◉` current, `●` ancestor, `○` undone branch), file counts, line diffs, and undo/redo hints.
- `<n>` or `jump <n>`: Moves the working tree to snapshot `#<n>` without touching `HEAD`, branches, or the staging area. Unsaved manual edits are automatically preserved in their own snapshot before jumping.
- `undo`: Jumps back to the parent state (or the state before the last jump).
- `redo`: Jumps forward to the newest child state.
- `diff <n>`: Lists every file changed in snapshot `#<n>`.
- `keep-days <days>`: Configures how many days snapshots are kept before automatic pruning (default `7`).

Show the formatted timeline output directly to the user inside a `text` code block so alignment stays crisp.
