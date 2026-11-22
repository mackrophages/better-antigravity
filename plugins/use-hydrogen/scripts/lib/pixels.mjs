// Linear-light 8x8 subpixel Unicode block renderer + BMP/PIL/librsvg/pdftoppm/ffmpeg decoder
// (adapted from midudev/better-claude image-preview/hooks/pixels.ts for 24-bit ANSI terminals).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const UPPER_HALF = 0x2580 // ▀
const LEFT_HALF = 0x258c // ▌
const DEFAULT_COLOR = 0x01000000

function channelOf (mask) {
  if (mask === 0) return null
  let shift = 0
  while (((mask >>> shift) & 1) === 0) shift++
  let bits = 0
  while (((mask >>> (shift + bits)) & 1) === 1) bits++
  return { shift, max: 2 ** bits - 1 }
}

export function parseBmp (bytes) {
  if (bytes.length < 54 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) throw new Error('not a BMP file')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const offset = view.getUint32(10, true)
  const headerSize = view.getUint32(14, true)
  const width = view.getInt32(18, true)
  const signedHeight = view.getInt32(22, true)
  const bits = view.getUint16(28, true)
  const compression = view.getUint32(30, true)
  const height = Math.abs(signedHeight)
  if (width <= 0 || height === 0) throw new Error('empty BMP')
  if (bits !== 24 && bits !== 32) throw new Error(`${bits}-bit BMP unsupported`)
  if (compression !== 0 && compression !== 3) throw new Error('compressed BMP unsupported')

  const stride = Math.ceil((width * bits) / 32) * 4
  if (offset + stride * height > bytes.length) throw new Error('truncated BMP')
  const masks = compression === 3
    ? [54, 58, 62, 66].map(at => (at === 66 && headerSize < 56) || at + 4 > bytes.length ? 0 : view.getUint32(at, true))
    : bits === 32 ? [0xff0000, 0xff00, 0xff, 0xff000000] : null
  const channels = masks?.map(channelOf)

  const data = new Uint8Array(width * height * 4)
  let hasAlpha = false
  for (let y = 0; y < height; y++) {
    const start = offset + (signedHeight < 0 ? y : height - 1 - y) * stride
    for (let x = 0; x < width; x++) {
      const out = (y * width + x) * 4
      if (channels) {
        const value = view.getUint32(start + x * 4, true)
        for (let c = 0; c < 4; c++) {
          const ch = channels[c]
          data[out + c] = ch ? Math.round((((value >>> ch.shift) & ch.max) * 255) / ch.max) : 255
        }
        if (data[out + 3] !== 0) hasAlpha = true
      } else {
        const at = start + x * 3
        data[out] = bytes[at + 2]
        data[out + 1] = bytes[at + 1]
        data[out + 2] = bytes[at]
        data[out + 3] = 255
      }
    }
  }
  if (channels && !hasAlpha) for (let i = 3; i < data.length; i += 4) data[i] = 255
  return { width, height, data }
}

export function fit (width, height, maxColumns, maxRows) {
  const columnsCap = Math.max(1, Math.min(maxColumns, width))
  let columns = columnsCap
  let rows = Math.max(1, Math.round((columns * height) / width / 2))
  if (rows > maxRows) {
    rows = Math.max(1, maxRows)
    columns = Math.max(1, Math.min(columnsCap, Math.round((rows * 2 * width) / height)))
  }
  return { columns, rows }
}

const LINEAR = Float64Array.from({ length: 256 }, (_, i) => {
  const v = i / 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
})
const ENCODED = Uint8Array.from({ length: 4096 }, (_, i) => {
  const v = i / 4095
  return Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055))
})
const encode = (lin) => ENCODED[Math.min(4095, Math.max(0, Math.round(lin * 4095)))]

const SIDE = 8
const HALF = SIDE / 2
const POINTS = SIDE * SIDE

const shape = (glyph, covers) => {
  const inside = Uint8Array.from({ length: POINTS }, (_, i) => (covers(i % SIDE, Math.floor(i / SIDE)) ? 1 : 0))
  return { glyph, inside, count: inside.reduce((s, b) => s + b, 0) }
}

