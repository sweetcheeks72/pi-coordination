# Changelog

All notable changes to pi-coordination.

---

## 2026-01-06

### Added
- **Unified Worker Tool API** - Consolidated 13 worker tools into 4 semantic tools:
  - `agent_chat` - All communication (messages, broadcasts, escalations, inbox)
  - `agent_sync` - Contract synchronization (provide/need interfaces)
  - `agent_work` - Task lifecycle (complete, step, add discovered task, deviation, read plan)
  - `file_reservations` - File conflict prevention (acquire, release, check)
- **Dynamic Task Pickup** - Workers now spawn continuously as new tasks become available (discovered tasks, reviewer tasks), not just initial batch
- **Reviewer newTasks** - Code reviewer can add new tasks via `newTasks` field in JSON output, creates FIX-XX tasks
- **Atomic Task ID Generation** - DISC-XX and FIX-XX IDs generated inside `addDiscoveredTask()` with file locking
- **Stale Task Cleanup** - Supervisor cleans up orphaned claimed tasks after configurable timeout
- **Coordination Dashboard** - Full-screen TUI for monitoring async coordination jobs via `/coord` command
  - Pipeline status with phase indicators (pending/running/complete/failed)
  - Task queue section with status, dependencies, and worker assignments
  - Worker grid with scrolling, selection, and progress bars
  - Event stream showing recent activity
  - Cost breakdown by phase and worker
  - Worker details overlay with stats, files modified, recent tools, and output
  - Task queue overlay with full dependency visualization
  - Worker actions: wrap_up, restart, abort via keyboard shortcuts
  - Mini footer for persistent status after dashboard exit
- **Philosophy section** in README explaining the "Ralph Wiggum on steroids" pattern
- New supervisor config options: `dynamicSpawnTimeoutMs` (default: 30s), `staleTaskTimeoutMs` (default: 30min)

### Changed
- Consolidated `tools/` into `extensions/coordination/` - all code now lives in the extension folder
- Old 13 worker tools deprecated with console warnings, will be removed in future release

### Fixed
- Race condition in dynamic spawning that could exceed maxWorkers limit
- `agent_sync({ action: "need" })` now returns immediately if contract already ready
- Supervisor worker state file path now uses correct `worker-{id}.json` format (was looking in non-existent `workers/` subdirectory)
- Dashboard reads pipeline state from checkpoint files (not non-existent `pipeline-state.json`), with fallback to `progress.md` parsing
- Dashboard checkpoint sorting now parses timestamps correctly (was sorting alphabetically by phase name)
- Dashboard `recentTools` display now shows newest tools first (was showing oldest due to incorrect slice direction)
- Dashboard tool timing calculation now computes relative duration from worker start (was passing absolute timestamp)
- Dashboard task overlay now checks for null state before opening
- Dashboard overlay render methods have defensive null checks
- Dashboard handles all CoordinationEvent types (added `contract_received`, `coordinator`, `cost_limit_reached`)
- Dashboard worker details now shows current task (looked up from tasks array)
- Dashboard calls `dispose()` before exit to set disposed flag (was only calling `stopPolling()`)
- Dashboard JSONL parsing now skips malformed lines instead of discarding all events
- Dashboard uses `truncateToWidth` for all content to handle narrow terminals
- Dashboard uses `padToWidth` helper for visible-width-aware column alignment (supports emojis and wide characters)
- Dashboard checks `disposed` flag before async operations complete to prevent render-after-unmount

---

## 2025-01-01

### Added
- **Validation layer** with 9 invariant checkers (session, worker, contract, cost, reservation, causality, phase, resources, content)
- Real-time streaming validator with timeout detection
- Markdown report generation at `{coordDir}/validation-report.md`
- Standalone `validate-coord` CLI for post-hoc analysis
- `validate` and `validateStream` parameters for coordinate tool

### Changed
- Integrated CustomToolContext API (`abort`, `hasQueuedMessages`, updated signature)
- `abort()` now called when hard cost threshold exceeded
- Streaming validation warnings suppressed when user has queued input

