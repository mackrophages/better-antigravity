---
name: context-meter
description: >-
  Check context window thresholds or configure warnAt and dangerAt percentages
  for Context Meter. Use when the user invokes /context-meter.
---

# Context Meter (`/context-meter`)

Run `scripts/context-meter-cli.mjs` using `run_command`:

```bash
node "<skill_dir>/../../scripts/context-meter-cli.mjs" <args>
```

## Supported Arguments

- `status` (default): Shows active `warnAt` (default 50%) and `dangerAt` (default 75%) thresholds.
- `warn <percent>`: Sets the yellow `/compact` threshold (for example, `50`).
- `danger <percent>`: Sets the red new-session threshold (for example, `75`).
- `setup`: Ensures the CLI `statusLine` is active.

Also remind the user they can run `/context` in the Antigravity CLI for the full category grid or `/compact` to compress older turns.
