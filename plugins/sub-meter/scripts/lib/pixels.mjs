// Linear-light 8x8 subpixel Unicode block renderer + zero-temp-file ffmpeg->PAM pipe decoder
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
  while (shift < 32 && ((mask >>> shift) & 1) === 0) shift++
  if (shift >= 32) return null
  let bits = 0
  while (shift + bits < 32 && ((mask >>> (shift + bits)) & 1) === 1) bits++
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
  const count = inside.reduce((s, b) => s + b, 0)
  return {
    glyph,
    ch: String.fromCodePoint(glyph),
    inside,
    count,
    invCount: 1 / count,
    invOut: 1 / (POINTS - count)
  }
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
  const baseY = row * SIDE
  const baseX = column * SIDE
  for (let py = 0; py < SIDE; py++) {
    const y0 = Math.floor(((baseY + py) * height) / down)
    const y1 = Math.max(y0 + 1, Math.floor(((baseY + py + 1) * height) / down))
    const dy = y1 - y0
    for (let px = 0; px < SIDE; px++) {
      const x0 = Math.floor(((baseX + px) * width) / across)
      const x1 = Math.max(x0 + 1, Math.floor(((baseX + px + 1) * width) / across))
      let r = 0; let g = 0; let b = 0; let alpha = 0
      for (let y = y0; y < y1; y++) {
        let at = (y * width + x0) * 4
        for (let x = x0; x < x1; x++) {
          const a = data[at + 3]
          if (a !== 0) {
            r += LINEAR[data[at]] * a
            g += LINEAR[data[at + 1]] * a
            b += LINEAR[data[at + 2]] * a
            alpha += a
          }
          at += 4
        }
      }
      const i = py * SIDE + px
      const isShown = alpha >= 128 * dy * (x1 - x0)
      shows[i] = isShown ? 1 : 0
      if (!isShown) continue
      pts.shown++
      const invAlpha = 1 / alpha
      const out = i * 3
      const lr = r * invAlpha; const lg = g * invAlpha; const lb = b * invAlpha
      linear[out] = lr; linear[out + 1] = lg; linear[out + 2] = lb
      encoded[out] = encode(lr); encoded[out + 1] = encode(lg); encoded[out + 2] = encode(lb)
    }
  }
}

function shapeOf ({ encoded, shows, shown }) {
  let best
  if (shown < POINTS) {
    let bestMatches = -1
    for (let s = 0; s < SHAPES.length; s++) {
      const c = SHAPES[s]
      const inside = c.inside
      let m = 0
      for (let i = 0; i < POINTS; i++) m += inside[i] === shows[i] ? 1 : 0
      if (m > bestMatches) { bestMatches = m; best = c }
    }
    return best
  }
  let t0 = 0; let t1 = 0; let t2 = 0
  for (let i = 0; i < POINTS * 3; i += 3) { t0 += encoded[i]; t1 += encoded[i + 1]; t2 += encoded[i + 2] }
  let bestScore = (t0 * t0 + t1 * t1 + t2 * t2) / POINTS
  for (let s = 0; s < SHAPES.length; s++) {
    const c = SHAPES[s]
    const { inside, invCount, invOut } = c
    let s0 = 0; let s1 = 0; let s2 = 0
    for (let i = 0; i < POINTS; i++) {
      if (inside[i] === 0) continue
      const at = i * 3
      s0 += encoded[at]; s1 += encoded[at + 1]; s2 += encoded[at + 2]
    }
    const d0 = t0 - s0; const d1 = t1 - s1; const d2 = t2 - s2
    const score = (s0 * s0 + s1 * s1 + s2 * s2) * invCount + (d0 * d0 + d1 * d1 + d2 * d2) * invOut
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
  if (count === 0) return DEFAULT_COLOR
  const inv = 1 / count
  return (encode(s0 * inv) << 16) | (encode(s1 * inv) << 8) | encode(s2 * inv)
}

export function renderAnsiRows (pixels, maxCols = 44, maxRows = 16) {
  const { columns, rows } = fit(pixels.width, pixels.height, maxCols, maxRows)
  const lines = []
  for (let row = 0; row < rows; row++) {
    let line = ''
    let prevFg = -1
    let prevBg = -1
    for (let col = 0; col < columns; col++) {
      pointsOf(pixels, columns, rows, col, row, SCRATCH)
      if (SCRATCH.shown === 0) {
        if (prevFg !== -1 || prevBg !== -1) {
          line += '\x1b[0m '
          prevFg = -1
          prevBg = -1
        } else {
          line += ' '
        }
        continue
      }
      const best = shapeOf(SCRATCH)
      const fg = colorOf(SCRATCH, best, 1)
      const bg = !best ? fg : SCRATCH.shown < POINTS ? DEFAULT_COLOR : colorOf(SCRATCH, best, 0)
      const ch = best ? best.ch : '▀'
      if (fg !== prevFg) {
        line += fg === DEFAULT_COLOR ? '\x1b[39m' : `\x1b[38;2;${(fg >> 16) & 255};${(fg >> 8) & 255};${fg & 255}m`
        prevFg = fg
      }
      if (bg !== prevBg) {
        line += bg === DEFAULT_COLOR ? '\x1b[49m' : `\x1b[48;2;${(bg >> 16) & 255};${(bg >> 8) & 255};${bg & 255}m`
        prevBg = bg
      }
      line += ch
    }
    lines.push(`${line}\x1b[0m`)
  }
  return { lines, columns, rows }
}

export const PREVIEWABLE_MEDIA_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tiff', '.svg',
  '.pdf', '.mp4', '.mov', '.webm', '.avi', '.mkv'
])

