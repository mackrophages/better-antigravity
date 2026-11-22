#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stateRoot, shortTokens, ensureStatusLineInstalled } from './lib/store.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const [cmd = 'status'] = process.argv.slice(2)

if (cmd === 'setup') {
  const res = ensureStatusLineInstalled(path.join(here, 'lib', 'better-statusline.mjs'), { force: true })
  console.log(`Token Meter statusLine configured: ${res.targetScript}`)
  process.exit(0)
}

const dir = path.join(stateRoot(), 'tokens')
const entries = fs.existsSync(dir)
  ? fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) } catch { return null }
    })
    .filter(Boolean)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  : []

if (entries.length === 0) {
  console.log('Token Meter · no recorded turns yet (updates automatically on the CLI statusLine and after each turn).')
  process.exit(0)
}

if (cmd === 'history') {
  console.log('Token Meter · Recent sessions:')
  for (const e of entries.slice(0, 10)) {
    console.log(
      `  ${String(e.conversationId).slice(0, 8)}  turns:${e.turnCount || 1}  ` +
      `last ↑ ${shortTokens(e.last?.input)} ↓ ${shortTokens(e.last?.output)} cache ${shortTokens(e.last?.cached)}  ·  ` +
      `session ↑ ${shortTokens(e.session?.input)} ↓ ${shortTokens(e.session?.output)}`
    )
  }
  process.exit(0)
}

const latest = entries[0]
console.log(
  `Token Meter (${String(latest.conversationId).slice(0, 8)}) · ` +
  `↑ ${shortTokens(latest.last?.input)}  ↓ ${shortTokens(latest.last?.output)}  cache ${shortTokens(latest.last?.cached)}  ·  ` +
  `session ↑ ${shortTokens(latest.session?.input)}  ↓ ${shortTokens(latest.session?.output)}`
)
