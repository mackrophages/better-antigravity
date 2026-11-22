import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WEB_HTML = path.join(ROOT, 'web', 'index.html')

describe('web/index.html offline deliverable contract', () => {
  it('starts with UTF-8 charset on line 1, has zero external assets or em-dashes, and valid inline JS', () => {
    const html = fs.readFileSync(WEB_HTML, 'utf8')
    const firstLine = html.split('\n')[0]
    assert.match(firstLine, /^<!doctype html><html lang="es"><head><meta charset="utf-8">/i)
    assert.equal(html.includes('\u2014'), false, 'HTML must contain zero em-dashes')
    assert.doesNotMatch(html, /<script[^>]+src=/i, 'No external script src allowed')
    assert.doesNotMatch(html, /<link[^>]+stylesheet/i, 'No external stylesheet link allowed')

    const scriptMatch = /<script>([\s\S]*?)<\/script>/i.exec(html)
    assert.ok(scriptMatch, 'Inline <script> block must exist')
    // Compile inline JS with node:vm to guarantee zero syntax errors
    const compiled = new vm.Script(scriptMatch[1], { filename: 'web/index.html' })
    assert.ok(compiled)

    // Verify all 11 plugins are embedded in CATALOG and selectable
    for (const id of [
      'quick-peek', 'image-preview', 'sub-meter', 'context-meter', 'commit',
      'narrator', 'time-machine', 'after', 'use-flash', 'think-hard', 'token-meter'
    ]) {
      assert.ok(html.includes(`data-plugin="${id}"`), `Missing picker button for ${id}`)
    }
    assert.ok(html.includes('&lt;tarea&gt;'), 'Angle brackets inside code spans must be HTML-escaped')
    assert.equal(html.includes('<code>/after <tarea>'), false, 'No unescaped <tarea> tag allowed')
    assert.match(html, /install\.sh /)
  })
})
