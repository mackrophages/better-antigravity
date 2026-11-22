#!/usr/bin/env node
// Runs `agy plugin validate --strict` on every plugin inside plugins/*.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGINS_DIR = path.join(ROOT, 'plugins')

const plugins = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name)
  .sort()

let failed = 0
for (const name of plugins) {
  const target = path.join(PLUGINS_DIR, name)
  const res = spawnSync('agy', ['plugin', 'validate', '--strict', target], { encoding: 'utf8' })
  process.stdout.write(res.stdout || '')
  process.stderr.write(res.stderr || '')
  if (res.status !== 0) failed++
}

if (failed > 0) {
  console.error(`\nValidation failed on ${failed} of ${plugins.length} plugins.`)
  process.exit(1)
}
console.log(`\nAll ${plugins.length} plugins passed agy plugin validate --strict!`)
