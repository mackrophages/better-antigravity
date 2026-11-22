---
name: use-hydrogen
description: >-
  Run a turn on Gemini 4 Hydrogen (Antigravity's balanced analog to Use Haiku)
  or inspect/configure the Hydrogen effort variant (low, medium, high, xhigh).
  Triggered via /use-hydrogen or by starting any prompt with _.
---

# Use Hydrogen (`_` / `/use-hydrogen`)

Use `scripts/use-hydrogen-cli.mjs` via `run_command` to execute a prompt directly on **Gemini 4 Hydrogen** or configure its effort tier:

```bash
# Run a prompt on the configured Hydrogen model (default: gemini-4-hydrogen-high)
node "<skill_dir>/../../scripts/use-hydrogen-cli.mjs" run "<prompt>"

# Inspect or switch the Hydrogen variant (low, medium, high, xhigh)
node "<skill_dir>/../../scripts/use-hydrogen-cli.mjs" status
node "<skill_dir>/../../scripts/use-hydrogen-cli.mjs" model high
```

## Rules

- When the user invokes `/use-hydrogen <task>` (where `<task>` is not `status`, `setup`, or `model ...`), run `use-hydrogen-cli.mjs run "<task>"` via `run_command` and relay its output verbatim (including the `⚡ Answered by gemini-4-hydrogen-...` verification line in interactive sessions).
- When the user invokes `/use-hydrogen`, `/use-hydrogen status`, or `/use-hydrogen model [low|medium|high|xhigh]`, run the matching subcommand and report the active Hydrogen model.
