#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { openInSystemViewer, renderImageCard } from './lib/pixels.mjs'

let cwd = process.cwd()
const raw = process.argv.slice(2)
const args = []
for (let i = 0; i < raw.length; i++) {
  if (raw[i] === '--cwd' && raw[i + 1]) cwd = path.resolve(raw[++i])
  else args.push(raw[i])
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tiff', '.svg'])

function findRecentImages (dir, maxDepth = 3) {
  const found = []
  function walk (cur, depth) {
    if (depth > maxDepth) return
    let entries = []
    try { entries = fs.readdirSync(cur, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const full = path.join(cur, e.name)
      if (e.isDirectory()) walk(full, depth + 1)
      else if (IMAGE_EXTS.has(path.extname(e.name).toLowerCase())) {
        try { found.push({ path: full, mtime: fs.statSync(full).mtimeMs }) } catch {}
      }
    }
  }
  walk(dir, 0)
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, 3)
}

const [sub = 'recent', targetArg = ''] = args

if (sub === 'open') {
  if (!targetArg) {
    console.error('Usage: image-preview-cli.mjs open <path>')
    process.exit(1)
  }
  const resolved = path.resolve(cwd, targetArg)
  if (!fs.existsSync(resolved)) {
    console.error(`File not found: ${resolved}`)
    process.exit(1)
  }
  const res = openInSystemViewer(resolved)
  console.log(res.opened ? `Opened ${resolved} via ${res.tool}.` : `Could not launch viewer (${res.tool}) for ${resolved}.`)
  process.exit(0)
}

if (sub === 'recent' || !sub) {
  const recents = findRecentImages(cwd)
  if (recents.length === 0) {
    console.log(`Image Preview: no images found under ${cwd}. Pass a path: /image-preview <path>`)
    process.exit(0)
  }
  for (const item of recents) {
    console.log(renderImageCard(item.path))
  }
  process.exit(0)
}

const filePath = path.resolve(cwd, sub)
if (!fs.existsSync(filePath)) {
  console.error(`Image Preview: file not found: ${filePath}`)
  process.exit(1)
}
console.log(renderImageCard(filePath))
