#!/usr/bin/env node
// Antigravity lifecycle hooks for Time Machine:
// - Uniform 64-char safeSid sanitization across state files and Git refs
// - Turn-bounded PID-verified lock around pre-tool snapshot creation: concurrent mutating tools
//   wait until `pending-<sid>.flag` exists instead of racing past `treeOf`
// - Top-level `maxId` + `cursor` ordering for O(1) HUD reads even on multi-MB state files
// - O(1) `jumped-<sid>.flag` marker + automatic pruning of old state JSON files on SessionStart
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  ensureStatusLineInstalled,
  getPluginConfig,
  isProcessAlive,
  isSubcall,
  readStdinJson,
  readState,
  repoKey,
  safeSid,
  sleepSyncMs,
  stateRoot,
  updateState,
  writeState
} from './lib/store.mjs'
import { mayWrite } from './core/tools.mjs'
import { normalizeTmState } from './core/states.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const event = process.argv[2] || ''

if (isSubcall()) {
  process.stdout.write(event === 'pre-tool' ? '{"decision":"allow"}\n' : '{}\n')
  process.exit(0)
}

const payload = await readStdinJson()
const cwd = payload.cwd || payload.workspacePaths?.[0] || process.cwd()
const sid = safeSid(payload.conversationId, 'default')

function stateFile (topDir) {
  return `time-machine/${repoKey(topDir)}/${sid}.json`
}

function pendingFlagPath () {
  return path.join(stateRoot(), 'time-machine', `pending-${sid}.flag`)
}

function jumpedFlagPath () {
  return path.join(stateRoot(), 'time-machine', `jumped-${sid}.flag`)
}

function lockFilePath () {
  return path.join(stateRoot(), 'time-machine', `pending-${sid}.lock`)
}

function pruneOldStateFiles (maxAgeMs) {
  const tmRoot = path.join(stateRoot(), 'time-machine')
  if (!fs.existsSync(tmRoot)) return
  const now = Date.now()
  try {
    for (const entry of fs.readdirSync(tmRoot, { withFileTypes: true })) {
      const full = path.join(tmRoot, entry.name)
      if (entry.isFile() && (entry.name.endsWith('.flag') || entry.name.endsWith('.lock'))) {
        const st = fs.statSync(full, { throwIfNoEntry: false })
        if (st && now - st.mtimeMs > maxAgeMs) {
          try { fs.rmSync(full, { force: true }) } catch {}
        }
        continue
      }
      if (!entry.isDirectory()) continue
      for (const jf of fs.readdirSync(full)) {
        if (!jf.endsWith('.json') || jf === 'latest.json') continue
        const jPath = path.join(full, jf)
        const st = fs.statSync(jPath, { throwIfNoEntry: false })
        if (st && now - st.mtimeMs > maxAgeMs) {
          try { fs.rmSync(jPath, { force: true }) } catch {}
          try { fs.rmSync(`${jPath}.lock`, { force: true }) } catch {}
        }
      }
    }
  } catch {}
}

