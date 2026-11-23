#!/bin/sh
# Lightweight POSIX /bin/sh lifecycle gate (~10ms in proot, <1.5ms native).
# Uses shell built-ins (`${0%/*}`, `IFS= read -r`) on no-op turns and delegates to Node when active.

GATE="$1"
shift

if [ "${BETTER_AGY_SUBCALL:-}" = "1" ]; then
  if [ "$GATE" = "tm-pre-tool" ]; then
    printf '{"decision":"allow"}\n'
  else
    printf '{}\n'
  fi
  exit 0
fi

HOME_EFF="${BETTER_AGY_TEST_HOME:-$HOME}"
STATE_ROOT="${BETTER_AGY_HOME:-$HOME_EFF/.gemini/antigravity-cli/better-antigravity}"
SETTINGS_PATH="${BETTER_AGY_SETTINGS_JSON:-$HOME_EFF/.gemini/antigravity-cli/settings.json}"
HERE="${0%/*}"
[ "$HERE" = "$0" ] && HERE="."

is_headless() {
  [ "${CLAUDE_MEM_SIN_HOOK:-}" = "1" ] || [ "${AGY_HEADLESS:-}" = "1" ]
}

has_json_in() {
  [ -d "$1" ] || return 1
  for _f in "$1"/*.json; do
    [ -e "$_f" ] && return 0
  done
  return 1
}

read_stdin() {
  INPUT=""
  if IFS= read -r _line; then
    INPUT="$_line"
    case "$INPUT" in
      *'}') ;;
      *)
        _rest="$(cat)"
        INPUT="$INPUT
$_rest"
        ;;
    esac
  else
    INPUT="$_line"
  fi
}

file_contains() {
  [ -f "$1" ] || return 1
  while IFS= read -r _fl || [ -n "$_fl" ]; do
    case "$_fl" in
      *"$2"*) return 0 ;;
    esac
  done < "$1"
  return 1
}

file_contains_either() {
  [ -f "$1" ] || return 1
  while IFS= read -r _fl || [ -n "$_fl" ]; do
    case "$_fl" in
      *"$2"*|*"$3"*) return 0 ;;
    esac
  done < "$1"
  return 1
}

has_active_after_queue() {
  [ -d "$STATE_ROOT/after" ] || return 1
  for _af in "$STATE_ROOT/after"/*.json; do
    [ -f "$_af" ] || continue
    # Skip drained idle queues (`"items": []` and `"running": null`)
    if ! file_contains_either "$_af" '"items": []' '"items":[]'; then
      return 0
    fi
    if ! file_contains_either "$_af" '"running": null' '"running":null'; then
      return 0
    fi
  done
  return 1
}

extract_sid() {
  SID="default"
  case "$1" in
    *'"conversationId":"'*)
      SID="${1#*\"conversationId\":\"}"
      SID="${SID%%\"*}"
      ;;
    *'"conversationId": "'*)
      SID="${1#*\"conversationId\": \"}"
      SID="${SID%%\"*}"
      ;;
  esac
  case "$SID" in
    ''|*[!a-zA-Z0-9_-]*) return 1 ;;
  esac
  [ "${#SID}" -le 64 ] || return 1
  return 0
}

is_non_first_step() {
  case "$1" in
    *'"invocationNum":0'*|*'"invocationNum": 0'*) return 1 ;;
    *'"invocationNum":'*) return 0 ;;
    *) return 1 ;;
  esac
}

case "$GATE" in
  ensure-hud)
    if is_headless; then
      printf '{}\n'
      exit 0
    fi
    if [ -f "$STATE_ROOT/.hud-ready" ] && [ -f "$SETTINGS_PATH" ] &&
       [ ! "$HERE/better-statusline.mjs" -nt "$STATE_ROOT/.hud-ready" ] &&
       [ ! "$HERE/better-statusline.c" -nt "$STATE_ROOT/.hud-ready" ]; then
      IFS= read -r HUD_KIND < "$STATE_ROOT/.hud-ready" 2>/dev/null || HUD_KIND=""
      if [ "$HUD_KIND" = "custom" ] && file_contains "$SETTINGS_PATH" '"statusLine"'; then
        printf '{}\n'
        exit 0
      fi
      if [ "$HUD_KIND" = "native" ] && [ -x "$HOME_EFF/.gemini/antigravity-cli/better-statusline" ] &&
         file_contains "$SETTINGS_PATH" "better-statusline" && ! file_contains "$SETTINGS_PATH" "better-statusline.mjs"; then
        printf '{}\n'
        exit 0
      fi
      if [ "$HUD_KIND" = "node" ] && [ ! -x "$HOME_EFF/.gemini/antigravity-cli/better-statusline" ] &&
         [ -s "$HOME_EFF/.gemini/antigravity-cli/better-statusline.mjs" ] && file_contains "$SETTINGS_PATH" "better-statusline.mjs"; then
        printf '{}\n'
        exit 0
      fi
    fi
    exec node "$HERE/ensure-hud.mjs"
    ;;

  quick-peek-post)
    if is_headless || ! file_contains_either "$STATE_ROOT/config.json" '"autoCard": true' '"autoCard":true'; then
      printf '{}\n'
      exit 0
    fi
    exec node "$HERE/../peek-hook.mjs" "$@"
    ;;

  after-pre|after-stop)
    if ! has_active_after_queue; then
      printf '{}\n'
      exit 0
    fi
    MODE="stop"
    [ "$GATE" = "after-pre" ] && MODE="pre-invocation"
    exec node "$HERE/../after-hook.mjs" "$MODE"
    ;;

  think-hard-pre)
    read_stdin
    if is_non_first_step "$INPUT"; then
      printf '{}\n'
      exit 0
    fi
    LUI_TH=""
    case "$INPUT" in
      *'"lastUserInput":'*) LUI_TH="${INPUT#*\"lastUserInput\":}" ;;
    esac
    case "$LUI_TH" in
      *+*) ;;
      *)
        if ! has_json_in "$STATE_ROOT/turn-flags"; then
          printf '{}\n'
          exit 0
        fi
        ;;
    esac
    printf '%s' "$INPUT" | exec node "$HERE/../think-hard-hook.mjs" pre
    ;;

  think-hard-stop)
    if ! has_json_in "$STATE_ROOT/turn-flags"; then
      printf '{}\n'
      exit 0
    fi
    exec node "$HERE/../think-hard-hook.mjs" stop
    ;;

  use-hydrogen-pre)
    read_stdin
    if is_non_first_step "$INPUT"; then
      printf '{}\n'
      exit 0
    fi
    LUI_UH=""
    case "$INPUT" in
      *'"lastUserInput":'*) LUI_UH="${INPUT#*\"lastUserInput\":}" ;;
    esac
    case "$LUI_UH" in
      *_*) ;;
      *)
        if ! has_json_in "$STATE_ROOT/turn-flags"; then
          printf '{}\n'
          exit 0
        fi
        ;;
    esac
    printf '%s' "$INPUT" | exec node "$HERE/../use-hydrogen-hook.mjs" pre
    ;;

  use-hydrogen-stop)
    if ! has_json_in "$STATE_ROOT/turn-flags"; then
      printf '{}\n'
      exit 0
    fi
    exec node "$HERE/../use-hydrogen-hook.mjs" stop
    ;;

  context-meter-pre)
    if is_headless; then
      printf '{}\n'
      exit 0
    fi
    read_stdin
    if extract_sid "$INPUT" && file_contains_either "$STATE_ROOT/context-alerts/$SID.json" '"alertedDanger": true' '"alertedDanger":true'; then
      printf '{}\n'
      exit 0
    fi
    if ! file_contains "$STATE_ROOT/config.json" '"context-meter"'; then
      TP=""
      case "$INPUT" in
        *'"transcriptPath":"'*)
          TP="${INPUT#*\"transcriptPath\":\"}"
          TP="${TP%%\"*}"
          ;;
        *'"transcriptPath": "'*)
          TP="${INPUT#*\"transcriptPath\": \"}"
          TP="${TP%%\"*}"
          ;;
      esac
      case "$TP" in
        ''|*\\*) ;;
        \~/*) TP="$HOME_EFF/${TP#\~/}" ;;
      esac
      if [ -n "$TP" ] && [ -f "$TP" ]; then
        # Scale pre-filter by active session window: >=100k tokens on 1M+ windows, >=10k on smaller/default windows
        MIN_RE='"input_tokens":[[:space:]]*[1-9][0-9]{4,}'
        if [ -f "$STATE_ROOT/context-windows/sess-$SID.json" ] &&
           grep -qE '"windowTokens":[[:space:]]*[1-9][0-9]{6,}' "$STATE_ROOT/context-windows/sess-$SID.json" 2>/dev/null; then
          MIN_RE='"input_tokens":[[:space:]]*[1-9][0-9]{5,}'
        fi
        if ! tail -c 131072 "$TP" 2>/dev/null | grep -qE "$MIN_RE"; then
          printf '{}\n'
          exit 0
        fi
      fi
    fi
    printf '%s' "$INPUT" | exec node "$HERE/../context-meter-hook.mjs"
    ;;

  tm-pre-invocation)
    read_stdin
    if is_non_first_step "$INPUT" || [ ! -d "$STATE_ROOT/time-machine" ]; then
      printf '{}\n'
      exit 0
    fi
    if extract_sid "$INPUT"; then
      if [ ! -f "$STATE_ROOT/time-machine/pending-$SID.flag" ] && [ ! -f "$STATE_ROOT/time-machine/jumped-$SID.flag" ]; then
        printf '{}\n'
        exit 0
      fi
    fi
    printf '%s' "$INPUT" | exec node "$HERE/../tm-hook.mjs" pre-invocation
    ;;

  tm-pre-tool)
    read_stdin
    if extract_sid "$INPUT" && [ -f "$STATE_ROOT/time-machine/pending-$SID.flag" ]; then
      printf '{"decision":"allow"}\n'
      exit 0
    fi
    printf '%s' "$INPUT" | exec node "$HERE/../tm-hook.mjs" pre-tool
    ;;

  tm-stop)
    read_stdin
    case "$INPUT" in
      *'"fullyIdle":false'*|*'"fullyIdle": false'*)
        printf '{}\n'
        exit 0
        ;;
    esac
    if extract_sid "$INPUT" && [ ! -f "$STATE_ROOT/time-machine/pending-$SID.flag" ]; then
      HAS_PENDING=0
      if [ -d "$STATE_ROOT/time-machine" ]; then
        for _d in "$STATE_ROOT/time-machine"/*; do
          [ -d "$_d" ] || continue
          if [ -f "$_d/$SID.json" ] && file_contains "$_d/$SID.json" '"pendingTurn"'; then
            HAS_PENDING=1
            break
          fi
        done
      fi
      if [ "$HAS_PENDING" = "0" ]; then
        printf '{}\n'
        exit 0
      fi
    fi
    printf '%s' "$INPUT" | exec node "$HERE/../tm-hook.mjs" stop
    ;;
esac
