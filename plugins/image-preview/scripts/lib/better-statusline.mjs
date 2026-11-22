#!/usr/bin/env node
// Unified composable statusLine engine for Better Antigravity.
// Renders active HUD widgets (Context Meter, Token Meter, Sub Meter, Time Machine,
// After Queue, Think Hard / Use Hydrogen turn badges, and Narrator switch) from Antigravity's
// live JSON statusLine payload, dynamically fitting terminal_width.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const R = '\x1b[0m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[91m'
const BLUE = '\x1b[94m'
const CYAN = '\x1b[36m'
const MAGENTA = '\x1b[95m'
const AGY_BLUE = '\x1b[38;5;75m'
const AGY_SKY = '\x1b[38;5;39m'
const SEP = `${DIM} · ${R}`

function homeDir () {
  return process.env.BETTER_AGY_TEST_HOME || os.homedir()
}

function stateRoot () {
  return process.env.BETTER_AGY_HOME || path.join(homeDir(), '.gemini', 'antigravity-cli', 'better-antigravity')
}

function pluginsRoot () {
  return process.env.BETTER_AGY_PLUGINS_DIR || path.join(homeDir(), '.gemini', 'config', 'plugins')
}

function agyConfigJsonPath () {
  return process.env.BETTER_AGY_CONFIG_JSON || path.join(homeDir(), '.gemini', 'config', 'config.json')
}

function readJson (filePath, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')) } catch { return fallback }
}

