# Image Preview

Renders crisp 24-bit truecolor Unicode subpixel previews (`▀ ▂ ▎ ▚ …`, sampled in linear light at 8x8 points per terminal cell) of images, PDF first pages, and video frames directly in the terminal, or opens them in your native OS viewer (`termux-open` on Android, `Preview` on macOS, `explorer` on Windows/WSL, `xdg-open` on Linux).

```text
╭──────────────────────────────────────────────╮
│ ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀ │
│ ▃▁▁▘▘▁▃▀▀▖▗▀▖▗▀▏▊▎▗▘▃▗▀▖▀▂▁▉▚▉▘▏▗▀▖▗▀▖▀▀▀▀▀ │
│ screenshot.png · PNG · 1280x720 · 151.0 KB   │
╰──────────────────────────────────────────────╯
```

Works out-of-the-box on Linux/Termux proot ARM64 via Python Pillow (`PIL`), `pdftoppm`, `ffmpeg`, and a pure-JS uncompressed BMP decoder (no `sips` or ImageMagick required).

## Commands

- `/image-preview <path>`: Render a truecolor preview card of any image, PDF, or video.
- `/image-preview recent`: Find and preview the latest images in your workspace.
- `/image-preview open <path>`: Open the image in your system viewer.

## Install

```bash
agy plugin install ./plugins/image-preview
```

MIT License · Original linear-light subpixel algorithm by Miguel Ángel Durán (midudev).
