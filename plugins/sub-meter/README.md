# Sub Meter

Displays your live Antigravity model quota windows (5-hour and weekly) as a compact bar in the CLI status line, with time remaining until reset. Adapted from `midudev/better-claude` for Google Antigravity (`agy`).

```text
5h ━━━━━━──── 58% ↻ 2h 10m
```

## Features

- **Automatic Status Line Integration**: On first session start, wires `better-statusline.mjs` with `stack_with_default: true` so your built-in Antigravity status line stays intact.
- **Cross-Session Quota Cache**: Shares the latest quota reading across open terminal windows so new sessions display your current usage immediately.
- **Four Display Modes**: `rotate` (switches every 8 seconds), `both` (side-by-side separated by `|`), `session` (5-hour window), or `week` (weekly window).
- **Color Thresholds**: Accent orange under 75%, yellow from 75%, red from 90%.

## Commands

- `/sub-meter` or `/sub-meter status`: View cached quota readings and settings.
- `/sub-meter mode <rotate|both|session|week>`: Change display mode.
- `/sub-meter rotate <seconds>`: Change rotation interval.

## Install

```bash
agy plugin install ./plugins/sub-meter
```

MIT License · Original concept by Miguel Ángel Durán (midudev).
