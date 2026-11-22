#!/usr/bin/env node
// Idempotent SessionStart hook for HUD plugins: installs/updates better-statusline.mjs
// and wires ~/.gemini/antigravity-cli/settings.json if no custom statusLine is set.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureStatusLineInstalled, stateRoot } from './store.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
try {
  const res = ensureStatusLineInstalled(path.join(here, 'better-statusline.mjs'), { preferNative: true })
  if (res.installed) {
    const flag = path.join(stateRoot(), '.hud-ready')
    fs.mkdirSync(path.dirname(flag), { recursive: true })
    fs.writeFileSync(flag, '1\n')
  }
} catch {}
process.stdout.write('{}\n')