/** Fast pure-JS header sniffer (<0.1ms, 0 subprocesses) for original image dimensions. */
function sniffDimensions (filePath, ext) {
  let fd = -1
  try {
    fd = fs.openSync(filePath, 'r')
    const buf = Buffer.allocUnsafe(4096)
    const n = fs.readSync(fd, buf, 0, 4096, 0)
    if (n < 10) return null
    // PNG
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && n >= 24) {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), fmt: 'PNG' }
    }
    // GIF
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && n >= 10) {
      return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8), fmt: 'GIF' }
    }
    // WebP
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && n >= 25) {
      const chunk = buf.toString('ascii', 12, 16)
      if (chunk === 'VP8 ' && n >= 30) return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff, fmt: 'WEBP' }
      if (chunk === 'VP8L') {
        const b = buf.readUInt32LE(21)
        return { w: (b & 0x3fff) + 1, h: ((b >>> 14) & 0x3fff) + 1, fmt: 'WEBP' }
      }
      if (chunk === 'VP8X' && n >= 30) {
        return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3), fmt: 'WEBP' }
      }
    }
    // JPEG (seeks past large APP1/EXIF camera headers cleanly)
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      const st = fs.fstatSync(fd)
      const seg = Buffer.allocUnsafe(16)
      let pos = 2
      for (let hop = 0; hop < 128 && pos + 4 < st.size; hop++) {
        const r = fs.readSync(fd, seg, 0, Math.min(16, st.size - pos), pos)
        if (r < 2 || seg[0] !== 0xff) break
        let mOff = 1
        while (mOff < r && seg[mOff] === 0xff) mOff++
        if (mOff >= r) { pos += mOff - 1; continue }
        const marker = seg[mOff]
        if (marker === 0xd9 || marker === 0xda) break
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { pos += mOff + 1; continue }
        if (mOff + 7 < r && ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf))) {
          return { w: seg.readUInt16BE(mOff + 6), h: seg.readUInt16BE(mOff + 4), fmt: 'JPEG' }
        }
        if (mOff + 2 >= r) break
        const segLen = seg.readUInt16BE(mOff + 1)
        if (segLen < 2) break
        pos += mOff + 1 + segLen
      }
    }
    // SVG (restrict attribute lookup strictly to the root <svg ...> opening tag)
    if (ext === '.svg') {
      const head = buf.toString('utf8', 0, n)
      const svgTag = /<svg\b[^>]*>/i.exec(head)?.[0] || ''
      if (svgTag) {
        const wM = /\bwidth=["'](\d+(?:\.\d+)?)(?:px)?["']/i.exec(svgTag)
        const hM = /\bheight=["'](\d+(?:\.\d+)?)(?:px)?["']/i.exec(svgTag)
        if (wM && hM) return { w: Math.round(Number(wM[1])), h: Math.round(Number(hM[1])), fmt: 'SVG' }
        const vb = /\bviewBox=["']\s*[-\d.]+\s+[-\d.]+\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)/i.exec(svgTag)
        if (vb) return { w: Math.round(Number(vb[1])), h: Math.round(Number(vb[2])), fmt: 'SVG' }
      }
    }
  } catch {} finally {
    if (fd !== -1) {
      try { fs.closeSync(fd) } catch {}
    }
  }
  return null
}

function parsePamRgba (buf) {
  if (!buf || buf.length < 32 || buf[0] !== 0x50 || buf[1] !== 0x37) return null // "P7"
  const hdrLimit = Math.min(buf.length, 256)
  const hdrStr = buf.toString('ascii', 0, hdrLimit)
  const endIdx = hdrStr.indexOf('ENDHDR\n')
  if (endIdx === -1) return null
  const dataOffset = endIdx + 7
  const wM = /\bWIDTH\s+(\d+)/.exec(hdrStr)
  const hM = /\bHEIGHT\s+(\d+)/.exec(hdrStr)
  if (!wM || !hM) return null
  const width = Number(wM[1])
  const height = Number(hM[1])
  const expected = width * height * 4
  if (width <= 0 || height <= 0 || buf.length < dataOffset + expected) return null
  return {
    width,
    height,
    data: new Uint8Array(buf.buffer, buf.byteOffset + dataOffset, expected)
  }
}

function parsePpmRgb (buf) {
  if (!buf || buf.length < 16 || buf[0] !== 0x50 || buf[1] !== 0x36) return null // "P6"
  let i = 2
  const tokens = []
  while (i < Math.min(buf.length, 256) && tokens.length < 3) {
    while (i < buf.length && (buf[i] <= 32)) i++
    if (buf[i] === 0x23) { // '#' comment
      while (i < buf.length && buf[i] !== 10) i++
      continue
    }
    let tok = ''
    while (i < buf.length && buf[i] > 32) tok += String.fromCharCode(buf[i++])
    if (tok) tokens.push(Number(tok))
  }
  if (tokens.length < 3) return null
  i++ // single whitespace byte after maxval (255)
  const [width, height, maxval] = tokens
  if (!Number.isFinite(width) || !Number.isFinite(height) || maxval !== 255) return null
  const rgbLen = width * height * 3
  if (width <= 0 || height <= 0 || buf.length < i + rgbLen) return null
  const data = new Uint8Array(width * height * 4)
  for (let p = 0, s = i, d = 0; p < width * height; p++, s += 3, d += 4) {
    data[d] = buf[s]
    data[d + 1] = buf[s + 1]
    data[d + 2] = buf[s + 2]
    data[d + 3] = 255
  }
  return { width, height, data }
}

function decodeViaFfmpegPam (inputPath, maxSide) {
  const absPath = path.resolve(inputPath)
  const scale = `scale='min(${maxSide},iw)':'min(${maxSide},ih)':force_original_aspect_ratio=decrease`
  const r = spawnSync(
    'ffmpeg',
    ['-v', 'error', '-i', absPath, '-frames:v', '1', '-vf', scale, '-c:v', 'pam', '-pix_fmt', 'rgba', '-f', 'image2pipe', 'pipe:1'],
    { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 }
  )
  if (r.status !== 0 || !r.stdout) return null
  return parsePamRgba(r.stdout)
}

function decodeViaPilFallback (sourceImg, maxSide, kindLabel) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-img-'))
  try {
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
      return {
        width: meta.w,
        height: meta.h,
        origWidth: meta.origW,
        origHeight: meta.origH,
        format: kindLabel.includes(' ') || kindLabel === 'SVG' ? kindLabel : meta.fmt,
        data: new Uint8Array(fs.readFileSync(outRaw))
      }
    }
  } catch {} finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
  return null
}

