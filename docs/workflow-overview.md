# Pi Coordination Workflow Overview

This document describes the **two-track architecture** of pi-coordination:

- **Plan Tool** — Creates TASK-XX specs from prose/PRDs
- **Coordinate Tool** — Executes validated specs with parallel workers

---

## Two-Track Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           TWO-TRACK ARCHITECTURE                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   User Input                                                                │
│   ─────────────────────────────────────────────────────────────────────     │
│                                                                             │
│   Prose/PRD/Idea                    TASK-XX Spec                            │
│   "Add authentication"              (already structured)                    │
│         │                                 │                                 │
│         ▼                                 │                                 │
│   ┌───────────────┐                       │                                 │
│   │  PLAN TOOL    │                       │                                 │
│   │               │                       │                                 │
│   │  Interview    │                       │                                 │
│   │      ↓        │                       │                                 │
│   │  Scout        │                       │                                 │
│   │      ↓        │                       │                                 │
│   │  Elaborate    │                       │                                 │
│   │      ↓        │                       │                                 │
│   │  Structure    │                       │                                 │
│   │      ↓        │                       │                                 │
│   │  Handoff      │                       │                                 │
│   └───────┬───────┘                       │                                 │
│           │                               │                                 │
│           ▼                               │                                 │
│        spec.md ───────────────────────────┤                                 │
│                                           │                                 │
│                                           ▼                                 │
│                                   ┌───────────────┐                         │
│                                   │ COORDINATE    │                         │
│                                   │               │                         │
│                                   │  Validate     │                         │
│                                   │      ↓        │                         │
│                                   │  Dispatch     │                         │
│                                   │      ↓        │                         │
│                                   │  Workers      │                         │
│                                   │      ↓        │                         │
│                                   │  Review       │                         │
│                                   │      ↓        │                         │
│                                   │  Fixes        │                         │
│                                   └───────────────┘                         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Plan Tool

The plan tool converts prose, PRDs, or ideas into structured TASK-XX format specs through an interactive flow.

### Usage

```typescript
// New plan from prose
plan({ input: "Add JWT authentication" })

// New plan from file
plan({ input: "./requirements.md" })

// Refine existing spec
plan({ continue: "./auth-spec.md" })

// Skip interview (use defaults)
plan({ input: "./prd.md", skipInterview: true })
```

