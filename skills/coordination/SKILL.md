---
name: coordination
description: Multi-agent coordination using pi_messenger/Crew for task orchestration and parallel subagent for bounded execution.
---

# Coordination Skill

Multi-agent coordination for parallel task execution. Two primary approaches:

1. **pi_messenger / Crew** — Full orchestration with durable task graphs, file reservations, progress tracking, and worker coordination
2. **Parallel subagent** — Lightweight parallel dispatch for bounded independent tasks

## Recommended: pi_messenger / Crew

Use **pi_messenger** with Crew for durable multi-agent coordination. Crew provides:
- Task dependency graphs with automatic sequencing
- File reservation system to prevent conflicts
- Real-time progress tracking and heartbeats
- Worker escalation and error handling
- Cross-session state persistence

### Typical Workflow

```typescript
// 1. Create a plan from requirements
plan({ input: "./requirements.md" })
// → Creates specs/requirements-spec.md

// 2. Load the plan into Crew
pi_messenger({ action: 'plan', prd: './specs/requirements-spec.md' })
// → Creates task graph in Crew state

// 3. Execute tasks autonomously
pi_messenger({ action: 'work', autonomous: true })
// → Workers execute tasks in parallel, respecting dependencies
```

### Core Operations

```typescript
// Join the mesh (first step)
pi_messenger({ action: 'join' })

// Plan from a PRD or spec
pi_messenger({ action: 'plan', prd: './path/to/spec.md' })

// Execute tasks (autonomous mode runs until done/blocked)
pi_messenger({ action: 'work' })
pi_messenger({ action: 'work', autonomous: true })

// Check status
pi_messenger({ action: 'status' })
pi_messenger({ action: 'task.list' })

// Manual task control
pi_messenger({ action: 'task.start', id: 'task-1' })
pi_messenger({ action: 'task.done', id: 'task-1', summary: '...' })

// File reservations (workers do this automatically)
pi_messenger({ action: 'reserve', paths: ['src/auth.ts'] })
pi_messenger({ action: 'release', paths: ['src/auth.ts'] })

// Direct messaging
pi_messenger({ action: 'send', to: 'worker-name', message: 'Status?' })
```

### When to Use Crew

- **Multi-file features** with dependencies between tasks
- **Long-running work** that spans multiple sessions
- **Parallel workers** that might touch overlapping files
- **Progress tracking** requirements (dashboards, status updates)
- **Escalation handling** (blocked workers need coordination)

### Example: Feature Implementation

```typescript
// Create spec from PRD
plan({ input: './docs/auth-feature.md', output: './specs/auth-spec.md' })

// Load into Crew
pi_messenger({ action: 'plan', prd: './specs/auth-spec.md' })

// Review planned tasks
pi_messenger({ action: 'task.list' })

// Execute autonomously
pi_messenger({ action: 'work', autonomous: true, concurrency: 4 })
```

## Alternative: Parallel Subagent

Use **parallel subagent dispatch** for bounded independent tasks without coordination overhead.

```typescript
// 2-4 independent tasks with no file overlap
subagent({ 
  tasks: [
    { agent: 'worker', task: 'Fix typo in README.md' },
    { agent: 'worker', task: 'Update changelog' },
    { agent: 'worker', task: 'Add test for auth.ts' }
  ]
})
```

### When to Use Parallel Subagent

- **2-4 independent tasks** with no dependencies
- **No file overlap** between tasks
- **Bounded work** (each task <30 min)
- **No progress tracking** needed
- **Single-session** execution

### Examples

```typescript
// Simple parallel execution
subagent({
  tasks: [
    { agent: 'worker', task: 'Create types.ts with User interface', model: 'anthropic/claude-sonnet-4-5' },
    { agent: 'worker', task: 'Create utils.ts with hash function', model: 'anthropic/claude-sonnet-4-5' },
    { agent: 'worker', task: 'Update README with setup steps', model: 'anthropic/claude-haiku-4-5' }
  ]
})

// Research + implementation
subagent({
  tasks: [
    { agent: 'researcher', task: 'Research JWT best practices for Node.js' },
    { agent: 'scout', task: 'Map current auth implementation' }
  ]
})
```

## Decision Table

