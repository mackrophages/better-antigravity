import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  readLatestUsageTail,
  scanTokensFromOffset,
  summarizeTranscript
} from '../shared/transcript.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function runGate (plugin, gateName, payload, env) {
  const gatePath = path.join(ROOT, 'plugins', plugin, 'scripts', 'lib', 'hook-gate.sh')
  const res = spawnSync('/bin/sh', [gatePath, gateName], {
    env,
    input: JSON.stringify(payload),
    encoding: 'utf8'
  })
  assert.equal(res.status, 0, res.stderr || res.stdout)
  return JSON.parse(res.stdout.trim())
}

describe('Performance fast-paths, incremental scanners, and payload budgets', () => {
  it('reads O(1) tail usage and O(delta) incremental tokens accurately even across invalid UTF-8 bytes', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-tx-'))
    try {
      const tFile = path.join(tmp, 'transcript.jsonl')
      const chunks = []
      for (let i = 0; i < 600; i++) {
        // Inject raw invalid UTF-8 bytes (0xff, 0xfe) in tool payloads to verify raw-Buffer offset safety
        const prefix = Buffer.from(`{"step_index":${i * 2},"source":"TOOL","type":"GENERIC","output":"`, 'utf8')
        const badUtf8 = Buffer.from([0xff, 0xfe, 0x61, 0x62])
        const suffix = Buffer.from(`${'payload-'.repeat(40)}"}\n`, 'utf8')
        chunks.push(Buffer.concat([prefix, badUtf8, suffix]))
        chunks.push(Buffer.from(JSON.stringify({
          step_index: i * 2 + 1,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          model: 'gemini-4-carbon-high',
          input_tokens: 1000 + i * 10,
          output_tokens: 25,
          cache_read_tokens: 500,
          content: i === 599 ? 'Final answer.' : ''
        }) + '\n', 'utf8'))
      }
      const part1 = Buffer.concat(chunks.slice(0, 800))
      const part2 = Buffer.concat(chunks.slice(800))
      fs.writeFileSync(tFile, part1)

      const s1 = scanTokensFromOffset(tFile, 0)
      assert.ok(s1)
      assert.equal(s1.nextByteOffset, part1.length)
      assert.equal(s1.deltaTurns, 400)

      fs.appendFileSync(tFile, part2)
      const s2 = scanTokensFromOffset(tFile, s1.nextByteOffset)
      assert.ok(s2)
      assert.equal(s2.reset, false)
      assert.equal(s2.nextByteOffset, part1.length + part2.length)
      assert.equal(s2.deltaTurns, 200)

      const full = summarizeTranscript(tFile)
      assert.equal(s1.delta.input + s2.delta.input, full.tokens.session.input)
      assert.equal(s1.delta.output + s2.delta.output, full.tokens.session.output)
      assert.equal(s1.delta.cached + s2.delta.cached, full.tokens.session.cached)
      assert.deepEqual(s2.last, full.tokens.last)

      const t0Tail = Number(process.hrtime.bigint()) / 1e6
      const tail = readLatestUsageTail(tFile)
      const tailMs = (Number(process.hrtime.bigint()) / 1e6) - t0Tail
      assert.deepEqual(tail, full.tokens.last)
      assert.ok(tailMs < 25, `Expected O(1) readLatestUsageTail < 25 ms, got ${tailMs.toFixed(2)} ms`)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('cleans up turn-flags on stop and catches >=75% context even behind 48 KB tool outputs', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-gate-'))
    const stateDir = path.join(tmp, '.gemini', 'antigravity-cli', 'better-antigravity')
    const env = {
      ...process.env,
      BETTER_AGY_TEST_HOME: tmp,
      BETTER_AGY_HOME: stateDir,
      BETTER_AGY_PLUGINS_DIR: path.join(tmp, '.gemini', 'config', 'plugins'),
      BETTER_AGY_CONFIG_JSON: path.join(tmp, '.gemini', 'config', 'config.json'),
      BETTER_AGY_SETTINGS_JSON: path.join(tmp, '.gemini', 'antigravity-cli', 'settings.json')
    }
    delete env.CLAUDE_MEM_SIN_HOOK
    delete env.AGY_HEADLESS
    delete env.BETTER_AGY_SUBCALL

    try {
      // Trigger + and _ simultaneously on invocationNum=0 (separate flag files, zero race)
      const thHit = runGate('think-hard', 'think-hard-pre', { conversationId: 'g1', invocationNum: 0, lastUserInput: '+verify edge cases' }, env)
      assert.match(thHit.injectSteps[0].systemMessage.systemMessage, /THINK HARD MODE/)
      const uhHit = runGate('use-hydrogen', 'use-hydrogen-pre', { conversationId: 'g1', invocationNum: 0, lastUserInput: '_summarize commit' }, env)
      assert.match(uhHit.injectSteps[0].systemMessage.systemMessage, /USE HYDROGEN MODE/)

      // Stop removes both turn-flag files so future unmarked prompts return to the fast no-op path
      runGate('think-hard', 'think-hard-stop', { conversationId: 'g1' }, env)
      runGate('use-hydrogen', 'use-hydrogen-stop', { conversationId: 'g1' }, env)
      const flagDir = path.join(stateDir, 'turn-flags')
      const leftover = fs.existsSync(flagDir) ? fs.readdirSync(flagDir).filter(f => f.endsWith('.json')) : []
      assert.deepEqual(leftover, [], 'turn-flags directory must be empty after stop')

      // Quick Peek autoCard:false with another plugin enabled:true must still fast-exit
      fs.mkdirSync(stateDir, { recursive: true })
      fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({
        plugins: { narrator: { enabled: true }, 'quick-peek': { autoCard: false } }
      }))
      assert.deepEqual(runGate('quick-peek', 'quick-peek-post', { conversationId: 'g1' }, env), {})

      // Context Meter >=75% followed by a 48 KB read_file tool output still triggers alert
      const tPath = path.join(tmp, 'high-ctx.jsonl')
      fs.writeFileSync(tPath, [
        JSON.stringify({
          step_index: 1,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          model: 'gemini-4-carbon-high',
          input_tokens: 160000,
          output_tokens: 300,
          content: 'reading file'
        }),
        JSON.stringify({
          step_index: 2,
          source: 'TOOL',
          type: 'GENERIC',
          output: 'A'.repeat(48_000)
        })
      ].join('\n') + '\n')

      const cmAlert = runGate('context-meter', 'context-meter-pre', { conversationId: 'g1', invocationNum: 1, transcriptPath: tPath }, env)
      assert.match(cmAlert.injectSteps[0].systemMessage.metadata.user_markdown, /Context Meter \(80%\)/)
      const cmSecond = runGate('context-meter', 'context-meter-pre', { conversationId: 'g1', invocationNum: 2, transcriptPath: tPath }, env)
      assert.deepEqual(cmSecond, {})

      // Regression budget on the full 6-gate per-step chain (5 PreInvocation + 1 PostInvocation)
      const stepPayload = { conversationId: 'g1', invocationNum: 2, lastUserInput: 'regular prompt', transcriptPath: tPath }
      const samples = []
      for (let r = 0; r < 3; r++) {
        const t0 = Number(process.hrtime.bigint()) / 1e6
        runGate('sub-meter', 'ensure-hud', stepPayload, env)
        runGate('context-meter', 'context-meter-pre', stepPayload, env)
        runGate('think-hard', 'think-hard-pre', stepPayload, env)
        runGate('use-hydrogen', 'use-hydrogen-pre', stepPayload, env)
        runGate('time-machine', 'tm-pre-invocation', stepPayload, env)
        runGate('quick-peek', 'quick-peek-post', stepPayload, env)
        samples.push((Number(process.hrtime.bigint()) / 1e6) - t0)
      }
      samples.sort((a, b) => a - b)
      assert.ok(samples[1] < 240, `Expected 6-gate step median < 240 ms (baseline 715.68 ms), got ${samples[1].toFixed(2)} ms`)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('enforces web/index.html size budgets and TAS A3 deterministic validation', () => {
    const buf = fs.readFileSync(path.join(ROOT, 'web', 'index.html'))
    const rawKb = buf.length / 1024
    const gzipKb = zlib.gzipSync(buf, { level: 9 }).length / 1024
    assert.ok(rawKb < 220, `Expected web/index.html raw < 220 KB, got ${rawKb.toFixed(1)} KB`)
    assert.ok(gzipKb < 65, `Expected web/index.html gzip < 65 KB, got ${gzipKb.toFixed(1)} KB`)

    const validator = '/root/.gemini/config/plugins/tas/skills/tas-a3/scripts/validar-a3.py'
    if (fs.existsSync(validator)) {
      const a3Res = spawnSync('python3', [validator, '--etapa', 'cerrar', path.join(ROOT, 'docs', 'a3-optimizacion-rendimiento.md')], {
        encoding: 'utf8'
      })
      assert.equal(a3Res.status, 0, a3Res.stdout + a3Res.stderr)
      assert.match(a3Res.stdout, /0 avisos de forma/)
    }
  })
})
