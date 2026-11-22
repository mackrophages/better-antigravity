#!/usr/bin/env node
// Deterministic Gemba benchmark suite for Better Antigravity using monotonic hrtime.bigint().
// Measures real process-spawn and algorithmic latencies across all hot paths.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const jsonOut = process.argv.includes('--json')

function nowMs () {
  return Number(process.hrtime.bigint()) / 1e6
}

function stats (samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  const p50 = sorted[Math.floor(sorted.length * 0.5)]
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
  const mean = samples.reduce((s, x) => s + x, 0) / samples.length
  return {
    p50: Number(p50.toFixed(2)),
    p95: Number(p95.toFixed(2)),
    mean: Number(mean.toFixed(2))
  }
}

function measure (runs, fn) {
  // 1 warmup run to stabilize OS page cache fairly for both baseline and post-fix
  fn()
  const samples = []
  for (let i = 0; i < runs; i++) {
    const t0 = nowMs()
    fn()
    samples.push(nowMs() - t0)
  }
  return stats(samples)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'better-agy-bench-'))
const repo = path.join(tmp, 'repo')
fs.mkdirSync(repo, { recursive: true })

const pluginsDir = path.join(tmp, '.gemini', 'config', 'plugins')
for (const p of [
  'quick-peek', 'image-preview', 'sub-meter', 'context-meter', 'commit',
  'time-machine', 'after', 'use-hydrogen', 'think-hard', 'token-meter'
]) {
  fs.mkdirSync(path.join(pluginsDir, p), { recursive: true })
  fs.writeFileSync(path.join(pluginsDir, p, 'plugin.json'), JSON.stringify({ name: p }))
}

const env = {
  ...process.env,
  BETTER_AGY_TEST_HOME: tmp,
  BETTER_AGY_HOME: path.join(tmp, '.gemini', 'antigravity-cli', 'better-antigravity'),
  BETTER_AGY_PLUGINS_DIR: pluginsDir,
  BETTER_AGY_CONFIG_JSON: path.join(tmp, '.gemini', 'config', 'config.json'),
  BETTER_AGY_SETTINGS_JSON: path.join(tmp, '.gemini', 'antigravity-cli', 'settings.json')
}
delete env.CLAUDE_MEM_SIN_HOOK
delete env.AGY_HEADLESS
delete env.BETTER_AGY_SUBCALL

// Initialize realistic git repo for Time Machine benchmarks
spawnSync('git', ['init', '-b', 'main'], { cwd: repo })
spawnSync('git', ['config', 'user.email', 'bench@example.com'], { cwd: repo })
spawnSync('git', ['config', 'user.name', 'Bench'], { cwd: repo })
for (let i = 0; i < 25; i++) {
  fs.writeFileSync(path.join(repo, `module-${i}.js`), `export const v${i} = ${i}\n`.repeat(30))
}
spawnSync('git', ['add', '.'], { cwd: repo })
spawnSync('git', ['commit', '-m', 'chore: seed repo'], { cwd: repo })

// Build a realistic 3,000-line (~1.6 MB) transcript.jsonl with heavy tool outputs
const transcriptPath = path.join(tmp, 'transcript.jsonl')
{
  const bigToolOutput = 'x'.repeat(600)
  const lines = []
  for (let i = 0; i < 3000; i++) {
    if (i % 25 === 0) {
      lines.push(JSON.stringify({
        step_index: i,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        content: `<USER_REQUEST>\nRefactor module ${i}\n</USER_REQUEST>`
      }))
    } else if (i % 5 === 0) {
      lines.push(JSON.stringify({
        step_index: i,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        model: 'gemini-4-carbon-high',
        input_tokens: 20_000 + i * 15,
        output_tokens: 240,
        cache_read_tokens: 14_000,
        content: i === 2995 ? 'Updated `module-1.js:12` cleanly.' : ''
      }))
    } else {
      lines.push(JSON.stringify({
        step_index: i,
        source: 'TOOL',
        type: 'GENERIC',
        tool_name: 'read_file',
        output: bigToolOutput
      }))
    }
  }
  fs.writeFileSync(transcriptPath, lines.join('\n') + '\n')
}

function runScript (relScript, args = [], inputObj = {}, cwd = repo) {
  const full = path.join(ROOT, relScript)
  const isShell = relScript.endsWith('.sh')
  const isBin = !relScript.endsWith('.mjs') && !relScript.endsWith('.cjs') && !isShell
  const cmd = isBin ? full : isShell ? '/bin/sh' : process.execPath
  const cmdArgs = isBin ? args : [full, ...args]
  const res = spawnSync(cmd, cmdArgs, {
    cwd,
    env,
    input: JSON.stringify(inputObj),
    encoding: 'utf8'
  })
  if (res.status !== 0) {
    throw new Error(`${relScript} exited ${res.status}: ${res.stderr || res.stdout}`)
  }
  return res.stdout
}