const SHAPES = [
  shape(UPPER_HALF, (_, y) => y < HALF),
  shape(LEFT_HALF, x => x < HALF),
  ...[1, 2, 3, 5, 6, 7].map(k => shape(0x2580 + k, (_, y) => y >= SIDE - k)),
  ...[1, 2, 3, 5, 6, 7].map(k => shape(0x2590 - k, x => x < k)),
  shape(0x2598, (x, y) => x < HALF && y < HALF),
  shape(0x259d, (x, y) => x >= HALF && y < HALF),
  shape(0x2596, (x, y) => x < HALF && y >= HALF),
  shape(0x2597, (x, y) => x >= HALF && y >= HALF),
  shape(0x259a, (x, y) => (x < HALF) === (y < HALF)),
  shape(0x259e, (x, y) => (x < HALF) !== (y < HALF))
]

const SCRATCH = {
  encoded: new Float64Array(POINTS * 3),
  linear: new Float64Array(POINTS * 3),
  shows: new Uint8Array(POINTS),
  shown: 0
}

function pointsOf ({ width, height, data }, columns, rows, column, row, pts) {
  const across = columns * SIDE
  const down = rows * SIDE
  const { encoded, linear, shows } = pts
  pts.shown = 0
  for (let py = 0; py < SIDE; py++) {
    const y0 = Math.floor(((row * SIDE + py) * height) / down)
    const y1 = Math.max(y0 + 1, Math.floor(((row * SIDE + py + 1) * height) / down))
    for (let px = 0; px < SIDE; px++) {
      const x0 = Math.floor(((column * SIDE + px) * width) / across)
      const x1 = Math.max(x0 + 1, Math.floor(((column * SIDE + px + 1) * width) / across))
      let r = 0; let g = 0; let b = 0; let alpha = 0
      for (let y = y0; y < y1; y++) {
        let at = (y * width + x0) * 4
        for (let x = x0; x < x1; x++) {
          const a = data[at + 3]
          r += LINEAR[data[at]] * a
          g += LINEAR[data[at + 1]] * a
          b += LINEAR[data[at + 2]] * a
          alpha += a
          at += 4
        }
      }
      const i = py * SIDE + px
      const isShown = alpha / ((y1 - y0) * (x1 - x0)) >= 128
      shows[i] = isShown ? 1 : 0
      if (!isShown) continue
      pts.shown++
      const out = i * 3
      const lr = r / alpha; const lg = g / alpha; const lb = b / alpha
      linear[out] = lr; linear[out + 1] = lg; linear[out + 2] = lb
      encoded[out] = encode(lr); encoded[out + 1] = encode(lg); encoded[out + 2] = encode(lb)
    }
  }
}

function shapeOf ({ encoded, shows, shown }) {
  let best
  if (shown < POINTS) {
    let bestMatches = -1
    for (const c of SHAPES) {
      let m = 0
      for (let i = 0; i < POINTS; i++) m += c.inside[i] === shows[i] ? 1 : 0
      if (m > bestMatches) { bestMatches = m; best = c }
    }
    return best
  }
  let t0 = 0; let t1 = 0; let t2 = 0
  for (let i = 0; i < POINTS * 3; i += 3) { t0 += encoded[i]; t1 += encoded[i + 1]; t2 += encoded[i + 2] }
  let bestScore = (t0 ** 2 + t1 ** 2 + t2 ** 2) / POINTS
  for (const c of SHAPES) {
    let s0 = 0; let s1 = 0; let s2 = 0
    const { inside, count } = c
    for (let i = 0; i < POINTS; i++) {
      if (inside[i] === 0) continue
      const at = i * 3
      s0 += encoded[at]; s1 += encoded[at + 1]; s2 += encoded[at + 2]
    }
    const out = POINTS - count
    const score = s0 ** 2 / count + (t0 - s0) ** 2 / out + s1 ** 2 / count + (t1 - s1) ** 2 / out + s2 ** 2 / count + (t2 - s2) ** 2 / out
    if (score > bestScore + 1e-6) { bestScore = score; best = c }
  }
  return best
}

