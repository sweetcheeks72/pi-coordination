#!/usr/bin/env bash
# pi-status.sh — Check background coordination run status
#
# Usage:
#   pi-status.sh              List all background runs
#   pi-status.sh <run-id>     Show details for a specific run (prefix match OK)
#
# Background runs live in ~/.pi/runs/<id>/
#   status.json  — machine-readable state
#   run.log      — full stdout/stderr from the coordination run

set -euo pipefail

RUNS_DIR="${HOME}/.pi/runs"

# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

color_reset="\033[0m"
color_green="\033[32m"
color_red="\033[31m"
color_yellow="\033[33m"
color_dim="\033[2m"
color_bold="\033[1m"
color_cyan="\033[36m"

status_icon() {
  local status="$1"
  case "$status" in
    complete) echo -e "${color_green}✅${color_reset}" ;;
    failed)   echo -e "${color_red}❌${color_reset}" ;;
    paused)   echo -e "${color_yellow}⏸ ${color_reset}" ;;
    running)  echo -e "${color_yellow}⏳${color_reset}" ;;
    *)        echo "  " ;;
  esac
}

format_age() {
  local ts="$1"
  if command -v python3 &>/dev/null; then
    python3 -c "
import datetime, sys
now = datetime.datetime.now(datetime.timezone.utc)
try:
    then = datetime.datetime.fromisoformat('$ts'.replace('Z', '+00:00'))
except Exception:
    print('?')
    sys.exit(0)
diff = int((now - then).total_seconds())
if diff < 60:
    print(f'{diff}s ago')
elif diff < 3600:
    print(f'{diff // 60}m ago')
elif diff < 86400:
    print(f'{diff // 3600}h ago')
else:
    print(f'{diff // 86400}d ago')
"
  else
    echo "$ts"
  fi
}

