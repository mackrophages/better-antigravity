import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { mayWrite } from '../plugins/time-machine/scripts/core/tools.mjs'
import { normalizeState, runCommandOnState } from '../plugins/after/scripts/core/queue-engine.mjs'
import { conciseSpokenSummary, guessLanguage, plain } from '../plugins/narrator/scripts/core/text.mjs'
import { parseBmp, renderAnsiRows } from '../shared/pixels.mjs'
import { excerptOf, languageOf, pathsIn } from '../plugins/quick-peek/scripts/core/peek-engine.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function makeEnv (tmp) {
  return {
    ...process.env,
    BETTER_AGY_TEST_HOME: tmp,
    BETTER_AGY_HOME: path.join(tmp, '.gemini', 'antigravity-cli', 'better-antigravity'),
    BETTER_AGY_PLUGINS_DIR: path.join(tmp, '.gemini', 'config', 'plugins'),
    BETTER_AGY_CONFIG_JSON: path.join(tmp, '.gemini', 'config', 'config.json'),
    BETTER_AGY_SETTINGS_JSON: path.join(tmp, '.gemini', 'antigravity-cli', 'settings.json'),
    CLAUDE_MEM_SIN_HOOK: ''
  }
}

function runNode (scriptRel, args = [], { input = '', cwd = ROOT, env = process.env } = {}) {
  const res = spawnSync(process.execPath, [path.join(ROOT, scriptRel), ...args], {
    input,
    cwd,
    env,
    encoding: 'utf8',
    timeout: 20_000
  })
  assert.equal(res.status, 0, `Script ${scriptRel} failed: ${res.stderr || res.stdout}`)
  return res.stdout
}

