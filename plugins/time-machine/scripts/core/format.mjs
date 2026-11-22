const LABEL_MAX = 60
const FEW = 2
const GROUPS = 2

export const ICON = { A: '+', D: '−', M: '~' }

export function shorten (text, max = LABEL_MAX) {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export function summary (files) {
  const added = files.reduce((sum, file) => sum + (file.added ?? 0), 0)
  const removed = files.reduce((sum, file) => sum + (file.removed ?? 0), 0)
  return files.length === 0 ? 'no files' : `${files.length} file${files.length === 1 ? '' : 's'} +${added} −${removed}`
}

const shortPath = p => p.split('/').slice(-2).join('/')

export function digest (files) {
  if (files.length <= FEW) {
    return { kind: 'few', files: files.map(file => ({ ...file, name: shortPath(file.path) })) }
  }
  const split = files.map(file => file.path.split('/'))
  let shared = 0
  while (split.every(parts => parts.length > shared + 1 && parts[shared] === split[0][shared])) shared++
  const counts = new Map()
  for (const parts of split) {
    const rest = parts.slice(shared)
    const group = rest.length > 1 ? `${rest[0]}/` : rest[0]
    counts.set(group, (counts.get(group) ?? 0) + 1)
  }
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  return {
    kind: 'many',
    count: files.length,
    added: files.reduce((sum, file) => sum + (file.added ?? 0), 0),
    removed: files.reduce((sum, file) => sum + (file.removed ?? 0), 0),
    groups: ranked.slice(0, GROUPS).map(([name, n]) => n > 1 ? `${name} ×${n}` : name),
    more: Math.max(0, ranked.length - GROUPS)
  }
}

export function digestText (files) {
  if (!files || files.length === 0) return 'no files'
  const d = digest(files)
  if (d.kind === 'few') {
    return d.files.map(f => {
      const counts = f.added !== null && f.removed !== null
        ? ` +${f.added}${f.removed ? ` −${f.removed}` : ''}`
        : ''
      return `${ICON[f.status] ?? '~'} ${f.name}${counts}`
    }).join('   ')
  }
  return `${d.count} files +${d.added} −${d.removed} · ${d.groups.join(' · ')}${d.more ? ` · +${d.more}` : ''}`
}

export function ago (ms) {
  const minutes = Math.round(ms / 60000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}