function colorOf ({ linear, shows }, shp, side) {
  let s0 = 0; let s1 = 0; let s2 = 0; let count = 0
  for (let i = 0; i < POINTS; i++) {
    if (shows[i] === 0 || (shp ? shp.inside[i] : 1) !== side) continue
    const at = i * 3
    s0 += linear[at]; s1 += linear[at + 1]; s2 += linear[at + 2]
    count++
  }
  return count === 0 ? DEFAULT_COLOR : (encode(s0 / count) << 16) | (encode(s1 / count) << 8) | encode(s2 / count)
}

export function renderAnsiRows (pixels, maxCols = 44, maxRows = 16) {
  const { columns, rows } = fit(pixels.width, pixels.height, maxCols, maxRows)
  const lines = []
  for (let row = 0; row < rows; row++) {
    let line = ''
    for (let col = 0; col < columns; col++) {
      pointsOf(pixels, columns, rows, col, row, SCRATCH)
      if (SCRATCH.shown === 0) {
        line += '\x1b[0m '
        continue
      }
      const best = shapeOf(SCRATCH)
      const fg = colorOf(SCRATCH, best, 1)
      const bg = !best ? fg : SCRATCH.shown < POINTS ? DEFAULT_COLOR : colorOf(SCRATCH, best, 0)
      const ch = String.fromCodePoint(best?.glyph ?? UPPER_HALF)
      const fgSeq = fg === DEFAULT_COLOR ? '\x1b[39m' : `\x1b[38;2;${(fg >> 16) & 255};${(fg >> 8) & 255};${fg & 255}m`
      const bgSeq = bg === DEFAULT_COLOR ? '\x1b[49m' : `\x1b[48;2;${(bg >> 16) & 255};${(bg >> 8) & 255};${bg & 255}m`
      line += `${fgSeq}${bgSeq}${ch}`
    }
    lines.push(`${line}\x1b[0m`)
  }
  return { lines, columns, rows }
}

export const PREVIEWABLE_MEDIA_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tiff', '.svg',
  '.pdf', '.mp4', '.mov', '.webm', '.avi', '.mkv'
])

/**
 * Decodes PNG/JPEG/WebP/GIF/BMP/TIFF/SVG/PDF/Video into `{ width, height, format, data }`
 * using BMP parser, ffmpeg+librsvg (for SVG & video frames), pdftoppm (for PDFs), and Python3 PIL.
 */