try {
  // 1. statusLine cold-spawn benchmark (runs every ~300ms in TUI)
  const statusPayload = {
    conversation_id: 'bench-conv',
    terminal_width: 120,
    workspace: { project_dir: repo },
    context_window: {
      total_input_tokens: 185000,
      total_output_tokens: 14200,
      context_window_size: 200000,
      used_percentage: 58.4,
      current_usage: { input_tokens: 65400, output_tokens: 410, cache_read_input_tokens: 48000, cache_creation_input_tokens: 0 }
    },
    quota: {
      'gemini-5h': { remaining_fraction: 0.62, reset_in_seconds: 9400 },
      'gemini-weekly': { remaining_fraction: 0.81, reset_in_seconds: 412000 }
    }
  }
  const statusLineScript = fs.existsSync(path.join(ROOT, 'scripts', 'better-statusline'))
    ? 'scripts/better-statusline'
    : fs.existsSync(path.join(ROOT, 'scripts', 'better-statusline.cjs'))
      ? 'scripts/better-statusline.cjs'
      : 'scripts/better-statusline.mjs'
  const statusLineBench = measure(12, () => {
    runScript(statusLineScript, [], statusPayload)
  })
  const statusLineJsFallbackBench = measure(10, () => {
    const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'better-statusline.mjs')], {
      cwd: repo,
      env: { ...env, BETTER_AGY_DISABLE_NATIVE: '1' },
      input: JSON.stringify(statusPayload),
      encoding: 'utf8'
    })
    if (res.status !== 0) throw new Error(res.stderr || res.stdout)
  })

  // 2. PreInvocation 5-hook chain mid-turn (invocationNum = 2 on 1.6 MB transcript, matching hooks.json)
  const prePayload = {
    conversationId: 'bench-conv',
    invocationNum: 2,
    cwd: repo,
    workspacePaths: [repo],
    transcriptPath,
    lastUserInput: 'Refactor module 1'
  }
  const preChainBench = measure(6, () => {
    runScript('plugins/after/scripts/lib/hook-gate.sh', ['after-pre'], prePayload)
    runScript('plugins/context-meter/scripts/lib/hook-gate.sh', ['context-meter-pre'], prePayload)
    runScript('plugins/think-hard/scripts/lib/hook-gate.sh', ['think-hard-pre'], prePayload)
    runScript('plugins/use-hydrogen/scripts/lib/hook-gate.sh', ['use-hydrogen-pre'], prePayload)
    runScript('plugins/time-machine/scripts/lib/hook-gate.sh', ['tm-pre-invocation'], prePayload)
  })

  // 3. PostInvocation quick-peek hook (autoCard: false default on 1.6 MB transcript)
  const postQuickPeekBench = measure(10, () => {
    runScript('plugins/quick-peek/scripts/lib/hook-gate.sh', ['quick-peek-post'], prePayload)
  })

  // 4. Stop token-meter hook on 1.6 MB transcript (incremental turn append simulation)
  const stopTokenBench = measure(10, () => {
    fs.appendFileSync(transcriptPath, JSON.stringify({
      step_index: 3001,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      model: 'gemini-4-carbon-high',
      input_tokens: 66000,
      output_tokens: 180,
      cache_read_tokens: 50000,
      content: 'Done.'
    }) + '\n')
    runScript('plugins/token-meter/scripts/token-meter-hook.mjs', [], prePayload)
  })

  // 5. Time Machine full 4-tool turn cycle (4x PreToolUse + Stop snapshot + next turn PreInvocation)
  let turnCounter = 0
  const timeMachineTurnBench = measure(5, () => {
    turnCounter++
    for (let t = 0; t < 4; t++) {
      runScript('plugins/time-machine/scripts/lib/hook-gate.sh', ['tm-pre-tool'], {
        conversationId: 'bench-tm',
        cwd: repo,
        lastUserInput: `Update module turn ${turnCounter}`,
        toolCall: { name: 'edit_file', args: { Path: path.join(repo, 'module-0.js') } }
      })
    }
    fs.writeFileSync(path.join(repo, 'module-0.js'), `export const v0 = ${turnCounter}\n`)
    runScript('plugins/time-machine/scripts/lib/hook-gate.sh', ['tm-stop'], {
      conversationId: 'bench-tm',
      cwd: repo,
      fullyIdle: true,
      lastUserInput: `Update module turn ${turnCounter}`
    })
    runScript('plugins/time-machine/scripts/lib/hook-gate.sh', ['tm-pre-invocation'], {
      conversationId: 'bench-tm',
      invocationNum: 0,
      cwd: repo,
      lastUserInput: 'Next prompt without rewind'
    })
  })

  // 6. Image Preview SVG decode + linear-light 8x8 render
  const svgLogo = path.join(ROOT, 'plugins', 'use-hydrogen', 'assets', 'logo.svg')
  const imagePreviewBench = measure(6, () => {
    runScript('plugins/image-preview/scripts/image-preview-cli.mjs', [svgLogo])
  })

  // 7. validate-all.mjs wall-clock (N=5) + web/index.html raw & gzipped size
  const validateBench = measure(5, () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'validate-all.mjs')], { cwd: ROOT, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(r.stderr || r.stdout)
  })

  const webBuf = fs.readFileSync(path.join(ROOT, 'web', 'index.html'))
  const webRawKb = Number((webBuf.length / 1024).toFixed(1))
  const webGzipKb = Number((zlib.gzipSync(webBuf, { level: 9 }).length / 1024).toFixed(1))

  const report = {
    statusLine_p50_ms: statusLineBench,
    statusLine_jsFallback_ms: statusLineJsFallbackBench,
    preInvocation_5hooks_ms: preChainBench,
    postInvocation_quickPeek_ms: postQuickPeekBench,
    stop_tokenMeter_1_6MB_ms: stopTokenBench,
    timeMachine_4tools_turn_ms: timeMachineTurnBench,
    imagePreview_svg_ms: imagePreviewBench,
    validateAll_11plugins_ms: validateBench,
    web_index_kb: { raw_kb: webRawKb, gzip_kb: webGzipKb }
  }

  if (jsonOut) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log('=== Better Antigravity Gemba Benchmark ===')
    for (const [k, v] of Object.entries(report)) {
      if (v.p50 !== undefined) {
        console.log(`  ${k.padEnd(30)} p50=${String(v.p50).padStart(7)} ms   p95=${String(v.p95).padStart(7)} ms   mean=${String(v.mean).padStart(7)} ms`)
      } else {
        console.log(`  ${k.padEnd(30)} raw=${v.raw_kb} KB   gzip=${v.gzip_kb} KB`)
      }
    }
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
