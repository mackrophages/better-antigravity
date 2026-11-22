#!/usr/bin/env node
// Deterministic git inspection + secret guard for /commit.
import { spawnSync } from 'node:child_process'
import { getPluginConfig, setPluginConfig } from './lib/store.mjs'

const args = process.argv.slice(2)
if (args[0] === '--set-language' && args[1]) {
  const cfg = setPluginConfig('commit', { language: args[1] })
  console.log(`Commit language set to: ${cfg.language}`)
  process.exit(0)
}

function git (...argv) {
  const res = spawnSync('git', argv, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  return { ok: res.status === 0, out: (res.stdout || '').trim(), err: (res.stderr || '').trim() }
}

const inside = git('rev-parse', '--is-inside-work-tree')
if (!inside.ok || inside.out !== 'true') {
  console.log(JSON.stringify({ isGitRepo: false, error: 'Current directory is not inside a git repository.' }, null, 2))
  process.exit(0)
}

const branch = git('branch', '--show-current').out || '(detached HEAD)'
const statusRaw = git('status', '--porcelain=v1').out
const recent = git('log', '--oneline', '-10').out
const remote = git('remote', '-v').out
const diffStat = git('diff', 'HEAD', '--stat').ok ? git('diff', 'HEAD', '--stat').out : git('diff', '--cached', '--stat').out
const diffPatch = (git('diff', 'HEAD').ok ? git('diff', 'HEAD').out : git('diff', '--cached').out).slice(0, 24_000)

const SECRET_RE = /(?:^|\/)(?:\.env(?:\..+)?|.*\.(?:pem|key|p12|pfx|keystore|enc)|.*(?:credentials|secret|id_rsa|id_ed25519).*)$/i
const SAFE_ENV_RE = /\.(?:example|sample|template)$/i

const files = statusRaw
  ? statusRaw.split('\n').filter(Boolean).map(line => {
      const xy = line.slice(0, 2)
      const file = line.slice(3).trim().replace(/^"(.*)"$/, '$1')
      const isSecret = SECRET_RE.test(file) && !SAFE_ENV_RE.test(file)
      return { status: xy, path: file, secretCandidate: isSecret }
    })
  : []

const cfg = getPluginConfig('commit', { language: 'English' })
console.log(JSON.stringify({
  isGitRepo: true,
  branch,
  hasRemote: Boolean(remote),
  commitLanguage: cfg.language || 'English',
  fileCount: files.length,
  secretCandidates: files.filter(f => f.secretCandidate).map(f => f.path),
  files,
  recentCommits: recent ? recent.split('\n') : [],
  diffStat,
  diffExcerpt: diffPatch
}, null, 2))
