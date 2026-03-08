#!/usr/bin/env bash
# Mutation test: verify bundle-files test catches swapped signal/onUpdate params
set -e
REPO=~/.pi/agent/git/github.com/nicobailon/pi-coordination
FILE="$REPO/bundle-files/index.ts"
BACKUP="/tmp/bundle-files-backup.ts"

cp "$FILE" "$BACKUP"
echo "=== MUTATION: swap _signal/_onUpdate in scan_files ==="
sed -i '' 's/async (_toolCallId, params, _signal, _onUpdate, _ctx) => {/async (_toolCallId, params, _onUpdate, _signal, _ctx) => {/' "$FILE"
echo "--- RED phase (should FAIL) ---"
cd "$REPO"
npx vitest run tests/tool-execute-contract.test.ts --reporter verbose 2>&1 | grep -E "bundle-files|FAIL|PASS|✓|✗|×" | head -20 || true

echo ""
echo "=== RESTORE ==="
cp "$BACKUP" "$FILE"
echo "--- GREEN phase (should PASS) ---"
npx vitest run tests/tool-execute-contract.test.ts --reporter verbose 2>&1 | grep -E "bundle-files|FAIL|PASS|✓|✗|×" | head -20 || true
echo "Done."
