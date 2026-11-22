#!/usr/bin/env node
// Builds a 100% self-contained single-file `web/index.html` (UTF-8 charset on line 1,
// zero external CSS/JS/font requests, zero em-dashes) adapted from betterclaude.dev
// for Google Antigravity (`agy`), embedding all 11 plugin READMEs and source files.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGINS_DIR = path.join(ROOT, 'plugins')

const ORDER = [
  {
    id: 'quick-peek',
    title: 'Quick Peek',
    summary: 'Convierte rutas en las respuestas en vistas previas coloreadas (20 líneas alrededor de `:línea`, carpetas, imágenes, PDFs y fotogramas de video) y las revela en tu gestor de archivos (`termux-open`, `Finder`, `Explorer` o `xdg-open`).',
    demoHtml: `<div class="demo"><p class="line"><span class="p">&gt; </span><span class="accent">/quick-peek</span> scripts/better-statusline.mjs:44</p><p class="line"><span class="path-link" data-peek="statusline">📄 scripts/better-statusline.mjs:44</span> <span class="dim">JavaScript · 395 líneas · 14.9 KB</span></p><p class="line"><span class="accent">▶  44 │</span> function writeJsonAtomic (filePath, data) {</p></div>`
  },
  {
    id: 'image-preview',
    title: 'Image Preview',
    summary: 'Dibuja vistas previas Unicode truecolor de 24 bits (muestreo subpíxel 8x8 en luz lineal) de imágenes, páginas PDF y videos directamente en la terminal o las abre en el visor del sistema sin requerir ImageMagick.',
    demoHtml: `<div class="demo"><p class="line"><span class="p">&gt; </span><span class="accent">/image-preview</span> recent</p><p class="line"><span class="accent">▀▀▖▗▀▖</span> <span class="up">▊▎▗▘▃</span> <span class="down">▗▀▖▀▂</span>  <span class="dim">logo.svg · 128x128 · 1.2 KB</span></p></div>`
  },
  {
    id: 'sub-meter',
    title: 'Sub Meter',
    summary: 'Tu consumo de cuota de modelos en vivo abajo en la barra `statusLine` de Antigravity CLI: alterna entre la ventana de 5 horas y la semanal (o muestra ambas lado a lado) con cuenta regresiva de reinicio compartida entre sesiones.',
    demoHtml: `<div class="demo"><p class="line footer-line"><span class="mode">● READY · accept-edits</span><span id="sub-meter"><span class="dim">5h </span><span class="accent">━━━━━━</span><span class="dim">────</span> 58% <span class="dim">↻ 2h 10m</span></span></p></div>`
  },
  {
    id: 'context-meter',
    title: 'Context Meter',
    summary: 'Mide qué tan llena está la ventana de contexto en `statusLine`: gris bajo 50 %, amarillo desde 50 % para recordar `/compact` y rojo desde 75 % con aviso inline sin gastar tokens del modelo.',
    demoHtml: `<div class="demo"><p class="line footer-line"><span class="dim">ventana activa</span><span id="context-meter" class="warn">context 58% · /compact</span></p><hr class="tm-rule"><p class="line"><span class="p">&gt; </span>revisa el módulo de recepción de pedidos</p></div>`
  },
  {
    id: 'commit',
    title: 'Commit',
    summary: 'Escribe `/commit`, elige con `ask_question` entre `Commit + push`, `Commit only` o `Commit on a new branch`, filtra `.env*` y secretos de forma determinista y divide los cambios en Conventional Commits limpios sin firmas de IA.',
    demoHtml: `<div class="demo"><p class="line"><span class="p">&gt; </span><span class="accent">/commit</span></p><p class="line">  <span class="accent">❯ 1. (Recommended) Commit + push</span></p><p class="line"><span class="dim">    2. Commit only</span></p><p class="line"><span class="dim">    3. Commit on a new branch</span></p><p class="line">  feat(hud): add progressive width shrink <span class="dim">· pushed to main</span></p></div>`
  },
  {
    id: 'narrator',
    title: 'Narrator',
    summary: 'Ejecuta `/narrator` (`⏵ narrator on` en `statusLine`) y al cerrar cada turno Antigravity te cuenta en voz alta qué hizo, en tu idioma, usando voces libres del sistema (Siri, OneCore, Speech Dispatcher / `espeak-ng` o `termux-tts-speak`).',
    demoHtml: `<div class="demo" id="narrator-demo"><p class="line"><span class="p">&gt; </span>agrega modo oscuro a la pantalla de ajustes</p><p class="line"><span class="accent">●</span> Agregué el selector de tema oscuro en <code>settings.tsx</code> y las 13 pruebas quedaron en verde.</p><p class="line footer-line"><span class="mode">● READY</span><button type="button" class="voice-btn" id="voice-btn" aria-pressed="false">⏸ narrator off (probar voz)</button></p></div>`
  },
  {
    id: 'time-machine',
    title: 'Time Machine',
    summary: 'Cada turno que modifica archivos (incluyendo comandos Bash) guarda un snapshot Git aislado en su propio índice sin tocar `HEAD`, ramas ni staging. Con `/timeline` viajas atrás o adelante sin perder ediciones manuales.',
    demoHtml: `<div class="demo" id="tm-demo"><p class="line"><span class="p">&gt; </span><span class="accent">/timeline</span></p><p class="line footer-line"><span class="accent">⏪ Time Machine</span><span class="dim" id="tm-head">3 estados</span></p><p class="line"><span id="tm-mark-3" class="accent">◉</span>  <button type="button" class="tm-btn" data-tm="3">#3  add rate limiting to the API</button><span class="dim">   2m</span></p><p class="line"><span id="tm-mark-2">●</span>  <button type="button" class="tm-btn" data-tm="2">#2  add migration for users table</button><span class="dim">   7m</span></p><p class="line"><span id="tm-mark-1">●</span>  <button type="button" class="tm-btn" data-tm="1">#1  start of the session</button><span class="dim">   14m</span></p><hr class="tm-rule"><p class="line"><span class="dim">actual </span><span class="accent" id="tm-cur">#3</span><span class="dim"> · salto previo </span><span class="warn" id="tm-from">-</span> · <button type="button" class="tm-btn accent" data-tm="undo">undo</button> / <button type="button" class="tm-btn accent" data-tm="redo">redo</button></p></div>`
  },
  {
    id: 'after',
    title: 'After',
    summary: 'Cola FIFO sin desviar el turno activo: `/after <tarea>` y `/before <tarea>` (o `agy-after after "<tarea>"` desde una segunda terminal) encolan pendientes y el hook `Stop` devuelve `decision: "continue"` para ejecutarlos en orden al terminar.',
    demoHtml: `<div class="demo"><p class="line"><span class="p">&gt; </span><span class="accent">/after</span> ejecutar pruebas y actualizar README</p><p class="line"><span class="down">✓</span> Queued #1 · o desde otra terminal: <code>agy-after after "revisar linter"</code></p></div>`
  },
  {
    id: 'use-hydrogen',
    title: 'Use Hydrogen',
    summary: 'Adaptación de Use Haiku para Antigravity sobre Gemini 4 Hydrogen (`gemini-4-hydrogen-high`, configurable en `low|medium|high|xhigh`): empezar con `_` ejecuta ese turno en Hydrogen verificando el modelo en `transcript.jsonl`, o usa `agy-hydrogen` para abrir sesión directa.',
    demoHtml: `<div class="demo"><p class="line"><span class="p">&gt; </span><span class="accent">_</span>resume los cambios del último commit</p><p class="line"><span class="up">⚡ Answered by gemini-4-hydrogen-high</span> <span class="dim">(2.4s · ↓ 18 tokens · <code>__init__.py</code> se ignora)</span></p></div>`
  },
  {
    id: 'think-hard',
    title: 'Think Hard',
    summary: 'Empieza cualquier prompt con `+` y ese único turno activa rigor analítico máximo (`+MAX` en `statusLine`: descomposición desde primeros principios y verificación de casos borde) manteniendo el resto de la sesión intacto.',
    demoHtml: `<div class="demo"><p class="line"><span class="p">&gt; </span><span class="accent">+</span>planifica el refactor del parser y revisa condiciones de carrera</p><p class="line"><span class="accent">🧠 Think Hard (+)</span> <span class="dim">· razonamiento profundo activo en este turno</span></p></div>`
  },
  {
    id: 'token-meter',
    title: 'Token Meter',
    summary: 'Muestra al cierre de cada turno los tokens de entrada (`↑`), salida (`↓`) y caché junto al acumulado de la sesión en colores dentro de la barra `statusLine` y mediante `/token-meter`.',
    demoHtml: `<div class="demo"><p class="line"><span class="up">↑</span> 1.2k  <span class="down">↓</span> 340  <span class="accent">cache</span> 4.1k<span class="dim">  ·  session ↑ 12.4k  ↓ 3.1k</span></p></div>`
  }
]

