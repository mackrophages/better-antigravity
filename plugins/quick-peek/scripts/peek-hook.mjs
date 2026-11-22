#!/usr/bin/env node
// PostInvocation hook: when `autoCard: true`, appends a zero-token user_markdown
// Quick Peek summary card for existing local paths mentioned in the assistant's reply.
import fs from 'node:fs'
import path from 'node:path'
import { getPluginConfig, isHeadless, readStdinJson } from './lib/store.mjs'
import { summarizeTranscript } from './lib/transcript.mjs'
import { languageOf, pathsIn, resolvePath } from './core/peek-engine.mjs'

const payload = await readStdinJson()
const cfg = getPluginConfig('quick-peek', { autoCard: false })
if (isHeadless() || !cfg.autoCard || !payload.transcriptPath) {
  process.stdout.write('{}\n')
  process.exit(0)
}

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
  if (!resolved || seen.has(resolved) || !fs.existsSync(resolved)) continue
  seen.add(resolved)
  try {
    const st = fs.statSync(resolved)
    const kb = st.isDirectory() ? 'folder' : st.size < 1024 ? `${st.size} B` : `${(st.size / 1024).toFixed(1)} KB`
    const lang = st.isDirectory() ? 'Directory' : (languageOf(resolved)?.name || path.extname(resolved).slice(1).toUpperCase() || 'File')
    const linePart = c.line ? `#L${c.line}` : ''
    items.push(`- [${path.basename(resolved)}${c.line ? `:${c.line}` : ''}](file://${resolved}${linePart}) · ${lang} · ${kb}`)
  } catch {}
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
