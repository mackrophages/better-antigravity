#!/usr/bin/env node
// Unified composable statusLine engine for Better Antigravity.
// Full parity with native C11 accelerator (`shared/better-statusline.c`):
// - Per-model dynamic context window identifier (`✦ context 18%/1M`, `✻ context 58%/200k`, `❂ context 42%/128k`)
// - Control/escape sequence sanitization on all user/state strings
// - Uniform safeSid path-traversal protection
// - Explicit `week` bucket priority before `resetSec <= 21600`
// - Unified wcwidth column measurement (CJK, emojis, variation selectors)
// - `/proc/<pid>/cmdline` verification against Narrator PID recycling

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

function staticFamilyIcon (kind) {
  return kind === 'claude' ? '✻' : (kind === 'gpt' ? '❂' : '✦')
}

function familyIconColor (kind) {
  return kind === 'claude' ? CLAUDE_AMBER : (kind === 'gpt' ? GPT_SILVER : AGY_BLUE)
}

function pickFamilyIcon (kind, isIdle, nowMs) {
  if (isIdle) return staticFamilyIcon(kind)
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

function safeSid (raw, fallback = '') {
  const clean = String(raw ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)
  return clean || fallback
}

function safeModelKey (raw) {
  return String(raw ?? '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
}

function sanitizeInlineText (raw) {
  return String(raw ?? '')
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
}

function sliceCodePoints (str, maxPoints) {
  const pts = Array.from(str)
  return pts.length <= maxPoints ? str : pts.slice(0, maxPoints).join('')
}

function readJson (filePath, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')) } catch { return fallback }
}

function writeJsonAtomic (filePath, data) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
    let mode = 0o600
    try { mode = fs.statSync(filePath).mode & 0o777 } catch {}
    const tmp = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`
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

function isZeroWidthCodePoint (cp) {
  return (
    cp < 0x20 ||
    (cp >= 0x7f && cp < 0xa0) ||
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xfe20 && cp <= 0xfe2f)
  )
}

function isWideCodePoint (cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x231a && cp <= 0x231b) ||
    (cp >= 0x2329 && cp <= 0x232a) ||
    (cp >= 0x23e9 && cp <= 0x23f3) ||
    (cp >= 0x23f8 && cp <= 0x23fa) ||
    (cp >= 0x25fd && cp <= 0x25fe) ||
    (cp >= 0x2614 && cp <= 0x2615) ||
    (cp >= 0x2648 && cp <= 0x2653) ||
    cp === 0x267f || cp === 0x2693 || cp === 0x26a1 ||
    (cp >= 0x26aa && cp <= 0x26ab) ||
    (cp >= 0x26bd && cp <= 0x26be) ||
    (cp >= 0x26c4 && cp <= 0x26c5) ||
    cp === 0x26ce || cp === 0x26d4 || cp === 0x26ea ||
    (cp >= 0x26f2 && cp <= 0x26f3) ||
    cp === 0x26f5 || cp === 0x26fa || cp === 0x26fd ||
    cp === 0x2705 ||
    (cp >= 0x270a && cp <= 0x270b) ||
    cp === 0x2728 || cp === 0x274c || cp === 0x274e ||
    (cp >= 0x2753 && cp <= 0x2755) ||
    cp === 0x2757 ||
    (cp >= 0x2795 && cp <= 0x2797) ||
    cp === 0x27b0 || cp === 0x27bf ||
    (cp >= 0x2b1b && cp <= 0x2b1c) ||
    cp === 0x2b50 || cp === 0x2b55 ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3040 && cp <= 0x33bf) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0xa4cf) ||
    (cp >= 0xa960 && cp <= 0xa97c) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff01 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f000 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
}

function visibleWidth (str) {
  const s = String(str ?? '')
  let w = 0
  for (let i = 0; i < s.length;) {
    const code = s.charCodeAt(i)
    if (code === 0x1b) {
      const next = s.charCodeAt(i + 1)
      if (next === 0x5b) {
        i += 2
        while (i < s.length) {
          const c = s.charCodeAt(i++)
          if (c >= 0x40 && c <= 0x7e) break
        }
        continue
      }
      if (next === 0x5d) {
        i += 2
        while (i < s.length) {
          const c = s.charCodeAt(i++)
          if (c === 0x07) break
          if (c === 0x1b && s.charCodeAt(i) === 0x5c) { i++; break }
        }
        continue
      }
    }
    const cp = s.codePointAt(i)
    const step = cp > 0xffff ? 2 : 1
    if (isZeroWidthCodePoint(cp)) {
      i += step
      continue
    }
    const nextCp = i + step < s.length ? s.codePointAt(i + step) : 0
    if (nextCp === 0xfe0e) {
      w += 1
      i += step + 1
      continue
    }
    if (nextCp === 0xfe0f) {
      w += 2
      i += step + 1
      continue
    }
    w += isWideCodePoint(cp) ? 2 : 1
    i += step
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

/** Compact window-capacity label: `200k`, `128k` (for both 128,000 and 131,072), `1M` (for 1,000,000 and 1,048,576), `2M`. */
export function shortWindowLabel (winSize) {
  const n = Math.round(Number(winSize) || 200_000)
  if (n >= 950_000) {
    const binaryM = n / 1_048_576
    if (Math.abs(binaryM - Math.round(binaryM)) < 0.02 && Math.round(binaryM) >= 1) {
      return `${Math.round(binaryM)}M`
    }
    const decTenths = Math.round(n / 100_000)
    return decTenths % 10 === 0 ? `${decTenths / 10}M` : `${Math.floor(decTenths / 10)}.${decTenths % 10}M`
  }
  if (n >= 1024 && (n & (n - 1)) === 0) {
    return `${n / 1024}k`
  }
  return `${Math.max(1, Math.round(n / 1000))}k`
}

function extractModelInfo (payload) {
  const m = payload?.model
  const rawId = typeof m === 'string' ? m : (m?.id || '')
  const rawDisplay = typeof m === 'string' ? '' : (m?.display_name || '')
  const combined = `${rawId} ${rawDisplay}`.toLowerCase()
  let kind = 'google'
  if (combined.includes('gpt') || combined.includes('openai')) kind = 'gpt'
  else if (combined.includes('claude') || combined.includes('anthropic')) kind = 'claude'
  const key = safeModelKey(rawId || rawDisplay)
  return { kind, key, combined }
}

function inferModelWindowTokens (combinedLow) {
  if (!combinedLow) return 0
  if (combinedLow.includes('[2m]') || combinedLow.includes('-2m') || combinedLow.includes(' 2m')) return 2_000_000
  if (combinedLow.includes('[1m]') || combinedLow.includes('-1m') || combinedLow.includes(' 1m')) return 1_000_000
  if (combinedLow.includes('gemini') || combinedLow.includes('orchestrator')) return 1_000_000
  if (combinedLow.includes('gpt-oss') || combinedLow.includes('128k')) return 131_072
  if (combinedLow.includes('claude') || combinedLow.includes('anthropic')) return 200_000
  return 0
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
  const cleanId = sanitizeInlineText(id)
  const low = cleanId.toLowerCase()
  if (low.includes('5h') || low.includes('five_hour') || low.includes('session')) {
    return '5h'
  }
  if (low.includes('week') || low.includes('seven_day') || low.endsWith('wk')) {
    return 'week'
  }
  if (typeof resetSec === 'number' && resetSec > 0 && resetSec <= 21600) {
    return '5h'
  }
  return sliceCodePoints(cleanId.replace(/^(gemini|antigravity|3p|claude|gpt)-/i, ''), 10)
}

function resolveBucketKind (idOrLabel, modelKind, pluginCfg) {
  const low = String(idOrLabel || '').toLowerCase()
  if (low.includes('gpt') || low.includes('openai')) return 'gpt'
  if (low.includes('claude') || low.includes('anthropic')) return 'claude'
  if (low.startsWith('3p') || low.includes('3p-') || low.includes('third')) {
    const theme = String(pluginCfg?.thirdPartyTheme || 'auto').toLowerCase()
    if (theme === 'gpt') return 'gpt'
    if (theme === 'claude') return 'claude'
    return modelKind === 'gpt' ? 'gpt' : 'claude'
  }
  return 'google'
}

const ISO_TZ_RE = /^\s*\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)\s*$/i
const MAX_RESET_SECONDS = 315_360_000

function parseIsoWithExplicitTz (raw) {
  if (typeof raw !== 'string' || !ISO_TZ_RE.test(raw)) return NaN
  return Date.parse(raw.trim())
}

function parseQuotas (quotaObj, nowMs) {
  if (!quotaObj || typeof quotaObj !== 'object') return []
  const list = []
  for (const [id, entry] of Object.entries(quotaObj)) {
    if (!entry || typeof entry !== 'object' || entry.disabled) continue
    let pctUsed = null
    if (typeof entry.remaining_fraction === 'number' && Number.isFinite(entry.remaining_fraction)) {
      pctUsed = Math.max(0, Math.min(100, (1 - entry.remaining_fraction) * 100))
    } else if (typeof entry.used_percentage === 'number' && Number.isFinite(entry.used_percentage)) {
      pctUsed = Math.max(0, Math.min(100, entry.used_percentage))
    }
    if (pctUsed === null) continue
    let resetSec = typeof entry.reset_in_seconds === 'number' && Number.isFinite(entry.reset_in_seconds)
      ? Math.max(0, Math.min(MAX_RESET_SECONDS, entry.reset_in_seconds))
      : null
    const rawResetTime = typeof entry.reset_time === 'string' && entry.reset_time ? entry.reset_time : null
    const parsedResetMs = rawResetTime ? parseIsoWithExplicitTz(rawResetTime) : NaN
    if (resetSec === null && Number.isFinite(parsedResetMs)) {
      resetSec = Math.max(0, Math.min(MAX_RESET_SECONDS, Math.round((parsedResetMs - nowMs) / 1000)))
    }
    const resetsAtMs = Number.isFinite(parsedResetMs)
      ? parsedResetMs
      : (resetSec !== null ? Math.round(nowMs + resetSec * 1000) : null)
    let resetsAt = Number.isFinite(parsedResetMs) ? rawResetTime.trim() : null
    if (!resetsAt && resetsAtMs !== null) {
      try { resetsAt = new Date(resetsAtMs).toISOString() } catch { resetsAt = null }
    }
    list.push({
      id: sanitizeInlineText(id),
      label: bucketLabel(id, resetSec),
      percentUsed: pctUsed,
      resetsAt,
      resetsAtMs: Number.isFinite(resetsAtMs) ? resetsAtMs : null,
      resetSec
    })
  }
  return list
}

function syncContextWindowCache (payload, rootDir, modelInfo, sid) {
  const liveWin = Number(payload?.context_window?.context_window_size)
  if (!Number.isFinite(liveWin) || liveWin <= 0) return 0
  const rounded = Math.round(liveWin)
  const cwDir = path.join(rootDir, 'context-windows')
  if (modelInfo.key) {
    const mPath = path.join(cwDir, `model-${modelInfo.key}.json`)
    if (Number(readJson(mPath, null)?.windowTokens) !== rounded) {
      writeJsonAtomic(mPath, { model: modelInfo.key, family: modelInfo.kind, windowTokens: rounded })
    }
  }
  if (sid) {
    const sPath = path.join(cwDir, `sess-${sid}.json`)
    const prev = readJson(sPath, null)
    if (Number(prev?.windowTokens) !== rounded || (modelInfo.key && prev?.model !== modelInfo.key)) {
      writeJsonAtomic(sPath, { model: modelInfo.key || prev?.model || '', family: modelInfo.kind, windowTokens: rounded })
    }
  }
  return rounded
}

function resolveEffectiveWindowSize (rootDir, pluginCfg, modelInfo, sid, liveWinSize) {
  if (liveWinSize > 0) return liveWinSize
  if (Number(pluginCfg.windowTokens) > 0) return Math.round(Number(pluginCfg.windowTokens))
  const cwDir = path.join(rootDir, 'context-windows')
  if (modelInfo.key) {
    const savedModelWin = Number(readJson(path.join(cwDir, `model-${modelInfo.key}.json`), null)?.windowTokens)
    if (savedModelWin > 0) return savedModelWin
  }
  if (sid) {
    const savedSessWin = Number(readJson(path.join(cwDir, `sess-${sid}.json`), null)?.windowTokens)
    if (savedSessWin > 0) return savedSessWin
  }
  const inferred = inferModelWindowTokens(modelInfo.combined)
  return inferred > 0 ? inferred : 200_000
}

function renderContextMeter (payload, pluginCfg, rootDir, modelInfo, sid, liveWinSize) {
  const warnAt = typeof pluginCfg.warnAt === 'number' ? pluginCfg.warnAt : 50
  const dangerAt = typeof pluginCfg.dangerAt === 'number' ? pluginCfg.dangerAt : 75
  const cw = payload?.context_window
  const windowSize = resolveEffectiveWindowSize(rootDir, pluginCfg, modelInfo, sid, liveWinSize)
  let pct = typeof cw?.used_percentage === 'number' && Number.isFinite(cw.used_percentage) &&
    cw.used_percentage >= 0 && (cw?.current_usage !== null || cw.used_percentage > 0)
    ? Math.min(100, cw.used_percentage)
    : null
  let isEstimate = false

  if (pct === null && payload?.transcript_path) {
    try {
      const stat = fs.statSync(expandTildePath(String(payload.transcript_path)))
      const estTokens = Math.round(stat.size / 4)
      pct = Math.min(99, (estTokens / windowSize) * 100)
      isEstimate = true
    } catch {}
  }
  if (pct === null) return null

  const rounded = clampInt(Math.round(pct), 0, 100)
  const prefix = isEstimate ? '~' : ''
  const winLabel = shortWindowLabel(windowSize)
  const icon = staticFamilyIcon(modelInfo.kind)
  const iconCol = familyIconColor(modelInfo.kind)
  const color = pct >= dangerAt ? `${RED}${BOLD}` : pct >= warnAt ? YELLOW : DIM
  const fullHint = pct >= dangerAt ? ' · new session' : pct >= warnAt ? ' · /compact' : ''
  return {
    full: `${iconCol}${icon}${R} ${color}context ${prefix}${rounded}%/${winLabel}${fullHint}${R}`,
    compact: `${iconCol}${icon}${R} ${color}ctx ${prefix}${rounded}%/${winLabel}${R}`,
    minimal: `${iconCol}${icon}${R}${color}${prefix}${rounded}%/${winLabel}${R}`
  }
}

function renderTokenMeter (payload, rootDir, sid) {
  const cw = payload?.context_window
  const usage = cw?.current_usage
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

function renderSubMeter (payload, pluginCfg, rootDir, modelInfo, nowMs) {
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
        id: sanitizeInlineText(b.id || ''),
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
      const idx = ((Math.floor(nowMs / (rotateSec * 1000)) % buckets.length) + buckets.length) % buckets.length
      chosen = [buckets[idx]]
    } else if (display === 'session') {
      const short = buckets.filter(b => b.label.includes('5h') || (b.label !== 'week' && b.resetSec > 0 && b.resetSec <= 21600))
      if (short.length > 0) chosen = short
    } else if (display === 'week') {
      const wk = buckets.filter(b => b.label.includes('week') || b.label.includes('wk'))
      if (wk.length > 0) chosen = wk
    }
  }

  const isIdle = payload?.agent_state === 'idle'
  const fmtWindow = (w, withBar, withReset) => {
    const kind = resolveBucketKind(w.id || w.label, modelInfo.kind, pluginCfg)
    const icon = pickFamilyIcon(kind, isIdle, nowMs)
    const iconColor = familyIconColor(kind)
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

function clampInt (v, lo, hi) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return lo
  const t = Math.trunc(v)
  return t < lo ? lo : (t > hi ? hi : t)
}

function renderTimeMachineBadge (rootDir, rKey, sid) {
  if (!sid) return null
  const st = readJson(path.join(rootDir, 'time-machine', rKey, `${sid}.json`), null)
  if (!st) return null
  const states = Array.isArray(st.states) ? st.states : []
  let maxId = typeof st.maxId === 'number' && Number.isFinite(st.maxId) ? clampInt(st.maxId, 0, 1_000_000_000) : 0
  for (const s of states) {
    const id = clampInt(Number(s?.id), 0, 1_000_000_000)
    if (id > maxId) maxId = id
  }
  if (maxId <= 0) return null
  const cur = st.cursor !== null && st.cursor !== undefined && Number.isFinite(Number(st.cursor))
    ? clampInt(Number(st.cursor), 0, 1_000_000_000)
    : maxId
  const label = cur < maxId ? `${YELLOW}⏪ #${cur}/${maxId}${R}` : `${AGY_BLUE}⏪ #${cur}${R}`
  return { full: label, compact: label, minimal: label }
}

function renderAfterBadge (rootDir, rKey, sid) {
  const asid = sid || 'default'
  const st = readJson(path.join(rootDir, 'after', `${rKey}-${asid}.json`), null) ||
    readJson(path.join(rootDir, 'after', `${rKey}.json`), null)
  if (!st) return null
  const count = Array.isArray(st.items) ? st.items.length : 0
  if (!st.running && count === 0) return null
  if (st.paused) {
    const s = `${YELLOW}⏸ after (${count})${R}`
    return { full: s, compact: s, minimal: `${YELLOW}⏸${count}${R}` }
  }
  if (st.running) {
    const shortTask = sliceCodePoints(sanitizeInlineText(st.running.text || ''), 22)
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

function renderTurnModeBadges (payload, rootDir, sid) {
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

function isNarratorWorkerAlive (pid, startedAt, nowMs) {
  const n = clampInt(Number(pid), 0, 2_147_483_647)
  if (n <= 0) return false
  try {
    process.kill(n, 0)
  } catch (err) {
    if (err?.code !== 'EPERM') return false
  }
  if (fs.existsSync('/proc/self/cmdline')) {
    try {
      const cmdline = fs.readFileSync(`/proc/${n}/cmdline`).toString('utf8').replace(/\0/g, ' ')
      return cmdline.includes('speak-worker')
    } catch {
      return false
    }
  }
  if (startedAt > 0 && nowMs - Number(startedAt) > 180_000) return false
  return true
}

function renderNarratorBadge (pluginCfg, rootDir, nowMs) {
  const runtime = readJson(path.join(rootDir, 'narrator-runtime.json'), {})
  const enabled = Boolean(pluginCfg.enabled)
  const cleanLang = sliceCodePoints(sanitizeInlineText(pluginCfg.language || ''), 12).toUpperCase()
  const langTag = cleanLang ? ` · ${cleanLang}` : ''
  const speaking = runtime?.speakingPid
    ? isNarratorWorkerAlive(runtime.speakingPid, Number(runtime.startedAt) || 0, nowMs)
    : false
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

  const sid = safeSid(payload?.conversation_id || payload?.session_id)
  const modelInfo = extractModelInfo(payload)
  const liveWinSize = syncContextWindowCache(payload, rootDir, modelInfo, sid)

  let cachedRepoKey = null
  const getRepoKey = () => {
    if (cachedRepoKey === null) {
      const cwd = String(payload?.workspace?.project_dir || payload?.cwd || process.cwd()).replace(/\0/g, '')
      cachedRepoKey = crypto.createHash('sha1').update(cwd).digest('hex').slice(0, 12)
    }
    return cachedRepoKey
  }

  const widgets = []
  if (isEnabled('context-meter', installedSet, globalCfg)) {
    const w = renderContextMeter(payload, pCfg('context-meter'), rootDir, modelInfo, sid, liveWinSize)
    if (w) widgets.push(w)
  }
  if (isEnabled('token-meter', installedSet, globalCfg)) {
    const w = renderTokenMeter(payload, rootDir, sid)
    if (w) widgets.push(w)
  }
  if (isEnabled('sub-meter', installedSet, globalCfg)) {
    const w = renderSubMeter(payload, pCfg('sub-meter'), rootDir, modelInfo, nowMs)
    if (w) widgets.push(w)
  }
  if (isEnabled('time-machine', installedSet, globalCfg)) {
    const w = renderTimeMachineBadge(rootDir, getRepoKey(), sid)
    if (w) widgets.push(w)
  }
  if (isEnabled('after', installedSet, globalCfg)) {
    const w = renderAfterBadge(rootDir, getRepoKey(), sid)
    if (w) widgets.push(w)
  }
  if (isEnabled('think-hard', installedSet, globalCfg) || isEnabled('use-hydrogen', installedSet, globalCfg)) {
    const w = renderTurnModeBadges(payload, rootDir, sid)
    if (w) widgets.push(w)
  }
  if (isEnabled('narrator', installedSet, globalCfg)) {
    const w = renderNarratorBadge(pCfg('narrator'), rootDir, nowMs)
    if (w) widgets.push(w)
  }

  if (widgets.length === 0) return ''

  const rawTw = Number(payload?.terminal_width)
  const effTw = Number.isFinite(rawTw) && rawTw > 0 ? clampInt(rawTw, 42, 10_000) : 100
  const cols = Math.max(40, effTw - 2)
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
  try {
    let raw = ''
    try {
      if (!process.stdin.isTTY) raw = fs.readFileSync(0, 'utf8')
    } catch {}
    let payload = {}
    try { payload = raw.trim() ? JSON.parse(raw) : {} } catch {}
    const line = formatStatusLine(payload)
    if (line) process.stdout.write(line + '\n')
  } catch {}
}
