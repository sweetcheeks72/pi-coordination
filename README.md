# pi-coordination

Multi-agent coordination for [pi](https://github.com/badlogic/pi-mono). Parallel task execution with dependencies, contracts, review cycles, and real-time visibility.

> **Ralph Wiggum on steroids** — the same single-task-per-agent pattern, scaled with parallelism and coordination. If Ralph is a solo developer with a todo list, pi-coordination is a team with a project manager, code reviewer, and task board.

## Philosophy

Agents work better focused on ONE task with fresh context, rather than juggling an entire spec at once.

A **plan** here isn't a sequential checklist — it's a **task graph**. Independent tasks run in parallel; dependent tasks wait for prerequisites. Workers continuously spawn as tasks become available, and new tasks can be discovered mid-run.

**Core pattern** (shared with Ralph Wiggum):
- **Stateless agents** — Fresh context each time, no accumulated confusion
- **Stateful files** — `tasks.json` tracks progress, survives crashes
- **One task per agent** — Focused execution, no context overload

**What we add:**
- **Parallel execution** — N workers instead of 1
- **Task graph** — Dependencies, not sequence
- **Contracts** — Cross-worker coordination for shared types/APIs
- **File reservations** — Prevent conflicts on shared files
- **Review cycles** — Dedicated quality gate after workers complete
- **Real-time monitoring** — TUI dashboard for visibility

## Two-Track Architecture

The coordination system is split into two focused tools:

```
┌─────────────────────────────────────────────────────────────┐
│                        plan tool                             │
│  Input: Prose, idea, PRD        Output: Spec file            │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐     │
│  │Interview │→ │  Scout   │→ │Elaborate │→ │Structure │     │
│  │ 60s/Q    │  │ targeted │  │ NO tools │  │ TASK-XX  │     │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘     │
└─────────────────────────────────────────────────────────────┘
                              ↓
                         spec.md
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                     coordinate tool                          │
│  Input: TASK-XX Spec            Output: Completed work       │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐     │
│  │ Validate │→ │Dispatch  │→ │ Execute  │→ │  Review  │     │
│  │ (strict) │  │(priority)│  │(workers) │  │(verify)  │     │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘     │
└─────────────────────────────────────────────────────────────┘
```

- **`plan` tool**: Converts ideas/PRDs into structured TASK-XX specs via interview + scout + LLM elaboration
- **`coordinate` tool**: Executes TASK-XX specs with parallel workers, strict validation, and review cycles

## Features

- **Two-Track Architecture**: Separate planning (interactive) from execution (automated)
- **Interactive Interview**: Multi-round questions with 60s timeout, sensible defaults
- **Targeted Scout**: Codebase analysis guided by interview findings
- **Task Queue Model**: Priority-based (P0-P3) task distribution with dependencies
- **Subtask Support**: Workers can break down complex tasks into TASK-XX.Y subtasks
- **Parallel Execution**: Spawn multiple workers to execute tasks simultaneously
- **Worker Context Persistence**: Tool events tracked across restarts for smart recovery
- **Smart Auto-Continue**: Failed workers restart with context from previous attempt
- **Supervisor Loop**: Monitors workers for inactivity, sends nudges, restarts stuck workers
- **Discovered Tasks**: Workers can add new tasks during implementation for planner review
- **A2A Messaging**: Agent-to-agent communication with read tracking and expiration
- **Dependency Graph**: Formal dependency types (blocks, parent, waits-for, discovered)
- **Review Cycles**: Automated code review with fix iterations
- **Cost Controls**: Configurable cost limit with graceful shutdown
- **Async Mode**: Fire-and-forget coordination with completion notifications
- **Full Observability**: Events, spans, decisions, causality tracking, snapshots
- **Coordination Dashboard**: Full-screen `/jobs` command for monitoring
- **Validation Layer**: Invariant checking, content validation, streaming warnings

## Installation

```bash
./install.sh
```

This creates symlinks at `~/.pi/agent/extensions/coordination` and `~/.pi/agent/agents/coordination/` so changes here are reflected immediately.

To uninstall:
```bash
./install.sh --uninstall
```

## Requirements

- pi (from pi-mono) v0.35.0+ (extensions system)
- Node.js 18+

## Settings

Default options can be configured in `~/.pi/agent/settings.json` under the `coordination` key:

```json
{
  "coordination": {
    "agents": 4,
    "reviewCycles": 5,
    "supervisor": true,
    "costLimit": 40
  }
}
```

**Plan tool settings:**
```json
{
  "coordination": {
    "plan": {
      "maxInterviewRounds": 5,
      "tokenBudget": 100000,
      "contextRatio": 0.85
    }
  }
}
```

Use `false` to disable features:

```json
{
  "coordination": {
    "reviewCycles": false,
    "supervisor": { "nudgeThresholdMs": 120000 }
  }
}
```

**Runtime configuration** (per-coordination session) can be set in `runtime-config.json` in the coordination directory:

```json
{
  "useSDKWorkers": true,
  "models": {
    "worker": "claude-sonnet-4-20250514"
  }
}
```

Or via environment variable: `PI_USE_SDK_WORKERS=1`

Options passed to `coordinate()` override settings, which override built-in defaults.

## Usage

### Two-Step Workflow

**Step 1: Create a spec with `plan`**
```typescript
plan({ input: "Add user authentication with JWT" })
```

This runs an interactive interview, scouts the codebase, and produces a TASK-XX spec file.

**Step 2: Execute with `coordinate`**
```typescript
coordinate({ plan: "./specs/auth-spec.md" })
```

This validates the spec and executes tasks with parallel workers.

### Plan Tool

```typescript
// From an idea
plan({ input: "Add user authentication with JWT" })

// From an existing PRD file
plan({ input: "./requirements/auth.md" })

// Refine an existing spec
plan({ continue: "./specs/auth-spec.md" })

// Skip interview, go straight to scout
plan({ input: "./requirements/auth.md", skipInterview: true })

// Custom output location
plan({ input: "Add auth", output: "./specs/auth-spec.md" })
```

**Plan tool phases:**
1. **Interview** — Multi-round questions (60s timeout per question)
2. **Scout** — Targeted codebase analysis based on interview findings
3. **Elaborate** — Frontier model creates detailed plan (~100K token context)
4. **Structure** — Convert to TASK-XX format with validation
5. **Handoff** — Show summary, offer execute/refine/exit

### Coordinate Tool

```typescript
// Basic execution (requires valid TASK-XX spec)
coordinate({ plan: "./spec.md" })

// 8 workers
coordinate({ plan: "./spec.md", agents: 8 })

// Custom review cycles
coordinate({ plan: "./spec.md", reviewCycles: 3 })

// Disable self-review
coordinate({ plan: "./spec.md", reviewCycles: false })

// With all options
coordinate({
  plan: "./spec.md",
  agents: 4,                    // or ["worker", "worker", ...]
  logPath: "./logs",
  resume: "workers-1234567",
  maxFixCycles: 3,
  sameIssueLimit: 2,
  checkTests: true,
  async: false,
  maxOutput: { lines: 200 },
  costLimit: 40,                // End gracefully when cost exceeds limit
  validate: true,
  reviewCycles: 5,              // worker self-review cycles (false to disable)
  supervisor: true,             // or { nudgeThresholdMs: 180000, ... }
  coordinator: "claude-opus-4-5",
  worker: "claude-sonnet-4-5",
  reviewer: "claude-opus-4-5"
})
```

**Note:** The `coordinate` tool requires a valid TASK-XX format spec. If your input isn't a valid spec, you'll get an error suggesting to use the `plan` tool first.

**Model Resolution Order**: For each phase, models are resolved in this priority:
1. Per-call parameter (e.g., `worker: "model-name"`)
2. Agent frontmatter `model:` field in `~/.pi/agent/agents/coordination/*.md`
3. Pi's global `defaultModel` from `~/.pi/agent/settings.json`

To disable logging, set `logPath: ""` or use `PI_COORDINATION_LOG_DIR` env var.

### Example Flow

> "Add authentication to the API"

```
1. plan({ input: "Add authentication to the API" })
   ├── Interview: "What auth method? OAuth, JWT, session?"
   ├── Scout: Finds existing routes, middleware patterns
   ├── Elaborate: Creates detailed implementation plan
   └── Structure: Outputs auth-spec.md with TASK-01 through TASK-05

2. coordinate({ plan: "./auth-spec.md" })
   ├── Validate: Checks TASK-XX format, dependencies
   ├── Dispatch: Assigns TASK-01 (types) first (no deps)
   ├── Workers: Execute tasks in parallel
   ├── Review: Code reviewer checks changes
   └── Complete: All tasks done, summary generated
```

## Pipeline Phases

### Plan Tool Phases

| Phase | Description |
|-------|-------------|
| **interview** | Multi-round questions (60s timeout each), gathers requirements |
| **scout** | Targeted codebase analysis based on interview findings |
| **elaborate** | Frontier model creates detailed plan (~100K context, no tools) |
| **structure** | Convert to TASK-XX format with validation |
| **handoff** | Show summary, offer execute/refine/exit (60s timeout) |

### Coordinate Tool Phases

| Phase | Description |
|-------|-------------|
| **validate** | Strict TASK-XX format validation |
| **coordinator** | Spawns workers from task queue, manages supervisor loop |
| **workers** | Parallel execution of tasks with self-review |
| **integration** | Cross-component review (API contracts, shared types, data flow) |
| **review** | Code reviewer checks all changes against plan goals |
| **fixes** | Same workers fix issues found in review |
| **complete** | All done, generate final report |

## Coordinator Tools

| Tool | Description |
|------|-------------|
| `spawn_workers` | Spawn workers with specs, wait for completion |
| `spawn_from_queue` | Spawn workers based on pending tasks from task queue |
| `get_task_queue_status` | Get status of all tasks in the queue |
| `assign_files` | Pre-assign files to workers before spawning |
| `create_contract` | Define dependencies between workers |
| `broadcast_deviation` | Notify workers when plan changes |
| `check_status` | Get status of all workers and contracts |
| `broadcast` | Send message to all workers |
| `escalate_to_user` | Ask user a question with timeout |
| `update_progress` | Update PROGRESS.md in coordination directory |
| `done` | Signal coordination complete |

## Worker Tools

### Unified API (v2)

| Tool | Description |
|------|-------------|
| `agent_chat` | All communication - messages, broadcasts, escalations, inbox |
| `agent_sync` | Contract synchronization - provide/need interfaces |
| `agent_work` | Task lifecycle - complete, step, add task, deviation, plan |
| `file_reservations` | File management - acquire, release, check reservations |

**agent_chat actions:**
- `agent_chat({ to: "worker:...", content: "..." })` - Send message
- `agent_chat({ to: "all", topic: "...", content: "...", importance: "critical" })` - Broadcast discovery
- `agent_chat({ to: "user", question: "...", options: [...] })` - Escalate to user
- `agent_chat({ action: "inbox" })` - Check messages

**agent_sync actions:**
- `agent_sync({ action: "provide", item: "...", signature: "..." })` - Signal interface ready
- `agent_sync({ action: "need", item: "..." })` - Wait for interface

**agent_work actions:**
- `agent_work({ action: "complete", result: "..." })` - Mark task done
- `agent_work({ action: "step", step: N })` - Update progress
- `agent_work({ action: "add", description: "...", reason: "..." })` - Add discovered task
- `agent_work({ action: "deviation", description: "..." })` - Report deviation
- `agent_work({ action: "plan" })` - Read full plan

**file_reservations actions:**
- `file_reservations({ action: "acquire", patterns: [...], ttl: 300 })` - Reserve files
- `file_reservations({ action: "release", patterns: [...] })` - Release files
- `file_reservations({ action: "check", path: "..." })` - Check who has file


## Planner Tools

| Tool | Description |
|------|-------------|
| `read_context` | Read scout context file without truncation (supports section filtering) |

## Scout Context Format

The targeted scout produces two outputs for the elaborate phase:

1. **contextDoc** (~85K tokens) — Raw file contents with structure
2. **metaPrompt** (~15K tokens) — Synthesized guidance combining interview + codebase analysis

### Context Document Format

````markdown
<file_map>
/path/to/project
├── src
│   ├── types.ts        * +    (* = needs modification, + = contents included)
│   ├── store.ts        * +
│   ├── routes/
│   │   ├── index.ts    * +
│   │   └── users.ts      +    (reference only)
│   └── middleware/
│       └── auth.ts       +    (pattern example)
├── tests/
│   └── users.test.ts   * +
└── package.json          +
</file_map>

<file_contents>
File: src/types.ts (full file - 45 lines)
```typescript
export interface User {
  id: string;
  email: string;
  // ...
}
```

File: src/routes/index.ts:1-30,85-120 (relevant sections)
```typescript
// Lines 1-30: Route setup
import { Router } from 'express';
// ...
```
</file_contents>
````

### Meta Prompt Format

````markdown
# Planning Guidance

## Request Summary
User wants to add JWT authentication to the Express API.
From interview: prefer httpOnly cookies, need refresh tokens.

## Architecture Analysis

### Current State
- Express 4.x with TypeScript
- Routes in src/routes/, middleware in src/middleware/
- Existing User type needs extension

### Integration Points
| What | Where | Action |
|------|-------|--------|
| Auth types | src/types.ts | Add AuthToken, Session interfaces |
| Auth middleware | src/middleware/auth.ts | Create new file |

### Patterns to Follow
- Middleware pattern: See existing `src/middleware/logging.ts`
- Route pattern: See `src/routes/users.ts`

### Dependency Order
1. Types (no deps) → TASK-01
2. JWT utils (needs types) → TASK-02, depends on TASK-01
3. Middleware → TASK-03, depends on TASK-02

### Gotchas & Warnings
- ⚠️ Don't modify existing User queries until auth is wired
- ⚠️ The existing `src/legacy/auth.js` is deprecated
````

**Token budget**: Scout targets ~100K total. The elaborate phase receives both directly in its prompt — no subsequent tool reads needed.

## TUI Display

**Pipeline Timeline:**
```
Pipeline: [scout] -> [planner] -> [coordinator] -> [workers] -> [integration] -> [review] -> [fixes] -> [complete]
Current: workers
Cost: $0.45 / $40.00 limit
```

**While Running:**
```
ok 2/4 workers
worker:04ea src/types.ts working   12s
worker:52e2 src/store.ts working   10s
---
+0.0s  [co] Spawned 4 workers
+1.2s  [04ea] write src/types.ts
+1.3s  [52e2] Creating store...
```

**When Complete:**
```
Coordination Complete (2m 34s total, $0.89)

| Worker      | Time   | Cost  | Turns | Files Modified
|-------------|--------|-------|-------|---------------
| ok worker:04ea | 45s    | $0.22 | 8     | types.ts
| ok worker:52e2 | 52s    | $0.25 | 10    | store.ts
```

## Coordination Dashboard

For async coordination jobs, use the `/jobs` command to open a full-screen dashboard:

```
─ Coordination ──────────────────────────────────────────────────────────
Pipeline: [scout ✓] → [planner ✓] → [workers ●] → [integration] → [review] → [complete]
Cost: $1.23 / $40.00 limit                             Elapsed: 3m 45s
─ Task Queue (6) ────────────────────────────────────────────────────────
● task-1    Create user types         claimed     swift_fox
○ task-2    Implement auth service    pending     deps: task-1
✓ task-3    Setup database schema     complete    calm_owl
─ Workers (4) ───────────────────────────────────────────────────────────
→ swift_fox     types.ts       ● working    1m23s   $0.45    45%
  calm_owl      store.ts       ✓ complete   2m01s   $0.38    
  bold_hawk     handlers.ts    ● working    0m45s   $0.22    32%
  keen_deer     ----           ○ waiting    0m12s   $0.00    
─ File Reservations ─────────────────────────────────────────────────────
swift_fox → types.ts, user.ts
bold_hawk → handlers.ts, routes.ts
─ Events ────────────────────────────────────────────────────────────────
+1m23s  [swift] write src/types.ts
+1m45s  [calm] completed
+2m01s  [bold] read src/handlers.ts
─ Cost Breakdown ────────────────────────────────────────────────────────
By Phase: scout $0.12 | planner $0.34 | workers $0.77

[j/k] select  [Enter] details  [w]rap up  [R]estart  [A]bort  [t]asks  [q]uit
```

Workers get memorable Docker-style names (e.g., `swift_fox`, `calm_owl`) for easy identification across the dashboard, events, and file reservations.

**Overlays:**
- **Worker Details** (Enter): Stats, files modified, recent tools, output
- **Task Queue** (t): Full task list with dependency visualization

**Keyboard Controls:**
| Key | Action |
|-----|--------|
| `j/k` or `↑/↓` | Navigate worker list |
| `Enter` | Open worker details overlay |
| `t` | Open full task queue overlay |
| `w` | Send wrap_up nudge to selected worker |
| `R` | Restart selected worker |
| `A` | Abort selected worker |
| `r` | Force refresh |
| `q` or `Esc` | Exit dashboard (shows mini footer) |
| `Q` | Exit without footer |

**Mini Footer:** After exiting with `q`, a compact status line shows in the main UI:
```
[coord] workers ● 2/4 | $1.23 | 3m45s | /jobs to open
```

## Spec Format (TASK-XX)

The `coordinate` tool requires specs in TASK-XX format:

```markdown
# Authentication Implementation

## TASK-01: Create auth types
Priority: P1
Create `src/auth/types.ts` with User, Session, and Token interfaces.

**Files:** src/auth/types.ts (create)
**Depends on:** none
**Acceptance:** Exports User, Session, Token interfaces

## TASK-02: Implement JWT utilities
Priority: P1
Create JWT signing and verification utilities.

**Files:** src/auth/jwt.ts (create)
**Depends on:** TASK-01
**Acceptance:** signToken() and verifyToken() functions work

## TASK-03: Create auth middleware
Priority: P2
Create Express middleware for route protection.

**Files:** src/middleware/auth.ts (create)
**Depends on:** TASK-02
**Acceptance:** Middleware extracts and validates JWT from cookies
```

**Required elements:**
- Task ID: `TASK-XX` or `TASK-XX.Y` (for subtasks)
- Priority: `P0` (critical) to `P3` (low)
- Files: List of files to create/modify
- Depends on: Task IDs or "none"
- Acceptance: Testable criteria

**Validation rules:**
- At least one task with no dependencies (entry point)
- No circular dependencies
- All dependency references must exist
- Valid task ID format

Use `plan({ input: "..." })` to generate valid specs from prose.

## Coordination Log

After each session, a markdown log is saved containing:

- **Executive Summary**: One-line outcome with duration, worker count, cost
- **Phase Timeline**: Table showing each phase's status, duration, and cost
- **Plan**: The original plan content
- **Workers Summary**: Table with status, duration, cost, files modified
- **Contracts**: Dependency contracts between workers
- **Event Timeline**: Chronological list of all events
- **Worker Details**: Per-worker breakdown with handshake specs
- **Review Cycles**: Issues found and fix attempts (if review ran)
- **Cost Breakdown**: By phase and by worker
- **Deviations**: Any deviations from the original plan
- **Metadata**: Token counts, coordination directory path

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                           plan tool                                  │
│                                                                     │
│  "Add auth"  ──►  Interview  ──►  Scout  ──►  Elaborate  ──►  Spec │
│                    (60s/Q)       (targeted)   (no tools)    (TASK-XX)│
└───────────────────────────────────┬─────────────────────────────────┘
                                    │
                               spec.md
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        coordinate tool                               │
│                                                                     │
│  ├── [Validate] - Strict TASK-XX format check                       │
│  │                                                                  │
│  ├── [Coordinator Phase]                                            │
│  │   ├── Spawns workers from task queue (priority-aware)            │
│  │   ├── Starts supervisor loop                                     │
│  │   └── Handles worker exits with smart auto-continue              │
│  │                                                                  │
│  ├── [Workers Phase] - Execute in parallel                          │
│  │   ├── Claim tasks from queue                                     │
│  │   ├── Context persisted to workers/<task-id>/context.md          │
│  │   ├── Self-review before completion                              │
│  │   ├── Can request subtasks (TASK-XX.Y)                           │
│  │   └── Signal contracts when ready                                │
│  │                                                                  │
│  ├── [Integration Phase] - Cross-component review                   │
│  │   └── API contracts, shared types, data flow issues              │
│  │                                                                  │
│  ├── [Review Phase] - Code reviewer checks changes                  │
│  │   └── Returns issues with file, line, severity                   │
│  │                                                                  │
│  └── [Fix Phase] - Workers fix their issues                         │
│      └── Repeat review/fix until clean or stuck                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Task Queue

Tasks are managed in a priority queue with dependencies:

```typescript
interface Task {
  id: string;
  description: string;
  priority: number;        // 0=P0 (critical), 1=P1, 2=P2, 3=P3 (low)
  status: TaskStatus;      // pending_review, pending, blocked, claimed, complete, failed, rejected
  files?: string[];
  dependsOn?: string[];
  parentTaskId?: string;   // For subtasks (TASK-XX.Y)
  blockedBy?: string[];    // Task IDs blocking this (e.g., subtasks)
  claimedBy?: string;
  discoveredFrom?: string; // For discovered tasks
}
```

Task status flow:
- **Planner tasks**: pending -> claimed -> complete/failed
- **Discovered tasks**: pending_review -> pending -> claimed -> complete/failed (or rejected)
- **Reviewer tasks**: pending (FIX-XX) -> claimed -> complete/failed
- **Subtasks**: pending -> claimed -> complete (parent unblocks when all complete)

## Subtasks

Workers can break down complex tasks into subtasks (TASK-XX.Y format):

```typescript
// Worker requests subtasks
agent_work({
  action: "subtasks",
  subtasks: [
    { title: "Create migration", description: "...", files: ["migrations/001.sql"] },
    { title: "Update queries", description: "...", files: ["src/db/users.ts"] },
  ]
})
```

**Subtask behavior:**
- Max 5 subtasks per parent
- All subtasks run in parallel (no inter-subtask dependencies)
- Parent task blocked until all subtasks complete
- Parent resumes after subtasks to finish up
- Nested subtasks not allowed by default

## Dynamic Task Pickup

Workers are spawned continuously as new tasks become available, not just at the start:

1. **Initial spawn**: Up to `maxWorkers` workers claim tasks from the queue
2. **On worker exit**: Immediately try to spawn a replacement for the next pending task
3. **Continuous polling**: Main loop checks for new tasks every 500ms
4. **Deadlock protection**: Exit after `dynamicSpawnTimeoutMs` (default: 30s) with no workers and no spawnable tasks

This enables:
- **Discovered tasks**: Workers can call `agent_work({ action: "add" })` to add tasks (creates DISC-XX, needs planner review)
- **Reviewer tasks**: Code reviewer can include `newTasks` in JSON output (creates FIX-XX, auto-approved)
- **Seamless continuation**: New tasks picked up without restarting coordination

Task ID prefixes:
- `TASK-XX`: Created by planner during initial planning
- `DISC-XX`: Discovered by workers during implementation
- `FIX-XX`: Created by code reviewer for issues found

## Worker Self-Review

Workers run a self-review pass before `agent_work({ action: "complete" })` succeeds. The worker is prompted to review their changes with "fresh eyes" and fix any issues found. Only proceeds when "No issues found." is in the response.

Configuration:
- `PI_SELF_REVIEW_ENABLED`: Set to "false" to disable (default: "true")
- `PI_MAX_SELF_REVIEW_CYCLES`: Max review cycles (default: 5)
- `PI_SELF_REVIEW_SPEC_PATH`: Optional spec path to include in review prompt

## Worker Context & Recovery

Each task maintains a persistent context file that survives worker restarts:

```
workers/TASK-03/
├── context.md         # Persistent context (auto-updated)
├── attempt-001.json   # First attempt state
└── attempt-002.json   # Second attempt state
```

**Context tracking:**
- Files modified (complete/partial/failed status)
- Discoveries made during work
- Attempt history (workers, exit codes, reasons)
- Last actions before failure
- Continuation notes for smart restarts

**Smart auto-continue:**
When a worker fails, the system automatically:
1. Loads `context.md` from previous attempt
2. Analyzes what was done and what failed
3. Builds a continuation prompt with context
4. Spawns new worker with: "Don't redo X, fix Y at line Z"

This happens at the spawn level without coordinator involvement, making simple recovery fast and efficient.

## Supervisor

The supervisor monitors worker activity and intervenes when workers appear stuck:

- **Nudge**: Sends wrap_up message after `nudgeThresholdMs` (default: 3 min)
- **Restart**: Kills worker, releases task after `restartThresholdMs` (default: 5 min)
- **Abandon**: Marks task failed after `maxRestarts` attempts (default: 2)
- **Stale Cleanup**: Releases orphaned claimed tasks after `staleTaskTimeoutMs` (default: 30 min)

Configure via `supervisor: { nudgeThresholdMs, restartThresholdMs, maxRestarts, checkIntervalMs, dynamicSpawnTimeoutMs, staleTaskTimeoutMs }`.

| Option | Default | Description |
|--------|---------|-------------|
| `nudgeThresholdMs` | 180000 | Send wrap_up after this inactivity |
| `restartThresholdMs` | 300000 | Force restart after this inactivity |
| `maxRestarts` | 2 | Max restart attempts before abandon |
| `checkIntervalMs` | 30000 | How often to check workers |
| `dynamicSpawnTimeoutMs` | 30000 | Exit spawning loop after this with no progress |
| `staleTaskTimeoutMs` | 1800000 | Release claimed tasks with no worker after this |

## SDK Worker Mode

By default, workers run as subprocesses (separate `pi` processes). SDK worker mode runs workers in-process using the Pi SDK's `createAgentSession()` API.

**Enable SDK workers:**
```json
// runtime-config.json in coordination directory
{ "useSDKWorkers": true }
```

Or via environment: `PI_USE_SDK_WORKERS=1`

**Benefits:**
- **Worker steering** — Send messages to running workers via dashboard `[i]` control
- **Direct abort** — Terminate workers immediately via dashboard `[x]` control
- **No subprocess overhead** — Workers share the coordinator's process

**Dashboard controls for SDK workers:**

| Key | Action | Description |
|-----|--------|-------------|
| `[i]` | Steer | Send a message to the worker (opens input) |
| `[x]` | Abort | Terminate the worker session immediately |
| `[w]` | Wrap up | Send wrap_up nudge (same as subprocess) |

**Note:** `[R]estart` and `[A]bort` are disabled for SDK workers because they use `process.exit()` which would crash the entire coordinator process. Use `[x]` abort instead.

**Subprocess workers** (default) still support `[w]rap up`, `[R]estart`, and `[A]bort` via the nudge system.

## Observability

The coordination system includes comprehensive observability for debugging, replay, and analysis:

### Data Captured

| Layer | File | Description |
|-------|------|-------------|
| Events | `events.jsonl` | Enhanced events with trace/span correlation |
| Spans | `traces/spans.jsonl` | Hierarchical timing (phase, worker, tool) |
| Causality | `causality.jsonl` | Cause-effect relationships between events |
| Errors | `errors.jsonl` | Structured errors with category/severity |
| Resources | `resources.jsonl` | Process/reservation lifecycle tracking |
| Snapshots | `snapshots/*.json` | Git/file/coordination state at phase boundaries |
| Decisions | `decisions.jsonl` | Decision audit trail with outcomes |

### Event Types (events.jsonl)

- **Worker**: `worker_started`, `worker_completed`, `worker_failed`
- **Tools**: `tool_call`, `tool_result`
- **Contracts**: `waiting`, `contract_received`
- **Coordinator**: `coordinator` (nudges, restarts, status messages)
- **Pipeline**: `phase_complete`
- **Cost**: `cost_milestone`, `cost_limit_reached`

### A2A Message Types (a2a-messages/)

`file_release_request`, `file_release_response`, `discovery`, `task_handoff`, `help_request`, `status_update`, `completion_notice`

### Trace Correlation

All events and spans share a `traceId` for session-wide correlation. Workers receive the trace ID via `PI_TRACE_ID` environment variable, enabling cross-process tracing.

## Validation

The validation layer provides production-grade testing of coordination sessions by checking invariants and generating reports.

### Usage

**Post-hoc validation (after coordination):**
```typescript
coordinate({
  plan: "./plan.md",
  agents: ["worker", "worker"],
  validate: true
})
```

**Real-time streaming validation:**
```typescript
coordinate({
  plan: "./plan.md",
  agents: ["worker", "worker"],
  validateStream: true
})
```

**Standalone CLI:**
```bash
validate-coord ~/.pi/sessions/default/coordination/abc123
validate-coord ./my-coord-dir --plan ./plan.md
validate-coord ./my-coord-dir --json
```

### Invariants Checked

| Invariant | Category | Description |
|-----------|----------|-------------|
| Session Lifecycle | Hard | Exactly one session_started and session_completed |
| Worker Lifecycle | Hard | All spawned workers started and completed/failed |
| Contract Fulfillment | Hard | All contracts with waiters were signaled and received |
| Cost Accounting | Soft | Costs sum correctly across phases and workers |
| Reservation Integrity | Hard | All reservations granted were released, no conflicts |
| Causality Validity | Soft | All causal links reference valid events, no cycles |
| Phase Ordering | Hard | Phases execute in correct order without overlap |
| No Orphaned Resources | Soft | All created resources were properly released |
| Content Validation | Soft | Expected files exist and have content |

## Output Retrieval (Artifacts)

Worker outputs are written to artifacts under the coordination directory. When previews are truncated, use the `coord_output` tool to fetch full output.

```typescript
coord_output({ ids: ["worker-04ea"] })
coord_output({ ids: ["scout", "review"], coordDir: "/path/to/coordDir", format: "stripped" })
```

## Async Mode

Async runs start a detached runner and return immediately. Completion is delivered via `coordination:complete` on the shared event bus and a result file in the async results directory.

- Results directory: `/tmp/pi-async-coordination-results` (override with `asyncResultsDir`)
- Durable status: `coordDir/async/status.json`
- Logs: `coordination-log-*.md` saved to `coordDir` by default in async runs

**Note:** If using the [rewind extension](https://github.com/nicobailon/pi-rewind-hook), avoid restoring files via `/branch` while async coordination is running. Workers write files concurrently; restoring mid-flight can cause inconsistent state or worker failures.

## Agent Customization

Agent prompts are defined in markdown files with YAML frontmatter:

```yaml
---
name: my-agent
description: What this agent does
model: claude-sonnet-4-20250514
tools: read, bash
system-prompt-mode: override
---

Your custom system prompt here...
```

**Frontmatter options:**
| Option | Description |
|--------|-------------|
| `name` | Agent identifier (required) |
| `description` | Human-readable description (required) |
| `model` | Model override for this agent |
| `tools` | Comma-separated tool list |
| `system-prompt-mode` | `append` (default) or `override` |

**System prompt modes:**
- `append` — Agent prompt is **added** to pi's default coding assistant prompt
- `override` — Agent prompt **replaces** pi's default prompt entirely

The coordination agents use these modes:
| Agent | Mode | Reason |
|-------|------|--------|
| coordinator | override | Manages workflow, doesn't write code |
| planner | override | Creates task graphs, no coding tools needed |
| reviewer | override | Reviews changes, only needs read/bash |
| scout | override | Analyzes codebase, specific output format |
| worker | append | Writes code, needs full coding assistant context |

## Coordination Data Layout

```
coordDir/
├── tasks.json                    # Task queue with priority and dependencies
├── state.json                    # CoordinationState
├── cost.json                     # CostState
├── deps.json                     # Dependency graph (blocks, parent, waits-for)
├── events.jsonl                  # All coordination events
├── decisions.jsonl               # Coordinator decision audit trail
├── progress.md                   # Human-readable progress
├── coordinator-context.md        # Coordinator session context
├── coordinator-context.json      # Coordinator context (JSON for parsing)
├── discoveries.json              # Shared discoveries
├── message-read.json             # Tracks read messages per worker
├── worker-{workerId}.json        # Per-worker state files
├── workers/                      # Per-task worker context
│   └── {task-id}/
│       ├── context.md            # Persistent context (survives restarts)
│       ├── attempt-001.json      # First attempt state
│       └── attempt-002.json      # Second attempt state
├── nudges/                       # Supervisor -> Worker nudges
│   └── {workerId}.json
├── messages/                     # Coordination messages (unified)
│   └── {timestamp}-{id}.json
├── reservations/                 # File reservations
├── escalation-responses/         # User escalation responses
├── artifacts/                    # Per-agent artifacts
├── checkpoints/                  # Phase checkpoints
└── traces/                       # Observability traces
```

## Files

```
extensions/coordination/           # Symlinked to ~/.pi/agent/extensions/coordination/
├── index.ts                      # Main extension entry point
├── coordinator.ts                # Coordinator-specific hooks
├── worker.ts                     # Worker hooks + self-review
├── planner.ts                    # Planner hooks (read_context)
├── scout.ts                      # Scout hooks (bundle tools)
│
├── plan/                         # Plan tool (interview -> spec)
│   ├── index.ts                  # plan() tool entry point
│   ├── interview.ts              # Multi-round interview (60s timeout)
│   ├── scout-targeted.ts         # Targeted codebase analysis
│   ├── elaborate.ts              # Frontier model elaboration
│   ├── structure.ts              # Convert to TASK-XX format
│   └── handoff.ts                # Execute/refine/exit prompt
│
├── coordinate/                   # Coordination runtime
│   ├── index.ts                  # coordinate() tool
│   ├── dashboard.ts              # /jobs command TUI + MiniDashboard widget
│   ├── pipeline.ts               # Multi-phase orchestration
│   ├── spec-parser.ts            # Parse TASK-XX format
│   ├── spec-validator.ts         # Validate spec rules
│   ├── state.ts                  # FileBasedStorage + message tracking
│   ├── task-queue.ts             # TaskQueueManager (priority-aware)
│   ├── deps.ts                   # Dependency graph module
│   ├── subtasks.ts               # Subtask creation/blocking
│   ├── worker-context.ts         # Per-task context persistence
│   ├── auto-continue.ts          # Smart restart logic
│   ├── coordinator-context.ts    # Session-level context
│   ├── supervisor.ts             # Stuck worker detection
│   ├── nudge.ts                  # Supervisor nudge protocol
│   ├── question-generator.ts     # LLM clarifying question generation
│   ├── inline-questions-tui.ts   # Sequential questions TUI
│   ├── coordinator-tools/        # Coordinator tools
│   ├── worker-tools/             # Worker tools (v2 unified API)
│   ├── phases/                   # Phase runners (review, fix)
│   ├── observability/            # Events, spans, decisions, causality
│   └── validation/               # Invariant checking
│
├── coord-output/                 # coord_output() tool
├── read-context/                 # read_context() tool
├── bundle-files/                 # scan_files(), bundle_files() tools
├── subagent/                     # Shared agent utilities + SDK runner
└── validate-coord/               # Standalone validation CLI

agents/                           # Symlinked to ~/.pi/agent/agents/coordination/
├── coordinator.md
├── worker.md
├── scout.md
├── planner.md
└── reviewer.md

skills/coordination/              # Symlinked to ~/.pi/agent/skills/coordination/
└── SKILL.md
```

## Credits

Inspired by and built on ideas from:

- **[RepoPrompt](https://repoprompt.com/)** by [@pvncher](https://x.com/pvncher) — The original scout/context bundling approach
- **[Ralph Wiggum Loop](https://ghuntley.com/ralph/)** by [@GeoffreyHuntley](https://x.com/GeoffreyHuntley) — One task per agent, fresh context each time
- **[MCP Agent Mail](https://github.com/Dicklesworthstone/mcp_agent_mail)** by [@doodlestein](https://x.com/doodlestein) — Agent-to-agent messaging and file reservations
- **[Beads](https://github.com/steveyegge/beads)** by [@Steve_Yegge](https://x.com/Steve_Yegge) — Task graph decomposition patterns
- **[pi](https://github.com/badlogic/pi-mono/)** by [@badlogicgames](https://x.com/badlogicgames) — The agent framework powering all of this

## License

MIT
