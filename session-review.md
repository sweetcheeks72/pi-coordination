# Adversarial Review — batch2/fix-and-merge (pre-push)

**Reviewer:** Murray (Feynman Reviewer — adversarial, no fixes)  
**Date:** 2026-03-15  
**Branch:** batch2/fix-and-merge  
**Commits reviewed:** 592afa1 ← daec096 ← 7665102 ← 008701f ← fed66a4 ← 8453698 ← 89f9b3d ← 611c367 ← 5fbe3cc  

---

<<adversarial_review>>

## Verdict (FIRST — before evidence)

**NEEDS_WORK**  
Confidence: HIGH  
The cherry-pick of 611c367 completely replaced 3 module APIs without updating the corresponding tests — 12 tests fail (6/6 hitl-gate, 6/6 worktree-manager, 6/6 auto-repair) because tests still import symbols that no longer exist.

REVIEW_TOKEN: { verdict: NEEDS_WORK, issues: 3, critical: 1 }

---

## Phase 1: My Independent Approach (Blind — before reading session work)

Given a cherry-pick migration of 3 module APIs and 4 bug-fix commits, here is what I would verify:

**What I'd expect to be correct:**
1. No conflict markers (`<<<<<<<`, `>>>>>>>`) in any source or test file
2. All existing tests still pass — cherry-pick should not regress green tests
3. The 4 bug-fix commits are atomic and localized (one concern per commit)
4. The security fix (HTML injection) properly escapes the label in all code paths
5. The API renames/replacements have corresponding test updates

**Critical edge cases I'd target:**
- **API surface mismatch** — if 3 modules were rewritten, their old exported symbols are gone; any test or consumer importing old names will crash at import time
- **Double-cleanup race** — signal handlers that lack idempotency guards (`cleanedUp` check) can run `git worktree remove` twice on rapid SIGINT+SIGTERM delivery
- **HTML injection** — `JSON.stringify(opt.label)` in `onclick` context does NOT escape HTML: a label like `"); alert(1);//` would execute JS
- **Log/return mismatch** — a timeout handler that logs "Proceeding" but returns `false` misleads operators monitoring logs
- **View index corruption** — navigation methods that update all index cursors regardless of active view corrupt unused-view indices

**Tests I'd require:**
- NEW tests exercising `requestApproval`, `createWorktree`, `detectTestFailures`, `shouldAutoRepair` with the new API shapes
- Security: test that `opt.label` with `"` or `<script>` produces safe HTML in the escalation button
- Worktree: double-signal test verifying cleanup runs exactly once
- Pipeline: oscillation detection with A→B→A issue pattern

---

## Phase 2: What the Session Did

**Approach:** 4 commits cherry-picked from `fix/sdk-model-registry-compat` into `batch2/fix-and-merge` using `--theirs` conflict resolution. The commits span two separate authoring sessions (89f9b3d/5fbe3cc from Mar 14, rest from Mar 15).

**Files changed:**
- `coordinate/hitl-gate.ts` — **full rewrite**: 339 lines removed, ~80 new. Old API `detectHighStakesActions`, `buildGateQuestion`, `recordDecision`, `getDecisions`, `getHITLSummary`, `HIGH_STAKES_PATTERNS` entirely gone. New single export: `requestApproval(opts: HitlGateOptions): Promise<boolean>`
- `coordinate/auto-repair.ts` — **full rewrite**: 287 lines removed. Old export `runAutoRepair` gone. New: `detectTestFailures`, `shouldAutoRepair`, `TEST_RESULT_REGEX`, `RepairCandidate`
- `coordinate/worktree-manager.ts` — **full rewrite**: 418 lines removed. Old API `allocateWorktree`, `releaseWorktree`, `mergeWorktreeBranch`, `cleanupAllWorktrees`, `shouldUseWorktrees` gone. New: `createWorktree`, `listWorktrees`
- `coordinate/context-compactor.ts` — expanded from minimal stub to full implementation (conflict resolution commit 8453698)
- `coordinate/escalation.ts` — XSS fix (008701f)
- `coordinate/dashboard.ts` — view-aware navigation (7665102)
- `coordinate/worktree-manager.ts` — double-cleanup guard (592afa1)
- `coordinate/hitl-gate.ts` — timeout log fix (daec096)
- `coordinate/pipeline.ts`, `coordinate/nudge.ts`, `coordinate/a2a.ts` — pipeline/oscillation/nudge fixes (89f9b3d, 5fbe3cc)