export function decodeMediaFile (filePath, maxSide = 360) {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.bmp') {
    const bytes = new Uint8Array(fs.readFileSync(filePath))
    const px = parseBmp(bytes)
    return { ...px, format: 'BMP', origWidth: px.width, origHeight: px.height }
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-img-'))
  try {
    let sourceImg = filePath
    let kindLabel = ext.slice(1).toUpperCase() || 'IMAGE'

    if (ext === '.svg') {
      const svgPng = path.join(tmpDir, 'svg.png')
      const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', filePath, '-frames:v', '1', svgPng], { timeout: 12_000 })
      if (r.status === 0 && fs.existsSync(svgPng)) {
        sourceImg = svgPng
        kindLabel = 'SVG'
      } else {
        return null
      }
    } else if (ext === '.pdf') {
      const prefix = path.join(tmpDir, 'page')
      const r = spawnSync('pdftoppm', ['-png', '-r', '100', '-f', '1', '-l', '1', '-singlefile', filePath, prefix], { timeout: 15_000 })
      if (r.status === 0 && fs.existsSync(`${prefix}.png`)) {
        sourceImg = `${prefix}.png`
        kindLabel = 'PDF (page 1)'
      } else {
        return null
      }
    } else if (['.mp4', '.mov', '.webm', '.avi', '.mkv'].includes(ext)) {
      const frame = path.join(tmpDir, 'frame.png')
      const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', filePath, '-frames:v', '1', frame], { timeout: 15_000 })
      if (r.status === 0 && fs.existsSync(frame)) {
        sourceImg = frame
        kindLabel = `${ext.slice(1).toUpperCase()} video frame`
      } else {
        return null
      }
    }

    const outRaw = path.join(tmpDir, 'rgba.bin')
    const py = [
      'import sys, json',
      'from PIL import Image',
      'im = Image.open(sys.argv[1])',
      'orig_w, orig_h = im.size',
      'fmt = im.format or "IMG"',
      'im = im.convert("RGBA")',
      'im.thumbnail((int(sys.argv[2]), int(sys.argv[2])))',
      'w, h = im.size',
      'open(sys.argv[3], "wb").write(im.tobytes())',
      'print(json.dumps({"w": w, "h": h, "origW": orig_w, "origH": orig_h, "fmt": fmt}))'
    ].join('\n')

    const res = spawnSync('python3', ['-c', py, sourceImg, String(maxSide), outRaw], { encoding: 'utf8', timeout: 10_000 })
    if (res.status === 0 && fs.existsSync(outRaw)) {
      const meta = JSON.parse(res.stdout.trim())
      const data = new Uint8Array(fs.readFileSync(outRaw))
      return {
        width: meta.w,
        height: meta.h,
        origWidth: meta.origW,
        origHeight: meta.origH,
        format: kindLabel === 'SVG' || kindLabel.includes(' ') ? kindLabel : meta.fmt,
        data
      }
    }
    return null
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

export function openInSystemViewer (filePath, { revealOnly = false } = {}) {
  const termuxOpen = '/data/data/com.termux/files/usr/bin/termux-open'
  if (fs.existsSync(termuxOpen)) {
    const r = spawnSync(termuxOpen, [filePath], { stdio: 'ignore' })
    return { opened: r.status === 0, tool: 'termux-open' }
  }
  if (os.platform() === 'darwin') {
    const args = revealOnly ? ['-R', filePath] : [filePath]
    const r = spawnSync('open', args, { stdio: 'ignore' })
    return { opened: r.status === 0, tool: 'open' }
  }
  if (os.platform() === 'win32' || process.env.WSL_DISTRO_NAME) {
    let winPath = filePath
    if (process.env.WSL_DISTRO_NAME) {
      const wp = spawnSync('wslpath', ['-w', filePath], { encoding: 'utf8' })
      if (wp.status === 0 && wp.stdout.trim()) winPath = wp.stdout.trim()
    }
    const bin = process.env.WSL_DISTRO_NAME ? 'explorer.exe' : 'explorer'
    const args = revealOnly ? [`/select,${winPath}`] : [winPath]
    spawnSync(bin, args, { stdio: 'ignore' })
    return { opened: true, tool: bin }
  }
  const target = revealOnly ? path.dirname(filePath) : filePath
  const r = spawnSync('xdg-open', [target], { stdio: 'ignore' })
  return { opened: r.status === 0, tool: 'xdg-open' }
}

export function formatBytes (bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function renderImageCard (filePath, { maxCols = 44, maxRows = 14 } = {}) {
  const stat = fs.statSync(filePath)
  const decoded = decodeMediaFile(filePath)
  const name = path.basename(filePath)
  const sizeStr = formatBytes(stat.size)

  if (!decoded) {
    return [
      `╭─ ${name} (${sizeStr}) ─╮`,
      `│ Preview decoder unavailable for ${path.extname(filePath) || 'file'} │`,
      `│ Path: ${filePath} │`,
      `╰${'─'.repeat(Math.max(30, name.length + sizeStr.length + 7))}╯`
    ].join('\n')
  }

  const { lines, columns } = renderAnsiRows(decoded, maxCols, maxRows)
  const footer = `${name} · ${decoded.format} · ${decoded.origWidth}x${decoded.origHeight} · ${sizeStr}`
  const inner = Math.max(columns, footer.length)
  const out = [`╭${'─'.repeat(inner + 2)}╮`]
  for (const row of lines) {
    const pad = ' '.repeat(Math.max(0, inner - columns))
    out.push(`│ ${row}${pad} │`)
  }
  out.push(`│ ${footer.padEnd(inner)} │`)
  out.push(`╰${'─'.repeat(inner + 2)}╯`)
  return out.join('\n')
}
