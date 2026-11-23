import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  readLatestAnswerTail,
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
  it('reads O(1) tail usage/answer and 64KB-chunked O(delta) tokens accurately across invalid UTF-8 bytes', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-tx-'))
    try {
      const tFile = path.join(tmp, 'transcript.jsonl')
      const chunks = []
      for (let i = 0; i < 600; i++) {
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
          content: i === 599 ? 'Final answer in `src/app.ts:12`.' : ''
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
      const ansTail = readLatestAnswerTail(tFile)
      const tailMs = (Number(process.hrtime.bigint()) / 1e6) - t0Tail
      assert.deepEqual(tail, full.tokens.last)
      assert.equal(ansTail, 'Final answer in `src/app.ts:12`.')
      assert.ok(tailMs < 35, `Expected O(1) tail readers < 35 ms, got ${tailMs.toFixed(2)} ms`)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('proves ensure-hud fast-exits with 0 Node spawns on second SessionStart (I1) and Context Meter scales per model (M10)', () => {
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
      // 1. Regression I1: First SessionStart installs HUD and writes 'native' or 'node' into .hud-ready.
      // Second SessionStart MUST NOT spawn `node` at all (poison `node` in PATH to exit 99 if called!).
      assert.deepEqual(runGate('sub-meter', 'ensure-hud', {}, env), {})
      const readyStamp = fs.readFileSync(path.join(stateDir, '.hud-ready'), 'utf8').trim()
      assert.ok(['native', 'node', 'custom'].includes(readyStamp), `Unexpected .hud-ready stamp: ${readyStamp}`)

      const poisonBin = path.join(tmp, 'poison-bin')
      fs.mkdirSync(poisonBin, { recursive: true })
      fs.writeFileSync(path.join(poisonBin, 'node'), '#!/bin/sh\necho "NODE_WAS_SPAWNED" >&2\nexit 99\n', { mode: 0o755 })
      const poisonedEnv = { ...env, PATH: `${poisonBin}:${env.PATH}` }
      assert.deepEqual(runGate('sub-meter', 'ensure-hud', {}, poisonedEnv), {})
      assert.deepEqual(runGate('context-meter', 'ensure-hud', {}, poisonedEnv), {})

      // Regression R2-2: Updating plugin source (`better-statusline.mjs` newer than `.hud-ready`, as in `agy plugin install <url>`)
      // MUST bypass stale `.hud-ready` and refresh the installed statusLine!
      const futureTime = new Date(Date.now() + 10_000)
      const subSlCopy = path.join(ROOT, 'plugins', 'sub-meter', 'scripts', 'lib', 'better-statusline.mjs')
      const origSubSlStat = fs.statSync(subSlCopy)
      try {
        fs.utimesSync(subSlCopy, futureTime, futureTime)
        assert.deepEqual(runGate('sub-meter', 'ensure-hud', {}, env), {})
        // Now `.hud-ready` was re-stamped, and once timestamps match normal install, fast-path works again:
        fs.utimesSync(subSlCopy, origSubSlStat.atime, origSubSlStat.mtime)
        assert.deepEqual(runGate('sub-meter', 'ensure-hud', {}, poisonedEnv), {})
      } finally {
        fs.utimesSync(subSlCopy, origSubSlStat.atime, origSubSlStat.mtime)
      }

      // 2. Think Hard + Use Hydrogen turn-flags cleanup
      const thHit = runGate('think-hard', 'think-hard-pre', { conversationId: 'g1', invocationNum: 0, lastUserInput: '+verify edge cases' }, env)
      assert.match(thHit.injectSteps[0].systemMessage.systemMessage, /THINK HARD MODE/)
      const uhHit = runGate('use-hydrogen', 'use-hydrogen-pre', { conversationId: 'g1', invocationNum: 0, lastUserInput: '_summarize commit' }, env)
      assert.match(uhHit.injectSteps[0].systemMessage.systemMessage, /USE HYDROGEN MODE/)

      runGate('think-hard', 'think-hard-stop', { conversationId: 'g1' }, env)
      runGate('use-hydrogen', 'use-hydrogen-stop', { conversationId: 'g1' }, env)
      const flagDir = path.join(stateDir, 'turn-flags')
      const leftover = fs.existsSync(flagDir) ? fs.readdirSync(flagDir).filter(f => f.endsWith('.json')) : []
      assert.deepEqual(leftover, [], 'turn-flags directory must be empty after stop')

      // 3. Quick Peek autoCard:false fast-exit (even with poisoned node!)
      fs.mkdirSync(stateDir, { recursive: true })
      fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({
        plugins: { narrator: { enabled: true }, 'quick-peek': { autoCard: false } }
      }))
      assert.deepEqual(runGate('quick-peek', 'quick-peek-post', { conversationId: 'g1' }, poisonedEnv), {})

      // 4. Regression M10 + per-model identifier:
      // a) 160,000 tokens on Gemini 1M (`16%`) must NOT false-alert!
      const tGem16 = path.join(tmp, 'gem-16pct.jsonl')
      fs.writeFileSync(tGem16, JSON.stringify({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        model: 'gemini-4-carbon-high',
        input_tokens: 160_000,
        output_tokens: 300,
        content: 'still at 16% of 1M'
      }) + '\n')
      assert.deepEqual(runGate('context-meter', 'context-meter-pre', { conversationId: 'gem-ok', invocationNum: 1, transcriptPath: tGem16 }, env), {})

      // b) 160,000 tokens on Claude 200k (`80%`) followed by 48 KB tool output MUST alert with `✻ claude-opus-5-5-high (200k)`!
      const tClaude80 = path.join(tmp, 'claude-80pct.jsonl')
      fs.writeFileSync(tClaude80, [
        JSON.stringify({
          step_index: 1,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          model: 'claude-opus-5-5-high',
          input_tokens: 160_000,
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
      const cmClaude = runGate('context-meter', 'context-meter-pre', { conversationId: 'g1', invocationNum: 1, transcriptPath: tClaude80 }, env)
      assert.match(cmClaude.injectSteps[0].systemMessage.metadata.user_markdown, /Context Meter \(80%\) · ✻ `claude-opus-5-5-high` \(200k\)/)
      // Second call hits alertedDanger:true in /bin/sh with zero Node spawns!
      assert.deepEqual(runGate('context-meter', 'context-meter-pre', { conversationId: 'g1', invocationNum: 2, transcriptPath: tClaude80 }, poisonedEnv), {})

      // c) Small 32k model session (`context-windows/sess-s32.json`) at 26,000 tokens (`79%`) MUST pass gate and alert!
      const cwDir = path.join(stateDir, 'context-windows')
      fs.mkdirSync(cwDir, { recursive: true })
      fs.writeFileSync(path.join(cwDir, 'sess-s32.json'), JSON.stringify({ model: 'custom-small', family: 'gpt', windowTokens: 32_768 }))
      const tSmall = path.join(tmp, 'small-32k.jsonl')
      fs.writeFileSync(tSmall, JSON.stringify({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        model: 'gpt-mini-32k',
        input_tokens: 26_000,
        output_tokens: 100,
        content: 'near 32k limit'
      }) + '\n')
      const cmSmall = runGate('context-meter', 'context-meter-pre', { conversationId: 's32', invocationNum: 1, transcriptPath: tSmall }, env)
      assert.match(cmSmall.injectSteps[0].systemMessage.metadata.user_markdown, /Context Meter \(79%\) · ❂ `gpt-mini-32k` \(32k\)/)

      // 5. Regression budget on the full 6-gate per-step chain (all 6 gates fast-exiting with 0 Node spawns!)
      const stepPayload = { conversationId: 'g1', invocationNum: 2, lastUserInput: 'regular prompt', transcriptPath: tClaude80 }
      const samples = []
      for (let r = 0; r < 3; r++) {
        const t0 = Number(process.hrtime.bigint()) / 1e6
        runGate('sub-meter', 'ensure-hud', stepPayload, poisonedEnv)
        runGate('context-meter', 'context-meter-pre', stepPayload, poisonedEnv)
        runGate('think-hard', 'think-hard-pre', stepPayload, poisonedEnv)
        runGate('use-hydrogen', 'use-hydrogen-pre', stepPayload, poisonedEnv)
        runGate('time-machine', 'tm-pre-invocation', stepPayload, poisonedEnv)
        runGate('quick-peek', 'quick-peek-post', stepPayload, poisonedEnv)
        samples.push((Number(process.hrtime.bigint()) / 1e6) - t0)
      }
      samples.sort((a, b) => a - b)
      assert.ok(samples[1] < 240, `Expected 6-gate step median < 240 ms, got ${samples[1].toFixed(2)} ms`)
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
