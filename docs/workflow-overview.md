# Pi Coordination Workflow Overview

This document describes the architecture and workflows of pi-coordination:

- Planner phase with embedded self-review
- Task queue model for work distribution
- Worker self-review loop
- Supervisor for stuck worker intervention
- A2A (Agent-to-Agent) messaging
- Discovered task workflow

---

## Architecture Overview

```
+=====================================================================================+
||                           PI-COORDINATION ARCHITECTURE                            ||
+=====================================================================================+
|                                                                                     |
|   User invokes:  coordinate({ plan: "./plan.md", agents: ["worker"],               |
|                              v2: { planner: { enabled: true }, ... } })             |
|                                                                                     |
|   +-------------------------------------------------------------------------+       |
|   |                        Coordinate Tool (index.ts)                       |       |
|   |                                                                         |       |
|   |  - Reads plan file                                                      |       |
|   |  - Initializes FileBasedStorage + TaskQueueManager                      |       |
|   |  - Creates ObservabilityContext                                         |       |
|   |  - Runs pipeline phases                                                 |       |
|   +-------------------------------------------------------------------------+       |
|                                      |                                              |
|                                      v                                              |
|   +-------------------------------------------------------------------------+       |
|   |                           Pipeline Phases                               |       |
|   |                                                                         |       |
|   |  scout --> planner --> coordinator --> workers --> review --> fixes     |       |
|   |              |              |             |                             |       |
|   |              |              |             +---> self-review loop        |       |
|   |              |              +---> spawns from task queue                |       |
|   |              +---> generates tasks.json + background review             |       |
|   +-------------------------------------------------------------------------+       |
|                                      |                                              |
|                                      v                                              |
|   +----------------------------------+--------------------------------------+       |
|   |          Planner Agent           |           Worker Agents              |       |
|   |  (coordination/planner)          |    (coordination/worker)             |       |
|   |                                  |                                      |       |
|   |  - Receives: PRD + scout context |  Tools:                              |       |
|   |  - Outputs: Task graph (JSON)    |  - complete_task (with self-review) |       |
|   |  - Embedded self-review          |  - add_discovered_task              |       |
|   |  - Background discovered task    |  - share_discovery                  |       |
|   |    review loop                   |  - reserve_files / release_files    |       |
|   +----------------------------------+  - wait_for_contract                |       |
|                                      |  - signal_contract_complete         |       |
|   +----------------------------------+  - send_message / check_messages    |       |
|   |          Coordinator Agent       +--------------------------------------+       |
|   |  (coordination/coordinator)      |                                      |       |
|   |                                  |                                      |       |
|   |  Tools:                          |                                      |       |
|   |  - spawn_from_queue              |          Supervisor Loop             |       |
|   |  - get_task_queue_status         |  - Monitors worker activity          |       |
|   |  - check_status                  |  - Nudges inactive workers           |       |
|   |  - broadcast                     |  - Restarts stuck workers            |       |
|   |  - done                          |  - Abandons after max restarts       |       |
|   +----------------------------------+--------------------------------------+       |
|                                      |                                              |
|                                      v                                              |
|   +-------------------------------------------------------------------------+       |
|   |                         Shared State                                    |       |
|   |                                                                         |       |
|   |  - tasks.json (task queue)        - progress.md (shared memory)         |       |
|   |  - state.json (coordination)      - nudges/ (supervisor -> worker)      |       |
|   |  - workers/*.json (per-worker)    - a2a-messages/ (agent-to-agent)      |       |
|   |  - discoveries.json               - events.jsonl                        |       |
|   +-------------------------------------------------------------------------+       |
|                                                                                     |
+=====================================================================================+
```

---

## Pipeline Phase Flow

