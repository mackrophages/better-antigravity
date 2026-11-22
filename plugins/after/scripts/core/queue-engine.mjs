// Pure queue operations + deterministic parser + bilingual fuzzy heuristics + card renderer
// (adapted from midudev/better-claude `after`, zero external dependencies).

export const STATE_VERSION = 1
const DONE_LIMIT = 10
const UNDO_LIMIT = 20

export class QueueError extends Error {
  constructor (message) {
    super(message)
    this.name = 'QueueError'
  }
}

export const shorten = (text, max = 60) => {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

export function createState ({ sessionId = null, cwd = null, now = Date.now() } = {}) {
  return {
    version: STATE_VERSION,
    sessionId,
    cwd,
    items: [],
    running: null,
    done: [],
    paused: false,
    nextId: 1,
    undo: [],
    busy: false,
    createdAt: now,
    updatedAt: now
  }
}

const isItem = (item) => Boolean(item) && Number.isInteger(item.id) && typeof item.text === 'string'
const cleanText = (text) => String(text ?? '').trim()

export function normalizeState (raw, defaults = {}) {
  const base = createState(defaults)
  if (!raw || typeof raw !== 'object') return base
  const state = { ...base, ...raw }
  state.items = Array.isArray(raw.items) ? raw.items.filter(isItem) : []
  state.done = Array.isArray(raw.done) ? raw.done.filter(isItem) : []
  state.undo = Array.isArray(raw.undo) ? raw.undo : []
  state.running = isItem(raw.running) ? raw.running : null
  const maxId = [...state.items, ...state.done, state.running].filter(Boolean)
    .reduce((max, item) => Math.max(max, item.id), 0)
  state.nextId = Math.max(Number(raw.nextId) || 1, maxId + 1)
  return state
}

export const findItem = (state, id) => state.items.find(item => item.id === id) ?? null
export const positionOf = (state, id) => state.items.findIndex(item => item.id === id) + 1
export const itemAt = (state, position) => state.items[position - 1] ?? null

export function insertionIndex (items, where = { kind: 'end' }) {
  switch (where.kind) {
    case 'start': return 0
    case 'end': return items.length
    case 'index': return Math.min(Math.max(0, where.index), items.length)
    case 'after':
    case 'before': {
      const index = items.findIndex(item => item.id === where.id)
      if (index === -1) throw new QueueError(`Task #${where.id} is no longer in the queue`)
      return where.kind === 'after' ? index + 1 : index
    }
    default: throw new QueueError(`Unknown placement "${where.kind}"`)
  }
}

export function addItem (state, text, where = { kind: 'end' }, now = Date.now()) {
  const value = cleanText(text)
  if (!value) throw new QueueError('A task needs some text')
  const item = { id: state.nextId, text: value, createdAt: now }
  const items = [...state.items]
  items.splice(insertionIndex(items, where), 0, item)
  return { state: { ...state, items, nextId: state.nextId + 1, updatedAt: now }, item }
}

export function removeItems (state, ids) {
  const wanted = new Set(ids)
  const removed = state.items.filter(item => wanted.has(item.id))
  if (removed.length === 0) throw new QueueError('Nothing to remove')
  return { state: { ...state, items: state.items.filter(item => !wanted.has(item.id)) }, removed }
}

export function moveItem (state, id, where) {
  const item = findItem(state, id)
  if (!item) throw new QueueError(`Task #${id} is no longer in the queue`)
  if ((where.kind === 'after' || where.kind === 'before') && where.id === id) {
    throw new QueueError('A task cannot be moved relative to itself')
  }
  const rest = state.items.filter(other => other.id !== id)
  rest.splice(insertionIndex(rest, where), 0, item)
  return { state: { ...state, items: rest }, item }
}

export function editItem (state, id, text) {
  const value = cleanText(text)
  if (!value) throw new QueueError('A task needs some text')
  const previous = findItem(state, id)
  if (!previous) throw new QueueError(`Task #${id} is no longer in the queue`)
  const item = { ...previous, text: value }
  return {
    state: { ...state, items: state.items.map(other => other.id === id ? item : other) },
    item,
    previous
  }
}

export function clearItems (state) {
  return { state: { ...state, items: [] }, removed: state.items }
}

export const setPaused = (state, paused) => ({ ...state, paused: Boolean(paused) })

export function takeNext (state, now = Date.now()) {
  const [item, ...items] = state.items
  if (!item) return { state, item: null }
  return { state: { ...state, items, running: { ...item, startedAt: now }, busy: true, updatedAt: now }, item }
}

export function markIdle (state, { now = Date.now(), status = 'done' } = {}) {
  if (!state.running) return state.busy ? { ...state, busy: false, updatedAt: now } : state
  const finished = { ...state.running, finishedAt: now, status }
  return {
    ...state,
    busy: false,
    running: null,
    done: [finished, ...state.done].slice(0, DONE_LIMIT),
    updatedAt: now
  }
}

export function withUndo (previous, next) {
  const snapshot = { items: previous.items, paused: previous.paused }
  return { ...next, undo: [snapshot, ...previous.undo].slice(0, UNDO_LIMIT) }
}

export function undo (state) {
  const [snapshot, ...rest] = state.undo
  if (!snapshot) return { state, ok: false }
  const runningId = state.running?.id
  const items = snapshot.items.filter(item => item.id !== runningId)
  return { state: { ...state, items, paused: snapshot.paused, undo: rest }, ok: true }
}

// --- Fuzzy matching & bilingual heuristics (EN + ES) ---
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'for', 'in', 'on', 'at', 'by', 'with', 'from', 'into',
  'it', 'its', 'this', 'that', 'these', 'those', 'my', 'our', 'your', 'me', 'us', 'please', 'task',
  'tasks', 'item', 'one', 'thing', 'stuff', 'about', 'some', 'all', 'is', 'be', 'are', 'was',
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'y', 'o', 'de', 'del', 'al', 'en', 'con',
  'para', 'por', 'que', 'lo', 'le', 'les', 'se', 'su', 'sus', 'mi', 'mis', 'tu', 'tus', 'este',
  'esta', 'esto', 'ese', 'esa', 'eso', 'tarea', 'tareas', 'cosa', 'porfa', 'favor'
])
const SUFFIXES = [
  ['ciones', 'cion'], ['ations', 'ate'], ['ation', 'ate'], ['iendo', ''], ['ando', ''],
  ['mente', ''], ['ings', ''], ['ing', ''], ['ies', 'y'], ['ers', ''], ['es', ''], ['ed', ''],
  ['er', ''], ['ar', ''], ['ir', ''], ['s', '']
]

