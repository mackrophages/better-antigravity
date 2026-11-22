---
name: token-meter
description: >-
  Display turn-by-turn and cumulative session token usage (input, output, and
  prompt cache). Use when the user invokes /token-meter.
---

# Token Meter (`/token-meter`)

Run `scripts/token-meter-cli.mjs` using `run_command`:

```bash
node "<skill_dir>/../../scripts/token-meter-cli.mjs" <args>
```

## Supported Arguments

- `status` (default): Displays the latest turn and cumulative session tokens.
- `history`: Lists recent sessions and their token totals.
- `setup`: Ensures the CLI `statusLine` is active.
