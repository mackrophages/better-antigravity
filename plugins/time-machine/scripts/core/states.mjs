export function lineOf (states, cursor) {
  const line = new Set()
  if (cursor === null) return line
  const parentOf = new Map()
  for (const state of states) parentOf.set(state.id, state.parent)
  let id = cursor
  while (id !== null && !line.has(id)) {
    line.add(id)
    id = parentOf.get(id) ?? null
  }
  return line
}

export const nextId = states => states.reduce((max, state) => Math.max(max, state.id), 0) + 1

export function normalizeTmState (raw, sessionId, repoTop) {
  const base = raw && typeof raw === 'object' ? raw : {}
  const states = Array.isArray(base.states) ? base.states : []
  let maxId = 0
  for (const s of states) {
    const id = Number(s?.id) || 0
    if (id > maxId) maxId = id
  }
  const ordered = {
    sessionId: base.sessionId || sessionId,
    repoTop: base.repoTop || repoTop,
    cursor: base.cursor ?? null,
    maxId,
    jumpedFrom: base.jumpedFrom ?? null,
    jumpedNoticePending: Boolean(base.jumpedNoticePending),
    lastAgentTree: base.lastAgentTree ?? null
  }
  if (base.pendingTurn) ordered.pendingTurn = base.pendingTurn
  ordered.states = states
  return ordered
}
