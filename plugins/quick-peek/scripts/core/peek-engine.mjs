// Path detection, resolution, and 40+ language syntax highlighter
// (ported from midudev/better-claude quick-peek/hooks/paths.ts & code.ts).
import os from 'node:os'

const TRAILING = /[.,;:!?)\]}>'"»”’]+$/
const LINE = /:\d+(?::\d+)?$/
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>()]+/gi
const DRIVE = /^[A-Za-z]:[\\/]/

const CANDIDATE = new RegExp(
  [
    String.raw`(?:~|\.{1,2})?\/[^\s\`'"<>()[\]{}|*]+`,
    String.raw`[A-Za-z]:\\[^\s\`'"<>()[\]{}|*]+`,
    String.raw`\.?[\w@+-][\w@.+-]*(?:\/[\w@.+-]+)+\/?`,
    String.raw`\.?[\w@+-][\w@.+-]*\.[A-Za-z][A-Za-z0-9]{0,9}`
  ].map(source => `(?<![\\w/.~:\\\\@-])(?:${source})(?::\\d+(?::\\d+)?)?`).join('|'),
  'g'
)

function clean (text) {
  let target = text.replace(TRAILING, '')
  target = target.replace(LINE, '')
  target = target.replace(TRAILING, '')
  return /[\w~]/.test(target) && target !== '~' ? target : undefined
}

export function lineOf (text) {
  const line = String(text ?? '').trim().replace(TRAILING, '').match(LINE)?.[0]
  return line === undefined ? undefined : Number(line.slice(1).split(':')[0])
}

export function pathsIn (text) {
  const masked = String(text ?? '').replace(URL_RE, m => ' '.repeat(m.length))
  const found = []
  for (const match of masked.matchAll(CANDIDATE)) {
    const whole = match[0]
    const trimmed = whole.replace(TRAILING, '')
    const target = clean(whole)
    if (target === undefined) continue
    found.push({ start: match.index, end: match.index + trimmed.length, target, line: lineOf(trimmed), raw: trimmed })
  }
  return found
}

export function nameOf (p) {
  return p.slice((DRIVE.test(p) ? Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) : p.lastIndexOf('/')) + 1)
}

