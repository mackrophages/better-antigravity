#!/usr/bin/env node
// Stop hook: updates per-session token ledger incrementally in O(delta) bytes.
import { isSubcall, readState, readStdinJson, writeState } from './lib/store.mjs'
import { scanTokensFromOffset } from './lib/transcript.mjs'

if (isSubcall()) {
  process.stdout.write('{}\n')
  process.exit(0)
}

const payload = await readStdinJson()
const safeSid = String(payload.conversationId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)
if (safeSid && payload.transcriptPath) {
  const key = `tokens/${safeSid}.json`
  const prev = readState(key, null)
  const fromByte = prev && typeof prev.byteOffset === 'number' ? prev.byteOffset : 0
  const scan = scanTokensFromOffset(payload.transcriptPath, fromByte)

  if (scan) {
    const baseSession = !prev || scan.reset
      ? { input: 0, output: 0, cached: 0 }
      : (prev.session || { input: 0, output: 0, cached: 0 })
    const baseTurns = !prev || scan.reset ? 0 : (Number(prev.turnCount) || 0)
    const last = scan.last || (!scan.reset ? prev?.last : null)

    if (last || (scan.reset && prev)) {
      writeState(key, {
        conversationId: safeSid,
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
      })
    }
  }
}
process.stdout.write('{}\n')
