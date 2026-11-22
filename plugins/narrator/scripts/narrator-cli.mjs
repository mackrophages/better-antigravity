#!/usr/bin/env node
import { getPluginConfig, setPluginConfig, readState } from './lib/store.mjs'
import { guessLanguage, isLanguageCode, plain } from './core/text.mjs'
import { detectSynthesizer, listVoicesText, speakDetached, stopSpeaking } from './core/speaker.mjs'

const PREVIEW_EN = 'Hello! Narrator is ready for Antigravity.'
const PREVIEW_ES = 'Hola. El narrador para Antigravity está listo.'

const [sub = '', ...rest] = process.argv.slice(2)
const arg = rest.join(' ').trim()
const cfg = getPluginConfig('narrator', {
  enabled: false,
  language: '',
  voice: '',
  speed: 1.3,
  shortAnswer: 240,
  command: ''
})

if (sub === 'voices') {
  console.log(listVoicesText())
  process.exit(0)
}

if (sub === 'stop') {
  stopSpeaking()
  console.log('Narrator: quiet.')
  process.exit(0)
}

if (sub === 'again') {
  const last = readState('narrator-last.json', null)
  if (!last?.text) {
    console.log('Narrator: nothing said yet.')
    process.exit(0)
  }
  const res = speakDetached({
    text: last.text,
    language: last.language || cfg.language || 'en',
    voice: cfg.voice || '',
    speed: Number(cfg.speed) || 1.3,
    customCommand: cfg.command || ''
  })
  console.log(res.started ? `Narrator: saying it again (${res.synthesizer}): "${last.text}"` : 'Narrator: no synthesizer installed (run `/narrator voices` for setup info).')
  process.exit(0)
}

if (sub === 'read') {
  const lastAns = readState('narrator-last-answer.json', null)
  if (!lastAns?.answer) {
    console.log('Narrator: no answer recorded yet.')
    process.exit(0)
  }
  const text = plain(lastAns.answer)
  const lang = cfg.language || guessLanguage(lastAns.answer) || guessLanguage(lastAns.request) || 'en'
  const res = speakDetached({
    text,
    language: lang,
    voice: cfg.voice || '',
    speed: Number(cfg.speed) || 1.3,
    customCommand: cfg.command || ''
  })
  console.log(res.started ? `Narrator: reading the last answer (${res.synthesizer}).` : `Narrator: no synthesizer available. Text:\n${text}`)
  process.exit(0)
}

if (sub === 'test') {
  const sample = cfg.language === 'es' ? PREVIEW_ES : PREVIEW_EN
  const lang = cfg.language || 'en'
  const res = speakDetached({
    text: sample,
    language: lang,
    voice: arg || cfg.voice || '',
    speed: Number(cfg.speed) || 1.3,
    customCommand: cfg.command || ''
  })
  if (res.started) {
    console.log(`Narrator: playing voice preview via ${res.synthesizer}${arg ? ` (${arg})` : ''}.`)
  } else {
    console.log('Narrator: no local TTS synthesizer found yet. Install `espeak-ng` / `speech-dispatcher` / `termux-api` or set `/narrator command "<cmd>"`.')
  }
  process.exit(0)
}

if (sub === 'lang' || sub === 'language') {
  if (!arg || arg.toLowerCase() === 'auto') {
    setPluginConfig('narrator', { language: '' })
    console.log('Narrator language set to automatic (matches your prompt language).')
    process.exit(0)
  }
  const code = isLanguageCode(arg)
  if (!code) {
    console.error(`Invalid ISO 639-1 language code "${arg}" (examples: es, en, pt, fr, de, it, auto).`)
    process.exit(1)
  }
  setPluginConfig('narrator', { language: code })
  console.log(`Narrator language pinned to ${code.toUpperCase()}.`)
  process.exit(0)
}

if (sub === 'speed') {
  const n = Number(arg)
  if (!Number.isFinite(n) || n < 0.5 || n > 3) {
    console.error('Usage: narrator-cli.mjs speed <0.5..3.0>')
    process.exit(1)
  }
  setPluginConfig('narrator', { speed: n })
  console.log(`Narrator speed set to ${n}x.`)
  process.exit(0)
}

if (sub === 'command') {
  setPluginConfig('narrator', { command: arg })
  console.log(arg ? `Narrator custom TTS command set to: ${arg}` : 'Narrator custom TTS command cleared.')
  process.exit(0)
}

if (sub === '' || sub === 'on' || sub === 'off') {
  const nextEnabled = sub === '' ? !cfg.enabled : sub === 'on'
  if (!nextEnabled) stopSpeaking()
  setPluginConfig('narrator', { enabled: nextEnabled })
  const synth = detectSynthesizer(cfg.command)
  const note = nextEnabled && !synth
    ? ' (Note: no local TTS binary detected yet; run `/narrator voices` for options.)'
    : nextEnabled && synth ? ` (using ${synth.kind})` : ''
  console.log(nextEnabled
    ? `⏵ Narrator on: Antigravity will summarize completed turns out loud${note}.`
    : '⏸ Narrator off.')
  process.exit(0)
}

console.log('Usage: /narrator [on | off | stop | again | read | voices | test [voice] | lang <code|auto> | speed <0.5..3.0> | command "<cmd>"]')
