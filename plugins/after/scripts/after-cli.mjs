#!/usr/bin/env node
// CLI for /after and /before (atomic file-locked updates across Antigravity skills and external terminals).
import path from 'node:path'
import { repoKey, updateState } from './lib/store.mjs'
import { normalizeState, renderCard, runCommandOnState } from './core/queue-engine.mjs'

let cwd = process.cwd()
const raw = process.argv.slice(2)
const rest = []
for (let i = 0; i < raw.length; i++) {
  if (raw[i] === '--cwd' && raw[i + 1]) {
    cwd = path.resolve(raw[++i])
  } else {
    rest.push(raw[i])
  }
}

let command = 'after'
if (rest[0] === 'after' || rest[0] === 'before') {
  command = rest.shift()
}
const argText = rest.join(' ').trim()

const qPath = `after/${repoKey(cwd)}.json`
let result = null
updateState(qPath, null, (curr) => {
  const normalized = normalizeState(curr, { cwd })
  result = runCommandOnState(normalized, command, argText, Date.now())
  return result.state
})
console.log(renderCard(result))
