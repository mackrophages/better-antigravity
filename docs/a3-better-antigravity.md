# A3: plugins de better-claude operativos en Antigravity: de 0 de 11 a 11 de 11

- **Propietario:** Antigravity (agente constructor)
- **Coach / Revisor:** lector-primera-visita y auditor-gemba (Ojos Frescos)
- **Versión:** 3 (2026-11-22)
- **Etapa:** cerrar
- **Contrato:** 3
- **Objetivo que apoya:** adaptar betterclaude.dev y midudev/better-claude para Google Antigravity

## 1. Contexto y Desperdicio (Muda) Observado
- **Por qué importa ahora:** los 11 plugins de `betterclaude.dev` aportan control de contexto, cuotas, tokens, snapshots Git por turno, cola sin desvío, commits atómicos, vista previa y narración, pero 0 operaban en Antigravity.
- **Desperdicio observado:** defecto de incompatibilidad; pegar el prompt de `betterclaude.dev` en `agy` fallaba en el primer comando y dejaba los 11 plugins inactivos.
- **Pregunta cero:** sin construir, Antigravity carecía de snapshots Git por turno (`time-machine`), cola sin desvío (`after`) y medidores combinados; se descartó "no construir".

## 2. Estado Actual en el Gemba
| Hecho medido | Fuente |
| :--- | :--- |
| 0 de 11 plugins de `midudev/better-claude` pasaban `agy plugin validate --strict` | docs/evidencia-gemba-inicial.log:3 |
| 10 de 11 plugins usaban `"modules": ["./register.tsx"]` e importaban `'claude-code'` | docs/evidencia-gemba-inicial.log:4 |
| El prompt web usaba `claude plugin marketplace add` y `@better-claude`, inválidos en `agy` | https://betterclaude.dev/ |
| Faltan `jq` y `magick` en proot; están `node` 24, `python3` (`PIL` 12.1.1), `pdftoppm` y `ffmpeg` (`librsvg`) | docs/evidencia-gemba-inicial.log:6 |
| Los núcleos JS de `after` y `time-machine` pasaban 157 de 157 pruebas en Node 24 | docs/evidencia-gemba-inicial.log:7 |

- **Brecha:** plugins de better-claude operativos en Antigravity: de 0 de 11 (medido) a 11 de 11 (meta) para el 2026-11-22

### Mapa del estado presente

| Paso | Quién | Tiempo | Problema | Fuente |
| :--- | :--- | :--- | :--- | :--- |
| 1. Copiar prompt en web | `betterclaude.dev` | 5 s | [C] emitía comandos `claude plugin` incompatibles con `agy` | https://betterclaude.dev/ |
| 2. Instalar plugin | `agy plugin install` | 3 s | [A] faltaba `plugin.json` raíz y `hooks` importaba `'claude-code'` | docs/evidencia-gemba-inicial.log:3-4 |
| 3. Correr hooks y barra | runtime de `agy` | inmediato | [B] sin `statusLine` ni soporte sin `jq` o `magick` | docs/evidencia-gemba-inicial.log:5-6 |

## 3. Meta y Criterio de Aceptación
- **Meta:** 11 de 11 plugins adaptados, validados con `agy plugin validate --strict` (0 errores, 0 avisos), instalados en `~/.gemini/config/plugins/` y con catálogo web autocontenido.
- **Criterio de aceptación:** `agy plugin validate --strict` pasa en los 11; `agy plugin list` muestra los 11 habilitados; suite `node --test` 100 % verde; `chequeo-gemba.sh` limpio y web UTF-8 sin red verificada.

