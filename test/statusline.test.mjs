import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

import {
  shortTokens,
  formatUntilSeconds,
  visibleWidth,
  ensureStatusLineInstalled,
  repoKey,
  safeSid,
  setPluginConfig,
  getPluginConfig,
  writeState
} from '../shared/store.mjs'
import { summarizeTranscript } from '../shared/transcript.mjs'
import { formatStatusLine } from '../shared/better-statusline.mjs'

function withTempEnv (fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'better-agy-test-'))
  const prev = {
    BETTER_AGY_TEST_HOME: process.env.BETTER_AGY_TEST_HOME,
    BETTER_AGY_HOME: process.env.BETTER_AGY_HOME,
    BETTER_AGY_PLUGINS_DIR: process.env.BETTER_AGY_PLUGINS_DIR,
    BETTER_AGY_CONFIG_JSON: process.env.BETTER_AGY_CONFIG_JSON,
    BETTER_AGY_SETTINGS_JSON: process.env.BETTER_AGY_SETTINGS_JSON,
    CLAUDE_MEM_SIN_HOOK: process.env.CLAUDE_MEM_SIN_HOOK
  }
  process.env.BETTER_AGY_TEST_HOME = tmp
  process.env.BETTER_AGY_HOME = path.join(tmp, '.gemini', 'antigravity-cli', 'better-antigravity')
  process.env.BETTER_AGY_PLUGINS_DIR = path.join(tmp, '.gemini', 'config', 'plugins')
  process.env.BETTER_AGY_CONFIG_JSON = path.join(tmp, '.gemini', 'config', 'config.json')
  process.env.BETTER_AGY_SETTINGS_JSON = path.join(tmp, '.gemini', 'antigravity-cli', 'settings.json')
  delete process.env.CLAUDE_MEM_SIN_HOOK
  try {
    return fn(tmp)
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

function enableFakePlugins (tmp, names) {
  for (const name of names) {
    const dir = path.join(tmp, '.gemini', 'config', 'plugins', name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ name }))
  }
}

describe('shared/store helpers & wcwidth', () => {
  it('formats token counts half-up, measures wide CJK/emoji wcwidth, and sanitizes safeSid', () => {
    assert.equal(shortTokens(0), '0')
    assert.equal(shortTokens(340), '340')
    assert.equal(shortTokens(1200), '1.2k')
    assert.equal(shortTokens(999_950), '1.0M')

    assert.equal(formatUntilSeconds(0), '')
    assert.equal(formatUntilSeconds(2520), '42m')
    assert.equal(formatUntilSeconds(7800), '2h 10m')
    assert.equal(formatUntilSeconds(273600), '3d 4h')

    // Unified wcwidth: ⏪ = 2 cols, ⏹\uFE0E = 1 col, bare ⏸ = 2 cols, CJK/🚀 = 2 cols each
    assert.equal(visibleWidth('\x1b[38;5;75m⏪ #60\x1b[0m'), 6)
    assert.equal(visibleWidth('\x1b[94m⏹\uFE0E\x1b[0m'), 1)
    assert.equal(visibleWidth('⏸ after (2)'), 12)
    assert.equal(visibleWidth('中文🚀'), 6)

    assert.equal(safeSid('../../../etc/passwd'), 'etcpasswd')
    assert.equal(safeSid('../../..', 'default'), 'default')
  })

  it('saves plugin config, verifies SHA-256 + smoke test on C11 binary, and backs up settings.json', () => {
    withTempEnv((tmp) => {
      const settingsFile = process.env.BETTER_AGY_SETTINGS_JSON
      fs.mkdirSync(path.dirname(settingsFile), { recursive: true })
      fs.writeFileSync(settingsFile, JSON.stringify({ model: 'Gemini 4 Carbon (High)' }))

      setPluginConfig('context-meter', { warnAt: 55 })
      assert.equal(getPluginConfig('context-meter', { warnAt: 50, dangerAt: 75 }).warnAt, 55)

      const srcScript = path.join(REPO_ROOT, 'shared', 'better-statusline.mjs')
      const res = ensureStatusLineInstalled(srcScript)
      assert.equal(res.installed, true)
      assert.equal(res.updatedSettings, true)
      assert.equal(fs.existsSync(`${settingsFile}.bak-better-agy`), true)

      if (['linux', 'android'].includes(process.platform)) {
        assert.equal(res.native, true, 'Expected native C11 statusLine binary to compile and pass smoke test on Linux')
        assert.equal(fs.existsSync(`${res.targetScript}.sha256`), true)
      }

      const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
      assert.equal(saved.model, 'Gemini 4 Carbon (High)')
      assert.equal(saved.statusLine.stack_with_default, true)
      assert.match(saved.statusLine.command, /better-statusline(?:\.mjs)?$/)

      if (res.native) {
        const tmHook = path.join(REPO_ROOT, 'plugins', 'time-machine', 'scripts', 'tm-hook.mjs')
        const hookRes = spawnSync(process.execPath, [tmHook, 'session-start'], {
          env: process.env,
          input: '{}',
          encoding: 'utf8'
        })
        assert.equal(hookRes.status, 0)
        const afterHook = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
        assert.equal(afterHook.statusLine.command, saved.statusLine.command)
      }
    })
  })
})

