#!/usr/bin/env node
// Selectively copies only the shared runtime libraries each plugin actually imports/invokes
// into `plugins/<name>/scripts/lib/`, prunes stale copies, and writes crisp 128x128 SVG icons.
// Supports `--check` (CI drift verification) and `--if-needed` (zero-write when clean).
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SHARED_DIR = path.join(ROOT, 'shared')
const PLUGINS_DIR = path.join(ROOT, 'plugins')

const HUD_CORE = ['store.mjs', 'better-statusline.mjs', 'better-statusline.c', 'ensure-hud.mjs', 'hook-gate.sh']

export const PLUGIN_SHARED_FILES = {
  after: [...HUD_CORE],
  commit: ['store.mjs'],
  'context-meter': [...HUD_CORE, 'transcript.mjs'],
  'image-preview': ['pixels.mjs'],
  narrator: ['store.mjs', 'better-statusline.mjs', 'better-statusline.c', 'transcript.mjs'],
  'quick-peek': ['store.mjs', 'transcript.mjs', 'pixels.mjs', 'hook-gate.sh'],
  'sub-meter': [...HUD_CORE],
  'think-hard': [...HUD_CORE, 'transcript.mjs'],
  'time-machine': ['store.mjs', 'better-statusline.mjs', 'better-statusline.c', 'hook-gate.sh', 'transcript.mjs'],
  'token-meter': [...HUD_CORE, 'transcript.mjs'],
  'use-hydrogen': [...HUD_CORE, 'transcript.mjs']
}

// 128x128 1:1 square icons (~10% padding) in Google Antigravity's cosmic slate & electric blue palette.
const ICONS = {
  'quick-peek': `<circle cx="64" cy="64" r="34" fill="none" stroke="#dce8ff" stroke-width="6"/><circle cx="64" cy="64" r="14" fill="#3186ff"/><path d="M24 64c12-22 28-32 40-32s28 10 40 32c-12 22-28 32-40 32S36 86 24 64z" fill="none" stroke="#60a5fa" stroke-width="5"/>`,
  'image-preview': `<rect x="24" y="30" width="80" height="64" rx="6" fill="#0d1424" stroke="#dce8ff" stroke-width="5"/><circle cx="84" cy="48" r="8" fill="#38bdf8"/><path d="M28 86l22-24 18 18 14-12 18 18z" fill="#3186ff"/>`,
  'sub-meter': `<rect x="24" y="52" width="80" height="24" rx="6" fill="#0d1424" stroke="#475978" stroke-width="4"/><rect x="28" y="56" width="48" height="16" rx="3" fill="#3186ff"/><path d="M64 30v10M42 36l6 8M86 36l-6 8" stroke="#38bdf8" stroke-width="5" stroke-linecap="round"/>`,
  'context-meter': `<rect x="30" y="24" width="68" height="80" rx="8" fill="#0d1424" stroke="#dce8ff" stroke-width="5"/><rect x="40" y="78" width="48" height="14" rx="2" fill="#34d399"/><rect x="40" y="58" width="48" height="14" rx="2" fill="#60a5fa"/><rect x="40" y="38" width="48" height="14" rx="2" fill="#3186ff"/>`,
  commit: `<circle cx="44" cy="40" r="10" fill="#3186ff"/><circle cx="44" cy="88" r="10" fill="#38bdf8"/><circle cx="86" cy="64" r="10" fill="#dce8ff"/><path d="M44 50v28M54 40h14c10 0 18 8 18 18v6" fill="none" stroke="#7aa2f7" stroke-width="6" stroke-linecap="round"/>`,
  narrator: `<path d="M28 52h16l20-18v60L44 76H28z" fill="#dce8ff"/><path d="M76 48c8 8 8 24 0 32M88 36c16 16 16 40 0 56" fill="none" stroke="#3186ff" stroke-width="6" stroke-linecap="round"/>`,
  'time-machine': `<circle cx="66" cy="64" r="36" fill="none" stroke="#dce8ff" stroke-width="6"/><path d="M30 44v20h20" fill="none" stroke="#38bdf8" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/><path d="M66 44v22l16 10" fill="none" stroke="#3186ff" stroke-width="6" stroke-linecap="round"/>`,
  after: `<rect x="26" y="32" width="76" height="16" rx="4" fill="#3186ff"/><rect x="26" y="56" width="60" height="16" rx="4" fill="#60a5fa"/><rect x="26" y="80" width="44" height="16" rx="4" fill="#334666"/>`,
  'use-hydrogen': `<ellipse cx="64" cy="64" rx="40" ry="18" transform="rotate(-30 64 64)" fill="none" stroke="#dce8ff" stroke-width="5"/><ellipse cx="64" cy="64" rx="40" ry="18" transform="rotate(30 64 64)" fill="none" stroke="#60a5fa" stroke-width="4"/><circle cx="64" cy="64" r="12" fill="#3186ff"/><circle cx="96" cy="46" r="6" fill="#38bdf8"/>`,
  'think-hard': `<circle cx="64" cy="54" r="24" fill="#3186ff"/><rect x="52" y="82" width="24" height="14" rx="4" fill="#dce8ff"/><path d="M64 18v8M30 54h8M90 54h8M38 30l6 6M90 30l-6 6" stroke="#38bdf8" stroke-width="5" stroke-linecap="round"/>`,
  'token-meter': `<path d="M44 92V36m0 0L28 52m16-16l16 16" fill="none" stroke="#38bdf8" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/><path d="M84 36v56m0 0L68 76m16 16l16-16" fill="none" stroke="#34d399" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>`
}

