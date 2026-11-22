---
name: think-hard
description: >-
  Execute a single turn with maximum analytical depth, first-principles
  verification, and edge-case analysis. Triggered via /think-hard or by starting
  any prompt with +.
---

# Think Hard (`+` / `/think-hard`)

Apply maximum reasoning depth for this turn only:

1. **First-Principles Decomposition**: Explicitly verify every assumption against the codebase or runtime before proposing edits.
2. **Adversarial Edge-Case Check**: Test boundary inputs, concurrency hazards, error recovery, and backward compatibility.
3. **Compare Options**: Weigh at least two concrete approaches when non-trivial trade-offs exist, then execute the strongest one cleanly.
4. **Tip**: For permanent session-level effort adjustment in the CLI, the user can also run `/effort max`, or `/boost` for multi-agent deep reasoning.
