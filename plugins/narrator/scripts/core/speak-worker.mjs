#!/usr/bin/env node
// Detached worker that acquires a cross-window ticket lock in /tmp and runs the synthesizer.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { readState, writeState } from '../lib/store.mjs'
import { buildSpeakCommand } from './speaker.mjs'

let payload
try {
  payload = JSON.parse(process.env.NARRATOR_PAYLOAD || '{}')
} catch {
  process.exit(0)
}

const spec = buildSpeakCommand(payload.synth, payload)
if (!spec) process.exit(0)

const lockDir = path.join(os.tmpdir(), `agy-narrator-queue-${process.getuid ? process.getuid() : '0'}`)
fs.mkdirSync(lockDir, { recursive: true })
const seatPath = path.join(lockDir, 'seat.pid')

// Bounded wait by iteration count (never Date.now(), safe under Termux proot clock jumps!)
for (let i = 0; i < 60; i++) {
  try {
    const holder = Number(fs.readFileSync(seatPath, 'utf8').trim())
    if (holder && holder !== process.pid) {
      process.kill(holder, 0)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)
      continue
    }
  } catch {}
  try {
    fs.writeFileSync(seatPath, String(process.pid), 'utf8')
    break
  } catch {
    break
  }
}

try {
  spawnSync(spec.cmd, spec.args, {
    stdio: 'ignore',
    timeout: 90_000,
    env: spec.env ? { ...process.env, ...spec.env } : process.env
  })
} finally {
  try {
    if (fs.readFileSync(seatPath, 'utf8').trim() === String(process.pid)) {
      fs.unlinkSync(seatPath)
    }
  } catch {}
  const rt = readState('narrator-runtime.json', {})
  if (rt?.speakingPid === process.pid) {
    writeState('narrator-runtime.json', { ...rt, speakingPid: null, endedAt: Date.now() })
  }
}
