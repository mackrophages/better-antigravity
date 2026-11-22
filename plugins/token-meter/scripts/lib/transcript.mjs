// Reads Antigravity's transcript.jsonl efficiently:
// - Fast line scanner skipping TOOL payloads during summarization
// - O(1) tail reader (128 KB with 512 KB retry) for latest input_tokens
// - Raw-Buffer O(delta) byte-offset scanner immune to invalid UTF-8 expansion
import fs from 'node:fs'
import os from 'node:os'

export function expandTilde (p) {
  if (!p) return ''
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return os.homedir() + p.slice(1)
  return p
}

export function cleanUserRequest (raw) {
  const s = String(raw || '')
  const openIdx = s.indexOf('<USER_REQUEST>')
  if (openIdx === -1) {
    const m = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(s)
    return (m ? m[1] : s).trim()
  }
  const closeIdx = s.indexOf('</USER_REQUEST>', openIdx + 14)
  if (closeIdx === -1) return s.trim()
  return s.slice(openIdx + 14, closeIdx).trim()
}

export function readTranscriptEntries (transcriptPath) {
  const resolved = expandTilde(transcriptPath)
  if (!resolved || !fs.existsSync(resolved)) return []
  try {
    const raw = fs.readFileSync(resolved, 'utf8')
    const out = []
    let start = 0
    const len = raw.length
    while (start < len) {
      let end = raw.indexOf('\n', start)
      if (end === -1) end = len
      const trimmed = raw.slice(start, end).trim()
      start = end + 1
      if (!trimmed) continue
      try { out.push(JSON.parse(trimmed)) } catch {}
    }
    return out
  } catch {
    return []
  }
}

function scanTailWindow (fd, fileSize, windowBytes) {
  const readLen = Math.min(fileSize, windowBytes)
  const offset = fileSize - readLen
  const buf = Buffer.allocUnsafe(readLen)
  const bytesRead = fs.readSync(fd, buf, 0, readLen, offset)
  const chunk = buf.toString('utf8', 0, bytesRead)
  let end = chunk.length
  while (end > 0) {
    const nl = chunk.lastIndexOf('\n', end - 1)
    const lineStart = nl === -1 ? 0 : nl + 1
    if (nl === -1 && offset > 0) break
    const line = chunk.slice(lineStart, end).trim()
    end = nl
    if (!line || !line.includes('"PLANNER_RESPONSE"')) continue
    try {
      const e = JSON.parse(line)
      if (e.source === 'MODEL' && e.type === 'PLANNER_RESPONSE') {
        const inp = Number(e.input_tokens) || 0
        const out = Number(e.output_tokens) || 0
        const cache = (Number(e.cache_read_tokens) || 0) + (Number(e.cache_creation_tokens) || 0)
        if (inp > 0 || out > 0 || cache > 0) {
          return { input: inp, output: out, cached: cache, model: e.model ? String(e.model) : '' }
        }
      }
    } catch {}
  }
  return null
}

/**
 * O(1) tail lookup of the latest PLANNER_RESPONSE token usage from the end of transcript.jsonl.
 * Reads 128 KB first, with a single 512 KB fallback retry when huge tool outputs trail EOF.
 */
export function readLatestUsageTail (transcriptPath, tailBytes = 131_072) {
  const resolved = expandTilde(transcriptPath)
  if (!resolved) return null
  let fd = -1
  try {
    const st = fs.statSync(resolved, { throwIfNoEntry: false })
    if (!st || st.size === 0) return null
    fd = fs.openSync(resolved, 'r')
    const first = scanTailWindow(fd, st.size, tailBytes)
    if (first || st.size <= tailBytes) return first
    return scanTailWindow(fd, st.size, Math.max(tailBytes * 4, 524_288))
  } catch {
    return null
  } finally {
    if (fd !== -1) {
      try { fs.closeSync(fd) } catch {}
    }
  }
}

/**
 * O(delta) incremental token scanner: finds last newline directly on raw Buffer bytes
 * before UTF-8 decoding so U+FFFD replacement never skews `nextByteOffset`.
 */
