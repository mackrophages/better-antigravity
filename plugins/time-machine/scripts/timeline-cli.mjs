#!/usr/bin/env node
// Interactive/deterministic CLI for `/timeline` in Antigravity.
import fs from 'node:fs'
import path from 'node:path'
import {
  getPluginConfig,
  setPluginConfig,
  readState,
  repoKey,
  safeSid,
  stateRoot,
  updateState
} from './lib/store.mjs'
import { MoveBlocked, REF_ROOT, changes, keep, locate, move, nodeRun, treeOf } from './core/git.mjs'
import { lineOf, nextId, normalizeTmState } from './core/states.mjs'
import { ICON, ago, digestText, summary } from './core/format.mjs'

let cwd = process.cwd()
const rawArgs = process.argv.slice(2)
const args = []
for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === '--cwd' && rawArgs[i + 1]) {
    cwd = path.resolve(rawArgs[++i])
  } else if (rawArgs[i] === '--session' && rawArgs[i + 1]) {
    process.env.BETTER_AGY_TM_SESSION = rawArgs[++i]
  } else {
    args.push(rawArgs[i])
  }
}

const [sub = 'list', arg1 = ''] = args

if (sub === 'keep-days') {
  const days = Number(arg1)
  if (!Number.isFinite(days) || days < 1) {
    console.error('Usage: timeline-cli.mjs keep-days <days>=1..365')
    process.exit(1)
  }
  const cfg = setPluginConfig('time-machine', { keepDays: Math.round(days) })
  console.log(`Time Machine keepDays set to ${cfg.keepDays} days.`)
  process.exit(0)
}

const probe = await locate(nodeRun, cwd, 'probe')
if (!probe) {
  console.log('⏪ Time Machine: current workspace is not a git repository.')
  process.exit(0)
}

const rKey = repoKey(probe.top)
const repoDir = path.join(stateRoot(), 'time-machine', rKey)

function resolveSessionId () {
  if (process.env.BETTER_AGY_TM_SESSION) return safeSid(process.env.BETTER_AGY_TM_SESSION, 'default')
  const latest = readState(`time-machine/${rKey}/latest.json`, null)
  const latestSid = safeSid(latest?.sessionId)
  if (latestSid && fs.existsSync(path.join(repoDir, `${latestSid}.json`))) {
    return latestSid
  }
  if (!fs.existsSync(repoDir)) return 'default'
  const files = fs.readdirSync(repoDir)
    .filter(f => f.endsWith('.json') && f !== 'latest.json')
    .map(f => ({
      sid: safeSid(f.slice(0, -5)),
      mtime: fs.statSync(path.join(repoDir, f)).mtimeMs
    }))
    .filter(x => x.sid)
    .sort((a, b) => b.mtime - a.mtime)
  return files[0]?.sid || 'default'
}

const sid = resolveSessionId()
const repo = await locate(nodeRun, cwd, sid)
const sFile = `time-machine/${rKey}/${sid}.json`
let data = normalizeTmState(readState(sFile, null), sid, repo.top)

