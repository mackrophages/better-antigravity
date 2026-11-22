#!/usr/bin/env node
// Antigravity lifecycle hooks for After:
// - session-start: ensures statusLine is installed
// - pre-invocation: marks workspace queue busy while a turn runs
// - stop: archives finished task and, when unpaused with pending items, returns
//         {"decision": "continue", "reason": "..."} so queued tasks run in FIFO order!
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ensureStatusLineInstalled,
  readStdinJson,
  readState,
  repoKey,
  writeState
} from './lib/store.mjs'
import { markIdle, normalizeState, takeNext } from './core/queue-engine.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const event = process.argv[2] || ''
const payload = await readStdinJson()
const cwd = payload.cwd || payload.workspacePaths?.[0] || process.cwd()
const qPath = `after/${repoKey(cwd)}.json`

if (event === 'session-start') {
  try { ensureStatusLineInstalled(path.join(here, 'lib', 'better-statusline.mjs')) } catch {}
  process.stdout.write('{}\n')
  process.exit(0)
}

if (event === 'pre-invocation') {
  const existing = readState(qPath, null)
  if (existing) {
    const st = normalizeState(existing, { cwd })
    if (!st.busy) writeState(qPath, { ...st, busy: true })
  }
  process.stdout.write('{}\n')
  process.exit(0)
}

if (event === 'stop') {
  if (payload.fullyIdle === false) {
    process.stdout.write('{}\n')
    process.exit(0)
  }

  const raw = readState(qPath, null)
  if (!raw) {
    process.stdout.write('{}\n')
    process.exit(0)
  }

  const reason = String(payload.terminationReason || '')
  const aborted = ['ERROR', 'USER_CANCELED', 'MAX_INVOCATIONS', 'MAX_FORCED_INVOCATIONS', 'MAX_TOKEN_BUDGET_EXCEEDED', 'error'].includes(reason)

  let st = normalizeState(raw, { cwd })
  st = markIdle(st, { status: aborted ? 'stopped' : 'done' })

  // Do not pop a task right when the user just ran `/after pause` or if aborted
  const lastInput = String(payload.lastUserInput || '')
  const justManagedQueue = /^\s*\/(?:after|before)\b/i.test(lastInput) && st.paused

  if (aborted || st.paused || justManagedQueue || st.items.length === 0) {
    writeState(qPath, st)
    process.stdout.write('{}\n')
    process.exit(0)
  }

  const { state: nextState, item } = takeNext(st)
  writeState(qPath, nextState)
  if (!item) {
    process.stdout.write('{}\n')
    process.exit(0)
  }

  const remaining = nextState.items.length
  const tail = remaining > 0 ? ` (${remaining} more queued behind this)` : ''
  process.stdout.write(JSON.stringify({
    decision: 'continue',
    reason: `[After Queue -> Next Task #${item.id}${tail}]: ${item.text}`
  }) + '\n')
  process.exit(0)
}

process.stdout.write('{}\n')
