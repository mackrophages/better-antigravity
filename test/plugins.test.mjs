import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { mayWrite } from '../plugins/time-machine/scripts/core/tools.mjs'
import { normalizeState, runCommandOnState } from '../plugins/after/scripts/core/queue-engine.mjs'
import { conciseSpokenSummary, guessLanguage, plain } from '../plugins/narrator/scripts/core/text.mjs'
import { decodeMediaFile, openInSystemViewer, parseBmp, renderAnsiRows } from '../shared/pixels.mjs'
import { excerptOf, languageOf, pathsIn } from '../plugins/quick-peek/scripts/core/peek-engine.mjs'
import { PLUGIN_SHARED_FILES, findSyncDrift } from '../scripts/sync-shared.mjs'

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

function spawnNodeAsync (scriptRel, args = [], { input = '', cwd = ROOT, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(ROOT, scriptRel), ...args], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const out = []
    const err = []
    proc.stdout.on('data', b => out.push(b))
    proc.stderr.on('data', b => err.push(b))
    proc.on('error', reject)
    proc.on('close', status => resolve({
      status,
      stdout: Buffer.concat(out).toString('utf8'),
      stderr: Buffer.concat(err).toString('utf8')
    }))
    proc.stdin.end(input)
  })
}

describe('Time Machine Antigravity hooks + /timeline CLI + parallel lock safety (C1, M9)', () => {
  it('classifies Antigravity read vs write tools and read-only Bash accurately', () => {
    assert.equal(mayWrite('read_file', { Path: '/a' }), false)
    assert.equal(mayWrite('view_file', { AbsolutePath: '/a' }), false)
    assert.equal(mayWrite('grep_search', { Query: 'foo' }), false)
    assert.equal(mayWrite('write_file', { Path: '/a' }), true)
    assert.equal(mayWrite('edit_file', { Path: '/a' }), true)
    assert.equal(mayWrite('run_command', { CommandLine: 'git status && ls -la' }), false)
    assert.equal(mayWrite('run_command', { CommandLine: 'sed -i s/a/b/ file.txt' }), true)
    // Regression R2-6: chained commands mentioning timeline-cli.mjs and mutating `date -s` / `file -C` MUST count as writes!
    assert.equal(mayWrite('run_command', { CommandLine: 'node /path/to/timeline-cli.mjs --cwd /repo undo' }), false)
    assert.equal(mayWrite('run_command', { CommandLine: 'git status && rm -rf src # timeline-cli.mjs' }), true)
    assert.equal(mayWrite('run_command', { CommandLine: 'date -s "2026-01-01"' }), true)
    assert.equal(mayWrite('run_command', { CommandLine: 'file -C -m magic' }), true)
  })

  it('snapshots working-tree changes, manages O(1) jumped flag, waits on live PreToolUse locks, and reaps dead locks', async () => {
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

      // Regression C1 part A: Dead-PID lock must be reclaimed immediately without waiting 30s
      const tmDir = path.join(env.BETTER_AGY_HOME, 'time-machine')
      fs.mkdirSync(tmDir, { recursive: true })
      fs.writeFileSync(path.join(tmDir, 'pending-sess-tm.lock'), '99999999:deadbeef\n')

      const tDead0 = Date.now()
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
      assert.ok(Date.now() - tDead0 < 5_000, 'Dead PID lock must be reclaimed immediately')

      // Agent modifies app.js and creates extra.js
      fs.writeFileSync(path.join(repo, 'app.js'), 'export const v = 2\n')
      fs.writeFileSync(path.join(repo, 'extra.js'), 'export const extra = true\n')

      runNode('plugins/time-machine/scripts/tm-hook.mjs', ['stop'], {
        cwd: repo,
        env,
        input: JSON.stringify({ conversationId: 'sess-tm', cwd: repo, fullyIdle: true })
      })

      const listOut = runNode('plugins/time-machine/scripts/timeline-cli.mjs', ['--cwd', repo], { env })
      assert.match(listOut, /2 states/)
      assert.match(listOut, /#2  bump version to 2/)
      assert.match(listOut, /#1  start of the session/)

      // Rewind to #1 -> writes O(1) `jumped-sess-tm.flag` (M9)
      const jumpOut = runNode('plugins/time-machine/scripts/timeline-cli.mjs', ['--cwd', repo, '1'], { env })
      assert.match(jumpOut, /Jumped to #1/)
      assert.equal(fs.existsSync(path.join(tmDir, 'jumped-sess-tm.flag')), true)
      assert.equal(fs.readFileSync(path.join(repo, 'app.js'), 'utf8'), 'export const v = 1\n')
      assert.equal(fs.existsSync(path.join(repo, 'extra.js')), false)
      assert.equal(fs.readFileSync(path.join(repo, '.env'), 'utf8'), 'SECRET=keep-safe\n')

      // Gate delegates to PreInvocation once and clears `jumped-sess-tm.flag`
      const gatePath = path.join(ROOT, 'plugins', 'time-machine', 'scripts', 'lib', 'hook-gate.sh')
      const preInv = JSON.parse(spawnSync('/bin/sh', [gatePath, 'tm-pre-invocation'], {
        cwd: repo,
        env,
        input: JSON.stringify({ conversationId: 'sess-tm', cwd: repo, invocationNum: 0 }),
        encoding: 'utf8'
      }).stdout)
      assert.match(preInv.injectSteps[0].systemMessage.systemMessage, /Time Machine notice/)
      assert.equal(fs.existsSync(path.join(tmDir, 'jumped-sess-tm.flag')), false)

      // Redo returns to #2
      runNode('plugins/time-machine/scripts/timeline-cli.mjs', ['--cwd', repo, 'redo'], { env })
      assert.equal(fs.readFileSync(path.join(repo, 'app.js'), 'utf8'), 'export const v = 2\n')

      // Regression C1 part B: Live-PID lock holder causes concurrent pre-tool to WAIT until pending-<sid>.flag exists!
      const lockRace = path.join(tmDir, 'pending-sess-race.lock')
      const flagRace = path.join(tmDir, 'pending-sess-race.flag')
      const holder = spawn(process.execPath, ['-e', `
        const fs = require('node:fs');
        fs.writeFileSync(${JSON.stringify(lockRace)}, process.pid + ':live\\n');
        setTimeout(() => {
          fs.writeFileSync(${JSON.stringify(flagRace)}, ${JSON.stringify(repo)});
          fs.unlinkSync(${JSON.stringify(lockRace)});
          process.exit(0);
        }, 180);
      `], { stdio: 'ignore' })
      const holderDone = new Promise(r => holder.once('close', r))
      // Wait briefly until lock file is visible on disk
      while (!fs.existsSync(lockRace)) {
        await new Promise(r => setTimeout(r, 10))
      }
      const tWait0 = Date.now()
      const waiterRes = await spawnNodeAsync('plugins/time-machine/scripts/tm-hook.mjs', ['pre-tool'], {
        cwd: repo,
        env,
        input: JSON.stringify({
          conversationId: 'sess-race',
          cwd: repo,
          lastUserInput: 'parallel edit',
          toolCall: { name: 'write_file', args: { Path: path.join(repo, 'b.js') } }
        })
      })
      const waitedMs = Date.now() - tWait0
      assert.equal(waiterRes.status, 0)
      assert.equal(JSON.parse(waiterRes.stdout).decision, 'allow')
      assert.equal(fs.existsSync(flagRace), true, 'Waiter returned before baseline snapshot flag existed!')
      assert.ok(waitedMs >= 100, `Expected concurrent pre-tool to wait for live lock holder, returned in ${waitedMs}ms`)
      await holderDone
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('After non-steering queue + concurrent lock safety (I7)', () => {
  it('supports EN/ES natural language queue ops, drains FIFO, and preserves 100% of concurrent CLI + Stop updates', async () => {
    let st = normalizeState(null, { cwd: '/proj' })
    st = runCommandOnState(st, 'after', 'add unit tests for parser').state
    st = runCommandOnState(st, 'after', 'update the README').state
    st = runCommandOnState(st, 'before', 'lint the code first').state
    assert.deepEqual(st.items.map(i => i.text), [
      'lint the code first',
      'add unit tests for parser',
      'update the README'
    ])

    const res = runCommandOnState(st, 'after', 'quita lo del readme')
    assert.equal(res.via, 'heuristics')
    assert.deepEqual(res.state.items.map(i => i.text), [
      'lint the code first',
      'add unit tests for parser'
    ])

    // Concurrent stress test (I7): 8 simultaneous `after-cli.mjs` processes + 1 `after-hook.mjs stop`
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'after-e2e-'))
    const proj = path.join(tmp, 'proj')
    fs.mkdirSync(proj, { recursive: true })
    const env = makeEnv(tmp)
    try {
      runNode('plugins/after/scripts/after-cli.mjs', ['--cwd', proj, 'after', 'seed-0'], { env })

      const jobs = []
      for (let i = 1; i <= 8; i++) {
        jobs.push(spawnNodeAsync('plugins/after/scripts/after-cli.mjs', ['--cwd', proj, 'after', `concurrent-${i}`], { env }))
      }
      jobs.push(spawnNodeAsync('plugins/after/scripts/after-hook.mjs', ['stop'], {
        cwd: proj,
        env,
        input: JSON.stringify({ cwd: proj, fullyIdle: true, terminationReason: 'NO_TOOL_CALL' })
      }))

      const results = await Promise.all(jobs)
      for (const r of results) assert.equal(r.status, 0, r.stderr)

      // Drain all remaining tasks via Stop hook and verify every single task (`seed-0` + `concurrent-1..8` = 9 total) ran!
      const executed = []
      const firstStop = JSON.parse(results[results.length - 1].stdout)
      if (firstStop.decision === 'continue') executed.push(firstStop.reason)

      for (let step = 0; step < 12; step++) {
        const nextStop = JSON.parse(runNode('plugins/after/scripts/after-hook.mjs', ['stop'], {
          cwd: proj,
          env,
          input: JSON.stringify({ cwd: proj, fullyIdle: true, terminationReason: 'NO_TOOL_CALL' })
        }))
        if (nextStop.decision !== 'continue') break
        executed.push(nextStop.reason)
      }

      assert.equal(executed.length, 9, `Expected all 9 tasks without lost updates, got ${executed.length}:\n${executed.join('\n')}`)
      for (let i = 1; i <= 8; i++) {
        assert.ok(executed.some(line => line.includes(`concurrent-${i}`)), `Lost concurrent-${i}`)
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('Security, media allowlist, Quick Peek `#` encoding, Secret diff stripping, and Selective Sync', () => {
  it('cleans markdown for speech, detects Spanish/English, and preserves closing questions', () => {
    const md = 'He corregido el fallo en `src/auth/login.tsx` (commit `9a8b7c6d`). ¿Quieres que corra las pruebas?'
    assert.equal(guessLanguage(md), 'es')
    const cleaned = plain(md)
    assert.doesNotMatch(cleaned, /9a8b7c6d/)
    assert.match(cleaned, /login/)
    const sum = conciseSpokenSummary(md, 120)
    assert.match(sum, /¿Quieres que corra las pruebas\?$/)
  })

  it('decodes BMP/SVG, enforces ffmpeg protocol_whitelist (M6), and blocks executable extensions in open (M7)', () => {
    const header = Buffer.alloc(54)
    header.write('BM', 0)
    header.writeUInt32LE(54 + 16, 2)
    header.writeUInt32LE(54, 10)
    header.writeUInt32LE(40, 14)
    header.writeInt32LE(2, 18)
    header.writeInt32LE(2, 22)
    header.writeUInt16LE(1, 26)
    header.writeUInt16LE(24, 28)
    const pixelsBuf = Buffer.from([
      255, 0, 0, 255, 0, 0, 0, 0,
      0, 0, 255, 0, 0, 255, 0, 0
    ])
    const px = parseBmp(new Uint8Array(Buffer.concat([header, pixelsBuf])))
    assert.equal(px.width, 2)
    assert.equal(px.height, 2)
    const rendered = renderAnsiRows(px, 4, 2)
    assert.match(rendered.lines[0], /\x1b\[38;2;/)

    const svgOut = runNode('plugins/image-preview/scripts/image-preview-cli.mjs', ['plugins/commit/assets/logo.svg'])
    assert.match(svgOut, /logo\.svg · SVG · 128x128/)
    const peekSvg = runNode('plugins/quick-peek/scripts/peek-cli.mjs', ['plugins/commit/assets/logo.svg'])
    assert.match(peekSvg, /logo\.svg · SVG · 128x128/)

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'media-sec-'))
    try {
      // M6: HLS playlist disguised as .png must be rejected by ffmpeg -protocol_whitelist file,pipe
      const fakePng = path.join(tmp, 'playlist.png')
      fs.writeFileSync(fakePng, '#EXTM3U\n#EXT-X-TARGETDURATION:5\nhttp://127.0.0.1:9/steal.ts\n')
      assert.equal(decodeMediaFile(fakePng, 64), null)

      // M7: Refuses opening .sh, .exe, and .desktop in system viewer
      assert.equal(openInSystemViewer(path.join(tmp, 'payload.exe')).refused, true)
      assert.equal(openInSystemViewer(path.join(tmp, 'payload.desktop')).refused, true)
      const evilSh = path.join(tmp, 'evil.sh')
      fs.writeFileSync(evilSh, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
      const cliOpen = spawnSync(process.execPath, [
        path.join(ROOT, 'plugins/image-preview/scripts/image-preview-cli.mjs'),
        'open',
        evilSh
      ], { encoding: 'utf8' })
      assert.notEqual(cliOpen.status, 0)
      assert.match(cliOpen.stderr, /Refused to open unsupported file type/)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('encodes `#`, `?`, `(`, `)` in Quick Peek file:// URLs (Pulido) and uses O(1) tail answer reader (M8)', () => {
    const found = pathsIn('See https://example.com/a/b.ts and check `src/server.ts:15` or ./README.md.')
    assert.deepEqual(found.map(f => ({ target: f.target, line: f.line })), [
      { target: 'src/server.ts', line: 15 },
      { target: './README.md', line: undefined }
    ])
    const sample = Array.from({ length: 30 }, (_, i) => `const line${i + 1} = ${i + 1}`).join('\n')
    const ex = excerptOf(sample, languageOf('src/server.ts'), 15, 10)
    assert.equal(ex.mark, 15)

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'peek-hash-'))
    const env = makeEnv(tmp)
    try {
      fs.mkdirSync(env.BETTER_AGY_HOME, { recursive: true })
      fs.writeFileSync(path.join(env.BETTER_AGY_HOME, 'config.json'), JSON.stringify({
        plugins: { 'quick-peek': { autoCard: true } }
      }))
      const trickyFile = path.join(tmp, 'notes#v2(draft).md')
      fs.writeFileSync(trickyFile, '# Heading\nLine 2\n')
      const txPath = path.join(tmp, 'tx.jsonl')
      fs.writeFileSync(txPath, JSON.stringify({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        input_tokens: 100,
        output_tokens: 20,
        content: 'Updated `notes#v2(draft).md:2`.'
      }) + '\n')

      const card = JSON.parse(runNode('plugins/quick-peek/scripts/peek-hook.mjs', [], {
        cwd: tmp,
        env,
        input: JSON.stringify({ cwd: tmp, transcriptPath: txPath })
      }))
      const md = card.injectSteps[0].systemMessage.metadata.user_markdown
      assert.match(md, /notes%23v2%28draft%29\.md#L2/, `Expected %23 encoding for '#' before #L2, got: ${md}`)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('triggers + Think Hard / _ Use Hydrogen, and excludes secret file contents from /commit diffExcerpt (I5)', () => {
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

      const uhHit = JSON.parse(runNode('plugins/use-hydrogen/scripts/use-hydrogen-hook.mjs', ['pre'], {
        env,
        input: JSON.stringify({ conversationId: 'c1', invocationNum: 0, lastUserInput: '_summarize README' })
      }))
      assert.match(uhHit.injectSteps[0].systemMessage.systemMessage, /gemini-4-hydrogen-high/)

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
      assert.match(runOut, /Answered by gemini-4-hydrogen-high \(2\.4s · ↓ 18 tokens\)/)

      // Regression I5: Tracked `.env.local` and `tls.pem` modified -> contents MUST NOT leak into diffExcerpt or diffStat!
      spawnSync('git', ['init', '-b', 'main'], { cwd: repo })
      spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
      spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
      fs.writeFileSync(path.join(repo, '.env.local'), 'DB_PASS=old\n')
      fs.writeFileSync(path.join(repo, 'tls.pem'), 'OLD_PEM\n')
      fs.writeFileSync(path.join(repo, 'index.js'), 'export const a = 1\n')
      spawnSync('git', ['add', '.env.local', 'tls.pem', 'index.js'], { cwd: repo })
      spawnSync('git', ['commit', '-m', 'chore: init'], { cwd: repo })

      fs.writeFileSync(path.join(repo, '.env.local'), 'DB_PASS=SUPER_SECRET_LEAK_TOKEN_999\n')
      fs.writeFileSync(path.join(repo, 'tls.pem'), 'PRIVATE_KEY_PAYLOAD_888\n')
      fs.writeFileSync(path.join(repo, '.env.production'), 'API_KEY=UNTRACKED_SECRET_777\n')
      fs.writeFileSync(path.join(repo, 'index.js'), 'export const a = 2\n')

      const commitCtx = JSON.parse(runNode('plugins/commit/scripts/commit-context.mjs', [], { cwd: repo, env }))
      assert.equal(commitCtx.isGitRepo, true)
      assert.deepEqual(commitCtx.secretCandidates.sort(), ['.env.local', '.env.production', 'tls.pem'])
      assert.equal(commitCtx.files.find(f => f.path === '.env.local')?.status, ' M')
      assert.doesNotMatch(commitCtx.diffExcerpt, /SUPER_SECRET_LEAK_TOKEN_999/, '.env.local secret leaked into diffExcerpt!')
      assert.doesNotMatch(commitCtx.diffExcerpt, /PRIVATE_KEY_PAYLOAD_888/, 'tls.pem secret leaked into diffExcerpt!')
      assert.doesNotMatch(commitCtx.diffStat, /\.env\.local|tls\.pem/, 'Secret paths must be excluded from diffStat')
      assert.match(commitCtx.diffExcerpt, /\+export const a = 2/, 'Safe code diff must still appear in diffExcerpt')

      // Regression R2-3: Running `/commit` from a nested subdirectory (`repo/src`) must still exclude `src/.env.sub`
      // from diffStat/diffExcerpt AND include root-level `index.js` changes!
      const subDir = path.join(repo, 'src')
      fs.mkdirSync(subDir, { recursive: true })
      fs.writeFileSync(path.join(subDir, '.env.sub'), 'SUB_OLD=1\n')
      spawnSync('git', ['add', 'src/.env.sub'], { cwd: repo })
      spawnSync('git', ['commit', '-m', 'chore: add sub env'], { cwd: repo })
      fs.writeFileSync(path.join(subDir, '.env.sub'), 'SUB_OLD=SUB_SECRET_555\n')

      const subCommitCtx = JSON.parse(runNode('plugins/commit/scripts/commit-context.mjs', [], { cwd: subDir, env }))
      assert.ok(subCommitCtx.secretCandidates.includes('src/.env.sub'))
      assert.doesNotMatch(subCommitCtx.diffStat, /\.env\.sub|\.env\.local|tls\.pem/, 'Subdir diffStat must exclude nested secrets')
      assert.doesNotMatch(subCommitCtx.diffExcerpt, /SUB_SECRET_555|SUPER_SECRET_LEAK_TOKEN_999/)
      assert.match(subCommitCtx.diffExcerpt, /\+export const a = 2/, 'Subdir /commit must still include root-level index.js diff')
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('enforces zero SHA-256 sync drift and minimal selective shared copies per plugin', () => {
    const drift = findSyncDrift()
    assert.deepEqual(drift, [], `Shared library drift detected:\n${drift.join('\n')}`)

    assert.deepEqual(PLUGIN_SHARED_FILES.commit, ['store.mjs'])
    assert.deepEqual(PLUGIN_SHARED_FILES['image-preview'], ['pixels.mjs'])

    // Verify every `lib/<file>` referenced by any plugin hook or script is declared in PLUGIN_SHARED_FILES
    const pluginsDir = path.join(ROOT, 'plugins')
    for (const name of fs.readdirSync(pluginsDir)) {
      const pDir = path.join(pluginsDir, name)
      if (!fs.statSync(pDir).isDirectory()) continue
      const allowed = new Set(PLUGIN_SHARED_FILES[name] || [])
      const scanFiles = []
      const hooksJson = path.join(pDir, 'hooks.json')
      if (fs.existsSync(hooksJson)) scanFiles.push(hooksJson)

      const walk = (d) => {
        if (!fs.existsSync(d)) return
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.name === 'lib') continue
          const full = path.join(d, e.name)
          if (e.isDirectory()) walk(full)
          else if (e.name.endsWith('.mjs') || e.name.endsWith('.json')) scanFiles.push(full)
        }
      }
      walk(path.join(pDir, 'scripts'))

      for (const sf of scanFiles) {
        const content = fs.readFileSync(sf, 'utf8')
        for (const m of content.matchAll(/(?:\.\.?\/scripts)?\/lib\/([a-zA-Z0-9_.-]+)/g)) {
          assert.equal(allowed.has(m[1]), true, `Plugin ${name} references lib/${m[1]} in ${path.basename(sf)} without declaring it in PLUGIN_SHARED_FILES`)
        }
        if (content.includes('ensureStatusLineInstalled')) {
          assert.equal(allowed.has('better-statusline.mjs'), true, `${name} calls ensureStatusLineInstalled without better-statusline.mjs`)
          assert.equal(allowed.has('better-statusline.c'), true, `${name} calls ensureStatusLineInstalled without better-statusline.c`)
        }
      }
      if (allowed.has('hook-gate.sh') && fs.existsSync(hooksJson) && fs.readFileSync(hooksJson, 'utf8').includes('ensure-hud')) {
        assert.equal(allowed.has('ensure-hud.mjs'), true, `${name} uses ensure-hud gate without ensure-hud.mjs`)
      }
    }
  })
})