describe('Time Machine Antigravity hooks + /timeline CLI', () => {
  it('classifies Antigravity read vs write tools and read-only Bash accurately', () => {
    assert.equal(mayWrite('read_file', { Path: '/a' }), false)
    assert.equal(mayWrite('view_file', { AbsolutePath: '/a' }), false)
    assert.equal(mayWrite('grep_search', { Query: 'foo' }), false)
    assert.equal(mayWrite('write_file', { Path: '/a' }), true)
    assert.equal(mayWrite('edit_file', { Path: '/a' }), true)
    assert.equal(mayWrite('run_command', { CommandLine: 'git status && ls -la' }), false)
    assert.equal(mayWrite('run_command', { CommandLine: 'sed -i s/a/b/ file.txt' }), true)
  })

  it('snapshots working-tree changes via PreToolUse + Stop and rewinds/redoes via timeline-cli', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-e2e-'))
    const repo = path.join(tmp, 'repo')
    fs.mkdirSync(repo, { recursive: true })
    const env = makeEnv(tmp)

    try {
      spawnSync('git', ['init', '-b', 'main'], { cwd: repo })
      spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
      spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
      fs.writeFileSync(path.join(repo, 'app.js'), 'export const v = 1\n')
      fs.writeFileSync(path.join(repo, '.gitignore'), '.env\n')
      fs.writeFileSync(path.join(repo, '.env'), 'SECRET=keep-safe\n')
      spawnSync('git', ['add', 'app.js', '.gitignore'], { cwd: repo })
      spawnSync('git', ['commit', '-m', 'init'], { cwd: repo })

      // 1. PreToolUse before editing app.js
      const preOut = runNode('plugins/time-machine/scripts/tm-hook.mjs', ['pre-tool'], {
        cwd: repo,
        env,
        input: JSON.stringify({
          conversationId: 'sess-tm',
          cwd: repo,
          lastUserInput: 'bump version to 2',
          toolCall: { name: 'edit_file', args: { Path: path.join(repo, 'app.js') } }
        })
      })
      assert.equal(JSON.parse(preOut).decision, 'allow')

      // 2. Agent modifies app.js and creates extra.js
      fs.writeFileSync(path.join(repo, 'app.js'), 'export const v = 2\n')
      fs.writeFileSync(path.join(repo, 'extra.js'), 'export const extra = true\n')

      // 3. Stop hook snapshots state #1 (start) and #2 (bump version to 2)
      runNode('plugins/time-machine/scripts/tm-hook.mjs', ['stop'], {
        cwd: repo,
        env,
        input: JSON.stringify({ conversationId: 'sess-tm', cwd: repo, fullyIdle: true })
      })

      const listOut = runNode('plugins/time-machine/scripts/timeline-cli.mjs', ['--cwd', repo], { env })
      assert.match(listOut, /2 states/)
      assert.match(listOut, /#2  bump version to 2/)
      assert.match(listOut, /#1  start of the session/)

      // 4. Rewind to #1: extra.js disappears, app.js returns to v = 1, .env stays intact!
      const jumpOut = runNode('plugins/time-machine/scripts/timeline-cli.mjs', ['--cwd', repo, '1'], { env })
      assert.match(jumpOut, /Jumped to #1/)
      assert.equal(fs.readFileSync(path.join(repo, 'app.js'), 'utf8'), 'export const v = 1\n')
      assert.equal(fs.existsSync(path.join(repo, 'extra.js')), false)
      assert.equal(fs.readFileSync(path.join(repo, '.env'), 'utf8'), 'SECRET=keep-safe\n')

      // 5. PreInvocation notifies model once about the rewind
      const preInv = JSON.parse(runNode('plugins/time-machine/scripts/tm-hook.mjs', ['pre-invocation'], {
        cwd: repo,
        env,
        input: JSON.stringify({ conversationId: 'sess-tm', cwd: repo, invocationNum: 0 })
      }))
      assert.match(preInv.injectSteps[0].systemMessage.systemMessage, /Time Machine notice/)

      // 6. Redo returns to #2
      runNode('plugins/time-machine/scripts/timeline-cli.mjs', ['--cwd', repo, 'redo'], { env })
      assert.equal(fs.readFileSync(path.join(repo, 'app.js'), 'utf8'), 'export const v = 2\n')
      assert.equal(fs.existsSync(path.join(repo, 'extra.js')), true)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('After non-steering queue + Stop hook auto-continue', () => {
  it('supports EN/ES natural language queue ops and drains FIFO via Stop hook', () => {
    let st = normalizeState(null, { cwd: '/proj' })
    st = runCommandOnState(st, 'after', 'add unit tests for parser').state
    st = runCommandOnState(st, 'after', 'update the README').state
    st = runCommandOnState(st, 'before', 'lint the code first').state
    assert.deepEqual(st.items.map(i => i.text), [
      'lint the code first',
      'add unit tests for parser',
      'update the README'
    ])

    // Spanish natural-language removal: "quita lo del readme"
    const res = runCommandOnState(st, 'after', 'quita lo del readme')
    assert.equal(res.via, 'heuristics')
    assert.deepEqual(res.state.items.map(i => i.text), [
      'lint the code first',
      'add unit tests for parser'
    ])

    // E2E Stop hook FIFO drain
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'after-e2e-'))
    const proj = path.join(tmp, 'proj')
    fs.mkdirSync(proj, { recursive: true })
    const env = makeEnv(tmp)
    try {
      runNode('plugins/after/scripts/after-cli.mjs', ['--cwd', proj, 'after', 'task alpha'], { env })
      runNode('plugins/after/scripts/after-cli.mjs', ['--cwd', proj, 'after', 'task beta'], { env })

      const stop1 = JSON.parse(runNode('plugins/after/scripts/after-hook.mjs', ['stop'], {
        cwd: proj,
        env,
        input: JSON.stringify({ cwd: proj, fullyIdle: true, terminationReason: 'NO_TOOL_CALL' })
      }))
      assert.equal(stop1.decision, 'continue')
      assert.match(stop1.reason, /task alpha/)

      const stop2 = JSON.parse(runNode('plugins/after/scripts/after-hook.mjs', ['stop'], {
        cwd: proj,
        env,
        input: JSON.stringify({ cwd: proj, fullyIdle: true, terminationReason: 'NO_TOOL_CALL' })
      }))
      assert.equal(stop2.decision, 'continue')
      assert.match(stop2.reason, /task beta/)

      const stop3 = JSON.parse(runNode('plugins/after/scripts/after-hook.mjs', ['stop'], {
        cwd: proj,
        env,
        input: JSON.stringify({ cwd: proj, fullyIdle: true, terminationReason: 'NO_TOOL_CALL' })
      }))
      assert.deepEqual(stop3, {})
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('Narrator, Image Preview, Quick Peek, Think Hard, Use Hydrogen, and Commit', () => {
  it('cleans markdown for speech, detects Spanish/English, and preserves closing questions', () => {
    const md = 'He corregido el fallo en `src/auth/login.tsx` (commit `9a8b7c6d`). ¿Quieres que corra las pruebas?'
    assert.equal(guessLanguage(md), 'es')
    const cleaned = plain(md)
    assert.doesNotMatch(cleaned, /9a8b7c6d/)
    assert.match(cleaned, /login/)
    const sum = conciseSpokenSummary(md, 120)
    assert.match(sum, /¿Quieres que corra las pruebas\?$/)
  })

  it('decodes uncompressed 24-bit BMP and renders SVG icons via ffmpeg+librsvg+PIL', () => {
    // 2x2 24-bit BMP (top red, bottom blue)
    const header = Buffer.alloc(54)
    header.write('BM', 0)
    header.writeUInt32LE(54 + 16, 2)
    header.writeUInt32LE(54, 10)
    header.writeUInt32LE(40, 14)
    header.writeInt32LE(2, 18)
    header.writeInt32LE(2, 22)
    header.writeUInt16LE(1, 26)
    header.writeUInt16LE(24, 28)
    // bottom row (blue BGR = 255,0,0 x2 + 2 pad), top row (red BGR = 0,0,255 x2 + 2 pad)
    const pixelsBuf = Buffer.from([
      255, 0, 0, 255, 0, 0, 0, 0,
      0, 0, 255, 0, 0, 255, 0, 0
    ])
    const px = parseBmp(new Uint8Array(Buffer.concat([header, pixelsBuf])))
    assert.equal(px.width, 2)
    assert.equal(px.height, 2)
    const rendered = renderAnsiRows(px, 4, 2)
    assert.ok(rendered.lines.length >= 1)
    assert.match(rendered.lines[0], /\x1b\[38;2;/)

    // Real SVG preview via image-preview-cli AND quick-peek-cli
    const svgOut = runNode('plugins/image-preview/scripts/image-preview-cli.mjs', ['plugins/commit/assets/logo.svg'])
    assert.match(svgOut, /logo\.svg · SVG · 128x128/)
    const peekSvg = runNode('plugins/quick-peek/scripts/peek-cli.mjs', ['plugins/commit/assets/logo.svg'])
    assert.match(peekSvg, /logo\.svg · SVG · 128x128/)
  })

  it('extracts file:line paths ignoring URLs and centers syntax-highlighted excerpts', () => {
    const found = pathsIn('See https://example.com/a/b.ts and check `src/server.ts:15` or ./README.md.')
    assert.deepEqual(found.map(f => ({ target: f.target, line: f.line })), [
      { target: 'src/server.ts', line: 15 },
      { target: './README.md', line: undefined }
    ])
    const sample = Array.from({ length: 30 }, (_, i) => `const line${i + 1} = ${i + 1}`).join('\n')
    const ex = excerptOf(sample, languageOf('src/server.ts'), 15, 10)
    assert.equal(ex.mark, 15)
    assert.ok(ex.first <= 15 && ex.first + ex.lines.length > 15)
  })

  it('triggers + Think Hard and _ Use Hydrogen (ignoring __init__.py and subcalls), runs Hydrogen CLI, and flags .env in Commit', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-e2e-'))
    const repo = path.join(tmp, 'repo')
    fs.mkdirSync(repo, { recursive: true })
    const env = makeEnv(tmp)
    try {
      const th = JSON.parse(runNode('plugins/think-hard/scripts/think-hard-hook.mjs', ['pre'], {
        env,
        input: JSON.stringify({ conversationId: 'c1', invocationNum: 0, lastUserInput: '+audit the auth flow' })
      }))
      assert.match(th.injectSteps[0].systemMessage.systemMessage, /THINK HARD MODE/)

      const uhSkip = JSON.parse(runNode('plugins/use-hydrogen/scripts/use-hydrogen-hook.mjs', ['pre'], {
        env,
        input: JSON.stringify({ conversationId: 'c1', invocationNum: 0, lastUserInput: '__init__.py is failing' })
      }))
      assert.deepEqual(uhSkip, {})

      const uhSubcall = JSON.parse(runNode('plugins/use-hydrogen/scripts/use-hydrogen-hook.mjs', ['pre'], {
        env: { ...env, BETTER_AGY_SUBCALL: '1' },
        input: JSON.stringify({ conversationId: 'c1', invocationNum: 0, lastUserInput: '_summarize README' })
      }))
      assert.deepEqual(uhSubcall, {})

      const uhHit = JSON.parse(runNode('plugins/use-hydrogen/scripts/use-hydrogen-hook.mjs', ['pre'], {
        env,
        input: JSON.stringify({ conversationId: 'c1', invocationNum: 0, lastUserInput: '_summarize README' })
      }))
      assert.match(uhHit.injectSteps[0].systemMessage.systemMessage, /USE HYDROGEN MODE/)
      assert.match(uhHit.injectSteps[0].systemMessage.systemMessage, /gemini-4-hydrogen-high/)

      const setMed = runNode('plugins/use-hydrogen/scripts/use-hydrogen-cli.mjs', ['model', 'medium'], { env })
      assert.match(setMed, /gemini-4-hydrogen-medium/)
      const setHigh = runNode('plugins/use-hydrogen/scripts/use-hydrogen-cli.mjs', ['model', 'high'], { env })
      assert.match(setHigh, /gemini-4-hydrogen-high/)

      const mockAgy = path.join(tmp, 'mock-agy.mjs')
      fs.writeFileSync(mockAgy, [
        '#!/usr/bin/env node',
        "import fs from 'node:fs'",
        "import path from 'node:path'",
        'const args = process.argv.slice(2)',
        "const mIdx = args.indexOf('--model')",
        "const model = mIdx >= 0 ? args[mIdx + 1] : 'unknown'",
        "if (process.env.BETTER_AGY_SUBCALL !== '1') process.exit(2)",
        "const logDir = path.join(process.env.BETTER_AGY_TEST_HOME, '.gemini', 'antigravity-cli', 'brain', 'mock-h2', '.system_generated', 'logs')",
        'fs.mkdirSync(logDir, { recursive: true })',
        "fs.writeFileSync(path.join(logDir, 'transcript.jsonl'), JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', model, input_tokens: 500, output_tokens: 18, content: 'Summary ready' }) + '\\n')",
        "process.stdout.write(JSON.stringify({ conversation_id: 'mock-h2', status: 'SUCCESS', response: 'Summary ready\\n', duration_seconds: 2.4, num_turns: 1, usage: { input_tokens: 500, output_tokens: 18, total_tokens: 518 } }) + '\\n')"
      ].join('\n'), { mode: 0o755 })

      const runOut = runNode('plugins/use-hydrogen/scripts/use-hydrogen-cli.mjs', ['run', 'summarize README'], {
        env: { ...env, BETTER_AGY_BIN: mockAgy }
      })
      assert.match(runOut, /Summary ready/)
      assert.match(runOut, /Answered by gemini-4-hydrogen-high \(2\.4s · ↓ 18 tokens\)/)

      spawnSync('git', ['init', '-b', 'main'], { cwd: repo })
      fs.writeFileSync(path.join(repo, '.env.production'), 'API_KEY=123\n')
      fs.writeFileSync(path.join(repo, 'index.js'), 'console.log(1)\n')
      const commitCtx = JSON.parse(runNode('plugins/commit/scripts/commit-context.mjs', [], { cwd: repo, env }))
      assert.equal(commitCtx.isGitRepo, true)
      assert.deepEqual(commitCtx.secretCandidates, ['.env.production'])
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
