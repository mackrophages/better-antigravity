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
  setPluginConfig,
  getPluginConfig,
  writeState
} from '../shared/store.mjs'
import { summarizeTranscript } from '../shared/transcript.mjs'
import { formatStatusLine } from '../scripts/better-statusline.mjs'

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

describe('shared/store helpers', () => {
  it('formats token counts half-up like midudev token-meter', () => {
    assert.equal(shortTokens(0), '0')
    assert.equal(shortTokens(340), '340')
    assert.equal(shortTokens(1200), '1.2k')
    assert.equal(shortTokens(999_950), '1.0M')
  })

  it('formats reset durations concisely', () => {
    assert.equal(formatUntilSeconds(0), '')
    assert.equal(formatUntilSeconds(2520), '42m')
    assert.equal(formatUntilSeconds(7800), '2h 10m')
    assert.equal(formatUntilSeconds(273600), '3d 4h')
  })

  it('saves plugin config and installs statusLine with backup', () => {
    withTempEnv((tmp) => {
      const settingsFile = process.env.BETTER_AGY_SETTINGS_JSON
      fs.mkdirSync(path.dirname(settingsFile), { recursive: true })
      fs.writeFileSync(settingsFile, JSON.stringify({ model: 'Gemini 4 Carbon (High)' }))

      setPluginConfig('context-meter', { warnAt: 55 })
      assert.equal(getPluginConfig('context-meter', { warnAt: 50, dangerAt: 75 }).warnAt, 55)

      const srcScript = path.join(REPO_ROOT, 'scripts', 'better-statusline.mjs')
      const res = ensureStatusLineInstalled(srcScript)
      assert.equal(res.installed, true)
      assert.equal(res.updatedSettings, true)
      assert.equal(fs.existsSync(`${settingsFile}.bak-better-agy`), true)

      const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
      assert.equal(saved.model, 'Gemini 4 Carbon (High)')
      assert.equal(saved.statusLine.stack_with_default, true)
      assert.match(saved.statusLine.command, /better-statusline(?:\.mjs)?$/)

      // Verify tm-hook session-start never downgrades native binary back to Node JS
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

describe('scripts/better-statusline.mjs', () => {
  it('renders enabled widgets and fits narrow terminal widths without overflowing', () => {
    withTempEnv((tmp) => {
      enableFakePlugins(tmp, ['context-meter', 'token-meter', 'sub-meter', 'narrator'])
      setPluginConfig('narrator', { enabled: true, language: 'es' })

      const payload = {
        conversation_id: 'conv-1',
        terminal_width: 120,
        context_window: {
          total_input_tokens: 12400,
          total_output_tokens: 3100,
          context_window_size: 200000,
          used_percentage: 58.2,
          current_usage: {
            input_tokens: 1200,
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

      const wide = formatStatusLine(payload, { nowMs: 16_000 })
      assert.equal(wide.includes('38;5;208m'), false, 'Google Gemini bucket uses electric blue, not amber')
      assert.equal(wide.includes('38;5;75m'), true, 'Antigravity electric blue ANSI must color Gemini gem and quota bar')
      const plainWide = wide.replace(/\x1b\[[0-9;]*m/g, '')
      assert.match(plainWide, /✦ 5h ━━━━━━──── 58% ↻ 2h 10m/)
      assert.match(plainWide, /⏵ narrator on · ES/)
      assert.ok(visibleWidth(wide) <= 118)

      // Verify 4-bucket rotation (4s default), ✻ Claude amber for 3p-*, and ❂ gray tones when active model is GPT
      const mixedPayload = {
        ...payload,
        model: { id: 'Gemini 4 Carbon (High)', display_name: 'Gemini 4 Carbon (High)' },
        quota: {
          '3p-5h': { remaining_fraction: 0.8, reset_in_seconds: 14400 },
          '3p-weekly': { remaining_fraction: 0.9, reset_in_seconds: 518400 },
          'gemini-5h': { remaining_fraction: 0.42, reset_in_seconds: 7800 },
          'gemini-weekly': { remaining_fraction: 0.69, reset_in_seconds: 273600 }
        }
      }
      const rot0 = formatStatusLine(mixedPayload, { nowMs: 0 }) // index 0 -> 3p-5h (Claude amber ✻)
      assert.equal(rot0.includes('38;5;208m'), true, '3p-5h defaults to Claude amber 38;5;208m')
      assert.match(rot0.replace(/\x1b\[[0-9;]*m/g, ''), /✻ 5h ━━──────── 20% ↻ 4h 0m/)

      const rot2 = formatStatusLine(mixedPayload, { nowMs: 8_000 }) // 8s / 4s = index 2 -> gemini-5h (Google blue ✦)
      assert.equal(rot2.includes('38;5;75m'), true)
      assert.match(rot2.replace(/\x1b\[[0-9;]*m/g, ''), /✦ 5h ━━━━━━──── 58% ↻ 2h 10m/)

      const gptMixed = {
        ...mixedPayload,
        model: { id: 'gpt-oss-120b-medium', display_name: 'GPT-OSS 120B (Medium)' }
      }
      const rotGpt = formatStatusLine(gptMixed, { nowMs: 0 }) // 3p-5h switches to ❂ silver/slate gray tones
      assert.equal(rotGpt.includes('38;5;252m'), true, 'GPT icon uses bright silver')
      assert.equal(rotGpt.includes('38;5;247m'), true, 'GPT bar uses slate gray')
      assert.equal(rotGpt.includes('38;5;208m'), false, 'GPT mode does not use amber')
      assert.match(rotGpt.replace(/\x1b\[[0-9;]*m/g, ''), /❂ 5h ━━──────── 20% ↻ 4h 0m/)

      const veryWide = formatStatusLine({ ...payload, terminal_width: 150 }, { nowMs: 16_000 })
      assert.match(veryWide.replace(/\x1b\[[0-9;]*m/g, ''), /context 58% · \/compact/)

      const narrow = formatStatusLine({ ...payload, terminal_width: 55 }, { nowMs: 16_000 })
      assert.ok(visibleWidth(narrow) <= 53)

      // Verify optional native C11 accelerator compiles cleanly and matches JS output byte-for-byte
      const resNative = ensureStatusLineInstalled(path.join(REPO_ROOT, 'scripts', 'better-statusline.mjs'), {
        force: true,
        preferNative: true
      })
      if (resNative.native) {
        writeState('turn-flags/conv-1.json', { thinkHard: true, useHydrogen: true })
        enableFakePlugins(tmp, ['think-hard', 'use-hydrogen'])
        for (const width of [150, 120, 85, 55]) {
          for (const [pCase, tNow] of [[payload, 16_000], [mixedPayload, 0], [mixedPayload, 8_000], [gptMixed, 0]]) {
            const testPayload = { ...pCase, terminal_width: width }
            const jsOut = formatStatusLine(testPayload, { nowMs: tNow })
            const cProc = spawnSync(resNative.targetScript, [], {
              env: { ...process.env, BETTER_AGY_NOW_MS: String(tNow) },
              input: JSON.stringify(testPayload),
              encoding: 'utf8'
            })
            assert.equal(cProc.status, 0, cProc.stderr)
            assert.equal(cProc.stdout.replace(/\n$/, ''), jsOut, `C11 vs JS mismatch at width=${width} tNow=${tNow}`)
          }
        }

        // Also verify quota-cache.json countdown & expiration parity when live payload omits quota
        const noQuotaPayload = { ...payload, quota: undefined, terminal_width: 120 }
        for (const futureNow of [16_000 + 600_000, 16_000 + 9_000_000]) {
          const jsCached = formatStatusLine(noQuotaPayload, { nowMs: futureNow })
          const cCached = spawnSync(resNative.targetScript, [], {
            env: { ...process.env, BETTER_AGY_NOW_MS: String(futureNow) },
            input: JSON.stringify(noQuotaPayload),
            encoding: 'utf8'
          })
          assert.equal(cCached.status, 0, cCached.stderr)
          assert.equal(cCached.stdout.replace(/\n$/, ''), jsCached, `Cached quota C11 vs JS mismatch at t=${futureNow}`)
        }
      }
    })
  })

  it('returns empty string when no HUD plugins are enabled', () => {
    withTempEnv(() => {
      const line = formatStatusLine({ terminal_width: 100 })
      assert.equal(line, '')
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
