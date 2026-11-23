#!/usr/bin/env node
// PreInvocation hook: emits a one-time user_markdown alert (zero model tokens)
// when the session's per-model context window crosses dangerAt (default 75%) using an O(1) tail read.
import {
  getPluginConfig,
  isHeadless,
  isSubcall,
  readStdinJson,
  readState,
  safeSid,
  shortTokens,
  shortWindowLabel,
  updateState
} from './lib/store.mjs'
import { readLatestUsageTail } from './lib/transcript.mjs'

function safeModelKey (raw) {
  return String(raw ?? '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
}

function familyIconOf (modelStr) {
  const low = String(modelStr || '').toLowerCase()
  if (low.includes('gpt') || low.includes('openai')) return '❂'
  if (low.includes('claude') || low.includes('anthropic')) return '✻'
  return '✦'
}

function inferModelWindowTokens (modelStr) {
  const low = String(modelStr || '').toLowerCase()
  if (!low) return 0
  if (low.includes('[2m]') || low.includes('-2m') || low.includes(' 2m')) return 2_000_000
  if (low.includes('[1m]') || low.includes('-1m') || low.includes(' 1m')) return 1_000_000
  if (low.includes('gemini') || low.includes('orchestrator')) return 1_000_000
  if (low.includes('gpt-oss') || low.includes('128k')) return 131_072
  if (low.includes('claude') || low.includes('anthropic')) return 200_000
  return 0
}

if (isSubcall() || isHeadless()) {
  process.stdout.write('{}\n')
  process.exit(0)
}

const payload = await readStdinJson()
const sid = safeSid(payload.conversationId)
if (!sid || !payload.transcriptPath) {
  process.stdout.write('{}\n')
  process.exit(0)
}

const alertPath = `context-alerts/${sid}.json`
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
const rawModel = String(payload.modelName || payload.model?.id || payload.model || latest?.model || '')
const mKey = safeModelKey(rawModel)

const payloadWin = Number(payload?.context_window?.context_window_size || payload?.contextWindowSize) || 0
const savedModelWin = mKey ? Number(readState(`context-windows/model-${mKey}.json`, null)?.windowTokens) || 0 : 0
const savedSessWin = Number(readState(`context-windows/sess-${sid}.json`, null)?.windowTokens) || 0
// Note: explicit/saved windows win first; if neither exists and rawModel is a generic test model without
// saved window metadata, fall back cleanly: savedModelWin -> savedSessWin -> inferred -> 200k.
const inferredWin = inferModelWindowTokens(rawModel)
const windowLimit = Number(cfg.windowTokens) > 0
  ? Number(cfg.windowTokens)
  : (payloadWin > 0 ? payloadWin : (savedModelWin > 0 ? savedModelWin : (savedSessWin > 0 ? savedSessWin : (inferredWin > 0 ? inferredWin : 200_000))))

const pct = (lastIn / windowLimit) * 100

if (pct >= cfg.dangerAt) {
  const winLabel = shortWindowLabel(windowLimit)
  const icon = familyIconOf(rawModel)
  const modelTag = rawModel ? ` · ${icon} \`${rawModel}\` (${winLabel})` : ` (${winLabel})`
  updateState(alertPath, { alertedDanger: false }, () => ({
    alertedDanger: true,
    atPct: Math.round(pct),
    model: rawModel || null,
    windowTokens: windowLimit
  }))
  process.stdout.write(JSON.stringify({
    injectSteps: [
      {
        systemMessage: {
          systemMessage: '',
          metadata: {
            user_markdown: `⚠ **Context Meter (${Math.round(pct)}%)${modelTag}**: Context fill (${shortTokens(lastIn)} / ${winLabel}) has passed ${cfg.dangerAt}%. Consider running \`/compact\` or starting a new session.`
          }
        }
      }
    ]
  }) + '\n')
  process.exit(0)
}

process.stdout.write('{}\n')
