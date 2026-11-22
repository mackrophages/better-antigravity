#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getPluginConfig, setPluginConfig, ensureStatusLineInstalled } from './lib/store.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const [cmd = 'status', val = ''] = process.argv.slice(2)

if (cmd === 'warn' || cmd === 'danger') {
  const n = Number(val)
  if (!Number.isFinite(n) || n < 5 || n > 99) {
    console.error(`Usage: context-meter-cli.mjs ${cmd} <5..99>`)
    process.exit(1)
  }
  const key = cmd === 'warn' ? 'warnAt' : 'dangerAt'
  const next = setPluginConfig('context-meter', { [key]: Math.round(n) })
  console.log(`Context Meter updated: warnAt=${next.warnAt ?? 50}%, dangerAt=${next.dangerAt ?? 75}%`)
  process.exit(0)
}

if (cmd === 'setup') {
  const res = ensureStatusLineInstalled(path.join(here, 'lib', 'better-statusline.mjs'), { force: true })
  console.log(`Context Meter statusLine configured: ${res.targetScript}`)
  process.exit(0)
}

const cfg = getPluginConfig('context-meter', { warnAt: 50, dangerAt: 75, inlineAlert: true })
console.log(`Context Meter · dim < ${cfg.warnAt}% · yellow >= ${cfg.warnAt}% (/compact) · red >= ${cfg.dangerAt}% (new session)`)
