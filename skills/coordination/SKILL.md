---
name: coordination
description: Multi-agent coordination for parallel plan execution with the coordinate and coord_output tools.
---

# Coordination Skill

Multi-agent coordination for parallel task execution using the **two-track architecture**:
- `plan` tool: Create specs from prose/PRDs (interview → scout → elaborate → structure)
- `coordinate` tool: Execute TASK-XX format specs (validate → dispatch → execute → review)

**NOTE: The `coordinate` and `plan` tools are only available if the pi-coordination extension is installed.
If these tools are not available in your session, run `install.sh` from your pi-coordination clone
and restart Pi.**

## Two-Track Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  PLAN TOOL (create specs)          COORDINATE TOOL (execute)    │
│  ─────────────────────────         ───────────────────────────  │
│  prose/PRD → interview             TASK-XX spec → validate      │
│           → scout                              → dispatch       │
│           → elaborate                          → workers        │
│           → structure                          → review         │
│           → spec.md ─────────────────────────→                  │
└─────────────────────────────────────────────────────────────────┘
```

## When to Use Each Tool

### Use `plan` when:
- User has prose, PRD, or requirements to convert into a spec
- User says "plan", "create a spec", "help me design"
- Input is NOT already in TASK-XX format

### Use `coordinate` when:
- User has a **valid TASK-XX format spec**
- User says "implement", "execute", "run", "coordinate"
- The file already contains `## TASK-XX:` sections

## Coordinate Tool

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

## Plan Tool

Creates TASK-XX specs from prose, PRDs, or requirements through an interactive flow.

```typescript
// Create spec from a file
plan({ input: "./requirements.md" })

// Create spec from inline text
plan({ input: "Add user authentication with JWT tokens" })

// Refine an existing spec
plan({ continue: "./spec.md" })

// Skip interview (use defaults)
plan({ input: "./prd.md", skipInterview: true })
```

### Parameters

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

### Pipeline Phases (plan)

1. **Interview** — Gather requirements interactively (can skip with Ctrl+D or timeout)
2. **Scout** — Analyze codebase structure and patterns
3. **Elaborate** — Expand requirements with codebase context
4. **Structure** — Convert to TASK-XX format spec
5. **Output** — Save spec to file

## Required Spec Format (TASK-XX)

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

## Typical Workflow

```typescript
// 1. User has prose requirements
plan({ input: "./requirements.md" })
// → Creates specs/requirements-spec.md

// 2. Execute the generated spec
coordinate({ plan: "./specs/requirements-spec.md" })
```

Or if user already has a valid spec:

```typescript
// Execute directly
coordinate({ plan: "./valid-spec.md" })
```

## Monitoring

**During execution:** TUI shows live progress with pipeline status, workers, events.

**Async mode:** Use `/jobs` command to open full dashboard:
- Pipeline status
- Task queue with dependencies  
- Worker status with cost/duration
- Event stream

## Output Retrieval

When worker output is truncated, use `coord_output`:

```typescript
coord_output({ ids: ["worker-04ea"] })
coord_output({ ids: ["scout", "planner", "review"] })
coord_output({ ids: ["worker-04ea"], format: "stripped" })  // No ANSI codes
```

## HITL Gate — Approval Handling During Coordination

During active coordination sessions, Helios must monitor for pending HITL approval requests and respond promptly.

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

## DO NOT

- **Don't pass prose to coordinate** — Use `plan` tool first to create a spec
- **Don't manually write TASK-XX specs** — Let `plan` tool generate them
- **Don't skip validation errors** — Fix the spec or use `plan` to create a valid one

## Error Handling

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
