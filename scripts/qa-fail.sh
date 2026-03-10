#!/usr/bin/env bash
# qa-fail.sh — Log a QA failure to ~/.pi/qa-failures.json
#
# Usage:
#   qa-fail.sh --title "Button not accessible" --file components/Button.tsx --severity major
#   qa-fail.sh --title "Auth token not refreshed" --file lib/auth.ts --severity critical --session SESSION_ID --description "full details here"
#   qa-fail.sh --title "Minor layout issue" --file pages/Home.tsx --severity minor --reporter staging
#
# Options:
#   --title       (required) Short description of the failure
#   --file        (required, repeatable) File(s) affected — can be repeated for multiple files
#   --severity    (required) critical | major | minor
#   --session     (optional) Coordination session ID this relates to
#   --description (optional) Full description of the failure
#   --task        (optional, repeatable) TASK-XX IDs this relates to
#   --reporter    (optional) human-qa | automated-test | staging (default: human-qa)

set -euo pipefail

TITLE=""
FILES=()
SEVERITY=""
SESSION_ID=""
DESCRIPTION=""
TASK_IDS=()
REPORTER="human-qa"
QA_STORE="${HOME}/.pi/qa-failures.json"

usage() {
    echo "Usage: qa-fail.sh --title TEXT --file FILE --severity (critical|major|minor) [options]"
    echo ""
    echo "Required:"
    echo "  --title TEXT        Short description of the failure"
    echo "  --file FILE         File affected (can be repeated)"
    echo "  --severity LEVEL    critical | major | minor"
    echo ""
    echo "Optional:"
    echo "  --session ID        Coordination session ID"
    echo "  --description TEXT  Full description"
    echo "  --task TASK_ID      Related task ID (can be repeated)"
    echo "  --reporter TYPE     human-qa | automated-test | staging (default: human-qa)"
    echo ""
    echo "Examples:"
    echo "  qa-fail.sh --title 'Button not accessible' --file components/Button.tsx --severity major"
    echo "  qa-fail.sh --title 'Auth token not refreshed' --file lib/auth.ts --severity critical --reporter staging"
    exit 1
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        --title)
            TITLE="$2"
            shift 2
            ;;
        --file)
            FILES+=("$2")
            shift 2
            ;;
        --severity)
            SEVERITY="$2"
            shift 2
            ;;
        --session)
            SESSION_ID="$2"
            shift 2
            ;;
        --description)
            DESCRIPTION="$2"
            shift 2
            ;;
        --task)
            TASK_IDS+=("$2")
            shift 2
            ;;
        --reporter)
            REPORTER="$2"
            shift 2
            ;;
        --help|-h)
            usage
            ;;
        *)
            echo "Unknown option: $1" >&2
            usage
            ;;
    esac
done

# Validate required fields
if [[ -z "$TITLE" ]]; then
    echo "Error: --title is required" >&2
    usage
fi

if [[ ${#FILES[@]} -eq 0 ]]; then
    echo "Error: at least one --file is required" >&2
    usage
fi

if [[ -z "$SEVERITY" ]]; then
    echo "Error: --severity is required" >&2
    usage
fi

if [[ "$SEVERITY" != "critical" && "$SEVERITY" != "major" && "$SEVERITY" != "minor" ]]; then
    echo "Error: --severity must be critical, major, or minor (got: $SEVERITY)" >&2
    exit 1
fi

if [[ "$REPORTER" != "human-qa" && "$REPORTER" != "automated-test" && "$REPORTER" != "staging" ]]; then
    echo "Error: --reporter must be human-qa, automated-test, or staging (got: $REPORTER)" >&2
    exit 1
fi

# Check for required tools
if ! command -v node &>/dev/null; then
    echo "Error: node is required" >&2
    exit 1
fi

# Generate UUID
generate_uuid() {
    node -e "const { randomUUID } = require('node:crypto'); console.log(randomUUID());"
}

# Build JSON arrays for files and task IDs
files_json=$(printf '%s\n' "${FILES[@]}" | node -e "
const lines = require('fs').readFileSync('/dev/stdin','utf-8').trim().split('\n').filter(Boolean);
console.log(JSON.stringify(lines));
")

if [[ ${#TASK_IDS[@]} -gt 0 ]]; then
    tasks_json=$(printf '%s\n' "${TASK_IDS[@]}" | node -e "
const lines = require('fs').readFileSync('/dev/stdin','utf-8').trim().split('\n').filter(Boolean);
console.log(JSON.stringify(lines));
")
else
    tasks_json="[]"
fi

# Ensure store dir exists
mkdir -p "$(dirname "$QA_STORE")"

# Read or initialize store
if [[ -f "$QA_STORE" ]]; then
    store_json=$(cat "$QA_STORE")
    # Validate it's a valid JSON object with failures array
    if ! echo "$store_json" | node -e "
const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));
if(!Array.isArray(d.failures)) throw new Error('invalid');
" 2>/dev/null; then
        echo "Warning: $QA_STORE is malformed, reinitializing" >&2
        store_json='{"failures":[]}'
    fi
else
    store_json='{"failures":[]}'
fi

FAILURE_ID=$(generate_uuid)
REPORTED_AT=$(node -e "console.log(new Date().toISOString())")
DESCRIPTION_ESCAPED=$(printf '%s' "$DESCRIPTION" | node -e "
const d=require('fs').readFileSync('/dev/stdin','utf-8');
process.stdout.write(JSON.stringify(d));
")
TITLE_ESCAPED=$(printf '%s' "$TITLE" | node -e "
const d=require('fs').readFileSync('/dev/stdin','utf-8');
process.stdout.write(JSON.stringify(d));
")
SESSION_ESCAPED=$(printf '%s' "$SESSION_ID" | node -e "
const d=require('fs').readFileSync('/dev/stdin','utf-8');
process.stdout.write(JSON.stringify(d));
")
REPORTER_ESCAPED=$(printf '%s' "$REPORTER" | node -e "
const d=require('fs').readFileSync('/dev/stdin','utf-8');
process.stdout.write(JSON.stringify(d));
")
SEVERITY_ESCAPED=$(printf '%s' "$SEVERITY" | node -e "
const d=require('fs').readFileSync('/dev/stdin','utf-8');
process.stdout.write(JSON.stringify(d));
")

# Build the new failure entry and append it
UPDATED_STORE=$(node -e "
const store = JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));
const entry = {
  id: '$FAILURE_ID',
  sessionId: $SESSION_ESCAPED || '',
  reportedAt: '$REPORTED_AT',
  reportedBy: $REPORTER_ESCAPED,
  severity: $SEVERITY_ESCAPED,
  title: $TITLE_ESCAPED,
  description: $DESCRIPTION_ESCAPED || $TITLE_ESCAPED,
  filesAffected: $files_json,
  taskIds: $tasks_json,
  resolved: false,
};
store.failures.push(entry);
console.log(JSON.stringify(store, null, 2));
" <<< "$store_json")

# Write atomically
TMP_FILE=$(mktemp)
echo "$UPDATED_STORE" > "$TMP_FILE"
mv "$TMP_FILE" "$QA_STORE"

# Report success
SEVERITY_UPPER=$(echo "$SEVERITY" | tr '[:lower:]' '[:upper:]')
echo "✓ QA failure recorded [${FAILURE_ID}]"
echo "  Title:    ${TITLE}"
echo "  Severity: ${SEVERITY_UPPER}"
echo "  Files:    ${FILES[*]}"
echo "  Store:    ${QA_STORE}"
