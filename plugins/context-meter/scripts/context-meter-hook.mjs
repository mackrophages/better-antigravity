#!/usr/bin/env node
// PreInvocation hook: emits a one-time user_markdown alert (zero model tokens)
// when the session's context window crosses dangerAt (default 75%) using an O(1) tail read.
import {
  getPluginConfig,
  isHeadless,
  isSubcall,
  readStdinJson,
  readState,
  writeState
} from './lib/store.mjs'
import { readLatestUsageTail } from './lib/transcript.mjs'

if (isSubcall() || isHeadless()) {
  process.stdout.write('{}\n')
  process.exit(0)
}

const payload = await readStdinJson()
const safeSid = String(payload.conversationId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)
if (!safeSid || !payload.transcriptPath) {
  process.stdout.write('{}\n')
  process.exit(0)
}

const alertPath = `context-alerts/${safeSid}.json`
const prev = readState(alertPath, { alertedDanger: false })
if (prev.alertedDanger) {
  process.stdout.write('{}\n')
  process.exit(0)
}

const cfg = getPluginConfig('context-meter', { warnAt: 50, dangerAt: 75, inlineAlert: true })
if (cfg.inlineAlert === false) {
  process.stdout.write('{}\n')
  process.exit(0)
}

const latest = readLatestUsageTail(payload.transcriptPath)
const lastIn = latest?.input || 0
const windowLimit = Number(cfg.windowTokens) > 0 ? Number(cfg.windowTokens) : 200_000
const pct = (lastIn / windowLimit) * 100

if (pct >= cfg.dangerAt) {
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
