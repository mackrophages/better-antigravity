# Better Antigravity

> **Créditos al creador original:** este proyecto es una adaptación para Google Antigravity del trabajo original creado por **[Miguel Ángel Durán (@midudev)](https://github.com/midudev)** en **[betterclaude.dev](https://betterclaude.dev/)** y **[`midudev/better-claude`](https://github.com/midudev/better-claude)** (con la colaboración de **[@DiegoMarty](https://github.com/DiegoMarty)** en `time-machine`). Todo el concepto de producto, diseño visual del catálogo y algoritmos base pertenecen a sus autores originales bajo licencia MIT.

Adaptación nativa y de código abierto de **[betterclaude.dev](https://betterclaude.dev/)** ([`midudev/better-claude`](https://github.com/midudev/better-claude)) para **Google Antigravity (`agy`)**.

🌐 **Página web interactiva (GitHub Pages):** **[https://mackrophages.github.io/better-antigravity/](https://mackrophages.github.io/better-antigravity/)**

Incluye los **11 plugins completos** (los 7 destacados en la web pública más los 4 adicionales del repositorio oficial), reescritos sobre las superficies nativas de Antigravity: `plugin.json`, `skills/<nombre>/SKILL.md`, `hooks.json` (`SessionStart`, `PreInvocation`, `PostInvocation`, `PreToolUse`, `Stop`), ejecución equilibrada sobre **Gemini 4 Hydrogen** y un multiplexor unificado de `statusLine` en Node ESM con **cero dependencias externas** (sin `node_modules`, inmune al fallo de hardlinks bajo Termux/proot).

## Catálogo de los 11 Plugins

| Plugin | Comando / Activación | Qué hace en Antigravity | Carpeta |
| :--- | :--- | :--- | :--- |
| **Quick Peek** | `/quick-peek [ruta[:línea]]` | Previsualiza rutas de las respuestas (20 líneas coloreadas centradas en `:línea`, carpetas y metadatos) y las revela en el gestor del sistema (`termux-open`, `Finder`, `Explorer`, `xdg-open`). | [`plugins/quick-peek/`](plugins/quick-peek/README.md) |
| **Image Preview** | `/image-preview [ruta\|recent]` | Renderiza imágenes, primera página de PDFs (`pdftoppm`) y fotogramas de video (`ffmpeg`) en bloques Unicode truecolor de 24 bits (muestreo 8x8 en luz lineal con `PIL` o lector BMP puro). | [`plugins/image-preview/`](plugins/image-preview/README.md) |
| **Sub Meter** | Barra `statusLine` + `/sub-meter` | Muestra en vivo las ventanas de cuota (5 horas y semanal) con barra de 10 celdas y cuenta regresiva de reinicio compartida entre terminales. | [`plugins/sub-meter/`](plugins/sub-meter/README.md) |
| **Context Meter** | Barra `statusLine` + `/context-meter` | Muestra el porcentaje de ventana de contexto usado (gris <50 %, amarillo >=50 % `/compact`, rojo >=75 %) y lanza aviso único al cruzar el umbral crítico sin gastar tokens. | [`plugins/context-meter/`](plugins/context-meter/README.md) |
| **Commit** | `/commit` | Pregunta con `ask_question` (`Commit + push`, `Commit only` o `Commit on a new branch`), bloquea `.env*` y llaves privadas, y divide cambios en Conventional Commits limpios sin trailers de IA. | [`plugins/commit/`](plugins/commit/README.md) |
| **Narrator** | `/narrator` + hook `Stop` | Resume en voz alta cada turno terminado en tu idioma (`AVSpeechSynthesizer`, `System.Speech`, `spd-say`/`espeak-ng` o `termux-tts-speak`) con cola compartida entre ventanas. | [`plugins/narrator/`](plugins/narrator/README.md) |
| **Time Machine** | `/timeline` + hooks Git | Cada turno que edita archivos (incluido Bash) crea un snapshot Git en un índice propio (`.git/time-machine-<sesión>.index`) bajo `refs/time-machine/*` sin tocar `HEAD`, ramas ni staging. | [`plugins/time-machine/`](plugins/time-machine/README.md) |
| **After** | `/after` y `/before` + `agy-after` | Cola FIFO sin desviar el turno en curso: encola tareas en español o inglés (desde otra terminal con `agy-after after "<tarea>"`) y el hook `Stop` encadena la siguiente con `decision: "continue"`. | [`plugins/after/`](plugins/after/README.md) |
| **Use Hydrogen** | Prefijo `_`, `/use-hydrogen` o `agy-hydrogen` | Adaptación de *Use Haiku* sobre **Gemini 4 Hydrogen** (`gemini-4-hydrogen-high`, configurable en `low\|medium\|high\|xhigh`): iniciar con `_` ejecuta el turno en Hydrogen verificando el modelo en `transcript.jsonl`, o abre sesión directa con `agy-hydrogen`. | [`plugins/use-hydrogen/`](plugins/use-hydrogen/README.md) |
| **Think Hard** | Prefijo `+` o `/think-hard` | Iniciar un prompt con `+` activa rigor analítico máximo (`+MAX` en `statusLine`) únicamente durante ese turno. | [`plugins/think-hard/`](plugins/think-hard/README.md) |
| **Token Meter** | Barra `statusLine` + `/token-meter` | Muestra los tokens de entrada (`↑`), salida (`↓`) y caché del turno junto al acumulado de la sesión. | [`plugins/token-meter/`](plugins/token-meter/README.md) |

## Instalación en Antigravity

### Opción 1: Desde GitHub (plugin individual o catálogo completo)

```bash
# Instalar un plugin puntual directo desde GitHub en Antigravity
agy plugin install https://github.com/mackrophages/better-antigravity/tree/main/plugins/use-hydrogen
agy plugin install https://github.com/mackrophages/better-antigravity/tree/main/plugins/time-machine

# O clonar e instalar los 11 plugins + barra statusLine de una sola vez
git clone https://github.com/mackrophages/better-antigravity.git
bash better-antigravity/install.sh --all
```

### Opción 2: Prompt de instalación de un solo paso (como en `betterclaude.dev`)

Abre [`web/index.html`](web/index.html) para elegir los plugins y copiar el prompt (en modo GitHub o Local), o pega directamente en Antigravity (`agy`):

```text
Instala estos plugins para Google Antigravity desde github.com/mackrophages/better-antigravity ejecutando:

agy plugin install https://github.com/mackrophages/better-antigravity/tree/main/plugins/quick-peek
agy plugin install https://github.com/mackrophages/better-antigravity/tree/main/plugins/image-preview
agy plugin install https://github.com/mackrophages/better-antigravity/tree/main/plugins/sub-meter
agy plugin install https://github.com/mackrophages/better-antigravity/tree/main/plugins/context-meter
agy plugin install https://github.com/mackrophages/better-antigravity/tree/main/plugins/commit
agy plugin install https://github.com/mackrophages/better-antigravity/tree/main/plugins/narrator
agy plugin install https://github.com/mackrophages/better-antigravity/tree/main/plugins/time-machine
agy plugin install https://github.com/mackrophages/better-antigravity/tree/main/plugins/after
agy plugin install https://github.com/mackrophages/better-antigravity/tree/main/plugins/use-hydrogen
agy plugin install https://github.com/mackrophages/better-antigravity/tree/main/plugins/think-hard
agy plugin install https://github.com/mackrophages/better-antigravity/tree/main/plugins/token-meter

Después verifica con agy plugin list que quedaron activos y dime que abra una nueva sesión de agy.
```

### Opción 3: Script local de gestión

```bash
# Instalar los 11 plugins + configurar statusLine (con respaldo automático de settings.json)
bash ./install.sh --all

# Instalar solo algunos
bash ./install.sh commit time-machine context-meter sub-meter use-hydrogen

# Desinstalar todos
bash ./install.sh --uninstall
```

## Desarrollo y Verificación

```bash
node scripts/sync-shared.mjs   # Sincroniza librerías e íconos SVG en los 11 plugins
node scripts/validate-all.mjs  # Corre agy plugin validate --strict en paralelo
node scripts/build-web.mjs     # Regenera web/index.html 100 % autocontenido
node --test "test/*.test.mjs"  # Ejecuta las 17 pruebas automatizadas (incluye paridad C11/JS)
node scripts/bench.mjs         # Mide latencias reales (ver resultados en PERF.md)
```

## Créditos y Autoría Original

- **Creador original:** **[Miguel Ángel Durán (@midudev)](https://github.com/midudev)**, autor de **[betterclaude.dev](https://betterclaude.dev/)** y del repositorio oficial **[`midudev/better-claude`](https://github.com/midudev/better-claude)**.
- **Coautor en `time-machine`:** **[@DiegoMarty](https://github.com/DiegoMarty)**.
- **Adaptación nativa para Google Antigravity (`agy`):** reescritura sobre `plugin.json`, `hooks.json`, `skills/`, `use-hydrogen` (`Gemini 4 Hydrogen`) y `better-statusline.mjs`, documentada en [`docs/a3-better-antigravity.md`](docs/a3-better-antigravity.md).
- **Licencia:** [MIT](LICENSE), preservando íntegramente el aviso de copyright original de Miguel Ángel Durán (`midudev`).