### Plan Tool Phases

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            PLAN TOOL PHASES                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ PHASE 1: Interview                                     [60s per Q]    │ │
│  │                                                                        │ │
│  │  Multi-round interactive interview to gather requirements:             │ │
│  │                                                                        │ │
│  │  Round 1: Discovery (text questions)                                   │ │
│  │    "What are you building?"                                            │ │
│  │    "What does success look like?"                                      │ │
│  │                                                                        │ │
│  │  Round 2: Technical (select options)                                   │ │
│  │    Framework? [React|Vue|Svelte]                                       │ │
│  │    Include tests? [Yes|No]                                             │ │
│  │                                                                        │ │
│  │  Round 3+: Clarifications based on LLM analysis                        │ │
│  │                                                                        │ │
│  │  Behaviors:                                                            │ │
│  │  - ESC on Q1 = abort planning                                          │ │
│  │  - Timeout = use default, continue                                     │ │
│  │  - Ctrl+D = skip remaining questions                                   │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                      │                                      │
│                                      ▼                                      │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ PHASE 2: Scout (targeted)                                              │ │
│  │                                                                        │ │
│  │  Questions derived from interview findings:                            │ │
│  │  • Existing patterns for this feature?                                 │ │
│  │  • Related models/types?                                               │ │
│  │  • Test patterns in use?                                               │ │
│  │  • Configuration/environment setup?                                    │ │
│  │                                                                        │ │
│  │  Output: ScoutResult with:                                             │ │
│  │  - metaPrompt (~15K tokens) - Synthesized guidance                     │ │
│  │  - contextDoc (~85K tokens) - Relevant file contents                   │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                      │                                      │
│                                      ▼                                      │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ PHASE 3: Elaborate (frontier model)                                    │ │
│  │                                                                        │ │
│  │  ~100K token context injected directly (no tool calls):                │ │
│  │  - Original request                                                    │ │
│  │  - Interview transcript                                                │ │
│  │  - Scout metaPrompt + contextDoc                                       │ │
│  │                                                                        │ │
│  │  Output: 1000-3000 word detailed implementation plan                   │ │
│  │  - Reasoning and justifications                                        │ │
│  │  - Edge cases and error handling                                       │ │
│  │  - Technical decisions with rationale                                  │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                      │                                      │
│                                      ▼                                      │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ PHASE 4: Structure                                                     │ │
│  │                                                                        │ │
│  │  Convert elaborated plan to TASK-XX format:                            │ │
│  │                                                                        │ │
│  │  ## TASK-01: Create auth types                                         │ │
│  │  Priority: P1                                                          │ │
│  │  Files: src/auth/types.ts (create)                                     │ │
│  │  Depends on: none                                                      │ │
│  │  Acceptance: Exports User, Token interfaces                            │ │
│  │                                                                        │ │
│  │  Validates output, retries if invalid (up to 2 retries)                │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                      │                                      │
│                                      ▼                                      │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ PHASE 5: Handoff                                       [60s timeout]  │ │
│  │                                                                        │ │
│  │  Spec saved to: auth-spec.md                                           │ │
│  │  Tasks: 6 | Files: 8 | P0: 1, P1: 3, P2: 2                            │ │
│  │                                                                        │ │
│  │  What would you like to do?                                            │ │
│  │  ● Execute now ──────────────────▶ coordinate({ plan: "spec.md" })     │ │
│  │  ○ Refine further ───────────────▶ plan({ continue: "spec.md" })       │ │
│  │  ○ Save and exit                                                       │ │
│  │                                                                        │ │
│  │  [timeout = Save and exit]                                             │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Plan Tool Options

```typescript
plan({
  // Input (exactly one required)
  input: string,                    // File path or inline text for NEW plans
  continue: string,                 // Path to existing spec to REFINE

  // Output
  output: string,                   // Where to save spec (default: specs/<name>-spec.md)
  format: "markdown" | "json",      // Output format (default: markdown)

  // Models
  model: string,                    // Model for elaboration (default: frontier)
  scoutModel: string,               // Model for scout (default: fast)

  // Behavior
  maxInterviewRounds: number,       // Limit interview rounds (default: 5 new, 3 refine)
  skipInterview: boolean,           // Skip interview phase
  skipScout: boolean,               // Skip scout phase
})
```

---

## Coordinate Tool

The coordinate tool executes validated TASK-XX format specs with parallel workers.

### Usage

```typescript
// Execute a spec
coordinate({ plan: "./auth-spec.md" })

// With more workers
coordinate({ plan: "./spec.md", agents: 8 })

// Async mode (returns immediately)
coordinate({ plan: "./spec.md", async: true })
```

### Spec Validation

The coordinate tool **requires** valid TASK-XX format specs. If validation fails:

```
Invalid spec format. The coordinate tool requires a valid TASK-XX format spec.

Errors:
- No valid TASK-XX format tasks found
- Task TASK-02 depends on non-existent task TASK-99

To create a valid spec, use the 'plan' tool:
  plan({ input: "./your-file.md" })
```

