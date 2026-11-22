#!/usr/bin/env node
// Antigravity lifecycle hooks for Narrator.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ensureStatusLineInstalled,
  getPluginConfig,
  isHeadless,
  isSubcall,
  readStdinJson,
  writeState
} from './lib/store.mjs'
import { summarizeTranscript } from './lib/transcript.mjs'
import { conciseSpokenSummary, guessLanguage } from './core/text.mjs'
import { speakDetached, stopSpeaking } from './core/speaker.mjs'

if (isSubcall()) {
  process.stdout.write('{}\n')
  process.exit(0)
}

const here = path.dirname(fileURLToPath(import.meta.url))
const event = process.argv[2] || ''
const payload = await readStdinJson()

if (event === 'session-start') {
  try { ensureStatusLineInstalled(path.join(here, 'lib', 'better-statusline.mjs')) } catch {}
  process.stdout.write('{}\n')
  process.exit(0)
}

if (event === 'pre-invocation') {
  const isFirst = payload.invocationNum === undefined || payload.invocationNum === 0
  if (isFirst) stopSpeaking()
  process.stdout.write('{}\n')
  process.exit(0)
}

if (event === 'stop') {
  if (isHeadless() || payload.fullyIdle === false) {
    process.stdout.write('{}\n')
    process.exit(0)
  }
  if (payload.transcriptPath) {
    const sum = summarizeTranscript(payload.transcriptPath)
    if (sum.answer) {
      writeState('narrator-last-answer.json', {
        answer: sum.answer,
        request: sum.request,
        at: Date.now()
      })
      const cfg = getPluginConfig('narrator', {
        enabled: false,
        language: '',
        voice: '',
        speed: 1.3,
        shortAnswer: 240,
        command: ''
      })
      if (cfg.enabled) {
        const spokenText = conciseSpokenSummary(sum.answer, Number(cfg.shortAnswer) || 240)
        if (spokenText) {
          const lang = cfg.language || guessLanguage(sum.request) || guessLanguage(spokenText) || 'en'
          speakDetached({
            text: spokenText,
            language: lang,
            voice: cfg.voice || '',
            speed: Number(cfg.speed) || 1.3,
            customCommand: cfg.command || ''
          })
        }
      }
    }
  }
  process.stdout.write('{}\n')
  process.exit(0)
}

process.stdout.write('{}\n')