| Need | Use | Why |
|------|-----|-----|
| Durable task graph with dependencies | **pi_messenger/Crew** | Full orchestration, state persistence |
| File reservations / conflict prevention | **pi_messenger/Crew** | Prevents parallel write conflicts |
| Progress tracking / worker monitoring | **pi_messenger/Crew** | Real-time heartbeats, escalations |
| Multi-session work (resume later) | **pi_messenger/Crew** | Crew state persists across sessions |
| 2-4 independent bounded tasks | **parallel subagent** | Simple, no coordination overhead |
| Single-file tasks in parallel | **parallel subagent** | Lightweight, fast dispatch |
| Legacy specs in TASK-XX format | **coordinate()** (deprecated) | Backward compatibility only |

## Creating Specs with `plan` Tool

Both Crew and coordinate() require structured specs. Use the `plan` tool to create them:

```typescript
// Create spec from prose/PRD
plan({ input: "./requirements.md" })

// Create spec from inline text
plan({ input: "Add user authentication with JWT tokens" })

// Refine existing spec
plan({ continue: "./spec.md" })

// Skip interview for speed
plan({ input: "./prd.md", skipInterview: true })
```

### Plan Parameters

```typescript
plan({
  // For NEW plans
  input: string,                   // File path or inline text
  
  // For REFINING existing specs
  continue: string,                // Path to existing spec to refine
  
  // Options
  skipInterview: boolean,          // Skip interactive interview (default: false)
  skipScout: boolean,              // Skip codebase analysis (default: false)
  maxInterviewRounds: number,      // Limit interview rounds (default: 5 new, 3 refine)
  output: string,                  // Where to save spec (default: auto-named in specs/)
  format: "markdown" | "json",     // Output format (default: markdown)
  
  // Model overrides
  model: string,                   // Model for elaboration (default: frontier)
  scoutModel: string,              // Model for scout (default: fast)
})
```

## HITL Gate — Approval Handling During Coordination

During active coordination sessions (Crew or coordinate), Helios must monitor for pending HITL approval requests and respond promptly.

### Detecting Pending Approvals

When `coordinate()` is running with `hitl: 'permissive'` or `hitl: 'strict'` mode, it may write an approval request to the coordination directory:

```
{coordDir}/hitl/batch-approval-request.json
```

This file contains tasks that require human approval before execution proceeds.

**Format:**
```json
{
  "tasks": [
    { "taskId": "task-1", "summary": "Deploy to staging", "risk": "medium" },
    { "taskId": "task-3", "summary": "Migrate schema to v2", "risk": "high" }
  ],
  "requestedAt": 1700000000000,
  "scopeConfirmed": false
}
```

### Risk Levels and Timeouts

| Risk | Timeout | Auto-approve? |
|------|---------|---------------|
| `low` | n/a | Yes (audit only) |
| `medium` | 2 minutes | No |
| `high` | 3 minutes | No |
| `critical` | 5 minutes | No |

### How Helios Should Respond

1. **Detect the request**: Check for `{coordDir}/hitl/batch-approval-request.json` during coordination status checks

2. **Present via interview tool**:
```json
{
  "title": "HITL Approval Required",
  "description": "The following tasks need your approval before execution.",
  "questions": [
    {
      "id": "approve_tasks",
      "type": "multi",
      "question": "Which tasks should proceed?",
      "options": ["task-1: Deploy to staging [MEDIUM]", "task-3: Migrate schema to v2 [HIGH]"]
    }
  ]
}
```

3. **Write the response** to `{coordDir}/hitl/batch-approval-response.json`:
```json
{
  "approved": ["task-1"],
  "rejected": ["task-3"],
  "respondedAt": 1700000001000
}
```

4. **Respond within the timeout** (max timeout is determined by the highest-risk task in the batch)

### Polling During Coordination

When `coord_output()` or `check_status()` shows a coordination session is running, Helios should:
1. Check if `{coordDir}/hitl/batch-approval-request.json` exists
2. If it does and is recent (within 5 minutes), immediately surface the approval UI
3. Write the response before the timeout expires

