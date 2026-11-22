---
name: sub-meter
description: >-
  Inspect or configure the Sub Meter quota bar in the Antigravity CLI status
  line (display modes: rotate, both, session, week). Use when the user invokes
  /sub-meter or asks to configure quota bar display.
---

# Sub Meter (`/sub-meter`)

Run `scripts/sub-meter-cli.mjs` from this plugin (`../..` relative to this skill directory) using `run_command`:

```bash
node "<skill_dir>/../../scripts/sub-meter-cli.mjs" <args>
```

## Supported Arguments

- `status` (default when no argument is provided): Shows cached model quota windows, usage percentages, reset countdowns, and active display settings.
- `mode <rotate|both|session|week>`: Sets how quota windows are shown on the status line (`rotate` switches every N seconds, `both` shows windows side by side, `session` shows short/5h windows, `week` shows weekly windows).
- `rotate <seconds>`: Sets rotation interval in seconds (default `8`).
- `setup`: Ensures `~/.gemini/antigravity-cli/better-statusline.mjs` is installed and active in `settings.json`.

Report the script output concisely to the user.