function makeSvg (inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <rect x="12" y="12" width="104" height="104" rx="22" fill="#090d16" stroke="#1e2b45" stroke-width="4"/>
  ${inner}
</svg>
`
}

function sha256File (filePath) {
  if (!fs.existsSync(filePath)) return null
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

export function findSyncDrift () {
  const issues = []
  if (!fs.existsSync(PLUGINS_DIR)) return issues
  const entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort()

  for (const name of entries) {
    const required = PLUGIN_SHARED_FILES[name]
    if (!required) {
      issues.push(`Plugin "${name}" is missing from PLUGIN_SHARED_FILES in scripts/sync-shared.mjs`)
      continue
    }
    const libDir = path.join(PLUGINS_DIR, name, 'scripts', 'lib')
    const reqSet = new Set(required)
    for (const file of required) {
      const srcHash = sha256File(path.join(SHARED_DIR, file))
      const dstHash = sha256File(path.join(libDir, file))
      if (!dstHash || srcHash !== dstHash) {
        issues.push(`Drift in plugins/${name}/scripts/lib/${file}`)
      }
    }
    if (fs.existsSync(libDir)) {
      for (const existing of fs.readdirSync(libDir)) {
        if (!reqSet.has(existing)) {
          issues.push(`Unused shared copy present: plugins/${name}/scripts/lib/${existing}`)
        }
      }
    }
    if (ICONS[name]) {
      const logoPath = path.join(PLUGINS_DIR, name, 'assets', 'logo.svg')
      const expectedSvg = makeSvg(ICONS[name])
      const currentSvg = fs.existsSync(logoPath) ? fs.readFileSync(logoPath, 'utf8') : ''
      if (currentSvg !== expectedSvg) {
        issues.push(`Logo drift in plugins/${name}/assets/logo.svg`)
      }
    }
  }

  if (sha256File(path.join(SHARED_DIR, 'better-statusline.mjs')) !== sha256File(path.join(ROOT, 'scripts', 'better-statusline.mjs'))) {
    issues.push('Drift between shared/better-statusline.mjs and scripts/better-statusline.mjs')
  }
  return issues
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const checkOnly = process.argv.includes('--check')
  const ifNeeded = process.argv.includes('--if-needed')

  if (checkOnly) {
    const drift = findSyncDrift()
    if (drift.length > 0) {
      console.error('Shared library sync drift detected:\n  - ' + drift.join('\n  - '))
      process.exit(1)
    }
    console.log('All plugin shared libraries and icons match SHA-256 baseline.')
    process.exit(0)
  }

  if (ifNeeded && findSyncDrift().length === 0) {
    process.exit(0)
  }

  if (!fs.existsSync(PLUGINS_DIR)) process.exit(0)
  const entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort()

  let totalCopies = 0
  for (const name of entries) {
    const pRoot = path.join(PLUGINS_DIR, name)
    const libDir = path.join(pRoot, 'scripts', 'lib')
    fs.mkdirSync(libDir, { recursive: true })
    const required = PLUGIN_SHARED_FILES[name] || []
    const reqSet = new Set(required)

    // Remove unused copies from previous layouts
    for (const existing of fs.readdirSync(libDir)) {
      if (!reqSet.has(existing)) {
        fs.rmSync(path.join(libDir, existing), { force: true })
      }
    }

    for (const file of required) {
      const src = path.join(SHARED_DIR, file)
      const dst = path.join(libDir, file)
      if (fs.existsSync(src)) {
        if (sha256File(src) !== sha256File(dst)) {
          fs.copyFileSync(src, dst)
        }
        if (file.endsWith('.mjs') || file.endsWith('.sh')) fs.chmodSync(dst, 0o755)
        totalCopies++
      }
    }

    const scriptsDir = path.join(pRoot, 'scripts')
    if (fs.existsSync(scriptsDir)) {
      for (const f of fs.readdirSync(scriptsDir)) {
        const full = path.join(scriptsDir, f)
        if (fs.statSync(full).isFile() && (f.endsWith('.mjs') || f.endsWith('.sh') || f.endsWith('.py'))) {
          fs.chmodSync(full, 0o755)
        }
      }
    }

    const assetsDir = path.join(pRoot, 'assets')
    fs.mkdirSync(assetsDir, { recursive: true })
    const logoPath = path.join(assetsDir, 'logo.svg')
    if (ICONS[name]) {
      const expectedSvg = makeSvg(ICONS[name])
      if (!fs.existsSync(logoPath) || fs.readFileSync(logoPath, 'utf8') !== expectedSvg) {
        fs.writeFileSync(logoPath, expectedSvg, 'utf8')
      }
    }
  }

  const sharedSl = path.join(SHARED_DIR, 'better-statusline.mjs')
  const scriptsSl = path.join(ROOT, 'scripts', 'better-statusline.mjs')
  if (fs.existsSync(sharedSl)) {
    if (sha256File(sharedSl) !== sha256File(scriptsSl)) {
      fs.copyFileSync(sharedSl, scriptsSl)
    }
    fs.chmodSync(scriptsSl, 0o755)
  }

  const srcC = path.join(SHARED_DIR, 'better-statusline.c')
  const localBin = path.join(ROOT, 'scripts', 'better-statusline')
  if (fs.existsSync(srcC) && process.platform !== 'win32' && !ifNeeded) {
    for (const cc of ['gcc', 'cc', 'clang']) {
      const r = spawnSync(cc, ['-std=c11', '-O3', '-Wall', '-Wextra', srcC, '-o', localBin, '-lm'], { stdio: 'ignore' })
      if (r.status === 0) {
        fs.chmodSync(localBin, 0o755)
        break
      }
    }
  }

  console.log(`Synced ${totalCopies} selective shared files and icons across ${entries.length} plugins: ${entries.join(', ')}`)
}
