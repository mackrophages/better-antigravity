// Isolated git snapshot engine for Time Machine (adapted from DiegoMarty & midudev).
import { spawn } from 'node:child_process'

export const REF_ROOT = 'refs/time-machine'
const IDENTITY = {
  GIT_AUTHOR_NAME: 'time-machine',
  GIT_AUTHOR_EMAIL: 'time-machine@localhost',
  GIT_COMMITTER_NAME: 'time-machine',
  GIT_COMMITTER_EMAIL: 'time-machine@localhost'
}
const TIMEOUT_MS = 120_000
const MAX_OUTPUT = 4 * 1024 * 1024
const PATHS_PER_CALL = 500
const seededFrom = new Map()

export class MoveBlocked extends Error {
  constructor (paths, why) {
    super(why ?? `it would write over ignored files no snapshot holds (${paths.join(', ')})`)
    this.name = 'MoveBlocked'
    this.paths = paths
  }
}

/** Real child_process runner matching the `run(argv, init)` contract. */
export function nodeRun (argv, init = {}) {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = argv
    const proc = spawn(cmd, args, {
      cwd: init.cwd || process.cwd(),
      env: init.env ? { ...process.env, ...init.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let outLen = 0
    let truncated = false
    const outChunks = []
    const errChunks = []
    const timer = init.timeoutMs
      ? setTimeout(() => { proc.kill('SIGKILL') }, init.timeoutMs)
      : null

    proc.stdout.on('data', (buf) => {
      if (outLen < MAX_OUTPUT) {
        const room = MAX_OUTPUT - outLen
        if (buf.length > room) {
          outChunks.push(buf.subarray(0, room))
          truncated = true
        } else {
          outChunks.push(buf)
        }
      } else {
        truncated = true
      }
      outLen += buf.length
    })
    proc.stderr.on('data', (buf) => {
      if (errChunks.length < 64) errChunks.push(buf)
    })
    proc.on('error', (err) => {
      if (timer) clearTimeout(timer)
      reject(err)
    })
    proc.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
        isStdoutTruncated: truncated
      })
    })
    if (init.stdin !== undefined) proc.stdin.end(init.stdin)
    else proc.stdin.end()
  })
}

async function git (run, argv, init = {}) {
  const result = await run(['git', ...argv], { timeoutMs: TIMEOUT_MS, ...init })
  if (result.exitCode !== 0) {
    const said = (result.stderr || result.stdout || '').trim().split('\n')[0]
    throw new Error(`git ${argv[0]}: ${said || `exit ${result.exitCode}`}`)
  }
  return result.stdout.trim()
}

export async function locate (run, cwd, session) {
  try {
    const [top, gitDir] = await Promise.all([
      git(run, ['rev-parse', '--show-toplevel'], { cwd }),
      git(run, ['rev-parse', '--absolute-git-dir'], { cwd })
    ])
    const safeSession = String(session || 'default').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 36) || 'default'
    return { top, gitDir, index: `${gitDir}/time-machine-${safeSession}.index` }
  } catch {
    return null
  }
}

function indexEnv (repo) {
  if (!repo.index) throw new Error('time-machine: no index of its own')
  return { ...IDENTITY, GIT_INDEX_FILE: repo.index }
}

export function forget (index) { seededFrom.delete(index) }
export function isSeeded (index) { return seededFrom.has(index) }

async function headOf (run, repo) {
  const result = await run(['git', 'rev-parse', '-q', '--verify', 'HEAD'], { cwd: repo.top })
  return result.exitCode === 0 ? result.stdout.trim() : null
}

async function untrackIgnored (run, repo, head, init) {
  const ignored = (await git(run, ['ls-files', '-z', '--cached', '--ignored', '--exclude-standard'], init)).split('\0').filter(Boolean)
  if (ignored.length === 0) return
  let leave = ignored
  if (head !== null) {
    const found = await git(run, ['cat-file', '--batch-check'], { cwd: repo.top, stdin: ignored.map(p => `${head}:${p}\n`).join('') })
    const lines = found.split('\n')
    leave = ignored.filter((_, i) => lines[i]?.endsWith(' missing'))
  }
  if (leave.length === 0) return
  await git(run, ['rm', '-q', '--cached', '--pathspec-from-file=-', '--pathspec-file-nul'], { ...init, stdin: leave.map(p => `:(literal)${p}`).join('\0') })
}

