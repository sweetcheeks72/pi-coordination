/**
 * Shared rendering utilities for coordination displays (sync and async dashboards)
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import { visibleWidth } from "@mariozechner/pi-tui";
import type { Input } from "@mariozechner/pi-tui";
import type { PipelinePhase, PhaseResult, WorkerStateFile, Task, CoordinationEvent, FileReservation, MeshMessage, EscalationRequest } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Memorable Names (Docker-style adjective_noun)
// ─────────────────────────────────────────────────────────────────────────────

const ADJECTIVES = [
	"swift", "calm", "bold", "keen", "wise", "fair", "warm", "cool", "bright", "quick",
	"sharp", "smart", "brave", "kind", "neat", "proud", "eager", "happy", "witty", "noble",
	"agile", "clever", "steady", "lively", "gentle", "fierce", "silent", "vivid", "mellow", "crisp",
	"sleek", "plush", "brisk", "deft", "spry", "zesty", "perky", "snug", "tidy", "cozy",
	"lucid", "frank", "prime", "fleet", "grand", "stout", "fresh", "clear", "light", "pure",
	"dusty", "misty", "foggy", "sunny", "rainy", "snowy", "windy", "stormy", "frosty", "dewy",
];

const NOUNS = [
	"fox", "owl", "wolf", "bear", "hawk", "lynx", "deer", "hare", "crow", "dove",
	"pike", "bass", "wren", "swan", "moth", "wasp", "toad", "newt", "crab", "seal",
	"elm", "oak", "pine", "fern", "moss", "reed", "vine", "rose", "lily", "sage",
	"finch", "robin", "egret", "heron", "otter", "badger", "stoat", "vole", "shrew", "mole",
	"trout", "perch", "carp", "bream", "squid", "conch", "clam", "snail", "slug", "ant",
	"birch", "maple", "cedar", "aspen", "alder", "willow", "holly", "ivy", "daisy", "tulip",
];

// Cache to ensure same workerId always gets same name within a session
const nameCache = new Map<string, string>();

export function generateMemorableName(workerId: string): string {
	if (nameCache.has(workerId)) {
		return nameCache.get(workerId)!;
	}
	
	// Simple hash from workerId to pick adjective + noun
	let hash = 0;
	for (let i = 0; i < workerId.length; i++) {
		hash = ((hash << 5) - hash) + workerId.charCodeAt(i);
		hash = hash & hash; // Convert to 32-bit int
	}
	hash = Math.abs(hash);
	
	// Use division for more uniform distribution of both indices
	const adj = ADJECTIVES[hash % ADJECTIVES.length];
	const noun = NOUNS[Math.floor(hash / ADJECTIVES.length) % NOUNS.length];
	const name = `${adj}_${noun}`;
	
	nameCache.set(workerId, name);
	return name;
}

// ─────────────────────────────────────────────────────────────────────────────
// Icons
// ─────────────────────────────────────────────────────────────────────────────

export const ICONS = {
	complete: "✓",
	running: "●",
	pending: "○",
	failed: "✗",
	waiting: "◐",
	spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
} as const;

export function getSpinnerFrame(): string {
	const idx = Math.floor(Date.now() / 80) % ICONS.spinner.length;
	return ICONS.spinner[idx];
}

export function getStatusIcon(status: string): string {
	switch (status) {
		case "complete": return ICONS.complete;
		case "working": return ICONS.running;
		case "running": return ICONS.running;
		case "waiting": return ICONS.waiting;
		case "blocked": return ICONS.waiting;
		case "failed": return ICONS.failed;
		case "pending": return ICONS.pending;
		default: return ICONS.pending;
	}
}

export function getStatusColor(status: string): "success" | "warning" | "error" | "muted" | "dim" {
	switch (status) {
		case "complete": return "success";
		case "working": return "warning";
		case "running": return "warning";
		case "waiting": return "muted";
		case "blocked": return "error";
		case "failed": return "error";
		case "pending": return "dim";
		default: return "dim";
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatters
// ─────────────────────────────────────────────────────────────────────────────

export function formatDuration(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}

export function formatCost(cost: number): string {
	return `$${(cost ?? 0).toFixed(2)}`;
}

export function formatContextUsage(tokens: number, maxTokens = 200000): string {
	if (!tokens || tokens <= 0) return "";
	const pct = Math.min(100, Math.round((tokens / maxTokens) * 100));
	const k = Math.round(tokens / 1000);
	return `${pct}%/${k}k`;
}

export function truncateText(text: string, maxLen: number): string {
	if (maxLen < 4) return text.slice(0, Math.max(0, maxLen)); // Can't fit "..." if < 4 chars
	if (text.length <= maxLen) return text;
	return text.slice(0, maxLen - 3) + "...";
}

// Pi TUI crashes on strings > 210 chars — hard cap as safety guard (Pi bug #1842)
function piSafe(str: string, max = 205): string {
	if (!str || str.length <= max) return str;
	return str.slice(0, max - 1) + '…';
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase helpers
// ─────────────────────────────────────────────────────────────────────────────

const PHASE_ORDER: PipelinePhase[] = ["scout", "planner", "coordinator", "workers", "integration", "review", "fixes", "complete", "failed"];

export function isPhasePast(phase: PipelinePhase, currentPhase: PipelinePhase): boolean {
	const phaseIdx = PHASE_ORDER.indexOf(phase);
	const currentIdx = PHASE_ORDER.indexOf(currentPhase);
	return phaseIdx < currentIdx;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline rendering
// ─────────────────────────────────────────────────────────────────────────────

export interface PipelineDisplayState {
	currentPhase: PipelinePhase;
	phases: Record<PipelinePhase, PhaseResult | undefined>;
	cost: number;
	costByPhase?: Record<string, number>;
	elapsed: number; // ms
	costLimit?: number; // USD cap — if set, shown in header
}

export function renderPipelineRow(
	state: PipelineDisplayState,
	theme: Theme,
	width: number,
): string {
	// Display phases (condensed: workers includes coordinator/fixes, review includes integration)
	const phases: PipelinePhase[] = ["scout", "planner", "workers", "review", "complete"];
	const parts: string[] = [];

	for (const phase of phases) {
		const result = state.phases[phase];
		const status = result?.status;
		// "workers" phase in display encompasses coordinator, workers, and fixes
		// "review" phase in display encompasses integration and review
		const isCurrent = phase === state.currentPhase || 
			(phase === "workers" && (state.currentPhase === "coordinator" || state.currentPhase === "fixes")) ||
			(phase === "review" && state.currentPhase === "integration");
		const isPast = isPhasePast(phase, state.currentPhase);
		const isFailed = state.currentPhase === "failed";

		let icon: string;
		let name: string;

		if (phase === state.currentPhase && isFailed) {
			icon = theme.fg("error", ICONS.failed);
			name = theme.fg("error", "failed");
		} else if (status === "complete" || (isPast && status !== "failed")) {
			icon = theme.fg("success", ICONS.complete);
			name = theme.fg("dim", phase);
		} else if (status === "running" || isCurrent) {
			icon = theme.fg("warning", getSpinnerFrame());
			name = theme.fg("accent", phase);
		} else {
			icon = theme.fg("dim", ICONS.pending);
			name = theme.fg("dim", phase);
		}

		parts.push(`${icon} ${name}`);
	}

	const pipeline = parts.join(theme.fg("dim", " → "));
	const cost = theme.fg("muted", formatCost(state.cost));
	const time = theme.fg("dim", formatDuration(state.elapsed));
	const right = `${cost}  ${time}`;

	const leftWidth = visibleWidth(pipeline);
	const rightWidth = visibleWidth(right);
	const gap = Math.max(1, width - leftWidth - rightWidth);

	return pipeline + " ".repeat(gap) + right;
}

export function renderCostBreakdown(
	costByPhase: Record<string, number> | undefined,
	theme: Theme,
): string | null {
	if (!costByPhase) return null;
	
	const abbrevs: Record<string, string> = { 
		scout: "scout", 
		planner: "planner", 
		coordinator: "coord", 
		workers: "workers", 
		review: "review", 
		fixes: "fixes" 
	};
	
	const parts: string[] = [];
	for (const [phase, amount] of Object.entries(costByPhase)) {
		if (amount > 0) {
			const name = abbrevs[phase] || phase;
			parts.push(`${theme.fg("dim", name + ":")} ${formatCost(amount)}`);
		}
	}
	
	if (parts.length === 0) return null;
	return parts.join(theme.fg("dim", "  "));
}

// ─────────────────────────────────────────────────────────────────────────────
// Workers rendering
// ─────────────────────────────────────────────────────────────────────────────

export interface WorkerDisplayState {
	id: string;
	shortId: string;
	name: string; // Memorable name like "swift_fox"
	status: string;
	taskId?: string;
	taskTitle?: string; // First line of handshake spec
	tokens?: number;
	contextPct?: number;
	cost: number;
	durationMs: number;
	currentFile?: string | null;
	currentTool?: string | null;
	lastOutput?: string; // Last captured output for live feedback
	/** Populated while auto-repair is active or after it completes */
	repairState?: {
		status: "running" | "success" | "failed";
		attempt: number;
		maxAttempts: number;
	};
}