export function resolvePath (target, cwd, home = os.homedir()) {
  if (/^[A-Za-z]:\\/.test(target)) return target
  let p = target
  if (p === '~' || p.startsWith('~/')) {
    if (!home) return undefined
    p = home + p.slice(1)
  } else if (!p.startsWith('/')) {
    p = `${cwd}/${p}`
  }
  const parts = []
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

// --- Syntax Highlighter ---
const CONTEXT = 3
const TAB = '  '
const LINE_CHARS = 200

function grammar (rules, flags = '') {
  return {
    pattern: rules.length > 0 ? new RegExp(rules.map(([, src]) => `(${src})`).join('|'), `gm${flags}`) : undefined,
    kinds: rules.map(([kind]) => kind)
  }
}

const words = (list) => String.raw`\b(?:${list.split(' ').join('|')})\b`
const block = (open, close) => `${open}[\\s\\S]*?(?:${close}|(?![\\s\\S]))`
const DQ = String.raw`"(?:[^"\\\n]|\\.)*"?`
const SQ = String.raw`'(?:[^'\\\n]|\\.)*'?`
const BT = String.raw`\`(?:[^\`\\]|\\[\s\S])*\`?`
const TRIPLE = String.raw`"""[\s\S]*?(?:"""|(?![\s\S]))|'''[\s\S]*?(?:'''|(?![\s\S]))`
const NUMBER = String.raw`\b(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)n?\b`
const TYPE = String.raw`\b[A-Z][A-Za-z0-9_]*\b`
const CALL = String.raw`\b[A-Za-z_$][\w$]*(?=\()`
const SLASHES = [['c', '//.*'], ['c', block(String.raw`/\*`, String.raw`\*/`)]]

const JS_WORDS = 'abstract as async await break case catch class const continue debugger declare default delete do else enum export extends false finally for from function get if implements import in infer instanceof interface keyof let namespace new null of private protected public readonly return satisfies set static super switch this throw true try type typeof undefined var void while with yield'
const JS_RULES = [...SLASHES, ['s', BT], ['s', DQ], ['s', SQ], ['k', words(JS_WORDS)], ['t', TYPE], ['f', CALL], ['n', NUMBER]]
const JS = grammar(JS_RULES)
const PYTHON = grammar([['c', '#.*'], ['s', TRIPLE], ['s', DQ], ['s', SQ], ['f', String.raw`@[\w.]+`], ['k', words('and as assert async await break case class continue def del elif else except False finally for from global if import in is lambda match None nonlocal not or pass raise return self True try while with yield')], ['t', TYPE], ['f', CALL], ['n', NUMBER]])
const SHELL = grammar([['c', String.raw`(?<![\w$#{])#.*`], ['s', DQ], ['s', `'[^'\\n]*'?`], ['a', String.raw`\$\{[^}\n]*\}?|\$[\w@#?$!*-]`], ['k', words('if then else elif fi for in do done while until case esac function return local export readonly declare set unset shift exit source alias echo cd')], ['n', NUMBER]])
const JSON_G = grammar([...SLASHES, ['a', `${DQ}(?=\\s*:)`], ['s', DQ], ['k', words('true false null')], ['n', `-?${NUMBER}`]])
const YAML = grammar([['c', String.raw`(?<!\S)#.*`], ['k', '^(?:---|\\.\\.\\.)$'], ['a', String.raw`[\w.-][\w .-]*?(?=\s*:(?:\s|$))`], ['s', DQ], ['s', SQ], ['k', words('true false null')], ['n', NUMBER]])
const MARKUP = grammar([['c', block('<!--', '-->')], ['k', String.raw`(?<=<)![A-Za-z]+`], ['k', String.raw`(?<=<|<\/)[A-Za-z][\w:.-]*`], ['a', String.raw`[\w:@.#-]+(?==)`], ['s', String.raw`(?<==)"[^"]*"?`], ['s', String.raw`(?<==)'[^']*'?`]])
const CSS = grammar([['c', block(String.raw`/\*`, String.raw`\*/`)], ['s', DQ], ['s', SQ], ['k', String.raw`@[\w-]+|!important`], ['n', String.raw`#[\da-fA-F]{3,8}\b`], ['a', String.raw`--[\w-]+|[\w-]+(?=\s*:\s)`], ['t', String.raw`[.#][A-Za-z_-][\w-]*`], ['n', String.raw`-?(?:\d+\.?\d*|\.\d+)(?:%|[A-Za-z]+)?`]])
const MARKDOWN = grammar([['c', '^(?:```|~~~).*'], ['k', String.raw`^#{1,6}\s.*`], ['c', '^>.*'], ['n', String.raw`^\s*(?:[-*+]|\d+[.)])(?=\s)`], ['s', '`[^`\\n]+`'], ['t', String.raw`\*\*[^*\n]+\*\*|__[^_\n]+__`], ['a', String.raw`!?\[[^\]\n]*\]\([^)\n]*\)`]])
const GO_RUST_C = grammar([...SLASHES, ['s', DQ], ['s', SQ], ['k', words('async await break case const continue default defer else enum extern false fn for func go if impl import in interface let loop match mod mut nil null package pub range return self static struct switch trait true type unsafe use var where while')], ['t', TYPE], ['f', CALL], ['n', NUMBER]])
const SQL = grammar([['c', '--.*'], ['s', SQ], ['a', DQ], ['k', words('select from where insert into values update set delete create alter drop table index join left right inner outer on group by order asc desc limit offset and or not null as distinct count sum avg min max')], ['n', NUMBER]], 'i')
const PLAIN = grammar([])

const lang = (name, g) => ({ name, grammar: g })
const BY_EXT = {
  js: lang('JavaScript', JS), mjs: lang('JavaScript', JS), cjs: lang('JavaScript', JS), jsx: lang('JSX', JS),
  ts: lang('TypeScript', JS), mts: lang('TypeScript', JS), cts: lang('TypeScript', JS), tsx: lang('TSX', JS),
  json: lang('JSON', JSON_G), jsonc: lang('JSONC', JSON_G), jsonl: lang('JSONL', JSON_G),
  html: lang('HTML', MARKUP), htm: lang('HTML', MARKUP), xml: lang('XML', MARKUP), vue: lang('Vue', MARKUP), svelte: lang('Svelte', MARKUP),
  css: lang('CSS', CSS), scss: lang('SCSS', CSS),
  md: lang('Markdown', MARKDOWN), mdx: lang('MDX', MARKDOWN),
  py: lang('Python', PYTHON), sh: lang('Shell', SHELL), bash: lang('Shell', SHELL), zsh: lang('Shell', SHELL),
  yml: lang('YAML', YAML), yaml: lang('YAML', YAML), toml: lang('TOML', YAML), ini: lang('INI', YAML), env: lang('Env', YAML),
  go: lang('Go', GO_RUST_C), rs: lang('Rust', GO_RUST_C), c: lang('C', GO_RUST_C), cpp: lang('C++', GO_RUST_C), h: lang('Header', GO_RUST_C), java: lang('Java', GO_RUST_C),
  sql: lang('SQL', SQL), txt: lang('Text', PLAIN), log: lang('Log', PLAIN), csv: lang('CSV', PLAIN)
}

export function languageOf (filePath) {
  const name = nameOf(filePath).toLowerCase()
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return lang('Dockerfile', SHELL)
  if (name === 'makefile') return lang('Makefile', SHELL)
  if (name.startsWith('.env') || name === '.gitignore' || name === '.bashrc') return lang('Config', SHELL)
  if (name === 'license' || name === 'readme') return lang('Text', PLAIN)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? BY_EXT[name.slice(dot + 1)] : undefined
}

const ANSI_BY_KIND = {
  k: '\x1b[38;5;208m', // coral keyword
  s: '\x1b[32m',        // green string
  n: '\x1b[94m',        // blue number
  c: '\x1b[90m',        // gray comment
  t: '\x1b[33m',        // yellow type
  a: '\x1b[36m',        // cyan attr/key
  f: '\x1b[97m',        // bright function
  '': ''
}

export function tokenize (source, g) {
  const lines = [[]]
  const push = (kind, text) =>
    text.split('\n').forEach((piece, i) => {
      if (i > 0) lines.push([])
      if (piece === '') return
      const line = lines.at(-1)
      const last = line.at(-1)
      if (last?.[0] === kind) last[1] += piece
      else line.push([kind, piece])
    })
  let at = 0
  if (g.pattern) {
    for (const match of source.matchAll(g.pattern)) {
      if (match[0] === '') continue
      if (match.index > at) push('', source.slice(at, match.index))
      push(g.kinds[match.slice(1).findIndex(grp => grp !== undefined)] ?? '', match[0])
      at = match.index + match[0].length
    }
  }
  push('', source.slice(at))
  return lines
}

export function excerptOf (text, language, line, rows = 20) {
  if (text.trim() === '' || text.includes('\u0000')) return undefined
  const all = text.split(/\r?\n/)
  if (all.length > 1 && all.at(-1) === '') all.pop()
  const mark = line !== undefined && line >= 1 && line <= all.length ? line : 0
  const first = mark > 0 ? Math.max(1, Math.min(mark - Math.min(CONTEXT, Math.floor(rows / 3)), all.length - rows + 1)) : 1
  const shown = all.slice(first - 1, first - 1 + rows).map(r => r.replaceAll('\t', TAB).trimEnd())
  while (shown.length > 1 && shown.at(-1) === '' && first + shown.length - 1 !== mark) shown.pop()
  const nonEmpty = shown.filter(r => r !== '')
  const indent = nonEmpty.length ? Math.min(...nonEmpty.map(r => r.length - r.trimStart().length)) : 0
  const source = shown.map(r => r.slice(indent).slice(0, LINE_CHARS)).join('\n')
  return { language: language.name, count: all.length, first, mark, source, lines: tokenize(source, language.grammar) }
}

export function renderColoredExcerpt (excerpt) {
  const maxLineNo = excerpt.first + excerpt.lines.length - 1
  const numWidth = String(maxLineNo).length
  return excerpt.lines.map((tokens, i) => {
    const lineNo = excerpt.first + i
    const isTarget = lineNo === excerpt.mark
    const gutter = isTarget
      ? `\x1b[38;5;208m\x1b[1m▶ ${String(lineNo).padStart(numWidth)}\x1b[0m`
      : `  \x1b[90m${String(lineNo).padStart(numWidth)}\x1b[0m`
    const code = tokens.map(([kind, txt]) => `${ANSI_BY_KIND[kind] || ''}${txt}\x1b[0m`).join('')
    return `${gutter} │ ${code}`
  }).join('\n')
}
