# Use Hydrogen

Antigravity's native adaptation of **Use Haiku** from `midudev/better-claude`, paired with **Gemini 4 Hydrogen** (`gemini-4-hydrogen-high` by default): the balanced, high-efficiency model in the Gemini 4 family that matches Claude Haiku's capability level while protecting your main session model quota (`Carbon` / `Neon` / `Opus`).

```text
> _summarize the last commit
```

## Features

- **Prefix `_` per turn**: `_summarize` routes that turn to Hydrogen (`gemini-4-hydrogen-high`), verifies the answering model in `transcript.jsonl`, and appends `⚡ Answered by gemini-4-hydrogen-high (2.4s · ↓ 18 tokens)`. `__init__.py` (double underscore) and a lone `_` are ignored.
- **Configurable Hydrogen effort**: switch anytime between `low`, `medium`, `high` (default), and `xhigh`:
  ```text
  /use-hydrogen model medium
  /use-hydrogen model high
  ```
- **Direct CLI launcher (`agy-hydrogen`)**: launch a full interactive or headless Antigravity session pinned to Hydrogen:
  ```bash
  agy-hydrogen
  agy-hydrogen -p "Explain package.json scripts"
  ```

## Install

```bash
agy plugin install ./plugins/use-hydrogen
```

MIT License · Original concept by Miguel Ángel Durán (midudev).
