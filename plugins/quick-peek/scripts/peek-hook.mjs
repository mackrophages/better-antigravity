#!/usr/bin/env node
// PostInvocation hook: when `autoCard: true`, appends a zero-token user_markdown
// Quick Peek summary card. Uses lazy imports so disabled mode skips loading grammars.
import fs from 'node:fs'
import path from 'node:path'
import { getPluginConfig, isHeadless, isSubcall, readStdinJson } from './lib/store.mjs'

if (isSubcall() || isHeadless()) {
  process.stdout.write('{}\n')
  process.exit(0)
}

const cfg = getPluginConfig('quick-peek', { autoCard: false })
if (!cfg.autoCard) {
  process.stdout.write('{}\n')
  process.exit(0)
}

const payload = await readStdinJson()
if (!payload.transcriptPath) {
  process.stdout.write('{}\n')
  process.exit(0)
}

const [{ summarizeTranscript }, { languageOf, pathsIn, resolvePath }] = await Promise.all([
  import('./lib/transcript.mjs'),
  import('./core/peek-engine.mjs')
])

const cwd = payload.cwd || payload.workspacePaths?.[0] || process.cwd()
const sum = summarizeTranscript(payload.transcriptPath)
if (!sum.answer) {
  process.stdout.write('{}\n')
  process.exit(0)
}

const found = pathsIn(sum.answer)
const items = []
const seen = new Set()
for (const c of found) {
  const resolved = resolvePath(c.target, cwd)
  if (!resolved || seen.has(resolved)) continue
  const st = fs.statSync(resolved, { throwIfNoEntry: false })
  if (!st) continue
  seen.add(resolved)
  const kb = st.isDirectory() ? 'folder' : st.size < 1024 ? `${st.size} B` : `${(st.size / 1024).toFixed(1)} KB`
  const lang = st.isDirectory() ? 'Directory' : (languageOf(resolved)?.name || path.extname(resolved).slice(1).toUpperCase() || 'File')
  const linePart = c.line ? `#L${c.line}` : ''
  const safeLabel = `${path.basename(resolved)}${c.line ? `:${c.line}` : ''}`.replace(/[[\]]/g, '\\$&')
  const safeUri = encodeURI(resolved).replace(/[()]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
  items.push(`- [${safeLabel}](file://${safeUri}${linePart}) · ${lang} · ${kb}`)
  if (items.length >= 6) break
}

if (items.length === 0) {
  process.stdout.write('{}\n')
  process.exit(0)
}

process.stdout.write(JSON.stringify({
  injectSteps: [
    {
      systemMessage: {
        systemMessage: '',
        metadata: {
          user_markdown: `**Quick Peek**\n${items.join('\n')}`
        }
      }
    }
  ]
}) + '\n')