export function normalize (text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

const keywords = (text) => normalize(text).split(' ').filter(w => w.length > 1 && !STOPWORDS.has(w))
function stem (word) {
  for (const [suf, rep] of SUFFIXES) {
    if (word.length - suf.length >= 3 && word.endsWith(suf)) return word.slice(0, -suf.length) + rep
  }
  return word
}
function commonPrefix (a, b) {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i
}
function wordSimilarity (a, b) {
  if (a === b) return 1
  const sa = stem(a); const sb = stem(b)
  if (sa === sb) return 0.9
  const isPre = (x, y) => { const s = Math.min(x.length, y.length); return s >= 3 && commonPrefix(x, y) === s }
  if (isPre(a, b) || isPre(sa, sb)) return 0.8
  const p = commonPrefix(a, b)
  if (p >= 5 && p >= Math.min(a.length, b.length) * 0.75) return 0.7
  return 0
}
const coverage = (from, to) => from.reduce((s, w) => s + Math.max(0, ...to.map(o => wordSimilarity(w, o))), 0) / from.length
export function similarity (query, target) {
  const q = keywords(query); const t = keywords(target)
  if (!q.length || !t.length) return 0
  return 0.7 * coverage(q, t) + 0.3 * coverage(t, q)
}
export function bestMatch (query, items, { min = 0.6, margin = 0.12 } = {}) {
  const ranked = items.map(item => ({ item, score: similarity(query, item.text) })).sort((a, b) => b.score - a.score)
  const [first, second] = ranked
  if (!first || first.score < min) return null
  if (second && first.score - second.score < margin) return null
  return first
}

const REMOVE_RE = /^\s*(?:remove|delete|drop|cancel|discard|forget(?:\s+about)?|skip|scrap|rm|del|don'?t\s+do|no\s+hagas|quita(?:r|me)?|elimina(?:r)?|borra(?:r)?|cancela(?:r)?|olv[ií]da(?:te)?(?:\s+de)?|descarta(?:r)?|saca(?:r|me)?)\s+(.+)$/iu
const MOVE_RE = /^\s*(?:move|mueve|put|pon|prioriti[sz]e|prioriza|bump|send|manda)\s+(.+?)\s+(?:to\s+(?:the\s+)?|al\s+|a\s+la\s+|a\s+|hasta\s+(?:el\s+|la\s+|arriba|abajo)?)?(first|top|front|start|beginning|next|primer[oa]|principio|inicio|arriba|last|end|bottom|final|[uú]ltim[oa]|abajo|fondo)\s*$/iu
const EDIT_RE = /^\s*(?:change|rename|rewrite|replace|edit|cambia|renombra|reescribe|reemplaza|edita)\s+(.+?)\s+(?:to|with|por|con|->|=>)\s+(.+)$/iu
const EVERYTHING_RE = /^(?:all|everything|todo|todas|todos)(?:\s+(?:the|las|los))?(?:\s+(?:tasks|tareas))?$/i
const TO_END = new Set(['last', 'end', 'bottom', 'final', 'ultimo', 'ultima', 'abajo', 'fondo'])
const ORDINALS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, primero: 1, primera: 1, primer: 1, segundo: 2, segunda: 2, tercero: 3, tercera: 3, tercer: 3, cuarto: 4, cuarta: 4, quinto: 5, quinta: 5 }
const ORDINAL_RE = /^(?:the\s+|el\s+|la\s+)?(\w+)(?:\s+(?:one|task|item|tarea))?$/
const CONNECTORS = ['and then', 'y luego', 'y despues', 'then', 'luego', 'despues', 'entonces', '->', '=>', '-', '\u2014', ',', ':', ';'].map(c => c.split(' '))
const ACTION_VERBS = new Set([
  'do', 'make', 'write', 'add', 'create', 'update', 'run', 'fix', 'refactor', 'remove', 'delete',
  'test', 'document', 'generate', 'implement', 'check', 'review', 'commit', 'push', 'deploy', 'build',
  'haz', 'hacer', 'crea', 'crear', 'anade', 'anadir', 'escribe', 'actualiza', 'ejecuta', 'corre',
  'arregla', 'revisa', 'genera', 'implementa', 'elimina', 'borra', 'documenta', 'prueba', 'refactoriza'
])

function byOrdinal (target, items) {
  const word = ORDINAL_RE.exec(normalize(target))?.[1]
  if (!word) return null
  if (TO_END.has(word)) return items.at(-1) ?? null
  return ORDINALS[word] ? items[ORDINALS[word] - 1] ?? null : null
}

function stripConnector (words) {
  const head = words.map(w => normalize(w) || w)
  const conn = CONNECTORS.find(parts => parts.every((part, i) => head[i] === part))
  return conn ? words.slice(conn.length) : null
}

function detectRelative (command, text, items) {
  const words = text.trim().split(/\s+/)
  let best = null
  for (let size = 1; size <= Math.min(6, words.length - 1); size++) {
    let left = words.slice(0, size).join(' ')
    let rest = words.slice(size)
    let linked = false
    if (/[,:;]$/.test(left)) { left = left.replace(/[,:;]+$/, ''); linked = true }
    const afterConn = stripConnector(rest)
    if (afterConn) { rest = afterConn; linked = true }
    if (!rest.length) continue
    if (!linked && !ACTION_VERBS.has(normalize(rest[0]))) continue
    const found = bestMatch(left, items, { min: 0.75 })
    if (found && (!best || found.score > best.found.score)) best = { found, rest: rest.join(' ') }
  }
  if (!best) return null
  return [{ type: 'add', text: best.rest, where: { kind: command === 'before' ? 'before' : 'after', id: best.found.item.id } }]
}

export function resolveHeuristically ({ command, text, items, started = [] }) {
  if (items.length > 0) {
    const rmMatch = text.match(REMOVE_RE)
    if (rmMatch) {
      const target = rmMatch[1].trim()
      if (EVERYTHING_RE.test(normalize(target))) return { ops: [{ type: 'clear' }], via: 'heuristics' }
      const item = byOrdinal(target, items) ?? bestMatch(target, items, { min: 0.6 })?.item
      if (item) return { ops: [{ type: 'remove', ids: [item.id] }], via: 'heuristics' }
    }
    const mvMatch = text.match(MOVE_RE)
    if (mvMatch) {
      const found = bestMatch(mvMatch[1], items, { min: 0.6 })
      if (found) return { ops: [{ type: 'move', id: found.item.id, where: { kind: TO_END.has(normalize(mvMatch[2])) ? 'end' : 'start' } }], via: 'heuristics' }
    }
    const edMatch = text.match(EDIT_RE)
    if (edMatch) {
      const found = bestMatch(edMatch[1], items, { min: 0.75 })
      if (found) return { ops: [{ type: 'edit', id: found.item.id, text: edMatch[2].trim() }], via: 'heuristics' }
    }
    const rel = detectRelative(command, text, items)
    if (rel) return { ops: rel, via: 'heuristics' }
  }
  const rmStarted = text.match(REMOVE_RE)
  if (rmStarted && started.length > 0) {
    const late = bestMatch(rmStarted[1], started, { min: 0.6, margin: 0 })?.item
    if (late) {
      const note = late.status === 'running'
        ? `"${shorten(late.text, 48)}" already started, so it is no longer in the queue (press Esc to interrupt)`
        : `"${shorten(late.text, 48)}" already ran, so there is nothing to remove`
      return { ops: [], via: 'heuristics', note }
    }
  }
  return {
    ops: [{ type: 'add', text: text.trim(), where: { kind: command === 'before' ? 'start' : 'end' } }],
    via: null
  }
}

// --- Deterministic CLI parser ---
const SHOW = new Set(['list', 'ls', 'show', 'status', 'queue', 'watch', 'view'])
const HELP = new Set(['help', '-h', '--help', '?'])
const CLEAR = new Set(['clear', 'reset', 'flush', 'empty'])
const PAUSE = new Set(['pause', 'hold', 'stop'])
const RESUME = new Set(['resume', 'go', 'start', 'unpause', 'play'])
const UNDO = new Set(['undo'])
const REMOVE = new Set(['rm', 'remove', 'del', 'delete', 'drop'])
const EDIT = new Set(['edit', 'set'])
const MOVE = new Set(['mv', 'move'])
const TOP = new Set(['top', 'first', 'prioritize'])
const START_WORDS = /^(?:first|top|start|front|next|primero|arriba)$/i
const END_WORDS = /^(?:last|end|bottom|final|[uú]ltimo|abajo)$/i

export function parseRefs (text) {
  const parts = String(text).toLowerCase().split(/[\s,]+/).filter(Boolean)
  if (!parts.length) return null
  const refs = []
  for (const part of parts) {
    let m
    if ((m = /^#?(\d+)$/.exec(part))) refs.push({ from: Number(m[1]), to: Number(m[1]) })
    else if ((m = /^#?(\d+)(?:-|\.\.)#?(\d+)$/.exec(part))) {
      const [a, b] = [Number(m[1]), Number(m[2])]
      refs.push({ from: Math.min(a, b), to: Math.max(a, b) })
    } else if (END_WORDS.test(part)) refs.push({ last: true })
    else if (/^(?:first|primero)$/.test(part)) refs.push({ from: 1, to: 1 })
    else if (/^(?:all|everything|todo|todas|todos)$/.test(part)) refs.push({ all: true })
    else return null
  }
  return refs
}

function parseTarget (text) {
  const value = text.trim().replace(/^(?:to|a|al)\s+/i, '')
  let m
  if ((m = /^#?(\d+)$/.exec(value))) return { kind: 'index', position: Number(m[1]) }
  if ((m = /^(after|before|despu[eé]s de|antes de)\s+#?(\d+)$/i.exec(value))) {
    return { kind: /^(after|despu)/i.test(m[1]) ? 'afterPos' : 'beforePos', position: Number(m[2]) }
  }
  if (START_WORDS.test(value)) return { kind: 'start' }
  if (END_WORDS.test(value)) return { kind: 'end' }
  return null
}

export function parseArgs (command, rawArgs = '') {
  const args = String(rawArgs).trim()
  if (!args) return { type: 'show' }
  if (args === '--' || args.startsWith('-- ')) {
    const text = args.slice(2).trim()
    return text ? { type: 'add', text, where: { kind: command === 'before' ? 'start' : 'end' } } : { type: 'show' }
  }
  const head = args.split(/\s+/, 1)[0]
  const word = head.toLowerCase()
  const rest = args.slice(head.length).trim()
  if (!rest) {
    if (SHOW.has(word)) return { type: 'show' }
    if (HELP.has(word)) return { type: 'help' }
    if (CLEAR.has(word)) return { type: 'clear' }
    if (PAUSE.has(word)) return { type: 'pause' }
    if (RESUME.has(word)) return { type: 'resume' }
    if (UNDO.has(word)) return { type: 'undo' }
  }
  if (REMOVE.has(word)) { const refs = parseRefs(rest); if (refs) return { type: 'remove', refs } }
  if (EDIT.has(word)) {
    const m = /^#?(\d+)[:.)]?\s+([\s\S]+)$/.exec(rest)
    if (m) return { type: 'edit', position: Number(m[1]), text: m[2].trim() }
  }
  if (MOVE.has(word)) {
    const m = /^#?(\d+)\s+([\s\S]+)$/.exec(rest)
    const to = m && parseTarget(m[2])
    if (to) return { type: 'move', position: Number(m[1]), to }
  }
  if (TOP.has(word)) {
    const m = /^#?(\d+)$/.exec(rest)
    if (m) return { type: 'move', position: Number(m[1]), to: { kind: 'start' } }
  }
  const anchor = /^#(\d+)\s+([\s\S]+)$/.exec(args) ?? /^(\d+)[:)]\s+([\s\S]+)$/.exec(args)
  if (anchor) {
    return { type: 'add', text: anchor[2].trim(), where: { kind: command === 'before' ? 'beforePos' : 'afterPos', position: Number(anchor[1]) } }
  }
  return { type: 'smart', command, text: args }
}

function idAt (state, position) {
  const item = itemAt(state, position)
  if (item) return item.id
  throw new QueueError(state.items.length === 0 ? 'The queue is empty' : `There is no #${position} (queue has ${plural(state.items.length, 'task')})`)
}

function toPlacement (state, where) {
  switch (where.kind) {
    case 'afterPos': return { kind: 'after', id: idAt(state, where.position) }
    case 'beforePos': return { kind: 'before', id: idAt(state, where.position) }
    case 'index':
      if (where.position < 1) throw new QueueError('Positions start at 1')
      return { kind: 'index', index: where.position - 1 }
    default: return where
  }
}

function resolveRefs (state, refs) {
  const count = state.items.length
  if (!count) throw new QueueError('The queue is empty')
  const pos = new Set()
  for (const ref of refs) {
    if (ref.all) state.items.forEach((_, i) => pos.add(i + 1))
    else if (ref.last) pos.add(count)
    else for (let p = ref.from; p <= ref.to; p++) pos.add(p)
  }
  return [...pos].map(p => idAt(state, p))
}

export function applyOps (state, ops, { now = Date.now(), via = null, note = '' } = {}) {
  if (!ops.length) return { state, kind: 'info', title: note || 'Nothing to change', via }
  let next = state
  const titles = []
  try {
    for (const op of ops) {
      if (op.type === 'add') {
        const res = addItem(next, op.text, op.where, now)
        next = res.state
        const at = positionOf(next, res.item.id)
        titles.push(`Queued #${at} · ${shorten(res.item.text, 44)}`)
      } else if (op.type === 'remove') {
        const res = removeItems(next, op.ids)
        next = res.state
        titles.push(`Removed ${plural(res.removed.length, 'task')}`)
      } else if (op.type === 'move') {
        const from = positionOf(next, op.id)
        const res = moveItem(next, op.id, op.where)
        next = res.state
        titles.push(`Moved #${from} -> #${positionOf(next, op.id)}`)
      } else if (op.type === 'edit') {
        const res = editItem(next, op.id, op.text)
        next = res.state
        titles.push(`Edited #${positionOf(next, op.id)} · ${shorten(res.item.text, 40)}`)
      } else if (op.type === 'clear') {
        const res = clearItems(next)
        next = res.state
        titles.push(`Cleared ${plural(res.removed.length, 'task')}`)
      }
    }
  } catch (err) {
    if (err instanceof QueueError) return { state, kind: 'error', title: err.message, via }
    throw err
  }
  return { state: withUndo(state, next), kind: 'ok', title: titles.join(' · '), via }
}

export function runCommandOnState (state, command, rawArgs, now = Date.now()) {
  const intent = parseArgs(command, rawArgs)
  try {
    switch (intent.type) {
      case 'show': return { state, kind: 'list', title: state.items.length ? `${plural(state.items.length, 'task')} queued` : 'Queue empty' }
      case 'help': return { state, kind: 'help', title: 'Queue prompts for Antigravity without steering' }
      case 'add': return applyOps(state, [{ type: 'add', text: intent.text, where: toPlacement(state, intent.where) }], { now })
      case 'remove': return applyOps(state, [{ type: 'remove', ids: resolveRefs(state, intent.refs) }], { now })
      case 'edit': return applyOps(state, [{ type: 'edit', id: idAt(state, intent.position), text: intent.text }], { now })
      case 'move': return applyOps(state, [{ type: 'move', id: idAt(state, intent.position), where: toPlacement(state, intent.to) }], { now })
      case 'clear':
        return state.items.length ? applyOps(state, [{ type: 'clear' }], { now }) : { state, kind: 'info', title: 'The queue is already empty' }
      case 'pause':
        return state.paused
          ? { state, kind: 'info', title: 'Already paused · /after resume to continue' }
          : { state: withUndo(state, setPaused(state, true)), kind: 'paused', title: 'Paused · queued tasks wait until /after resume' }
      case 'resume':
        return !state.paused
          ? { state, kind: 'info', title: state.items.length ? 'Queue active' : 'Nothing queued' }
          : { state: withUndo(state, setPaused(state, false)), kind: 'ok', title: 'Resumed · tasks will run as turns finish' }
      case 'undo': {
        const res = undo(state)
        return res.ok ? { state: res.state, kind: 'ok', title: 'Undid the last queue change' } : { state, kind: 'info', title: 'Nothing to undo' }
      }
      case 'smart': {
        const started = [
          ...(state.running ? [{ ...state.running, status: 'running' }] : []),
          ...state.done.slice(0, 5)
        ]
        const resolved = resolveHeuristically({ command: intent.command, text: intent.text, items: state.items, started })
        return applyOps(state, resolved.ops, { now, via: resolved.via, note: resolved.note })
      }
      default:
        return { state, kind: 'error', title: `Unknown command "${intent.type}"` }
    }
  } catch (err) {
    if (err instanceof QueueError) return { state, kind: 'error', title: err.message }
    throw err
  }
}

export function renderCard (result) {
  const { state, kind, title, via } = result
  const icon = kind === 'error' ? '✗' : kind === 'paused' || state.paused ? '⏸' : kind === 'ok' ? '✓' : '≡'
  const body = [`${icon} ${title}`]

  if (kind === 'help') {
    body.push(
      '',
      '  /after <task>          queue a task at the end (runs when turn finishes)',
      '  /before <task>         queue a task at the front (runs next)',
      '  /after #2 <task>       insert right after #2 (/before #2: right before)',
      '  /after list            print the queue',
      '  /after rm 2 · rm 2-4   remove tasks (also: rm last, rm all)',
      '  /after edit 2 <text>   rewrite a task',
      '  /after mv 3 1 · top 3  reorder tasks',
      '  /after pause · resume  hold or release the queue',
      '  /after undo · clear    undo last change or empty the queue',
      '',
      '  Natural language works too (EN & ES):',
      '  /after tests, write README   ·   /after remove the tests one'
    )
  } else {
    const rows = []
    for (const d of state.done.slice(0, 2).reverse()) {
      rows.push(`  ${d.status === 'stopped' ? '■' : '✓'}  ${shorten(d.text, 52)}${d.status === 'stopped' ? '  (stopped)' : ''}`)
    }
    if (state.running) {
      rows.push(`  ▶  ${shorten(state.running.text, 52)}  (running)`)
    }
    state.items.forEach((item, idx) => {
      rows.push(`  ${String(idx + 1).padStart(1)}  ${shorten(item.text, 52)}`)
    })
    if (rows.length > 0) body.push('', ...rows.slice(0, 10))
    body.push('', '/after <task> · rm <n> · mv <n> <m> · pause · resume · undo · help')
  }

  const badge = via === 'heuristics' ? ' ✦ smart match ' : ''
  const inner = Math.max(...body.map(l => l.length), ' After '.length + badge.length + 6)
  const top = `╭─ After ${'─'.repeat(inner - ' After '.length - badge.length)}${badge}─╮`
  return [top, ...body.map(l => `│ ${l.padEnd(inner)} │`), `╰${'─'.repeat(inner + 2)}╯`].join('\n')
}
