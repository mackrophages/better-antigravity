---
name: before
description: >-
  Queue a task at the front of the After prompt queue (/before <task> or
  /before #2 <task>) so it runs next when the current turn finishes.
disable-model-invocation: true
---

# Before (`/before`)

Run `scripts/after-cli.mjs` in a single command to insert at the front of the workspace prompt queue:

```bash
node "<skill_dir>/../../scripts/after-cli.mjs" --cwd "<workspace_cwd>" before <raw_args>
```

Show the returned `╭─ After ───╮` card inside a `text` code block and **stop immediately**: the `Stop` hook will dispatch the queued task automatically as soon as this turn ends.
