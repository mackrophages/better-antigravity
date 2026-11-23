#!/usr/bin/env node
// Stop hook: updates per-session token ledger incrementally in O(delta) bytes under file lock.
import { isSubcall, readStdinJson, safeSid, updateState } from './lib/store.mjs'
import { scanTokensFromOffset } from './lib/transcript.mjs'

if (isSubcall()) {
  process.stdout.write('{}\n')
  process.exit(0)
}

const payload = await readStdinJson()
const sid = safeSid(payload.conversationId)
if (sid && payload.transcriptPath) {
  const key = `tokens/${sid}.json`
  updateState(key, null, (prev) => {
    const fromByte = prev && typeof prev.byteOffset === 'number' ? prev.byteOffset : 0
    const scan = scanTokensFromOffset(payload.transcriptPath, fromByte)
    if (!scan) return prev || { conversationId: sid, updatedAt: Date.now(), byteOffset: 0, last: null, session: { input: 0, output: 0, cached: 0 }, turnCount: 0 }

    const baseSession = !prev || scan.reset
      ? { input: 0, output: 0, cached: 0 }
      : (prev.session || { input: 0, output: 0, cached: 0 })
    const baseTurns = !prev || scan.reset ? 0 : (Number(prev.turnCount) || 0)
    const last = scan.last || (!scan.reset ? prev?.last : null)

    if (last || (scan.reset && prev)) {
      return {
        conversationId: sid,
        model: scan.model || (!scan.reset ? prev?.model : '') || payload.modelName || '',
        updatedAt: Date.now(),
        byteOffset: scan.nextByteOffset,
        last,
        session: {
          input: baseSession.input + scan.delta.input,
          output: baseSession.output + scan.delta.output,
          cached: baseSession.cached + scan.delta.cached
        },
        turnCount: baseTurns + scan.deltaTurns
      }
    }
    return prev || { conversationId: sid, updatedAt: Date.now(), byteOffset: scan.nextByteOffset, last: null, session: baseSession, turnCount: baseTurns }
  })
}
process.stdout.write('{}\n')
