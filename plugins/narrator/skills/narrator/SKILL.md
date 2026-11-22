---
name: narrator
description: >-
  Toggle or control Narrator spoken turn summaries (/narrator [on | off | stop |
  again | read | voices | test [voice] | lang <code|auto> | speed <rate>]). Use
  when the user invokes /narrator.
disable-model-invocation: true
---

# Narrator (`/narrator`)

Run `scripts/narrator-cli.mjs` using `run_command`:

```bash
node "<skill_dir>/../../scripts/narrator-cli.mjs" <args>
```

## Supported Arguments

- *(no arguments)*: Toggles Narrator on or off and persists the choice across sessions.
- `on` / `off`: Explicitly enables or disables spoken summaries after each turn.
- `stop`: Immediately silences any active narration.
- `again`: Repeats the last spoken narration.
- `read`: Reads the last assistant reply in full.
- `voices`: Lists installed system voices (macOS Siri/AVFoundation, Windows OneCore/SAPI, Linux Speech Dispatcher / espeak-ng, or Android Termux TTS).
- `test [voice]`: Plays a short voice sample.
- `lang <es|en|pt|fr|de|it|auto>`: Pins a spoken language or returns to automatic language detection.
- `speed <0.5..3.0>`: Adjusts speaking rate (default `1.3`).
- `command "<shell-cmd>"`: Configures a custom TTS command that receives the text as its final argument.

Relay the output concisely to the user.
