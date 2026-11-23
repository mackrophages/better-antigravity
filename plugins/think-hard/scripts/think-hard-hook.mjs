#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { isHeadless, isSubcall, readStdinJson, safeSid, stateRoot, writeState } from './lib/store.mjs'
import { cleanUserRequest } from './lib/transcript.mjs'

if (isSubcall()) {
  process.stdout.write('{}\n')
  process.exit(0)
}

const mode = process.argv[2] || 'pre'
const payload = await readStdinJson()
const sid = safeSid(payload.conversationId)
const flagRel = sid ? `turn-flags/think-hard-${sid}.json` : ''
const flagAbs = flagRel ? path.join(stateRoot(), flagRel) : ''

function clearFlag () {
  if (flagAbs) {
    try { fs.rmSync(flagAbs, { force: true }) } catch {}
  }
}

if (mode === 'stop') {
  clearFlag()
  process.stdout.write('{}\n')
  process.exit(0)
}

const input = cleanUserRequest(String(payload.lastUserInput || ''))
const isMarked = input.startsWith('+') && !input.startsWith('++') && input.slice(1).trim().length > 0
const isFirstStep = payload.invocationNum === undefined || payload.invocationNum === 0

if (!isMarked || !isFirstStep) {
  if (isFirstStep) clearFlag()
  process.stdout.write('{}\n')
  process.exit(0)
}

if (flagRel) {
  writeState(flagRel, { thinkHard: true })
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
