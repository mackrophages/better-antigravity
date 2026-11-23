// Shared zero-dependency persistence, locking, config, plugin discovery, and formatting helpers
// for Better Antigravity plugins and CLI statusLine.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4))

export function sleepSyncMs (ms) {
  Atomics.wait(SLEEP_BUF, 0, 0, Math.max(1, Math.trunc(ms)))
}

export function homeDir () {
  return process.env.BETTER_AGY_TEST_HOME || os.homedir()
}

export function stateRoot () {
  return process.env.BETTER_AGY_HOME || path.join(homeDir(), '.gemini', 'antigravity-cli', 'better-antigravity')
}

export function pluginsRoot () {
  return process.env.BETTER_AGY_PLUGINS_DIR || path.join(homeDir(), '.gemini', 'config', 'plugins')
}

export function agyConfigJsonPath () {
  return process.env.BETTER_AGY_CONFIG_JSON || path.join(homeDir(), '.gemini', 'config', 'config.json')
}

export function agyCliSettingsPath () {
  return process.env.BETTER_AGY_SETTINGS_JSON || path.join(homeDir(), '.gemini', 'antigravity-cli', 'settings.json')
}

export function isHeadless () {
  return process.env.CLAUDE_MEM_SIN_HOOK === '1' || process.env.AGY_HEADLESS === '1'
}

export function isSubcall () {
  return process.env.BETTER_AGY_SUBCALL === '1'
}

/** Uniform session/conversation ID sanitizer (max 64 [a-zA-Z0-9_-] chars, path-traversal proof). */
export function safeSid (raw, fallback = '') {
  const clean = String(raw ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)
  return clean || fallback
}

/** Checks whether a POSIX PID currently exists (treats EPERM as alive, ESRCH as dead). */
export function isProcessAlive (pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

/**
 * Verifies that `pid` is a live Narrator `speak-worker` process, guarding against PID recycling
 * under Linux/Android proot via `/proc/<pid>/cmdline` (with bounded age fallback on non-procfs OSes).
 */
export function isNarratorWorkerAlive (pid, startedAt = 0) {
  const n = Number(pid)
  if (!isProcessAlive(n)) return false
  if (fs.existsSync('/proc/self/cmdline')) {
    try {
      const raw = fs.readFileSync(`/proc/${n}/cmdline`)
      const text = raw.toString('utf8').replace(/\0/g, ' ')
      return text.includes('speak-worker')
    } catch {
      return false
    }
  }
  if (startedAt > 0 && Date.now() - Number(startedAt) > 180_000) return false
  return true
}

function ensurePrivateDir (dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
}

function tryReclaimDeadLock (lockPath, expectedRaw) {
  const reclaimPath = `${lockPath}.reclaim`
  let rfd = -1
  try {
    rfd = fs.openSync(reclaimPath, 'wx', 0o600)
    fs.writeSync(rfd, `${process.pid}\n`)
    fs.closeSync(rfd)
    rfd = -1
    const currentRaw = fs.readFileSync(lockPath, 'utf8').trim()
    if (currentRaw === expectedRaw) {
      const holderPid = Number(currentRaw.split(':')[0])
      if (!currentRaw || (holderPid > 0 && !isProcessAlive(holderPid))) {
        fs.unlinkSync(lockPath)
      }
    }
  } catch (err) {
    if (err?.code === 'EEXIST') {
      try {
        const rPid = Number(fs.readFileSync(reclaimPath, 'utf8').trim())
        if (rPid > 0 && !isProcessAlive(rPid)) fs.unlinkSync(reclaimPath)
      } catch {}
    }
  } finally {
    if (rfd !== -1) {
      try { fs.closeSync(rfd) } catch {}
    }
    try {
      const owner = Number(fs.readFileSync(reclaimPath, 'utf8').trim())
      if (owner === process.pid) fs.unlinkSync(reclaimPath)
    } catch {}
  }
}

/**
 * Cross-process exclusive lockfile (`wx` + `pid:nonce` + serialized `.reclaim` stale recovery).
 * Bounded strictly by iteration count (`maxTurns`), throwing if mutual exclusion cannot be established.
 */
export function withFileLock (targetFilePath, fn, { maxTurns = 600, stepMs = 15 } = {}) {
  const dir = path.dirname(targetFilePath)
  ensurePrivateDir(dir)
  const lockPath = `${targetFilePath}.lock`
  const token = `${process.pid}:${crypto.randomBytes(4).toString('hex')}`
  let acquired = false
  let emptyRetries = 0
  let lastErr = null

  for (let turn = 0; turn < maxTurns; turn++) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600)
      try {
        fs.writeSync(fd, `${token}\n`)
      } finally {
        fs.closeSync(fd)
      }
      acquired = true
      break
    } catch (err) {
      lastErr = err
      if (err?.code !== 'EEXIST') throw err
      try {
        const raw = fs.readFileSync(lockPath, 'utf8').trim()
        if (!raw) {
          emptyRetries++
          if (emptyRetries > 20) {
            tryReclaimDeadLock(lockPath, '')
            emptyRetries = 0
            continue
          }
        } else {
          emptyRetries = 0
          const holderPid = Number(raw.split(':')[0])
          if (holderPid > 0 && !isProcessAlive(holderPid)) {
            tryReclaimDeadLock(lockPath, raw)
            continue
          }
        }
      } catch {}
      sleepSyncMs(stepMs)
    }
  }

  if (!acquired) {
    throw lastErr || new Error(`Timed out acquiring file lock: ${lockPath}`)
  }

  try {
    return fn()
  } finally {
    try {
      const cur = fs.readFileSync(lockPath, 'utf8').trim()
      if (cur === token) fs.unlinkSync(lockPath)
    } catch {}
  }
}

