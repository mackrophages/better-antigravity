// Reads Antigravity's transcript.jsonl safely to extract latest user prompt,
// tool actions, assistant reply, and token counts.
import fs from 'node:fs'
import os from 'node:os'

function expandTilde (p) {
  if (!p) return ''
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return os.homedir() + p.slice(1)
  return p
}

export function readTranscriptEntries (transcriptPath) {
  const resolved = expandTilde(transcriptPath)
  if (!resolved || !fs.existsSync(resolved)) return []
  try {
    const raw = fs.readFileSync(resolved, 'utf8')
    const out = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try { out.push(JSON.parse(trimmed)) } catch {}
    }
    return out
  } catch {
    return []
  }
}

/**
 * Extracts the latest turn from Antigravity transcript entries:
 * - request: latest USER_INPUT content (stripped of <USER_REQUEST> wrapper if present)
 * - answer: latest PLANNER_RESPONSE content with non-empty text
 * - actions: tool step types executed since that USER_INPUT
 * - tokens: { last: { input, output, cached }, session: { input, output, cached } }
 */
export function summarizeTranscript (transcriptPath) {
  const entries = readTranscriptEntries(transcriptPath)
  if (entries.length === 0) {
    return {
      request: '',
      answer: '',
      actions: [],
      model: '',
      tokens: { last: null, session: { input: 0, output: 0, cached: 0 }, turns: [] }
    }
  }

  let lastUserIdx = -1
  let request = ''
  const sessionTokens = { input: 0, output: 0, cached: 0 }
  let lastTurnTokens = null
  const turns = []
  let latestModel = ''

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (e.source === 'USER_EXPLICIT' && e.type === 'USER_INPUT') {
      lastUserIdx = i
      request = cleanUserRequest(String(e.content || ''))
    }
    if (e.source === 'MODEL' && e.type === 'PLANNER_RESPONSE') {
      if (e.model) latestModel = String(e.model)
      const inp = Number(e.input_tokens) || 0
      const out = Number(e.output_tokens) || 0
      const cache = (Number(e.cache_read_tokens) || 0) + (Number(e.cache_creation_tokens) || 0)
      if (inp > 0 || out > 0 || cache > 0) {
        lastTurnTokens = { input: inp, output: out, cached: cache, model: latestModel }
        sessionTokens.input += inp
        sessionTokens.output += out
        sessionTokens.cached += cache
        turns.push({ step: e.step_index ?? i, ...lastTurnTokens })
      }
    }
  }

  const slice = lastUserIdx >= 0 ? entries.slice(lastUserIdx + 1) : entries
  const actions = []
  let answer = ''
  for (const e of slice) {
    if (e.source === 'MODEL' && e.type === 'PLANNER_RESPONSE') {
      if (typeof e.content === 'string' && e.content.trim()) {
        answer = e.content.trim()
      }
    } else if (e.source === 'MODEL' && e.type && e.type !== 'GENERIC') {
      actions.push(String(e.type).toLowerCase().replace(/_/g, ' '))
    }
  }

  return {
    request,
    answer,
    actions: actions.slice(-30),
    model: latestModel,
    tokens: { last: lastTurnTokens, session: sessionTokens, turns }
  }
}

export function cleanUserRequest (raw) {
  const m = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(raw)
  return (m ? m[1] : raw).trim()
}
