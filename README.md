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

## Features

- **Smart Input Routing**: Auto-detects input type (spec/plan/request) and skips unnecessary phases
- **Multi-Phase Pipeline**: Scout -> Planner -> Coordinator -> Workers -> Review -> Fixes -> Complete
- **Planner Phase**: Dedicated planning agent with self-review loop for task decomposition
- **Task Queue Model**: Priority-based task distribution with dependencies and dynamic assignment
- **Parallel Execution**: Spawn multiple workers to execute tasks simultaneously
- **Worker Self-Review**: Each worker reviews their own code before marking complete
- **Supervisor Loop**: Monitors workers for inactivity, sends nudges, restarts stuck workers
- **Discovered Tasks**: Workers can add new tasks during implementation for planner review
- **A2A Messaging**: Agent-to-agent communication for file negotiation and discovery sharing
- **Dependency Management**: Pre-assign files and create contracts between workers
- **Review Cycles**: Automated code review with fix iterations
- **Cost Controls**: Configurable cost limit with graceful shutdown
- **Async Mode**: Fire-and-forget coordination with completion notifications
- **Artifacts + Truncation**: Full prompt/output JSONL artifacts with optional output truncation
- **Checkpointing**: Save/restore at phase boundaries for resumable sessions
- **Real-time TUI**: Phase timeline, worker status, and event stream
- **Coordination Dashboard**: Full-screen `/jobs` command for monitoring async coordination
- **Coordination Logs**: Comprehensive markdown logs with executive summary
- **Full Observability**: Events, spans, causality tracking, snapshots, structured errors
- **Validation Layer**: Invariant checking, content validation, streaming warnings, markdown reports

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
    "planner": true,
    "reviewCycles": 5,
    "supervisor": true
  }
}
```

Use `false` to disable features:

```json
{
  "coordination": {
    "reviewCycles": false,
    "supervisor": { "nudgeThresholdMs": 120000 },
    "costLimit": 40
  }
}
```

Options passed to `coordinate()` override settings, which override built-in defaults.

## Usage

### Basic Usage

```typescript
coordinate({ plan: "./plan.md" })
```

With smart defaults, this runs the full pipeline: scout -> planner -> coordinator -> workers -> review -> fixes.

Defaults:
- `agents`: 4 workers
- `planner`: enabled
- `reviewCycles`: 5
- `supervisor`: enabled

### Common Configurations

```typescript
// 8 workers (reviewCycles defaults to 5)
coordinate({ plan: "./plan.md", agents: 8 })

// Custom review cycles
coordinate({ plan: "./plan.md", reviewCycles: 3 })

// Disable self-review
coordinate({ plan: "./plan.md", reviewCycles: false })

// Disable planner (manual coordinator flow)
coordinate({ plan: "./plan.md", planner: false })
```

### With All Options

```typescript
coordinate({
  plan: "./plan.md",
  mode: "request",              // "spec" | "plan" | "request" (auto-detected if omitted)
  agents: 4,                    // or ["worker", "worker", ...]
  logPath: "./logs",
  resume: "workers-1234567",
  maxFixCycles: 3,
  sameIssueLimit: 2,
  checkTests: true,
  async: false,
  maxOutput: { lines: 200 },
  costLimit: 40,                // End gracefully when cost exceeds limit (default: $40)
  validate: true,
  planner: true,                // or { humanCheckpoint: true, maxSelfReviewCycles: 3 }
  reviewCycles: 5,              // worker self-review cycles (false to disable)
  supervisor: true,             // or { nudgeThresholdMs: 180000, ... }
  // Per-phase model overrides (string sets model, object for full config)
  scout: "claude-sonnet-4-5",
  planner: { model: "claude-opus-4-5", maxSelfReviewCycles: 3 },
  coordinator: "claude-opus-4-5",
  worker: "claude-sonnet-4-5",
  reviewer: "claude-opus-4-5"
})
```

**Model Resolution**: When multiple providers offer the same model ID, resolution follows provider registration order: `openai-codex` > `github-copilot` > `openrouter`. To target a specific provider, use explicit format: `"openai-codex/gpt-5.2"` or `"openrouter/anthropic/claude-sonnet-4-5"`.

To disable logging, set `logPath: ""`.

You can also set `PI_COORDINATION_LOG_DIR` environment variable to change the default log directory.

### Smart Routing

The coordinate tool automatically detects your input type and routes appropriately:

| Input Type | Detection | Phases Run |
|------------|-----------|------------|
| **Spec** | Has `TASK-XX` + files/deps/acceptance | Coordinator → Workers → Review |
| **Plan** | Has code blocks, file paths, phases | Planner → Coordinator → Workers → Review |
| **Request** | Prose only | Scout → Questions → Planner → Full pipeline |

**Override detection:**
```typescript
coordinate({ plan: "./input.md", mode: "spec" })    // Skip scout + planner
coordinate({ plan: "./input.md", mode: "plan" })    // Skip scout only
coordinate({ plan: "./input.md", mode: "request" }) // Full pipeline with questions
```

**Clarifying questions** (request mode only):
- LLM generates in-depth design review questions
- Interactive TUI with 60s per-question timer
- Select options + "Other" text field for custom input
- Esc to skip all remaining (uses sensible defaults)
- Answers appended to PRD as `## Clarifications` section