### Coordinate Tool Phases

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         COORDINATE TOOL PHASES                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ PHASE 1: Validate                                                      │ │
│  │                                                                        │ │
│  │  ✓ Has TASK-XX sections                                                │ │
│  │  ✓ All task IDs valid (TASK-\d{2,}(.\d+)?)                            │ │
│  │  ✓ No circular dependencies                                            │ │
│  │  ✓ Entry point exists (task with no deps)                              │ │
│  │  ✓ All dependencies reference existing tasks                           │ │
│  │  ✓ Required fields present (Priority, Files, Depends on, Acceptance)   │ │
│  │                                                                        │ │
│  │  Invalid? → Error with actionable fix suggestions                      │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                      │                                      │
│                                      ▼                                      │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ PHASE 2: Dispatch (priority-aware)                                     │ │
│  │                                                                        │ │
│  │  Ready tasks = no deps OR all deps complete                            │ │
│  │  Sort: P0 → P1 → P2 → P3, then by dependency count                     │ │
│  │                                                                        │ │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐                    │ │
│  │  │ TASK-01 │  │ TASK-02 │  │ TASK-03 │  │ TASK-04 │                    │ │
│  │  │   P0    │  │   P1    │  │   P1    │  │   P2    │                    │ │
│  │  │ ready ✓ │  │ blocked │  │ blocked │  │ blocked │                    │ │
│  │  └─────────┘  └─────────┘  └─────────┘  └─────────┘                    │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                      │                                      │
│                                      ▼                                      │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ PHASE 3: Workers (parallel execution)                                  │ │
│  │                                                                        │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                  │ │
│  │  │   Worker A   │  │   Worker B   │  │   Worker C   │                  │ │
│  │  │   TASK-01    │  │   TASK-02    │  │   TASK-03    │                  │ │
│  │  │   working    │  │   waiting    │  │   waiting    │                  │ │
│  │  └──────────────┘  └──────────────┘  └──────────────┘                  │ │
│  │                                                                        │ │
│  │  Features:                                                             │ │
│  │  • Fresh eyes self-review before completion (tool-gated)              │ │
│  │  • Can create subtasks (TASK-XX.Y format, max 5 per parent)           │ │
│  │  • Worker context persisted to context.md                              │ │
│  │  • Smart auto-continue on failure                                      │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                      │                                      │
│                                      ▼                                      │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ PHASE 4: Integration Review (cross-component)                          │ │
│  │                                                                        │ │
│  │  Checks changes from ALL workers together:                             │ │
│  │  • API contracts between components                                    │ │
│  │  • Shared types and interfaces                                         │ │
│  │  • Data flow consistency                                               │ │
│  │  • Cross-component dependencies                                        │ │
│  │                                                                        │ │
│  │  Skipped if: single worker OR no files modified                        │ │
│  │  Issues found? → Fix before regular review                             │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                      │                                      │
│                                      ▼                                      │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ PHASE 5: Review (code-reviewer with fresh eyes)                        │ │
│  │                                                                        │ │
│  │  Reviewer READS FULL FILES (not just diff):                            │ │
│  │  • Tests pass?                                                         │ │
│  │  • Acceptance criteria met?                                            │ │
│  │  • No regressions?                                                     │ │
│  │  • Code quality issues?                                                │ │
│  │                                                                        │ │
│  │  Fresh eyes: After initial review, re-reviews with "fresh eyes"        │ │
│  │  prompt to catch anything missed (up to 2 cycles)                      │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                      │                                      │
│                         ┌────────────┴────────────┐                         │
│                         │                         │                         │
│                         ▼                         ▼                         │
│                   [All passing]            [Has issues]                     │
│                         │                         │                         │
│                         ▼                         ▼                         │
│                    ┌─────────┐           ┌───────────────┐                  │
│                    │ COMPLETE │           │  FIX PHASE    │                  │
│                    └─────────┘           │  (up to 5x)   │                  │
│                                          │               │                  │
│                                          │ Fix workers   │                  │
│                                          │ get checklist │                  │
│                                          └───────────────┘                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Coordinate Tool Options

```typescript
coordinate({
  // Required
  plan: string,                     // Path to TASK-XX format spec file

  // Workers
  agents: number | string[],        // Worker count or array (default: 4)

  // Review
  reviewCycles: number | false,     // Worker self-review cycles (default: 5)
  maxFixCycles: number,             // Review/fix iterations (default: 5)
  checkTests: boolean,              // Reviewer checks tests (default: true)
  sameIssueLimit: number,           // Times same issue can recur before giving up (default: 2)

  // Supervisor
  supervisor: boolean | {           // Monitor stuck workers (default: true)
    enabled?: boolean,
    nudgeThresholdMs?: number,      // Before wrap_up nudge (default: 180000)
    restartThresholdMs?: number,    // Before force restart (default: 300000)
    maxRestarts?: number,           // Before abandoning (default: 2)
    checkIntervalMs?: number,       // Check frequency (default: 30000)
  },

  // Cost
  costLimit: number,                // End gracefully at limit (default: 40)

  // Resume
  resume: string,                   // Checkpoint ID to resume from

  // Async
  async: boolean,                   // Run in background (default: false)
  asyncResultsDir: string,          // Override results directory

  // Output
  logPath: string,                  // Where to save coordination log
  maxOutput: { bytes?, lines? },    // Truncation limits

  // Validation
  validate: boolean,                // Run validation after (default: false)
  validateStream: boolean,          // Stream warnings (default: false)

  // Model overrides
  coordinator: string | { model: string },
  worker: string | { model: string },
  reviewer: string | { model: string },
})
```

