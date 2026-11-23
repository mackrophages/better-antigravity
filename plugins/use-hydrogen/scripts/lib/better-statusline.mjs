#!/usr/bin/env node
// Unified composable statusLine engine for Better Antigravity.
// Optimized: 1 readdirSync instead of 16 statx calls, throttled quota-cache writes (30s / delta),
// lazy single SHA-1 repoKey, and allocation-free visibleWidth calculation.

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
const CLAUDE_AMBER = '\x1b[38;5;208m'
const GPT_SILVER = '\x1b[38;5;252m'
const GPT_SLATE = '\x1b[38;5;247m'
const SEP = `${DIM} · ${R}`

const SPINNER_GOOGLE = ['·', '✧', '✦', '◇', '◈', '❖', '◈', '◇', '✦', '✧']
const SPINNER_CLAUDE = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢']
const SPINNER_GPT = ['·', '∘', '○', '◎', '◉', '❂', '◉', '◎', '○', '∘']

function pickFamilyIcon (kind, isIdle, nowMs) {
  if (isIdle) {
    return kind === 'claude' ? '✻' : (kind === 'gpt' ? '❂' : '✦')
  }
  const idx = ((Math.floor(nowMs / 300) % 10) + 10) % 10
  const seq = kind === 'claude' ? SPINNER_CLAUDE : (kind === 'gpt' ? SPINNER_GPT : SPINNER_GOOGLE)
  return seq[idx]
}

function homeDir () {
  return process.env.BETTER_AGY_TEST_HOME || os.homedir()
}

