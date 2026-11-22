# Quick Peek

Previews file paths mentioned in Antigravity's replies (or any `<path[:line]>` you pass): syntax-highlighted code around `:line`, folder listings, file size and age, clickable `file://` links, and instant reveal in Finder, Explorer, `termux-open`, or `xdg-open`.

```text
> /quick-peek scripts/better-statusline.mjs:42
📄 /root/better-antigravity/scripts/better-statusline.mjs:42  (JavaScript · 384 lines · 11.8 KB · 2m ago)
   39 │ function readJson (filePath, fallback = null) {
   40 │   try { return JSON.parse(fs.readFileSync(filePath, 'utf8')) } catch { return fallback }
   41 │ }
▶  42 │
```

## Commands

- `/quick-peek`: Scans Antigravity's latest reply and previews every existing path mentioned in it.
- `/quick-peek <path[:line]>`: Previews 20 syntax-colored lines (highlighting `:line` when given) or folder entries.
- `/quick-peek open <path>`: Reveals the file in your system file manager.
- `/quick-peek auto <on|off>`: Toggles automatic zero-token `Quick Peek` clickable summary cards after replies.

## Install

```bash
agy plugin install ./plugins/quick-peek
```

MIT License · Original path resolver and grammar highlighter by Miguel Ángel Durán (midudev).