jq_field() {
  local file="$1" field="$2" default="${3:-}"
  if command -v jq &>/dev/null; then
    jq -r ".$field // \"$default\"" "$file" 2>/dev/null || echo "$default"
  else
    # Naive grep fallback
    grep -o "\"$field\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$file" 2>/dev/null \
      | head -1 | sed 's/.*: "\(.*\)"/\1/' || echo "$default"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# Show all runs
# ─────────────────────────────────────────────────────────────────────────────

list_runs() {
  if [[ ! -d "$RUNS_DIR" ]]; then
    echo -e "${color_dim}No background runs found (${RUNS_DIR} does not exist)${color_reset}"
    return 0
  fi

  local dirs
  mapfile -t dirs < <(ls -1t "$RUNS_DIR" 2>/dev/null || true)

  if [[ ${#dirs[@]} -eq 0 ]]; then
    echo -e "${color_dim}No background runs found${color_reset}"
    return 0
  fi

  echo -e "${color_bold}Background Coordination Runs${color_reset}"
  echo -e "${color_dim}──────────────────────────────────────────────────────────────${color_reset}"
  printf "${color_dim}%-3s %-10s %-32s %-8s %-12s${color_reset}\n" "" "ID" "Spec" "Cost" "Age"
  echo -e "${color_dim}──────────────────────────────────────────────────────────────${color_reset}"

  for dir in "${dirs[@]}"; do
    local status_file="${RUNS_DIR}/${dir}/status.json"
    [[ -f "$status_file" ]] || continue

    local status spec_path cost started_at completed_at
    status=$(jq_field "$status_file" "status" "unknown")
    spec_path=$(jq_field "$status_file" "specPath" "")
    cost=$(jq_field "$status_file" "cost" "")
    started_at=$(jq_field "$status_file" "startedAt" "")
    completed_at=$(jq_field "$status_file" "completedAt" "")

    local spec_name
    spec_name=$(basename "${spec_path}" .md | cut -c1-30)

    local age_ts="${completed_at:-$started_at}"
    local age
    age=$(format_age "$age_ts")

    local cost_str="      "
    if [[ -n "$cost" && "$cost" != "null" ]]; then
      cost_str=$(printf "\$%.3f" "$cost" 2>/dev/null || echo "$cost")
    fi

    local icon
    icon=$(status_icon "$status")
    printf "%b %-10s %-32s %-8s %-12s\n" "$icon" "$dir" "$spec_name" "$cost_str" "$age"
  done

  echo ""
  echo -e "${color_dim}Tip: pi-status.sh <run-id>  — full details + log tail${color_reset}"
}

# ─────────────────────────────────────────────────────────────────────────────
# Show a specific run
# ─────────────────────────────────────────────────────────────────────────────

show_run() {
  local query="$1"

  # Find matching run directory (exact or prefix)
  local run_dir=""
  if [[ -d "${RUNS_DIR}/${query}" ]]; then
    run_dir="${RUNS_DIR}/${query}"
  else
    for dir in "${RUNS_DIR}"/*/; do
      local name
      name=$(basename "$dir")
      if [[ "$name" == "${query}"* ]]; then
        run_dir="$dir"
        break
      fi
    done
  fi

  if [[ -z "$run_dir" || ! -d "$run_dir" ]]; then
    echo -e "${color_red}Run not found: ${query}${color_reset}"
    echo "Available runs:"
    ls -1 "$RUNS_DIR" 2>/dev/null || echo "  (none)"
    exit 1
  fi

  local status_file="${run_dir}/status.json"
  local log_file="${run_dir}/run.log"

  if [[ ! -f "$status_file" ]]; then
    echo -e "${color_red}status.json not found in ${run_dir}${color_reset}"
    exit 1
  fi

  local id status spec_path pid cost started_at completed_at error_msg
  id=$(jq_field "$status_file" "id" "")
  status=$(jq_field "$status_file" "status" "unknown")
  spec_path=$(jq_field "$status_file" "specPath" "")
  pid=$(jq_field "$status_file" "pid" "")
  cost=$(jq_field "$status_file" "cost" "")
  started_at=$(jq_field "$status_file" "startedAt" "")
  completed_at=$(jq_field "$status_file" "completedAt" "")
  error_msg=$(jq_field "$status_file" "error" "")

  local icon
  icon=$(status_icon "$status")

  echo -e "${color_bold}Run: ${id}${color_reset}  ${icon}  ${color_cyan}${status}${color_reset}"
  echo -e "${color_dim}──────────────────────────────────────────────────${color_reset}"
  echo -e "  Spec:       ${spec_path}"
  echo -e "  Started:    ${started_at}"
  [[ -n "$completed_at" && "$completed_at" != "null" ]] && echo -e "  Completed:  ${completed_at}"
  [[ -n "$pid"          && "$pid"          != "null" ]] && echo -e "  PID:        ${pid}"
  [[ -n "$cost"         && "$cost"         != "null" ]] && echo -e "  Cost:       \$${cost}"
  [[ -n "$error_msg"    && "$error_msg"    != "null" ]] && echo -e "  ${color_red}Error:${color_reset}      ${error_msg}"

  echo ""
  echo -e "  ${color_dim}Log:${color_reset}    ${log_file}"
  echo -e "  ${color_dim}Status:${color_reset} ${status_file}"

  # Show tail of log
  if [[ -f "$log_file" ]]; then
    echo ""
    echo -e "${color_bold}── Log tail (last 20 lines) ──────────────────────────────${color_reset}"
    tail -n 20 "$log_file"
  else
    echo ""
    echo -e "${color_dim}(log not yet available)${color_reset}"
  fi

  # Show watch hint if still running
  if [[ "$status" == "running" ]]; then
    echo ""
    echo -e "${color_yellow}Run is still in progress.${color_reset}"
    echo -e "  Watch live:  tail -f ${log_file}"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────────────────────────

case "${1:-}" in
  "")
    list_runs
    ;;
  -h|--help)
    echo "Usage: pi-status.sh [run-id]"
    echo ""
    echo "  (no args)     List all background runs"
    echo "  <run-id>      Show details and log tail for a specific run"
    echo ""
    echo "Background runs live in ~/.pi/runs/<id>/"
    ;;
  *)
    show_run "$1"
    ;;
esac