function writeJsonAtomic (filePath, data) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const tmp = `${filePath}.tmp-${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
    fs.renameSync(tmp, filePath)
  } catch {}
}

function isEnabled (name, globalCfg) {
  const dir = path.join(pluginsRoot(), name)
  const exists = fs.existsSync(path.join(dir, 'plugin.json')) ||
    fs.existsSync(path.join(dir, '.antigravity-plugin', 'plugin.json'))
  if (!exists) return false
  if (globalCfg?.plugins?.[name]?.enabled === false) return false
  return true
}

function visibleWidth (str) {
  return [...String(str ?? '').replace(/\x1b\[[0-9;]*m/g, '').replace(/[\uFE0E\uFE0F]/g, '')].length
}

const UNITS = ['k', 'M', 'B']
function shortTokens (n) {
  const val = typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0
  if (val < 1000) return `${val}`
  let unit = 0
  let tenths = Math.round(val / 100)
  while (tenths >= 10_000 && unit < UNITS.length - 1) {
    tenths = Math.round(val / (100 * 1000 ** ++unit))
  }
  return `${Math.floor(tenths / 10)}.${tenths % 10}${UNITS[unit]}`
}

function formatUntil (sec) {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec <= 0) return ''
  const minutes = Math.max(1, Math.round(sec / 60))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

function bucketLabel (id, resetSec) {
  const low = String(id).toLowerCase()
  if (low.includes('5h') || low.includes('five_hour') || low.includes('session') || (resetSec && resetSec <= 21600)) {
    return low.includes('claude') ? 'claude 5h' : '5h'
  }
  if (low.includes('week') || low.includes('seven_day')) {
    return low.includes('claude') ? 'claude wk' : 'week'
  }
  return id.replace(/^(gemini|antigravity)-/i, '').slice(0, 10)
}

function parseQuotas (quotaObj, nowMs) {
  if (!quotaObj || typeof quotaObj !== 'object') return []
  const list = []
  for (const [id, entry] of Object.entries(quotaObj)) {
    if (!entry || typeof entry !== 'object' || entry.disabled) continue
    let pctUsed = null
    if (typeof entry.remaining_fraction === 'number') {
      pctUsed = Math.max(0, Math.min(100, (1 - entry.remaining_fraction) * 100))
    } else if (typeof entry.used_percentage === 'number') {
      pctUsed = Math.max(0, Math.min(100, entry.used_percentage))
    }
    if (pctUsed === null) continue
    let resetSec = typeof entry.reset_in_seconds === 'number' ? entry.reset_in_seconds : null
    const resetsAt = entry.reset_time || (resetSec !== null ? new Date(nowMs + resetSec * 1000).toISOString() : null)
    if (resetSec === null && resetsAt) {
      const diff = Date.parse(resetsAt) - nowMs
      if (Number.isFinite(diff)) resetSec = Math.max(0, Math.round(diff / 1000))
    }
    list.push({
      id,
      label: bucketLabel(id, resetSec),
      percentUsed: pctUsed,
      resetsAt,
      resetSec
    })
  }
  return list
}

function renderContextMeter (payload, pluginCfg) {
  const warnAt = typeof pluginCfg.warnAt === 'number' ? pluginCfg.warnAt : 50
  const dangerAt = typeof pluginCfg.dangerAt === 'number' ? pluginCfg.dangerAt : 75
  const cw = payload?.context_window
  let pct = typeof cw?.used_percentage === 'number' && (cw?.current_usage !== null || cw.used_percentage > 0)
    ? cw.used_percentage
    : null
  let isEstimate = false

  if (pct === null && payload?.transcript_path) {
    try {
      const stat = fs.statSync(payload.transcript_path)
      const windowSize = cw?.context_window_size > 0 ? cw.context_window_size : 200_000
      const estTokens = Math.round(stat.size / 4)
      pct = Math.min(99, (estTokens / windowSize) * 100)
      isEstimate = true
    } catch {}
  }
  if (pct === null) return null

  const rounded = Math.round(pct)
  const prefix = isEstimate ? '~' : ''
  const color = pct >= dangerAt ? `${RED}${BOLD}` : pct >= warnAt ? YELLOW : DIM
  const fullHint = pct >= dangerAt ? ' · new session' : pct >= warnAt ? ' · /compact' : ''
  return {
    full: `${color}context ${prefix}${rounded}%${fullHint}${R}`,
    compact: `${color}ctx ${prefix}${rounded}%${R}`,
    minimal: `${color}${prefix}${rounded}%${R}`
  }
}

function renderTokenMeter (payload, rootDir) {
  const cw = payload?.context_window
  const usage = cw?.current_usage
  const sid = payload?.conversation_id || payload?.session_id || ''
  let lastIn = null
  let lastOut = null
  let lastCache = 0

  if (usage && typeof usage === 'object') {
    lastIn = Number(usage.input_tokens) || 0
    lastOut = Number(usage.output_tokens) || 0
    lastCache = (Number(usage.cache_read_input_tokens) || 0) + (Number(usage.cache_creation_input_tokens) || 0)
  } else if (sid) {
    const saved = readJson(path.join(rootDir, 'tokens', `${sid}.json`), null)
    if (saved?.last) {
      lastIn = saved.last.input || 0
      lastOut = saved.last.output || 0
      lastCache = saved.last.cached || 0
    }
  }
  if (lastIn === null) return null

  const totIn = Number(cw?.total_input_tokens) || lastIn
  const totOut = Number(cw?.total_output_tokens) || lastOut
  const turnPart = `${BLUE}↑${R} ${shortTokens(lastIn)}  ${GREEN}↓${R} ${shortTokens(lastOut)}` +
    (lastCache > 0 ? `  ${AGY_SKY}cache${R} ${shortTokens(lastCache)}` : '')
  const sessPart = `${DIM}  ·  session ↑ ${shortTokens(totIn)}  ↓ ${shortTokens(totOut)}${R}`
  return {
    full: turnPart + sessPart,
    compact: turnPart,
    minimal: `${BLUE}↑${R}${shortTokens(lastIn)} ${GREEN}↓${R}${shortTokens(lastOut)}`
  }
}

function renderSubMeter (payload, pluginCfg, rootDir, nowMs) {
  const cachePath = path.join(rootDir, 'quota-cache.json')
  let buckets = parseQuotas(payload?.quota, nowMs)
  if (buckets.length > 0) {
    writeJsonAtomic(cachePath, { at: nowMs, buckets })
  } else {
    const cached = readJson(cachePath, null)
    if (Array.isArray(cached?.buckets) && cached.buckets.length > 0) {
      buckets = cached.buckets.map((b) => {
        const rem = b.resetsAt ? Math.max(0, Math.round((Date.parse(b.resetsAt) - nowMs) / 1000)) : b.resetSec
        const expired = b.resetsAt && Date.parse(b.resetsAt) <= nowMs
        return { ...b, percentUsed: expired ? 0 : b.percentUsed, resetSec: expired ? 0 : rem }
      })
    }
  }
  if (buckets.length === 0) return null

  const display = ['rotate', 'both', 'session', 'week'].includes(pluginCfg.display) ? pluginCfg.display : 'rotate'
  const rotateSec = Number(pluginCfg.rotateSeconds) > 0 ? Number(pluginCfg.rotateSeconds) : 8

  let chosen = buckets
  if (buckets.length >= 2) {
    if (display === 'rotate') {
      const idx = Math.floor(nowMs / (rotateSec * 1000)) % buckets.length
      chosen = [buckets[idx]]
    } else if (display === 'session') {
      const short = buckets.filter(b => b.label.includes('5h') || (b.resetSec && b.resetSec <= 21600))
      if (short.length > 0) chosen = [short[0]]
    } else if (display === 'week') {
      const wk = buckets.filter(b => b.label.includes('week') || b.label.includes('wk'))
      if (wk.length > 0) chosen = [wk[0]]
    }
  }

  const fmtWindow = (w, withBar, withReset) => {
    const pct = Math.round(w.percentUsed)
    const filled = Math.round((Math.min(Math.max(w.percentUsed, 0), 100) / 100) * 10)
    const barColor = pct >= 90 ? RED : pct >= 75 ? YELLOW : AGY_BLUE
    const bar = withBar ? ` ${barColor}${'━'.repeat(filled)}${R}${DIM}${'─'.repeat(10 - filled)}${R}` : ''
    const rstStr = withReset && w.resetSec > 0 ? `${DIM} ↻ ${formatUntil(w.resetSec)}${R}` : ''
    return `${DIM}${w.label}${R}${bar} ${pct}%${rstStr}`
  }

  return {
    full: chosen.map(w => fmtWindow(w, true, true)).join(`${DIM}  |  ${R}`),
    compact: chosen.map(w => fmtWindow(w, false, true)).join(`${DIM} | ${R}`),
    minimal: chosen.map(w => fmtWindow(w, false, false)).join(`${DIM} | ${R}`)
  }
}

function renderTimeMachineBadge (payload, rootDir) {
  const cwd = payload?.workspace?.project_dir || payload?.cwd || process.cwd()
  const sid = payload?.conversation_id || payload?.session_id || ''
  if (!sid) return null
  const rKey = crypto.createHash('sha1').update(String(cwd)).digest('hex').slice(0, 12)
  const st = readJson(path.join(rootDir, 'time-machine', rKey, `${sid}.json`), null)
  if (!st || !Array.isArray(st.states) || st.states.length === 0) return null
  const maxId = st.states.reduce((m, s) => Math.max(m, s.id), 0)
  const cur = st.cursor ?? maxId
  const label = cur < maxId ? `${YELLOW}⏪ #${cur}/${maxId}${R}` : `${AGY_BLUE}⏪ #${cur}${R}`
  return { full: label, compact: label, minimal: label }
}