### Example Prompt

> Execute plan.md with 4 workers

The coordinate tool will:
1. Scout analyzes codebase for context
2. Planner decomposes plan into task graph with self-review
3. Coordinator spawns workers from task queue
4. Workers execute tasks in parallel with self-review before completion
5. Supervisor monitors worker activity, nudges or restarts stuck workers
6. Code reviewer checks all changes
7. Fix workers address any issues found
8. TUI shows real-time progress
9. Final summary shows completion status

## Pipeline Phases

| Phase | Description | Skipped When |
|-------|-------------|--------------|
| **scout** | Deep codebase analysis before coordination | mode=spec, mode=plan |
| **questions** | Clarifying questions TUI for ambiguous requests | mode=spec, mode=plan |
| **planner** | Creates task graph from plan with self-review | mode=spec |
| **coordinator** | Spawns workers from task queue, manages supervisor loop | — |
| **workers** | Parallel execution of tasks with self-review | — |
| **review** | Code reviewer checks all changes against plan goals | — |
| **fixes** | Same workers fix issues found in review | — |
| **complete** | All done, generate final report | — |

Smart routing auto-detects the input type and skips unnecessary phases. Override with `mode: "spec" | "plan" | "request"`.

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

The scout outputs a structured context file for the planner with three sections:

````markdown
<meta>
<architecture>
How the codebase is organized, package structure, entry points
</architecture>

<patterns>
Code patterns to follow, naming conventions, error handling
</patterns>

<key_files>
Central files many things depend on, integration points
</key_files>

<dependencies>
What depends on what, suggested modification order
</dependencies>

<gotchas>
Things that might trip someone up, deprecated code, tight coupling
</gotchas>

<task_recommendations>
Suggested task breakdown, what to parallelize vs sequence
</task_recommendations>

<scope_constraints>
Implement EXACTLY what plan specifies, no extras
</scope_constraints>

<omitted>
Files not included due to budget (list them so planner knows they exist)
</omitted>
</meta>

<file_map>
/path/to/project
├── src
│   ├── components
│   │   ├── Button.tsx *
│   │   ├── Input.tsx * +
│   │   └── ...
│   └── index.ts +
├── package.json
└── README.md

(* = needs modification, + = contents included below)
</file_map>

<file_contents>
File: src/components/Input.tsx:1-45 (component)
```tsx
export function Input() { ... }
```

File: src/index.ts (full file - 12 lines)
```ts
export * from './components';
```
</file_contents>
````

**Token budget**: Scout targets ~30k tokens. If output exceeds budget, it's automatically split:
- `main.md` — Meta + file_map + highest priority file_contents
- `overflow.md` — Remaining file_contents (planner can read if needed)

The planner receives scout context as a direct attachment (no tool call needed). For on-demand access:
- `read_context({ path: "scout/main.md" })` - Full context
- `read_context({ path: "scout/main.md", section: "meta" })` - Scout's analysis and recommendations
- `read_context({ path: "scout/main.md", section: "file_map" })` - Just the file tree
- `read_context({ path: "scout/main.md", section: "file_contents" })` - Just file contents

## TUI Display

**Pipeline Timeline:**
```
Pipeline: [scout] -> [planner] -> [coordinator] -> [workers] -> [review] -> [fixes] -> [complete]
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
Pipeline: [scout ✓] → [planner ✓] → [workers ●] → [review] → [complete]
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

## Plan Format

Plans should be markdown with clear steps:

```markdown
# My Plan

