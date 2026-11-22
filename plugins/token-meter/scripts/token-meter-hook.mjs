#!/usr/bin/env node
// Stop hook: updates per-session token ledger from transcript.jsonl.
import { readStdinJson, writeState } from './lib/store.mjs'
import { summarizeTranscript } from './lib/transcript.mjs'

const payload = await readStdinJson()
if (payload.conversationId && payload.transcriptPath) {
  const sum = summarizeTranscript(payload.transcriptPath)
  if (sum.tokens.last) {
    writeState(`tokens/${payload.conversationId}.json`, {
      conversationId: payload.conversationId,
      model: sum.model || payload.modelName || '',
      updatedAt: Date.now(),
      last: sum.tokens.last,
      session: sum.tokens.session,
      turnCount: sum.tokens.turns.length
    })
  }
}
process.stdout.write('{}\n')
