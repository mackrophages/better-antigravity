# Context Meter

Shows how full your session context window is right in the Antigravity CLI status line, identifying each model family and its real context window capacity (`✦ 1M` Gemini, `✻ 200k` Claude, `❂ 128k` GPT), plus a one-time inline alert (spending 0 model tokens) when crossing the danger threshold.

- **Under 50%**: dim gray (`✦ context 18%/1M` or `❂ context 34%/128k`).
- **From 50%**: yellow (`✦ context 58%/1M · /compact`).
- **From 75%**: red (`✻ context 82%/200k · new session`).
- **Before first response**: estimates fill against the active model's cached or inferred window (`✦ context ~16%/1M`) until exact token usage is reported.

## Commands

- `/context-meter`: Show active thresholds and detected per-model context windows.
- `/context-meter warn <percent>`: Set yellow threshold (default `50`).
- `/context-meter danger <percent>`: Set red threshold (default `75`).
- `/context-meter window <auto|tokens>`: Use automatic per-model window detection (default) or set a manual override.

## Install

```bash
agy plugin install ./plugins/context-meter
```

MIT License · Original concept by Miguel Ángel Durán (midudev).
