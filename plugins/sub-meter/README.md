# Sub Meter

Displays your live Antigravity model quota windows (Google Gemini and Third-Party Claude/GPT, both 5-hour and weekly) as a compact bar in the CLI status line with distinct icons and colors. Adapted from `midudev/better-claude` for Google Antigravity (`agy`).

```text
✦ 5h ━───────── 10% ↻ 3h 51m   |   ✻ 5h ────────── 0% ↻ 4h 56m
```

## Animated Family Spinners & Color Identity

While the agent is active, each quota family breathes through a smooth 10-frame ping-pong animation (and rests on its signature emblem when `idle`):

- **Google Gemini (`gemini-5h`, `gemini-weekly`)**: `· ✧ ✦ ◇ ◈ ❖` (rests on `✦`) in electric blue (`38;5;75m`).
- **Third-Party / Claude (`3p-5h`, `3p-weekly`, default)**: `· ✢ ✳ ✶ ✻ ✽` (Claude Code's classic asterisk spinner, resting on `✻`) in warm amber (`38;5;208m`).
- **Third-Party / GPT (`auto` when using a GPT model, or `/sub-meter theme gpt`)**: `· ∘ ○ ◎ ◉ ❂` (rests on `❂`) in silver/slate-gray monochrome tones (`38;5;252m` / `38;5;247m`).
- **Alert Thresholds**: Yellow from 75%, red from 90%.

## Commands

- `/sub-meter` or `/sub-meter status`: View cached quota readings and settings.
- `/sub-meter mode <rotate|both|session|week>`: Change display mode (`rotate` cycles all 4 windows every 4 seconds by default).
- `/sub-meter rotate <seconds>`: Change rotation interval (`1..120`, default `4`).
- `/sub-meter theme <auto|claude|gpt>`: Choose `3p-*` icon/color theme (`auto` defaults to Claude amber and switches to gray tones when a GPT model is active).

## Install

```bash
agy plugin install ./plugins/sub-meter
```

MIT License · Original concept by Miguel Ángel Durán (midudev).