```
                                  +--------+
                                  | Start  |
                                  +--------+
                                      |
                                      v
+-------------------------------------------------------------------------------+
|                              SCOUT PHASE                                      |
|  Agent: coordination/scout                                                    |
|  - Analyzes codebase with PLANNER focus (not worker focus)                    |
|  - Produces structured context with <file_map> and <file_contents>            |
|  - Token-budgeted output (~30K tokens target)                                 |
|  - Output: scout/main.md with file tree and full file contents                |
+-------------------------------------------------------------------------------+
                                      |
                                      v
+-------------------------------------------------------------------------------+
|                              PLANNER PHASE                                    |
|  Agent: coordination/planner                                                  |
|  - Uses read_context tool to read scout context without truncation            |
|  - Generates task graph as JSON with embedded self-review                     |
|  - Creates tasks.json with all tasks in "pending" status                      |
|  - Starts background review loop for discovered tasks                         |
|  - Output: tasks.json                                                         |
+-------------------------------------------------------------------------------+
                                      |
                                      v
+-------------------------------------------------------------------------------+
|                           COORDINATOR PHASE                                   |
|  Agent: coordination/coordinator                                              |
|  - Uses spawn_from_queue to spawn workers per-task                            |
|  - Supervisor loop monitors all workers                                       |
|  - Waits for all workers to complete                                          |
|  - Handles restarts for exit code 42                                          |
+-------------------------------------------------------------------------------+
                                      |
                                      v
+-------------------------------------------------------------------------------+
|                            WORKERS PHASE                                      |
|  Agent: coordination/worker (one per task)                                    |
|  - Each worker receives single task in handshakeSpec                          |
|  - Self-review loop before complete_task succeeds                             |
|  - Can discover new tasks (pending_review status)                             |
|  - Can share discoveries with other workers                                   |
|  - Responds to supervisor nudges                                              |
+-------------------------------------------------------------------------------+
                                      |
                                      v
+-------------------------------------------------------------------------------+
|                            REVIEW PHASE                                       |
|  - code-reviewer analyzes all changes                                         |
|  - Returns issues or allPassing: true                                         |
+-------------------------------------------------------------------------------+
                                      |
                          +-----------+-----------+
                          |                       |
                          v                       v
                    [allPassing]            [has issues]
                          |                       |
                          v                       v
                    +---------+           +---------------+
                    |  DONE   |           |  FIX PHASE    |
                    +---------+           +---------------+
```

---

## Scout Context Format

The scout outputs a structured context file with two sections:

### Output Structure

```markdown
<file_map>
/path/to/project
├── src
│   ├── components
│   │   ├── Button.tsx *
│   │   ├── Input.tsx * +
│   │   └── ...
│   ├── utils
│   │   └── helpers.ts +
│   └── index.ts * +
├── package.json
└── README.md

(* denotes files to be modified based on the plan)
(+ denotes file contents included below)
</file_map>

<file_contents>
File: /path/to/project/src/components/Input.tsx
```tsx
export function Input() { ... }
```

File: /path/to/project/src/utils/helpers.ts
```ts
export function helper() { ... }
```
</file_contents>
```

### File Markers

| Marker | Meaning |
|--------|---------|
| `*` | File will need modification based on the plan |
| `+` | Full file contents included in `<file_contents>` |

### Planner Tool: read_context

The planner uses `read_context` to read scout context without truncation:

```typescript
read_context({ path: "scout/main.md" })                          // Full context
read_context({ path: "scout/main.md", section: "file_map" })     // Just file tree
read_context({ path: "scout/main.md", section: "file_contents" }) // Just contents
```

---

## Task Queue Model

### tasks.json Schema

```typescript
interface TaskQueue {
  version: "2.0";
  planPath: string;
  planHash: string;
  createdAt: number;
  tasks: Task[];
}

interface Task {
  id: string;                    // e.g., "TASK-01"
  description: string;
  priority: number;              // 0=critical, 1=high, 2=medium, 3=low
  status: TaskStatus;
  files?: string[];              // Files to modify
  creates?: string[];            // New files to create
  dependsOn?: string[];          // Task IDs this depends on
  acceptanceCriteria?: string[];
  
  // Claiming
  claimedBy?: string;            // Worker identity
  claimedAt?: number;
  
  // Completion
  completedAt?: number;
  completedBy?: string;
  
  // Failure handling
  restartCount?: number;
  failureReason?: string;
  
  // Discovered tasks only
  discoveredFrom?: string;       // Task ID that discovered this
  reviewed?: boolean;
  reviewedAt?: number;
  reviewResult?: "ok" | "modified" | "rejected";
  reviewNotes?: string;
}

type TaskStatus =
  | "pending_review"  // Discovered by worker, awaiting planner review
  | "pending"         // Available to claim
  | "blocked"         // Dependencies not met (computed)
  | "claimed"         // Worker is working on it
  | "complete"        // Successfully done
  | "failed"          // Failed after max retries
  | "rejected";       // Rejected by planner (discovered tasks only)
```

### Task Status Flow

