---
name: quick-peek
description: >-
  Preview file paths mentioned in Antigravity's latest reply or inspect any
  path[:line], video, PDF, image, or folder with syntax highlighting, or reveal
  it in your file manager. Use when the user invokes /quick-peek.
disable-model-invocation: true
---

# Quick Peek (`/quick-peek`)

Run `scripts/peek-cli.mjs` using `run_command`:

```bash
node "<skill_dir>/../../scripts/peek-cli.mjs" --cwd "<workspace_cwd>" <args>
```

## Supported Arguments

- *(no arguments)* or `scan`: Scans the latest assistant reply in the active conversation transcript and previews every existing path mentioned in it!
- `<path[:line]>`: Previews a specific file (20 numbered, syntax-colored lines centered around `:line` if given), image/PDF/video thumbnail, or folder listing, with file kind, size, and age.
- `open <path>`: Reveals or opens `<path>` in Finder, Explorer, `termux-open`, or `xdg-open`.
- `auto <on|off>`: Toggles automatic inline Quick Peek metadata cards under replies that mention workspace files (zero model tokens).

Display the output to the user cleanly.
