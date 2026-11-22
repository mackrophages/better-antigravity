# Performance Optimization Ledger (`PERF.md`)

Reproducible Gemba measurements collected on the target ARM64 Termux/proot environment (`aarch64`, Node `v24.22.1`, `gcc -O3`) via [`scripts/bench.mjs`](scripts/bench.mjs) using monotonic `process.hrtime.bigint()`. Raw logs are stored in [`docs/bench-baseline.log`](docs/bench-baseline.log) and [`docs/bench-after.log`](docs/bench-after.log).

Run anytime with:

```bash
node scripts/bench.mjs
```

## Before vs. After Latency Measurements

| Hot Path / Workload | Baseline `p50` | Optimized `p50` | Baseline `p95` | Optimized `p95` | Speedup / Delta |
| :--- | ---: | ---: | ---: | ---: | :--- |
| **`statusLine` refresh** (native C11 `-O3`, runs every ~300 ms in TUI) | `113.10 ms` | **`9.71 ms`** | `124.12 ms` | `13.71 ms` | **11.6x faster (`-91.4%`)** |
| **`statusLine` JS fallback** (`BETTER_AGY_DISABLE_NATIVE=1`, no C compiler) | `113.10 ms` | **`117.57 ms`** | `124.12 ms` | `124.73 ms` | **0 disk writes/tick** (V8 cold-start floor) |
| **`PreInvocation` 5-hook chain** (runs before every model step) | `605.03 ms` | **`83.94 ms`** | `625.17 ms` | `84.74 ms` | **7.2x faster (`-86.1%`)** |
| **`PostInvocation` `quick-peek`** (`autoCard: false` default) | `110.65 ms` | **`13.60 ms`** | `113.02 ms` | `14.74 ms` | **8.1x faster (`-87.7%`)** |
| **Combined per-step TUI + hook overhead** (`statusLine + Pre + Post`) | `828.78 ms` | **`107.25 ms`** | `862.31 ms` | `113.19 ms` | **7.7x faster (`-87.1%`)** |
| **`Stop` `token-meter`** (on 1.6 MB / 3,000-line transcript) | `133.35 ms` | **`117.53 ms`** | `139.73 ms` | `134.41 ms` | **1.13x faster (`-11.9%`, `O(delta)`)** |
| **`Time Machine` 4-tool Git turn** (`4x PreToolUse + Stop + PreInvocation`) | `1,533.90 ms` | **`641.89 ms`** | `1,555.00 ms` | `718.50 ms` | **2.39x faster (`-58.2%`)** |
| **`Image Preview` SVG decode + 8x8 linear-light render** | `583.83 ms` | **`292.63 ms`** | `607.61 ms` | `319.74 ms` | **2.00x faster (`-49.9%`)** |
| **`validate-all.mjs` strict validation** (11 plugins, `N=5` post-fix) | `3,171.88 ms` | **`1,347.18 ms`** | `n/a (N=2)` | `1,361.49 ms` | **2.35x faster (`-57.5%`)** |

## Bundle Payload Measurements

| Deliverable | Baseline Raw | Optimized Raw | Raw Delta | Baseline Gzip (`-9`) | Optimized Gzip (`-9`) | Gzip Delta |
| :--- | ---: | ---: | :--- | ---: | ---: | :--- |
| **`web/index.html`** (self-contained 11-plugin catalog + code viewer) | `228.6 KB` | **`214.8 KB`** | **`-13.8 KB (-6.0%)`** | `59.1 KB` | `60.2 KB` | `+1.1 KB (+1.9%, embeds C11 & gate sources)` |

## Optimization Ledger (Kept and Discarded Attempts)

| Attempt / Hypothesis | Measured Evidence | Verdict | Rationale |
| :--- | :--- | :--- | :--- |
| Convert `.mjs` scripts to CommonJS `.cjs` to lower Node startup | `[PRÁCTICA ESTÁNDAR]` pre-change Node 24 probe showed `.cjs` slower than native ESM | **Discarded** | Node 24's native ESM loader already beats CommonJS translation overhead on ARM64 proot. |
| Optional C11 `statusLine` binary (`shared/better-statusline.c`, `-O3`) with automatic JS fallback | `113.10 ms -> 9.71 ms` (`docs/bench-baseline.log:2`, `docs/bench-after.log:2`) | **Kept** | Bypasses V8 cold-start every 300 ms; live + cached quota parity and `SessionStart` preservation enforced in `test/statusline.test.mjs`. |
| Single `readdirSync` + 30s/delta throttled `quota-cache.json` writes in JS `better-statusline.mjs` | `117.57 ms` wall-clock (`docs/bench-after.log:3`), `0` disk writes on steady ticks | **Kept** | Eliminates flash wear and repeated `statx` syscalls on systems without a C compiler (`preferNative = true` keeps C11 when available). |
| Lightweight POSIX `/bin/sh` lifecycle gate (`shared/hook-gate.sh`) ahead of Node hooks | `605.03 ms -> 83.94 ms` (`PreInvocation`), `110.65 ms -> 13.60 ms` (`PostInvocation`) | **Kept** | Uses shell built-ins (`${0%/*}`, `IFS= read -r`) on 7 gates and a `128 KB` `tail` window on `context-meter-pre` to skip booting V8 on no-op steps. |
| `O(1)` `128 KB` tail reader (`readLatestUsageTail`) + raw-`Buffer` `O(delta)` scanner (`scanTokensFromOffset`) | `133.35 ms -> 117.53 ms` (`docs/bench-after.log:6`), immune to invalid UTF-8 byte drift | **Kept** | Keeps `statusLine` and `token-meter` constant-time as `transcript.jsonl` grows to multi-MB. |
| Fix `tm-hook.mjs` `pre-invocation` order + atomic `pending-<sid>.flag` + `.index.head` stamp + `git diff-tree` | `1,533.90 ms -> 641.89 ms` (`docs/bench-baseline.log:6`, `docs/bench-after.log:7`) | **Kept** | Skips `treeOf` when no rewind occurred, skips `git` on mutating tools `#2..#N`, and avoids re-seeding unchanged `HEAD` indexes. |
| Single-pass in-memory `ffmpeg -> PAM` RGBA pipe + header sniffer + ANSI color deduplication (`shared/pixels.mjs`) | `583.83 ms -> 292.63 ms` (`docs/bench-baseline.log:7`, `docs/bench-after.log:8`) | **Kept** | Removes temporary directory creation, disk PNG/raw roundtrips, and Python `PIL` startup when `ffmpeg` is present. |
| Parallel worker pool in `scripts/validate-all.mjs` (`N=5` benchmarked) + single-pass `install.sh` check | `3,171.88 ms -> 1,347.18 ms` (`docs/bench-baseline.log:8`, `docs/bench-after.log:9`) | **Kept** | Runs `agy plugin validate --strict` concurrently across CPU cores with deterministic ordered output and a 30s timeout. |
| Deduplicate `README.md` & `logo.svg` in `build-web.mjs` + safe CSS minification + `content-visibility: auto` | `228.6 KB -> 214.8 KB` raw (`docs/bench-baseline.log:9`, `docs/bench-after.log:10`) | **Kept** | Removes duplicate JSON strings even after adding C11/gate source files, accelerates mobile paint, and pauses timers on hidden tabs. |
| Embed `token-meter` Stop logic inside `better-statusline.c` | Not applied (`117.53 ms` runs once at end of multi-second LLM turn) | **Discarded** | Violates single-responsibility (`code-simplification` Principle 4) for negligible end-of-turn wall-clock gain. |
