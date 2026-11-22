# A3: sobrecarga combinada por paso: de 828.78 ms a 120 ms

- **Propietario:** Antigravity (agente optimizador)
- **Coach / Revisor:** auditor-gemba y code-reviewer (Ojos Frescos)
- **Versión:** 3 (2026-11-22)
- **Etapa:** cerrar
- **Contrato:** 3
- **Objetivo que apoya:** reducir la latencia interactiva de Better Antigravity en proot ARM64 y escritorio sin perder garantías funcionales

## 1. Contexto y Desperdicio (Muda) Observado
- **Por qué importa ahora:** `statusLine` corre cada 300 ms y los hooks corren en cada paso; sumar `828.78 ms` frena la TUI e infla el uso de CPU móvil.
- **Desperdicio observado:** sobreprocesamiento y espera; cada paso vacío levantaba 6 instancias V8 de Node y subprocesos `git` o `python3`.
- **Pregunta cero:** mover `PreInvocation` a `Stop` o comandos manuales rompería la alerta al `75 %` de contexto y los prefijos `+` y `_`; tocaba filtrar rápido.

## 2. Estado Actual en el Gemba
| Hecho medido | Fuente |
| :--- | :--- |
| `statusLine` tardaba `113.10 ms` (`p50`) por pulso de 300 ms | docs/bench-baseline.log:2 |
| La cadena de 5 hooks `PreInvocation` tardaba `605.03 ms` (`p50`) por paso | docs/bench-baseline.log:3 |
| `PostInvocation` (`quick-peek` con `autoCard: false`) tardaba `110.65 ms` (`p50`) | docs/bench-baseline.log:4 |
| Un turno de 4 herramientas en `Time Machine` tardaba `1,533.90 ms` (`p50`) | docs/bench-baseline.log:6 |
| `Image Preview` sobre SVG tardaba `583.83 ms` (`p50`) | docs/bench-baseline.log:7 |

- **Brecha:** sobrecarga combinada por paso: de 828.78 ms (medido) a 120 ms (meta) para el 2026-11-22

### Mapa del estado presente

| Paso | Quién | Tiempo | Problema | Fuente |
| :--- | :--- | :--- | :--- | :--- |
| 1. Refrescar `statusLine` cada 300 ms | `better-statusline.mjs` | 113.1 ms | [B] arranque en frío de V8 en cada pulso | docs/bench-baseline.log:2 |
| 2. Evaluar 6 hooks por paso | 6 procesos Node ESM | 715.7 ms | [A] abría V8 y releía `transcript.jsonl` completo | docs/bench-baseline.log:3-4 |
| 3. Snapshots Git y vistas previas | `tm-hook.mjs` y `pixels.mjs` | 2117.7 ms | [C] `git` repetido y paso en disco por `PIL` | docs/bench-baseline.log:6-7 |

## 3. Meta y Criterio de Aceptación
- **Meta:** bajar la sobrecarga por paso de `828.78 ms` a menos de `120 ms` y reducir al menos `2x` `Time Machine` e `Image Preview`.
- **Criterio de aceptación:** `bench.mjs` con `hrtime.bigint()`; `gcc -O3 -Wall -Wextra -Werror` limpio; paridad C11/JS; 17/17 tests verdes y binario activo en `~/.gemini/`.

## 4. Análisis de Causa Raíz
| Estado | Observación | Evidencia en Gemba o prueba pendiente |
| :--- | :--- | :--- |
| **Verificado** | Con 1 `readdirSync` y caché de 30 s, el arranque V8 deja el fallback JS en `117.57 ms` (`p50`) | docs/bench-after.log:3 |
| **Verificado** | `tm-hook.mjs` valida `jumpedNoticePending` antes de `treeOf` y `git.mjs` persiste `${index}.head` | plugins/time-machine/scripts/tm-hook.mjs:260-265; plugins/time-machine/scripts/core/git.mjs:107-126 |
| **Verificado** | `decodeViaFfmpegPam` transmite `PAM` RGBA en memoria sin temporales ni Python `PIL` | shared/pixels.mjs:379-389 |
| **Verificado** | `ensureStatusLineInstalled` usa `preferNative = true` por defecto y evita degradar C11 en `SessionStart` | shared/store.mjs:191-235 |
| **Supuesto** | Fuera de proot (Linux/macOS nativo), el binario C11 bajará de `2 ms` por pulso | medir `node scripts/bench.mjs` en PC WSL2 |

