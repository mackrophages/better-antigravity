#!/usr/bin/env node
// Deterministic parallel git inspection + NUL-safe porcelain secret guard for /commit.
// Secret candidate files (.env*, *.pem, *.key, credentials*, id_rsa*, etc.) are flagged by path
// AND excluded from `git diff` + stripped from `diffExcerpt` so secret contents never enter model context.
import { spawn } from 'node:child_process'
import { getPluginConfig, setPluginConfig } from './lib/store.mjs'

const args = process.argv.slice(2)
if (args[0] === '--set-language' && args[1]) {
  const cfg = setPluginConfig('commit', { language: args[1] })
  console.log(`Commit language set to: ${cfg.language}`)
  process.exit(0)
}

function gitAsync (argv, maxBytes = 65_536, cwd = process.cwd()) {
  return new Promise((resolve) => {
    const proc = spawn('git', argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    const out = []
    const err = []
    let outBytes = 0
    proc.stdout.on('data', (b) => {
      if (outBytes < maxBytes) {
        const room = maxBytes - outBytes
        out.push(b.length > room ? b.subarray(0, room) : b)
        outBytes += Math.min(b.length, room)
      }
    })
    proc.stderr.on('data', (b) => {
      if (err.length < 16) err.push(b)
    })
    proc.on('error', () => resolve({ ok: false, raw: '', err: 'spawn failed' }))
    proc.on('close', (code) => resolve({
      ok: code === 0,
      raw: Buffer.concat(out).toString('utf8'),
      err: Buffer.concat(err).toString('utf8').trim()
    }))
  })
}

// Always execute from repo toplevel so status porcelain paths and `:(exclude,literal)` pathspecs
// align 100% even when `/commit` is invoked inside a nested subdirectory.
const topRes = await gitAsync(['rev-parse', '--show-toplevel'], 4096)
const repoTop = topRes.raw.trim()
if (!topRes.ok || !repoTop) {
  console.log(JSON.stringify({ isGitRepo: false, error: 'Current directory is not inside a git repository.' }, null, 2))
  process.exit(0)
}

const SECRET_RE = /(?:^|\/)(?:\.env(?:\..+)?|.*\.(?:pem|key|p12|pfx|keystore|enc)|.*(?:credentials|secret|id_rsa|id_ed25519).*)$/i
const SAFE_ENV_RE = /\.(?:example|sample|template)$/i
const isSecretPath = (p) => Boolean(p) && SECRET_RE.test(p) && !SAFE_ENV_RE.test(p)

function stripSecretDiffHunks (rawDiff) {
  if (!rawDiff) return ''
  const chunks = rawDiff.split(/^(?=diff --git )/m)
  const safeChunks = []
  for (const chunk of chunks) {
    if (!chunk.startsWith('diff --git ')) {
      safeChunks.push(chunk)
      continue
    }
    const hdrLine = chunk.slice(0, chunk.indexOf('\n') === -1 ? chunk.length : chunk.indexOf('\n'))
    const m = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/.exec(hdrLine)
    if (m && (isSecretPath(m[1]) || isSecretPath(m[2]))) {
      continue
    }
    safeChunks.push(chunk)
  }
  return safeChunks.join('')
}

const [branchRes, statusRes, recentRes, remoteRes] = await Promise.all([
  gitAsync(['branch', '--show-current'], 1024, repoTop),
  gitAsync(['status', '--porcelain=v1', '-z'], 4 * 1024 * 1024, repoTop),
  gitAsync(['log', '--oneline', '-10'], 8192, repoTop),
  gitAsync(['remote', '-v'], 4096, repoTop)
])

// Parse NUL-delimited `git status --porcelain=v1 -z` preserving leading spaces (e.g. " M .env")
// and handling rename/copy two-path entries (`R  dest\0orig\0`).
const files = []
const excludedSecretSet = new Set()
if (statusRes.raw) {
  const parts = statusRes.raw.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (!entry || entry.length < 4) continue
    const xy = entry.slice(0, 2)
    const dest = entry.slice(3)
    let orig = ''
    if (xy[0] === 'R' || xy[0] === 'C') {
      orig = parts[++i] || ''
    }
    const secretCandidate = isSecretPath(dest) || isSecretPath(orig)
    if (secretCandidate) {
      if (dest) excludedSecretSet.add(dest)
      if (orig) excludedSecretSet.add(orig)
    }
    files.push({
      status: xy,
      path: dest,
      ...(orig ? { origPath: orig } : {}),
      secretCandidate
    })
  }
}

const excludeArgs = excludedSecretSet.size > 0
  ? ['--', '.', ...Array.from(excludedSecretSet).map(p => `:(exclude,literal)${p}`)]
  : []

const [headStat, headPatch] = await Promise.all([
  gitAsync(['diff', 'HEAD', '--stat', ...excludeArgs], 32_768, repoTop),
  gitAsync(['diff', 'HEAD', ...excludeArgs], 65_536, repoTop)
])

const [diffStatRes, diffPatchRes] = headStat.ok && headPatch.ok
  ? [headStat, headPatch]
  : await Promise.all([
      headStat.ok ? Promise.resolve(headStat) : gitAsync(['diff', '--cached', '--stat', ...excludeArgs], 32_768, repoTop),
      headPatch.ok ? Promise.resolve(headPatch) : gitAsync(['diff', '--cached', ...excludeArgs], 65_536, repoTop)
    ])

const safePatch = stripSecretDiffHunks(diffPatchRes.raw)
const recentClean = recentRes.raw.replace(/\r?\n$/, '')
const cfg = getPluginConfig('commit', { language: 'English' })
console.log(JSON.stringify({
  isGitRepo: true,
  branch: branchRes.raw.trim() || '(detached HEAD)',
  hasRemote: Boolean(remoteRes.raw.trim()),
  commitLanguage: cfg.language || 'English',
  fileCount: files.length,
  secretCandidates: files.filter(f => f.secretCandidate).map(f => f.path),
  files,
  recentCommits: recentClean ? recentClean.split('\n') : [],
  diffStat: diffStatRes.raw.trim(),
  diffExcerpt: safePatch.slice(0, 24_000).trim()
}, null, 2))