export function scanTokensFromOffset (transcriptPath, fromByte = 0) {
  const resolved = expandTilde(transcriptPath)
  if (!resolved) return null
  let fd = -1
  try {
    const st = fs.statSync(resolved, { throwIfNoEntry: false })
    if (!st) return null
    const startByte = st.size >= fromByte && fromByte > 0 ? fromByte : 0
    const reset = startByte === 0 && fromByte > 0
    const len = st.size - startByte
    if (len === 0) {
      return { nextByteOffset: st.size, reset, model: '', last: null, delta: { input: 0, output: 0, cached: 0 }, deltaTurns: 0 }
    }
    fd = fs.openSync(resolved, 'r')
    const buf = Buffer.allocUnsafe(len)
    const n = fs.readSync(fd, buf, 0, len, startByte)
    const lastNl = buf.lastIndexOf(0x0a, n - 1)
    if (lastNl === -1) {
      return { nextByteOffset: startByte, reset, model: '', last: null, delta: { input: 0, output: 0, cached: 0 }, deltaTurns: 0 }
    }
    const consumedBytes = lastNl + 1
    const complete = buf.toString('utf8', 0, consumedBytes)
    let pos = 0
    let latestModel = ''
    let last = null
    const delta = { input: 0, output: 0, cached: 0 }
    let deltaTurns = 0

    while (pos < complete.length) {
      const end = complete.indexOf('\n', pos)
      const line = complete.slice(pos, end === -1 ? complete.length : end).trim()
      pos = end === -1 ? complete.length : end + 1
      if (!line || !line.includes('"PLANNER_RESPONSE"')) continue
      try {
        const e = JSON.parse(line)
        if (e.source === 'MODEL' && e.type === 'PLANNER_RESPONSE') {
          if (e.model) latestModel = String(e.model)
          const inp = Number(e.input_tokens) || 0
          const out = Number(e.output_tokens) || 0
          const cache = (Number(e.cache_read_tokens) || 0) + (Number(e.cache_creation_tokens) || 0)
          if (inp > 0 || out > 0 || cache > 0) {
            last = { input: inp, output: out, cached: cache, model: latestModel }
            delta.input += inp
            delta.output += out
            delta.cached += cache
            deltaTurns++
          }
        }
      } catch {}
    }

    return {
      nextByteOffset: startByte + consumedBytes,
      reset,
      model: latestModel,
      last,
      delta,
      deltaTurns
    }
  } catch {
    return null
  } finally {
    if (fd !== -1) {
      try { fs.closeSync(fd) } catch {}
    }
  }
}

export function summarizeTranscript (transcriptPath) {
  const empty = () => ({
    request: '',
    answer: '',
    actions: [],
    model: '',
    tokens: { last: null, session: { input: 0, output: 0, cached: 0 }, turns: [] }
  })
  const resolved = expandTilde(transcriptPath)
  if (!resolved) return empty()
  let raw = ''
  try {
    raw = fs.readFileSync(resolved, 'utf8')
  } catch {
    return empty()
  }
  if (!raw) return empty()

  let request = ''
  let answer = ''
  let actions = []
  const sessionTokens = { input: 0, output: 0, cached: 0 }
  let lastTurnTokens = null
  const turns = []
  let latestModel = ''
  let lineIdx = -1
  let start = 0
  const len = raw.length

  while (start < len) {
    let end = raw.indexOf('\n', start)
    if (end === -1) end = len
    const line = raw.slice(start, end).trim()
    start = end + 1
    if (!line) continue
    lineIdx++

    // Skip lines that do not mention USER_EXPLICIT or MODEL at all (e.g. huge TOOL outputs)
    if (!line.includes('"MODEL"') && !line.includes('"USER_EXPLICIT"')) continue

    let e
    try { e = JSON.parse(line) } catch { continue }
    if (e.source === 'USER_EXPLICIT' && e.type === 'USER_INPUT') {
      request = cleanUserRequest(String(e.content || ''))
      answer = ''
      actions = []
      continue
    }
    if (e.source === 'MODEL') {
      if (e.type === 'PLANNER_RESPONSE') {
        if (e.model) latestModel = String(e.model)
        const inp = Number(e.input_tokens) || 0
        const out = Number(e.output_tokens) || 0
        const cache = (Number(e.cache_read_tokens) || 0) + (Number(e.cache_creation_tokens) || 0)
        if (inp > 0 || out > 0 || cache > 0) {
          lastTurnTokens = { input: inp, output: out, cached: cache, model: latestModel }
          sessionTokens.input += inp
          sessionTokens.output += out
          sessionTokens.cached += cache
          turns.push({ step: e.step_index ?? lineIdx, ...lastTurnTokens })
        }
        if (typeof e.content === 'string' && e.content.trim()) {
          answer = e.content.trim()
        }
      } else if (e.type && e.type !== 'GENERIC') {
        actions.push(String(e.type).toLowerCase().replace(/_/g, ' '))
      }
    }
  }

  if (lineIdx === -1) return empty()
  return {
    request,
    answer,
    actions: actions.slice(-30),
    model: latestModel,
    tokens: { last: lastTurnTokens, session: sessionTokens, turns }
  }
}