describe('better-statusline JS & C11 golden parity matrix', () => {
  it('renders per-model context identifiers, animated spinners, >250KB Time Machine states, ISO reset_time, \\uXXXX escapes, and control-char stripping identically in C11 and JS', () => {
    withTempEnv((tmp) => {
      enableFakePlugins(tmp, [
        'context-meter', 'token-meter', 'sub-meter',
        'time-machine', 'after', 'think-hard', 'use-hydrogen', 'narrator'
      ])
      setPluginConfig('narrator', { enabled: true, language: 'es\x1b]0;INJECT\x07' })

      const resNative = ensureStatusLineInstalled(path.join(REPO_ROOT, 'shared', 'better-statusline.mjs'), {
        force: true,
        preferNative: true
      })
      if (['linux', 'android'].includes(process.platform)) {
        assert.equal(resNative.native, true, 'C11 compiler must be present and mandatory on Linux/CI')
      }

      const runC = (rawJsonString, nowMs) => {
        const cProc = spawnSync(resNative.targetScript, [], {
          env: { ...process.env, BETTER_AGY_NOW_MS: String(nowMs) },
          input: rawJsonString,
          encoding: 'utf8'
        })
        assert.equal(cProc.status, 0, cProc.stderr)
        return cProc.stdout.replace(/\n$/, '')
      }

      const basePayload = {
        conversation_id: 'conv-1',
        cwd: '/tmp/proj-alpha',
        terminal_width: 160,
        model: { id: 'gemini-4-carbon-high', display_name: 'Gemini 4 Carbon (High)' },
        context_window: {
          total_input_tokens: 184000,
          total_output_tokens: 3100,
          context_window_size: 1048576,
          used_percentage: 58.2,
          current_usage: {
            input_tokens: 184000,
            output_tokens: 340,
            cache_read_input_tokens: 4100,
            cache_creation_input_tokens: 0
          }
        },
        quota: {
          'gemini-5h': { remaining_fraction: 0.42, reset_in_seconds: 7800 },
          'gemini-weekly': { remaining_fraction: 0.69, reset_in_seconds: 273600 }
        }
      }

      // 1. Per-model context window identifier (`✦ context 58%/1M · /compact`, `✻ .../200k`, `❂ .../128k`)
      const wideGem = formatStatusLine({ ...basePayload, agent_state: 'idle' }, { nowMs: 16_000 })
      const plainGem = wideGem.replace(/\x1b\[[0-9;]*m/g, '')
      assert.match(plainGem, /✦ context 58%\/1M · \/compact/)
      assert.match(plainGem, /✦ 5h ━━━━━━──── 58% ↻ 2h 10m/)
      // Narrator language had `\x1b]0;INJECT\x07` stripped cleanly!
      assert.equal(wideGem.includes('\x07'), false)
      assert.match(plainGem, /⏵ narrator on · ES\]0;INJECT/)

      const wideClaude = formatStatusLine({
        ...basePayload,
        agent_state: 'idle',
        model: { id: 'claude-opus-5-5-high', display_name: 'Claude Opus 5.5 (High)' },
        context_window: { ...basePayload.context_window, context_window_size: 200_000, used_percentage: 81.4 }
      }, { nowMs: 16_000 })
      assert.match(wideClaude.replace(/\x1b\[[0-9;]*m/g, ''), /✻ context 81%\/200k · new session/)

      const wideGpt = formatStatusLine({
        ...basePayload,
        agent_state: 'idle',
        model: { id: 'gpt-oss-120b-medium', display_name: 'GPT-OSS 120B (Medium)' },
        context_window: { ...basePayload.context_window, context_window_size: 131_072, used_percentage: 34.0 }
      }, { nowMs: 16_000 })
      assert.match(wideGpt.replace(/\x1b\[[0-9;]*m/g, ''), /❂ context 34%\/128k/)

      // 2. Animated spinner frames for Claude (`· ✢ ✳ ✶ ✻ ✽`), Gemini (`· ✧ ✦ ◇ ◈ ❖`), and GPT (`❂`)
      const mixedPayload = {
        ...basePayload,
        agent_state: 'working',
        quota: {
          '3p-5h': { remaining_fraction: 0.8, reset_in_seconds: 14400 },
          '3p-weekly': { remaining_fraction: 0.9, reset_in_seconds: 518400 },
          'gemini-5h': { remaining_fraction: 0.42, reset_in_seconds: 7800 },
          'gemini-weekly': { remaining_fraction: 0.69, reset_in_seconds: 273600 }
        }
      }
      const claudeFrames = ['·', '✢', '✳', '✶', '✻', '✽']
      for (let f = 0; f < claudeFrames.length; f++) {
        const out = formatStatusLine(mixedPayload, { nowMs: f * 300 })
        assert.ok(out.replace(/\x1b\[[0-9;]*m/g, '').includes(`${claudeFrames[f]} 5h ━━──────── 20% ↻ 4h 0m`))
      }

      // 3. Large >260 KB Time Machine state file with 60 states (regression I2)
      const rKeyAlpha = repoKey('/tmp/proj-alpha')
      const bigStates = Array.from({ length: 60 }, (_, idx) => ({
        id: idx + 1,
        parent: idx === 0 ? null : idx,
        tree: 'a'.repeat(40),
        head: 'b'.repeat(40),
        commit: 'c'.repeat(40),
        label: `turn snapshot #${idx + 1} with detailed description`,
        prompt: 'x'.repeat(300),
        at: 1_700_000_000_000 + idx * 1000,
        files: Array.from({ length: 65 }, (__, fi) => ({
          path: `src/modules/feature-${idx}/component-${fi}.tsx`,
          status: 'M',
          added: 12,
          removed: 4
        }))
      }))
      // Deliberately put `states` FIRST (legacy layout without top-level `maxId`) to prove 8 MB reader works too!
      const tmLegacyPath = path.join(process.env.BETTER_AGY_HOME, 'time-machine', rKeyAlpha, 'conv-1.json')
      fs.mkdirSync(path.dirname(tmLegacyPath), { recursive: true })
      fs.writeFileSync(tmLegacyPath, JSON.stringify({ states: bigStates, cursor: 42 }))
      assert.ok(fs.statSync(tmLegacyPath).size > 250_000, 'Fixture must exceed 250 KB (> 64 KB old cap)')

      // 4. Terminal escape injection in `after` queue + Unicode `\uXXXX` + surrogate pair `cwd` (regressions I4 & M1)
      const unicodeCwd = '/tmp/café-🚀'
      const rKeyUnicode = repoKey(unicodeCwd)
      writeState(`after/${rKeyUnicode}-conv-1.json`, {
        paused: false,
        running: { id: 1, text: '\x1b]0;PWNED\x07\x1b]52;c;YWJj\x07fix\ncafé 🚀タスク完了' },
        items: [{ id: 2, text: 'next' }]
      })

      // 5. Narrator PID recycling guard (regression M4): process.pid is alive (`node`), NOT `speak-worker`!
      writeState('narrator-runtime.json', { speakingPid: process.pid, startedAt: 15_000, synthesizer: 'espeak-ng' })
      writeState('turn-flags/think-hard-conv-1.json', { thinkHard: true })
      writeState('turn-flags/use-hydrogen-conv-1.json', { useHydrogen: true })

      // 6. ISO-8601 `reset_time` without `reset_in_seconds` + weekly bucket with < 6h left (regressions I3 & M2)
      const isoBaseMs = Date.parse('2026-11-22T12:00:00.000Z')
      const isoPayload = {
        conversation_id: 'conv-1',
        cwd: '/tmp/proj-alpha',
        agent_state: 'idle',
        terminal_width: 180,
        model: { id: 'claude-sonnet-5-5-high', display_name: 'Claude Sonnet 5.5 (High)' },
        context_window: { context_window_size: 200_000, used_percentage: 45, current_usage: { input_tokens: 90_000, output_tokens: 500 } },
        quota: {
          '3p-weekly': { remaining_fraction: 0.5, reset_time: '2026-11-22T12:30:00+00:00' }, // 30m left <= 6h, MUST stay "week"!
          'gemini-session': { remaining_fraction: 0.5, reset_time: '2026-11-22T15:00:00.400+02:00' } // 13:00Z = 1h 0m left!
        }
      }
      setPluginConfig('sub-meter', { display: 'both' })

      const isoJs = formatStatusLine(isoPayload, { nowMs: isoBaseMs })
      const isoPlain = isoJs.replace(/\x1b\[[0-9;]*m/g, '')
      assert.match(isoPlain, /✻ week ━━━━━───── 50% ↻ 30m/, 'Weekly bucket <6h from reset must stay labeled "week"')
      assert.match(isoPlain, /✦ 5h ━━━━━───── 50% ↻ 1h 0m/, 'ISO-8601 +02:00 reset_time must compute 1h 0m')
      assert.match(isoPlain, /⏪ #42\/60/, '>250 KB Time Machine state must show #42/60')
      assert.doesNotMatch(isoPlain, /narrating/, 'Non-speak-worker PID must not falsely display narrating')

      if (resNative.native) {
        assert.equal(runC(JSON.stringify(isoPayload), isoBaseMs), isoJs, 'ISO-8601 + >250KB TM parity mismatch')

        // Raw `\u00e9` + surrogate pair `\ud83d\ude80` in JSON input (regression M1 + I4 + wcwidth)
        const rawUnicodeJson =
          '{"conversation_id":"conv-1","cwd":"/tmp/caf\\u00e9-\\ud83d\\ude80","agent_state":"working",' +
          '"terminal_width":170,"model":"gpt-oss-120b-medium",' +
          '"context_window":{"context_window_size":131072,"used_percentage":22,"current_usage":{"input_tokens":28000,"output_tokens":120}}}'
        const parsedUnicode = JSON.parse(rawUnicodeJson)
        for (const width of [180, 120, 85, 55, 1e300]) {
          const jsU = formatStatusLine({ ...parsedUnicode, terminal_width: width }, { nowMs: isoBaseMs + 900 })
          assert.equal(jsU.includes('\x07'), false, 'No BEL byte may survive sanitizeInlineText')
          assert.equal(jsU.includes('\x1b]'), false, 'No OSC sequence may survive sanitizeInlineText')
          if (width === 180) {
            assert.match(jsU.replace(/\x1b\[[0-9;]*m/g, ''), /after ▶ \]0;PWNED\]52;c;YWJjfix /)
          }
          const rawWithWidth = rawUnicodeJson.replace('"terminal_width":170', `"terminal_width":${width}`)
          const cU = runC(rawWithWidth, isoBaseMs + 900)
          assert.equal(cU, jsU, `Unicode/escape/wcwidth parity mismatch at width=${width}`)
        }

        // Traversal conversation_id `../../../etc/passwd` parity (regression M3)
        const travPayload = { ...isoPayload, conversation_id: '../../../etc/passwd', terminal_width: 140 }
        assert.equal(runC(JSON.stringify(travPayload), isoBaseMs), formatStatusLine(travPayload, { nowMs: isoBaseMs }))

        // Regression R2-5 & R2-8: giant reset_in_seconds (no RangeError!), negative/over-100 used_percentage,
        // timezone-less reset_time, `\u0000` inside strings, and duplicate JSON keys!
        const edgeCases = [
          '{"conversation_id":"conv-1","terminal_width":150,"context_window":{"context_window_size":200000,"used_percentage":-5,"current_usage":{"input_tokens":100,"output_tokens":10}}}',
          '{"conversation_id":"conv-1","terminal_width":150,"context_window":{"context_window_size":200000,"used_percentage":1000000000,"current_usage":{"input_tokens":100,"output_tokens":10}}}',
          '{"conversation_id":"conv-1","terminal_width":150,"quota":{"gemini-5h":{"remaining_fraction":0.5,"reset_in_seconds":1e30},"3p-weekly":{"remaining_fraction":0.2,"reset_time":"2026-11-22T15:00:00"}}}',
          '{"conversation_id":"conv-1","cwd":"/tmp/wrong","cwd":"/tmp/caf\\u0000\\u00e9-\\ud83d\\ude80","agent_state":"working","terminal_width":160}'
        ]
        for (const rawEdge of edgeCases) {
          const jsEdge = formatStatusLine(JSON.parse(rawEdge), { nowMs: isoBaseMs })
          const cEdge = runC(rawEdge, isoBaseMs)
          assert.equal(cEdge, jsEdge, `Edge-case C11 vs JS parity mismatch on: ${rawEdge}`)
        }

        // Quota cache perms must be 0600 (Pulido)
        const qStat = fs.statSync(path.join(process.env.BETTER_AGY_HOME, 'quota-cache.json'))
        assert.equal(qStat.mode & 0o777, 0o600, 'quota-cache.json must have 0600 permissions')
      }
    })
  })

  it('returns empty string when no HUD plugins are enabled', () => {
    withTempEnv(() => {
      assert.equal(formatStatusLine({ terminal_width: 100 }), '')
    })
  })
})

describe('shared/transcript.mjs', () => {
  it('extracts user request, final assistant message, tool actions, and token totals', () => {
    withTempEnv((tmp) => {
      const tPath = path.join(tmp, 'transcript.jsonl')
      const rows = [
        { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: '<USER_REQUEST>\nFix the login bug\n</USER_REQUEST>' },
        { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', model: 'gemini-4-carbon-high', input_tokens: 1500, output_tokens: 200, cache_read_tokens: 500, content: '' },
        { step_index: 2, source: 'MODEL', type: 'VIEW_FILE', content: 'read auth.ts' },
        { step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', model: 'gemini-4-carbon-high', input_tokens: 1800, output_tokens: 350, cache_read_tokens: 1200, content: 'I fixed the login bug in `src/auth.ts`. Should I run the tests?' }
      ]
      fs.writeFileSync(tPath, rows.map(r => JSON.stringify(r)).join('\n'))

      const sum = summarizeTranscript(tPath)
      assert.equal(sum.request, 'Fix the login bug')
      assert.equal(sum.answer, 'I fixed the login bug in `src/auth.ts`. Should I run the tests?')
      assert.deepEqual(sum.actions, ['view file'])
      assert.equal(sum.tokens.last.input, 1800)
      assert.equal(sum.tokens.session.input, 3300)
      assert.equal(sum.tokens.session.output, 550)
      assert.equal(sum.tokens.session.cached, 1700)
    })
  })
})