### Fixed
- EventEmitter `emit()` type inference - changed generic parameter from `T extends ObservableEvent` to `T extends EventType` with proper payload extraction
- Graceful handling of malformed JSON in observability data loader

---

## 2026-01-05

### Added
- **Planner phase** with Ralph self-review loop for task decomposition before coordination
- **Task queue model** replacing step-based work distribution (priority levels, dependencies, dynamic assignment)
- **Worker self-review loop** via tool interception on `complete_task` (configurable via `selfReview`)
- **Supervisor loop** monitors worker activity, nudges or restarts stuck workers (configurable via `supervisor`)
- **Discovered tasks workflow** - workers can add tasks via `add_discovered_task`, planner reviews before adding to queue
- **A2A communication** - `send_message` / `check_messages` for inter-worker messaging
- **Structured scout context** - Scout outputs `<file_map>` and `<file_contents>` sections for planner consumption
- **`read_context` tool** - Planner tool to read large scout context files without truncation
- New coordinator tools: `spawn_from_queue`, `get_task_queue_status`
- New worker tools: `add_discovered_task`, `share_discovery`
- Planner extension (`extensions/coordination/planner.ts`) with `read_context` tool
- Extensions-first integration for coordinator/worker/coord_output
- Async coordination runner with result files and durable `coordDir/async/status.json`
- Artifacts + output truncation helpers for full-output recovery
- Async TUI widget for idle status updates
- `coord_output` tool for retrieving subagent results from artifacts
- Configurable self-review spec via `PI_SELF_REVIEW_SPEC_PATH` env var

### Changed
- **Config flattened**: `planner`, `supervisor` options now at top level (no `v2` wrapper)
- **Smart defaults**: `agents` defaults to 4 workers, `planner.enabled` defaults to `true`
- **Settings support**: Defaults can be configured in `~/.pi/agent/settings.json` under `coordination` key
- **Elegant API**: `agents: 4`, `planner: true`, `reviewCycles: 5` shorthand forms
- **Simplified self-review**: `reviewCycles: 5` replaces `selfReview: { maxCycles: 5 }` (use `false` to disable)
- **Cost control**: Simplified to single `costLimit` param (default: $40) - ends gracefully when exceeded

### Fixed
- Self-review config now properly passed to workers via `PI_SELF_REVIEW_ENABLED` and `PI_MAX_SELF_REVIEW_CYCLES` env vars
- Supervisor config now properly passed to SupervisorLoop (nudge/restart thresholds were being ignored)
- Scout agent now outputs structured format with file tree and full file contents
- Planner reads scout context via `read_context` tool instead of inline prompt
- Installation now cleans up legacy hooks/tools symlinks
- README updated with scout context format, planner tools, and new file layout
- Pipeline phases now include optional planner phase between scout and coordinator

### Removed
- `worker-hooks/reservation.ts` (replaced by extensions model)
- `reviewModel` parameter (use `reviewer: { model }` instead)
- `costThresholds` and `pauseOnCostThreshold` (replaced by simple `costLimit`)

---

## 2024-12-31

### Added
- **Observability system** with events, spans, causality tracking, structured errors
- Event streaming with `EventEmitter.subscribe()` for real-time listeners
- Span tracing with hierarchical timing
- Causality tracker for cause-effect relationships
- Resource lifecycle tracking
- Snapshot manager for state capture
- Decision logger for audit trails

---

## 2024-12-30

### Added
- **Multi-phase pipeline** with scout, coordinator, workers, review, fixes phases
- Review/fix loop with configurable max cycles and stuck detection
- Cost controls with warn/pause/hard thresholds
- Checkpointing system for pipeline state recovery
- Progress document generation

### Changed
- Coordination now runs through pipeline phases instead of direct execution

---

## 2024-12-29

### Added
- Automatic coordination log generation (`coordination-log-*.md`)
- Enhanced TUI with phase timeline, worker status, event stream
- Cost milestone tracking in events

---

## 2024-12-28

### Added
- **Initial release** of multi-agent coordination system
- Coordinator agent with spawn_workers, create_contract, assign_files tools
- Worker agents with contract signaling and reservation system
- File reservation system for conflict prevention
- Contract system for cross-worker dependencies
- Basic event logging