/**
 * Extract task ID from worker identity (format: worker:TASK-XX-shortid)
 */
function extractTaskId(identity: string): string | undefined {
	const match = identity.match(/TASK-\d+(?:\.\d+)?/);
	return match ? match[0] : undefined;
}

/**
 * Extract task title from handshake spec (first meaningful line)
 */
function extractTaskTitle(handshakeSpec: string | undefined): string | undefined {
	if (!handshakeSpec) return undefined;
	// Look for first meaningful content line
	const lines = handshakeSpec.split("\n").map(l => l.trim()).filter(l => l);
	for (const line of lines) {
		// Skip markdown headers like "## Task: TASK-01"
		if (line.startsWith("## Task:")) continue;
		if (line.startsWith("#")) continue;
		// Skip metadata lines like "**Files:** ..."
		if (line.startsWith("**") && line.includes(":")) continue;
		// Skip frontmatter delimiters
		if (line === "---") continue;
		// Return first content line
		return line;
	}
	// No meaningful content found
	return undefined;
}

export function workerStateToDisplay(w: WorkerStateFile): WorkerDisplayState {
	const contextTokens = w.tokens || 0;
	return {
		id: w.id,
		shortId: w.shortId || w.id.slice(0, 4),
		name: generateMemorableName(w.identity),
		status: w.status,
		taskId: extractTaskId(w.identity),
		taskTitle: extractTaskTitle(w.handshakeSpec),
		tokens: contextTokens,
		contextPct: contextTokens > 0 ? Math.min(100, Math.round((contextTokens / 200000) * 100)) : undefined,
		cost: w.usage?.cost || 0,
		durationMs: w.startedAt ? Date.now() - w.startedAt : 0,
		currentFile: w.currentFile,
		currentTool: w.currentTool,
		lastOutput: w.lastOutput,
		repairState: w.repairState,
	};
}

/**
 * Render a fancy progress bar with percentage
 * Uses Unicode block characters for smooth appearance:
 * ████████░░░░░░░░ 50%
 */
export function renderProgressBar(
	completed: number,
	total: number,
	theme: Theme,
	barWidth: number = 20,
): string {
	if (total === 0) return theme.fg("dim", "─".repeat(barWidth));
	
	const pct = Math.round((completed / total) * 100);
	const filledWidth = Math.round((completed / total) * barWidth);
	const emptyWidth = barWidth - filledWidth;
	
	// Use different colors based on progress
	let barColor: "success" | "warning" | "accent" = "accent";
	if (pct >= 75) barColor = "success";
	else if (pct >= 40) barColor = "accent";
	else barColor = "warning";
	
	const filled = theme.fg(barColor, "█".repeat(filledWidth));
	const empty = theme.fg("dim", "░".repeat(emptyWidth));
	const pctStr = theme.fg(barColor, `${pct}%`.padStart(4));
	
	return `${filled}${empty} ${pctStr}`;
}

/**
 * Render task progress with a visual bar
 */
export interface TaskProgress {
	total: number;
	completed: number;
	active: number;
	pending: number;
	blocked: number;
	failed: number;
}

export function renderTaskProgress(
	progress: TaskProgress,
	theme: Theme,
	width: number,
): string[] {
	const lines: string[] = [];
	
	const bar = renderProgressBar(progress.completed, progress.total, theme, 20);
	const counts = `${theme.fg("success", String(progress.completed))}${theme.fg("dim", "/")}${theme.fg("muted", String(progress.total))}`;
	
	const statusParts: string[] = [];
	if (progress.active > 0) statusParts.push(theme.fg("warning", `${progress.active} active`));
	if (progress.pending > 0) statusParts.push(theme.fg("dim", `${progress.pending} pending`));
	if (progress.blocked > 0) statusParts.push(theme.fg("muted", `${progress.blocked} blocked`));
	if (progress.failed > 0) statusParts.push(theme.fg("error", `${progress.failed} failed`));
	
	const status = statusParts.length > 0 ? theme.fg("dim", " ⟨ ") + statusParts.join(theme.fg("dim", " · ")) + theme.fg("dim", " ⟩") : "";
	
	lines.push(`${theme.fg("muted", "Tasks:")} ${bar}  ${counts}${status}`);
	
	return lines;
}

