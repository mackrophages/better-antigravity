# Quick Peek

Previews file paths mentioned in Antigravity's replies (or any `<path[:line]>` you pass): syntax-highlighted code around `:line`, folder listings, file size and age, clickable `file://` links, and instant reveal in Finder, Explorer, `termux-open`, or `xdg-open`.

```text
> /quick-peek scripts/better-statusline.mjs:44
📄 /root/better-antigravity/scripts/better-statusline.mjs:44  (JavaScript · 395 lines · 14.9 KB · 2m ago)
  41 │   try { return JSON.parse(fs.readFileSync(filePath, 'utf8')) } catch { return fallback }
  42 │ }
  43 │
▶ 44 │ function writeJsonAtomic (filePath, data) {
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