function renderAfterBadge (payload, rootDir) {
  const sid = payload?.conversation_id || payload?.session_id || 'default'
  const cwd = payload?.workspace?.project_dir || payload?.cwd || process.cwd()
  const rKey = crypto.createHash('sha1').update(String(cwd)).digest('hex').slice(0, 12)
  const st = readJson(path.join(rootDir, 'after', `${rKey}-${sid}.json`), null) ||
    readJson(path.join(rootDir, 'after', `${rKey}.json`), null)
  if (!st) return null
  const count = Array.isArray(st.items) ? st.items.length : 0
  if (!st.running && count === 0) return null
  if (st.paused) {
    const s = `${YELLOW}⏸ after (${count})${R}`
    return { full: s, compact: s, minimal: `${YELLOW}⏸${count}${R}` }
  }
  if (st.running) {
    const shortTask = String(st.running.text || '').slice(0, 22)
    const tail = count > 0 ? ` · +${count}` : ''
    return {
      full: `${GREEN}after ▶${R} ${shortTask}${DIM}${tail}${R}`,
      compact: `${GREEN}after ▶${tail}${R}`,
      minimal: `${GREEN}▶+${count}${R}`
    }
  }
  return {
    full: `${CYAN}after${R} (${count} queued)`,
    compact: `${CYAN}after (${count})${R}`,
    minimal: `${CYAN}+${count}${R}`
  }
}

