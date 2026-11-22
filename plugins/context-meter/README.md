# Context Meter

Shows how full your session context window is right in the Antigravity CLI status line, plus a one-time inline alert (spending 0 model tokens) when crossing the danger threshold in the App, IDE, or CLI.

- **Under 50%**: dim gray (`context 18%`).
- **From 50%**: yellow (`context 58% · /compact`).
- **From 75%**: red (`context 82% · new session`).
- **Before first response**: estimates fill from the transcript (`context ~16%`) until the model reports exact token usage.

## Commands

- `/context-meter`: Show current thresholds.
- `/context-meter warn <percent>`: Set yellow threshold (default `50`).
- `/context-meter danger <percent>`: Set red threshold (default `75`).

## Install

```bash
agy plugin install ./plugins/context-meter
```

MIT License · Original concept by Miguel Ángel Durán (midudev).
