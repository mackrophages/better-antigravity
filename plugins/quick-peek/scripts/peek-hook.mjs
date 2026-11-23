#!/usr/bin/env node
// PostInvocation hook: when `autoCard: true`, appends a zero-token user_markdown
// Quick Peek summary card using an O(1) tail read of transcript.jsonl.
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

const [{ readLatestAnswerTail }, { languageOf, pathsIn, resolvePath }] = await Promise.all([
  import('./lib/transcript.mjs'),
  import('./core/peek-engine.mjs')
])

const cwd = payload.cwd || payload.workspacePaths?.[0] || process.cwd()
const answer = readLatestAnswerTail(payload.transcriptPath)
if (!answer) {
  process.stdout.write('{}\n')
  process.exit(0)
}

const found = pathsIn(answer)
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
  const safeUri = encodeURI(resolved).replace(/[#?()]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
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
