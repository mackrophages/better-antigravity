#!/usr/bin/env node
// Copies shared runtime libraries into each plugin's scripts/lib/ folder and writes
// crisp 128x128 square SVG icons so every plugin in plugins/* is 100% standalone.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SHARED_DIR = path.join(ROOT, 'shared')
const PLUGINS_DIR = path.join(ROOT, 'plugins')

const SHARED_FILES = [
  'store.mjs',
  'better-statusline.mjs',
  'better-statusline.c',
  'ensure-hud.mjs',
  'hook-gate.sh',
  'transcript.mjs',
  'pixels.mjs'
]

// 128x128 1:1 square icons (~10% padding) in Google Antigravity's cosmic slate & electric blue palette.
const ICONS = {
  'quick-peek': `<circle cx="64" cy="64" r="34" fill="none" stroke="#dce8ff" stroke-width="6"/><circle cx="64" cy="64" r="14" fill="#3186ff"/><path d="M24 64c12-22 28-32 40-32s28 10 40 32c-12 22-28 32-40 32S36 86 24 64z" fill="none" stroke="#60a5fa" stroke-width="5"/>`,
  'image-preview': `<rect x="24" y="30" width="80" height="64" rx="6" fill="#0d1424" stroke="#dce8ff" stroke-width="5"/><circle cx="84" cy="48" r="8" fill="#38bdf8"/><path d="M28 86l22-24 18 18 14-12 18 18z" fill="#3186ff"/>`,
  'sub-meter': `<rect x="24" y="52" width="80" height="24" rx="6" fill="#0d1424" stroke="#475978" stroke-width="4"/><rect x="28" y="56" width="48" height="16" rx="3" fill="#3186ff"/><path d="M64 30v10M42 36l6 8M86 36l-6 8" stroke="#38bdf8" stroke-width="5" stroke-linecap="round"/>`,
  'context-meter': `<rect x="30" y="24" width="68" height="80" rx="8" fill="#0d1424" stroke="#dce8ff" stroke-width="5"/><rect x="40" y="78" width="48" height="14" rx="2" fill="#34d399"/><rect x="40" y="58" width="48" height="14" rx="2" fill="#60a5fa"/><rect x="40" y="38" width="48" height="14" rx="2" fill="#3186ff"/>`,
  'commit': `<circle cx="44" cy="40" r="10" fill="#3186ff"/><circle cx="44" cy="88" r="10" fill="#38bdf8"/><circle cx="86" cy="64" r="10" fill="#dce8ff"/><path d="M44 50v28M54 40h14c10 0 18 8 18 18v6" fill="none" stroke="#7aa2f7" stroke-width="6" stroke-linecap="round"/>`,
  'narrator': `<path d="M28 52h16l20-18v60L44 76H28z" fill="#dce8ff"/><path d="M76 48c8 8 8 24 0 32M88 36c16 16 16 40 0 56" fill="none" stroke="#3186ff" stroke-width="6" stroke-linecap="round"/>`,
  'time-machine': `<circle cx="66" cy="64" r="36" fill="none" stroke="#dce8ff" stroke-width="6"/><path d="M30 44v20h20" fill="none" stroke="#38bdf8" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/><path d="M66 44v22l16 10" fill="none" stroke="#3186ff" stroke-width="6" stroke-linecap="round"/>`,
  'after': `<rect x="26" y="32" width="76" height="16" rx="4" fill="#3186ff"/><rect x="26" y="56" width="60" height="16" rx="4" fill="#60a5fa"/><rect x="26" y="80" width="44" height="16" rx="4" fill="#334666"/>`,
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

if (!fs.existsSync(PLUGINS_DIR)) process.exit(0)
const entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name)
  .sort()

for (const name of entries) {
  const pRoot = path.join(PLUGINS_DIR, name)
  const libDir = path.join(pRoot, 'scripts', 'lib')
  fs.mkdirSync(libDir, { recursive: true })
  for (const file of SHARED_FILES) {
    const src = path.join(SHARED_DIR, file)
    const dst = path.join(libDir, file)
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst)
      if (file.endsWith('.mjs') || file.endsWith('.sh')) fs.chmodSync(dst, 0o755)
    }
  }

  // Ensure all scripts/*.mjs are 0755
  const scriptsDir = path.join(pRoot, 'scripts')
  if (fs.existsSync(scriptsDir)) {
    for (const f of fs.readdirSync(scriptsDir)) {
      const full = path.join(scriptsDir, f)
      if (fs.statSync(full).isFile() && (f.endsWith('.mjs') || f.endsWith('.sh') || f.endsWith('.py'))) {
        fs.chmodSync(full, 0o755)
      }
    }
  }

  // Ensure assets/logo.svg exists
  const assetsDir = path.join(pRoot, 'assets')
  fs.mkdirSync(assetsDir, { recursive: true })
  const logoPath = path.join(assetsDir, 'logo.svg')
  if (ICONS[name]) {
    fs.writeFileSync(logoPath, makeSvg(ICONS[name]), 'utf8')
  }
}

// Keep scripts/better-statusline.mjs synced with shared/better-statusline.mjs so they never drift
const sharedSl = path.join(SHARED_DIR, 'better-statusline.mjs')
const scriptsSl = path.join(ROOT, 'scripts', 'better-statusline.mjs')
if (fs.existsSync(sharedSl)) {
  fs.copyFileSync(sharedSl, scriptsSl)
  fs.chmodSync(scriptsSl, 0o755)
}

// Also precompile local scripts/better-statusline (gitignored) when a C compiler exists
const srcC = path.join(SHARED_DIR, 'better-statusline.c')
const localBin = path.join(ROOT, 'scripts', 'better-statusline')
if (fs.existsSync(srcC) && process.platform !== 'win32') {
  for (const cc of ['gcc', 'cc', 'clang']) {
    const r = spawnSync(cc, ['-O3', srcC, '-o', localBin, '-lm'], { stdio: 'ignore' })
    if (r.status === 0) {
      fs.chmodSync(localBin, 0o755)
      break
    }
  }
}

console.log(`Synced shared libs and icons across ${entries.length} plugins: ${entries.join(', ')}`)