function renderTurnModeBadges (payload, rootDir) {
  const sid = payload?.conversation_id || payload?.session_id || ''
  if (!sid || payload?.agent_state === 'idle') return null
  const flags = readJson(path.join(rootDir, 'turn-flags', `${sid}.json`), null)
  if (!flags) return null
  const parts = []
  if (flags.thinkHard) parts.push(`${MAGENTA}${BOLD}+MAX${R}`)
  if (flags.useHydrogen) parts.push(`${CYAN}${BOLD}_Hydrogen${R}`)
  if (parts.length === 0) return null
  const joined = parts.join(' ')
  return { full: joined, compact: joined, minimal: joined }
}

function renderNarratorBadge (pluginCfg, rootDir) {
  const runtime = readJson(path.join(rootDir, 'narrator-runtime.json'), {})
  const enabled = Boolean(pluginCfg.enabled)
  const langTag = pluginCfg.language ? ` · ${String(pluginCfg.language).toUpperCase()}` : ''
  let speaking = false
  if (runtime?.speakingPid) {
    try {
      process.kill(Number(runtime.speakingPid), 0)
      speaking = true
    } catch {}
  }
  if (speaking) {
    return {
      full: `${BLUE}⏹\uFE0E narrating${langTag}${R}`,
      compact: `${BLUE}⏹\uFE0E narrating${R}`,
      minimal: `${BLUE}⏹\uFE0E${R}`
    }
  }
  if (enabled) {
    return {
      full: `${GREEN}⏵ narrator on${langTag}${R}`,
      compact: `${GREEN}⏵ narrator${R}`,
      minimal: `${GREEN}⏵${R}`
    }
  }
  return {
    full: `${DIM}⏸\uFE0E narrator off${R}`,
    compact: `${DIM}⏸\uFE0E narrator${R}`,
    minimal: `${DIM}⏸\uFE0E${R}`
  }
}

export function formatStatusLine (payload, { nowMs = Date.now() } = {}) {
  const rootDir = stateRoot()
  const globalCfg = readJson(agyConfigJsonPath(), {})
  const allCfg = readJson(path.join(rootDir, 'config.json'), { plugins: {} })
  const pCfg = (name) => (allCfg?.plugins?.[name] && typeof allCfg.plugins[name] === 'object' ? allCfg.plugins[name] : {})

  const widgets = []
  if (isEnabled('context-meter', globalCfg)) {
    const w = renderContextMeter(payload, pCfg('context-meter'))
    if (w) widgets.push(w)
  }
  if (isEnabled('token-meter', globalCfg)) {
    const w = renderTokenMeter(payload, rootDir)
    if (w) widgets.push(w)
  }
  if (isEnabled('sub-meter', globalCfg)) {
    const w = renderSubMeter(payload, pCfg('sub-meter'), rootDir, nowMs)
    if (w) widgets.push(w)
  }
  if (isEnabled('time-machine', globalCfg)) {
    const w = renderTimeMachineBadge(payload, rootDir)
    if (w) widgets.push(w)
  }
  if (isEnabled('after', globalCfg)) {
    const w = renderAfterBadge(payload, rootDir)
    if (w) widgets.push(w)
  }
  if (isEnabled('think-hard', globalCfg) || isEnabled('use-hydrogen', globalCfg)) {
    const w = renderTurnModeBadges(payload, rootDir)
    if (w) widgets.push(w)
  }
  if (isEnabled('narrator', globalCfg)) {
    const w = renderNarratorBadge(pCfg('narrator'), rootDir)
    if (w) widgets.push(w)
  }

  if (widgets.length === 0) return ''

  const cols = Math.max(40, (Number(payload?.terminal_width) || 100) - 2)
  const tiers = widgets.map(() => 'full')
  const build = () => widgets.map((w, i) => w[tiers[i]]).filter(Boolean).join(SEP)
  if (visibleWidth(build()) <= cols) return build()

  // Shrink progressively one widget at a time (full -> compact -> minimal) so e.g. the 10-cell
  // quota bar stays visible at 110-120 cols when dropping only the session token tail suffices.
  for (const nextTier of ['compact', 'minimal']) {
    for (let i = 0; i < widgets.length; i++) {
      tiers[i] = nextTier
      if (visibleWidth(build()) <= cols) return build()
    }
  }
  return build()
}

// Run as CLI when invoked directly by Antigravity statusLine
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
if (isMain) {
  let raw = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => { raw += chunk })
  process.stdin.on('end', () => {
    let payload = {}
    try { payload = raw.trim() ? JSON.parse(raw) : {} } catch {}
    const out = formatStatusLine(payload)
    if (out) process.stdout.write(out + '\n')
  })
}
