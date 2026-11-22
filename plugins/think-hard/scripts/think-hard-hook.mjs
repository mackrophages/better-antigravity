#!/usr/bin/env node
import { isHeadless, isSubcall, readStdinJson, updateState } from './lib/store.mjs'
import { cleanUserRequest } from './lib/transcript.mjs'

if (isSubcall()) {
  process.stdout.write('{}\n')
  process.exit(0)
}

const mode = process.argv[2] || 'pre'
const payload = await readStdinJson()
const sid = payload.conversationId

if (mode === 'stop') {
  if (sid) {
    updateState(`turn-flags/${sid}.json`, {}, prev => ({ ...prev, thinkHard: false }))
  }
  process.stdout.write('{}\n')
  process.exit(0)
}

// PreInvocation: only fire on the initial invocation of a user turn (invocationNum === 0)
const input = cleanUserRequest(String(payload.lastUserInput || ''))
const isMarked = input.startsWith('+') && !input.startsWith('++') && input.slice(1).trim().length > 0
const isFirstStep = payload.invocationNum === undefined || payload.invocationNum === 0

if (!isMarked || !isFirstStep) {
  if (sid && isFirstStep) {
    updateState(`turn-flags/${sid}.json`, {}, prev => ({ ...prev, thinkHard: false }))
  }
  process.stdout.write('{}\n')
  process.exit(0)
}

if (sid) {
  updateState(`turn-flags/${sid}.json`, {}, prev => ({ ...prev, thinkHard: true }))
}

const cleanTask = input.slice(1).trimStart()
const sysText =
  `THINK HARD MODE (+ prefix detected): The user prefixed this prompt with '+' to request maximum reasoning depth for this turn only. ` +
  `Interpret the prompt as: "${cleanTask}". ` +
  `Before acting or answering, perform exhaustive first-principles analysis, check edge cases and failure modes, and verify every claim in the workspace.`

const step = isHeadless()
  ? { systemMessage: { systemMessage: sysText } }
  : {
      systemMessage: {
        systemMessage: sysText,
        metadata: {
          user_markdown: '🧠 **Think Hard (`+`)** · Maximum reasoning rigor active for this turn'
        }
      }
    }

process.stdout.write(JSON.stringify({ injectSteps: [step] }) + '\n')