### 4a. Ishikawa

| Rama | Hipótesis u observación | Evidencia en Gemba | Estado |
| :--- | :--- | :--- | :--- |
| Método | Los 6 hooks por paso arrancaban Node sin compuerta previa en pasos vacíos | docs/bench-baseline.log:3-4 | FOCO |
| Máquina | El arranque V8 bajo proot ARM64 impone un piso de `117.57 ms` en `statusLine` | docs/bench-after.log:3 | FOCO |
| Material | `transcript.jsonl` de `1.6 MB` obligaría a leer todo el archivo por paso | cola de `128 KB` basta (`shared/transcript.mjs:82-104`) | DESCARTADA |
| Medición | Migrar `.mjs` a `.cjs` reduciría el arranque de Node 24 | ESM nativo superó a `.cjs` (`PERF.md:35`) | DESCARTADA |
| Medio | `Time Machine` e `Image Preview` repetían `git` y pasaban imágenes por `PIL` | docs/bench-baseline.log:6-7 | FOCO |
| Relevo | `SessionStart` sobrescribiría el binario C11 o fallaría sin `cc` | `preferNative = true` cae a JS (`shared/store.mjs:191-235`) | DESCARTADA |

### 4b. Porqués por causa

- **Causa A (Método):** los hooks por paso arrancaban 6 instancias V8 y parseaban `transcript.jsonl` completo.
  - 1. ¿Por qué sumaban `715.68 ms`? -> corrían 6 procesos Node y `JSON.parse` completo en cada paso.
  - 2. ¿Por qué entraban a Node sin acción pendiente? -> faltaban compuerta `/bin/sh` y lectores `O(1)` / `O(delta)`.
  - Por lo tanto: carecer de compuerta `/bin/sh` y lectura `O(1)`/`O(delta)` -> abría 6 V8 por paso -> sumaban `715.68 ms`.
- **Causa B (Máquina):** `statusLine` pagaba el arranque V8 en cada pulso de 300 ms.
  - 1. ¿Por qué tardaba `113.10 ms`? -> levantaba V8 en cada pulso y reescribía `quota-cache.json`.
  - 2. ¿Por qué dependía siempre de V8? -> faltaba un acelerador C11 opcional con respaldo JS.
  - Por lo tanto: carecer de binario C11 opcional -> levantaba V8 cada 300 ms -> `statusLine` tardaba `113.10 ms`.
- **Causa C (Medio):** `Time Machine` e `Image Preview` duplicaban subprocesos y E/S temporal.
  - 1. ¿Por qué tardaban `1,533.90 ms` y `583.83 ms`? -> repetían `git` sin rebobinado y pasaban por disco + `PIL`.
  - 2. ¿Por qué repetían ese trabajo? -> faltaban bandera por turno, sello `.index.head` y pipe `ffmpeg -> PAM`.
  - Por lo tanto: estado efímero y paso por disco -> multiplicaban `git` y `python3` -> inflaban la latencia.

