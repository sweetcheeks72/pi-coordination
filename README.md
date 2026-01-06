# pi-coordination

Multi-agent coordination system for [pi](https://github.com/badlogic/pi-mono). Enables parallel plan execution with dependency management, contracts between workers, review cycles, and real-time TUI visibility.

## Features

- **Multi-Phase Pipeline**: Scout -> Planner (V2) -> Coordinator -> Workers -> Review -> Fixes -> Complete
- **Parallel Execution**: Spawn multiple workers to execute plan steps simultaneously
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

### V2 Features (New)

- **Planner Phase**: Dedicated planning agent with Ralph self-review loop before coordination
- **Task Queue Model**: Task-based work distribution instead of step-based
- **Worker Self-Review**: Each worker reviews their own code before marking complete (Ralph Wiggum 2)
- **Supervisor Loop**: Monitors workers for inactivity, sends nudges, restarts stuck workers
- **Discovered Tasks**: Workers can add new tasks discovered during implementation
- **A2A Messaging**: Agent-to-agent file negotiation and discovery sharing
- **Dynamic File Reservation**: Workers claim files when needed, not pre-assigned

## Installation

```bash
./install.sh
```

This creates a symlink at `~/.pi/agent/extensions/coordination` to this repo, so changes here are reflected immediately.
Legacy `hooks/` and `tools/` are deprecated in pi v0.35.0+; if you have them, move or disable to avoid load errors.

To uninstall:
```bash
./install.sh --uninstall
```

## Requirements

- pi (from pi-mono) v0.35.0+ (extensions system)
- Node.js 18+

## Migration from hooks/tools (pi v0.35.0+)

pi no longer loads `hooks/` or `tools/`. Move any legacy custom tools or hooks into `extensions/` and update settings.

- **Global agent dir:** `~/.pi/agent/extensions/`
- **Project dir:** `.pi/extensions/`
- **Settings:** use `"extensions": ["path/to/ext.ts"]` instead of `hooks`/`customTools`

If you see `Tool must export a default function`, it usually means a legacy `tools/` entry is still being loaded.
Disable or remove old directories:

```bash
mv ~/.pi/agent/tools ~/.pi/agent/tools.disabled
mv ~/.pi/agent/hooks ~/.pi/agent/hooks.disabled
```

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
  async: false,                // Run coordination in background (default: false)
  asyncResultsDir: "/tmp/pi-async-coordination-results", // Override async results directory
  maxOutput: { lines: 200 },   // Truncate returned output (full output in artifacts)
  costThresholds: {
    warn: 1.0,                 // Cost threshold for warning ($)
    pause: 5.0,                // Cost threshold to pause and confirm ($)
    hard: 10.0                 // Cost threshold to abort ($)
  },
  pauseOnCostThreshold: false, // Block on pause threshold (default: false)
  validate: true,              // Run validation after completion
  validateStream: true,        // Stream invariant warnings in real-time
  // V2 Options
  v2: {
    selfReview: {
      enabled: true,           // Worker self-review loop (default: true)
      maxCycles: 5             // Max self-review cycles (default: 5)
    },
    supervisor: {
      enabled: true,           // Supervisor loop (default: true)
      nudgeThresholdMs: 180000,  // 3 min inactivity before nudge
      restartThresholdMs: 300000, // 5 min before restart
      maxRestarts: 2           // Max restart attempts
    },
    planner: {
      enabled: true,           // Enable planner phase
      humanCheckpoint: false,  // Pause for human approval
      maxSelfReviewCycles: 5   // Planner self-review cycles
    }
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
| **scout** | Deep codebase analysis before coordination (provides context to planner/workers) |
| **planner** (V2) | Creates task graph from plan with Ralph self-review (optional, requires v2.planner.enabled) |
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
| `spawn_from_queue` (V2) | Spawn workers based on pending tasks from task queue |
| `get_task_queue_status` (V2) | Get status of all tasks in the queue |

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
| `add_discovered_task` (V2) | Add a discovered task for planner review |
| `share_discovery` (V2) | Share learnings with other workers |

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

## Validation

The validation layer provides production-grade testing of coordination sessions by checking invariants and generating reports.

### Usage

**Post-hoc validation (after coordination):**
```typescript
coordinate({
  plan: "./plan.md",
  agents: ["worker", "worker"],
  validate: true  // Run full validation after completion
})
```

**Real-time streaming validation:**
```typescript
coordinate({
  plan: "./plan.md",
  agents: ["worker", "worker"],
  validateStream: true  // Stream warnings during execution
})
```

**Standalone CLI:**
```bash
# Validate an existing coordination session
validate-coord ~/.pi/sessions/default/coordination/abc123

# With plan for semantic validation
validate-coord ./my-coord-dir --plan ./plan.md

# Output as JSON
validate-coord ./my-coord-dir --json
```

## Output Retrieval (Artifacts)

Worker outputs are written to artifacts under the coordination directory. When previews are truncated, use the `coord_output` tool to fetch full output.

```typescript
coord_output({ ids: ["worker-04ea"] })
```

Optional: specify a coordination directory or output format.

```typescript
coord_output({ ids: ["scout", "review"], coordDir: "/path/to/coordDir", format: "stripped" })
```

## Async Mode

Async runs start a detached runner and return immediately. Completion is delivered via `coordination:complete` on the shared event bus and a result file in the async results directory.

- Results directory: `/tmp/pi-async-coordination-results` (override with `asyncResultsDir`)
- Durable status: `coordDir/async/status.json`
- Logs: `coordination-log-*.md` saved to `coordDir` by default in async runs

## File IPC (Shared Context)

Coordination sessions create:
- `coordDir/inputs/` for large input lists
- `coordDir/outputs/` for worker primary outputs
- `coordDir/shared-context.md` for shared prompt/context

Coordinators can reference these paths instead of copying large content into prompts.

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

**Strictness levels:**
- `fatal-all`: Fail on any invariant violation
- `warn-soft-fatal-hard`: Warn on soft, fail on hard (default)
- `advisory`: Report only, never fail

### Streaming Validation

When `validateStream: true`, real-time checks run during coordination:

```
[VALIDATION WARNING] Worker Lifecycle: Worker abc123 spawned 30s ago but never started
[VALIDATION WARNING] Contract Fulfillment: worker-B waiting for contract user-type for 60s
[VALIDATION ERROR] Phase Ordering: Phase workers started before coordinator completed
```

### Validation Report

After validation, a markdown report is saved to `{coordDir}/validation-report.md`:

```markdown
# Validation Report

**Result:** PASS

## Invariant Checks

| Invariant | Category | Result | Details |
|-----------|----------|--------|---------|
| Session Lifecycle | hard | PASS | - |
| Worker Lifecycle | hard | PASS | - |
...

## Coordinator Judgment

**Passed:** Yes
**Confidence:** medium

## Session Statistics

- **Duration:** 45.2s
- **Total Cost:** $0.89
- **Workers:** 3/3 completed
```

## Files

```
extensions/
└── coordination/
    ├── index.ts            # Main extension (coordinate + coord_output + async notify)
    ├── coordinator.ts      # Coordinator-only tools
    └── worker.ts           # Worker tools + reservation handlers

tools/
├── coord-output/           # Read full outputs from coordDir/artifacts
├── coordinate/              # Coordination runtime
│   ├── index.ts             # Tool entry point with TUI rendering
│   ├── async-runner.ts       # Detached async runner (writes async status/result)
│   ├── pipeline.ts          # Multi-phase pipeline orchestration
│   ├── types.ts             # Type definitions
│   ├── state.ts             # FileBasedStorage for shared state
│   ├── log-generator.ts     # Coordination log generation
│   ├── progress.ts          # Progress document generation
│   ├── checkpoint.ts        # Phase-boundary checkpointing
│   ├── coordinator-tools/   # Coordinator tools (registered by extension)
│   │   └── index.ts
│   ├── worker-tools/        # Worker tools + reservation logic (registered by extension)
│   │   └── index.ts
│   ├── phases/              # Phase runners
│   │   ├── scout.ts         # Scout phase (codebase analysis)
│   │   ├── review.ts        # Review phase (code-reviewer)
│   │   └── fix.ts           # Fix phase (spawn fix workers)
│   ├── observability/       # Observability system
│   │   ├── index.ts         # ObservabilityContext (unified interface)
│   │   ├── types.ts         # Event, span, error type definitions
│   │   ├── events.ts        # EventEmitter with span stack and listeners
│   │   ├── spans.ts         # SpanTracer for hierarchical timing
│   │   ├── causality.ts     # CausalityTracker for cause-effect links
│   │   ├── errors.ts        # ErrorTracker for structured errors
│   │   ├── resources.ts     # ResourceTracker for lifecycle tracking
│   │   ├── llm.ts           # LLM interaction logger (requires upstream emitters)
│   │   ├── snapshots.ts     # SnapshotManager for state capture
│   │   └── decisions.ts     # DecisionLogger for audit trails
│   └── validation/          # Validation layer
│       ├── index.ts         # Main exports
│       ├── types.ts         # Validation type definitions
│       ├── loader.ts        # Load observability data from coordDir
│       ├── orchestrator.ts  # Main validation orchestrator
│       ├── streaming.ts     # Real-time streaming validator
│       ├── judge.ts         # Coordinator-as-judge for semantic validation
│       ├── report.ts        # Markdown report generator
│       ├── content.ts       # File content validation
│       ├── invariants/      # Invariant checkers
│       │   ├── index.ts     # All invariants registry
│       │   ├── session.ts   # Session lifecycle
│       │   ├── workers.ts   # Worker lifecycle
│       │   ├── contracts.ts # Contract fulfillment
│       │   ├── costs.ts     # Cost accounting
│       │   ├── reservations.ts # Reservation integrity
│       │   ├── causality.ts # Causality validity
│       │   ├── phases.ts    # Phase ordering
│       │   └── resources.ts # No orphaned resources
│       └── fixtures/        # Test fixtures
│           ├── minimal/     # Single worker, no deps
│           ├── diamond/     # Diamond dependency pattern
│           ├── conflict/    # File conflict scenario
│           └── failure/     # Deliberate failure scenario
├── validate-coord/          # Standalone validation CLI
│   └── index.ts
└── subagent/                # Shared agent utilities
    ├── agents.ts            # Agent discovery and configuration
    ├── render.ts            # Result rendering utilities
    ├── runner.ts            # Agent process spawning
    ├── artifacts.ts         # Artifact path helpers
    ├── truncate.ts          # Output truncation helpers
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
