#!/usr/bin/env node
// Idempotent SessionStart hook for HUD plugins: installs/updates better-statusline(.mjs)
// and wires ~/.gemini/antigravity-cli/settings.json if no custom statusLine is set.
// Note: ensureStatusLineInstalled writes the exact mode ('native', 'node', or 'custom')
// into .hud-ready so hook-gate.sh fast-exits on subsequent SessionStart invocations.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureStatusLineInstalled } from './store.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
try {
  ensureStatusLineInstalled(path.join(here, 'better-statusline.mjs'), { preferNative: true })
} catch {}
process.stdout.write('{}\n')
