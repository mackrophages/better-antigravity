#!/usr/bin/env node
// Runs `agy plugin validate --strict` concurrently across requested (or all) plugins inside plugins/*.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGINS_DIR = path.join(ROOT, 'plugins')

const requested = process.argv.slice(2).filter(Boolean)
const plugins = requested.length > 0
  ? requested
  : fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort()

function validateOne (name) {
  return new Promise((resolve) => {
    const target = path.join(PLUGINS_DIR, name)
    const proc = spawn('agy', ['plugin', 'validate', '--strict', target], { stdio: ['ignore', 'pipe', 'pipe'] })
    const out = []
    const err = []
    const timer = setTimeout(() => { proc.kill('SIGKILL') }, 30_000)
    proc.stdout.on('data', b => out.push(b))
    proc.stderr.on('data', b => err.push(b))
    proc.on('error', e => {
      clearTimeout(timer)
      resolve({ name, status: 1, stdout: '', stderr: String(e) })
    })
    proc.on('close', code => {
      clearTimeout(timer)
      resolve({
        name,
        status: code ?? 1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8')
      })
    })
  })
}

const concurrency = Math.max(2, Math.min(plugins.length, os.availableParallelism ? os.availableParallelism() : 4))
const results = new Array(plugins.length)
let cursor = 0

async function worker () {
  while (cursor < plugins.length) {
    const idx = cursor++
    results[idx] = await validateOne(plugins[idx])
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()))

let failed = 0
for (const res of results) {
  process.stdout.write(res.stdout)
  process.stderr.write(res.stderr)
  if (res.status !== 0) failed++
}

if (failed > 0) {
  console.error(`\nValidation failed on ${failed} of ${plugins.length} plugins.`)
  process.exit(1)
}
console.log(`\nAll ${plugins.length} plugins passed agy plugin validate --strict!`)
