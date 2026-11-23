// Which Bash commands only look (adapted from midudev/better-claude time-machine).
const GIT = 'git(?:\\s+-C\\s+\\S+)?\\s+'
const LOOKS = new RegExp(`^(?:cd|ls|ll|pwd|cat|head|tail|less|wc|grep|egrep|rg|ag|find|fd|tree|file|stat|du|df|which|type|echo|printf|date|whoami|uname|diff|cmp|jq|${GIT}(?:status|log|diff|show|blame|grep|ls-files|ls-tree|rev-parse|rev-list|describe|shortlog|reflog|for-each-ref|show-ref|cat-file|merge-base|name-rev|check-ignore|count-objects))(?:\\s|$)`)
const LOOKS_EXACTLY = new RegExp(`^(?:env|${GIT}(?:branch(?:\\s+(?:-a|-r|-v|-vv|--list|--show-current))*|remote(?:\\s+-v)?|stash\\s+list|config\\s+--get\\S*\\s+\\S+))\\s*$`)
const WRITES = /[>`]|[$<]\(|\b(?:tee|xargs)\b|\bdate\s+-(?:s|-set)\b|\bfile\s+-(?:C|-compile)\b|\s-(?:delete|exec|execdir|ok|fls|fprint\S*|[xXo])(?:\s|$)|\s--(?:exec(?:-batch)?|output|pre)\b/
const HARMLESS = /\s*(?:\d?>&\d|\d?>\s*\/dev\/null)/g

export function readOnly (command) {
  const plain = String(command ?? '').replace(HARMLESS, '')
  if (WRITES.test(plain)) return false
  const segments = plain.split(/\|\||&&|[|;&\n]/).map(part => part.trim()).filter(Boolean)
  return segments.length > 0 && segments.every(part => LOOKS.test(part) || LOOKS_EXACTLY.test(part))
}