## 4. Análisis de Causa Raíz
| Estado | Observación | Evidencia en Gemba o prueba pendiente |
| :--- | :--- | :--- |
| **Verificado** | Antigravity exige `plugin.json` raíz, `hooks.json` por comandos stdin/stdout y `skills/<nombre>/SKILL.md` | https://antigravity.google/docs/build-plugins.md |
| **Verificado** | `better-statusline.mjs` responde con mediana de 109.2 ms bajo proot ARM64 | docs/evidencia-gemba-cierre.log:5 |
| **Verificado** | En `Stop`, devolver `{"decision":"continue","reason":"..."}` drena la cola FIFO en prueba real | docs/evidencia-gemba-cierre.log:6 |
| **Supuesto** | El esquema JSON de `statusLine` de `agy` se mantendrá estable en futuras versiones mayores | correr `node --test` tras cada actualización mayor de `agy` |

### 4a. Ishikawa

| Rama | Hipótesis u observación | Evidencia en Gemba | Estado |
| :--- | :--- | :--- | :--- |
| Método | El prompt de instalación asumía marketplaces de Claude Code | docs/evidencia-gemba-inicial.log:9 | FOCO |
| Máquina | Los mods TSX importaban `'claude-code'` en vez de `hooks.json`, `skills/` y `statusLine` | docs/evidencia-gemba-inicial.log:4 | FOCO |
| Material | Los módulos puros (`git.js`, `queue.js`, `text.ts`, `paths.ts`, `pixels.ts`) estarían acoplados | 157/157 pruebas pasan aisladas | DESCARTADA |
| Medición | Faltaría validador oficial de estructura | `agy plugin validate --strict` valida todo el paquete | DESCARTADA |
| Medio | Termux proot carece de `jq` y `magick`, sufre hardlinks con `npm` y carece de `claude-haiku-5-5` | docs/evidencia-gemba-inicial.log:5-6 | FOCO |
| Relevo | Un HTML multiarchivo fallaría al abrirse por `content://` en Android | regla de entregable único UTF-8 | DESCARTADA |

### 4b. Porqués por causa

- **Causa A (Máquina):** los plugins usaban mods TSX de `'claude-code'` que Antigravity no carga.
  - 1. ¿Por qué fallaban los 11 en `agy plugin validate --strict`? -> faltaban `plugin.json` raíz, `skills/*/SKILL.md` y `hooks.json` de comandos.
  - 2. ¿Por qué traían `register.tsx`? -> fueron diseñados para el motor interno de Claude Code.
  - Por lo tanto: fueron diseñados como mods TSX de `'claude-code'` -> carecían de `plugin.json`, `skills/` y `hooks.json` estándar -> 0 de 11 cargaban en Antigravity.
- **Causa B (Medio):** asumir `jq`, `sips`, `magick` o `claude-haiku-5-5` rompía la ejecución en proot ARM64 y en `agy`.
  - 1. ¿Por qué fallaban vistas previas, barra y subagente rápido acá? -> `jq` y `magick` faltan y `claude-haiku-5-5` no existe en `agy models`.
  - 2. ¿Por qué se invocaban? -> el código original asumía utilidades de escritorio y modelos de Anthropic.
  - Por lo tanto: asumir binarios ausentes y modelos ajenos -> fallaba en proot ARM64 y en `agy` -> vistas previas y medidores quedaban inactivos.
- **Causa C (Método):** la web generaba comandos `claude plugin` incompatibles con `agy`.
  - 1. ¿Por qué fallaba el prompt copiado? -> `agy` instala por ruta o URL de GitHub con `agy plugin install`.
  - 2. ¿Por qué no lo emitía la web? -> `web/index.html` solo tenía la plantilla de Claude Code.
  - Por lo tanto: `web/index.html` solo emitía `claude plugin` -> `agy` rechazaba el comando -> la instalación guiada fallaba.