export async function treeOf (run, repo) {
  const init = { cwd: repo.top, env: indexEnv(repo) }
  const { index } = repo
  const head = await headOf(run, repo)
  if (head !== null && seededFrom.get(index) !== head) {
    if (!seededFrom.has(index)) {
      await run(['cp', '-n', `${repo.gitDir}/index`, index], { cwd: repo.top }).catch(() => undefined)
    }
    await git(run, ['read-tree', '-m', 'HEAD'], init).catch(() => git(run, ['read-tree', 'HEAD'], init))
    seededFrom.set(index, head)
  }
  await git(run, ['add', '-A', '--', '.'], init)
  await untrackIgnored(run, repo, head, init)
  return { tree: await git(run, ['write-tree'], init), head }
}

export async function keep (run, repo, { tree, head }, ref, message) {
  const parent = head ? ['-p', head] : []
  const commit = await git(run, ['commit-tree', tree, ...parent, '-m', message], { cwd: repo.top, env: IDENTITY })
  await git(run, ['update-ref', ref, commit], { cwd: repo.top })
  return commit
}

export async function snapshot (run, repo, ref, message) {
  const now = await treeOf(run, repo)
  return { tree: now.tree, head: now.head, commit: await keep(run, repo, now, ref, message) }
}

async function whole (run, repo, argv) {
  const result = await run(['git', ...argv], { cwd: repo.top, timeoutMs: TIMEOUT_MS })
  if (result.exitCode !== 0) throw new Error(`git ${argv[0]}: ${(result.stderr || '').trim().split('\n')[0] || `exit ${result.exitCode}`}`)
  if (!result.isStdoutTruncated) return result.stdout
  return result.stdout.slice(0, result.stdout.lastIndexOf('\0') + 1)
}

async function every (run, repo, argv, { stdin, okCodes = [0] } = {}) {
  const result = await run(['git', ...argv], { cwd: repo.top, timeoutMs: TIMEOUT_MS, ...(stdin === undefined ? {} : { stdin }) })
  if (!okCodes.includes(result.exitCode)) throw new Error(`git ${argv[0]}: ${(result.stderr || '').trim().split('\n')[0] || `exit ${result.exitCode}`}`)
  if (result.isStdoutTruncated) throw new MoveBlocked([], 'it changes more files than can all be checked for ignored ones')
  return result.stdout.split('\0').filter(Boolean)
}

export async function changes (run, repo, a, b) {
  if (!a || !b || a === b) return []
  const [numstat, status] = await Promise.all([
    whole(run, repo, ['diff', '--numstat', '--no-renames', '-z', a, b]),
    whole(run, repo, ['diff', '--name-status', '--no-renames', '-z', a, b])
  ])
  const statusOf = new Map()
  const parts = status.split('\0').filter(Boolean)
  for (let i = 0; i + 1 < parts.length; i += 2) statusOf.set(parts[i + 1], parts[i])
  return numstat.split('\0').filter(Boolean).map(line => {
    const first = line.indexOf('\t')
    const second = line.indexOf('\t', first + 1)
    const added = line.slice(0, first)
    const removed = line.slice(first + 1, second)
    const p = line.slice(second + 1)
    return {
      path: p,
      status: statusOf.get(p) ?? 'M',
      added: added === '-' ? null : Number(added),
      removed: removed === '-' ? null : Number(removed)
    }
  })
}

export async function move (run, repo, from, to) {
  if (from === to) return []
  const added = await every(run, repo, ['diff', '--name-only', '--diff-filter=A', '--no-renames', '-z', from, to])
  if (added.length > 0) {
    const ignored = await every(run, repo, ['check-ignore', '-z', '--stdin'], { stdin: added.join('\0') + '\0', okCodes: [0, 1] })
    const blocked = []
    for (let i = 0; i < ignored.length; i += PATHS_PER_CALL) {
      blocked.push(...await every(run, repo, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', ...ignored.slice(i, i + PATHS_PER_CALL).map(p => `:(literal)${p}`)]))
    }
    if (blocked.length > 0) throw new MoveBlocked(blocked)
  }
  const moved = await changes(run, repo, from, to)
  await git(run, ['read-tree', '-m', '-u', from, to], { cwd: repo.top, env: indexEnv(repo) })
  return moved
}

export async function prune (run, repo, now, maxAgeMs) {
  const list = await git(run, ['for-each-ref', '--format=%(refname) %(committerdate:unix)', REF_ROOT], { cwd: repo.top })
  const old = list.split('\n').filter(Boolean).map(line => line.split(' ')).filter(([, seconds]) => now - Number(seconds) * 1000 > maxAgeMs)
  if (old.length > 0) {
    await git(run, ['update-ref', '--stdin'], { cwd: repo.top, stdin: old.map(([ref]) => `delete ${ref}\n`).join('') })
  }
  return old.length
}
