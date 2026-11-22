# Token Meter

Shows each turn's input (`↑`), output (`↓`), and prompt-cache (`cache`) tokens alongside the cumulative session total in the Antigravity CLI status line.

```text
↑ 1.2k  ↓ 340  cache 4.1k  ·  session ↑ 12.4k  ↓ 3.1k
```

## Commands

- `/token-meter`: Show latest turn and session token totals.
- `/token-meter history`: List token totals across recent sessions.

## Install

```bash
agy plugin install ./plugins/token-meter
```

MIT License · Original concept by Miguel Ángel Durán (midudev).