## 5. Contramedidas y Poka-Yoke
| Opción | Causa | Nivel | Impacto | Esfuerzo | Cuadrante | Decisión | Predicción |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| O-1 Adaptar los 11 plugins autónomos (`plugin.json`, `skills/`, `hooks.json`, `use-hydrogen` sobre `gemini-4-hydrogen-high` y `sync-shared.mjs`) | A | raíz | alto | bajo (5 h) | Implementar | elegida | plugins validados con `--strict`: de 0 de 11 a 11 de 11 (base: docs/evidencia-gemba-inicial.log:8) |
| O-2 Motor Node ESM cero dependencias + `PIL`/`librsvg`/`pdftoppm`/`ffmpeg` + `better-statusline.mjs` | B | poka-yoke | alto | bajo (5 h) | Implementar | elegida | fallos por binarios faltantes o hardlinks en proot: de 3 a 0 (base: docs/evidencia-gemba-inicial.log:6) |
| O-3 Web `better-antigravity` en un solo HTML UTF-8 + `install.sh` idempotente + comando `agy-after` | C | raíz | alto | bajo (5 h) | Implementar | elegida | comandos fallidos al instalar o actualizar: de 2 a 0 (base: docs/evidencia-gemba-inicial.log:9) |
| O-4 Empaquetar los 11 en un único plugin monolítico indivisible | A | curita | bajo | bajo (5 h) | Posible | descartada | impide elegir e instalar plugins sueltos como en betterclaude.dev (base: https://betterclaude.dev/) |

### Mapa del estado futuro

| Paso | Quién | Tiempo | Problema | Fuente |
| :--- | :--- | :--- | :--- | :--- |
| 1. Elegir plugins y copiar prompt o correr `install.sh` | `web/index.html` e `install.sh` | 5 s | ninguno | docs/evidencia-gemba-cierre.log:8 |
| 2. Validar e instalar cada plugin autónomo | `agy plugin validate --strict` + `agy plugin install` | 5 s | ninguno | docs/evidencia-gemba-cierre.log:2-3 |
| 3. Ejecutar hooks de ciclo de vida y barra TUI | Node 24 ESM + `PIL` + `librsvg` | 109.2 ms | ninguno | docs/evidencia-gemba-cierre.log:5 |

## 6. Plan de Ejecución PDCA y Ventana de Despliegue
| Paso | Acción | Responsable | Verificación |
| :--- | :--- | :--- | :--- |
| 1 | Construir `shared/store.mjs` y `scripts/better-statusline.mjs` con pruebas unitarias | agente constructor | `node --test test/statusline.test.mjs` verde |
| 2 | Construir y sincronizar los 11 plugins autónomos en `plugins/*` | `scripts/sync-shared.mjs` | `agy plugin validate --strict` pasa 11 de 11 |
| 3 | Construir `web/index.html` autocontenida e `install.sh` con respaldo de `settings.json` | agente constructor | `chequeo-gemba.sh` limpio y charset UTF-8 |
| 4 | Instalar los 11 plugins en `agy`, corregir hallazgos de Ojos Frescos y medir en Gemba | `install.sh` + revisores | `agy plugin list` muestra los 11 habilitados |

- **Ventana de despliegue:** aplicada en `/root/better-antigravity` y en `~/.gemini/config/plugins/` con respaldo `settings.json.bak-better-agy`, preservando intactos `tas`, `egm` y `agent-skills`.
- **Autorización:** no hace falta para repositorio local e instalación en este Antigravity; crear repositorio remoto en GitHub queda preparado para decisión del usuario.

## 7. Verificación en Gemba y Estandarización
- **Predicho contra real:** O-1 predijo 11 de 11 validados; se midieron 11 de 11 activos (`agy plugin list`). O-2 predijo menos de 120 ms; se midieron todas las pruebas verdes y mediana de 109.2 ms.
- **Qué puede salir mal y cómo lo veremos:** sin voz TTS local, `Narrator` avisa cómo instalar `espeak-ng` o `termux-api`; sin navegador GUI en proot, `test/web.test.mjs` valida el HTML y compila el JS con `node:vm`.
- **Próxima revisión:** ventana de 20 h en la próxima sesión interactiva de `agy` para confirmar comodidad visual de `better-statusline.mjs` con `stack_with_default: true`.
- **Estandarización:** `scripts/sync-shared.mjs`, `scripts/validate-all.mjs`, `scripts/build-web.mjs`, `scripts/better-statusline.mjs` e `install.sh` quedan versionados en Git en `/root/better-antigravity` e instalados en `~/.gemini/`.