```
PLANNER-GENERATED TASKS:

  pending ──────> claimed ──────> complete
      │               │
      │               └──────> failed
      │
      └──> blocked (computed from dependsOn)


WORKER-DISCOVERED TASKS:

  pending_review ──> pending ──> claimed ──> complete
         │              │           │
         │              │           └──> failed
         │              │
         │              └──> blocked
         │
         └──> rejected (by planner)
```

### Task Queue Operations

```
+------------------------------------------------------------------+
|                    TASK QUEUE OPERATIONS                         |
|                    (TaskQueueManager class)                      |
+------------------------------------------------------------------+

  getNextTask()
  ┌─────────────────────────────────────────────────────────────┐
  │ 1. Acquire lock on tasks.json                               │
  │ 2. Find highest priority task where:                        │
  │    - status === "pending" (NOT pending_review)              │
  │    - all dependsOn tasks are "complete"                     │
  │ 3. Return task (does NOT claim - separate operation)        │
  │ 4. Release lock                                             │
  └─────────────────────────────────────────────────────────────┘

  claimTask(taskId, claimedBy)
  ┌─────────────────────────────────────────────────────────────┐
  │ 1. Acquire lock                                             │
  │ 2. Verify task.status === "pending"                         │
  │ 3. Set status = "claimed", claimedBy, claimedAt             │
  │ 4. Release lock                                             │
  │ 5. Return task (or null if already claimed)                 │
  └─────────────────────────────────────────────────────────────┘

  markTaskComplete(taskId, completedBy)
  ┌─────────────────────────────────────────────────────────────┐
  │ 1. Set status = "complete", completedAt, completedBy        │
  │ 2. Update blocked tasks (deps now met -> pending)           │
  └─────────────────────────────────────────────────────────────┘

  markTaskFailed(taskId, reason, maxRestarts=2)
  ┌─────────────────────────────────────────────────────────────┐
  │ 1. Increment restartCount                                   │
  │ 2. If restartCount >= maxRestarts: status = "failed"        │
  │ 3. Else: status = "pending" (available for retry)           │
  │ 4. Return whether retry is possible                         │
  └─────────────────────────────────────────────────────────────┘

  releaseTask(taskId)
  ┌─────────────────────────────────────────────────────────────┐
  │ Reset to pending, clear claimedBy/claimedAt                 │
  │ (Used when worker stuck or killed)                          │
  └─────────────────────────────────────────────────────────────┘

  addDiscoveredTask(task)
  ┌─────────────────────────────────────────────────────────────┐
  │ Add task with status = "pending_review"                     │
  │ Not claimable until planner approves                        │
  └─────────────────────────────────────────────────────────────┘

  approveTask(taskId, modifications?)
  ┌─────────────────────────────────────────────────────────────┐
  │ Change status from pending_review to pending                │
  │ Optionally apply modifications from planner                 │
  └─────────────────────────────────────────────────────────────┘

  rejectTask(taskId, reason)
  ┌─────────────────────────────────────────────────────────────┐
  │ Set status = "rejected", record reason                      │
  └─────────────────────────────────────────────────────────────┘
```

---

## Worker Self-Review Loop

The self-review loop ensures workers review their own code before completion.

### Flow

```
+===============================================================================+
||                         WORKER SELF-REVIEW LOOP                             ||
+===============================================================================+

  Worker implements task
          |
          v
  Worker calls complete_task()
          |
          v
  ┌─────────────────────────────────────┐
  │ tool_call handler intercepts        │
  │ - Stores pendingCompletion          │
  │ - Returns { block: true }           │
  └─────────────────────────────────────┘
          |
          v
  agent_end fires
          |
          v
  ┌─────────────────────────────────────┐
  │ Check for "No issues found."        │
  └─────────────────────────────────────┘
          |
     ┌────┴────┐
     |         |
     v         v
 [Found]   [Not found]
     |         |
     v         v
 ┌───────┐  ┌─────────────────────────┐
 │ PASS  │  │ count >= maxCycles?     │
 │       │  └─────────────────────────┘
 │       │         |
 │       │    ┌────┴────┐
 │       │    |         |
 │       │    v         v
 │       │  [Yes]     [No]
 │       │    |         |
 │       │    v         v
 │       │  PASS    ┌───────────────────┐
 │       │  (limit) │ Inject self-review│
 │       │          │ prompt, count++   │
 │       │          └───────────────────┘
 │       │                  |
 │       │                  v
 │       │          Agent reviews code
 │       │                  |
 │       │                  v
 │       │          agent_end fires again
 │       │                  |
 │       │                  +──> [Back to check]
 └───────┘
     |
     v
  pi.sendMessage("Now call complete_task()...")
          |
          v
  complete_task() succeeds (selfReview.passed = true)
```

