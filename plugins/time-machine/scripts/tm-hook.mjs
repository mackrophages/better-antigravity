#!/usr/bin/env node
// Antigravity lifecycle hooks for Time Machine:
// - Uniform safeSid sanitization across state files and Git refs
// - Atomic lockfile around pre-tool snapshot creation to prevent parallel index.lock collisions
// - Cleans up stale pending flags on new turn start (invocationNum === 0) if a prior turn aborted
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ensureStatusLineInstalled,
  getPluginConfig,
  isSubcall,
  readStdinJson,
  readState,
  repoKey,
  stateRoot,
  writeState
} from './lib/store.mjs'
import { mayWrite } from './core/tools.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const event = process.argv[2] || ''

if (isSubcall()) {
  process.stdout.write(event === 'pre-tool' ? '{"decision":"allow"}\n' : '{}\n')
  process.exit(0)
}

const payload = await readStdinJson()
const cwd = payload.cwd || payload.workspacePaths?.[0] || process.cwd()
const safeSid = String(payload.conversationId || 'default').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 36) || 'default'

function stateFile (topDir) {
  return `time-machine/${repoKey(topDir)}/${safeSid}.json`
}

function pendingFlagPath () {
  return path.join(stateRoot(), 'time-machine', `pending-${safeSid}.flag`)
}

function lockFilePath () {
  return path.join(stateRoot(), 'time-machine', `pending-${safeSid}.lock`)
}

function tryAcquireLock (lockPath) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  try {
    const fd = fs.openSync(lockPath, 'wx')
    fs.writeSync(fd, `${process.pid}\n`)
    fs.closeSync(fd)
    return true
  } catch {
    try {
      const st = fs.statSync(lockPath, { throwIfNoEntry: false })
      if (st && Date.now() - st.mtimeMs > 30_000) {
        fs.rmSync(lockPath, { force: true })
        const fd = fs.openSync(lockPath, 'wx')
        fs.writeSync(fd, `${process.pid}\n`)
        fs.closeSync(fd)
        return true
      }
    } catch {}
    return false
  }
}

