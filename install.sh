#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ALL_PLUGINS=(
  quick-peek
  image-preview
  sub-meter
  context-meter
  commit
  narrator
  time-machine
  after
  use-hydrogen
  think-hard
  token-meter
)

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'EOF'
Usage:
  bash install.sh [--all]               Install all 11 Better Antigravity plugins + statusLine
  bash install.sh <plugin1> <plugin2>   Install only the selected plugins
  bash install.sh --uninstall           Uninstall all Better Antigravity plugins + statusLine
EOF
  exit 0
fi

if [[ "${1:-}" == "--uninstall" ]]; then
  for name in "${ALL_PLUGINS[@]}" use-flash; do
    agy plugin uninstall "$name" 2>/dev/null || true
  done
  rm -f "$HOME/.local/bin/agy-after" "$HOME/.local/bin/agy-hydrogen"
  node "$ROOT_DIR/scripts/setup-statusline.mjs" --uninstall
  echo "Uninstalled Better Antigravity plugins and statusLine."
  exit 0
fi

node "$ROOT_DIR/scripts/sync-shared.mjs" >/dev/null

TARGETS=()
if [[ $# -eq 0 || "${1:-}" == "--all" ]]; then
  TARGETS=("${ALL_PLUGINS[@]}")
else
  TARGETS=("$@")
fi

# Retire legacy use-flash if previously installed
if [[ -d "$HOME/.gemini/config/plugins/use-flash" ]]; then
  agy plugin uninstall use-flash >/dev/null 2>&1 || rm -rf "$HOME/.gemini/config/plugins/use-flash"
fi

NEED_HUD=0
for name in "${TARGETS[@]}"; do
  plugin_path="$ROOT_DIR/plugins/$name"
  if [[ ! -d "$plugin_path" ]]; then
    echo "Unknown plugin: $name" >&2
    exit 1
  fi
  was_disabled="$(node -e '
    const fs = require("node:fs"), p = process.env.HOME + "/.gemini/config/config.json";
    try {
      const c = JSON.parse(fs.readFileSync(p, "utf8"));
      process.stdout.write(c?.plugins?.[process.argv[1]]?.enabled === false ? "1" : "0");
    } catch { process.stdout.write("0"); }
  ' "$name")"
  agy plugin validate --strict "$plugin_path" >/dev/null
  # Reinstall cleanly if already present so updates take effect immediately
  if [[ -d "$HOME/.gemini/config/plugins/$name" ]]; then
    agy plugin uninstall "$name" >/dev/null 2>&1 || rm -rf "$HOME/.gemini/config/plugins/$name"
  fi
  agy plugin install "$plugin_path"
  # Keep previously disabled plugins disabled, and default narrator to disabled in proot without TTS
  if [[ "$was_disabled" == "1" ]]; then
    agy plugin disable "$name" >/dev/null 2>&1 || true
  elif [[ "$name" == "narrator" && ( $# -eq 0 || "${1:-}" == "--all" ) && -n "${PROOT_TMP_DIR:-}${TERMUX_VERSION:-}" ]]; then
    if ! command -v termux-tts-speak >/dev/null 2>&1 && ! command -v espeak-ng >/dev/null 2>&1 && ! command -v spd-say >/dev/null 2>&1; then
      agy plugin disable narrator >/dev/null 2>&1 || true
    fi
  fi
  case "$name" in
    sub-meter|context-meter|token-meter|narrator|time-machine|after|think-hard|use-hydrogen)
      NEED_HUD=1
      ;;
  esac
done

if [[ "$NEED_HUD" -eq 1 ]]; then
  node "$ROOT_DIR/scripts/setup-statusline.mjs"
fi

if [[ -d "$HOME/.gemini/config/plugins/after" ]]; then
  mkdir -p "$HOME/.local/bin"
  cat > "$HOME/.local/bin/agy-after" <<'WRAP'
#!/usr/bin/env bash
exec node "$HOME/.gemini/config/plugins/after/scripts/after-cli.mjs" --cwd "$PWD" "$@"
WRAP
  chmod +x "$HOME/.local/bin/agy-after"
fi

if [[ -d "$HOME/.gemini/config/plugins/use-hydrogen" ]]; then
  mkdir -p "$HOME/.local/bin"
  cat > "$HOME/.local/bin/agy-hydrogen" <<'WRAP_H2'
#!/usr/bin/env bash
H_MODEL="${AGY_HYDROGEN_MODEL:-$(node "$HOME/.gemini/config/plugins/use-hydrogen/scripts/use-hydrogen-cli.mjs" model --id 2>/dev/null || echo gemini-4-hydrogen-high)}"
exec agy --model "$H_MODEL" --agent hydrogen-runner "$@"
WRAP_H2
  chmod +x "$HOME/.local/bin/agy-hydrogen"
fi

echo ""
echo "Installed ${#TARGETS[@]} plugin(s). Verify anytime with: agy plugin list"
