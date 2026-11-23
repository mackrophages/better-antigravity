// Cross-platform TTS synthesis & background speaker queue for Narrator
// Supports: custom command, Termux Android TTS, macOS AVSpeechSynthesizer,
// Windows/WSL OneCore + SAPI, and Linux spd-say / espeak-ng / espeak.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isNarratorWorkerAlive, readState, updateState, writeState } from '../lib/store.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const TERMUX_TTS = '/data/data/com.termux/files/usr/bin/termux-tts-speak'

const clamp = (v, min, max) => Math.min(Math.max(v, min), max)
export const dispatcherRate = (speed) => Math.round(clamp(((speed - 1) * 170 * 100) / (speed >= 1 ? 279 : 90), -100, 100))
export const espeakWords = (speed) => Math.round(clamp(175 * speed, 80, 450))

function which (bin) {
  if (bin.startsWith('/')) return fs.existsSync(bin) ? bin : null
  const res = spawnSync('sh', ['-c', `command -v "${bin}"`], { encoding: 'utf8' })
  return res.status === 0 ? res.stdout.trim() : null
}

export function detectSynthesizer (customCommand = '') {
  if (customCommand) return { kind: 'custom', bin: customCommand }
  if (os.platform() === 'darwin' && which('osascript')) return { kind: 'macos', bin: 'osascript' }
  if (os.platform() === 'win32') return { kind: 'windows', bin: 'powershell' }
  if (process.env.WSL_DISTRO_NAME && which('powershell.exe')) return { kind: 'wsl', bin: 'powershell.exe' }
  if (which('termux-tts-speak')) return { kind: 'termux', bin: which('termux-tts-speak') }
  if (fs.existsSync(TERMUX_TTS)) return { kind: 'termux', bin: TERMUX_TTS }
  for (const tool of ['spd-say', 'espeak-ng', 'espeak']) {
    const found = which(tool)
    if (found) return { kind: tool, bin: found }
  }
  return null
}

export function listVoicesText () {
  const found = []
  if (os.platform() === 'darwin' && which('osascript')) {
    const jxa = `ObjC.import('AVFoundation');const a=$.AVSpeechSynthesisVoice.speechVoices;const r=[];for(let i=0;i<a.count;i++){const v=a.objectAtIndex(i);r.push(ObjC.unwrap(v.language)+': '+ObjC.unwrap(v.name))}console.log(r.sort().join('\\n'))`
    const res = spawnSync('osascript', ['-l', 'JavaScript', '-e', jxa], { encoding: 'utf8', timeout: 8000 })
    if (res.stdout?.trim()) found.push(`macOS voices:\n${res.stdout.trim()}`)
  }
  if (which('termux-tts-engines') || fs.existsSync('/data/data/com.termux/files/usr/bin/termux-tts-engines')) {
    const bin = which('termux-tts-engines') || '/data/data/com.termux/files/usr/bin/termux-tts-engines'
    const res = spawnSync(bin, [], { encoding: 'utf8', timeout: 5000 })
    if (res.stdout?.trim()) found.push(`Termux TTS engines:\n${res.stdout.trim()}`)
  }
  for (const [tool, flag] of [['spd-say', '-L'], ['espeak-ng', '--voices'], ['espeak', '--voices']]) {
    const bin = which(tool)
    if (!bin) continue
    const res = spawnSync(bin, [flag], { encoding: 'utf8', timeout: 5000 })
    if (res.stdout?.trim()) found.push(`${tool} voices:\n${res.stdout.trim().split('\n').slice(0, 25).join('\n')}`)
  }
  if (found.length === 0) {
    return 'Narrator: no installed system synthesizer found yet.\n' +
      'Install `espeak-ng` or `speech-dispatcher` on Linux (`apt install espeak-ng`), `termux-api` on Android Termux, or set a custom TTS command with `/narrator command "<cmd>"`.'
  }
  return found.join('\n\n')
}