### Self-Review Prompt

```
Great, now I want you to carefully read over all of the new code you just wrote
and other existing code you just modified with "fresh eyes," looking super
carefully for any obvious bugs, errors, problems, issues, confusion, etc.

[If PI_SELF_REVIEW_SPEC_PATH is set]:
Make sure you re-read the spec before you review:
<spec_path>

If any issues are found, proceed to fix them without being asked to do so.
If no issues are found then your response MUST contain these exact words:
"No issues found."
```

### Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `PI_SELF_REVIEW_ENABLED` | `"true"` | Set to `"false"` to disable |
| `PI_MAX_SELF_REVIEW_CYCLES` | `5` | Max review cycles before proceeding |
| `PI_SELF_REVIEW_SPEC_PATH` | (none) | Optional spec path to include in prompt |

---

## Supervisor Loop

The supervisor monitors workers and intervenes when they appear stuck.

### Architecture

```
+===============================================================================+
||                            SUPERVISOR LOOP                                  ||
+===============================================================================+

  SupervisorLoop starts with worker handles
          |
          v
  ┌─────────────────────────────────────┐
  │ setInterval(checkAllWorkers, 30s)   │
  └─────────────────────────────────────┘
          |
          v
  For each tracked worker:
          |
          v
  ┌─────────────────────────────────────┐
  │ 1. Check if process still alive     │
  │    - If dead, remove from tracking  │
  │                                     │
  │ 2. Check worker state file mtime    │
  │    - If modified, update activity   │
  │                                     │
  │ 3. Calculate inactiveMs             │
  └─────────────────────────────────────┘
          |
          v
  ┌─────────────────────────────────────────────────────────────┐
  │                                                             │
  │  inactiveMs >= restartThresholdMs (5 min)?                  │
  │      |                                                      │
  │      YES ──> handleStuckWorker()                            │
  │              - restartCount++                               │
  │              - If > maxRestarts: abandonWorker()            │
  │              - Else: send "restart" nudge, kill, release    │
  │                                                             │
  │  inactiveMs >= nudgeThresholdMs (3 min) && not nudged?      │
  │      |                                                      │
  │      YES ──> nudgeWorker()                                  │
  │              - Send "wrap_up" nudge                         │
  │              - Worker receives on next turn_start           │
  │                                                             │
  └─────────────────────────────────────────────────────────────┘
```

### Nudge Protocol

```
Supervisor                    Nudge Files                     Worker
    |                             |                              |
    | sendNudge(workerId, {       |                              |
    |   type: "wrap_up",          |                              |
    |   message: "...",           |                              |
    |   timestamp: ...            |                              |
    | })                          |                              |
    |                             |                              |
    +-----> nudges/{workerId}.json                               |
                                  |                              |
                                  |      turn_start fires        |
                                  |<-----------------------------+
                                  |                              |
                                  +----> consumeNudgeSync()      |
                                        (reads and deletes)      |
                                              |                  |
                                              v                  |
                                  ┌─────────────────────────┐    |
                                  │ type === "wrap_up"      │    |
                                  │   -> inject message     │    |
                                  │                         │    |
                                  │ type === "restart"      │    |
                                  │   -> process.exit(42)   │    |
                                  │                         │    |
                                  │ type === "abort"        │    |
                                  │   -> process.exit(1)    │    |
                                  └─────────────────────────┘    |
```

### Supervisor Configuration

| Config | Default | Description |
|--------|---------|-------------|
| `nudgeThresholdMs` | 180000 (3 min) | Time before sending wrap_up nudge |
| `restartThresholdMs` | 300000 (5 min) | Time before forcing restart |
| `maxRestarts` | 2 | Restarts before abandoning task |
| `checkIntervalMs` | 30000 (30s) | How often to check workers |

---

## A2A (Agent-to-Agent) Messaging

Workers can communicate directly via filesystem-based messaging.

### Message Types

```typescript
type A2APayload =
  | { type: "file_release_request"; file: string; reason: string; urgency: "low" | "medium" | "high" }
  | { type: "file_release_response"; file: string; granted: boolean; eta?: number; reason?: string }
  | { type: "discovery"; topic: string; content: string; importance: "fyi" | "important" | "critical" }
  | { type: "task_handoff"; taskId: string; reason: string; context: string }
  | { type: "help_request"; taskId: string; blocker: string; needsFrom?: string }
  | { type: "status_update"; taskId: string; progress: number; eta?: number }
  | { type: "completion_notice"; taskId: string; filesModified: string[] };

interface A2AMessage {
  id: string;
  from: string;           // Worker identity
  to: string | "all";     // Recipient or broadcast
  timestamp: number;
  type: A2AMessageType;
  payload: A2APayload;
  inReplyTo?: string;     // For request/response correlation
}
```