function collectFiles (dir, prefix = '') {
  const out = {}
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'lib' || e.name.startsWith('.')) continue
    const full = path.join(dir, e.name)
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isDirectory()) Object.assign(out, collectFiles(full, rel))
    else if (/\.(json|md|mjs|svg)$/i.test(e.name) && fs.statSync(full).size < 64_000) {
      out[rel] = fs.readFileSync(full, 'utf8')
    }
  }
  return out
}

const catalog = {}
for (const item of ORDER) {
  const pDir = path.join(PLUGINS_DIR, item.id)
  const files = collectFiles(pDir)
  const svgRaw = files['assets/logo.svg'] || ''
  catalog[item.id] = {
    title: item.title,
    readme: files['README.md'] || '',
    svg: svgRaw,
    files
  }
}

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const inlineCode = (s) => escapeHtml(s).replace(/`([^`]+)`/g, '<code>$1</code>')

const cardsHtml = ORDER.map((item) => {
  const svgInline = (catalog[item.id].svg || '')
    .replace(/width="128"\s+height="128"/, 'class="icon" aria-hidden="true"')
  return `      <li class="plugin" id="p-${item.id}">
        <div class="meta">
          ${svgInline}
          <h2>${item.title}</h2>
          <ul class="links">
            <li><button type="button" data-open-reader="${item.id}" data-tab="docs"><span>docs</span></button></li>
            <li><button type="button" data-open-reader="${item.id}" data-tab="source"><span>código</span></button></li>
            <li><button type="button" class="install-one" data-install="${item.id}"><span>copiar prompt</span></button></li>
          </ul>
        </div>
        <div class="body">
          <p>${inlineCode(item.summary)}</p>
          ${item.demoHtml}
        </div>
      </li>`
}).join('\n\n')

const picksHtml = ORDER.map(item =>
  `          <li><button type="button" class="pick" data-plugin="${item.id}" aria-pressed="true">${item.title}</button></li>`
).join('\n')

const catalogJson = JSON.stringify(catalog).replace(/<\//g, '<\\/')

const html = `<!doctype html><html lang="es"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Better Antigravity | 11 Plugins y Barra statusLine para Google Antigravity (agy)</title>
  <meta name="description" content="Adaptación nativa y de código abierto de betterclaude.dev (midudev/better-claude) para Google Antigravity (agy). Instala en un solo prompt.">
  <style>
    :root {
      --bg: #050505;
      --surface: #0c0c0c;
      --fg: #ececec;
      --soft: #a4a4a4;
      --muted: #666666;
      --line: #1c1c1c;
      --accent: #d77757;
      --accent-soft: rgba(215, 119, 87, 0.15);
      --panel: clamp(420px, 46vw, 680px);
    }
    @media (max-width: 900px) { :root { --panel: 100vw; } }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: radial-gradient(680px 380px at 18% -60px, rgba(215, 119, 87, 0.14), transparent 70%), var(--bg);
      color: var(--fg);
      font: 14px/1.7 ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      -webkit-font-smoothing: antialiased;
    }
    ::selection { background: var(--accent); color: #000; }
    a { color: inherit; text-decoration: none; }
    code { padding: 1px 5px; border-radius: 4px; background: #151515; color: var(--fg); font-size: 12.5px; }
    .accent { color: var(--accent); }
    .dim { color: var(--muted); }
    .warn { color: #e5c07b; }
    .err { color: #e06c75; }
    .up { color: #afd7ff; }
    .down { color: #87d787; }

    main { max-width: 800px; margin: 0 auto; padding: 64px 18px 72px; transition: opacity 0.25s; }
    .badge-top {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 4px 12px; border-radius: 999px;
      background: #121212; border: 1px solid #262626;
      color: var(--soft); font-size: 12px; margin-bottom: 18px;
    }
    .badge-dot { width: 7px; height: 7px; border-radius: 50%; background: #87d787; }
    h1 {
      margin: 0;
      font-size: clamp(34px, 8vw, 56px);
      line-height: 1.05;
      letter-spacing: -0.02em;
    }
    h1 span { color: var(--accent); }
    .lede { margin: 18px 0 0; max-width: 62ch; color: var(--soft); font-size: 14.5px; }
    .lede a { color: var(--fg); border-bottom: 1px solid #3a3a3a; }
    .lede a:hover { color: var(--accent); border-color: var(--accent); }

    .install {
      margin: 38px 0 0;
      padding: 22px;
      border-radius: 12px;
      background: var(--surface);
      border: 1px solid var(--line);
    }
    .picks-head {
      display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px;
      margin: 0 0 16px; font-size: 12.5px; color: var(--muted);
    }
    .picks-head strong { color: var(--fg); }
    .picks-head .count { color: var(--accent); }
    .mode-switch {
      display: inline-flex; gap: 4px; padding: 3px;
      background: #151515; border: 1px solid #252525; border-radius: 8px;
    }
    .mode-btn {
      padding: 3px 10px; border: 0; border-radius: 5px; background: none;
      font: inherit; font-size: 11.5px; color: var(--muted); cursor: pointer;
    }
    .mode-btn[aria-pressed="true"] { background: var(--accent); color: #000; font-weight: 600; }
    .select-toggle {
      margin-left: auto; padding: 0; border: 0; background: none;
      font: inherit; color: var(--soft); cursor: pointer; text-decoration: underline;
    }
    .picks {
      display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px 18px; margin: 0 0 22px; padding: 0; list-style: none;
    }
    @media (max-width: 640px) { .picks { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    .pick {
      display: inline-flex; align-items: center; gap: 9px;
      padding: 4px 0; border: 0; background: none;
      font: inherit; color: var(--muted); cursor: pointer; text-align: left;
    }
    .pick::before {
      content: ""; width: 10px; height: 10px; flex: none;
      border: 1px solid currentColor; border-radius: 2px;
    }
    .pick[aria-pressed="true"] { color: var(--fg); }
    .pick[aria-pressed="true"]::before { background: var(--accent); border-color: var(--accent); }

    .cta { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
    .primary {
      padding: 10px 18px; border: 0; border-radius: 8px;
      background: var(--accent); color: #000;
      font: inherit; font-weight: 600; cursor: pointer;
    }
    .primary:disabled { opacity: 0.4; cursor: not-allowed; }
    .note { color: var(--muted); font-size: 12.5px; }
    details { margin-top: 16px; }
    summary { cursor: pointer; color: var(--soft); font-size: 12.5px; }
    .preview {
      margin: 12px 0 0; padding: 14px 16px;
      border-radius: 8px; background: #050505; border: 1px solid #222;
      color: #dcdcdc; font-size: 12px; line-height: 1.55;
      overflow-x: auto; white-space: pre-wrap; word-break: break-word;
    }

    .plugins { margin: 56px 0 0; padding: 0; list-style: none; display: grid; gap: 42px; }
    .plugin {
      display: grid; grid-template-columns: 190px minmax(0, 1fr); gap: 24px;
      padding-top: 32px; border-top: 1px solid var(--line);
    }
    @media (max-width: 640px) { .plugin { grid-template-columns: 1fr; gap: 14px; } }
    .meta .icon { width: 52px; height: 52px; display: block; margin-bottom: 10px; }
    .meta h2 { margin: 0; font-size: 16px; color: var(--fg); }
    .links { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 12px; }
    .links button {
      padding: 2px 0; border: 0; background: none;
      font: inherit; color: var(--muted); cursor: pointer;
      border-bottom: 1px solid transparent;
    }
    .links button:hover { color: var(--fg); border-color: var(--accent); }
    .links .install-one { color: var(--accent); }

    .body p { margin: 0 0 12px; color: var(--soft); }
    .demo {
      position: relative; margin: 16px 0 0; padding: 16px 16px 12px;
      border: 1px solid #222; border-radius: 8px; background: #080808;
    }
    .demo::before {
      content: "agy demo"; position: absolute; top: -9px; left: 12px;
      padding: 0 6px; background: var(--bg); color: var(--muted); font-size: 11px;
    }
    .line { margin: 0 0 6px; color: var(--fg); font-size: 12.5px; white-space: pre-wrap; word-break: break-word; }
    .line:last-child { margin-bottom: 0; }
    .line .p { color: var(--accent); user-select: none; }
    .footer-line { display: flex; justify-content: space-between; gap: 8px 18px; flex-wrap: wrap; }
    .footer-line .mode { color: #87d787; }
    .tm-rule { margin: 8px 0; border: 0; border-top: 1px solid #1e1e1e; }
    .tm-btn, .voice-btn {
      padding: 0; border: 0; background: none;
      font: inherit; color: inherit; cursor: pointer; text-decoration: underline;
    }
    .tm-btn:hover, .voice-btn:hover { color: var(--accent); }
    .path-link { color: #afd7ff; }

    /* Offline Reader Drawer */
    .reader {
      position: fixed; top: 0; right: 0; bottom: 0; z-index: 30;
      width: var(--panel); background: #080808; border-left: 1px solid #242424;
      box-shadow: -24px 0 64px rgba(0, 0, 0, 0.75);
      display: flex; flex-direction: column;
      transform: translateX(100%); visibility: hidden;
      transition: transform 0.28s ease, visibility 0s 0.28s;
    }
    .reader.open { transform: translateX(0); visibility: visible; transition: transform 0.28s ease, visibility 0s; }
    .reader-head { padding: 16px 20px 0; border-bottom: 1px solid var(--line); }
    .reader-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .reader-top h3 { margin: 0; font-size: 15px; }
    .reader-close {
      padding: 5px 10px; border: 1px solid #2b2b2b; border-radius: 6px;
      background: #121212; color: var(--soft); font: inherit; font-size: 12px; cursor: pointer;
    }
    .reader-tabs { display: flex; gap: 18px; margin-top: 12px; }
    .reader-tabs button {
      padding: 8px 0 10px; border: 0; border-bottom: 2px solid transparent;
      background: none; font: inherit; font-size: 12.5px; color: var(--muted); cursor: pointer;
    }
    .reader-tabs button[aria-selected="true"] { color: var(--fg); border-color: var(--accent); }
    .reader-body { flex: 1; overflow: auto; padding: 20px; }
    .file-pills { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
    .file-pill {
      padding: 4px 10px; border-radius: 999px; border: 1px solid #262626;
      background: #101010; color: var(--soft); font: inherit; font-size: 11.5px; cursor: pointer;
    }
    .file-pill[aria-current="true"] { border-color: var(--accent); color: var(--fg); background: #19120f; }
    .code-box {
      margin: 0; padding: 14px; border-radius: 8px;
      background: #040404; border: 1px solid #1e1e1e;
      color: #dadada; font-size: 12px; line-height: 1.55;
      overflow-x: auto; white-space: pre-wrap; word-break: break-word;
    }

    .toast {
      position: fixed; left: 50%; bottom: 22px; z-index: 40;
      padding: 10px 18px; border-radius: 999px;
      background: #161616; border: 1px solid #333; color: var(--fg); font-size: 12.5px;
      opacity: 0; transform: translate(-50%, 8px); pointer-events: none;
      transition: opacity 0.2s, transform 0.2s;
    }
    .toast.show { opacity: 1; transform: translate(-50%, 0); }

    footer {
      margin-top: 72px; padding-top: 24px; border-top: 1px solid var(--line);
      color: var(--muted); font-size: 12px; display: grid; gap: 10px;
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div class="badge-top"><span class="badge-dot"></span>11/11 plugins validados con <code>agy plugin validate --strict</code></div>
      <h1>better<span>antigravity</span></h1>
      <p class="lede">
        Adaptación nativa para <strong>Google Antigravity (<code>agy</code>)</strong> del proyecto original creado por
        <a href="https://github.com/midudev" target="_blank" rel="noopener"><strong>Miguel Ángel Durán (@midudev)</strong></a> en
        <a href="https://betterclaude.dev/" target="_blank" rel="noopener">betterclaude.dev</a>
        (<a href="https://github.com/midudev/better-claude" target="_blank" rel="noopener">midudev/better-claude</a>):
        hooks de ciclo de vida reales, skills slash, ejecución equilibrada en Hydrogen y barra <code>statusLine</code> unificada.
      </p>

      <section class="install" aria-label="Instalador">
        <div class="picks-head">
          <strong id="picks-label">Elige qué instalar</strong>
          <span class="count" id="picks-count">11 de 11</span>
          <div class="mode-switch" role="group" aria-label="Origen de instalación">
            <button type="button" class="mode-btn" data-source="github" aria-pressed="true">GitHub URL</button>
            <button type="button" class="mode-btn" data-source="local" aria-pressed="false">Clon local</button>
          </div>
          <button type="button" class="select-toggle" id="picks-all">desmarcar todos</button>
        </div>

        <ul class="picks" role="group" aria-labelledby="picks-label">
${picksHtml}
        </ul>

        <div class="cta">
          <button type="button" class="primary" id="copy-prompt">Copiar prompt de instalación</button>
          <span class="note">Pégalo directo en Antigravity (<code>agy</code>) o clona y corre <code>bash install.sh --all</code>.</span>
        </div>

        <details open>
          <summary>Ver prompt de instalación generado para Antigravity</summary>
          <pre class="preview" id="prompt"></pre>
        </details>
      </section>
    </header>

    <ol class="plugins">
${cardsHtml}
    </ol>

    <footer>
      <div><strong>Better Antigravity</strong> · Licencia MIT · Creador original: <a href="https://github.com/midudev" target="_blank" rel="noopener">Miguel Ángel Durán (@midudev)</a> en <a href="https://betterclaude.dev/" target="_blank" rel="noopener">betterclaude.dev</a> (<a href="https://github.com/midudev/better-claude" target="_blank" rel="noopener">midudev/better-claude</a>, con DiegoMarty en <code>time-machine</code>).</div>
      <div>Autocontenido (funciona 100 % sin red y por <code>content://</code> en Android) · Repositorio: <a href="https://github.com/mackrophages/better-antigravity" target="_blank" rel="noopener">mackrophages/better-antigravity</a>.</div>
    </footer>
  </main>

  <aside class="reader" id="reader" aria-label="Lector de documentación y código">
    <div class="reader-head">
      <div class="reader-top">
        <h3 id="reader-title">Plugin</h3>
        <button type="button" class="reader-close" id="reader-close">Cerrar (Esc)</button>
      </div>
      <div class="reader-tabs" role="tablist">
        <button type="button" role="tab" data-reader-tab="docs" aria-selected="true">README.md</button>
        <button type="button" role="tab" data-reader-tab="source" aria-selected="false">Archivos fuente</button>
      </div>
    </div>
    <div class="reader-body" id="reader-body"></div>
  </aside>

  <div class="toast" id="toast" role="status"></div>

  <script>
    (() => {
      const CATALOG = ${catalogJson};
      const HUD_PLUGINS = new Set(['sub-meter', 'context-meter', 'token-meter', 'narrator', 'time-machine', 'after', 'think-hard', 'use-hydrogen']);
      const GH_REPO = 'https://github.com/mackrophages/better-antigravity/tree/main/plugins';
      const LOCAL_ROOT = '/root/better-antigravity';

      const $ = (s, ctx = document) => ctx.querySelector(s);
      const $$ = (s, ctx = document) => [...ctx.querySelectorAll(s)];

      let sourceMode = 'github';
      const picks = $$('.pick');
      const promptEl = $('#prompt');
      const countEl = $('#picks-count');
      const allBtn = $('#picks-all');
      const copyBtn = $('#copy-prompt');
      const toast = $('#toast');
      let toastTimer = 0;

      function showToast(msg) {
        toast.textContent = msg;
        toast.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toast.classList.remove('show'), 2500);
      }

      async function copyText(text) {
        try {
          await navigator.clipboard.writeText(text);
          return true;
        } catch (_) {
          try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand('copy');
            ta.remove();
            return ok;
          } catch (_2) {
            return false;
          }
        }
      }

      function buildInstallPrompt(names) {
        if (!names.length) return '';
        const one = names.length === 1;
        if (sourceMode === 'local') {
          const argList = names.length === picks.length ? '--all' : names.join(' ');
          return [
            'Instala o actualiza de forma idempotente ' + (one ? 'este plugin adaptado para Google Antigravity' : 'estos plugins adaptados para Google Antigravity') + ' desde ' + LOCAL_ROOT + ' ejecutando:',
            '',
            'bash ' + LOCAL_ROOT + '/install.sh ' + argList,
            'agy plugin list',
            '',
            'Después avísame que abra una nueva sesión de agy para cargar los skills, hooks y la barra statusLine.'
          ].join('\\n');
        }

        return [
          'Instala ' + (one ? 'este plugin para Google Antigravity' : 'estos plugins para Google Antigravity') + ' desde github.com/mackrophages/better-antigravity ejecutando:',
          '',
          ...names.map(n => 'agy plugin uninstall ' + n + ' 2>/dev/null || true && agy plugin install ' + GH_REPO + '/' + n),
          '',
          'Después verifica con agy plugin list que ' + (one ? 'quedó activo' : 'quedaron activos') + ' y dime que abra una nueva sesión de agy (en el primer SessionStart se registrará better-statusline.mjs si no tenías otra statusLine personalizada).'
        ].join('\\n');
      }

      function pickedNames() {
        return picks.filter(p => p.getAttribute('aria-pressed') === 'true').map(p => p.dataset.plugin);
      }

      function renderPrompt() {
        const selected = pickedNames();
        const txt = buildInstallPrompt(selected);
        promptEl.textContent = txt || 'Selecciona al menos un plugin arriba.';
        copyBtn.disabled = !txt;
        countEl.textContent = selected.length + ' de ' + picks.length;
        allBtn.textContent = selected.length === picks.length ? 'desmarcar todos' : 'marcar todos';
      }

      picks.forEach(btn => btn.addEventListener('click', () => {
        btn.setAttribute('aria-pressed', btn.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
        renderPrompt();
      }));

      allBtn.addEventListener('click', () => {
        const next = pickedNames().length === picks.length ? 'false' : 'true';
        picks.forEach(p => p.setAttribute('aria-pressed', next));
        renderPrompt();
      });

      $$('.mode-btn').forEach(btn => btn.addEventListener('click', () => {
        sourceMode = btn.dataset.source;
        $$('.mode-btn').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
        renderPrompt();
      }));

      copyBtn.addEventListener('click', async () => {
        const ok = await copyText(buildInstallPrompt(pickedNames()));
        showToast(ok ? 'Prompt copiado. Pégalo en Antigravity (agy).' : 'No se pudo copiar automáticamente.');
      });

      $$('.install-one').forEach(btn => btn.addEventListener('click', async () => {
        const id = btn.dataset.install;
        const ok = await copyText(buildInstallPrompt([id]));
        showToast(ok ? 'Prompt para ' + CATALOG[id].title + ' copiado.' : 'Error al copiar.');
      }));

      // Live demos: Sub Meter + Context Meter + Time Machine + Narrator
      const subEl = $('#sub-meter');
      const WINDOWS = [
        { label: '5h', pct: 58, rst: '2h 10m' },
        { label: 'week', pct: 31, rst: '3d 4h' }
      ];
      let wIdx = 0;
      setInterval(() => {
        wIdx = (wIdx + 1) % WINDOWS.length;
        const w = WINDOWS[wIdx];
        const f = Math.round(w.pct / 10);
        subEl.innerHTML = '<span class="dim">' + w.label + ' </span><span class="accent">' + '━'.repeat(f) + '</span><span class="dim">' + '─'.repeat(10 - f) + '</span> ' + w.pct + '% <span class="dim">↻ ' + w.rst + '</span>';
      }, 4000);

      const ctxEl = $('#context-meter');
      const CTX = [
        { t: 'context 58% · /compact', c: 'warn' },
        { t: 'context 82% · new session', c: 'err' },
        { t: 'context ~16%', c: 'dim' },
        { t: 'context 34%', c: 'dim' }
      ];
      let cIdx = 0;
      setInterval(() => {
        cIdx = (cIdx + 1) % CTX.length;
        ctxEl.textContent = CTX[cIdx].t;
        ctxEl.className = CTX[cIdx].c;
      }, 3500);

      const tmStates = {
        3: { label: 'add rate limiting to the API', diff: '2 archivos +72 −4' },
        2: { label: 'add migration for users table', diff: '2 archivos +44 −3' },
        1: { label: 'start of the session', diff: 'estado inicial limpio' }
      };
      let tmCur = 3;
      let tmFrom = null;
      function setTm(id) {
        if (!tmStates[id] || id === tmCur) return;
        tmFrom = tmCur;
        tmCur = id;
        [1, 2, 3].forEach(n => {
          const m = $('#tm-mark-' + n);
          m.textContent = n === tmCur ? '◉' : n < tmCur ? '●' : '○';
          m.className = n === tmCur ? 'accent' : n > tmCur ? 'dim' : '';
        });
        $('#tm-cur').textContent = '#' + tmCur;
        $('#tm-from').textContent = '#' + tmFrom;
        $('#tm-head').textContent = 'En #' + tmCur + ' · ' + tmStates[tmCur].diff;
      }
      $$('[data-tm]').forEach(b => b.addEventListener('click', () => {
        const v = b.dataset.tm;
        setTm(v === 'undo' ? tmCur - 1 : v === 'redo' ? tmCur + 1 : Number(v));
      }));

      const voiceBtn = $('#voice-btn');
      voiceBtn.addEventListener('click', () => {
        if (!('speechSynthesis' in window)) {
          showToast('Síntesis del navegador no disponible aquí; en agy usa el hook de Narrator.');
          return;
        }
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance('Agregué el selector de tema oscuro en settings y las trece pruebas quedaron en verde.');
        u.lang = 'es-ES';
        u.onstart = () => { voiceBtn.textContent = '⏹ narrating'; voiceBtn.className = 'voice-btn up'; };
        u.onend = () => { voiceBtn.textContent = '⏵ narrator on'; voiceBtn.className = 'voice-btn down'; };
        u.onerror = () => { voiceBtn.textContent = '⏵ narrator on'; voiceBtn.className = 'voice-btn down'; };
        speechSynthesis.speak(u);
      });

      // Offline Reader Drawer
      const reader = $('#reader');
      const readerTitle = $('#reader-title');
      const readerBody = $('#reader-body');
      let curPlugin = null;
      let curTab = 'docs';
      let curFile = '';

      function renderReader() {
        if (!curPlugin || !CATALOG[curPlugin]) return;
        const entry = CATALOG[curPlugin];
        readerTitle.textContent = entry.title + ' (plugins/' + curPlugin + ')';
        $$('[data-reader-tab]').forEach(t => t.setAttribute('aria-selected', String(t.dataset.readerTab === curTab)));

        if (curTab === 'docs') {
          const pre = document.createElement('pre');
          pre.className = 'code-box';
          pre.textContent = entry.readme;
          readerBody.replaceChildren(pre);
          return;
        }

        const names = Object.keys(entry.files).sort();
        if (!curFile || !entry.files[curFile]) {
          curFile = names.find(n => n === 'plugin.json') || names[0] || '';
        }
        const pills = document.createElement('div');
        pills.className = 'file-pills';
        names.forEach(name => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'file-pill';
          b.textContent = name;
          b.setAttribute('aria-current', String(name === curFile));
          b.addEventListener('click', () => { curFile = name; renderReader(); });
          pills.appendChild(b);
        });
        const pre = document.createElement('pre');
        pre.className = 'code-box';
        pre.textContent = entry.files[curFile] || '';
        readerBody.replaceChildren(pills, pre);
      }

      function openReader(id, tab) {
        curPlugin = id;
        curTab = tab;
        curFile = '';
        reader.classList.add('open');
        renderReader();
      }

      $$('[data-open-reader]').forEach(btn => btn.addEventListener('click', () => {
        openReader(btn.dataset.openReader, btn.dataset.tab);
      }));
      $$('[data-reader-tab]').forEach(btn => btn.addEventListener('click', () => {
        curTab = btn.dataset.readerTab;
        renderReader();
      }));
      $('#reader-close').addEventListener('click', () => reader.classList.remove('open'));
      addEventListener('keydown', e => { if (e.key === 'Escape') reader.classList.remove('open'); });

      renderPrompt();
    })();
  </script>
</body>
</html>
`

fs.mkdirSync(path.join(ROOT, 'web'), { recursive: true })
const outPath = path.join(ROOT, 'web', 'index.html')
fs.writeFileSync(outPath, html, 'utf8')
console.log(`Built self-contained web/index.html (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB)`)
