#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  getPluginConfig,
  isHeadless,
  isSubcall,
  readStdinJson,
  updateState
} from './lib/store.mjs'
import { cleanUserRequest } from './lib/transcript.mjs'

if (isSubcall()) {
  process.stdout.write('{}\n')
  process.exit(0)
}

const here = path.dirname(fileURLToPath(import.meta.url))
const mode = process.argv[2] || 'pre'
const payload = await readStdinJson()
const sid = payload.conversationId

if (mode === 'stop') {
  if (sid) {
    updateState(`turn-flags/${sid}.json`, {}, prev => ({ ...prev, useHydrogen: false }))
  }
  process.stdout.write('{}\n')
  process.exit(0)
}

const input = cleanUserRequest(String(payload.lastUserInput || ''))
// Exact upstream rule: `_summarize` is marked; `__init__.py` or lone `_` is NOT.
const isMarked = input.startsWith('_') && !input.startsWith('__') && input.slice(1).trim().length > 0
const isFirstStep = payload.invocationNum === undefined || payload.invocationNum === 0

if (!isMarked || !isFirstStep) {
  if (sid && isFirstStep) {
    updateState(`turn-flags/${sid}.json`, {}, prev => ({ ...prev, useHydrogen: false }))
  }
  process.stdout.write('{}\n')
  process.exit(0)
}

if (sid) {
  updateState(`turn-flags/${sid}.json`, {}, prev => ({ ...prev, useHydrogen: true }))
}

const cfg = getPluginConfig('use-hydrogen', { model: 'gemini-4-hydrogen-high' })
const hydrogenModel = cfg.model || 'gemini-4-hydrogen-high'
const cliPath = path.join(here, 'use-hydrogen-cli.mjs')
const cleanTask = input.slice(1).trimStart()

const sysText =
  `USE HYDROGEN MODE (_ prefix detected): Strip the leading '_' and execute the user's request on Gemini 4 Hydrogen (${hydrogenModel}) ` +
  `by running \`node ${JSON.stringify(cliPath)} run ${JSON.stringify(cleanTask)}\` via run_command, ` +
  `then output its response (keeping the verified "Answered by ${hydrogenModel}" footer in interactive sessions) without re-solving the task on your main session model.`

const step = isHeadless()
  ? { systemMessage: { systemMessage: sysText } }
  : {
      systemMessage: {
        systemMessage: sysText,
        metadata: {
          user_markdown: `⚡ **Use Hydrogen (\`_\`)** · Routing this turn to \`${hydrogenModel}\``
        }
      }
    }

process.stdout.write(JSON.stringify({ injectSteps: [step] }) + '\n')