### Message Flow

```
Worker A                      a2a-messages/                    Worker B
    |                              |                               |
    | sendMessage(to: "all", {     |                               |
    |   type: "discovery",         |                               |
    |   topic: "Found pattern",    |                               |
    |   content: "...",            |                               |
    |   importance: "important"    |                               |
    | })                           |                               |
    |                              |                               |
    +-----> {timestamp}-{id}.json  |                               |
                                   |                               |
                                   |       turn_start              |
                                   |<------------------------------+
                                   |                               |
                                   +----> checkMessagesSync()      |
                                         (filters by to: "all")    |
                                               |                   |
                                               v                   |
                                   ┌─────────────────────────┐     |
                                   │ Display to worker:      │     |
                                   │ "[Worker A] shared      │     |
                                   │  [IMPORTANT]: Found..." │     |
                                   └─────────────────────────┘     |
                                               |                   |
                                               +----> markRead()   |
```

---

## Discovered Task Workflow

Workers can discover new tasks during implementation.

### Flow

```
+===============================================================================+
||                      DISCOVERED TASK WORKFLOW                               ||
+===============================================================================+

  Worker discovers new work needed
          |
          v
  add_discovered_task({
    id: "TASK-DISC-01",
    description: "Handle null case",
    priority: 2,
    files: ["src/store.ts"],
    reason: "getUser crashes if ID not found"
  })
          |
          v
  ┌─────────────────────────────────────┐
  │ Task added to queue with            │
  │ status: "pending_review"            │
  │ discoveredFrom: <current_task_id>   │
  │                                     │
  │ NOT CLAIMABLE YET                   │
  └─────────────────────────────────────┘
          |
          v
  ┌─────────────────────────────────────┐
  │ Planner Background Review Loop      │
  │ (runs every 5 seconds)              │
  │                                     │
  │ getTasksForReview() -> tasks        │
  │                                     │
  │ For each pending_review task:       │
  │   - Is it within scope?             │
  │   - Is it duplicated?               │
  │   - Does it conflict with files?    │
  │   - Are dependencies correct?       │
  └─────────────────────────────────────┘
          |
     ┌────┴────────────┐
     |                 |
     v                 v
 [Approve]         [Reject]
     |                 |
     v                 v
 status:           status:
 "pending"         "rejected"
 (now claimable)   reviewNotes: "reason"
```

---

## Spawn From Queue Flow

```
spawn_from_queue({ maxWorkers: 3 })
          |
          v
  ┌─────────────────────────────────────┐
  │ While handles.length < maxWorkers:  │
  │   1. getNextTask() from queue       │
  │   2. claimTask() atomically         │
  │   3. Build handshakeSpec with task  │
  │   4. spawnWorkerProcess()           │
  │   5. Add handle to list             │
  └─────────────────────────────────────┘
          |
          v
  ┌─────────────────────────────────────┐
  │ Start SupervisorLoop with handles   │
  └─────────────────────────────────────┘
          |
          v
  ┌─────────────────────────────────────┐
  │ For each worker exit:               │
  │                                     │
  │   exit 0:                           │
  │     markTaskComplete()              │
  │                                     │
  │   exit 42:                          │
  │     releaseTask()                   │
  │     spawn replacement (if retries   │
  │     remaining)                      │
  │                                     │
  │   other:                            │
  │     markTaskFailed()                │
  └─────────────────────────────────────┘
          |
          v
  ┌─────────────────────────────────────┐
  │ Wait until all workers done         │
  │ (activeHandles.size === 0)          │
  └─────────────────────────────────────┘
          |
          v
  Stop supervisor, return results
```

---

## Agent Organization

Subdirectory-based agent naming avoids conflicts with generic agents.

### Structure

```
~/.pi/agent/agents/
├── coordination/                    <- Symlinks to pi-coordination/agents/
│   ├── coordinator.md              <- coordination/coordinator
│   ├── worker.md                   <- coordination/worker
│   ├── scout.md                    <- coordination/scout
│   └── planner.md                  <- coordination/planner
├── worker.md                        <- Generic worker (unchanged)
└── scout.md                         <- Generic scout (unchanged)
```

