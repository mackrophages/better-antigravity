#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getPluginConfig, setPluginConfig, ensureStatusLineInstalled, shortWindowLabel, stateRoot } from './lib/store.mjs'

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

if (cmd === 'window') {
  if (val.toLowerCase() === 'auto' || val === '0') {
    setPluginConfig('context-meter', { windowTokens: 0 })
    console.log('Context Meter window size set to automatic per-model detection.')
    process.exit(0)
  }
  const n = Number(val)
  if (!Number.isFinite(n) || n < 4096 || n > 10_000_000) {
    console.error('Usage: context-meter-cli.mjs window <auto|4096..10000000>')
    process.exit(1)
  }
  const next = setPluginConfig('context-meter', { windowTokens: Math.round(n) })
  console.log(`Context Meter window override set to ${shortWindowLabel(next.windowTokens)} (${next.windowTokens} tokens).`)
  process.exit(0)
}

if (cmd === 'setup') {
  const res = ensureStatusLineInstalled(path.join(here, 'lib', 'better-statusline.mjs'), { force: true, preferNative: true })
  console.log(`Context Meter statusLine configured: ${res.targetScript}`)
  process.exit(0)
}

const cfg = getPluginConfig('context-meter', { warnAt: 50, dangerAt: 75, inlineAlert: true, windowTokens: 0 })
const modeNote = Number(cfg.windowTokens) > 0 ? `override ${shortWindowLabel(cfg.windowTokens)}` : 'auto per-model (✦ Gemini 1M · ✻ Claude 200k · ❂ GPT 128k)'
console.log(`Context Meter · window: ${modeNote} · dim < ${cfg.warnAt}% · yellow >= ${cfg.warnAt}% (/compact) · red >= ${cfg.dangerAt}% (new session)`)

const cwDir = path.join(stateRoot(), 'context-windows')
if (fs.existsSync(cwDir)) {
  const models = fs.readdirSync(cwDir)
    .filter(f => f.startsWith('model-') && f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(cwDir, f), 'utf8')) } catch { return null }
    })
    .filter(m => m?.model && m?.windowTokens > 0)
    .sort((a, b) => a.model.localeCompare(b.model))
  if (models.length > 0) {
    console.log('Detected model windows:')
    for (const m of models) {
      const icon = m.family === 'claude' ? '✻' : (m.family === 'gpt' ? '❂' : '✦')
      console.log(`  ${icon} ${m.model.padEnd(28)} ${shortWindowLabel(m.windowTokens)} (${m.windowTokens.toLocaleString('en-US')} tokens)`)
    }
  }
}