---

## TASK-XX Spec Format

The coordinate tool requires specs in this format:

```markdown
# Project Title

Optional description of the project.

---

## TASK-01: Create auth types
Priority: P1
Files: src/auth/types.ts (create)
Depends on: none
Acceptance: Exports User, Token, Session interfaces

Optional detailed description of the task.

## TASK-02: Implement JWT utilities
Priority: P1
Files: src/auth/jwt.ts (create), src/auth/types.ts (modify)
Depends on: TASK-01
Acceptance: signToken and verifyToken functions work correctly

## TASK-03: Add login endpoint
Priority: P1
Files: src/routes/auth.ts (create)
Depends on: TASK-01, TASK-02
Acceptance: POST /login returns JWT token on valid credentials
```

### Required Fields

| Field | Format | Description |
|-------|--------|-------------|
| Header | `## TASK-XX: Title` | Task ID (TASK-01, TASK-02, etc.) and title |
| Priority | `Priority: P0\|P1\|P2\|P3` | P0 = critical, P3 = low |
| Files | `Files: path (action)` | Files with (create), (modify), or (delete) |
| Depends on | `Depends on: TASK-XX` | Dependencies or "none" |
| Acceptance | `Acceptance: criteria` | Testable completion criteria |

### Task ID Formats

| Format | Example | Description |
|--------|---------|-------------|
| `TASK-XX` | TASK-01 | Main spec task |
| `TASK-XX.Y` | TASK-01.1 | Subtask (max 5 per parent) |
| `DISC-XX` | DISC-01 | Discovered task |
| `FIX-XX` | FIX-01 | Fix task from reviewer |

---

## Worker Context & Auto-Continue

Workers maintain persistent context that survives crashes and enables intelligent restarts.

### Worker Context File

Each task has a `workers/<task-id>/context.md` file:

```markdown
# Task Context: TASK-03

## Files Modified
- ✓ migrations/003_pool.sql (complete)
- ⚠️ src/db/users.ts (partial - line 45 error)

## Discoveries
- Legacy connection in src/legacy/db.js

## Last Actions
- [14:25:01] ✓ write: migrations/003_pool.sql
- [14:25:15] ✗ edit: src/db/users.ts (syntax error)

## Continuation Notes
- Don't recreate migrations/003_pool.sql
- Fix syntax error at src/db/users.ts:45
```

### Auto-Continue Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          AUTO-CONTINUE FLOW                                 │
│                   (at spawn level, NOT coordinator)                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   Worker exits non-zero                                                     │
│         │                                                                   │
│         ▼                                                                   │
│   ┌─────────────────────────────────────────────────┐                       │
│   │ Load workers/<task-id>/context.md               │                       │
│   │ • Files modified (with status)                  │                       │
│   │ • Discoveries                                   │                       │
│   │ • Last actions before failure                   │                       │
│   │ • Continuation notes                            │                       │
│   └─────────────────────────────────────────────────┘                       │
│         │                                                                   │
│         ▼                                                                   │
│   restartCount > maxRestarts?                                               │
│         │                                                                   │
│     ┌───┴───┐                                                               │
│     │       │                                                               │
│    YES     NO                                                               │
│     │       │                                                               │
│     ▼       ▼                                                               │
│   FAIL   Build continuation prompt:                                         │
│          ┌─────────────────────────────────────────────────────────────┐    │
│          │ ## Task: TASK-03 (Continuation - Attempt 2)                 │    │
│          │                                                             │    │
│          │ ### ⚠️ CONTINUATION FROM FAILED ATTEMPT                     │    │
│          │ Previous attempt exited with code 1.                        │    │
│          │                                                             │    │
│          │ ### Files Already Modified (verify before recreating)       │    │
│          │ - ✓ migrations/003_pool.sql (complete)                      │    │
│          │ - ⚠️ src/db/users.ts (partial - fix line 45)                │    │
│          │                                                             │    │
│          │ ### Instructions                                            │    │
│          │ 1. Verify which previous files are valid                    │    │
│          │ 2. Don't redo completed work                                │    │
│          │ 3. Focus on fixing the specific failure                     │    │
│          └─────────────────────────────────────────────────────────────┘    │
│         │                                                                   │
│         ▼                                                                   │
│   Spawn new worker with context                                             │
│   (no coordinator involvement!)                                             │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Supervisor Loop