---

## Configuration

### coordinate() Options

```typescript
coordinate({
  plan: "./plan.md",
  agents: ["worker"],
  
  v2: {
    selfReview: {
      enabled: true,           // Enable worker self-review
      maxCycles: 5             // Max review cycles
    },
    supervisor: {
      enabled: true,           // Enable supervisor loop
      nudgeThresholdMs: 180000,    // 3 minutes
      restartThresholdMs: 300000,  // 5 minutes
      maxRestarts: 2,
      checkIntervalMs: 30000       // 30 seconds
    },
    planner: {
      enabled: true,           // Enable planner phase
      humanCheckpoint: false,  // Pause for approval
      maxSelfReviewCycles: 5   // Planner self-review cycles
    }
  }
})
```

### Environment Variables

| Variable | Set By | Used By | Description |
|----------|--------|---------|-------------|
| `PI_COORDINATION_DIR` | Coordinate tool | All | Path to coordination directory |
| `PI_WORKER_ID` | Coordinator | Worker | Worker UUID |
| `PI_AGENT_IDENTITY` | Coordinator | Worker | Worker identity string |
| `PI_SELF_REVIEW_ENABLED` | Coordinate tool | Worker | Enable self-review loop |
| `PI_MAX_SELF_REVIEW_CYCLES` | Coordinate tool | Worker | Max self-review cycles |
| `PI_SELF_REVIEW_SPEC_PATH` | User | Worker | Spec path to include in review prompt |
| `PI_TRACE_ID` | Coordinate tool | All | Trace ID for observability |

---

## Coordination Data Layout

```
coordDir/
├── tasks.json                    # Task queue
├── state.json                    # CoordinationState
├── cost.json                     # CostState
├── events.jsonl                  # All coordination events
├── progress.md                   # Human-readable progress
├── discoveries.json              # Shared discoveries
│
├── workers/                      # Per-worker state files
│   └── {workerId}.json
│
├── nudges/                       # Supervisor -> Worker nudges
│   └── {workerId}.json           # Consumed on read
│
├── a2a-messages/                 # Agent-to-agent messages
│   └── {timestamp}-{id}.json
│
├── scout/                        # Scout outputs
│   ├── main.md
│   └── files/
│
├── artifacts/                    # Per-agent artifacts
│   ├── planner-*/
│   ├── planner-review-*/
│   ├── coordinator-*/
│   ├── scout-*/
│   └── worker:*-*/
│
├── checkpoints/                  # Phase checkpoints
├── traces/                       # Observability traces
└── ...
```

---

## Observable Events

| Event | Description |
|-------|-------------|
| `task_claimed` | Worker claimed a task from queue |
| `task_completed` | Task marked complete |
| `task_failed` | Task marked failed |
| `task_deferred` | Task deferred (deps not met) |
| `task_discovered` | Worker discovered new task |
| `task_reviewed` | Planner reviewed discovered task |
| `self_review_started` | Worker self-review cycle started |
| `self_review_passed` | Worker self-review found no issues |
| `self_review_limit_reached` | Max self-review cycles hit |
| `worker_nudged` | Supervisor sent nudge to worker |
| `worker_restarting` | Worker being restarted |
| `worker_abandoned` | Worker abandoned after max restarts |
| `planner_review_started` | Planner phase started |
| `planner_review_complete` | Planner phase completed |
| `discovery_shared` | Worker shared discovery via A2A |
| `a2a_message_sent` | A2A message sent |
| `file_negotiation_started` | File release negotiation started |
| `file_negotiation_resolved` | File release negotiation resolved |

---

## Troubleshooting

| Symptom | Check | Resolution |
|---------|-------|------------|
| No tasks.json created | Check if planner phase enabled | Ensure `v2.planner.enabled: true` |
| Workers not spawning | Check tasks.json status | Verify tasks have status "pending" |
| Self-review not triggering | Check PI_SELF_REVIEW_ENABLED | Should not be "false" |
| Self-review stuck | Check PI_MAX_SELF_REVIEW_CYCLES | Increase if needed |
| Worker stuck, not nudged | Check supervisor enabled | Verify supervisor.enabled: true |
| Discovered task not claimable | Check planner background loop | Task needs status "pending" not "pending_review" |
| A2A messages not showing | Check a2a-messages/ directory | Verify messages being created |
| Agent not found | Run install.sh | Symlinks must exist in ~/.pi/agent/agents/coordination/ |