export function renderWorkersCompact(
	workers: WorkerDisplayState[],
	theme: Theme,
	width: number,
): string[] {
	const lines: string[] = [];

	if (workers.length === 0) {
		return [theme.fg("dim", "No workers")];
	}

	// Summary line
	const working = workers.filter(w => w.status === "working").length;
	const complete = workers.filter(w => w.status === "complete").length;
	const failed = workers.filter(w => w.status === "failed").length;
	const totalCost = workers.reduce((sum, w) => sum + w.cost, 0);

	const summary = [
		theme.fg("warning", `${working} active`),
		theme.fg("success", `${complete} done`),
		...(failed > 0 ? [theme.fg("error", `${failed} failed`)] : []),
		theme.fg("muted", formatCost(totalCost)),
	].join(theme.fg("dim", " │ "));

	lines.push(`${theme.fg("muted", "Workers:")} ${summary}`);

	// Active workers detail - show task info
	// Include workers that are currently being auto-repaired
	const active = workers.filter(w =>
		w.status === "working" || w.status === "waiting" || w.repairState?.status === "running",
	);
	for (const w of active.slice(0, 4)) {
		// Override icon for repair state
		let icon: string;
		if (w.repairState?.status === "running") {
			icon = theme.fg("warning", "⟳");
		} else {
			icon = theme.fg(getStatusColor(w.status), getSpinnerFrame());
		}
		// Pad raw name first, then apply color (ANSI codes break padEnd)
		const namePadded = theme.fg("accent", w.name.padEnd(14));
		const time = theme.fg("dim", formatDuration(w.durationMs));
		const cost = theme.fg("muted", formatCost(w.cost));
		const ctx = w.contextPct ? theme.fg("dim", `${w.contextPct}%`) : "";
		
		// Calculate remaining space for task info
		// Base: "  " + icon(1) + " " + name(14) + " " + time(~6) + " " + cost(~6) + " " + ctx(~4)
		const baseLen = 2 + 1 + 1 + 14 + 1 + 6 + 1 + 6 + 1 + (w.contextPct ? 4 : 0) + 1;
		const taskSpace = Math.max(0, width - baseLen - 2);
		
		// Show repair status if active, otherwise show task ID and title
		let taskInfo = "";
		if (w.repairState?.status === "running") {
			// e.g. "TASK-02  auto-repair 2/3"
			const repairLabel = `auto-repair ${w.repairState.attempt}/${w.repairState.maxAttempts}`;
			const taskId = w.taskId ? `${w.taskId}  ` : "";
			taskInfo = `${theme.fg("accent", taskId)}${theme.fg("warning", repairLabel)}`;
		} else if (w.taskId || w.taskTitle) {
			const taskIdLen = w.taskId?.length || 0;
			const taskId = w.taskId ? theme.fg("accent", w.taskId) : "";
			// Reserve space for taskId + ": " separator
			const titleSpace = taskSpace - taskIdLen - (w.taskId && w.taskTitle ? 2 : 0);
			const title = w.taskTitle && titleSpace > 5 ? truncateText(w.taskTitle, titleSpace) : "";
			if (taskId && title) {
				taskInfo = `${taskId}${theme.fg("dim", ":")} ${theme.fg("muted", title)}`;
			} else if (taskId) {
				taskInfo = taskId;
			} else if (title) {
				taskInfo = theme.fg("muted", title);
			}
		} else if (w.currentTool) {
			// Fallback to showing current tool if no task info
			const file = w.currentFile ? ` ${truncateText(w.currentFile.split("/").pop() || "", 15)}` : "";
			taskInfo = theme.fg("dim", `${w.currentTool}${file}`);
		}
		
		lines.push(`  ${icon} ${namePadded} ${time} ${cost} ${ctx} ${taskInfo}`);

		if (w.lastOutput) {
			const preview = w.lastOutput
				.split('\n')
				.filter(l => l.trim())
				.slice(-8) // last 8 non-empty lines
				.join(' │ ');
			if (preview.length > 0) {
				const truncated = preview.length > 170 ? preview.slice(0, 167) + '…' : preview;
				lines.push(`      ${theme.fg("dim", truncated)}`);
			}
		}
	}

	if (active.length > 4) {
		lines.push(theme.fg("dim", `  ... +${active.length - 4} more`));
	}

	return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// Task-centric rendering
// ─────────────────────────────────────────────────────────────────────────────

export interface TaskCentricEntry {
	id: string;
	title: string;
	status: "pending" | "working" | "complete" | "failed";
	workerId?: string;
	workerName?: string;
	durationMs?: number;
	cost?: number;
	currentFile?: string;
	/** Populated while auto-repair is running for this task's worker */
	repairState?: {
		status: "running" | "success" | "failed";
		attempt: number;
		maxAttempts: number;
	};
}

/**
 * Task-centric coordination display: tasks are primary rows, assigned worker is annotation.
 * Falls back to renderWorkersCompact() when tasks array is empty.
 *
 * Example output:
 *   Tasks: ███████░░░░ 3/5 done · 2 active · ~12m remaining · $0.23
 *
 *     ✓ TASK-01  Scout codebase            calm_hawk   4m  $0.06
 *     ⠸ TASK-02  Fix auth middleware        swift_fox   8m  $0.09  ← edit middleware.ts
 *     ○ TASK-05  Integration test          (queued)
 */
export function renderTasksCentric(
	workers: WorkerDisplayState[],
	tasks: TaskCentricEntry[],
	theme: Theme,
	width: number,
): string[] {
	// Fall back to worker-centric view when no task data is available
	if (tasks.length === 0) {
		return renderWorkersCompact(workers, theme, width);
	}

	const lines: string[] = [];

	const complete = tasks.filter(t => t.status === "complete");
	const active   = tasks.filter(t => t.status === "working");
	const failed   = tasks.filter(t => t.status === "failed");
	const total    = tasks.length;
	const totalCost = tasks.reduce((sum, t) => sum + (t.cost ?? 0), 0);

	// ── ETA estimate ──────────────────────────────────────────────────────────
	// Average duration of completed tasks → rough remaining time
	let etaStr = "";
	if (complete.length > 0 && active.length > 0) {
		const completedWithDuration = complete.filter(t => (t.durationMs ?? 0) > 0);
		if (completedWithDuration.length > 0) {
			const avgMs = completedWithDuration.reduce((s, t) => s + (t.durationMs ?? 0), 0) / completedWithDuration.length;
			const remaining = tasks.filter(t => t.status !== "complete" && t.status !== "failed");
			const etaMs = avgMs * Math.max(0, remaining.length - active.length) + avgMs * 0.5 * active.length;
			if (etaMs > 0) {
				etaStr = theme.fg("dim", ` · ~${formatDuration(etaMs)} remaining`);
			}
		}
	}

	// ── Summary / header line ─────────────────────────────────────────────────
	const barWidth = Math.min(16, Math.max(8, Math.floor(width / 8)));
	const bar = renderProgressBar(complete.length, total, theme, barWidth);
	const doneLabel  = `${theme.fg("success", String(complete.length))}${theme.fg("dim", "/")}${theme.fg("muted", String(total))} done`;
	const activePart = active.length > 0 ? ` ${theme.fg("dim", "·")} ${theme.fg("warning", `${active.length} active`)}` : "";
	const failedPart = failed.length > 0 ? ` ${theme.fg("dim", "·")} ${theme.fg("error", `${failed.length} failed`)}` : "";
	const costPart   = totalCost > 0 ? ` ${theme.fg("dim", "·")} ${theme.fg("muted", formatCost(totalCost))}` : "";

	lines.push(`${theme.fg("muted", "Tasks:")} ${bar}  ${doneLabel}${activePart}${failedPart}${etaStr}${costPart}`);

	// ── Per-task rows ─────────────────────────────────────────────────────────
	// Layout constants (visible chars, no ANSI):
	//   "  " + icon(1) + " " + id(~7) + "  " + title + " " + workerCol + " " + time + " " + cost + " " + file
	const INDENT         = 2;
	const ICON_W         = 1;
	const ID_W           = 7; // "TASK-01"
	const WORKER_W       = 12; // memorable name padded
	const TIME_W         = 6;
	const COST_W         = 6;
	const FILE_ARROW_W   = 5; // " ← " + small file name
	const BASE_W         = INDENT + ICON_W + 1 + ID_W + 2 + 1 + WORKER_W + 1 + TIME_W + 1 + COST_W;
	const titleSpace     = Math.max(10, width - BASE_W - FILE_ARROW_W - 4);

	for (const task of tasks) {
		const isActive   = task.status === "working";
		const isComplete = task.status === "complete";
		const isFailed   = task.status === "failed";
		const isPending  = task.status === "pending";

		// Icon
		let icon: string;
		if (isActive) {
			icon = theme.fg("warning", getSpinnerFrame());
		} else if (isComplete) {
			icon = theme.fg("success", "✓");
		} else if (isFailed) {
			icon = theme.fg("error", "✗");
		} else {
			icon = theme.fg("dim", "○");
		}

		// Task ID
		const idColor   = isComplete ? "dim" : isFailed ? "error" : isActive ? "accent" : "dim";
		const idRaw     = task.id.padEnd(ID_W);
		const taskId    = theme.fg(idColor as Parameters<Theme["fg"]>[0], idRaw);

		// Title
		const titleRaw  = truncateText(task.title, titleSpace);
		const titleStr  = isComplete
			? theme.fg("dim", titleRaw.padEnd(titleSpace))
			: isFailed
				? theme.fg("error", titleRaw.padEnd(titleSpace))
				: isPending
					? theme.fg("dim", titleRaw.padEnd(titleSpace))
					: theme.fg("muted", titleRaw.padEnd(titleSpace));

		if (isPending) {
			// Queued row: no worker/cost/time
			const queuedLabel = theme.fg("dim", "(queued)");
			lines.push(`  ${icon} ${taskId}  ${titleStr} ${queuedLabel}`);
			continue;
		}

		// Worker name (right-aligned in fixed column)
		const workerRaw = (task.workerName ?? "").slice(0, WORKER_W).padEnd(WORKER_W);
		const workerStr = isComplete
			? theme.fg("dim", workerRaw)
			: theme.fg("accent", workerRaw);

		// Duration
		const timeStr = task.durationMs
			? theme.fg("dim", formatDuration(task.durationMs).padEnd(TIME_W))
			: theme.fg("dim", "--".padEnd(TIME_W));

		// Cost
		const costStr = task.cost !== undefined && task.cost > 0
			? theme.fg("muted", formatCost(task.cost).padEnd(COST_W))
			: theme.fg("dim", "".padEnd(COST_W));

		// Current file annotation (active tasks only) — or repair status
		let fileAnnotation = "";
		if (task.repairState?.status === "running") {
			const repairLabel = `auto-repair ${task.repairState.attempt}/${task.repairState.maxAttempts}`;
			fileAnnotation = `  ${theme.fg("warning", "⟳")} ${theme.fg("warning", repairLabel)}`;
		} else if (isActive && task.currentFile) {
			const fileName = task.currentFile.split("/").pop() || task.currentFile;
			const truncated = truncateText(fileName, 20);
			fileAnnotation = `  ${theme.fg("dim", "←")} ${theme.fg("dim", truncated)}`;
		}

		lines.push(`  ${icon} ${taskId}  ${titleStr} ${workerStr} ${timeStr} ${costStr}${fileAnnotation}`);
	}

	return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// File reservations rendering
// ─────────────────────────────────────────────────────────────────────────────

export function renderFileReservations(
	reservations: FileReservation[],
	theme: Theme,
	width: number,
): string[] {
	if (reservations.length === 0) return [];
	
	// Group by agent (worker), filtering out released reservations
	const byAgent = new Map<string, string[]>();
	for (const r of reservations) {
		if (r.releasedAt) continue; // Skip released
		const files = byAgent.get(r.agent) || [];
		files.push(...r.patterns);
		byAgent.set(r.agent, files);
	}
	
	// Don't show header if all reservations were released
	if (byAgent.size === 0) return [];
	
	const lines: string[] = [];
	lines.push(theme.fg("muted", "File reservations:"));
	
	for (const [agent, files] of byAgent) {
		const name = generateMemorableName(agent);
		const fileList = files.map(f => f.split("/").pop() || f).join(", ");
		const truncated = truncateText(fileList, width - name.length - 8);
		lines.push(`  ${theme.fg("accent", name)} → ${theme.fg("dim", truncated)}`);
	}
	
	return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tasks rendering
// ─────────────────────────────────────────────────────────────────────────────

export interface TaskDisplayState {
	id: string;
	status: string;
	description: string;
}

export function renderTasksCompact(
	tasks: TaskDisplayState[],
	theme: Theme,
	width: number,
): string[] {
	const lines: string[] = [];

	if (tasks.length === 0) {
		return [];
	}

	const claimed = tasks.filter(t => t.status === "claimed");
	const pending = tasks.filter(t => t.status === "pending");
	const complete = tasks.filter(t => t.status === "complete");
	const blocked = tasks.filter(t => t.status === "blocked");

	const summary = [
		...(claimed.length > 0 ? [theme.fg("warning", `${claimed.length} active`)] : []),
		...(pending.length > 0 ? [theme.fg("dim", `${pending.length} pending`)] : []),
		...(complete.length > 0 ? [theme.fg("success", `${complete.length} done`)] : []),
		...(blocked.length > 0 ? [theme.fg("muted", `${blocked.length} blocked`)] : []),
	].join(theme.fg("dim", ", "));

	lines.push(`${theme.fg("muted", "Tasks:")} ${theme.fg("success", String(complete.length))}${theme.fg("dim", "/")}${theme.fg("muted", String(tasks.length))} ${theme.fg("dim", "│")} ${summary}`);

	// Show active tasks
	for (const task of claimed.slice(0, 2)) {
		const icon = theme.fg("warning", ICONS.running);
		const id = theme.fg("accent", task.id);
		const desc = theme.fg("muted", truncateText(task.description, width - 25));
		lines.push(`  ${icon} ${id} ${desc}`);
	}

	return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// Events rendering
// ─────────────────────────────────────────────────────────────────────────────

export function renderEventLine(
	ev: CoordinationEvent,
	firstTs: number,
	theme: Theme,
	expanded: boolean = false,
): string {
	const elapsed = `+${((ev.timestamp - firstTs) / 1000).toFixed(1)}s`;
	const workerId = (ev as { workerId?: string }).workerId;
	const contextTokens = (ev as { contextTokens?: number }).contextTokens;

	// Determine source label
	let shortId: string;
	const phase = (ev as { phase?: string }).phase;
	if (ev.type === "cost_milestone" || ev.type === "cost_limit_reached") {
		shortId = "$";
	} else if (["phase_complete", "phase_completed", "phase_started", "session_started", "session_completed", "checkpoint_saved", "cost_updated", "review_started", "review_complete", "review_completed", "fix_started", "fix_completed", "fixes_started", "fixes_complete"].includes(ev.type)) {
		shortId = "sys";
	} else if (["coordinator", "planner_review_started", "planner_review_complete"].includes(ev.type)) {
		shortId = "co";
	} else if (ev.type === "activity") {
		shortId = phase || "sys";
	} else if (workerId === "scout") {
		shortId = "scout";
	} else if (workerId === "planner") {
		shortId = "plan";
	} else if (workerId === "coordinator") {
		shortId = "coord";
	} else if (workerId === "review") {
		shortId = "review";
	} else {
		shortId = workerId?.slice(0, 4) || "??";
	}

	// Context usage label
	const ctxLabel = contextTokens && contextTokens > 0 
		? ` ${formatContextUsage(contextTokens)}` 
		: "";

	let line = `${theme.fg("muted", elapsed.padEnd(8))}`;
	line += `${theme.fg("accent", `[${shortId}${ctxLabel}]`)} `;

	// Event-specific content
	switch (ev.type) {
		case "tool_call": {
			const file = ev.file || "";
			const maxLen = expanded ? 200 : 60;
			const displayFile = file.length > maxLen ? "..." + file.slice(-maxLen) : file;
			line += theme.fg("dim", `${ev.tool}${displayFile ? ` ${displayFile}` : ""}`);
			break;
		}
		case "tool_result":
			line += theme.fg("dim", `${ev.tool} ${ev.success ? "ok" : "error"}`);
			break;
		case "waiting":
			line += theme.fg("warning", `waiting for ${ev.item}`);
			break;
		case "contract_received": {
			const fromId = (ev as { from: string }).from.split("-").pop() || "??";
			line += theme.fg("success", `received contract from ${fromId}`);
			break;
		}
		case "worker_spawning": {
			const config = (ev as { config?: { logicalName?: string; handshakeSpec?: string } }).config;
			const name = config?.logicalName || workerId || "?";
			const spec = config?.handshakeSpec?.slice(0, 40) || "";
			line += theme.fg("warning", `spawning ${name}`) + (spec ? theme.fg("dim", ` ${spec}...`) : "");
			break;
		}
		case "worker_started":
			line += theme.fg("success", "started");
			break;
		case "worker_completed":
			line += theme.fg("success", "done");
			break;
		case "worker_failed":
			line += theme.fg("error", `FAILED: ${ev.error}`);
			break;
		case "cost_milestone": {
			const milestone = ev as { totals: Record<string, number>; aggregate: number };
			const totals = Object.entries(milestone.totals)
				.map(([id, cost]) => `${id.slice(0, 4)}: ${formatCost(cost)}`)
				.join(" │ ");
			line += theme.fg("muted", `${totals} │ total: ${formatCost(milestone.aggregate)}`);
			break;
		}
		case "coordinator": {
			const msg = (ev as { message: string }).message;
			line += theme.fg("dim", msg.slice(0, 50));
			break;
		}
		case "phase_complete":
			line += theme.fg("success", `${ev.phase} done (${formatCost(ev.cost)})`);
			break;
		case "phase_started":
			line += theme.fg("muted", `${(ev as { phase?: string }).phase || "?"} started`);
			break;
		case "phase_completed":
			line += theme.fg("success", `${(ev as { phase?: string }).phase || "?"} done`);
			break;
		case "cost_updated":
			line += theme.fg("dim", `cost: ${formatCost((ev as { total?: number }).total || 0)}`);
			break;
		case "checkpoint_saved":
			line += theme.fg("dim", "checkpoint");
			break;
		case "planner_review_started":
			line += theme.fg("muted", "reviewing tasks");
			break;
		case "planner_review_complete":
			line += theme.fg("success", "tasks approved");
			break;
		case "session_started":
			line += theme.fg("muted", "session started");
			break;
		case "session_completed":
			line += theme.fg("success", "session completed");
			break;
		case "cost_limit_reached":
			line += theme.fg("warning", `limit reached: ${formatCost((ev as { total: number }).total)}`);
			break;
		case "review_started":
			line += theme.fg("muted", "review started");
			break;
		case "review_complete":
		case "review_completed":
			line += theme.fg("success", "review complete");
			break;
		case "fix_started":
			line += theme.fg("muted", "fix started");
			break;
		case "fix_completed":
			line += theme.fg("success", "fix completed");
			break;
		case "fixes_started":
			line += theme.fg("muted", "fixes started");
			break;
		case "fixes_complete":
			line += theme.fg("success", "fixes complete");
			break;
		case "activity": {
			const actPhase = (ev as { phase?: string }).phase || "?";
			const actTokens = (ev as { contextTokens?: number }).contextTokens;
			line += theme.fg("dim", `${actPhase} working${actTokens ? ` (${Math.round(actTokens / 1000)}k tokens)` : ""}`);
			break;
		}
		default:
			line += theme.fg("dim", ev.type);
	}

	return line;
}

// ─────────────────────────────────────────────────────────────────────────────
// Box drawing
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Question buffer rendering (HANDRaiser pattern)
// ─────────────────────────────────────────────────────────────────────────────

export function renderQuestionBuffer(
	questions: Array<{ workerName: string; question: string; options?: string[] }>,
	theme: Theme,
	width: number,
): string[] {
	if (questions.length === 0) return [];

	const capped = questions.slice(0, 4); // max 4 per research
	const lines: string[] = [];

	// Border characters
	const TL = "╔";
	const TR = "╗";
	const BL = "╚";
	const BR = "╝";
	const H  = "═";
	const V  = "║";

	const innerWidth = Math.max(40, width - 2);
	const count = capped.length;
	const headerText = `  ✋ ${count} agent${count > 1 ? "s have" : " has"} question${count > 1 ? "s" : ""} — answer before review begins    `;
	const headerPadded = headerText.padEnd(innerWidth);

	// Top border with header
	lines.push(
		theme.fg("warning", TL + H.repeat(innerWidth) + TR),
	);
	lines.push(
		theme.fg("warning", V) +
		theme.fg("warning", headerPadded.slice(0, innerWidth)) +
		theme.fg("warning", V),
	);
	lines.push(
		theme.fg("warning", BL + H.repeat(innerWidth) + BR),
	);

	// Questions
	for (const q of capped) {
		const nameStr = theme.fg("accent", q.workerName.padEnd(12));
		const questionStr = theme.fg("muted", truncateText(q.question, innerWidth - 16));
		lines.push(`  ${nameStr}  ${questionStr}`);

		// Options as chips [A] opt1  [B] opt2
		if (q.options && q.options.length > 0) {
			const chips = q.options
				.slice(0, 4)
				.map((opt, i) => {
					const letter = String.fromCharCode(65 + i); // A, B, C, D
					return theme.fg("dim", `[${letter}]`) + " " + theme.fg("muted", opt);
				})
				.join("  ");
			lines.push(`              ${chips}`);
		}
	}

	return lines;
}

export function drawBoxTop(width: number, title: string, theme: Theme): string {
	const dim = (s: string) => theme.fg("borderMuted", s);
	const titlePart = title ? ` ${title} ` : "";
	const lineLen = width - visibleWidth(titlePart) - 3;
	return dim("╭─") + theme.fg("accent", titlePart) + dim("─".repeat(Math.max(0, lineLen))) + dim("╮");
}

export function drawBoxBottom(width: number, theme: Theme): string {
	const dim = (s: string) => theme.fg("borderMuted", s);
	return dim("╰") + dim("─".repeat(width - 2)) + dim("╯");
}

export function drawBoxLine(content: string, width: number, theme: Theme): string {
	const contentWidth = visibleWidth(content);
	const padding = Math.max(0, width - contentWidth - 2);
	return theme.fg("borderMuted", "│") + content + " ".repeat(padding) + theme.fg("borderMuted", "│");
}

// ─────────────────────────────────────────────────────────────────────────────
// 2026 Four-Level Coordination Dashboard
// Research-backed: Session → Phase → Tasks → Workers hierarchy
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Map a raw tool name to a short action verb for display.
 * Never show raw output in primary view — show file path + action only.
 */
function toolToAction(toolName: string | null | undefined): string {
	if (!toolName) return "";
	const lower = toolName.toLowerCase();
	if (lower.includes("edit") || lower.includes("write") || lower.includes("create")) return "edit";
	if (lower.includes("read") || lower.includes("cat") || lower.includes("view")) return "read";
	if (lower.includes("bash") || lower.includes("exec") || lower.includes("run") || lower.includes("shell")) return "bash";
	if (lower.includes("search") || lower.includes("grep") || lower.includes("find") || lower.includes("codebase")) return "search";
	if (lower.includes("web") || lower.includes("fetch") || lower.includes("url") || lower.includes("http")) return "fetch";
	// Fallback: first word up to 6 chars
	return lower.split(/[_\s]/)[0]?.slice(0, 6) ?? "";
}

/**
 * Compute ETA string from completed-task average and remaining task count.
 */
function computeEta(tasks: TaskCentricEntry[]): string {
	const completed = tasks.filter(t => t.status === "complete" && (t.durationMs ?? 0) > 0);
	const remaining = tasks.filter(t => t.status === "pending" || t.status === "working");
	if (completed.length === 0 || remaining.length === 0) return "";
	const avgMs = completed.reduce((s, t) => s + (t.durationMs ?? 0), 0) / completed.length;
	const active = tasks.filter(t => t.status === "working");
	// active tasks are ~50% of an avg task remaining; pending tasks are 100%
	const etaMs = avgMs * (remaining.length - active.length) + avgMs * 0.5 * active.length;
	if (etaMs <= 0) return "";
	return `ETA ~${formatDuration(etaMs)}`;
}

/**
 * renderCoordinationDashboard — 2026 four-level coordination display.
 *
 * Returns an array of lines (no box borders — caller adds them if desired):
 *
 *   Layer 1 — Session header (1 line)
 *   Layer 2 — Phase row  (1 line, reuses renderPipelineRow)
 *   [blank line]
 *   Layer 3 — Task progress (0 or 2 lines)
 *   Layer 4 — Active workers (max 4 rows + "+N more")
 */
export function renderCoordinationDashboard(
	planName: string,
	pipeline: PipelineDisplayState,
	workers: WorkerDisplayState[],
	tasks: TaskCentricEntry[],
	theme: Theme,
	width: number,
	/** Whether model routing is active (shows routing:on in header) */
	modelRoutingEnabled: boolean = true,
	costLimit?: number,
	/** Whether MCP lazy tool loading is active (shows lazy-tools:on in header) */
	lazyToolsEnabled: boolean = false,
): string[] {
	const lines: string[] = [];

	// ── Layer 1 — Session header ───────────────────────────────────────────────
	// coordinate <plan>    ⠸ 8m12s · $0.23 · ctx 62% · routing:on · lazy-tools:on
	{
		const spinner = theme.fg("warning", getSpinnerFrame());
		const elapsed = theme.fg("dim", formatDuration(pipeline.elapsed));

		// Determine cost color: yellow if ≥ 80% of cap
		const costColor: "muted" | "warning" | "error" = 
			costLimit && pipeline.cost >= costLimit * 0.8 
				? (pipeline.cost >= costLimit ? "error" : "warning")
				: "muted";
		const costDisplay = costLimit 
			? `${formatCost(pipeline.cost)} / ${formatCost(costLimit)} cap`
			: formatCost(pipeline.cost);
		const cost = theme.fg(costColor, costDisplay);

		// Context health: aggregate across workers, pick highest pressure
		const allCtx = workers.map(w => w.contextPct ?? 0);
		const maxCtx = allCtx.length > 0 ? Math.max(...allCtx) : 0;
		let ctxStr = "";
		if (maxCtx > 0) {
			const ctxColor: "success" | "warning" | "error" =
				maxCtx > 80 ? "error" : maxCtx > 50 ? "warning" : "success";
			ctxStr = " · " + theme.fg(ctxColor, `ctx ${maxCtx}%`);
		}

		// Routing indicator
		const routingStr = modelRoutingEnabled ? " · " + theme.fg("accent", "routing:on") : "";

		// Lazy tools indicator
		const lazyToolsStr = lazyToolsEnabled ? " · " + theme.fg("accent", "lazy-tools:on") : "";

		const leftLabel = theme.fg("dim", "coordinate ") + theme.fg("accent", piSafe(planName, 60));
		const rightLabel = `${spinner} ${elapsed} · ${cost}${ctxStr}${routingStr}${lazyToolsStr}`;

		const leftVis = visibleWidth(leftLabel);
		const rightVis = visibleWidth(rightLabel);
		const gap = Math.max(1, width - leftVis - rightVis);
		lines.push(piSafe(leftLabel + " ".repeat(gap) + rightLabel, 205));
	}

	// ── Layer 2 — Phase row ────────────────────────────────────────────────────
	lines.push(renderPipelineRow(pipeline, theme, width));

	// ── blank separator ────────────────────────────────────────────────────────
	lines.push("");

	// ── Layer 3 — Task progress (only when task data available) ───────────────
	if (tasks.length > 0) {
		const completed = tasks.filter(t => t.status === "complete").length;
		const total = tasks.length;
		const active = tasks.filter(t => t.status === "working");
		const etaStr = computeEta(tasks);

		// Progress bar: 10 chars (█ filled, ░ empty)
		const BAR_W = 10;
		const filledN = total > 0 ? Math.round((completed / total) * BAR_W) : 0;
		const emptyN = BAR_W - filledN;
		const barColor: "success" | "accent" | "warning" =
			completed / total >= 0.75 ? "success" : completed / total >= 0.4 ? "accent" : "warning";
		const bar = theme.fg(barColor, "█".repeat(filledN)) + theme.fg("dim", "░".repeat(emptyN));

		const countPart = `${theme.fg("success", String(completed))} / ${theme.fg("muted", String(total))}`;
		const activePart = active.length > 0 ? ` · ${theme.fg("warning", `${active.length} working`)}` : "";
		const etaPart = etaStr ? ` · ${theme.fg("dim", etaStr)}` : "";

		const label = theme.fg("muted", "Tasks");
		lines.push(`${label}  ${bar}  ${countPart}${activePart}${etaPart}`);

		// Second line: titles of ACTIVE tasks only, truncated to fit width
		if (active.length > 0) {
			const indent = " ".repeat(7); // "Tasks  " length
			const titleWidth = Math.max(0, width - 7);
			const titleParts = active.map(t =>
				theme.fg("dim", truncateText(`${t.id} ${t.title}`, Math.max(10, Math.floor(titleWidth / active.length) - 2))
			));
			lines.push(piSafe(indent + titleParts.join("  "), 205));
		}
	}

	// ── Layer 4 — Active workers (max 4, then "+N more") ──────────────────────
	// Show working first, then recently completed — so user sees progress.
	const working = workers.filter(w => w.status === "working" || w.status === "waiting");
	const recentDone = workers.filter(w => w.status === "complete" || w.status === "failed")
		.sort((a, b) => b.durationMs - a.durationMs); // most-recently-finished first
	const displayWorkers = [...working, ...recentDone].slice(0, 4);
	const overflowCount = workers.length - displayWorkers.length;

	for (const w of displayWorkers) {
		const isActive = w.status === "working" || w.status === "waiting";
		const icon = isActive
			? theme.fg("warning", getSpinnerFrame())
			: w.status === "complete"
				? theme.fg("success", "✓")
				: theme.fg("error", "✗");

		// Name: 12 chars padded (e.g. "swift_fox   ")
		const namePadded = theme.fg(isActive ? "accent" : "dim", piSafe(w.name, 60).slice(0, 12).padEnd(12));

		// Task ID: 7 chars
		const taskIdStr = w.taskId
			? theme.fg(isActive ? "accent" : "dim", w.taskId.padEnd(7))
			: " ".repeat(7);

		// Action + file (file path only, no raw output)
		let actionStr = "";
		if (!isActive && w.status === "complete") {
			actionStr = theme.fg("dim", "done");
		} else if (w.currentTool || w.currentFile) {
			const verb = toolToAction(w.currentTool);
			if (w.currentFile) {
				const filePath = w.currentFile.replace(/^\/[^/]+\/[^/]+\//, ""); // strip leading /Users/xxx/
				const maxFileLen = Math.max(10, width - 2 - 1 - 12 - 1 - 7 - 1 - 6 - 1 - 8 - 1 - 6 - 2);
				const truncated = truncateText(filePath, maxFileLen);
				actionStr = verb
					? theme.fg("dim", verb) + " " + theme.fg("muted", truncated)
					: theme.fg("muted", truncated);
			} else {
				actionStr = theme.fg("dim", verb);
			}
		} else if (w.taskTitle) {
			actionStr = theme.fg("dim", truncateText(w.taskTitle, 30));
		}
		actionStr = piSafe(actionStr, 80);

		// Duration + cost + ctx%
		const timeStr = theme.fg("dim", formatDuration(w.durationMs).padEnd(4));
		const costStr = theme.fg("muted", formatCost(w.cost));
		const ctxStr = w.contextPct != null
			? "  " + (w.contextPct > 80
				? theme.fg("error", `${w.contextPct}%`)
				: w.contextPct > 50
					? theme.fg("warning", `${w.contextPct}%`)
					: theme.fg("dim", `${w.contextPct}%`))
			: "";

		lines.push(`  ${icon} ${namePadded} ${taskIdStr} ${actionStr}  ${timeStr} ${costStr}${ctxStr}`);
	}

	if (overflowCount > 0) {
		lines.push(theme.fg("dim", `  +${overflowCount} more`));
	}

	return lines;
}

// Task Navigator TUI
// ─────────────────────────────────────────────────────────────────────────────

export type TaskNavView = "tasks" | "agent" | "mesh";

export interface TaskNavState {
	tasks: Task[];
	workers: WorkerStateFile[];
	meshMessages: MeshMessage[];
	selectedTaskIndex: number;
	activeView: TaskNavView;
	expandedTaskId: string | null;
	planName?: string;
	cost: number;
	costLimit: number;
	elapsedMs: number;
	currentPhase?: PipelinePhase;
	phases?: Partial<Record<PipelinePhase, PhaseResult | undefined>>;
	/** Pending escalation requests shown in QUESTION section */
	escalations?: EscalationRequest[];
	/** Live countdown (seconds remaining) per escalation id */
	escalationCountdowns?: Map<string, number>;
	/** Whether the user is typing a free-form :answer */
	escalationInputMode?: boolean;
	/** The Input component for :answer (rendered inline) */
	escalationInput?: Input;
	/** Status message after answering */
	escalationStatus?: string | null;
	/** Whether the DEVIATION accordion is open for the currently expanded task */
	deviationExpanded?: boolean;
	/** Whether raw logs are expanded inside the deviation accordion */
	rawLogsExpanded?: boolean;
	/** Whether the user is typing an intervention command (:send :retry :skip :pause :logs) */
	commandInputMode?: boolean;
	/** The Input component for command entry */
	commandInput?: Input;
	/** Status message after executing a command */
	commandStatus?: string | null;
}

/**
 * Split text into chunks that fit within maxW visible characters.
 */
function splitToWidth(text: string, maxW: number): string[] {
	if (maxW <= 0) return [text];
	const chunks: string[] = [];
	let remaining = text.trim();
	while (remaining.length > 0) {
		if (remaining.length <= maxW) {
			chunks.push(remaining);
			break;
		}
		// Try to split at word boundary
		let cut = maxW;
		const spaceIdx = remaining.lastIndexOf(" ", maxW);
		if (spaceIdx > maxW / 2) cut = spaceIdx + 1;
		chunks.push(remaining.slice(0, cut).trimEnd());
		remaining = remaining.slice(cut).trimStart();
	}
	return chunks;
}

/**
 * Render the top progress summary lines:
 *   plan-name
 *   ▰▰▰▱ 3/4 done · $3.21/$25 · 13m29s
 */
export function renderPlanProgress(
	tasks: Task[],
	cost: number,
	costLimit: number,
	elapsedMs: number,
	planName: string,
	theme: Theme,
	width: number,
): string[] {
	const done = tasks.filter((t) => t.status === "complete").length;
	const total = tasks.length;

	// Block-style progress bar (▰ filled, ▱ empty), 4 blocks
	const BAR_LEN = 4;
	const filled = total > 0 ? Math.round((done / total) * BAR_LEN) : 0;
	const empty = BAR_LEN - filled;
	const bar = theme.fg("success", "▰".repeat(filled)) + theme.fg("dim", "▱".repeat(empty));

	const countStr = `${done}/${total} done`;
	const costStr = `$${(cost ?? 0).toFixed(2)}/$${(costLimit ?? 0).toFixed(0)}`;
	const timeStr = formatDuration(elapsedMs);

	const summary = `${bar} ${countStr} · ${costStr} · ${timeStr}`;

	const lines: string[] = [];
	if (planName) {
		lines.push(theme.fg("accent", truncateText(planName, width)));
	}
	lines.push(summary);
	return lines;
}

/**
 * Render the view tab bar:
 *   [TASKS]  AGENT  MESH ─────── ↑↓:select  Tab:view
 */
export function renderViewTabs(
	activeView: TaskNavView,
	theme: Theme,
	width: number,
): string {
	const tabs = ["tasks", "agent", "mesh"] as const;
	const labels = tabs.map((t) => {
		const label = t.toUpperCase();
		if (t === activeView) return `[${label}]`;
		return ` ${label} `;
	});
	const tabStrs = tabs.map((t, i) => {
		if (t === activeView) return theme.fg("accent", labels[i]);
		return theme.fg("dim", labels[i]);
	});
	const tabStr = tabStrs.join(" ");
	const hints = "↑↓:select  Tab:view";
	const hintsW = visibleWidth(hints);
	const tabW = visibleWidth(tabStr);
	const sepLen = Math.max(1, width - tabW - hintsW - 3);
	const sep = theme.fg("dim", " " + "─".repeat(sepLen) + " ");
	return tabStr + sep + theme.fg("dim", hints);
}

/**
 * Render a single collapsed task row.
 *   ` ● T-01 sync-git-context ·········· done 2m14s`
 * Selected task gets `▸` prefix.
 */
export function renderCollapsedTask(
	task: Task,
	worker: WorkerStateFile | undefined,
	isSelected: boolean,
	_isExpanded: boolean,
	theme: Theme,
	width: number,
): string {
	// Status icon + color
	let icon: string;
	let iconColor: "success" | "warning" | "error" | "muted" | "dim" | "accent";
	switch (task.status) {
		case "complete":
			icon = "●";
			iconColor = "success";
			break;
		case "claimed":
			icon = "⯈";
			iconColor = "accent";
			break;
		case "blocked":
		case "failed":
			icon = "⚠";
			iconColor = "error";
			break;
		default:
			icon = "○";
			iconColor = "dim";
	}

	const prefix = isSelected ? theme.fg("accent", "▸") : " ";
	const styledIcon = theme.fg(iconColor, icon);

	// Deviation badge: ⚠N (shown on right side when deviations exist)
	const devCount = task.deviationLog?.length ?? 0;
	const devBadge = devCount > 0 ? `  ${theme.fg("warning", `⚠${devCount}`)}` : "";
	const devBadgeW = devCount > 0 ? 2 + 1 + String(devCount).length : 0; // "  ⚠" + digits

	// Right side: status + duration + badge
	let rightStr: string;
	if (task.status === "complete" && task.completedAt && task.claimedAt) {
		const dur = formatDuration(task.completedAt - task.claimedAt);
		rightStr = `done ${dur}`;
	} else if (task.status === "claimed" && worker) {
		const workerName = generateMemorableName(worker.identity);
		const dur = worker.startedAt ? formatDuration(Date.now() - worker.startedAt) : "";
		rightStr = `${workerName} ${dur}`.trim();
	} else {
		rightStr = task.status;
	}

	// Build: [prefix][icon] [taskId] [desc]·····[rightStr][devBadge]
	const leftFixed = `${prefix}${styledIcon} ${task.id} `;
	const leftFixedW = visibleWidth(leftFixed);
	const rightStrW = visibleWidth(rightStr);

	const rawDesc = task.planDescription || task.description;
	const descMaxW = width - leftFixedW - rightStrW - devBadgeW - 2;
	const desc = truncateText(rawDesc, Math.max(4, descMaxW));
	const descW = visibleWidth(desc);

	// Dot fill
	const dotFill = Math.max(1, width - leftFixedW - descW - rightStrW - devBadgeW);
	const dots = theme.fg("dim", "·".repeat(dotFill));
	const styledDesc = iconColor === "dim" ? theme.fg("muted", desc) : theme.fg(iconColor === "accent" ? "muted" : iconColor, desc);

	return `${leftFixed}${styledDesc}${dots}${theme.fg("dim", rightStr)}${devBadge}`;
}

/**
 * Render the expanded task panel with box-drawing.
 * Max ~12 lines. Sections hide when content is empty.
 */
export function renderExpandedTask(
	task: Task,
	worker: WorkerStateFile | undefined,
	theme: Theme,
	width: number,
	deviationExpanded?: boolean,
	rawLogsExpanded?: boolean,
	escalation?: EscalationRequest | null,
	escalationCountdownSecs?: number | null,
	escalationInputMode?: boolean,
	escalationInput?: Input | null,
	escalationStatus?: string | null,
	commandInputMode?: boolean,
	commandInput?: Input | null,
	commandStatus?: string | null,
): string[] {
	const lines: string[] = [];
	// Inner width = width - 4 (│ content │, each side has "│ " = 2 chars)
	const innerW = width - 4;

	const boxLine = (content: string): string => {
		const contentW = visibleWidth(content);
		const pad = Math.max(0, innerW - contentW);
		return theme.fg("dim", "│") + " " + content + " ".repeat(pad) + " " + theme.fg("dim", "│");
	};

	const divider = (): string =>
		theme.fg("dim", "├" + "─".repeat(width - 2) + "┤");

	let sectionCount = 0;
	const addDivider = () => {
		if (sectionCount > 0) lines.push(divider());
		sectionCount++;
	};

	lines.push(theme.fg("dim", "┌" + "─".repeat(width - 2) + "┐"));

	// PLAN + NOW + deviation section
	const planText = worker?.planIntent || task.planDescription || task.description;
	const nowText = worker?.currentProblem || "";

	addDivider();
	if (planText) {
		const planLabel = theme.fg("dim", "PLAN ");
		const planContent = theme.fg("muted", truncateText(planText, innerW - 6));
		lines.push(boxLine(`${planLabel} ${planContent}`));
	}
	if (nowText) {
		const nowLabel = theme.fg("dim", "NOW  ");
		const nowContent = theme.fg("muted", truncateText(nowText, innerW - 6));
		lines.push(boxLine(`${nowLabel} ${nowContent}`));
	}

	// Deviations — accordion (Tier 1 hint + Tier 2 detail)
	if (task.deviationLog && task.deviationLog.length > 0) {
		if (deviationExpanded) {
			// ── Tier 2: Full DEVIATION section ─────────────────────────────────
			addDivider();
			// Section header divider: ├ DEVIATION ────────┤
			const devTitle = " DEVIATION ";
			const devLineLen = Math.max(0, width - 2 - devTitle.length - 1);
			lines.push(
				theme.fg("dim", "├") +
				theme.fg("dim", " ") +
				theme.fg("warning", "DEVIATION") +
				theme.fg("dim", " " + "─".repeat(devLineLen)) +
				theme.fg("dim", "┤"),
			);

			// Render deviations newest-first
			const devsNewestFirst = [...task.deviationLog].reverse();
			for (const dev of devsNewestFirst) {
				const elapsed = `+${Math.round((Date.now() - dev.timestamp) / 1000)}s`;
				const elapsedStr = theme.fg("dim", elapsed);
				// Summary line: ⚠ +802s what-text
				const summaryText = truncateText(dev.what, innerW - elapsed.length - 4);
				lines.push(boxLine(`${theme.fg("warning", "⚠")} ${elapsedStr} ${theme.fg("muted", summaryText)}`));
				lines.push(boxLine(""));

				// WHAT/WHY/DECIDED/IMPACT
				const fieldW = innerW - 9; // "WHAT  " = 6 + 1 padding + 2 for box sides already
				const whatLabel = theme.fg("accent", "WHAT");
				lines.push(boxLine(`  ${whatLabel}  ${theme.fg("muted", truncateText(dev.what, fieldW))}`));

				const whyLines = splitToWidth(dev.why, Math.max(10, fieldW));
				const whyLabel = theme.fg("accent", "WHY");
				lines.push(boxLine(`  ${whyLabel}   ${theme.fg("muted", truncateText(whyLines[0] || "", fieldW))}`));
				for (const chunk of whyLines.slice(1, 2)) {
					lines.push(boxLine(`        ${theme.fg("dim", chunk)}`));
				}

				const decidedLabel = theme.fg("accent", "DECIDED");
				lines.push(boxLine(`  ${decidedLabel}  ${theme.fg("muted", truncateText(dev.decision, fieldW))}`));

				const impactLabel = theme.fg("accent", "IMPACT");
				lines.push(boxLine(`  ${impactLabel}   ${theme.fg("muted", truncateText(dev.impact, fieldW))}`));

				lines.push(boxLine(""));
			}

			// Raw logs toggle line
			const rawLogCount = worker?.recentTools?.length ?? 0;
			const rawLogsLabel = rawLogsExpanded
				? theme.fg("dim", "▾ Raw logs")
				: theme.fg("dim", "▸ Raw logs");
			const rawLogsCountStr = rawLogCount > 0 ? theme.fg("dim", ` (${rawLogCount} lines)`) : "";
			lines.push(boxLine(`${rawLogsLabel}${rawLogsCountStr}`));

			// ── Tier 3: Raw logs (if expanded) ─────────────────────────────────
			if (rawLogsExpanded && worker?.recentTools && worker.recentTools.length > 0) {
				const logTools = worker.recentTools.slice(-20);
				for (const entry of logTools) {
					const toolName = theme.fg("dim", entry.tool.padEnd(8));
					const argStr = theme.fg("muted", truncateText(entry.args || "", innerW - 10));
					lines.push(boxLine(`  ${toolName} ${argStr}`));
				}
			} else if (rawLogsExpanded) {
				// Fallback: show deviation details as pseudo-logs
				for (const dev of devsNewestFirst.slice(0, 20)) {
					const ts = new Date(dev.timestamp).toISOString().slice(11, 19);
					lines.push(boxLine(theme.fg("dim", `  [${ts}] ${truncateText(dev.what, innerW - 14)}`)));
				}
			}
		} else {
			// ── Tier 1 hint (collapsed): single ⚠ summary line + press d hint ──
			const lastDev = task.deviationLog[task.deviationLog.length - 1];
			const devCount = task.deviationLog.length;
			const countLabel = devCount > 1 ? theme.fg("dim", ` +${devCount - 1} more`) : "";
			const hintStr = theme.fg("dim", " [d]");
			const maxDevW = innerW - 2 - visibleWidth(countLabel) - visibleWidth(hintStr) - 1;
			lines.push(boxLine(
				`${theme.fg("warning", "⚠")} ${theme.fg("dim", truncateText(lastDev.what, maxDevW))}${countLabel}${hintStr}`,
			));
		}
	}

	// THINK section
	const thinkText = worker?.thinkingStream || "";
	if (thinkText) {
		addDivider();
		const thinkLabel = "THINK";
		const thinkSpace = innerW - thinkLabel.length - 2;
		const chunks = splitToWidth(thinkText, Math.max(10, thinkSpace));
		if (chunks.length > 0) {
			lines.push(boxLine(`${theme.fg("dim", thinkLabel)}  ${theme.fg("muted", chunks[0])}`));
			// Show second chunk with cursor indicator, indent matches label
			if (chunks.length > 1) {
				const indent = " ".repeat(thinkLabel.length + 2);
				lines.push(boxLine(`${indent}${theme.fg("dim", chunks[1])}▊`));
			}
		}
	}

	// ASSUME + questions section
	const assumptions = worker?.assumptions || [];
	if (assumptions.length > 0) {
		addDivider();
		const assumeStrs = assumptions.slice(0, 2).map((a) => {
			const statusMark = a.status === "verified" ? theme.fg("success", "✓") : theme.fg("dim", "?");
			return `${a.text} ${statusMark}`;
		});
		const assumeContent = truncateText(assumeStrs.join("  "), innerW - 8);
		lines.push(boxLine(`${theme.fg("dim", "ASSUME")} ${theme.fg("muted", assumeContent)}`));

		// Unverified assumption as question
		const unverified = assumptions.find((a) => a.status === "unverified");
		if (unverified) {
			lines.push(boxLine(`${theme.fg("warning", "❓")} ${theme.fg("dim", truncateText(unverified.text, innerW - 4))}`));
			lines.push(boxLine(theme.fg("dim", "   [1]Yes  [2]No  [3]Skip")));
		}
	}

	// QUESTION section — active escalation
	if (escalation) {
		addDivider();

		const options = escalation.richOptions?.length
			? escalation.richOptions
			: escalation.options.map((o) => ({ label: o, description: undefined as string | undefined }));

		const secs = escalationCountdownSecs ?? 0;
		const timeStr = secs > 0 ? `${secs}s` : "now";

		// Question text
		const qLabel = theme.fg("warning", "❓ QUESTION");
		const qText = truncateText(escalation.question, innerW - 14);
		lines.push(boxLine(`${qLabel}  ${theme.fg("muted", qText)}`));

		// Number-key options
		const optStrs = options
			.slice(0, 3)
			.map((o, i) => {
				const key = theme.fg("accent", `[${i + 1}]`);
				const label = truncateText(o.label, 20);
				return `${key} ${theme.fg("muted", label)}`;
			})
			.join("  ");
		lines.push(boxLine(`  ${optStrs}`));

		// :answer free-form or input field
		if (escalationInputMode && escalationInput) {
			const inputLines = escalationInput.render(innerW - 4);
			for (const line of inputLines) {
				lines.push(boxLine(`  ${line}`));
			}
		} else if (escalationStatus) {
			lines.push(boxLine(`  ${theme.fg("success", escalationStatus)}`));
		} else {
			lines.push(boxLine(`  ${theme.fg("dim", ":answer <text>  or  press [1][2][3]")}`));
		}

		// Agent assumption + countdown
		const assumption = escalation.agentAssumption
			? truncateText(escalation.agentAssumption, innerW - 30)
			: truncateText(options[escalation.defaultOption ?? 0]?.label ?? "", innerW - 30);
		const countdownColor: "error" | "warning" | "muted" = secs < 30 ? "error" : secs < 60 ? "warning" : "muted";
		const countdownStr = theme.fg(countdownColor, `auto-proceed in ${timeStr}`);
		lines.push(boxLine(`  ${theme.fg("dim", `assumes: ${assumption}`)}  ${countdownStr}`));
	}

	// INTERVENE commands
	addDivider();
	if (commandInputMode && commandInput) {
		// Show command input field
		const inputLines = commandInput.render(innerW - 4);
		for (const line of inputLines) {
			lines.push(boxLine(`  ${line}`));
		}
	} else if (commandStatus) {
		lines.push(boxLine(`  ${theme.fg("success", commandStatus)}`));
		lines.push(boxLine(theme.fg("dim", "  :send <msg>  :retry  :skip  :pause  :logs")));
	} else {
		lines.push(boxLine(theme.fg("dim", "  : to intervene  — :send :retry :skip :pause :logs")));
	}

	lines.push(theme.fg("dim", "└" + "─".repeat(width - 2) + "┘"));

	return lines;
}

/**
 * Render the MESH view tab content (last N messages).
 */
export function renderMeshView(
	messages: MeshMessage[],
	theme: Theme,
	width: number,
): string[] {
	const lines: string[] = [];

	const header = `MESH (${messages.length} recent)`;
	lines.push(theme.fg("accent", header));
	lines.push(theme.fg("dim", "─".repeat(Math.min(width, 49))));

	if (messages.length === 0) {
		lines.push(theme.fg("dim", "  No mesh messages"));
		return lines;
	}

	for (const msg of messages.slice(-20)) {
		const from = msg.from;
		const to = msg.to;
		const maxMsgW = Math.max(10, width - from.length - to.length - 5);
		const msgText = truncateText(msg.message, maxMsgW);
		const arrow = theme.fg("dim", "→");
		const fromStr = theme.fg("accent", from.padEnd(12));
		const toStr = theme.fg("muted", to.padEnd(10));
		lines.push(`${fromStr}${arrow}${toStr}  ${theme.fg("dim", msgText)}`);
	}

	return lines;
}

/**
 * Full task navigator rendering (TASKS / AGENT / MESH views).
 *
 * Returns an array of rendered lines for the given state.
 */
export function renderTaskNavigator(
	state: TaskNavState,
	theme: Theme,
	width: number,
): string[] {
	const lines: string[] = [];

	// Progress bar + plan name
	lines.push(...renderPlanProgress(
		state.tasks,
		state.cost,
		state.costLimit,
		state.elapsedMs,
		state.planName || "",
		theme,
		width,
	));

	// Pipeline phase row (secondary, below progress bar)
	if (state.currentPhase && state.phases) {
		const pipelineState: PipelineDisplayState = {
			currentPhase: state.currentPhase,
			phases: state.phases as Record<PipelinePhase, PhaseResult | undefined>,
			cost: state.cost,
			elapsed: state.elapsedMs,
		};
		lines.push(renderPipelineRow(pipelineState, theme, width));
	}

	// View tabs
	lines.push(renderViewTabs(state.activeView, theme, width));

	const sep = theme.fg("dim", "─".repeat(width));

	if (state.activeView === "mesh") {
		lines.push(sep);
		lines.push(...renderMeshView(state.meshMessages.slice(-20), theme, width));
		return lines;
	}

	if (state.activeView === "agent") {
		// Full-screen expanded panel for selected task
		const task = state.tasks[state.selectedTaskIndex];
		if (task) {
			const worker = state.workers.find((w) => w.id === task.claimedBy);
			const escalation = state.escalations?.[0] ?? null;
			const countdown = escalation ? (state.escalationCountdowns?.get(escalation.id) ?? null) : null;
			lines.push(sep);
			lines.push(...renderExpandedTask(
				task, worker, theme, width,
				state.deviationExpanded, state.rawLogsExpanded,
				escalation, countdown,
				state.escalationInputMode, state.escalationInput, state.escalationStatus,
				state.commandInputMode, state.commandInput, state.commandStatus,
			));
		} else {
			lines.push(sep);
			lines.push(theme.fg("dim", "  No task selected"));
		}
		return lines;
	}

	// TASKS view: list of tasks with optional expanded panel
	for (let i = 0; i < state.tasks.length; i++) {
		const task = state.tasks[i];
		const worker = state.workers.find((w) => w.id === task.claimedBy);
		const isSelected = i === state.selectedTaskIndex;
		const isExpanded = task.id === state.expandedTaskId;

		lines.push(sep);
		lines.push(renderCollapsedTask(task, worker, isSelected, isExpanded, theme, width));

		if (isExpanded) {
			// Only show escalation in the expanded panel for the selected task
			const escalation = state.escalations?.[0] ?? null;
			const countdown = escalation ? (state.escalationCountdowns?.get(escalation.id) ?? null) : null;
			lines.push(...renderExpandedTask(
				task, worker, theme, width,
				state.deviationExpanded, state.rawLogsExpanded,
				isSelected ? escalation : null, isSelected ? countdown : null,
				isSelected ? state.escalationInputMode : undefined,
				isSelected ? state.escalationInput : undefined,
				isSelected ? state.escalationStatus : undefined,
				isSelected ? state.commandInputMode : undefined,
				isSelected ? state.commandInput : undefined,
				isSelected ? state.commandStatus : undefined,
			));
		}
	}

	lines.push(sep);

	// MESH preview at bottom (last 3 messages)
	if (state.meshMessages.length > 0) {
		lines.push(...renderMeshView(state.meshMessages.slice(-3), theme, width));
	}

	return lines;
}
