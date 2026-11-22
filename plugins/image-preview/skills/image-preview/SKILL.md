---
name: image-preview
description: >-
  Preview images (PNG, JPEG, WebP, GIF, BMP, SVG), PDF first pages, or video
  frames as 24-bit truecolor terminal cards or open them in the system viewer.
  Use when the user invokes /image-preview.
disable-model-invocation: true
---

# Image Preview (`/image-preview`)

Run `scripts/image-preview-cli.mjs` using `run_command`:

```bash
node "<skill_dir>/../../scripts/image-preview-cli.mjs" --cwd "<workspace_cwd>" <args>
```

## Supported Arguments

- `<path>`: Decodes the image (or PDF first page / video frame) and prints a 24-bit truecolor Unicode 8x8 linear-light subpixel preview card with dimensions, format, and size.
- `recent` *(or no arguments)*: Finds and previews the most recent image(s) in the current workspace or conversation artifacts directory.
- `open <path>`: Opens the image in the system viewer (`termux-open` on Android, `Preview` on macOS, `explorer` on Windows/WSL, `xdg-open` on Linux).

Report the metadata and preview result to the user.