function expandTildePath (p) {
  if (!p) return ''
  if (p === '~') return homeDir()
  if (p.startsWith('~/')) return homeDir() + p.slice(1)
  return p
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
    let mode = 0o600
    try { mode = fs.statSync(filePath).mode & 0o777 } catch {}
    const tmp = `${filePath}.tmp-${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode })
    try { fs.chmodSync(tmp, mode) } catch {}
    fs.renameSync(tmp, filePath)
  } catch {}
}

function discoverInstalledPlugins () {
  const set = new Set()
  try {
    for (const d of fs.readdirSync(pluginsRoot(), { withFileTypes: true })) {
      if (d.isDirectory() || d.isSymbolicLink()) set.add(d.name)
    }
  } catch {}
  return set
}

function isEnabled (name, installedSet, globalCfg) {
  if (!installedSet.has(name)) return false
  if (globalCfg?.plugins?.[name]?.enabled === false) return false
  return true
}

function visibleWidth (str) {
  const s = String(str ?? '')
  let w = 0
  for (let i = 0; i < s.length;) {
    const code = s.charCodeAt(i)
    if (code === 0x1b && s.charCodeAt(i + 1) === 0x5b) {
      i += 2
      while (i < s.length) {
        const c = s.charCodeAt(i++)
        if ((c >= 0x40 && c <= 0x7e)) break
      }
      continue
    }
    if (code === 0xfe0e || code === 0xfe0f) {
      i++
      continue
    }
    w++
    i += code >= 0xd800 && code <= 0xdbff ? 2 : 1
  }
  return w
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
    return '5h'
  }
  if (low.includes('week') || low.includes('seven_day') || low.endsWith('wk')) {
    return 'week'
  }
  return String(id).replace(/^(gemini|antigravity|3p|claude|gpt)-/i, '').slice(0, 10)
}

function isGptModelActive (payload) {
  const m = payload?.model
  const hay = typeof m === 'string'
    ? m.toLowerCase()
    : `${m?.id || ''} ${m?.display_name || ''}`.toLowerCase()
  return hay.includes('gpt') || hay.includes('openai')
}

function resolveBucketKind (idOrLabel, payload, pluginCfg) {
  const low = String(idOrLabel || '').toLowerCase()
  if (low.includes('gpt') || low.includes('openai')) return 'gpt'
  if (low.includes('claude') || low.includes('anthropic')) return 'claude'
  if (low.startsWith('3p') || low.includes('3p-') || low.includes('third')) {
    const theme = String(pluginCfg?.thirdPartyTheme || 'auto').toLowerCase()
    if (theme === 'gpt') return 'gpt'
    if (theme === 'claude') return 'claude'
    return isGptModelActive(payload) ? 'gpt' : 'claude'
  }
  return 'google'
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
    const resetsAtMs = resetsAt ? Date.parse(resetsAt) : (resetSec !== null ? nowMs + resetSec * 1000 : null)
    list.push({
      id,
      label: bucketLabel(id, resetSec),
      percentUsed: pctUsed,
      resetsAt,
      resetsAtMs: Number.isFinite(resetsAtMs) ? resetsAtMs : null,
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
      const stat = fs.statSync(expandTildePath(String(payload.transcript_path)))
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

function shouldPersistQuotaCache (cached, buckets, nowMs) {
  if (!cached || !Array.isArray(cached.buckets) || cached.buckets.length !== buckets.length) return true
  if (nowMs - (Number(cached.at) || 0) >= 30_000) return true
  for (let i = 0; i < buckets.length; i++) {
    if (Math.round(cached.buckets[i]?.percentUsed ?? -1) !== Math.round(buckets[i].percentUsed)) return true
  }
  return false
}

function renderSubMeter (payload, pluginCfg, rootDir, nowMs) {
  const cachePath = path.join(rootDir, 'quota-cache.json')
  let buckets = parseQuotas(payload?.quota, nowMs)
  const cached = readJson(cachePath, null)
  if (buckets.length > 0) {
    if (shouldPersistQuotaCache(cached, buckets, nowMs)) {
      writeJsonAtomic(cachePath, { at: nowMs, buckets })
    }
  } else if (Array.isArray(cached?.buckets) && cached.buckets.length > 0) {
    buckets = cached.buckets.map((b) => {
      const expMs = typeof b.resetsAtMs === 'number' ? b.resetsAtMs : (b.resetsAt ? Date.parse(b.resetsAt) : null)
      const rem = expMs !== null && Number.isFinite(expMs) ? Math.max(0, Math.round((expMs - nowMs) / 1000)) : b.resetSec
      const expired = expMs !== null && Number.isFinite(expMs) && expMs <= nowMs
      const nextReset = expired ? 0 : rem
      return {
        ...b,
        label: bucketLabel(b.id || b.label, nextReset),
        percentUsed: expired ? 0 : b.percentUsed,
        resetSec: nextReset
      }
    })
  }
  if (buckets.length === 0) return null

  const display = ['rotate', 'both', 'session', 'week'].includes(pluginCfg.display) ? pluginCfg.display : 'rotate'
  const rotateSec = Number(pluginCfg.rotateSeconds) > 0 ? Number(pluginCfg.rotateSeconds) : 4

  let chosen = buckets
  if (buckets.length >= 2) {
    if (display === 'rotate') {
      const idx = Math.floor(nowMs / (rotateSec * 1000)) % buckets.length
      chosen = [buckets[idx]]
    } else if (display === 'session') {
      const short = buckets.filter(b => b.label.includes('5h') || (b.resetSec && b.resetSec <= 21600))
      if (short.length > 0) chosen = short
    } else if (display === 'week') {
      const wk = buckets.filter(b => b.label.includes('week') || b.label.includes('wk'))
      if (wk.length > 0) chosen = wk
    }
  }

  const isIdle = payload?.agent_state === 'idle'
  const fmtWindow = (w, withBar, withReset) => {
    const kind = resolveBucketKind(w.id || w.label, payload, pluginCfg)
    const icon = pickFamilyIcon(kind, isIdle, nowMs)
    const iconColor = kind === 'claude' ? CLAUDE_AMBER : (kind === 'gpt' ? GPT_SILVER : AGY_BLUE)
    const baseBarColor = kind === 'claude' ? CLAUDE_AMBER : (kind === 'gpt' ? GPT_SLATE : AGY_BLUE)
    const pct = Math.round(w.percentUsed)
    const filled = Math.round((Math.min(Math.max(w.percentUsed, 0), 100) / 100) * 10)
    const barColor = pct >= 90 ? RED : pct >= 75 ? YELLOW : baseBarColor
    const bar = withBar ? ` ${barColor}${'━'.repeat(filled)}${R}${DIM}${'─'.repeat(10 - filled)}${R}` : ''
    const rstStr = withReset && w.resetSec > 0 ? `${DIM} ↻ ${formatUntil(w.resetSec)}${R}` : ''
    return `${iconColor}${icon}${R} ${DIM}${w.label}${R}${bar} ${pct}%${rstStr}`
  }

  return {
    full: chosen.map(w => fmtWindow(w, true, true)).join(`${DIM}  |  ${R}`),
    compact: chosen.map(w => fmtWindow(w, false, true)).join(`${DIM} | ${R}`),
    minimal: chosen.map(w => fmtWindow(w, false, false)).join(`${DIM} | ${R}`)
  }
}

function renderTimeMachineBadge (payload, rootDir, rKey) {
  const sid = payload?.conversation_id || payload?.session_id || ''
  if (!sid) return null
  const st = readJson(path.join(rootDir, 'time-machine', rKey, `${sid}.json`), null)
  if (!st || !Array.isArray(st.states) || st.states.length === 0) return null
  const maxId = st.states.reduce((m, s) => Math.max(m, s.id), 0)
  const cur = st.cursor ?? maxId
  const label = cur < maxId ? `${YELLOW}⏪ #${cur}/${maxId}${R}` : `${AGY_BLUE}⏪ #${cur}${R}`
  return { full: label, compact: label, minimal: label }
}

