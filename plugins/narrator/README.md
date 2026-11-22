# Narrator

Run `/narrator` to turn spoken summaries on or off (`⏵ narrator on` / `⏸ narrator off` in the CLI status line). After each completed turn, Narrator strips code blocks, URLs, and hashes, speaks file paths naturally by basename, preserves any closing question, and reads the summary out loud in your language.

| System | Free Voice Engine Used |
| :--- | :--- |
| **macOS** | `AVSpeechSynthesizer` (Siri & natural voices via `osascript`) |
| **Windows / WSL** | `System.Speech` / OneCore (`powershell` / `powershell.exe`) |
| **Linux** | `spd-say` (`speech-dispatcher`), `espeak-ng`, or `espeak` |
| **Android / Termux** | `termux-tts-speak` (`termux-api`) |

Multiple terminal windows share a cross-session ticket queue so two sessions never talk over one another, and sending a new prompt immediately silences active speech.

## Commands

- `/narrator` · `/narrator on` · `/narrator off`: Switch spoken summaries on or off.
- `/narrator stop`: Silence active narration immediately.
- `/narrator again`: Repeat the last narration.
- `/narrator read`: Read the last assistant reply in full.
- `/narrator voices` · `/narrator test [voice]`: Inspect and test installed voices.
- `/narrator lang <es|en|...|auto>` · `/narrator speed <0.5..3.0>`: Configure language and rate.

## Install

```bash
agy plugin install ./plugins/narrator
```

MIT License · Original concept and text cleaning logic by Miguel Ángel Durán (midudev).