/**
 * Decodes PNG/JPEG/WebP/GIF/BMP/TIFF/SVG/PDF/Video into `{ width, height, origWidth, origHeight, format, data }`.
 * Fast path uses a single zero-temp-file in-memory pipe (`ffmpeg -> PAM` or `pdftoppm -> PPM`),
 * falling back to Python PIL only if ffmpeg is unavailable.
 */
export function decodeMediaFile (filePath, maxSide = 360) {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.bmp') {
    const bytes = new Uint8Array(fs.readFileSync(filePath))
    const px = parseBmp(bytes)
    return { ...px, format: 'BMP', origWidth: px.width, origHeight: px.height }
  }

  if (ext === '.pdf') {
    const r = spawnSync('pdftoppm', ['-r', '72', '-f', '1', '-l', '1', '-singlefile', '--', path.resolve(filePath)], {
      timeout: 15_000,
      maxBuffer: 24 * 1024 * 1024
    })
    if (r.status === 0 && r.stdout) {
      const ppm = parsePpmRgb(r.stdout)
      if (ppm) {
        return { ...ppm, origWidth: ppm.width, origHeight: ppm.height, format: 'PDF (page 1)' }
      }
    }
    return null
  }

  const isVideo = ['.mp4', '.mov', '.webm', '.avi', '.mkv'].includes(ext)
  const kindLabel = isVideo ? `${ext.slice(1).toUpperCase()} video frame` : (ext.slice(1).toUpperCase() || 'IMAGE')
  const sniffed = !isVideo ? sniffDimensions(filePath, ext) : null

  // Single-subprocess in-memory ffmpeg -> PAM RGBA pipe (0 temp files, 0 Python startup)
  const pam = decodeViaFfmpegPam(filePath, maxSide)
  if (pam) {
    return {
      width: pam.width,
      height: pam.height,
      origWidth: sniffed?.w || pam.width,
      origHeight: sniffed?.h || pam.height,
      format: isVideo ? kindLabel : (sniffed?.fmt || kindLabel),
      data: pam.data
    }
  }

  if (!isVideo && ext !== '.svg') {
    return decodeViaPilFallback(filePath, maxSide, kindLabel)
  }
  return null
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
  const targetSampleSide = Math.max(64, Math.max(maxCols * SIDE, maxRows * 2 * SIDE))
  const decoded = decodeMediaFile(filePath, targetSampleSide)
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