## Step 1: Create Types
Create `src/types.ts` with the Todo interface.

## Step 2: Create Store  
Create `src/store.ts` with CRUD operations. Imports Todo from types.

## Step 3: Create Handlers
Create `src/handlers.ts` with HTTP handlers. Imports from store.
```

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
coordinate tool
    │
    ├── [Scout Phase] - Analyze codebase for context
    │
    ├── [Planner Phase] - Decompose plan into task graph
    │   ├── Receives scout context + plan
    │   ├── Self-review loop before finalizing
    │   ├── Creates tasks.json with dependencies
    │   └── Starts background review for discovered tasks
    │
    ├── [Coordinator Phase]
    │   ├── Spawns workers from task queue
    │   ├── Starts supervisor loop
    │   └── Handles worker exits and restarts
    │
    ├── [Workers Phase] - Execute in parallel
    │   ├── Claim tasks from queue
    │   ├── Self-review before completion
    │   ├── Can discover new tasks
    │   └── Signal contracts when ready
    │
    ├── [Review Phase] - Code reviewer checks changes
    │   └── Returns issues with file, line, severity
    │
    └── [Fix Phase] - Same workers fix their issues
        └── Repeat review/fix until clean or stuck
```

## Task Queue

Tasks are managed in a priority queue with dependencies:

```typescript
interface Task {
  id: string;
  description: string;
  priority: number;        // 0=critical, 1=high, 2=medium, 3=low
  status: TaskStatus;      // pending_review, pending, blocked, claimed, complete, failed, rejected
  files?: string[];
  dependsOn?: string[];
  claimedBy?: string;
  discoveredFrom?: string; // For discovered tasks
}
```

Task status flow:
- **Planner tasks**: pending -> claimed -> complete/failed
- **Discovered tasks**: pending_review -> pending -> claimed -> complete/failed (or rejected)
- **Reviewer tasks**: pending (FIX-XX) -> claimed -> complete/failed

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

Workers run a self-review pass before `complete_task` succeeds. The worker is prompted to review their changes with "fresh eyes" and fix any issues found. Only proceeds when "No issues found." is in the response.

Configuration:
- `PI_SELF_REVIEW_ENABLED`: Set to "false" to disable (default: "true")
- `PI_MAX_SELF_REVIEW_CYCLES`: Max review cycles (default: 5)
- `PI_SELF_REVIEW_SPEC_PATH`: Optional spec path to include in review prompt

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
├── tasks.json                    # Task queue
├── state.json                    # CoordinationState
├── cost.json                     # CostState
├── routing-info.json             # Smart routing decision (mode, skipped phases, clarifications)
├── events.jsonl                  # All coordination events
├── progress.md                   # Human-readable progress
├── discoveries.json              # Shared discoveries
├── a2a-read.json                 # Tracks read A2A messages per worker
├── worker-{workerId}.json        # Per-worker state files
├── nudges/                       # Supervisor -> Worker nudges
│   └── {workerId}.json
├── a2a-messages/                 # Agent-to-agent messages
│   └── {timestamp}-{id}.json
├── scout/                        # Scout outputs
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
├── coordinate/                   # Coordination runtime
│   ├── index.ts                  # coordinate() tool
│   ├── dashboard.ts              # /jobs command TUI + MiniDashboard widget
│   ├── pipeline.ts               # Multi-phase orchestration
│   ├── detection.ts              # Smart routing input type detection
│   ├── input-type-tui.ts         # Input type confirmation TUI
│   ├── question-generator.ts     # LLM clarifying question generation
│   ├── inline-questions-tui.ts   # Sequential questions TUI
│   ├── augment-prd.ts            # PRD augmentation with answers
│   ├── state.ts                  # FileBasedStorage
│   ├── task-queue.ts             # TaskQueueManager
│   ├── supervisor.ts             # Stuck worker detection
│   ├── a2a.ts                    # Agent-to-agent messaging
│   ├── nudge.ts                  # Supervisor nudge protocol
│   ├── coordinator-tools/        # Coordinator tools
│   ├── worker-tools/             # Worker tools
│   ├── phases/                   # Phase runners (scout, planner, review, fix)
│   ├── observability/            # Events, spans, causality
│   └── validation/               # Invariant checking
│
├── coord-output/                 # coord_output() tool
├── read-context/                 # read_context() tool
├── bundle-files/                 # scan_files(), bundle_files() tools
├── subagent/                     # Shared agent utilities
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
