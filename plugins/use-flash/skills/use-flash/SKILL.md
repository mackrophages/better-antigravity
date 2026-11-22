---
name: use-flash
description: >-
  Run a quick prompt on Antigravity's fast Flash model tier via flash-runner
  (adapted from Use Haiku). Triggered via /use-flash or by starting a prompt
  with _.
---

# Use Flash (`_` / `/use-flash`)

Delegate this task immediately to the bundled `flash-runner` subagent (`TypeName: "flash-runner"`, `Model: "flash"`) using `invoke_subagent`, or if it is a single-sentence answer already in context, answer directly in 1-3 lines.

Once `flash-runner` replies, relay its answer cleanly and append `_⚡ Answered via Flash_` at the end in interactive sessions.
