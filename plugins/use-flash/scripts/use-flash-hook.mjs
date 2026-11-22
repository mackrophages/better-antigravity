#!/usr/bin/env node
import { isHeadless, readStdinJson, updateState } from './lib/store.mjs'
import { cleanUserRequest } from './lib/transcript.mjs'

const mode = process.argv[2] || 'pre'
const payload = await readStdinJson()
const sid = payload.conversationId

if (mode === 'stop') {
  if (sid) {
    updateState(`turn-flags/${sid}.json`, {}, prev => ({ ...prev, useFlash: false }))
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
    updateState(`turn-flags/${sid}.json`, {}, prev => ({ ...prev, useFlash: false }))
  }
  process.stdout.write('{}\n')
  process.exit(0)
}

if (sid) {
  updateState(`turn-flags/${sid}.json`, {}, prev => ({ ...prev, useFlash: true }))
}

const cleanTask = input.slice(1).trimStart()
const sysText =
  `USE FLASH MODE (_ prefix detected): Strip the leading '_' and treat the user's request as: "${cleanTask}". ` +
  `For multi-step or file-reading work, delegate immediately to invoke_subagent with TypeName="flash-runner" and Model="flash" so Flash handles the heavy token work; for trivial in-context questions, answer directly and concisely.`

const step = isHeadless()
  ? { systemMessage: { systemMessage: sysText } }
  : {
      systemMessage: {
        systemMessage: sysText,
        metadata: {
          user_markdown: '⚡ **Use Flash (`_`)** · Fast Flash mode active for this turn'
        }
      }
    }

process.stdout.write(JSON.stringify({ injectSteps: [step] }) + '\n')