function renderAfterBadge (payload, rootDir, rKey) {
  const sid = payload?.conversation_id || payload?.session_id || 'default'
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
  const sid = String(payload?.conversation_id || payload?.session_id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)
  if (!sid || payload?.agent_state === 'idle') return null
  const thFlag = readJson(path.join(rootDir, 'turn-flags', `think-hard-${sid}.json`), null)
  const uhFlag = readJson(path.join(rootDir, 'turn-flags', `use-hydrogen-${sid}.json`), null)
  const legacy = (!thFlag && !uhFlag) ? readJson(path.join(rootDir, 'turn-flags', `${sid}.json`), null) : null
  const thinkHard = Boolean(thFlag?.thinkHard || legacy?.thinkHard)
  const useHydrogen = Boolean(uhFlag?.useHydrogen || legacy?.useHydrogen)
  const parts = []
  if (thinkHard) parts.push(`${MAGENTA}${BOLD}+MAX${R}`)
  if (useHydrogen) parts.push(`${CYAN}${BOLD}_Hydrogen${R}`)
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

export function formatStatusLine (payload, { nowMs = Number(process.env.BETTER_AGY_NOW_MS) || Date.now() } = {}) {
  const installedSet = discoverInstalledPlugins()
  if (installedSet.size === 0) return ''

  const rootDir = stateRoot()
  const globalCfg = readJson(agyConfigJsonPath(), {})
  const allCfg = readJson(path.join(rootDir, 'config.json'), { plugins: {} })
  const pCfg = (name) => (allCfg?.plugins?.[name] && typeof allCfg.plugins[name] === 'object' ? allCfg.plugins[name] : {})

  let cachedRepoKey = null
  const getRepoKey = () => {
    if (cachedRepoKey === null) {
      const cwd = payload?.workspace?.project_dir || payload?.cwd || process.cwd()
      cachedRepoKey = crypto.createHash('sha1').update(String(cwd)).digest('hex').slice(0, 12)
    }
    return cachedRepoKey
  }

  const widgets = []
  if (isEnabled('context-meter', installedSet, globalCfg)) {
    const w = renderContextMeter(payload, pCfg('context-meter'))
    if (w) widgets.push(w)
  }
  if (isEnabled('token-meter', installedSet, globalCfg)) {
    const w = renderTokenMeter(payload, rootDir)
    if (w) widgets.push(w)
  }
  if (isEnabled('sub-meter', installedSet, globalCfg)) {
    const w = renderSubMeter(payload, pCfg('sub-meter'), rootDir, nowMs)
    if (w) widgets.push(w)
  }
  if (isEnabled('time-machine', installedSet, globalCfg)) {
    const w = renderTimeMachineBadge(payload, rootDir, getRepoKey())
    if (w) widgets.push(w)
  }
  if (isEnabled('after', installedSet, globalCfg)) {
    const w = renderAfterBadge(payload, rootDir, getRepoKey())
    if (w) widgets.push(w)
  }
  if (isEnabled('think-hard', installedSet, globalCfg) || isEnabled('use-hydrogen', installedSet, globalCfg)) {
    const w = renderTurnModeBadges(payload, rootDir)
    if (w) widgets.push(w)
  }
  if (isEnabled('narrator', installedSet, globalCfg)) {
    const w = renderNarratorBadge(pCfg('narrator'), rootDir)
    if (w) widgets.push(w)
  }

  if (widgets.length === 0) return ''

  const cols = Math.max(40, (Number(payload?.terminal_width) || 100) - 2)
  const tiers = widgets.map(() => 'full')
  const build = () => widgets.map((w, i) => w[tiers[i]]).filter(Boolean).join(SEP)
  if (visibleWidth(build()) <= cols) return build()

  for (const nextTier of ['compact', 'minimal']) {
    for (let i = 0; i < widgets.length; i++) {
      tiers[i] = nextTier
      if (visibleWidth(build()) <= cols) return build()
    }
  }
  return build()
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
if (isMain) {
  let raw = ''
  try {
    if (!process.stdin.isTTY) raw = fs.readFileSync(0, 'utf8')
  } catch {}
  let payload = {}
  try { payload = raw.trim() ? JSON.parse(raw) : {} } catch {}
  const line = formatStatusLine(payload)
  if (line) process.stdout.write(line + '\n')
}