export function readJsonFile (filePath, fallback = null) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

export function writeJsonAtomic (filePath, value) {
  const dir = path.dirname(filePath)
  ensurePrivateDir(dir)
  let mode = 0o600
  try { mode = fs.statSync(filePath).mode & 0o777 } catch {}
  const tmp = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode })
  try { fs.chmodSync(tmp, mode) } catch {}
  fs.renameSync(tmp, filePath)
}

export function readState (relPath, fallback = null) {
  return readJsonFile(path.join(stateRoot(), relPath), fallback)
}

export function writeState (relPath, value) {
  const root = stateRoot()
  ensurePrivateDir(root)
  writeJsonAtomic(path.join(root, relPath), value)
  return value
}

export function updateState (relPath, fallback, updater) {
  const root = stateRoot()
  ensurePrivateDir(root)
  const full = path.join(root, relPath)
  return withFileLock(full, () => {
    const current = readJsonFile(full, fallback)
    const next = updater(current)
    writeJsonAtomic(full, next)
    return next
  })
}

export function getPluginConfig (pluginName, defaults = {}) {
  const all = readState('config.json', { plugins: {} })
  const saved = all?.plugins?.[pluginName]
  return { ...defaults, ...(saved && typeof saved === 'object' ? saved : {}) }
}

export function setPluginConfig (pluginName, patch) {
  return updateState('config.json', { plugins: {} }, (curr) => {
    const base = curr && typeof curr === 'object' ? curr : { plugins: {} }
    const plugins = base.plugins && typeof base.plugins === 'object' ? base.plugins : {}
    const prev = plugins[pluginName] && typeof plugins[pluginName] === 'object' ? plugins[pluginName] : {}
    return {
      ...base,
      plugins: {
        ...plugins,
        [pluginName]: { ...prev, ...patch }
      }
    }
  }).plugins[pluginName]
}

