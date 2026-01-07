---
name: coordination
description: Multi-agent coordination for parallel plan execution with the coordinate and coord_output tools.
---

# Coordination Skill

Multi-agent coordination for parallel task execution.

**YOU HAVE THE `coordinate` TOOL AVAILABLE.** When asked to execute a plan, spec, or PRD - USE THE `coordinate` TOOL.

## IMPORTANT: Pass Files Directly

**DO NOT rewrite or convert the user's plan/spec.** Pass it directly to coordinate:

```typescript
// User says "implement spec.md" → pass it directly
coordinate({ plan: "./spec.md" })

// User says "execute my-plan.md with 8 workers"
coordinate({ plan: "./my-plan.md", agents: 8 })
```

The planner phase will analyze and decompose ANY format - prose, specs, task lists. **You don't need to convert it first.**

**Defaults:** 4 workers, planner enabled, 5 self-review cycles, supervisor enabled, $40 cost limit.

## When to Use

Use `coordinate` when:
- User has a **plan**, **spec**, or **PRD** to implement
- User says "implement", "execute", "run", "coordinate" a file
- Work spans multiple files that could be parallelized

**Just pass the file directly** — don't rewrite it, don't create a new plan from it.

**Any format works:**
- Prose PRD → Planner decomposes into tasks
- Detailed spec → Planner extracts tasks
- Task list → Planner validates and uses

## Tool Parameters

```typescript
coordinate({
  // Required
  plan: string,                    // Path to plan/spec markdown file

  // Common options (all optional)
  agents: number | string[],       // Worker count or array (default: 4)
  planner: boolean | object,       // Enable planner or config (default: true)
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
  scout: string | { model: string },
  coordinator: string | { model: string },
  worker: string | { model: string },
  reviewer: string | { model: string },
})
```

**Note:** `planner` serves dual purpose - `planner: false` disables it, `planner: { model: "..." }` configures it.

## Examples

```typescript
// Basic - 4 workers, planner enabled
coordinate({ plan: "./plan.md" })

// More workers
coordinate({ plan: "./plan.md", agents: 8 })

// Skip planner (plan is already a task graph)
coordinate({ plan: "./tasks.md", planner: false })

// Async mode - returns immediately, use /jobs to monitor
coordinate({ plan: "./plan.md", async: true })

// Disable self-review for speed
coordinate({ plan: "./plan.md", reviewCycles: false })

// Custom models
coordinate({ 
  plan: "./plan.md",
  scout: "claude-sonnet-4-20250514",
  worker: "claude-sonnet-4-20250514"
})
```

## Pipeline Phases

1. **Scout** — Analyzes codebase, outputs `<meta>`, `<file_map>`, `<file_contents>`
2. **Planner** — Creates task graph from plan + scout context
3. **Workers** — Execute tasks in parallel with self-review
4. **Review** — Code reviewer checks all changes
5. **Fixes** — Workers fix any issues found
6. **Complete** — Final summary

## Plan Format

Plans can be prose (PRD) or already a spec:

**Prose (planner will decompose):**
```markdown
# Add Authentication

- Login endpoint with JWT tokens
- Password hashing with bcrypt  
- Protected route middleware
```

**Spec (planner will validate):**
```markdown
## TASK-01: Create auth types
Files: src/types.ts
Acceptance: AuthCredentials and User interfaces exported

## TASK-02: Implement login endpoint
Files: src/routes/auth.ts
Depends on: TASK-01
Acceptance: POST /login returns JWT
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

Parameters: `ids` (required), `coordDir` (optional), `format` ("raw" | "json" | "stripped")

## DO NOT

- **Don't rewrite the user's spec** — Pass it directly to coordinate
- **Don't create a new plan file** — The planner handles any format
- **Don't manually decompose tasks** — That's the planner's job

## Tips

1. **Pass directly** — User gives you a file? `coordinate({ plan: "that-file.md" })`
2. **Let planner work** — It handles prose, specs, task lists, anything
3. **Check /jobs** — For async runs, the dashboard shows everything
4. **Cost aware** — Default $40 limit, increase with `costLimit` if needed