**Tests written:** None added in these commits.  
**Tests updated:** None — this is the problem.  
**Stated reasoning (commit message 611c367):** "fix: index scope, hitl gate, checkpoint hash, auto-repair regex, cycle detection, worktree signal handlers" — describes functional fixes but doesn't mention the API shape change.

---

## Phase 3: Socratic Interrogation

### Q1 — The 12 test failures: are they my expected gap, or did they choose a worse path?

I expected either (a) new tests for the new API, or (b) updated tests migrated from old → new API. The session chose (c) neither — the old tests were left untouched while the modules they test were completely rewritten. This is unambiguously worse than both alternatives.

**Concrete failing scenario:** Run `NODE_PATH=... npx jiti tests/unit/hitl-gate.test.ts` → immediate `(0, _hitlGate.detectHighStakesActions) is not a function` on all 6 tests. This is not a subtle failure — it is an import-time crash for every test that touches the old symbol.

**Test count:**
- `hitl-gate.test.ts`: 0/6 passing
- `worktree-manager.test.ts`: 0/6 passing  
- `auto-repair.test.ts`: 0/6 passing (4 render-utils tests in the same file still pass, but 6 `runAutoRepair` tests fail)
- **Total regression: 12 tests**

### Q2 — Are the failing tests testing the right things?

The tests were written for the **old API**. Whether they test the right things for the **new API** is moot — the old API no longer exists. The tests have a binary problem: the symbols they import are undefined. The test logic is sound for the old behavior; it is simply testing code that no longer ships.

The resolution required is clear: update the 3 test files to import and exercise `requestApproval`, `createWorktree`/`listWorktrees`, and `detectTestFailures`/`shouldAutoRepair` respectively.

### Q3 — Is the security fix (008701f) actually correct?

