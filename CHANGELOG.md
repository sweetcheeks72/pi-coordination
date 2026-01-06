# Changelog

All notable changes to pi-coordination.

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
- **Worker self-review loop** via tool interception on `complete_task` (configurable via `v2.selfReview`)
- **Supervisor loop** monitors worker activity, nudges or restarts stuck workers (configurable via `v2.supervisor`)
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
- Scout agent now outputs structured format with file tree and full file contents
- Planner reads scout context via `read_context` tool instead of inline prompt
- Installation now cleans up legacy hooks/tools symlinks
- README updated with scout context format, planner tools, and new file layout
- Pipeline phases now include optional planner phase between scout and coordinator

### Removed
- `worker-hooks/reservation.ts` (replaced by extensions model)

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
