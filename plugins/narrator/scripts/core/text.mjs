// Markdown-to-speech cleaning, language detection, and closing question extraction
// (exact port of midudev/better-claude narrator/hooks/text.ts).

const DISPLAY_NAMES = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' })
const WORDS = {
  en: new Set(['the', 'and', 'is', 'to', 'of', 'it', 'you', 'that', 'with', 'for', 'this', 'are']),
  es: new Set(['el', 'la', 'que', 'de', 'y', 'en', 'los', 'las', 'es', 'para', 'por', 'una', 'del', 'he']),
  pt: new Set(['o', 'que', 'não', 'em', 'um', 'uma', 'os', 'você', 'está', 'do', 'da', 'foi']),
  fr: new Set(['le', 'la', 'les', 'et', 'est', 'des', 'une', 'pour', 'que', 'dans', 'vous', 'pas']),
  de: new Set(['der', 'die', 'das', 'und', 'ist', 'nicht', 'ich', 'mit', 'für', 'sie', 'den', 'ein']),
  it: new Set(['il', 'che', 'di', 'è', 'per', 'una', 'con', 'non', 'sono', 'gli', 'della', 'ho'])
}

const HASH = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g
const EXTENSION = /(.)(?:\.[a-z][a-z0-9]{0,4})+$/i

const fileName = (p) => (p.split(/[\\/]/).filter(Boolean).pop() ?? '').replace(EXTENSION, '$1')
const isPath = (w) => /[a-z]/i.test(fileName(w)) && (/^(?:~|\.{1,2})?\//.test(w) || EXTENSION.test(w) || w.split('/').length > 2)

export function cut (text, size) {
  const str = String(text ?? '')
  if (str.length <= size) return str
  const head = str.slice(0, size)
  const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '))
  return end > size / 2 ? head.slice(0, end + 1) : `${head.trimEnd()}.`
}

export function plain (markdown) {
  return String(markdown ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`([^`]*)`/g, (_, inside) => (/^[^\s/\\]*([/\\][^\s/\\]*)+$|^[\w-]+\.[a-z][a-z0-9]{0,4}$/i.test(inside) ? fileName(inside) : inside))
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^\s{0,3}(#{1,6}|[-*+•]|\d+[.)]|>)\s+/gm, '')
    .replace(/[\w.@~-]*\/[\w.@~/-]*[\w@~/-]/g, word => (isPath(word) ? fileName(word) : word))
    .replace(HASH, ' ')
    .replace(/\(\s*\)/g, ' ')
    .replace(/[*_~|#>]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/ ([.,;:!?？؟])/g, '$1')
    .replace(/^[\s-]+/, '')
    .trim()
}

export function guessLanguage (text) {
  const words = String(text ?? '').toLowerCase().match(/\p{L}+/gu) ?? []
  let best = ''
  let most = 1
  for (const [language, common] of Object.entries(WORDS)) {
    let count = 0
    for (const word of words) if (common.has(word)) count++
    if (count > most) [best, most] = [language, count]
  }
  return best
}

const sentences = (text) => String(text ?? '').split(/(?<=[.!?…؟])\s+|(?<=[。！？])\s*/).filter(Boolean)
const isQuestion = (s) => /[?？؟]$/.test(s)

export function finalQuestion (answer) {
  const last = plain(String(answer ?? '').trim().split('\n').filter(l => l.trim()).pop() ?? '')
  const asked = []
  for (const s of sentences(last).reverse()) {
    if (!isQuestion(s)) break
    asked.unshift(s)
  }
  const q = asked.join(' ')
  return q.length <= 200 ? q : ''
}

export function withQuestion (narration, question) {
  if (!narration || !question || narration.includes(question)) return narration
  const said = sentences(narration)
  while (said.length > 0 && isQuestion(said.at(-1))) said.pop()
  return said.length > 0 ? `${said.join(' ')} ${question}` : question
}

export function isLanguageCode (code) {
  const clean = String(code ?? '').trim().split(/[-_]/)[0].toLowerCase()
  if (!/^[a-z]{2,3}$/.test(clean)) return ''
  try {
    return DISPLAY_NAMES.of(clean) ? clean : ''
  } catch {
    return ''
  }
}

/** Builds a concise 1-2 sentence spoken summary from an assistant answer without extra API latency. */
export function conciseSpokenSummary (answer, maxChars = 240) {
  const cleaned = plain(answer)
  if (!cleaned) return ''
  if (cleaned.length <= maxChars) return cleaned
  const question = finalQuestion(answer)
  const sents = sentences(cleaned).filter(s => !isQuestion(s))
  const picked = sents.slice(0, 2).join(' ')
  const body = cut(picked || cleaned, maxChars)
  return withQuestion(body, question)
}