export function isPluginEnabled (pluginName) {
  const pRoot = path.join(pluginsRoot(), pluginName)
  const hasManifest = fs.existsSync(path.join(pRoot, 'plugin.json')) ||
    fs.existsSync(path.join(pRoot, '.antigravity-plugin', 'plugin.json'))
  if (!hasManifest) return false
  const cfg = readJsonFile(agyConfigJsonPath(), {})
  if (cfg?.plugins?.[pluginName]?.enabled === false) return false
  return true
}

export async function readStdinJson () {
  if (process.stdin.isTTY) return {}
  const chunks = []
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

export function repoKey (cwd) {
  return crypto.createHash('sha1').update(String(cwd || process.cwd()).replace(/\0/g, '')).digest('hex').slice(0, 12)
}

const UNITS = ['k', 'M', 'B']

/** One decimal, rounded half up (exact port of midudev/better-claude token-meter). */
export function shortTokens (n) {
  const val = typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0
  if (val < 1000) return `${val}`
  let unit = 0
  let tenths = Math.round(val / 100)
  while (tenths >= 10_000 && unit < UNITS.length - 1) {
    tenths = Math.round(val / (100 * 1000 ** ++unit))
  }
  return `${Math.floor(tenths / 10)}.${tenths % 10}${UNITS[unit]}`
}

/** Compact window-capacity badge: `200k`, `128k` (128,000 or 131,072), `1M` (1,000,000 or 1,048,576), `2M`. */
export function shortWindowLabel (winSize) {
  const n = Math.round(Number(winSize) || 200_000)
  if (n >= 950_000) {
    const binaryM = n / 1_048_576
    if (Math.abs(binaryM - Math.round(binaryM)) < 0.02 && Math.round(binaryM) >= 1) return `${Math.round(binaryM)}M`
    const decTenths = Math.round(n / 100_000)
    return decTenths % 10 === 0 ? `${decTenths / 10}M` : `${Math.floor(decTenths / 10)}.${decTenths % 10}M`
  }
  if (n >= 1024 && (n & (n - 1)) === 0) return `${n / 1024}k`
  return `${Math.max(1, Math.round(n / 1000))}k`
}

/** "42m", "2h 10m", "3d 4h": duration formatter for quota reset windows. */
export function formatUntilSeconds (sec) {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec <= 0) return ''
  const minutes = Math.max(1, Math.round(sec / 60))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
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

/** Unified wcwidth-aware visible column counter (strips CSI/OSC escapes, handles \uFE0E/\uFE0F, CJK, and emojis). */
export function visibleWidth (str) {
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

function tryBuildNativeStatusLine (sourceScriptPath, targetBin) {
  if (process.env.BETTER_AGY_DISABLE_NATIVE === '1' || process.platform === 'win32') return false
  const dir = path.dirname(sourceScriptPath)
  const candidates = [
    path.join(dir, 'better-statusline.c'),
    path.resolve(dir, '..', 'shared', 'better-statusline.c')
  ]
  const srcC = candidates.find(p => fs.existsSync(p))
  if (!srcC) return false

  let srcHash = ''
  const hashFile = `${targetBin}.sha256`
  try {
    srcHash = crypto.createHash('sha256').update(fs.readFileSync(srcC)).digest('hex')
    const bStat = fs.statSync(targetBin, { throwIfNoEntry: false })
    const savedHash = fs.existsSync(hashFile) ? fs.readFileSync(hashFile, 'utf8').trim() : ''
    if (bStat && bStat.size > 0 && savedHash === srcHash) {
      return true
    }
  } catch {}

  const tmpBin = `${targetBin}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  for (const cc of ['gcc', 'cc', 'clang']) {
    try {
      const r = spawnSync(cc, ['-std=c11', '-O3', '-Wall', '-Wextra', srcC, '-o', tmpBin, '-lm'], {
        stdio: 'ignore',
        timeout: 15_000
      })
      if (r.status === 0 && fs.existsSync(tmpBin)) {
        fs.chmodSync(tmpBin, 0o755)
        // Smoke-test the newly compiled binary with `{}` before promoting it live
        const smoke = spawnSync(tmpBin, [], {
          input: '{}',
          encoding: 'utf8',
          timeout: 3_000
        })
        if (smoke.status === 0 && !smoke.signal && !smoke.error) {
          fs.renameSync(tmpBin, targetBin)
          if (srcHash) {
            try { fs.writeFileSync(hashFile, `${srcHash}\n`, { encoding: 'utf8', mode: 0o600 }) } catch {}
          }
          return true
        }
      }
    } catch {} finally {
      try { fs.rmSync(tmpBin, { force: true }) } catch {}
    }
  }
  return false
}

/**
 * Ensures ~/.gemini/antigravity-cli/better-statusline(.mjs) is up to date and wired
 * into settings.json (non-destructively, with backup). Defaults `preferNative = true`
 * so SessionStart hooks never downgrade the ~6ms native C11 binary back to Node JS.
 */
export function ensureStatusLineInstalled (sourceScriptPath, { force = false, preferNative = true } = {}) {
  if (isHeadless() && !force) return { installed: false, reason: 'headless' }
  if (!sourceScriptPath || !fs.existsSync(sourceScriptPath)) {
    return { installed: false, reason: 'missing-source' }
  }
  const agyDir = path.join(homeDir(), '.gemini', 'antigravity-cli')
  const targetScript = path.join(agyDir, 'better-statusline.mjs')
  const targetBin = path.join(agyDir, 'better-statusline')
  fs.mkdirSync(agyDir, { recursive: true })

  const srcContent = fs.readFileSync(sourceScriptPath, 'utf8')
  let dstContent = ''
  try { dstContent = fs.readFileSync(targetScript, 'utf8') } catch {}
  if (srcContent !== dstContent) {
    const tmp = `${targetScript}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
    fs.writeFileSync(tmp, srcContent, { mode: 0o755 })
    fs.chmodSync(tmp, 0o755)
    fs.renameSync(tmp, targetScript)
  }

  const hasNative = preferNative && tryBuildNativeStatusLine(sourceScriptPath, targetBin)
  const quotedBin = targetBin.includes(' ') ? `"${targetBin}"` : targetBin
  const quotedScript = targetScript.includes(' ') ? `"${targetScript}"` : targetScript
  const desiredCmd = hasNative ? quotedBin : `node ${quotedScript}`

  const writeReadyStamp = (kind) => {
    try {
      const stamp = path.join(stateRoot(), '.hud-ready')
      ensurePrivateDir(path.dirname(stamp))
      fs.writeFileSync(stamp, `${kind}\n`, { encoding: 'utf8', mode: 0o600 })
    } catch {}
  }

  const settingsFile = agyCliSettingsPath()
  const settings = readJsonFile(settingsFile, {})
  const existingCmd = settings?.statusLine?.command || ''

  if (!existingCmd || existingCmd.includes('better-statusline') || force) {
    if (existingCmd !== desiredCmd || settings?.statusLine?.enabled === false) {
      const bakFile = `${settingsFile}.bak-better-agy`
      if (fs.existsSync(settingsFile) && !fs.existsSync(bakFile)) {
        fs.copyFileSync(settingsFile, bakFile)
      }
      const nextSettings = {
        ...settings,
        statusLine: {
          type: 'command',
          command: desiredCmd,
          stack_with_default: settings?.statusLine?.stack_with_default ?? true,
          enabled: true
        }
      }
      writeJsonAtomic(settingsFile, nextSettings)
      writeReadyStamp(hasNative ? 'native' : 'node')
      return { installed: true, native: hasNative, updatedSettings: true, targetScript: hasNative ? targetBin : targetScript }
    }
    writeReadyStamp(hasNative ? 'native' : 'node')
    return { installed: true, native: hasNative, updatedSettings: false, targetScript: hasNative ? targetBin : targetScript }
  }

  writeReadyStamp('custom')
  return { installed: true, native: hasNative, updatedSettings: false, preservedCustom: existingCmd, targetScript }
}
