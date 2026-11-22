#!/usr/bin/env node
// Idempotent SessionStart hook for HUD plugins: installs/updates better-statusline.mjs
// and wires ~/.gemini/antigravity-cli/settings.json if no custom statusLine is set.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureStatusLineInstalled, readStdinJson } from './store.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
await readStdinJson()
try {
  ensureStatusLineInstalled(path.join(here, 'better-statusline.mjs'))
} catch {}
process.stdout.write('{}\n')
