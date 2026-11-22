#!/usr/bin/env node
// Antigravity lifecycle hooks for Time Machine:
// - session-start: installs statusLine + prunes old refs/time-machine/* snapshots
// - pre-tool: snapshots pre-turn working tree before the first mutating tool call
// - stop: commits changed working tree as a new state under refs/time-machine/<session>/<id>
// - pre-invocation: informs model once if user rewound files with /timeline
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ensureStatusLineInstalled,
  getPluginConfig,
  isSubcall,
  readStdinJson,
  readState,
  repoKey,
  writeState
} from './lib/store.mjs'
import { cleanUserRequest } from './lib/transcript.mjs'
import { REF_ROOT, changes, keep, locate, nodeRun, prune, treeOf } from './core/git.mjs'
import { mayWrite } from './core/tools.mjs'
import { nextId } from './core/states.mjs'
import { shorten, summary } from './core/format.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const event = process.argv[2] || ''

if (isSubcall()) {
  process.stdout.write(event === 'pre-tool' ? '{"decision":"allow"}\n' : '{}\n')
  process.exit(0)
}
const payload = await readStdinJson()
const cwd = payload.cwd || payload.workspacePaths?.[0] || process.cwd()
const sid = payload.conversationId || 'default'

function stateFile (topDir, session) {
  return `time-machine/${repoKey(topDir)}/${session}.json`
}

if (event === 'session-start') {
  try { ensureStatusLineInstalled(path.join(here, 'lib', 'better-statusline.mjs')) } catch {}
  try {
    const repo = await locate(nodeRun, cwd, sid)
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
  const toolName = payload?.toolCall?.name || ''
  const toolArgs = payload?.toolCall?.args || {}
  if (mayWrite(toolName, toolArgs)) {
    try {
      const repo = await locate(nodeRun, cwd, sid)
      if (repo) {
        const sFile = stateFile(repo.top, sid)
        const data = readState(sFile, { sessionId: sid, repoTop: repo.top, states: [], cursor: null, jumpedFrom: null })
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
      }
    } catch {}
  }
  process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\n')
  process.exit(0)
}

if (event === 'stop') {
  if (payload.fullyIdle === false) {
    process.stdout.write('{}\n')
    process.exit(0)
  }
  try {
    const repo = await locate(nodeRun, cwd, sid)
    if (repo) {
      const sFile = stateFile(repo.top, sid)
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
              `${REF_ROOT}/${sid}/${baseId}`,
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
          const commit = await keep(nodeRun, repo, post, `${REF_ROOT}/${sid}/${id}`, label)
          const files = await changes(nodeRun, repo, parentState.tree, post.tree)

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
          writeState(path.join('time-machine', repoKey(repo.top), 'latest.json'), { sessionId: sid, updatedAt: now })
        }
        writeState(sFile, data)
      }
    }
  } catch {}
  process.stdout.write('{}\n')
  process.exit(0)
}

if (event === 'pre-invocation') {
  const isFirst = payload.invocationNum === undefined || payload.invocationNum === 0
  if (!isFirst) {
    process.stdout.write('{}\n')
    process.exit(0)
  }
  try {
    const repo = await locate(nodeRun, cwd, sid)
    if (repo) {
      const sFile = stateFile(repo.top, sid)
      const data = readState(sFile, null)
      if (data?.lastAgentTree) {
        const cur = await treeOf(nodeRun, repo)
        if (cur.tree !== data.lastAgentTree && data.jumpedNoticePending) {
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
        }
      }
    }
  } catch {}
  process.stdout.write('{}\n')
  process.exit(0)
}

process.stdout.write('{}\n')
