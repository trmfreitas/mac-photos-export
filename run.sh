#!/usr/bin/env bash
# run.sh — launcher for export-script.js (JXA / osascript)
#
# Usage:
#   ./run.sh              # run with default 6-hour wall-clock timeout
#   ./run.sh --no-log     # run without writing a log file
#   ./run.sh --timeout N  # override timeout in seconds (0 = no limit)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JS_SCRIPT="$SCRIPT_DIR/export-script.js"
LOG_DIR="$SCRIPT_DIR/logs"
TIMEOUT_SECS=21600   # 6 hours — change or pass --timeout N to override
WRITE_LOG=true

# ── Colours ───────────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  C_RESET='\033[0m'
  C_GRAY='\033[0;90m'
  C_CYAN='\033[0;36m'
  C_GREEN='\033[0;32m'
  C_YELLOW='\033[0;33m'
  C_RED='\033[0;31m'
  C_BOLD='\033[1m'
else
  C_RESET='' C_GRAY='' C_CYAN='' C_GREEN='' C_YELLOW='' C_RED='' C_BOLD=''
fi

# ── Load .env ─────────────────────────────────────────────────────────────────
ENV_FILE="$SCRIPT_DIR/.env"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck source=.env
  source "$ENV_FILE"
  set +a
else
  echo -e "${C_YELLOW}  Warning: .env not found — using defaults baked into the script.${C_RESET}"
  echo -e "${C_YELLOW}  Copy .env.template to .env and fill in your values.${C_RESET}"
fi

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-log)      WRITE_LOG=false; shift ;;
    --timeout)     TIMEOUT_SECS="$2"; shift 2 ;;
    *)             echo "Unknown argument: $1"; exit 1 ;;
  esac
done

# ── Validate ──────────────────────────────────────────────────────────────────
if [[ ! -f "$JS_SCRIPT" ]]; then
  echo -e "${C_RED}Error: script not found: $JS_SCRIPT${C_RESET}"
  exit 1
fi

if ! command -v osascript &>/dev/null; then
  echo -e "${C_RED}Error: osascript not found (macOS only)${C_RESET}"
  exit 1
fi

# ── Log file setup ────────────────────────────────────────────────────────────
LOG_FILE=""
if $WRITE_LOG; then
  mkdir -p "$LOG_DIR"
  LOG_FILE="$LOG_DIR/export_$(date +%Y%m%d_%H%M%S).log"
fi

# ── Colourising filter ────────────────────────────────────────────────────────
# Reads lines from stdin, applies colour based on log-level marker, and also
# tees to the log file (plain text, no escape codes) when enabled.
colorize() {
  while IFS= read -r line; do
    # Write plain line to log file
    if $WRITE_LOG && [[ -n "$LOG_FILE" ]]; then
      echo "$line" >> "$LOG_FILE"
    fi

    # Apply colour to terminal
    if [[ "$line" == *"  x  "* ]]; then
      echo -e "${C_RED}${line}${C_RESET}"
    elif [[ "$line" == *"  !  "* ]]; then
      echo -e "${C_YELLOW}${line}${C_RESET}"
    elif [[ "$line" == *"  v  "* ]]; then
      echo -e "${C_GREEN}${line}${C_RESET}"
    elif [[ "$line" == *"  i  "* ]]; then
      echo -e "${C_CYAN}${line}${C_RESET}"
    elif [[ "$line" == *"─────"* ]]; then
      echo -e "${C_GRAY}${line}${C_RESET}"
    else
      echo -e "${C_GRAY}${line}${C_RESET}"
    fi
  done
}

# ── Banner ────────────────────────────────────────────────────────────────────
echo -e ""
echo -e "${C_BOLD}  Photos Export  ${C_RESET}"
echo -e "${C_GRAY}  Script  : $JS_SCRIPT${C_RESET}"
if $WRITE_LOG; then
  echo -e "${C_GRAY}  Log     : $LOG_FILE${C_RESET}"
fi
if [[ "$TIMEOUT_SECS" -gt 0 ]]; then
  echo -e "${C_GRAY}  Timeout : ${TIMEOUT_SECS}s ($(( TIMEOUT_SECS / 3600 ))h $(( (TIMEOUT_SECS % 3600) / 60 ))m)${C_RESET}"
else
  echo -e "${C_YELLOW}  Timeout : none (script may run indefinitely)${C_RESET}"
fi
echo -e ""

# ── Run ───────────────────────────────────────────────────────────────────────
WALL_START=$(date +%s)

# osascript writes its log output to stderr, so redirect stderr→stdout.
# Wrap with macOS `gtimeout` (coreutils) if available, else fallback to
# the built-in timeout from bash 4+ / macOS 12+.
run_script() {
  if [[ "$TIMEOUT_SECS" -gt 0 ]]; then
    if command -v gtimeout &>/dev/null; then
      gtimeout "$TIMEOUT_SECS" osascript -l JavaScript "$JS_SCRIPT" 2>&1
    elif command -v timeout &>/dev/null; then
      timeout "$TIMEOUT_SECS" osascript -l JavaScript "$JS_SCRIPT" 2>&1
    else
      echo -e "${C_YELLOW}  Warning: neither gtimeout nor timeout found — running without time limit.${C_RESET}" >&2
      echo -e "${C_YELLOW}  Install coreutils for timeout support: brew install coreutils${C_RESET}" >&2
      osascript -l JavaScript "$JS_SCRIPT" 2>&1
    fi
  else
    osascript -l JavaScript "$JS_SCRIPT" 2>&1
  fi
}

EXIT_CODE=0
run_script | colorize || EXIT_CODE=${PIPESTATUS[0]}

WALL_END=$(date +%s)
WALL_ELAPSED=$(( WALL_END - WALL_START ))
WALL_H=$(( WALL_ELAPSED / 3600 ))
WALL_M=$(( (WALL_ELAPSED % 3600) / 60 ))
WALL_S=$(( WALL_ELAPSED % 60 ))

echo ""
if [[ "$EXIT_CODE" -eq 124 ]]; then
  echo -e "${C_RED}  Timed out after ${WALL_H}h ${WALL_M}m ${WALL_S}s (exit ${EXIT_CODE})${C_RESET}"
elif [[ "$EXIT_CODE" -ne 0 ]]; then
  echo -e "${C_RED}  Script exited with error (exit ${EXIT_CODE}) — wall time: ${WALL_H}h ${WALL_M}m ${WALL_S}s${C_RESET}"
else
  echo -e "${C_GREEN}  Finished in ${WALL_H}h ${WALL_M}m ${WALL_S}s${C_RESET}"
fi

if $WRITE_LOG; then
  echo -e "${C_GRAY}  Log saved to: $LOG_FILE${C_RESET}"
fi
echo ""

exit "$EXIT_CODE"
