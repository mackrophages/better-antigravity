#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getPluginConfig, setPluginConfig } from './lib/store.mjs'
import { PREVIEWABLE_MEDIA_EXTS, formatBytes, openInSystemViewer, renderImageCard } from './lib/pixels.mjs'
import { summarizeTranscript } from './lib/transcript.mjs'
import { excerptOf, languageOf, lineOf, pathsIn, renderColoredExcerpt, resolvePath } from './core/peek-engine.mjs'

let cwd = process.cwd()
const raw = process.argv.slice(2)
const args = []
for (let i = 0; i < raw.length; i++) {
  if (raw[i] === '--cwd' && raw[i + 1]) cwd = path.resolve(raw[++i])
  else args.push(raw[i])
}

function formatAge (mtimeMs) {
  const sec = Math.max(0, Math.round((Date.now() - mtimeMs) / 1000))
  if (sec < 60) return 'just now'
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.round(hr / 24)}d ago`
}

export function previewOne (rawTarget, baseCwd) {
  const line = lineOf(rawTarget)
  const cleanTarget = rawTarget.replace(/:\d+(?::\d+)?$/, '')
  const resolved = resolvePath(cleanTarget, baseCwd)
  if (!resolved) return null
  const stat = fs.statSync(resolved, { throwIfNoEntry: false })
  if (!stat) return null
  const age = formatAge(stat.mtimeMs)
  if (stat.isDirectory()) {
    const entries = fs.readdirSync(resolved).slice(0, 12)
    return [
      `📁 ${resolved}  (folder · ${entries.length}${entries.length === 12 ? '+' : ''} items · ${age})`,
      `   ${entries.join('  ') || '(empty)'}`
    ].join('\n')
  }

  const ext = path.extname(resolved).toLowerCase()
  if (PREVIEWABLE_MEDIA_EXTS.has(ext)) {
    return [
      `🖼 ${resolved}  (${age})`,
      renderImageCard(resolved, { maxCols: 40, maxRows: 12 })
    ].join('\n')
  }

  const size = formatBytes(stat.size)
  const lang = languageOf(resolved)
  if (lang && stat.size <= 1024 * 1024) {
    const content = fs.readFileSync(resolved, 'utf8')
    const ex = excerptOf(content, lang, line, 20)
    if (ex) {
      return [
        `📄 ${resolved}${line ? `:${line}` : ''}  (${ex.language} · ${ex.count} lines · ${size} · ${age})`,
        renderColoredExcerpt(ex)
      ].join('\n')
    }
  }

  return `📦 ${resolved}  (${path.extname(resolved).slice(1).toUpperCase() || 'FILE'} · ${size} · ${age})`
}

function findLatestTranscript () {
  const brainDir = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain')
  if (!fs.existsSync(brainDir)) return null
  let bestPath = null
  let bestMtime = -1
  for (const d of fs.readdirSync(brainDir)) {
    const t = path.join(brainDir, d, '.system_generated', 'logs', 'transcript.jsonl')
    const st = fs.statSync(t, { throwIfNoEntry: false })
    if (st && st.mtimeMs > bestMtime) {
      bestMtime = st.mtimeMs
      bestPath = t
    }
  }
  return bestPath
}

const [sub = 'scan', arg1 = ''] = args

if (sub === 'auto') {
  const val = arg1.toLowerCase()
  if (val !== 'on' && val !== 'off') {
    const cur = getPluginConfig('quick-peek', { autoCard: false })
    console.log(`Quick Peek auto inline card is ${cur.autoCard ? 'on' : 'off'}. Usage: /quick-peek auto <on|off>`)
    process.exit(0)
  }
  setPluginConfig('quick-peek', { autoCard: val === 'on' })
  console.log(`Quick Peek auto inline card turned ${val}.`)
  process.exit(0)
}

if (sub === 'open') {
  if (!arg1) {
    console.error('Usage: peek-cli.mjs open <path>')
    process.exit(1)
  }
  const resolved = resolvePath(arg1.replace(/:\d+(?::\d+)?$/, ''), cwd)
  if (!resolved || !fs.existsSync(resolved)) {
    console.error(`Quick Peek: path not found: ${arg1}`)
    process.exit(1)
  }
  const res = openInSystemViewer(resolved, { revealOnly: true })
  console.log(`Quick Peek: revealed ${resolved} via ${res.tool}.`)
  process.exit(0)
}

if (sub === 'scan' || !sub) {
  const latestT = findLatestTranscript()
  if (!latestT) {
    console.log('Quick Peek: no active transcript found; pass a path directly: `/quick-peek <path[:line]>`')
    process.exit(0)
  }
  const sum = summarizeTranscript(latestT)
  const candidates = pathsIn(sum.answer || '')
  const seen = new Set()
  const rendered = []
  for (const c of candidates) {
    const key = `${c.target}:${c.line || 0}`
    if (seen.has(key)) continue
    seen.add(key)
    const out = previewOne(c.raw, cwd)
    if (out) rendered.push(out)
  }
  if (rendered.length === 0) {
    console.log('Quick Peek: no existing local paths found in the latest reply. Pass one directly: `/quick-peek src/index.ts:10`')
  } else {
    console.log(rendered.join('\n\n'))
  }
  process.exit(0)
}

const single = previewOne(sub, cwd)
if (!single) {
  console.error(`Quick Peek: path not found: ${sub}`)
  process.exit(1)
}
console.log(single)