function renderTimeline (stateData, dirtyNote = '') {
  const { states, cursor, jumpedFrom } = stateData
  if (states.length === 0) {
    const cfg = getPluginConfig('time-machine', { keepDays: 7 })
    return [
      '⏪ Time Machine · 0 states in this repository yet',
      `Snapshots are captured automatically whenever a turn modifies files (kept for ${cfg.keepDays} days).`
    ].join('\n')
  }

  const now = Date.now()
  const activeLine = lineOf(states, cursor)
  const ordered = [...states].sort((a, b) => b.id - a.id)
  const out = [`⏪ Time Machine                                           ${states.length} state${states.length === 1 ? '' : 's'}`, '']

  if (dirtyNote) {
    out.push(`  ●  (unsaved working-tree edits since #${cursor}: ${dirtyNote})`)
  }

  for (const st of ordered) {
    const mark = st.id === cursor ? '◉' : activeLine.has(st.id) ? '●' : '○'
    const tag = !activeLine.has(st.id) ? ' (undone)' : ''
    out.push(`  ${mark}  #${st.id}  ${st.label}${tag}   (${ago(now - (st.at || now))})`)
    out.push(`  │  ${digestText(st.files)}`)
  }

  out.push('  ──────────────────────────────────────────────────────────────────')
  out.push(`  current #${cursor ?? '-'}   jumped from ${jumpedFrom ? `#${jumpedFrom}` : '-'}`)
  out.push('  Commands: /timeline <id> · /timeline undo · /timeline redo · /timeline diff <id>')
  return out.join('\n')
}

async function jumpToState (targetId) {
  const target = data.states.find(s => s.id === targetId)
  if (!target) {
    console.error(`⏪ Time Machine: state #${targetId} not found.`)
    process.exit(1)
  }

  const nowTree = await treeOf(nodeRun, repo)
  if (nowTree.tree === target.tree) {
    data = updateState(sFile, null, (curr) => {
      const norm = normalizeTmState(curr || data, sid, repo.top)
      norm.cursor = target.id
      return normalizeTmState(norm, sid, repo.top)
    })
    console.log(`⏪ Already at state #${target.id} (${target.label}).`)
    return
  }

  let extraManual = null
  const knownNow = data.states.find(s => s.tree === nowTree.tree)
  if (!knownNow) {
    const savedId = nextId(data.states)
    const savedLabel = 'your changes, kept before a jump'
    const commit = await keep(nodeRun, repo, nowTree, `${REF_ROOT}/${sid}/${savedId}`, savedLabel)
    const curState = data.states.find(s => s.id === data.cursor)
    const diffFiles = curState ? await changes(nodeRun, repo, curState.tree, nowTree.tree) : []
    extraManual = { commit, savedLabel, diffFiles, at: Date.now() }
  }

  try {
    const moved = await move(nodeRun, repo, nowTree.tree, target.tree)
    data = updateState(sFile, null, (curr) => {
      const norm = normalizeTmState(curr || data, sid, repo.top)
      if (extraManual && !norm.states.some(s => s.tree === nowTree.tree)) {
        const sId = nextId(norm.states)
        norm.states.push({
          id: sId,
          parent: norm.cursor,
          tree: nowTree.tree,
          head: nowTree.head,
          commit: extraManual.commit,
          label: extraManual.savedLabel,
          prompt: extraManual.savedLabel,
          at: extraManual.at,
          files: extraManual.diffFiles
        })
        norm.cursor = sId
      }
      const prevCursor = norm.cursor
      norm.cursor = target.id
      norm.jumpedFrom = prevCursor
      norm.jumpedNoticePending = true
      return normalizeTmState(norm, sid, repo.top)
    })

    const jFlag = path.join(stateRoot(), 'time-machine', `jumped-${sid}.flag`)
    fs.mkdirSync(path.dirname(jFlag), { recursive: true, mode: 0o700 })
    fs.writeFileSync(jFlag, `${target.id}\n`, { encoding: 'utf8', mode: 0o600 })

    const headMovedNote = target.head && nowTree.head && target.head !== nowTree.head
      ? '\n  Note: HEAD moved since this snapshot; files were restored onto your current HEAD and branch.'
      : ''
    console.log(`⏪ Jumped to #${target.id} · ${target.label} (${summary(moved)} moved)${headMovedNote}`)
    console.log('')
    console.log(renderTimeline(data))
  } catch (err) {
    if (err instanceof MoveBlocked) {
      console.error(`⏪ Refused jump to #${target.id}: ${err.message}`)
      process.exit(1)
    }
    throw err
  }
}

if (sub === 'diff') {
  const id = Number(arg1 || data.cursor)
  const st = data.states.find(s => s.id === id)
  if (!st) {
    console.error(`State #${arg1} not found.`)
    process.exit(1)
  }
  console.log(`⏪ Snapshot #${st.id} · ${st.label}`)
  if (!st.files?.length) {
    console.log('  no files changed in this state')
  } else {
    for (const f of st.files) {
      const counts = f.added !== null ? ` +${f.added} −${f.removed}` : ' (binary)'
      console.log(`  ${ICON[f.status] ?? '~'} ${f.path}${counts}`)
    }
  }
  process.exit(0)
}

if (sub === 'undo') {
  if (data.states.length === 0 || data.cursor === null) {
    console.log('⏪ Time Machine: nothing to undo.')
    process.exit(0)
  }
  const cur = data.states.find(s => s.id === data.cursor)
  const targetId = cur?.parent ?? data.jumpedFrom
  if (!targetId) {
    console.log(`⏪ Already at the earliest state (#${data.cursor}).`)
    process.exit(0)
  }
  await jumpToState(targetId)
  process.exit(0)
}

if (sub === 'redo') {
  if (data.states.length === 0 || data.cursor === null) {
    console.log('⏪ Time Machine: nothing to redo.')
    process.exit(0)
  }
  const children = data.states.filter(s => s.parent === data.cursor).sort((a, b) => b.id - a.id)
  const targetId = children[0]?.id ?? (data.jumpedFrom && data.jumpedFrom > data.cursor ? data.jumpedFrom : null)
  if (!targetId) {
    console.log(`⏪ Already at the latest state on this branch (#${data.cursor}).`)
    process.exit(0)
  }
  await jumpToState(targetId)
  process.exit(0)
}

if (sub === 'jump' || /^#?\d+$/.test(sub)) {
  const rawNum = sub === 'jump' ? arg1 : sub
  const id = Number(String(rawNum).replace(/^#/, ''))
  await jumpToState(id)
  process.exit(0)
}

let dirty = ''
if (data.states.length > 0 && data.cursor !== null) {
  const cur = data.states.find(s => s.id === data.cursor)
  if (cur) {
    const live = await treeOf(nodeRun, repo)
    if (live.tree !== cur.tree) {
      const diff = await changes(nodeRun, repo, cur.tree, live.tree)
      if (diff.length > 0) dirty = summary(diff)
    }
  }
}
console.log(renderTimeline(data, dirty))
