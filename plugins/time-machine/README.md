# Time Machine

Every turn that modifies files becomes a git snapshot off your history, Bash commands included, using a dedicated per-session git index so your staging area, `HEAD`, and branches are never touched.

```text
> /timeline

⏪ Time Machine                                           3 states

  ◉  #3  add rate limiting to the API   (2m)
  │  ~ api/routes.ts +24 −4   + api/limit.ts +48
  ●  #2  add migration for users table   (7m)
  │  + migrations/0007_users.sql +32   ~ db/schema.ts +12 −3
  ●  #1  start of the session   (14m)
  │  no files
  ──────────────────────────────────────────────────────────────────
  current #3   jumped from -
```

## How It Works in Antigravity

- **`PreToolUse` Hook**: Before the first mutating tool call (`write_file`, `edit_file`, `run_command` with write effects, or mutating MCP tools), Time Machine captures the pre-turn tree in `.git/time-machine-<session>.index`.
- **`Stop` Hook**: At turn completion, if the working tree changed, Time Machine creates an unreferenced commit under `refs/time-machine/<session>/<id>`.
- **`PreInvocation` Hook**: After a `/timeline` jump, notifies Antigravity once on your next prompt which files moved so the agent reads fresh state.
- **Unsaved Edits Protected**: Manual edits made outside Antigravity are automatically snapshotted as `your changes, kept before a jump` before any jump.

## Commands

- `/timeline`: Browse all snapshots in the current repository.
- `/timeline <id>`: Jump the working tree to snapshot `#<id>`.
- `/timeline undo` / `/timeline redo`: Step backward or forward across states.
- `/timeline diff <id>`: Inspect every file modified in snapshot `#<id>`.
- `/timeline keep-days <days>`: Configure snapshot retention (default `7` days).

## Install

```bash
agy plugin install ./plugins/time-machine
```

MIT License · Original git engine by DiegoMarty & Miguel Ángel Durán (midudev).