The supervisor monitors workers and intervenes when stuck.

### Nudge + Auto-Continue

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    NUDGE + AUTO-CONTINUE (complementary)                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Worker running                                                             │
│       │                                                                     │
│       │ ═══ context.md updated continuously ═══                             │
│       │                                                                     │
│       │ (inactive 3 min)                                                    │
│       ▼                                                                     │
│  Supervisor: sendNudge(wrap_up) ──▶ Worker tries to wrap up                 │
│       │                                                                     │
│       │ (still stuck 5 min)                                                 │
│       ▼                                                                     │
│  Supervisor: sendNudge(restart) + kill ──▶ Worker exits                     │
│       │                                                                     │
│       │ (exit code 143)                                                     │
│       ▼                                                                     │
│  Auto-continue: Load context → Build prompt → Spawn new worker              │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│  NUDGE = Detection + Intervention (proactive)                               │
│  AUTO-CONTINUE = Smart Recovery (reactive, after exit)                      │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Nudge Types

| Type | Trigger | Effect |
|------|---------|--------|
| `wrap_up` | 3 min inactive | Message injected: "Wrap up your work" |
| `restart` | 5 min inactive | Worker killed, auto-continue spawns replacement |
| `abort` | Manual/critical | Worker exits immediately |

### Supervisor Configuration

| Config | Default | Description |
|--------|---------|-------------|
| `nudgeThresholdMs` | 180000 (3 min) | Before sending wrap_up nudge |
| `restartThresholdMs` | 300000 (5 min) | Before forcing restart |
| `maxRestarts` | 2 | Restarts before abandoning task |
| `checkIntervalMs` | 30000 (30s) | How often to check workers |

---

## Worker Fresh Eyes Self-Review

