# Changelog

All notable changes to pi-coordination.

---

## 2026-01-08

### Added
- **Smart Input Routing** - Auto-detects input type and routes to minimize overhead:
  - **Spec** (has TASK-XX + files/deps/acceptance) → Skips scout and planner, executes immediately
  - **Plan** (has code blocks/file paths/phases) → Skips scout, runs planner for task extraction
  - **Request** (prose only) → Full pipeline with clarifying questions
- **Input Type TUI** - Interactive confirmation of detected type with 60s timeout, arrow/j/k navigation
- **Clarifying Questions** - LLM generates in-depth design review questions for request mode:
  - Questions cover architecture, tradeoffs, edge cases, security, testing, UI/UX
  - Sequential inline TUI with 60s per-question timer (resets on interaction)
  - Select options with always-visible "Other" text field for custom input
  - Context hints explaining why each question matters
  - Esc to skip all remaining questions (uses sensible defaults)
- **PRD Augmentation** - Answers appended to original content as `## Clarifications` section
- **Routing Decision Logging** - Console log and `routing-info.json` with mode, skipped phases, clarifications
- **`mode` parameter** - Explicit override: `coordinate({ plan: "input.md", mode: "spec" | "plan" | "request" })`

### Changed
- Detection uses separate signal arrays for each type (prevents spec signals leaking into plan results)
- Pipeline `skipScout` config option for smart routing integration
- Planner `enabled: false` when in spec mode (already has TASK-XX format)

### Fixed
- Input type TUI missing `finished` guard (could render after cleanup)
- Inline questions TUI context line ANSI codes broke box alignment (now calculates visual length separately)
- Truncate function exceeded maxLen for small values (now handles maxLen ≤ 3)
- Newlines in question text/context broke TUI box (now sanitized to single line)

---

## 2026-01-07

### Added
- **Scout meta section** - Scout outputs `<meta>` block with architecture, patterns, key_files, dependencies, gotchas, task_recommendations, scope_constraints, and omitted files
- **Token budget enforcement** - Scout has configurable `tokenBudget` (default: 30k) with automatic overflow splitting
  - When output exceeds budget, splits into `main.md` (meta + file_map + priority files) and `overflow.md` (remaining files)
  - Appends note to main.md pointing to overflow.md
- **Scout context attachment** - Planner receives scout context via `@file` attachment for full 100K+ token support (no tool call needed)
- **PRD vs Spec detection** - Planner auto-detects input type:
  - PRD/prose → creates task graph from scratch
  - Spec (already has tasks) → validates and refines without re-decomposing
