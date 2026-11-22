#!/usr/bin/env node
// Executes a prompt directly on Gemini 4 Hydrogen via `agy --model gemini-4-hydrogen-*`
// and verifies the answering model in transcript.jsonl (Antigravity's balanced analog to Use Haiku).
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  ensureStatusLineInstalled,
  getPluginConfig,
  homeDir,
  isHeadless,
  setPluginConfig,
  shortTokens
} from './lib/store.mjs'
import { summarizeTranscript } from './lib/transcript.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_MODEL = 'gemini-4-hydrogen-high'
const VARIANTS = {
  low: 'gemini-4-hydrogen-low',
  medium: 'gemini-4-hydrogen-medium',
  high: 'gemini-4-hydrogen-high',
  xhigh: 'gemini-4-hydrogen-xhigh',
  'gemini-4-hydrogen-low': 'gemini-4-hydrogen-low',
  'gemini-4-hydrogen-medium': 'gemini-4-hydrogen-medium',
  'gemini-4-hydrogen-high': 'gemini-4-hydrogen-high',
  'gemini-4-hydrogen-xhigh': 'gemini-4-hydrogen-xhigh'
}

function resolveVariant (raw) {
  const key = String(raw || '').trim().toLowerCase()
  return VARIANTS[key] || null
}

const args = process.argv.slice(2)
let rawOutput = false
let cwd = process.cwd()
const positional = []

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--raw') {
    rawOutput = true
  } else if (args[i] === '--cwd' && args[i + 1]) {
    cwd = args[++i]
  } else {
    positional.push(args[i])
  }
}

const [sub = 'status', ...rest] = positional
const cfg = getPluginConfig('use-hydrogen', { model: DEFAULT_MODEL })
const activeModel = resolveVariant(process.env.AGY_HYDROGEN_MODEL) || resolveVariant(cfg.model) || DEFAULT_MODEL

if (sub === 'setup') {
  const res = ensureStatusLineInstalled(path.join(here, 'lib', 'better-statusline.mjs'), { force: true })
  console.log(`Use Hydrogen statusLine configured: ${res.targetScript}`)
  process.exit(0)
}

if (sub === 'status') {
  console.log(`Use Hydrogen · active model: ${activeModel} (variants: low, medium, high, xhigh)`)
  process.exit(0)
}

if (sub === 'model' || sub === 'effort') {
  if (rest[0] === '--id') {
    process.stdout.write(`${activeModel}\n`)
    process.exit(0)
  }
  if (rest.length === 0) {
    console.log(`Use Hydrogen · active model: ${activeModel} (variants: low, medium, high, xhigh)`)
    process.exit(0)
  }
  const chosen = resolveVariant(rest[0])
  if (!chosen) {
    console.error(`Unknown Hydrogen variant "${rest[0]}". Choose one of: low, medium, high, xhigh.`)
    process.exit(1)
  }
  setPluginConfig('use-hydrogen', { model: chosen })
  console.log(`Use Hydrogen · model set to ${chosen}`)
  process.exit(0)
}

const promptText = sub === 'run' ? rest.join(' ').trim() : [sub, ...rest].join(' ').trim()
if (!promptText) {
  console.error('Usage: use-hydrogen-cli.mjs <run "<prompt>" | status | model [low|medium|high|xhigh] | setup>')
  process.exit(1)
}

const agyBin = process.env.BETTER_AGY_BIN || 'agy'
const wasHeadless = isHeadless()
const childEnv = {
  ...process.env,
  BETTER_AGY_SUBCALL: '1',
  CLAUDE_MEM_SIN_HOOK: '1'
}

const proc = spawnSync(
  agyBin,
  ['--model', activeModel, '--disable-slash-commands', '--output-format', 'json', '-p', promptText],
  {
    cwd,
    env: childEnv,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  }
)

if (proc.status !== 0) {
  const errMsg = (proc.stderr || proc.stdout || `agy exited with code ${proc.status}`).trim()
  console.error(`Use Hydrogen execution failed (${activeModel}): ${errMsg}`)
  process.exit(proc.status || 1)
}

const stdout = String(proc.stdout || '').trim()
let parsed = null
for (const line of stdout.split('\n').reverse()) {
  const t = line.trim()
  if (t.startsWith('{') && t.endsWith('}')) {
    try {
      parsed = JSON.parse(t)
      break
    } catch {}
  }
}

if (!parsed) {
  process.stdout.write(stdout + '\n')
  process.exit(0)
}

let apiModel = activeModel
if (parsed.conversation_id) {
  const tPath = path.join(
    homeDir(),
    '.gemini',
    'antigravity-cli',
    'brain',
    parsed.conversation_id,
    '.system_generated',
    'logs',
    'transcript.jsonl'
  )
  if (fs.existsSync(tPath)) {
    const sum = summarizeTranscript(tPath)
    if (sum.model) apiModel = sum.model
  }
}

const body = String(parsed.response ?? '').replace(/\s+$/, '')
if (rawOutput || wasHeadless) {
  process.stdout.write(`${body}\n`)
  process.exit(0)
}

const dur = typeof parsed.duration_seconds === 'number' ? `${parsed.duration_seconds.toFixed(1)}s` : ''
const outTok = parsed.usage?.output_tokens != null ? `↓ ${shortTokens(parsed.usage.output_tokens)} tokens` : ''
const metaParts = [dur, outTok].filter(Boolean).join(' · ')
const suffix = metaParts ? ` (${metaParts})` : ''
const footer = apiModel === activeModel
  ? `⚡ Answered by ${apiModel}${suffix}`
  : `⚠ Requested ${activeModel}, answered by ${apiModel}${suffix}`

process.stdout.write(`${body}\n\n${footer}\n`)
