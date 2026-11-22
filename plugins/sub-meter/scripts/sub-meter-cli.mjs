#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  getPluginConfig,
  setPluginConfig,
  readState,
  formatUntilSeconds,
  ensureStatusLineInstalled
} from './lib/store.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const [cmd = 'status', arg = ''] = process.argv.slice(2)

if (cmd === 'mode') {
  const mode = arg.toLowerCase()
  if (!['rotate', 'both', 'session', 'week'].includes(mode)) {
    console.error('Usage: sub-meter-cli.mjs mode <rotate|both|session|week>')
    process.exit(1)
  }
  const cfg = setPluginConfig('sub-meter', { display: mode })
  console.log(`Sub Meter display mode set to "${cfg.display}".`)
  process.exit(0)
}

if (cmd === 'rotate') {
  const sec = Number(arg)
  if (!Number.isFinite(sec) || sec < 2) {
    console.error('Usage: sub-meter-cli.mjs rotate <seconds>=2..120')
    process.exit(1)
  }
  const cfg = setPluginConfig('sub-meter', { rotateSeconds: Math.round(sec) })
  console.log(`Sub Meter rotation interval set to ${cfg.rotateSeconds}s.`)
  process.exit(0)
}

if (cmd === 'setup') {
  const res = ensureStatusLineInstalled(path.join(here, 'lib', 'better-statusline.mjs'), { force: true })
  console.log(`Sub Meter statusLine configured: ${res.targetScript}`)
  process.exit(0)
}

const cfg = getPluginConfig('sub-meter', { display: 'rotate', rotateSeconds: 8 })
const cached = readState('quota-cache.json', null)
console.log(`Sub Meter · mode: ${cfg.display} · rotate: ${cfg.rotateSeconds}s`)
if (!cached?.buckets?.length) {
  console.log('No quota windows recorded yet in this profile (will populate automatically from the CLI statusLine payload).')
} else {
  for (const b of cached.buckets) {
    const pct = Math.round(b.percentUsed)
    const filled = Math.round((Math.min(Math.max(b.percentUsed, 0), 100) / 100) * 10)
    const bar = `${'━'.repeat(filled)}${'─'.repeat(10 - filled)}`
    const rst = b.resetSec > 0 ? ` · resets in ${formatUntilSeconds(b.resetSec)}` : ''
    console.log(`  ${b.label.padEnd(10)} ${bar}  ${pct}% used${rst}`)
  }
}