Workers do a "fresh eyes" self-review before completing. This is a **tool-gated** approach: the first call to `agent_work({ action: 'complete' })` returns a fresh eyes prompt instead of completing.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       WORKER FRESH EYES REVIEW                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Worker implements task                                                     │
│         │                                                                   │
│         ▼                                                                   │
│  Worker calls agent_work({ action: 'complete' })  ← First attempt           │
│         │                                                                   │
│         ▼                                                                   │
│  ┌────────────────────────────────────────┐                                 │
│  │ Tool intercepts - fresh eyes enabled?  │                                 │
│  │ cycleCount < MAX_CYCLES?               │                                 │
│  └────────────────────────────────────────┘                                 │
│         │                                                                   │
│     ┌───┴───┐                                                               │
│    NO      YES                                                              │
│     │       │                                                               │
│     │       ▼                                                               │
│     │  cycleCount++ (now 1)                                                 │
│     │       │                                                               │
│     │       ▼                                                               │
│     │  Is this cycle 1?                                                     │
│     │       │                                                               │
│     │   ┌───┴───┐                                                           │
│     │  YES     NO                                                           │
│     │   │       │                                                           │
│     │   ▼       ▼                                                           │
│     │  Return FRESH EYES   Allow completion                                 │
│     │  PROMPT (don't       (they've done                                    │
│     │  complete yet)       at least one review)                             │
│     │   │                       │                                           │
│     │   ▼                       │                                           │
│     │  "Before completing,      │                                           │
│     │   do a fresh eyes         │                                           │
│     │   review..."              │                                           │
│     │   │                       │                                           │
│     │   ▼                       │                                           │
│     │  Worker reads files,      │                                           │
│     │  reviews changes,         │                                           │
│     │  fixes any issues         │                                           │
│     │   │                       │                                           │
│     │   ▼                       │                                           │
│     │  Worker calls complete ───┘                                           │
│     │  again (2nd attempt)                                                  │
│     │                                                                       │
│     ▼                                                                       │
│  agent_work({ action: 'complete' }) succeeds                                │
│  Worker marked as complete                                                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Fresh Eyes Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_FRESH_EYES_ENABLED` | `"true"` | Set to `"false"` to disable |
| `PI_FRESH_EYES_MAX_CYCLES` | `2` | Max cycles before allowing completion |

---

## Integration Review

After workers complete, an **Integration Review** phase runs to catch cross-component issues that individual workers might miss.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         INTEGRATION REVIEW PHASE                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  All workers completed                                                      │
│         │                                                                   │
│         ▼                                                                   │
│  ┌────────────────────────────────────────┐                                 │
│  │ Short-circuit checks:                  │                                 │
│  │ • Single worker? → Skip                │                                 │
│  │ • No files modified? → Skip            │                                 │
│  └────────────────────────────────────────┘                                 │
│         │                                                                   │
│         ▼                                                                   │
│  ┌────────────────────────────────────────┐                                 │
│  │ Reviewer analyzes ALL modified files   │                                 │
│  │ across ALL workers looking for:        │                                 │
│  │                                        │                                 │
│  │ • API contract mismatches              │                                 │
│  │   (function signatures, return types)  │                                 │
│  │                                        │                                 │
│  │ • Shared type inconsistencies          │                                 │
│  │   (different workers modified same     │                                 │
│  │    interface differently)              │                                 │
│  │                                        │                                 │
│  │ • Data flow issues                     │                                 │
│  │   (producer/consumer misalignments)    │                                 │
│  │                                        │                                 │
│  │ • Cross-component dependencies         │                                 │
│  │   (missing imports, broken references) │                                 │
│  └────────────────────────────────────────┘                                 │
│         │                                                                   │
│     ┌───┴───┐                                                               │
│    NO      YES (issues found)                                               │
│  ISSUES      │                                                              │
│     │        ▼                                                              │
│     │   Fix workers run BEFORE                                              │
│     │   regular review-fix loop                                             │
│     │        │                                                              │
│     └────────┴───▶ Regular Review-Fix Loop                                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Integration Review Categories

| Category | Description |
|----------|-------------|
| `integration` | Cross-component issues found by integration review |
| `bug` | Logic errors in code |
| `type` | Type mismatches |
| `missing` | Missing implementations |
| `regression` | Broken existing functionality |

---

## Subtask Support

Workers can break complex tasks into subtasks (TASK-XX.Y format).

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            SUBTASK CREATION                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Worker on TASK-03 realizes task is complex                                 │
│         │                                                                   │
│         ▼                                                                   │
│  Creates subtasks via add_subtask tool:                                     │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────┐        │
│  │ TASK-03.1: Create migration        ─┐                          │        │
│  │ TASK-03.2: Update queries           ├─ All run in parallel     │        │
│  │ TASK-03.3: Add indexes             ─┘                          │        │
│  └─────────────────────────────────────────────────────────────────┘        │
│                                                                             │
│  Constraints:                                                               │
│  • Max 5 subtasks per parent                                                │
│  • Subtasks depend on parent (implicit)                                     │
│  • Subtasks run in parallel (no inter-subtask deps)                         │
│  • Parent blocked until ALL subtasks complete                               │
│  • No nested subtasks (TASK-03.1.1 not allowed)                             │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Dependency Graph

Dependencies are tracked in `deps.json`:

### Dependency Types

| Type | Meaning | Example |
|------|---------|---------|
| `blocks` | Hard dep - A must complete before B | TASK-01 blocks TASK-02 |
| `parent` | Structural - B is subtask of A | TASK-03.1 parent TASK-03 |
| `waits-for` | Dynamic fanout | TASK-05 waits for TASK-03.* |
| `discovered` | Audit trail | DISC-01 discovered from TASK-02 |
| `related` | Soft link (informational) | TASK-04 related TASK-06 |

### Dependency Resolution

```
isTaskReady(taskId):
  1. Get all "blocks" deps where task is "from"
  2. For each blocker, check if status === "complete"
  3. If parent task, check areSubtasksComplete(parentId)
  4. Ready if all blockers complete AND all subtasks complete
