---
name: after
description: >-
  Manage the After non-steering task queue (/after <task>, list, rm, mv, edit,
  pause, resume, undo, clear, help). Tasks run automatically via the Stop hook
  when the current turn finishes.
disable-model-invocation: true
---

# After (`/after`)

Run `scripts/after-cli.mjs` in a single command to update or view the workspace prompt queue:

```bash
node "<skill_dir>/../../scripts/after-cli.mjs" --cwd "<workspace_cwd>" after <raw_args>
```

*(Pass the user's arguments after `/after` verbatim as `<raw_args>`; if they invoked bare `/after`, pass `list`.)*

Show the returned `╭─ After ───╮` card inside a `text` code block and **stop immediately without executing the queued tasks yourself**: the `Stop` hook automatically dispatches queued tasks in FIFO order when the turn ends (unless paused).