function hasAnyJumpedNotice () {
  const tmRoot = path.join(stateRoot(), 'time-machine')
  if (!fs.existsSync(tmRoot)) return false
  try {
    for (const dir of fs.readdirSync(tmRoot, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue
      const candidate = path.join(tmRoot, dir.name, `${safeSid}.json`)
      if (fs.existsSync(candidate)) {
        const raw = fs.readFileSync(candidate, 'utf8')
        if (raw.includes('"jumpedNoticePending": true') || raw.includes('"jumpedNoticePending":true')) {
          return true
        }
      }
    }
  } catch {}
  return false
}

if (event === 'session-start') {
  try { ensureStatusLineInstalled(path.join(here, 'lib', 'better-statusline.mjs'), { preferNative: true }) } catch {}
  try {
    const { locate, nodeRun, prune } = await import('./core/git.mjs')
    const repo = await locate(nodeRun, cwd, safeSid)
    if (repo) {
      const cfg = getPluginConfig('time-machine', { keepDays: 7 })
      const days = Number(cfg.keepDays) > 0 ? Number(cfg.keepDays) : 7
      await prune(nodeRun, repo, Date.now(), days * 86_400_000)
    }
  } catch {}
  process.stdout.write('{}\n')
  process.exit(0)
}

if (event === 'pre-tool') {
  const flag = pendingFlagPath()
  if (fs.existsSync(flag)) {
    process.stdout.write('{"decision":"allow"}\n')
    process.exit(0)
  }
  const toolName = payload?.toolCall?.name || ''
  const toolArgs = payload?.toolCall?.args || {}
  if (mayWrite(toolName, toolArgs)) {
    const lock = lockFilePath()
    if (tryAcquireLock(lock)) {
      try {
        if (!fs.existsSync(flag)) {
          const [{ locate, nodeRun, treeOf }, { cleanUserRequest }] = await Promise.all([
            import('./core/git.mjs'),
            import('./lib/transcript.mjs')
          ])
          const repo = await locate(nodeRun, cwd, safeSid)
          if (repo) {
            const sFile = stateFile(repo.top)
            const data = readState(sFile, { sessionId: safeSid, repoTop: repo.top, states: [], cursor: null, jumpedFrom: null })
            if (!data.pendingTurn) {
              const pre = await treeOf(nodeRun, repo)
              data.pendingTurn = {
                tree: pre.tree,
                head: pre.head,
                prompt: cleanUserRequest(String(payload.lastUserInput || '')),
                startedAt: Date.now()
              }
              writeState(sFile, data)
            }
            fs.mkdirSync(path.dirname(flag), { recursive: true })
            fs.writeFileSync(flag, repo.top)
          }
        }
      } catch {} finally {
        try { fs.rmSync(lock, { force: true }) } catch {}
      }
    }
  }
  process.stdout.write('{"decision":"allow"}\n')
  process.exit(0)
}

if (event === 'stop') {
  if (payload.fullyIdle === false) {
    process.stdout.write('{}\n')
    process.exit(0)
  }
  const flag = pendingFlagPath()
  try {
    const [
      { REF_ROOT, changes, keep, locate, nodeRun, treeOf },
      { nextId },
      { shorten },
      { cleanUserRequest }
    ] = await Promise.all([
      import('./core/git.mjs'),
      import('./core/states.mjs'),
      import('./core/format.mjs'),
      import('./lib/transcript.mjs')
    ])
    const repo = await locate(nodeRun, cwd, safeSid)
    if (repo) {
      const sFile = stateFile(repo.top)
      const data = readState(sFile, null)
      if (data?.pendingTurn) {
        const start = data.pendingTurn
        delete data.pendingTurn
        const post = await treeOf(nodeRun, repo)
        if (post.tree !== start.tree) {
          const now = Date.now()
          let parentState = data.states.find(s => s.tree === start.tree) || null

          if (!parentState) {
            const baseId = nextId(data.states)
            const baseLabel = data.states.length === 0 ? 'start of the session' : 'changes outside Antigravity'
            const baseCommit = await keep(
              nodeRun,
              repo,
              { tree: start.tree, head: start.head },
              `${REF_ROOT}/${safeSid}/${baseId}`,
              baseLabel
            )
            parentState = {
              id: baseId,
              parent: data.cursor,
              tree: start.tree,
              head: start.head,
              commit: baseCommit,
              label: baseLabel,
              prompt: baseLabel,
              at: start.startedAt || now,
              files: []
            }
            data.states.push(parentState)
          }

          const id = nextId(data.states)
          const rawPrompt = start.prompt || cleanUserRequest(String(payload.lastUserInput || '')) || `turn #${id}`
          const label = shorten(rawPrompt, 60)
          const [commit, files] = await Promise.all([
            keep(nodeRun, repo, post, `${REF_ROOT}/${safeSid}/${id}`, label),
            changes(nodeRun, repo, parentState.tree, post.tree)
          ])

          data.states.push({
            id,
            parent: parentState.id,
            tree: post.tree,
            head: post.head,
            commit,
            label,
            prompt: rawPrompt,
            at: now,
            files
          })
          data.cursor = id
          data.lastAgentTree = post.tree
          writeState(path.join('time-machine', repoKey(repo.top), 'latest.json'), { sessionId: safeSid, updatedAt: now })
        }
        writeState(sFile, data)
      }
    }
  } catch {} finally {
    try { fs.rmSync(flag, { force: true }) } catch {}
  }
  process.stdout.write('{}\n')
  process.exit(0)
}

if (event === 'pre-invocation') {
  const isFirst = payload.invocationNum === undefined || payload.invocationNum === 0
  if (!isFirst) {
    process.stdout.write('{}\n')
    process.exit(0)
  }
  const flag = pendingFlagPath()
  const hadStaleFlag = fs.existsSync(flag)
  if (hadStaleFlag) {
    try { fs.rmSync(flag, { force: true }) } catch {}
  }
  const jumped = hasAnyJumpedNotice()
  if (!jumped && !hadStaleFlag) {
    process.stdout.write('{}\n')
    process.exit(0)
  }
  try {
    const [{ changes, locate, nodeRun, treeOf }, { summary }] = await Promise.all([
      import('./core/git.mjs'),
      import('./core/format.mjs')
    ])
    const repo = await locate(nodeRun, cwd, safeSid)
    if (repo) {
      const sFile = stateFile(repo.top)
      const data = readState(sFile, null)
      if (data?.pendingTurn) {
        delete data.pendingTurn
        writeState(sFile, data)
      }
      if (data?.lastAgentTree && data.jumpedNoticePending) {
        const cur = await treeOf(nodeRun, repo)
        if (cur.tree !== data.lastAgentTree) {
          const moved = await changes(nodeRun, repo, data.lastAgentTree, cur.tree)
          data.lastAgentTree = cur.tree
          data.jumpedNoticePending = false
          writeState(sFile, data)
          if (moved.length > 0) {
            const list = moved.slice(0, 12).map(f => `${f.status} ${f.path}`).join(', ')
            const msg = `Time Machine notice: the user moved the working tree to snapshot #${data.cursor} (${summary(moved)}: ${list}). Read modified files fresh before editing them.`
            process.stdout.write(JSON.stringify({
              injectSteps: [{ systemMessage: { systemMessage: msg } }]
            }) + '\n')
            process.exit(0)
          }
        } else {
          data.jumpedNoticePending = false
          writeState(sFile, data)
        }
      }
    }
  } catch {}
  process.stdout.write('{}\n')
  process.exit(0)
}

process.stdout.write('{}\n')
