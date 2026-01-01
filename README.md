# pi-coordination

Multi-agent coordination system for [pi](https://github.com/badlogic/pi-mono). Enables parallel plan execution with dependency management, contracts between workers, review cycles, and real-time TUI visibility.

## Features

- **Multi-Phase Pipeline**: Scout -> Coordinator -> Workers -> Review -> Fixes -> Complete
- **Parallel Execution**: Spawn multiple workers to execute plan steps simultaneously
- **Dependency Management**: Pre-assign files and create contracts between workers
- **Review Cycles**: Automated code review with fix iterations
- **Cost Controls**: Configurable warn/pause/hard thresholds
- **Checkpointing**: Save/restore at phase boundaries for resumable sessions
- **Real-time TUI**: Phase timeline, worker status, and event stream
- **Coordination Logs**: Comprehensive markdown logs with executive summary
- **Full Observability**: Events, spans, causality tracking, snapshots, structured errors

## Installation

```bash
./install.sh
```

This creates symlinks from `~/.pi/agent/` to this repo, so changes here are reflected immediately.

To uninstall:
```bash
./install.sh --uninstall
```

## Requirements

- pi (from pi-mono)
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
  logPath: "./logs",           // Save log to ./logs/coordination-log-TIMESTAMP.md
  resume: "workers-1234567",   // Resume from checkpoint ID
  maxFixCycles: 3,             // Maximum review/fix cycles (default: 3)
  sameIssueLimit: 2,           // Times same issue can recur before giving up
  reviewModel: "claude-opus-4-20250514",  // Model for code review phase
  checkTests: true,            // Whether reviewer should check for tests
  costThresholds: {
    warn: 1.0,                 // Cost threshold for warning ($)
    pause: 5.0,                // Cost threshold to pause and confirm ($)
    hard: 10.0                 // Cost threshold to abort ($)
  }
})
```

To disable logging, set `logPath: ""`.

You can also set `PI_COORDINATION_LOG_DIR` environment variable to change the default log directory.

### Example Prompt

> Execute plan.md with 4 workers

The coordinate tool will:
1. Spawn a coordinator to analyze the plan
2. Coordinator pre-assigns files and creates contracts
3. Coordinator spawns workers with detailed handshake specs
4. Workers execute in parallel, coordinating via contracts
5. Code reviewer checks all changes (when integrated)
6. Fix workers address any issues found
7. TUI shows real-time progress
8. Final summary shows completion status

## Pipeline Phases

| Phase | Description |
|-------|-------------|
| **scout** | Deep codebase analysis before coordination (provides context to workers) |
| **coordinator** | Analyzes plan, assigns files, creates contracts, spawns workers |
| **workers** | Parallel execution of plan steps |
| **review** | Code reviewer checks all changes against plan goals |
| **fixes** | Same workers fix issues found in review |
| **complete** | All done, generate final report |

## Coordinator Tools

| Tool | Description |
|------|-------------|
| `spawn_workers` | Spawn workers with specs, wait for completion |
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
| `complete_task` | Signal worker is done |
| `report_deviation` | Report deviation from plan approach |
| `read_plan` | Read the full implementation plan |
| `send_message` | Send message to another agent |
| `check_messages` | Check inbox for new messages |
| `update_step` | Update current step being worked on |
| `escalate_to_user` | Ask user a question |

## TUI Display

**Pipeline Timeline:**
```
Pipeline: [scout] -> [coordinator] -> [workers] -> [review] -> [fixes] -> [complete]
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
    ├── [Coordinator Phase]
    │   ├── Analyzes plan for dependencies
    │   ├── Pre-assigns files via assign_files()
    │   ├── Creates contracts between workers
    │   └── Spawns workers with handshake specs
    │
    ├── [Workers Phase] - Execute in parallel
    │   ├── Use coordination tools
    │   ├── Signal contracts when ready
    │   └── Report deviations if needed
    │
    ├── [Review Phase] - Code reviewer checks changes
    │   └── Returns issues with file, line, severity
    │
    └── [Fix Phase] - Same workers fix their issues
        └── Repeat review/fix until clean or stuck
```

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
- **Other**: `message_sent`, `deviation_reported`, `deviation_broadcast`, `escalation_created`, `escalation_responded`, `checkpoint_saved`

### Trace Correlation

All events and spans share a `traceId` for session-wide correlation. Workers receive the trace ID via `PI_TRACE_ID` environment variable, enabling cross-process tracing.

## Files

```
tools/
├── coordinate/              # Main coordination tool
│   ├── index.ts             # Tool entry point with TUI rendering
│   ├── pipeline.ts          # Multi-phase pipeline orchestration
│   ├── types.ts             # Type definitions
│   ├── state.ts             # FileBasedStorage for shared state
│   ├── log-generator.ts     # Coordination log generation
│   ├── progress.ts          # Progress document generation
│   ├── checkpoint.ts        # Phase-boundary checkpointing
│   ├── coordinator-tools/   # Tools available to coordinator
│   │   └── index.ts
│   ├── worker-tools/        # Tools available to workers
│   │   └── index.ts
│   ├── worker-hooks/        # Hooks for worker file reservation
│   │   └── reservation.ts
│   ├── phases/              # Phase runners
│   │   ├── scout.ts         # Scout phase (codebase analysis)
│   │   ├── review.ts        # Review phase (code-reviewer)
│   │   └── fix.ts           # Fix phase (spawn fix workers)
│   └── observability/       # Observability system
│       ├── index.ts         # ObservabilityContext (unified interface)
│       ├── types.ts         # Event, span, error type definitions
│       ├── events.ts        # EventEmitter with span stack
│       ├── spans.ts         # SpanTracer for hierarchical timing
│       ├── causality.ts     # CausalityTracker for cause-effect links
│       ├── errors.ts        # ErrorTracker for structured errors
│       ├── resources.ts     # ResourceTracker for lifecycle tracking
│       ├── snapshots.ts     # SnapshotManager for state capture
│       └── decisions.ts     # DecisionLogger for audit trails
└── subagent/                # Shared agent utilities
    ├── agents.ts            # Agent discovery and configuration
    ├── render.ts            # Result rendering utilities
    ├── runner.ts            # Agent process spawning
    └── types.ts             # Shared type definitions

agents/
├── coordinator.md           # Coordinator agent definition
└── worker.md                # Worker agent definition

skills/
└── coordination/
    └── SKILL.md             # Skill documentation
```

## License

MIT
