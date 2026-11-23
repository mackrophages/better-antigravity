---
name: sub-meter
description: >-
  Inspect or configure the Sub Meter quota bar in the Antigravity CLI status
  line (display modes: rotate, both, session, week; family icons: ✦ Google
  Gemini blue, ✻ Claude amber, ❂ GPT gray). Use when the user invokes
  /sub-meter or asks to configure quota bar display.
---

# Sub Meter (`/sub-meter`)

Run `scripts/sub-meter-cli.mjs` from this plugin (`../..` relative to this skill directory) using `run_command`:

```bash
node "<skill_dir>/../../scripts/sub-meter-cli.mjs" <args>
```

## Supported Arguments

- `status` (default when no argument is provided): Shows cached model quota windows (`✦` Google Gemini and `✻`/`❂` Third-Party Claude/GPT), usage percentages, reset countdowns, and active display settings.
- `mode <rotate|both|session|week>`: Sets how quota windows are shown on the status line (`rotate` cycles every N seconds across all 4 windows, `both` shows all windows side by side, `session` shows 5h windows, `week` shows weekly windows).
- `rotate <seconds>`: Sets rotation interval in seconds (`1..120`, default `4`).
- `theme <auto|claude|gpt>`: Sets how `3p-*` (Third-Party) buckets are styled (`auto` uses `✻` in Claude amber by default and switches to `❂` in silver/gray tones when an active GPT model is selected).
- `setup`: Ensures the `better-statusline` engine is installed and active in `settings.json`.

Report the script output concisely to the user.
