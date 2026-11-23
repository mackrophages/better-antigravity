// Shared zero-dependency persistence, config, plugin discovery, and formatting helpers
// for Better Antigravity plugins and CLI statusLine.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

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
  fs.mkdirSync(dir, { recursive: true })
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
  writeJsonAtomic(path.join(stateRoot(), relPath), value)
  return value
}

export function updateState (relPath, fallback, updater) {
  const current = readState(relPath, fallback)
  const next = updater(current)
  writeState(relPath, next)
  return next
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
  return crypto.createHash('sha1').update(String(cwd || process.cwd())).digest('hex').slice(0, 12)
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

/** "42m", "2h 10m", "3d 4h": duration formatter for quota reset windows. */
export function formatUntilSeconds (sec) {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec <= 0) return ''
  const minutes = Math.max(1, Math.round(sec / 60))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/** Strips ANSI SGR sequences and variation selectors to measure visible terminal columns. */
export function visibleWidth (str) {
  const plain = String(str ?? '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/[\uFE0E\uFE0F]/g, '')
  return [...plain].length
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

  try {
    const cStat = fs.statSync(srcC)
    const bStat = fs.statSync(targetBin, { throwIfNoEntry: false })
    if (bStat && bStat.mtimeMs >= cStat.mtimeMs && bStat.size > 0) {
      return true
    }
  } catch {}

  const tmpBin = `${targetBin}.tmp-${process.pid}`
  for (const cc of ['gcc', 'cc', 'clang']) {
    try {
      const r = spawnSync(cc, ['-O3', srcC, '-o', tmpBin, '-lm'], { stdio: 'ignore', timeout: 15_000 })
      if (r.status === 0 && fs.existsSync(tmpBin)) {
        fs.chmodSync(tmpBin, 0o755)
        fs.renameSync(tmpBin, targetBin)
        return true
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
    const tmp = `${targetScript}.tmp-${process.pid}`
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
      fs.mkdirSync(path.dirname(stamp), { recursive: true })
      fs.writeFileSync(stamp, `${kind}\n`, 'utf8')
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
