#!/usr/bin/env node
// PreInvocation hook: emits a one-time user_markdown alert (zero model tokens)
// when the session's estimated context window crosses dangerAt (default 75%).
import {
  getPluginConfig,
  isHeadless,
  readStdinJson,
  readState,
  writeState
} from './lib/store.mjs'
import { summarizeTranscript } from './lib/transcript.mjs'

const payload = await readStdinJson()
if (isHeadless() || !payload.conversationId || !payload.transcriptPath) {
  process.stdout.write('{}\n')
  process.exit(0)
}

const cfg = getPluginConfig('context-meter', { warnAt: 50, dangerAt: 75, inlineAlert: true })
if (cfg.inlineAlert === false) {
  process.stdout.write('{}\n')
  process.exit(0)
}

const summary = summarizeTranscript(payload.transcriptPath)
const lastIn = summary.tokens.last?.input || 0
const windowLimit = Number(cfg.windowTokens) > 0 ? Number(cfg.windowTokens) : 200_000
const pct = (lastIn / windowLimit) * 100

const alertPath = `context-alerts/${payload.conversationId}.json`
const prev = readState(alertPath, { alertedDanger: false })

if (pct >= cfg.dangerAt && !prev.alertedDanger) {
  writeState(alertPath, { alertedDanger: true, atPct: Math.round(pct) })
  process.stdout.write(JSON.stringify({
    injectSteps: [
      {
        systemMessage: {
          systemMessage: '',
          metadata: {
            user_markdown: `⚠ **Context Meter (${Math.round(pct)}%)**: Context fill has passed ${cfg.dangerAt}%. Consider running \`/compact\` or starting a new session.`
          }
        }
      }
    ]
  }) + '\n')
  process.exit(0)
}

process.stdout.write('{}\n')