```

---

## A2A (Agent-to-Agent) Messaging

Workers communicate via filesystem-based messages.

### Message Types

| Type | Use Case | Status |
|------|----------|--------|
| `file_release_request` | Ask another worker to release a file | Implemented |
| `file_release_response` | Grant/deny file release | Implemented |
| `discovery` | Share important finding | Implemented |
| `completion_notice` | Notify task done | Implemented |
| `task_handoff` | Hand off work | Defined (not yet implemented) |
| `help_request` | Ask for help | Defined (not yet implemented) |
| `status_update` | Progress update | Defined (not yet implemented) |

### Message Flow

```
Worker A                      messages/                       Worker B
    │                             │                               │
    │ agent_chat({ to: "all",     │                               │
    │   topic: "Found pattern",   │                               │
    │   content: "Details..."     │                               │
    │ })                          │                               │
    │                             │                               │
    +────▶ {timestamp}-{id}.json  │                               │
                                  │      turn_start               │
                                  │◀──────────────────────────────+
                                  │                               │
                                  +────▶ checkMessages()          │
                                         (filters by "to")        │
                                               │                  │
                                               ▼                  │
                                  "[Worker A] discovered:         │
                                   Found pattern..."              │
```

### Read Tracking

Messages are tracked via `message-read.json`:

```json
{
  "worker:TASK-01": ["msg-001", "msg-002"],
  "worker:TASK-02": ["msg-001"]
}
```

Workers don't re-receive already-read messages.

---

## File Reservation System

Workers reserve files for exclusive editing.

### Tools

| Tool | Description |
|------|-------------|
| `file_reservations` | Unified tool with `action: 'acquire' \| 'release' \| 'check'` |

### Auto-Release

Reservations auto-release when:
- Worker calls `file_reservations({ action: 'release' })`
- Worker calls `agent_work({ action: 'complete' })`
- TTL expires
- Worker process exits

---

## Coordinator Context

The coordinator maintains session context in `coordinator-context.md`:

```markdown
# Coordinator Context

## Session
- ID: abc123
- Plan: auth-spec.md
- Status: running
- Started: 2024-01-15T10:30:00Z

## Assignments
| Task | Worker | Attempt | Outcome | Duration |
|------|--------|---------|---------|----------|
| TASK-01 | worker-a | 1 | success | 45s |
| TASK-02 | worker-b | 1 | failed | 120s |
| TASK-02 | worker-c | 2 | success | 90s |

## Worker Performance
| Worker | Tasks | Success Rate | Avg Duration |
|--------|-------|--------------|--------------|
| worker-a | 3 | 100% | 52s |
| worker-b | 2 | 50% | 105s |

## Failure Patterns
- TASK-02: 2 failures, common error: "connection timeout"