function hasLegacyJumpedNotice () {
  const tmRoot = path.join(stateRoot(), 'time-machine')
  if (!fs.existsSync(tmRoot)) return false
  try {
    for (const dir of fs.readdirSync(tmRoot, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue
      const candidate = path.join(tmRoot, dir.name, `${sid}.json`)
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
    const cfg = getPluginConfig('time-machine', { keepDays: 7 })
    const days = Number(cfg.keepDays) > 0 ? Number(cfg.keepDays) : 7
    const maxAgeMs = days * 86_400_000
    pruneOldStateFiles(maxAgeMs)
    const { locate, nodeRun, prune } = await import('./core/git.mjs')
    const repo = await locate(nodeRun, cwd, sid)
    if (repo) {
      await prune(nodeRun, repo, Date.now(), maxAgeMs)
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
    fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 })
    const token = `${process.pid}:${crypto.randomBytes(4).toString('hex')}`
    let emptyChecks = 0

    // Bounded by iteration count (4800 * 25ms = 120s max git timeout; zero wall-clock dependency).
    // Concurrent mutating tools wait until `pending-<sid>.flag` is written or the dead holder is reaped.
    for (let turn = 0; turn < 4800; turn++) {
      if (fs.existsSync(flag)) break
      let acquired = false
      try {
        const fd = fs.openSync(lock, 'wx', 0o600)
        try {
          fs.writeSync(fd, `${token}\n`)
        } finally {
          fs.closeSync(fd)
        }
        acquired = true
      } catch (err) {
        if (err?.code !== 'EEXIST') break
      }

      if (acquired) {
        try {
          if (!fs.existsSync(flag)) {
            const [{ locate, nodeRun, treeOf }, { cleanUserRequest }] = await Promise.all([
              import('./core/git.mjs'),
              import('./lib/transcript.mjs')
            ])
            const repo = await locate(nodeRun, cwd, sid)
            if (repo) {
              const sFile = stateFile(repo.top)
              const existing = readState(sFile, null)
              if (!existing?.pendingTurn) {
                const pre = await treeOf(nodeRun, repo)
                const prompt = cleanUserRequest(String(payload.lastUserInput || ''))
                const startedAt = Date.now()
                updateState(sFile, null, (curr) => {
                  const norm = normalizeTmState(curr, sid, repo.top)
                  if (!norm.pendingTurn) {
                    norm.pendingTurn = { tree: pre.tree, head: pre.head, prompt, startedAt }
                  }
                  return normalizeTmState(norm, sid, repo.top)
                })
              }
              fs.mkdirSync(path.dirname(flag), { recursive: true, mode: 0o700 })
              fs.writeFileSync(flag, repo.top, { encoding: 'utf8', mode: 0o600 })
            }
          }
        } catch {} finally {
          try {
            if (fs.readFileSync(lock, 'utf8').trim() === token) fs.unlinkSync(lock)
          } catch {}
        }
        break
      }

      try {
        const raw = fs.readFileSync(lock, 'utf8').trim()
        if (!raw) {
          emptyChecks++
          if (emptyChecks > 20) {
            try { fs.unlinkSync(lock) } catch {}
            emptyChecks = 0
            continue
          }
        } else {
          emptyChecks = 0
          const holderPid = Number(raw.split(':')[0])
          if (holderPid > 0 && !isProcessAlive(holderPid)) {
            try { fs.unlinkSync(lock) } catch {}
            continue
          }
        }
      } catch {}
      sleepSyncMs(25)
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
    const repo = await locate(nodeRun, cwd, sid)
    if (repo) {
      const sFile = stateFile(repo.top)
      const snapshot = readState(sFile, null)
      if (snapshot?.pendingTurn) {
        const start = snapshot.pendingTurn
        const post = await treeOf(nodeRun, repo)
        let baseData = null
        let postData = null

        if (post.tree !== start.tree) {
          const now = Date.now()
          const curStates = Array.isArray(snapshot.states) ? snapshot.states : []
          let parentState = curStates.find(s => s.tree === start.tree) || null

          if (!parentState) {
            const baseId = nextId(curStates)
            const baseLabel = curStates.length === 0 ? 'start of the session' : 'changes outside Antigravity'
            const baseCommit = await keep(
              nodeRun,
              repo,
              { tree: start.tree, head: start.head },
              `${REF_ROOT}/${sid}/${baseId}`,
              baseLabel
            )
            baseData = { baseLabel, baseCommit, startedAt: start.startedAt || now }
            parentState = { id: baseId, tree: start.tree }
          }

          const provisionalId = nextId([...curStates, ...(baseData ? [{ id: parentState.id }] : [])])
          const rawPrompt = start.prompt || cleanUserRequest(String(payload.lastUserInput || '')) || `turn #${provisionalId}`
          const label = shorten(rawPrompt, 60)
          const [commit, files] = await Promise.all([
            keep(nodeRun, repo, post, `${REF_ROOT}/${sid}/${provisionalId}`, label),
            changes(nodeRun, repo, parentState.tree, post.tree)
          ])
          postData = { now, rawPrompt, label, commit, files }
        }

        let wroteSnapshot = false
        updateState(sFile, null, (curr) => {
          const norm = normalizeTmState(curr, sid, repo.top)
          delete norm.pendingTurn
          if (post.tree !== start.tree && postData) {
            let parent = norm.states.find(s => s.tree === start.tree) || null
            if (!parent && baseData) {
              const bId = nextId(norm.states)
              parent = {
                id: bId,
                parent: norm.cursor,
                tree: start.tree,
                head: start.head,
                commit: baseData.baseCommit,
                label: baseData.baseLabel,
                prompt: baseData.baseLabel,
                at: baseData.startedAt,
                files: []
              }
              norm.states.push(parent)
            }
            if (parent) {
              const nId = nextId(norm.states)
              norm.states.push({
                id: nId,
                parent: parent.id,
                tree: post.tree,
                head: post.head,
                commit: postData.commit,
                label: postData.label,
                prompt: postData.rawPrompt,
                at: postData.now,
                files: postData.files
              })
              norm.cursor = nId
              norm.lastAgentTree = post.tree
              wroteSnapshot = true
            }
          }
          return normalizeTmState(norm, sid, repo.top)
        })

        if (wroteSnapshot && postData) {
          writeState(path.join('time-machine', repoKey(repo.top), 'latest.json'), { sessionId: sid, updatedAt: postData.now })
        }
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
  const jFlag = jumpedFlagPath()
  const hadStaleFlag = fs.existsSync(flag)
  if (hadStaleFlag) {
    try { fs.rmSync(flag, { force: true }) } catch {}
  }
  const jumped = fs.existsSync(jFlag) || hasLegacyJumpedNotice()
  if (!jumped && !hadStaleFlag) {
    process.stdout.write('{}\n')
    process.exit(0)
  }
  try {
    const [{ changes, locate, nodeRun, treeOf }, { summary }] = await Promise.all([
      import('./core/git.mjs'),
      import('./core/format.mjs')
    ])
    const repo = await locate(nodeRun, cwd, sid)
    if (repo) {
      const sFile = stateFile(repo.top)
      const data = readState(sFile, null)
      if (data?.pendingTurn) {
        updateState(sFile, null, (curr) => {
          const norm = normalizeTmState(curr, sid, repo.top)
          delete norm.pendingTurn
          return normalizeTmState(norm, sid, repo.top)
        })
      }
      if (data?.lastAgentTree && data.jumpedNoticePending) {
        const cur = await treeOf(nodeRun, repo)
        let cursorNum = data.cursor
        if (cur.tree !== data.lastAgentTree) {
          const moved = await changes(nodeRun, repo, data.lastAgentTree, cur.tree)
          updateState(sFile, null, (curr) => {
            const norm = normalizeTmState(curr, sid, repo.top)
            norm.lastAgentTree = cur.tree
            norm.jumpedNoticePending = false
            cursorNum = norm.cursor
            return normalizeTmState(norm, sid, repo.top)
          })
          try { fs.rmSync(jFlag, { force: true }) } catch {}
          if (moved.length > 0) {
            const list = moved.slice(0, 12).map(f => `${f.status} ${f.path}`).join(', ')
            const msg = `Time Machine notice: the user moved the working tree to snapshot #${cursorNum} (${summary(moved)}: ${list}). Read modified files fresh before editing them.`
            process.stdout.write(JSON.stringify({
              injectSteps: [{ systemMessage: { systemMessage: msg } }]
            }) + '\n')
            process.exit(0)
          }
        } else {
          updateState(sFile, null, (curr) => {
            const norm = normalizeTmState(curr, sid, repo.top)
            norm.jumpedNoticePending = false
            return normalizeTmState(norm, sid, repo.top)
          })
          try { fs.rmSync(jFlag, { force: true }) } catch {}
        }
      } else {
        try { fs.rmSync(jFlag, { force: true }) } catch {}
      }
    }
  } catch {}
  process.stdout.write('{}\n')
  process.exit(0)
}

process.stdout.write('{}\n')
