# After

A non-steering FIFO prompt queue for Google Antigravity. Queue follow-up tasks with `/after <task>` or `/before <task>` (or from a second terminal while Antigravity is busy!) and the `Stop` hook dispatches them one by one as each turn finishes.

```text
╭─ After ──────────────────────────────╮
│ ✓ Queued #2 · update the README      │
│                                      │
│   1  add unit tests for parser       │
│   2  update the README               │
│                                      │
│ /after <task> · rm <n> · pause · ... │
╰──────────────────────────────────────╯
```

## Queue From Another Terminal Mid-Turn (Zero Steering)

While Antigravity is actively working in Terminal 1, queue work from Terminal 2 without interrupting or steering the active turn:

```bash
node ~/.gemini/config/plugins/after/scripts/after-cli.mjs --cwd "$PWD" after "run linter and update docs"
```

When Terminal 1 finishes its current turn, After's `Stop` hook automatically feeds the queued task!

## Commands

- `/after <task>` / `/before <task>` / `/after #2 <task>`: Add tasks to the queue.
- `/after list`: Show queued, running, and recently finished tasks.
- `/after rm 2` · `rm 2-4` · `rm last` · `rm all`: Remove tasks.
- `/after edit 2 <text>`: Edit a queued task.
- `/after mv 3 1` · `top 3`: Reorder tasks.
- `/after pause` · `/after resume`: Hold or release queue execution.
- `/after undo` · `/after clear`: Undo the last queue operation or clear all pending tasks.
- **Natural language (EN & ES)**: `/after tests, write README`, `/after remove the tests one`, `/after quita lo del readme`.

## Install

```bash
agy plugin install ./plugins/after
```

MIT License · Original concept and queue logic by Miguel Ángel Durán (midudev).