### Notes
- `LOW` risk tasks are never included in approval requests (they auto-proceed with audit logging)
- `scopeConfirmed: true` in the request means scope was pre-confirmed via interview; show this context to the user but do NOT use it to auto-approve
- The hitl/ directory is cleaned up by coordinate after resolution

---

## Legacy: coordinate() Tool (Deprecated)

> ⚠️ **DEPRECATED**: The `coordinate()` tool is deprecated. Use **pi_messenger/Crew** for new multi-agent work or **parallel subagent** for bounded tasks.
>
> This section is preserved for backward compatibility with existing TASK-XX format specs.

**IMPORTANT:** The `coordinate` tool now requires a valid TASK-XX format spec. It will NOT auto-convert prose or PRDs.

```typescript
// Execute a valid spec
coordinate({ plan: "./spec.md" })

// If validation fails, the error will tell you to use the plan tool first
```

### Parameters

```typescript
coordinate({
  // Required
  plan: string,                    // Path to TASK-XX format spec file

  // Common options (all optional)
  agents: number | string[],       // Worker count or array (default: 4)
  reviewCycles: number | false,    // Worker self-review cycles (default: 5, false to disable)
  supervisor: boolean | object,    // Monitor stuck workers (default: true)
  costLimit: number,               // End gracefully at limit (default: $40)
  
  // Async mode
  async: boolean,                  // Run in background (default: false)
  
  // Advanced
  maxFixCycles: number,            // Review/fix iterations (default: 3)
  validate: boolean,               // Run validation after (default: false)
  checkTests: boolean,             // Reviewer checks tests (default: true)
  
  // Model overrides (string sets model, object for full config)
  coordinator: string | { model: string },
  worker: string | { model: string },
  reviewer: string | { model: string },
})
```

### Examples

```typescript
// Basic - 4 workers
coordinate({ plan: "./spec.md" })

// More workers
coordinate({ plan: "./spec.md", agents: 8 })

// Async mode - returns immediately, use /jobs to monitor
coordinate({ plan: "./spec.md", async: true })

// Disable self-review for speed
coordinate({ plan: "./spec.md", reviewCycles: false })

// Custom models
coordinate({ 
  plan: "./spec.md",
  worker: "claude-sonnet-4-20250514"
})
```

### Pipeline Phases (coordinate)

1. **Validate** — Checks spec is valid TASK-XX format
2. **Dispatch** — Assigns tasks to workers respecting dependencies
3. **Workers** — Execute tasks in parallel with self-review
4. **Review** — Code reviewer checks all changes
5. **Fixes** — Workers fix any issues found
6. **Complete** — Final summary

### Required Spec Format (TASK-XX)

The `coordinate` tool requires this format:

```markdown
# Project Title

Description of what we're building.

## TASK-01: Create auth types
Priority: P1
Files: src/types.ts (create)
Depends on: none
Acceptance: AuthCredentials and User interfaces exported

## TASK-02: Implement login endpoint
Priority: P1
Files: src/routes/auth.ts (create)
Depends on: TASK-01
Acceptance: POST /login returns JWT, tests pass
```

**Required fields per task:**
- `## TASK-XX: Title` — Task ID and title
- `Priority: P0|P1|P2|P3` — Execution priority
- `Files:` — Files to create/modify
- `Depends on:` — Dependencies (or "none")
- `Acceptance:` — Testable completion criteria

### Monitoring

**During execution:** TUI shows live progress with pipeline status, workers, events.

**Async mode:** Use `/jobs` command to open full dashboard:
- Pipeline status
- Task queue with dependencies  
- Worker status with cost/duration
- Event stream

### Output Retrieval

When worker output is truncated, use `coord_output`:

```typescript
coord_output({ ids: ["worker-04ea"] })
coord_output({ ids: ["scout", "planner", "review"] })
coord_output({ ids: ["worker-04ea"], format: "stripped" })  // No ANSI codes
```

### Error Handling

If `coordinate` returns a validation error like:

```
Invalid spec format. The coordinate tool requires a valid TASK-XX format spec.

Errors:
- No valid TASK-XX format tasks found
```

Use the `plan` tool first:

```typescript
plan({ input: "./your-file.md" })
// Then coordinate the output
coordinate({ plan: "./specs/your-file-spec.md" })
```