export function stopSpeaking () {
  const runtime = readState('narrator-runtime.json', {})
  const pid = Number(runtime?.speakingPid)
  if (pid > 0 && isNarratorWorkerAlive(pid, runtime?.startedAt)) {
    try { process.kill(-pid, 'SIGTERM') } catch {}
    try { process.kill(pid, 'SIGTERM') } catch {}
  }
  if (which('spd-say')) {
    spawnSync('spd-say', ['-S'], { stdio: 'ignore' })
  }
  updateState('narrator-runtime.json', {}, curr => ({ ...(curr || {}), speakingPid: null, stoppedAt: Date.now() }))
}

export function buildSpeakCommand (synth, { text, language = '', voice = '', speed = 1.3 }) {
  if (!synth) return null
  if (synth.kind === 'custom') {
    return { cmd: 'sh', args: ['-c', `${synth.bin} "$1"`, 'narrator-custom', text] }
  }
  if (synth.kind === 'termux') {
    const args = []
    if (language) args.push('-l', language)
    if (speed && speed !== 1) args.push('-r', String(clamp(speed, 0.5, 3)))
    args.push(text)
    return { cmd: synth.bin, args }
  }
  if (synth.kind === 'macos') {
    const rate = Math.min(Math.max(speed >= 1 ? 0.5 + (speed - 1) / 6 : 0.5 - (1 - speed) / 0.88, 0.1), 1)
    const jxa = `ObjC.import('AVFoundation');const s=$.AVSpeechSynthesizer.alloc.init;const u=$.AVSpeechUtterance.speechUtteranceWithString(${JSON.stringify(text)});u.rate=${rate};s.speakUtterance(u);const l=$.NSRunLoop.currentRunLoop;while(s.speaking){l.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.1))}`
    return { cmd: 'osascript', args: ['-l', 'JavaScript', '-e', jxa] }
  }
  if (synth.kind === 'windows' || synth.kind === 'wsl') {
    const sapiRate = Math.max(-10, Math.min(10, Math.round(10 * Math.log(speed || 1) / Math.log(3))))
    const ps = `Add-Type -AssemblyName System.Speech;$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;$s.Rate=${sapiRate};$s.Speak($env:NARRATOR_TEXT)`
    return { cmd: synth.bin, args: ['-NoProfile', '-NonInteractive', '-Command', ps], env: { NARRATOR_TEXT: text } }
  }
  if (synth.kind === 'spd-say') {
    const args = ['-w']
    if (language) args.push('-l', language)
    if (voice) args.push('-y', voice)
    if (speed !== 1) args.push('-r', String(dispatcherRate(speed)))
    args.push('--', text)
    return { cmd: synth.bin, args }
  }
  const args = []
  const v = voice || language
  if (v) args.push('-v', v)
  if (speed !== 1) args.push('-s', String(espeakWords(speed)))
  args.push('--', text)
  return { cmd: synth.bin, args }
}

/** Spawns a detached background worker so Stop hooks return immediately without blocking TUI. */
export function speakDetached ({ text, language = '', voice = '', speed = 1.3, customCommand = '' }) {
  const synth = detectSynthesizer(customCommand)
  writeState('narrator-last.json', { text, language, at: Date.now(), synthesizer: synth?.kind ?? null })
  if (!synth) return { started: false, reason: 'no-synthesizer' }

  stopSpeaking()
  const workerScript = path.join(here, 'speak-worker.mjs')
  const child = spawn(process.execPath, [workerScript], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      NARRATOR_PAYLOAD: JSON.stringify({ synth, text, language, voice, speed })
    }
  })
  child.unref()
  updateState('narrator-runtime.json', {}, curr => ({
    ...(curr || {}),
    speakingPid: child.pid,
    startedAt: Date.now(),
    synthesizer: synth.kind
  }))
  return { started: true, pid: child.pid, synthesizer: synth.kind }
}
