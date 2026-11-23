#!/usr/bin/env node
// Antigravity lifecycle hooks for After:
// - session-start: ensures statusLine is installed
// - pre-invocation: marks workspace queue busy under exclusive file lock
// - stop: atomically archives finished task and dequeues next FIFO item under exclusive file lock
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ensureStatusLineInstalled,
  isSubcall,
  readStdinJson,
  readState,
  repoKey,
  updateState
} from './lib/store.mjs'
import { markIdle, normalizeState, takeNext } from './core/queue-engine.mjs'

if (isSubcall()) {
  process.stdout.write('{}\n')
  process.exit(0)
}

const here = path.dirname(fileURLToPath(import.meta.url))
const event = process.argv[2] || ''
const payload = await readStdinJson()
const cwd = payload.cwd || payload.workspacePaths?.[0] || process.cwd()
const qPath = `after/${repoKey(cwd)}.json`

if (event === 'session-start') {
  try { ensureStatusLineInstalled(path.join(here, 'lib', 'better-statusline.mjs'), { preferNative: true }) } catch {}
  process.stdout.write('{}\n')
  process.exit(0)
}

if (event === 'pre-invocation') {
  if (readState(qPath, null) !== null) {
    updateState(qPath, null, (curr) => {
      if (!curr) return normalizeState(null, { cwd })
      const st = normalizeState(curr, { cwd })
      return st.busy ? st : { ...st, busy: true }
    })
  }
  process.stdout.write('{}\n')
  process.exit(0)
}

if (event === 'stop') {
  if (payload.fullyIdle === false) {
    process.stdout.write('{}\n')
    process.exit(0)
  }

  if (readState(qPath, null) === null) {
    process.stdout.write('{}\n')
    process.exit(0)
  }

  const reason = String(payload.terminationReason || '')
  const aborted = ['ERROR', 'USER_CANCELED', 'MAX_INVOCATIONS', 'MAX_FORCED_INVOCATIONS', 'MAX_TOKEN_BUDGET_EXCEEDED', 'error'].includes(reason)
  const lastInput = String(payload.lastUserInput || '')

  let poppedItem = null
  let remainingCount = 0

  updateState(qPath, null, (curr) => {
    let st = normalizeState(curr, { cwd })
    st = markIdle(st, { status: aborted ? 'stopped' : 'done' })
    const justManagedQueue = /^\s*\/(?:after|before)\b/i.test(lastInput) && st.paused
    if (aborted || st.paused || justManagedQueue || st.items.length === 0) {
      poppedItem = null
      remainingCount = st.items.length
      return st
    }
    const { state: nextState, item } = takeNext(st)
    poppedItem = item
    remainingCount = nextState.items.length
    return nextState
  })

  if (!poppedItem) {
    process.stdout.write('{}\n')
    process.exit(0)
  }

  const tail = remainingCount > 0 ? ` (${remainingCount} more queued behind this)` : ''
  process.stdout.write(JSON.stringify({
    decision: 'continue',
    reason: `[After Queue -> Next Task #${poppedItem.id}${tail}]: ${poppedItem.text}`
  }) + '\n')
  process.exit(0)
}

process.stdout.write('{}\n')