**Before:** `onclick="respond(${num}, ${JSON.stringify(opt.label)})"` — `JSON.stringify` escapes JSON special chars (`"`, `\`) but does NOT escape HTML. A label like `<img src=x onerror=alert(1)>` would be JSON-stringified to `"<img src=x onerror=alert(1)>"` and injected verbatim into the HTML attribute context, where the browser would parse `<img...>` as a tag closing the attribute.

**After:** `onclick="respond(${num}, this.dataset.label)" data-label="${escHtml(opt.label)}"` — label is stored in a DOM attribute (properly HTML-entity-encoded by `escHtml`) and retrieved at runtime via `dataset.label`. The `onclick` string no longer contains user data. This is the correct pattern.

✅ **CONFIRMED CORRECT** — the security fix is sound. `dataset.label` reads the decoded attribute value, which is safe regardless of label content.

### Q4 — Is the hitl-gate timeout log fix (daec096) correct?

Before: `"Proceeding without human approval."` + `return false` — the log says "proceeding" but execution returns `false` (denied). After: `"Denying — no human response received within timeout."` + `return false` — log and return value agree.

✅ **CONFIRMED CORRECT** — log now matches semantics. This is a low-risk cosmetic change with correct intent. No logic change.

### Q5 — Is the view-aware navigation fix (7665102) correct?

Before: `selectNext()` incremented BOTH `selectedTaskIndex` AND `selectedWorkerIndex` unconditionally. This means navigating up/down in the task view silently mutated the worker index, so switching views would land on the wrong item.

After: only the index for the active view is updated. The three view names used are `"tasks"`, `"mesh"`, and `"agent"` — tasks and mesh both operate on task-list index; agent view operates on worker index.

✅ **CONFIRMED CORRECT** — the mutual exclusivity is proper. No case where both indices should update simultaneously exists in the dashboard logic.

### Q6 — Is the double-cleanup guard (592afa1) sufficient?

The `cleanedUp` boolean is declared inside `createWorktree`'s closure scope, initialized to `false`. The `onSignal` handler checks `if (cleanedUp) return` and sets `cleanedUp = true` before running `execFile`. Node.js signal handlers can fire on the same event loop tick in some scenarios, but since `cleanedUp = true` is set synchronously before the async `execFile` call, a second synchronous signal invocation will see `cleanedUp = true` and bail. This covers the primary double-cleanup vector.

✅ **CONFIRMED CORRECT** — the guard is sound for the synchronous entry-point case.

### Q7 — Does the context-compactor conflict resolution (8453698) actually restore both exports?

Verification: `grep -n "^export" coordinate/context-compactor.ts` confirms:
- `export interface SessionDigest` at line 44 ✅
- `export async function compactMessages(` at line 395 ✅
- All intermediate types (`CompletedTask`, `buildWorkerContextHeader`, `loadDigest`, `saveCrossSessionDigest`, `loadCrossSessionDigest`) also exported

✅ **CONFIRMED CORRECT** — both symbols lost in the `--theirs` merge conflict resolution are present and properly exported.

### Q8 — Does the pipeline oscillation detection (5fbe3cc) introduce any regression risk?

The commit replaces `if (issuesFromN-1 matches issuesFromN)` with `if (issuesFromN-1 matches issuesFromN OR issuesFromN-2 matches issuesFromN)` for stuck-issue detection. This is strictly more conservative (will detect stalls sooner) and cannot false-negative. The helper `countMatchingIssues()` is extracted cleanly. The integration fix cycle counter `integrationFixCycle` being separate from `maxFixCycles` prevents exhausting the reviewer budget on integration-only failures.

✅ **CONFIRMED CORRECT** — logic tightening, no regression surface identified.

---

## Phase 4: Evidence

### Issues Found

🐛 **CRITICAL — API Tombstone: hitl-gate tests import 6 removed symbols**  
`tests/unit/hitl-gate.test.ts:35-41`  
Imports: `detectHighStakesActions`, `buildGateQuestion`, `recordDecision`, `getDecisions`, `getHITLSummary`, `HIGH_STAKES_PATTERNS`  
All 6 are absent from `coordinate/hitl-gate.ts` (only export: `requestApproval`).  
Repro: `NODE_PATH=... npx jiti tests/unit/hitl-gate.test.ts` → 6/6 fail: `(0, _hitlGate.detectHighStakesActions) is not a function`  
**Blocker.** Tests must be updated to exercise the new `requestApproval` API before push.

🐛 **CRITICAL — API Tombstone: worktree-manager tests import 4 removed symbols**  
`tests/unit/worktree-manager.test.ts` (imports line ~35)  
Imports: `shouldUseWorktrees`, `allocateWorktree`, `mergeWorktreeBranch` (plus `releaseWorktree` by inference)  
All absent from `coordinate/worktree-manager.ts` (exports: `createWorktree`, `listWorktrees`).  
Repro: `NODE_PATH=... npx jiti tests/unit/worktree-manager.test.ts` → 6/6 fail: `shouldUseWorktrees is not a function`  
**Blocker.** Tests must be migrated to new API.

🐛 **HIGH — API Tombstone: auto-repair tests import removed `runAutoRepair`**  
`tests/unit/auto-repair.test.ts:35`  
Imports: `runAutoRepair, type RepairContext`  
`runAutoRepair` is absent from `coordinate/auto-repair.ts` (exports: `detectTestFailures`, `shouldAutoRepair`, `TEST_RESULT_REGEX`).  
Repro: `NODE_PATH=... npx jiti tests/unit/auto-repair.test.ts` → 6 `runAutoRepair` tests fail: `(0, _autoRepair.runAutoRepair) is not a function` (4 render-utils tests in same file still pass).  
**Blocker.** The 6 auto-repair behavior tests need migration to new API.

✅ **CONFIRMED — Security fix (008701f) is correct**  
`coordinate/escalation.ts:78`  
`data-label="${escHtml(opt.label)}"` + `this.dataset.label` prevents HTML injection in the escalation button onclick. Verified: `escHtml` is used consistently on the attribute; the JS side reads the DOM-decoded value safely.

✅ **CONFIRMED — Timeout log fix (daec096) is correct**  
`coordinate/hitl-gate.ts:91-93`  
Log message now says "Denying" matching `return false`. Low risk, single-line change.

✅ **CONFIRMED — View-aware navigation fix (7665102) is correct**  
`coordinate/dashboard.ts:1165-1195`  
`selectNext`/`selectPrev` now gate index mutation behind `this.activeView` check. Prevents cross-view index corruption.

✅ **CONFIRMED — Double-cleanup guard (592afa1) is correct**  
`coordinate/worktree-manager.ts:69-70`  
`cleanedUp` boolean in closure scope prevents double `git worktree remove` on rapid signal delivery.

✅ **CONFIRMED — Context compactor conflict resolution (8453698) is correct**  
Both `SessionDigest` (interface) and `compactMessages` (async function) present and exported in `coordinate/context-compactor.ts`.

✅ **CONFIRMED — No conflict markers**  
`grep -rn "<<<<<<\|>>>>>>" coordinate/ tests/` returns empty. Clean cherry-pick.

⚠️ **OBSERVATION — auto-repair test runner reports 0/0 on summary line**  
The `runner.summary()` call in `auto-repair.test.ts` prints `Passed: 0/0 / Failed: 0/0` even when 4+6 tests actually ran. This is a pre-existing test-runner quirk (possibly from async test registration) but is obscured by the import crash. Not a new issue — document for test infrastructure review.

⚠️ **OBSERVATION — New hitl-gate API (`requestApproval`) has zero test coverage**  
`coordinate/hitl-gate.ts` exports a single function handling the full HITL approval lifecycle (stdio, timeout, return value). It has no unit tests. This is not a regression introduced by the cherry-pick (the old tests simply haven't been migrated), but coverage is zero for production-critical behavior.

---

## Issues Found: 3 (1 critical, 1 high, 1 medium)

## Recommendation: FIX FIRST

The 7 functional fixes (security, log consistency, navigation, double-cleanup, conflict resolution, pipeline oscillation, nudge/a2a types) are all correct and ready. However the branch cannot ship until the 12 test failures are resolved. The fix is mechanical: update the 3 test files to import and exercise the new API shapes — `requestApproval`, `createWorktree`/`listWorktrees`, `detectTestFailures`/`shouldAutoRepair`.

## Next Steps
1. **Worker (Dyson):** Update `tests/unit/hitl-gate.test.ts` to test `requestApproval` — mock the stdio interview tool call, verify return values for approve/deny/timeout branches
2. **Worker (Dyson):** Update `tests/unit/worktree-manager.test.ts` to test `createWorktree`/`listWorktrees` with the new `WorktreeOptions`/`WorktreeHandle` interfaces
3. **Worker (Dyson):** Update `tests/unit/auto-repair.test.ts` to test `detectTestFailures`/`shouldAutoRepair` with sample failure strings
4. **Re-run review:** Murray pass 2 after fixes — verify 0 regressions in currently-passing 268 tests, plus all 3 migrated suites green
5. **Verifier (Hans):** Invariant check on the `requestApproval` timeout branch and the `cleanedUp` signal guard

<</adversarial_review>>

---

## Summary Scorecard

| Area | Status | Severity | Notes |
|---|---|---|---|
| Conflict markers | ✅ Clean | — | No `<<<<<<<` / `>>>>>>>` anywhere |
| hitl-gate API tests | ❌ FAILING | **CRITICAL** | 6/6 — all import removed symbols |
| worktree-manager API tests | ❌ FAILING | **CRITICAL** | 6/6 — all import removed symbols |
| auto-repair API tests | ❌ FAILING | **HIGH** | 6/6 `runAutoRepair` tests fail; 4 render-utils tests still pass |
| HTML injection fix (008701f) | ✅ Correct | — | `data-label` + `escHtml` pattern is safe |
| Timeout log fix (daec096) | ✅ Correct | — | Log message now matches `return false` |
| View-aware navigation (7665102) | ✅ Correct | — | Gate prevents cross-view index drift |
| Double-cleanup guard (592afa1) | ✅ Correct | — | `cleanedUp` closure bool is sufficient |
| Context compactor merge (8453698) | ✅ Correct | — | Both `SessionDigest` and `compactMessages` exported |
| Pipeline oscillation (5fbe3cc) | ✅ Correct | — | A→B→A detection + budget fix sound |
| Nudge/a2a/lock types (89f9b3d) | ✅ Correct | — | Type + lock consistency improvements |
| Security (OWASP LLM02 check) | ✅ Addressed | — | 008701f fixes the one XSS vector found |
| New API test coverage | ⚠️ Zero | **Medium** | `requestApproval` has 0 unit tests post-migration |
| **Overall verdict** | **NEEDS_WORK** | — | Fix 3 test files; re-review; then push |