## 5. Contramedidas y Poka-Yoke
| Opción | Causa | Nivel | Impacto | Esfuerzo | Cuadrante | Decisión | Predicción |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| O-1 Compuerta `/bin/sh` (`hook-gate.sh`) con cola `128 KB` + lectores `O(1)`/`O(delta)` en `Buffer` | A | poka-yoke | alto | bajo (5 h) | Implementar | elegida | `Pre` + `Post`: de 715.68 ms a menos de 105 ms (base: docs/bench-baseline.log:3-4) |
| O-2 Despachador único que fusione los 5 hooks `PreInvocation` en un proceso | A | raíz | alto | alto (20 h) | Desafío | descartada | bajaría a ~25 ms pero acopla plugins independientes (base: docs/bench-after.log:4) |
| O-3 Binario C11 opcional (`better-statusline.c` `-O3`) con paridad exacta y `preferNative = true` | B | raíz | alto | alto (20 h) | Desafío | elegida | `statusLine` `p50`: de 113.10 ms a menos de 15 ms (base: docs/bench-baseline.log:2) |
| O-4 Optimizar solo `better-statusline.mjs` (`1 readdirSync` + caché 30 s) sin C11 | B | curita | bajo | bajo (5 h) | Posible | descartada | evita escrituras pero deja `117.57 ms` por V8 (base: docs/bench-after.log:3) |
| O-5 Bandera `pending-<sid>.flag`, sello `.index.head`, `diff-tree` y pipe `ffmpeg -> PAM` | C | raíz | alto | bajo (5 h) | Implementar | elegida | `Time Machine` < 700 ms e `Image Preview` < 320 ms (base: docs/bench-baseline.log:6-7) |
| O-6 Demonio residente en segundo plano para Git y decodificación | C | raíz | alto | alto (1 semana) | Desafío | descartada | evita subprocesos pero deja huérfanos en proot (base: docs/bench-after.log:7-8) |

### Mapa del estado futuro

| Paso | Quién | Tiempo | Problema | Fuente |
| :--- | :--- | :--- | :--- | :--- |
| 1. Refrescar `statusLine` cada 300 ms | binario C11 `better-statusline` | 9.71 ms | ninguno | docs/bench-after.log:2 |
| 2. Evaluar 6 hooks por paso | `hook-gate.sh` + `transcript.mjs` `O(1)`/`O(delta)` | 97.54 ms | ninguno | docs/bench-after.log:4-5 |
| 3. Snapshots Git y vistas previas | `git.mjs` (`.index.head`) + `ffmpeg -> PAM` | 934.52 ms | ninguno | docs/bench-after.log:7-8 |

## 6. Plan de Ejecución PDCA y Ventana de Despliegue
| Paso | Acción | Responsable | Verificación |
| :--- | :--- | :--- | :--- |
| 1 | Medir línea base con `scripts/bench.mjs` (`hrtime.bigint()`) | agente optimizador | `docs/bench-baseline.log` con 8 métricas |
| 2 | Implementar `hook-gate.sh`, `transcript.mjs` en `Buffer` y mejoras Git/PAM | agente optimizador | `node --test`: 17/17 verdes |
| 3 | Compilar `better-statusline.c` y blindar `preferNative = true` | agente optimizador | `gcc -Werror` salida 0 y paridad C11/JS |
| 4 | Reinstalar con `install.sh --all`, auditar y publicar Pages | `install.sh` + revisores | `settings.json` usa C11; `HTTP/2 200` |

- **Ventana de despliegue:** compatible en caliente con `agy`; `install.sh --all` preserva `narrator` en `disabled` y respalda `settings.json`.
- **Autorización:** aprobada por el usuario el 2026-11-22 al solicitar la optimización profunda mediante `/goal`.

## 7. Verificación en Gemba y Estandarización
- **Predicho contra real:** la sobrecarga por paso cayó de `828.78 ms` a `107.25 ms` (`7.7x`); `Time Machine` bajó a `641.89 ms` (`2.4x`) e `Image Preview` a `292.63 ms` (`2.0x`).
- **Qué puede salir mal y cómo lo veremos:** `PreInvocation` concentra `83.94 ms` (`78 %`); si nuevos plugins suman hooks y superan `120 ms`, la siguiente roca será multiplexarlos.
- **Próxima revisión:** ventana de 20 h por el mantenedor con `node scripts/bench.mjs`: normal `< 120 ms` combinados, anormal `>= 120 ms`, acción bloquear merge y multiplexar `PreInvocation`.
- **Estandarización:** `scripts/bench.mjs`, `PERF.md`, `shared/better-statusline.c`, `shared/hook-gate.sh` y `test/perf.test.mjs` quedan integrados en el repositorio.
