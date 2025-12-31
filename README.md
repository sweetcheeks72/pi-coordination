# pi-coordination

Multi-agent coordination system for [pi](https://github.com/badlogic/pi-mono). Enables parallel plan execution with dependency management, contracts between workers, and real-time TUI visibility.

## Features

- **Parallel Execution**: Spawn multiple workers to execute plan steps simultaneously
- **Dependency Management**: Automatic detection of file and type dependencies
- **Contracts**: Workers coordinate via contracts, not file polling
- **Real-time TUI**: Animated spinners, status updates, timestamped message stream
- **Clean Completion**: Summary of what each worker accomplished

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

- pi (from pi-mono, session-tree branch or later)
- Node.js 18+

## Usage

### Via the `coordinate` tool

```typescript
coordinate({
  plan: "./plan.md",
  agents: ["worker", "worker", "worker", "worker"]
})
```

### Example prompt

> Execute plan.md with 4 workers

The coordinate tool will:
1. Spawn a coordinator to analyze the plan
2. Coordinator spawns workers with detailed handshake specs
3. Workers execute in parallel, coordinating via contracts
4. TUI shows real-time progress
5. Final summary shows completion status

## TUI Display

**During startup:**
```
ok 0/4 agents | 0 msgs
⠹ worker  ⠹ worker  ⠹ worker  ⠹ worker
Coordinator starting up (waiting for LLM response)...
```

**While running:**
```
ok 2/4 agents | 35 msgs
ok worker:04ea  ok worker:52e2  .. worker:952d  .. worker:7407
+0.0s [coordinator] Spawned 4 workers
+1.2s [worker-04ea] [tool] write
+1.3s [worker-52e2] Creating store with CRUD operations
```

**When complete:**
```
ok 4/4 completed
ok worker:04ea  ok worker:52e2  ok worker:952d  ok worker:7407
---
## Coordination Complete
All 4 workers executed successfully...
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

## Step 4: Create Routes
Create `src/routes.ts` with route definitions. Imports from handlers.
```

## Architecture

```
coordinate tool
    │
    ├── Spawns coordinator agent
    │   ├── Analyzes plan for dependencies
    │   ├── Creates contracts between workers
    │   └── Spawns workers with handshake specs
    │
    └── Workers execute in parallel
        ├── Use coordination tools (complete_task, signal_contract_complete, etc.)
        ├── Communicate via file-based messages
        └── Exit cleanly when done
```

## Files

```
tools/
├── coordinate/           # Main coordination tool
│   ├── index.ts          # Tool entry point with TUI rendering
│   ├── state.ts          # FileBasedStorage for shared state
│   ├── types.ts          # Type definitions
│   ├── coordinator-tools/ # Tools available to coordinator
│   ├── worker-tools/      # Tools available to workers
│   └── worker-hooks/      # Hooks for worker file reservation
└── subagent/             # Shared agent utilities
    ├── agents.ts         # Agent discovery and configuration
    ├── render.ts         # Result rendering utilities
    ├── runner.ts         # Agent process spawning
    └── types.ts          # Shared type definitions

agents/
├── coordinator.md        # Coordinator agent definition
└── worker.md             # Worker agent definition (includes coordination section)

skills/
└── coordination/
    └── SKILL.md          # Skill documentation
```

## License

MIT
