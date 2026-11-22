#!/usr/bin/env node
// Installs or removes the unified Better Antigravity CLI statusLine in settings.json.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  agyCliSettingsPath,
  ensureStatusLineInstalled,
  homeDir,
  readJsonFile,
  writeJsonAtomic
} from '../shared/store.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mode = process.argv[2] || 'install'

if (mode === 'uninstall' || mode === '--uninstall') {
  const settingsFile = agyCliSettingsPath()
  const settings = readJsonFile(settingsFile, null)
  if (settings?.statusLine?.command?.includes('better-statusline')) {
    delete settings.statusLine
    writeJsonAtomic(settingsFile, settings)
    console.log(`Removed better-statusline entry from ${settingsFile}`)
  }
  for (const name of ['better-statusline.mjs', 'better-statusline']) {
    const f = path.join(homeDir(), '.gemini', 'antigravity-cli', name)
    if (fs.existsSync(f)) {
      fs.unlinkSync(f)
      console.log(`Removed ${f}`)
    }
  }
  process.exit(0)
}

const res = ensureStatusLineInstalled(path.join(ROOT, 'scripts', 'better-statusline.mjs'), {
  force: true,
  preferNative: true
})
console.log(`Better Antigravity statusLine ready: ${res.targetScript} (native=${Boolean(res.native)}, updatedSettings=${Boolean(res.updatedSettings)})`)
