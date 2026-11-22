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