## Continuation Notes
- Worker-b struggles with database tasks
- TASK-03 may need timeout increase
```

---

## Observability

### Event Types

| Event | Description |
|-------|-------------|
| `phase_started` | Pipeline phase started |
| `phase_completed` | Pipeline phase completed |
| `task_claimed` | Task claimed by worker |
| `task_completed` | Task completed |
| `worker_started` | Worker process started |
| `worker_completed` | Worker finished |
| `worker_failed` | Worker crashed |
| `worker_restarting` | Auto-continue triggered |
| `cost_milestone` | Cost threshold reached |

### Files

| File | Content |
|------|---------|
| `events.jsonl` | All coordination events |
| `decisions.jsonl` | Coordinator decisions |
| `traces/spans.jsonl` | Timing spans |
| `snapshots/*.json` | State snapshots |

---

## Coordination Data Layout

```
coordDir/
├── state.json                    # CoordinationState
├── tasks.json                    # Task queue
├── deps.json                     # Dependency graph
├── cost.json                     # Cost tracking
├── progress.md                   # Human-readable progress
├── coordinator-context.md        # Coordinator session context
├── execution-info.json           # Mode and task count
│
├── workers/                      # Per-task worker state
│   └── TASK-01/
│       ├── context.md            # Survives restarts
│       ├── attempt-001.json
│       └── attempt-002.json
│
├── messages/                     # A2A messages
│   └── {timestamp}-{id}.json
├── message-read.json             # Read tracking
│
├── nudges/                       # Supervisor -> Worker
│   └── {workerId}.json
│
├── reservations/                 # File reservations
├── escalation-responses/         # User Q&A responses
├── discoveries.json              # Shared discoveries
│
├── artifacts/                    # Per-agent artifacts
│   ├── coordinator-*/
│   └── worker:*-*/
│
├── traces/                       # Observability
│   └── spans.jsonl
├── snapshots/                    # State snapshots
├── events.jsonl                  # Event stream
└── decisions.jsonl               # Decision log
```

---

## Agent Organization

```
~/.pi/agent/agents/
├── coordination/                 # Symlinks to pi-coordination/agents/
│   ├── coordinator.md
│   ├── planner.md
│   ├── worker.md
│   ├── scout.md
│   └── reviewer.md
├── worker.md                     # Generic worker (unchanged)
└── scout.md                      # Generic scout (unchanged)
```

---

## SDK Worker Mode

By default, workers run as subprocesses. SDK worker mode runs workers in-process using Pi's SDK.

### Enable

```json
// runtime-config.json
{ "useSDKWorkers": true }
```

Or: `PI_USE_SDK_WORKERS=1`

### Benefits

- **Steering** — Send messages to running workers via `[i]` in dashboard
- **Direct abort** — Terminate workers immediately via `[x]` in dashboard
- **No subprocess overhead** — Workers share coordinator process

### Dashboard Controls

| Mode | Controls |
|------|----------|
| Subprocess (default) | `[w]` wrap up, `[R]` restart, `[A]` abort |
| SDK workers | `[i]` steer, `[x]` abort, `[w]` wrap up |

**Note:** `[R]` and `[A]` disabled for SDK workers (would crash coordinator).

---

## Environment Variables

| Variable | Set By | Used By | Description |
|----------|--------|---------|-------------|
| `PI_COORDINATION_DIR` | Coordinate tool | All | Path to coordination directory |
| `PI_WORKER_ID` | Coordinator | Worker | Worker UUID |
| `PI_AGENT_IDENTITY` | Coordinator | Worker | Worker identity string |
| `PI_TRACE_ID` | Coordinate tool | All | Observability trace ID |
| `PI_FRESH_EYES_ENABLED` | Coordinate tool | Worker, Reviewer | Enable fresh eyes self-review (default: true) |
| `PI_FRESH_EYES_MAX_CYCLES` | User | Worker, Reviewer | Max fresh eyes cycles (default: 2) |
| `PI_USE_SDK_WORKERS` | User | Coordinator | Enable SDK worker mode (default: false) |

---

## Troubleshooting

| Symptom | Check | Resolution |
|---------|-------|------------|
| "Invalid spec format" | Spec has TASK-XX? | Use `plan` tool to create valid spec |
| Workers not spawning | tasks.json status | Verify tasks are "pending" not "blocked" |
| Fresh eyes slowing things | PI_FRESH_EYES_ENABLED | Set to "false" to disable |
| Worker stuck, not nudged | supervisor enabled | Verify supervisor: true |
| Context not persisting | workers/ directory | Check coordDir permissions |
| Messages not received | message-read.json | Check if already marked read |
| Agent not found | install.sh run | Verify symlinks in ~/.pi/agent/agents/coordination/ |
| Integration review slow | Single worker? | Skipped automatically for single worker |