- **System prompt override** - Agents can use `system-prompt-mode: override` in frontmatter for complete custom prompts (replaces pi's default coding assistant prompt)
- **customMetaPrompt** - Scout config option for custom meta guidance appended to scout task
- **read_context meta section** - `read_context({ section: "meta" })` extracts just the scout's analysis

### Changed
- **Atomic backlog model** - Planner prompt emphasizes tasks as "backlog items" not "waterfall phases"
- **Coordination agents use override mode** - coordinator, planner, reviewer, scout now use `system-prompt-mode: override` (worker keeps default append for coding context)
- Scout prompt updated with `<omitted>` block for files not included due to budget
- Planner prompt updated with GPT-5.2 patterns: `<scope_constraints>`, `<task_model>`, `<breakdown_rules>` XML blocks
- `tokenMetrics.estimated` now returns final token count after split (was returning original before split)

### Fixed
- **planner.ts extension path** - Fixed wrong relative path `../../../extensions/coordination/planner.ts` → `../../planner.ts`
- Planner instructions now conditional based on whether scout context is attached vs embedded inline
- Scout overflow token logging now shows actual main/overflow sizes (was showing budget and overage)
- read_context tool description now lists all sections including "meta"
- read_context error handler type cast now includes "meta" section
- **Override mode agents missing tools** - Scout, planner, coordinator now have explicit `tools:` in frontmatter (override mode removes default tools)
- **Dashboard `[??]` events** - Added handlers for `session_started`, `session_completed`, `phase_started`, `phase_completed`, `cost_updated`, `checkpoint_saved`, `planner_review_started`, `planner_review_complete`
- **Agent config visibility** - Log agent configuration when spawning (model, tools, prompt mode)
- **Override + no tools warning** - Warn at agent discovery if `system-prompt-mode: override` with no tools specified
- **Skill doc rewrite** - Updated to current API, emphasizes passing specs directly (don't rewrite user's files)
- **Scout/planner progress streaming** - Tool calls now stream in real-time during scout and planner phases (was waiting for phase completion)
- **Better event source labels** - Progress shows `[scout]`, `[plan]`, `[sys]` instead of `[??]` for phase events
- **Tool call details** - Shows command/path args (e.g., `bash find . -name "*.ts"`, `read tui.ts`)
- **Context window usage** - Shows `[scout 29.4%/59k]` with context window % and token count
- **Tool description fix** - Now says "Pass any markdown file (spec, PRD, plan) directly" to prevent spec conversion
- **Fix coordinator crash** - `params.agents` (could be number) was passed to `.join()` instead of normalized array
- **Fix duplicate tool events** - Track `lastToolEndMs` to deduplicate; still uses `recentTools[0]` for reliability
- **Telemetry error logging** - Progress callback errors now captured via `ctx.obs.errors` instead of silently swallowed
- **Unified render utilities** - Shared icons, formatters, and renderers between sync and async dashboards
- **Improved sync display** - Box-drawn UI with spinner icons (⠋⠙⠹⠸), checkmarks (✓✗), and consistent styling
- **Coordinator progress streaming** - Coordinator phase now emits tool call events like scout/planner
- **Planner verification mode** - Planner now verifies detailed specs against scout context, restructures if issues found
- **Input type detection** - Planner detects: detailed-spec, phased-plan, PRD, existing task-graph
- **Phase→atomic conversion** - Planner converts waterfall phases to atomic parallel tasks
- **Fixed coordinator extension path** - Extension path was doubled (`/extensions/extensions/`), now correct
- **Worker tool call streaming** - Worker tool calls now emit to main event stream for visibility
- **Worker spawn events** - Added `worker_spawning` event handler with logical name display
- **Missing event handlers** - Added handlers for `review_started`, `fix_completed`, `fixes_started`, `activity`
- **Cost breakdown in pipeline** - Shows per-phase costs like `$1.27 (s:$0.64 p:$0.20 w:$0.43)`
- **Activity events during scout** - Emits activity events when context grows 5k+ tokens (prevents "stuck" appearance)
- **Reviewer progress streaming** - Review phase now emits tool call events like scout/planner
- **Expanded view (Opt+C)** - Shows 25 events with full paths instead of 8 truncated; hint shown in tool header
- **Dynamic box width** - Uses terminal width (max 120) instead of fixed 80
- **Cleaner pipeline row** - Removed `│` separator between cost and time
- **Cost breakdown on own row** - Moved outside the box for cleaner display
- **Worker activity display** - Shows current tool + file for active workers
- **Worker cost tracking** - Fixed workers showing $0.00; now properly extracts cost from `usage.cost.total` in message_end events
- **Event type consistency** - Added `review_completed` handler (pipeline emits this, was only handling `review_complete`)
- **Event shortId for review_completed** - Added to sys events array so it shows `[sys]` not `[??]`
- **Context % capped at 100%** - `formatContextUsage` and worker display no longer show >100%
- **Memorable worker names** - Workers get Docker-style names like `swift_fox`, `calm_owl` (60×60 = 3600 combinations)
- **File reservations display** - Dashboard shows which files each worker owns in dedicated section
- **Name consistency fix** - Worker names now use `identity` (not UUID) to match reservation display
- **Completed table uses memorable names** - Final summary table shows `swift_fox` instead of `a1b2`
- **Empty reservations header fix** - Don't show "File reservations:" if all are released
- **Name column width fix** - Increased to 13 chars (max name is "bright_badger")
- **truncateText edge case** - Handle negative/small maxLen values gracefully
- **Hash distribution fix** - Noun selection now uses division instead of bit-shift for more uniform distribution
- **Completed state total cost** - Now uses full `costState.total` (includes scout/planner/coordinator/review), not just worker sum

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
- **Coordination Dashboard** - Full-screen TUI via `/jobs` command, plus MiniDashboard widget above input
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
