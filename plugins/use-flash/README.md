# Use Flash

Antigravity's native adaptation of **Use Haiku** from `midudev/better-claude`: start a prompt with `_` and that turn routes work through Antigravity's fast `flash` tier (`flash-runner` subagent), keeping your session model untouched for everything else.

```text
> _summarize the last commit
```

- `_summarize` triggers Flash; `__init__.py` (double underscore) and a bare `_` are left alone.
- You can also run a full interactive or headless session directly on `flash-runner`:
  ```bash
  agy --agent flash-runner
  ```

## Install

```bash
agy plugin install ./plugins/use-flash
```

MIT License · Original concept by Miguel Ángel Durán (midudev).
