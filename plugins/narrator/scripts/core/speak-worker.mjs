#!/usr/bin/env node
// Detached worker that acquires an atomic O_EXCL seat lock inside private 0700 stateRoot()
// (never world-writable /tmp) and runs the system TTS synthesizer.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { isProcessAlive, sleepSyncMs, stateRoot, updateState } from '../lib/store.mjs'
import { buildSpeakCommand } from './speaker.mjs'

let payload
try {
  payload = JSON.parse(process.env.NARRATOR_PAYLOAD || '{}')
} catch {
  process.exit(0)
}

const spec = buildSpeakCommand(payload.synth, payload)
if (!spec) process.exit(0)

const root = stateRoot()
fs.mkdirSync(root, { recursive: true, mode: 0o700 })
const seatPath = path.join(root, 'narrator-seat.lock')
const token = `${process.pid}:${crypto.randomBytes(4).toString('hex')}`
let acquired = false
let emptyRetries = 0

// Bounded wait by iteration count (never Date.now(), safe under Termux proot clock jumps)
for (let i = 0; i < 60; i++) {
  try {
    const fd = fs.openSync(seatPath, 'wx', 0o600)
    try {
      fs.writeSync(fd, `${token}\n`)
    } finally {
      fs.closeSync(fd)
    }
    acquired = true
    break
  } catch (err) {
    if (err?.code !== 'EEXIST') break
    try {
      const raw = fs.readFileSync(seatPath, 'utf8').trim()
      if (!raw) {
        emptyRetries++
        if (emptyRetries > 8) {
          try { fs.unlinkSync(seatPath) } catch {}
          emptyRetries = 0
          continue
        }
      } else {
        emptyRetries = 0
        const holder = Number(raw.split(':')[0])
        if (holder > 0 && holder !== process.pid && !isProcessAlive(holder)) {
          try { fs.unlinkSync(seatPath) } catch {}
          continue
        }
      }
    } catch {}
    sleepSyncMs(250)
  }
}

try {
  spawnSync(spec.cmd, spec.args, {
    stdio: 'ignore',
    timeout: 90_000,
    env: spec.env ? { ...process.env, ...spec.env } : process.env
  })
} finally {
  if (acquired) {
    try {
      if (fs.readFileSync(seatPath, 'utf8').trim() === token) {
        fs.unlinkSync(seatPath)
      }
    } catch {}
  }
  updateState('narrator-runtime.json', {}, (rt) => {
    if (rt?.speakingPid === process.pid) {
      return { ...rt, speakingPid: null, endedAt: Date.now() }
    }
    return rt || {}
  })
}
