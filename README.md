# pi-coordination

Multi-agent coordination system for [pi](https://github.com/badlogic/pi-mono). Enables parallel plan execution with dependency management, contracts between workers, review cycles, and real-time TUI visibility.

## Features

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
- **Cost Controls**: Configurable warn/pause/hard thresholds
- **Async Mode**: Fire-and-forget coordination with completion notifications
- **Artifacts + Truncation**: Full prompt/output JSONL artifacts with optional output truncation
- **Checkpointing**: Save/restore at phase boundaries for resumable sessions
- **Real-time TUI**: Phase timeline, worker status, and event stream
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

## Usage

### Basic Usage

```typescript
coordinate({
  plan: "./plan.md",
  agents: ["worker", "worker", "worker"]
})
```

### With All Options

```typescript
coordinate({
  plan: "./plan.md",
  agents: ["worker", "worker"],
  logPath: "./logs",
  resume: "workers-1234567",
  maxFixCycles: 3,
  sameIssueLimit: 2,
  reviewModel: "claude-opus-4-20250514",
  checkTests: true,
  async: false,
  asyncResultsDir: "/tmp/pi-async-coordination-results",
  maxOutput: { lines: 200 },
  costThresholds: {
    warn: 1.0,
    pause: 5.0,
    hard: 10.0
  },
  pauseOnCostThreshold: false,
  validate: true,
  validateStream: true,
  v2: {
    selfReview: {
      enabled: true,
      maxCycles: 5
    },
    supervisor: {
      enabled: true,
      nudgeThresholdMs: 180000,
      restartThresholdMs: 300000,
      maxRestarts: 2,
      checkIntervalMs: 30000
    },
    planner: {
      enabled: true,
      humanCheckpoint: false,
      maxSelfReviewCycles: 5
    }
  }
})
```

To disable logging, set `logPath: ""`.

You can also set `PI_COORDINATION_LOG_DIR` environment variable to change the default log directory.

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

| Phase | Description |
|-------|-------------|
| **scout** | Deep codebase analysis before coordination (provides context to planner/workers) |
| **planner** | Creates task graph from plan with self-review (optional, requires v2.planner.enabled) |
| **coordinator** | Spawns workers from task queue, manages supervisor loop |
| **workers** | Parallel execution of tasks with self-review |
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

| Tool | Description |
|------|-------------|
| `reserve_files` | Reserve files for exclusive editing |
| `release_files` | Release file reservations |
| `signal_contract_complete` | Signal a contract is ready |
| `wait_for_contract` | Block until contract is ready |
| `complete_task` | Signal worker is done (triggers self-review if enabled) |
| `report_deviation` | Report deviation from plan approach |
| `read_plan` | Read the full implementation plan |
| `send_message` | Send message to another agent |
| `check_messages` | Check inbox for new messages |
| `update_step` | Update current step being worked on |
| `escalate_to_user` | Ask user a question |
| `add_discovered_task` | Add a discovered task for planner review |
| `share_discovery` | Share learnings with other workers |

## Planner Tools

| Tool | Description |
|------|-------------|
| `read_context` | Read scout context file without truncation (supports section filtering) |

## Scout Context Format

The scout outputs a structured context file for the planner with two sections:

```markdown
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

(* denotes files to be modified)
(+ denotes file contents included below)
</file_map>

<file_contents>
File: /path/to/project/src/components/Input.tsx
```tsx
export function Input() { ... }
```

File: /path/to/project/src/index.ts
```ts
export * from './components';
```
</file_contents>
```

The planner reads this context using the `read_context` tool:
- `read_context({ path: "scout/main.md" })` - Full context
- `read_context({ path: "scout/main.md", section: "file_map" })` - Just the file tree
- `read_context({ path: "scout/main.md", section: "file_contents" })` - Just file contents

## TUI Display

**Pipeline Timeline:**
```
Pipeline: [scout] -> [planner] -> [coordinator] -> [workers] -> [review] -> [fixes] -> [complete]
Current: workers
Cost: $0.45 / $5.00 pause threshold
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

## Worker Self-Review

Workers run a self-review pass before `complete_task` succeeds. The worker is prompted to review their changes with "fresh eyes" and fix any issues found. Only proceeds when "No issues found." is in the response.

Configuration:
- `PI_SELF_REVIEW_ENABLED`: Set to "false" to disable (default: "true")
- `PI_MAX_SELF_REVIEW_CYCLES`: Max review cycles (default: 5)
- `PI_SELF_REVIEW_SPEC_PATH`: Optional spec path to include in review prompt

## Supervisor

The supervisor monitors worker activity and intervenes when workers appear stuck:

- **Nudge** (3 min inactive): Sends wrap_up message to worker
- **Restart** (5 min inactive): Kills worker, releases task for retry
- **Abandon** (max restarts exceeded): Marks task as failed

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

### Event Types

- **Session**: `session_started`, `session_completed`
- **Phase**: `phase_started`, `phase_completed`
- **Worker**: `worker_spawning`, `worker_started`, `worker_completed`, `worker_failed`
- **Contract**: `contract_created`, `contract_signaled`, `contract_waiting`, `contract_received`
- **Reservation**: `reservation_requested`, `reservation_granted`, `reservation_denied`, `reservation_transferred`, `reservation_released`
- **Review**: `review_started`, `review_completed`, `fix_started`, `fix_completed`
- **Cost**: `cost_updated`, `cost_threshold_crossed`
- **Task**: `task_claimed`, `task_completed`, `task_failed`, `task_discovered`, `task_reviewed`
- **Self-Review**: `self_review_started`, `self_review_passed`, `self_review_limit_reached`
- **Supervisor**: `worker_nudged`, `worker_restarting`, `worker_abandoned`
- **A2A**: `a2a_message_sent`, `discovery_shared`

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

## Coordination Data Layout

```
coordDir/
├── tasks.json                    # Task queue
├── state.json                    # CoordinationState
├── cost.json                     # CostState
├── events.jsonl                  # All coordination events
├── progress.md                   # Human-readable progress
├── discoveries.json              # Shared discoveries
├── workers/                      # Per-worker state files
│   └── {workerId}.json
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
extensions/
└── coordination/
    ├── index.ts            # Main extension (coordinate + coord_output + async notify)
    ├── coordinator.ts      # Coordinator-only tools
    ├── worker.ts           # Worker tools + self-review hooks
    └── planner.ts          # Planner tools (read_context)

tools/
├── coord-output/           # Read full outputs from coordDir/artifacts
├── read-context/           # Read scout context without truncation
├── coordinate/             # Coordination runtime
│   ├── index.ts            # Tool entry point with TUI rendering
│   ├── async-runner.ts     # Detached async runner
│   ├── pipeline.ts         # Multi-phase pipeline orchestration
│   ├── types.ts            # Type definitions
│   ├── state.ts            # FileBasedStorage for shared state
│   ├── task-queue.ts       # TaskQueueManager for task distribution
│   ├── supervisor.ts       # Supervisor loop for stuck worker detection
│   ├── nudge.ts            # Nudge protocol for supervisor -> worker
│   ├── a2a.ts              # Agent-to-agent messaging
│   ├── log-generator.ts    # Coordination log generation
│   ├── progress.ts         # Progress document generation
│   ├── checkpoint.ts       # Phase-boundary checkpointing
│   ├── coordinator-tools/  # Coordinator tools
│   ├── worker-tools/       # Worker tools
│   ├── phases/             # Phase runners
│   │   ├── scout.ts
│   │   ├── planner.ts
│   │   ├── review.ts
│   │   └── fix.ts
│   ├── observability/      # Observability system
│   └── validation/         # Validation layer
├── validate-coord/         # Standalone validation CLI
└── subagent/               # Shared agent utilities

agents/
├── coordinator.md          # Coordinator agent definition
├── worker.md               # Worker agent definition
├── scout.md                # Scout agent definition
└── planner.md              # Planner agent definition

skills/
└── coordination/
    └── SKILL.md            # Skill documentation
```

## License

MIT
