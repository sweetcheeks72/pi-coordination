import * as fs from "node:fs";
import * as path from "node:path";
import type { Component } from "@mariozechner/pi-tui";
import { Input, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { sendNudge } from "./nudge.js";
import { getControls, hasControls, hasSteer, getSteer, getAbort } from "./worker-control-registry.js";
import type {
	WorkerStateFile,
	CoordinationEvent,
	CostState,
	PipelineState,
	Task,
	PipelinePhase,
	TaskQueue,
	PhaseResult,
	Checkpoint,
} from "./types.js";

interface DashboardState {
	pipelineState: PipelineState | null;
	costState: CostState;
	workers: WorkerStateFile[];
	events: CoordinationEvent[];
	tasks: Task[];
	startedAt: number;
}

const POLL_INTERVAL_MS = 1000;

const PHASE_ORDER: PipelinePhase[] = ["scout", "planner", "coordinator", "workers", "integration", "review", "fixes", "complete", "failed"];

function formatDuration(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function formatCost(cost: number): string {
	return `$${cost.toFixed(2)}`;
}

function padToWidth(str: string, targetWidth: number): string {
	const currentWidth = visibleWidth(str);
	if (currentWidth >= targetWidth) return str;
	return str + " ".repeat(targetWidth - currentWidth);
}

function readJsonSync<T>(filePath: string): T | null {
	try {
		if (!fs.existsSync(filePath)) return null;
		const content = fs.readFileSync(filePath, "utf-8");
		return JSON.parse(content) as T;
	} catch {
		return null;
	}
}

function readJsonlSync<T>(filePath: string): T[] {
	try {
		if (!fs.existsSync(filePath)) return [];
		const content = fs.readFileSync(filePath, "utf-8");
		const results: T[] = [];
		for (const line of content.trim().split("\n")) {
			if (!line) continue;
			try {
				results.push(JSON.parse(line) as T);
			} catch {
				// Skip malformed lines
			}
		}
		return results;
	} catch {
		return [];
	}
}

function readLatestCheckpointSync(coordDir: string): Checkpoint | null {
	try {
		const checkpointsDir = path.join(coordDir, "checkpoints");
		if (!fs.existsSync(checkpointsDir)) return null;
		const files = fs.readdirSync(checkpointsDir).filter((f) => f.endsWith(".json"));
		if (files.length === 0) return null;
		const sorted = files.sort((a, b) => {
			const tsA = parseInt(a.split("-").pop()?.replace(".json", "") || "0", 10);
			const tsB = parseInt(b.split("-").pop()?.replace(".json", "") || "0", 10);
			return tsB - tsA;
		});
		return readJsonSync<Checkpoint>(path.join(checkpointsDir, sorted[0]));
	} catch {
		return null;
	}
}

function readWorkerStatesSync(coordDir: string): WorkerStateFile[] {
	try {
		const files = fs.readdirSync(coordDir);
		const workerFiles = files.filter((f) => f.startsWith("worker-") && f.endsWith(".json"));
		const states: WorkerStateFile[] = [];
		for (const file of workerFiles) {
			const state = readJsonSync<WorkerStateFile>(path.join(coordDir, file));
			if (state) states.push(state);
		}
		return states;
	} catch {
		return [];
	}
}

function parsePipelineFromProgress(content: string): Partial<PipelineState> {
	const result: Partial<PipelineState> = {};
	for (const line of content.split("\n")) {
		if (line.includes("**Current Phase:**")) {
			const match = line.match(/\*\*Current Phase:\*\*\s*([a-zA-Z_-]+)/);
			if (match) result.currentPhase = match[1] as PipelinePhase;
		}
		if (line.includes("**Started:**")) {
			const match = line.match(/\*\*Started:\*\*\s*(.+)/);
			if (match) {
				const date = new Date(match[1].trim());
				if (!isNaN(date.getTime())) result.startedAt = date.getTime();
			}
		}
	}
	return result;
}

export class CoordinationDashboard implements Component {
	private tui: { requestRender: () => void };
	private coordDir: string;
	private theme: Theme;
	private onDone: (installFooter: boolean) => void;
	private pollInterval: NodeJS.Timeout | null = null;
	private disposed = false;

	private selectedWorkerIndex = 0;
	private overlay: "worker" | "tasks" | null = null;

	private state: DashboardState | null = null;
	private lastPollError: string | null = null;

	private inputMode = false;
	private steerInput: Input;
	private steerStatus: string | null = null; // "[sent ✓]" or "[error: ...]"
	private steerStatusTimeout: NodeJS.Timeout | null = null;

	constructor(
		tui: { requestRender: () => void },
		coordDir: string,
		theme: Theme,
		onDone: (installFooter: boolean) => void,
	) {
		this.tui = tui;
		this.coordDir = coordDir;
		this.theme = theme;
		this.onDone = onDone;
		this.steerInput = new Input();
		this.steerInput.onSubmit = (value) => this.handleSteerSubmit(value);
		this.steerInput.onEscape = () => {
			this.inputMode = false;
			this.tui.requestRender();
		};
		this.poll();
		this.startPolling();
	}

	render(width: number): string[] {
		if (this.overlay === "worker") return this.renderWorkerDetails(width);
		if (this.overlay === "tasks") return this.renderTaskQueue(width);
		return this.renderMainDashboard(width);
	}

	handleInput(data: string): void {
		// Clear input mode if worker is no longer steering-capable
		if (this.inputMode) {
			const w = this.state?.workers[this.selectedWorkerIndex];
			if (!w || w.status !== "working" || !hasSteer(w.id)) {
				this.inputMode = false;
				this.showSteerStatus("[worker no longer available]");
				return; // Don't process keystroke as command
			}
		}

		if (this.overlay === "worker" && this.inputMode) {
			// Delegate to Input component (handles escape internally)
			this.steerInput.handleInput(data);
			this.tui.requestRender();
			return;
		}

		if (this.overlay) {
			if (matchesKey(data, "escape")) {
				this.overlay = null;
				this.inputMode = false;
				this.steerStatus = null;
				this.tui.requestRender();
				return;
			}
			if (this.overlay === "worker") {
				const w = this.state?.workers[this.selectedWorkerIndex];

				// [i] - Enter input mode for steering
				if (data === "i" && w && w.status === "working" && hasSteer(w.id)) {
					this.inputMode = true;
					this.steerInput.setValue("");
					this.tui.requestRender();
					return;
				}

				// [x] - Abort session (via SDK session.abort)
				if (data === "x" && w && w.status === "working") {
					const abort = getAbort(w.id);
					if (abort) {
						abort();
						this.showSteerStatus("[abort signal sent]");
					}
					return;
				}

				if (data === "w") this.wrapUpWorker();
				// [R]estart and [A]bort use nudges which call process.exit() - unsafe for SDK workers
				const isSDKWorker = w && hasControls(w.id);
				if (data === "R" && !isSDKWorker) this.restartWorker();
				if (data === "A" && !isSDKWorker) this.abortWorker();
			}
			return;
		}

		if (matchesKey(data, "j") || matchesKey(data, "down")) {
			this.selectNext();
			this.tui.requestRender();
		} else if (matchesKey(data, "k") || matchesKey(data, "up")) {
			this.selectPrev();
			this.tui.requestRender();
		} else if (matchesKey(data, "enter")) {
			if (this.state && this.state.workers.length > 0) {
				this.overlay = "worker";
				this.tui.requestRender();
			}
		} else if (data === "t") {
			if (this.state) {
				this.overlay = "tasks";
				this.tui.requestRender();
			}
		} else if (data === "w") {
			this.wrapUpWorker();
		} else if (data === "R" || data === "A") {
			// [R]estart and [A]bort use nudges which call process.exit()
			// Only safe for subprocess workers, not SDK workers
			const w = this.state?.workers[this.selectedWorkerIndex];
			const isSDKWorker = w && hasControls(w.id);
			if (!isSDKWorker) {
				if (data === "R") this.restartWorker();
				if (data === "A") this.abortWorker();
			}
		} else if (data === "r") {
			this.poll();
			this.tui.requestRender();
		} else if (matchesKey(data, "q") || matchesKey(data, "escape")) {
			this.dispose();
			this.onDone(true);
		} else if (data === "Q") {
			this.dispose();
			this.onDone(false);
		}
	}

	invalidate(): void {}

	dispose(): void {
		this.disposed = true;
		this.stopPolling();
		if (this.steerStatusTimeout) {
			clearTimeout(this.steerStatusTimeout);
			this.steerStatusTimeout = null;
		}
	}

	private renderMainDashboard(width: number): string[] {
		const th = this.theme;
		const lines: string[] = [];

		if (!this.state) {
			lines.push(th.fg("error", "Loading..."));
			return lines;
		}

		if (this.lastPollError) {
			lines.push(th.fg("error", `Error: ${this.lastPollError}`));
		}

		const innerWidth = width - 4;

		lines.push(this.renderBorder("top", innerWidth, "Coordination"));
		lines.push(...this.renderPipelineSection(innerWidth));
		lines.push(...this.renderHeaderInBox(innerWidth));
		lines.push(this.renderBorder("middle", innerWidth, `Task Queue (${this.state.tasks.length})`));
		lines.push(...this.renderTaskQueueSection(innerWidth));
		lines.push(this.renderBorder("middle", innerWidth, `Workers (${this.state.workers.length})`));
		lines.push(...this.renderWorkerGrid(innerWidth));
		lines.push(this.renderBorder("middle", innerWidth, "Events"));
		lines.push(...this.renderEventStream(innerWidth));
		lines.push(this.renderBorder("middle", innerWidth, "Cost Breakdown"));
		lines.push(...this.renderCostSection(innerWidth));
		lines.push(this.renderBorder("bottom", innerWidth, ""));
		lines.push(...this.renderHelpLine(width));

		return lines;
	}

	private renderHeaderInBox(width: number): string[] {
		const th = this.theme;
		const state = this.state!;

		const elapsed = formatDuration(Date.now() - state.startedAt);
		const cost = formatCost(state.costState.total);
		const limit = formatCost(state.costState.limit);

		const left = ` ${th.fg("dim", "Cost:")} ${cost} / ${limit} limit`;
		const right = `${th.fg("dim", "Elapsed:")} ${elapsed}`;
		const padding = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right) - 1));
		const content = left + padding + right;
		const paddedContent = content + " ".repeat(Math.max(0, width - visibleWidth(content) - 1));

		return [th.fg("borderMuted", " \u2502") + paddedContent + th.fg("borderMuted", "\u2502")];
	}

	private renderBorder(type: "top" | "middle" | "bottom", width: number, title: string): string {
		const th = this.theme;
		const dim = (s: string) => th.fg("borderMuted", s);

		if (type === "top") {
			const titlePart = title ? ` ${title} ` : "";
			const lineLen = width - titlePart.length;
			return dim(" \u250c") + dim("\u2500") + th.fg("accent", titlePart) + dim("\u2500".repeat(Math.max(0, lineLen - 2))) + dim("\u2510");
		} else if (type === "middle") {
			const titlePart = title ? ` ${title} ` : "";
			const lineLen = width - titlePart.length;
			return dim(" \u251c") + dim("\u2500") + th.fg("muted", titlePart) + dim("\u2500".repeat(Math.max(0, lineLen - 2))) + dim("\u2524");
		} else {
			return dim(" \u2514") + dim("\u2500".repeat(width - 1)) + dim("\u2518");
		}
	}

	private renderPipelineSection(width: number): string[] {
		const th = this.theme;
		const state = this.state!;
		const currentPhase = state.pipelineState?.currentPhase || "unknown";

		const phases: PipelinePhase[] = ["scout", "planner", "workers", "review", "complete"];
		const parts: string[] = [];

		for (const phase of phases) {
			const phaseResult = state.pipelineState?.phases?.[phase];
			const status = phaseResult?.status || "pending";

			let icon: string;
			let styled: string;

			const isCurrentPhase = phase === currentPhase ||
				(phase === "workers" && (currentPhase === "coordinator" || currentPhase === "fixes"));

			if (isCurrentPhase && status === "running") {
				icon = "\u25cf";
				styled = th.fg("warning", `[${phase} ${icon}]`);
			} else if (status === "complete") {
				icon = "\u2713";
				styled = th.fg("success", `[${phase} ${icon}]`);
			} else if (status === "failed") {
				icon = "\u2717";
				styled = th.fg("error", `[${phase} ${icon}]`);
			} else if (isCurrentPhase) {
				icon = "\u25cf";
				styled = th.fg("warning", `[${phase} ${icon}]`);
			} else {
				styled = th.fg("dim", `[${phase}]`);
			}

			parts.push(styled);
		}

		const pipeline = " " + th.fg("dim", "Pipeline: ") + parts.join(th.fg("dim", " \u2192 "));
		const truncated = truncateToWidth(pipeline, width - 1);
		const paddedContent = truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated) - 1));
		return [th.fg("borderMuted", " \u2502") + paddedContent + th.fg("borderMuted", "\u2502")];
	}

	private renderWorkerGrid(width: number): string[] {
		const th = this.theme;
		const state = this.state!;
		const lines: string[] = [];

		if (state.workers.length === 0) {
			const empty = th.fg("dim", "  No workers yet");
			lines.push(th.fg("borderMuted", " \u2502") + empty + " ".repeat(Math.max(0, width - visibleWidth(empty) - 1)) + th.fg("borderMuted", "\u2502"));
			return lines;
		}

		const maxRows = 6;
		const startIdx = Math.max(0, Math.min(this.selectedWorkerIndex - Math.floor(maxRows / 2), state.workers.length - maxRows));
		const endIdx = Math.min(startIdx + maxRows, state.workers.length);
		const workers = state.workers.slice(startIdx, endIdx);

		if (startIdx > 0) {
			const more = th.fg("dim", `  ... ${startIdx} more above`);
			lines.push(th.fg("borderMuted", " \u2502") + more + " ".repeat(Math.max(0, width - visibleWidth(more) - 1)) + th.fg("borderMuted", "\u2502"));
		}

		for (let i = 0; i < workers.length; i++) {
			const actualIdx = startIdx + i;
			const w = workers[i];
			const isSelected = actualIdx === this.selectedWorkerIndex;

			const prefix = isSelected ? th.fg("accent", " \u2192 ") : "   ";
			const id = w.shortId || w.id.slice(0, 4);

			let statusIcon: string;
			let statusColor: "success" | "warning" | "error" | "muted";
			switch (w.status) {
				case "complete":
					statusIcon = "\u2713";
					statusColor = "success";
					break;
				case "working":
					statusIcon = "\u25cf";
					statusColor = "warning";
					break;
				case "waiting":
				case "blocked":
					statusIcon = "\u25cb";
					statusColor = "muted";
					break;
				case "failed":
					statusIcon = "\u2717";
					statusColor = "error";
					break;
				default:
					statusIcon = "\u25cb";
					statusColor = "muted";
			}

			const statusStr = th.fg(statusColor, `${statusIcon} ${padToWidth(w.status, 8)}`);
			const fileName = w.currentFile ? path.basename(w.currentFile) : "----";
			const file = padToWidth(truncateToWidth(fileName, 12), 12);
			const duration = w.startedAt ? formatDuration(Date.now() - w.startedAt).padEnd(7) : "---".padEnd(7);
			const cost = formatCost(w.usage?.cost || 0).padEnd(7);
			const turns = `${w.usage?.turns || 0} turns`.padEnd(9);

			const progress = this.renderProgressBar(w, 10);

			const row = `${prefix}${padToWidth(id, 6)} ${file} ${statusStr} ${duration} ${cost} ${turns} ${progress}`;
			const truncatedRow = truncateToWidth(row, width - 1);
			const paddedRow = truncatedRow + " ".repeat(Math.max(0, width - visibleWidth(truncatedRow) - 1));

			lines.push(th.fg("borderMuted", " \u2502") + paddedRow + th.fg("borderMuted", "\u2502"));
		}

		if (endIdx < state.workers.length) {
			const more = th.fg("dim", `  ... ${state.workers.length - endIdx} more below`);
			lines.push(th.fg("borderMuted", " \u2502") + more + " ".repeat(Math.max(0, width - visibleWidth(more) - 1)) + th.fg("borderMuted", "\u2502"));
		}

		return lines;
	}

	private renderProgressBar(worker: WorkerStateFile, barWidth: number): string {
		const th = this.theme;
		const completed = worker.completedSteps?.length || 0;
		const total = worker.assignedSteps?.length || 1;
		const percent = Math.min(100, Math.round((completed / total) * 100));
		const filled = Math.round((percent / 100) * barWidth);
		const empty = barWidth - filled;
		return th.fg("success", "\u2588".repeat(filled)) + th.fg("dim", "\u2591".repeat(empty));
	}

	private renderTaskQueueSection(width: number): string[] {
		const th = this.theme;
		const state = this.state!;
		const lines: string[] = [];

		if (state.tasks.length === 0) {
			const empty = th.fg("dim", "  No tasks");
			lines.push(th.fg("borderMuted", " \u2502") + empty + " ".repeat(Math.max(0, width - visibleWidth(empty) - 1)) + th.fg("borderMuted", "\u2502"));
			return lines;
		}

		const maxTasks = 4;
		const tasks = state.tasks.slice(0, maxTasks);

		for (const task of tasks) {
			let icon: string;
			let color: "success" | "warning" | "error" | "muted";

			switch (task.status) {
				case "complete":
					icon = "\u2713";
					color = "success";
					break;
				case "claimed":
					icon = "\u25cf";
					color = "warning";
					break;
				case "failed":
					icon = "\u2717";
					color = "error";
					break;
				case "blocked":
					icon = "\u25cb";
					color = "error";
					break;
				default:
					icon = "\u25cb";
					color = "muted";
			}

			const statusIcon = th.fg(color, icon);
			const taskId = padToWidth(task.id, 10);
			const desc = padToWidth(truncateToWidth(task.description, 35), 35);
			const status = padToWidth(task.status, 10);
			const worker = task.claimedBy ? `worker:${task.claimedBy.slice(0, 4)}` : task.dependsOn?.length ? `deps: ${task.dependsOn.join(",")}` : "";

			const row = `  ${statusIcon} ${taskId} ${desc} ${th.fg(color, status)} ${th.fg("dim", worker)}`;
			const truncatedRow = truncateToWidth(row, width - 1);
			const paddedRow = truncatedRow + " ".repeat(Math.max(0, width - visibleWidth(truncatedRow) - 1));

			lines.push(th.fg("borderMuted", " \u2502") + paddedRow + th.fg("borderMuted", "\u2502"));
		}

		if (state.tasks.length > maxTasks) {
			const more = th.fg("dim", `  ... and ${state.tasks.length - maxTasks} more tasks`);
			lines.push(th.fg("borderMuted", " \u2502") + more + " ".repeat(Math.max(0, width - visibleWidth(more) - 1)) + th.fg("borderMuted", "\u2502"));
		}

		return lines;
	}

	private renderEventStream(width: number): string[] {
		const th = this.theme;
		const state = this.state!;
		const lines: string[] = [];

		if (state.events.length === 0) {
			const empty = th.fg("dim", "  No events yet");
			lines.push(th.fg("borderMuted", " \u2502") + empty + " ".repeat(Math.max(0, width - visibleWidth(empty) - 1)) + th.fg("borderMuted", "\u2502"));
			return lines;
		}

		const maxEvents = 5;
		const events = state.events.slice(-maxEvents);

		for (const event of events) {
			const elapsed = formatDuration(event.timestamp - state.startedAt);
			const time = th.fg("dim", `+${elapsed.padEnd(7)}`);

			let source: string;
			let message: string;

			if ("workerId" in event && event.workerId) {
				source = th.fg("accent", `[${event.workerId.slice(0, 4)}]`);
			} else {
				source = th.fg("muted", "[sys]");
			}

			switch (event.type) {
				case "tool_call":
					message = `${event.tool}${event.file ? ` ${event.file}` : ""}`;
					break;
				case "tool_result":
					message = `${event.tool} ${event.success ? th.fg("success", "ok") : th.fg("error", "failed")}`;
					break;
				case "worker_started":
					message = th.fg("muted", "started");
					break;
				case "worker_completed":
					message = th.fg("success", "completed");
					break;
				case "worker_failed":
					message = th.fg("error", `failed: ${event.error}`);
					break;
				case "waiting":
					message = `waiting for ${event.waitingFor}: ${event.item}`;
					break;
				case "cost_milestone":
					message = th.fg("warning", `cost milestone: ${formatCost(event.aggregate)}`);
					break;
				case "phase_complete":
					message = th.fg("success", `phase ${event.phase} complete`);
					break;
				case "contract_received":
					message = `received ${event.item} from ${event.from}`;
					break;
				case "coordinator":
					message = th.fg("muted", event.message);
					break;
				case "cost_limit_reached":
					message = th.fg("error", `cost limit reached: ${formatCost(event.total)} / ${formatCost(event.limit)}`);
					break;
				case "session_started":
					message = th.fg("muted", "session started");
					break;
				case "session_completed":
					message = th.fg("success", "session completed");
					break;
				case "phase_started":
					message = th.fg("muted", `phase ${(event as { phase?: string }).phase || "?"} started`);
					break;
				case "phase_completed":
					message = th.fg("success", `phase ${(event as { phase?: string }).phase || "?"} done`);
					break;
				case "cost_updated": {
					const costEvent = event as { total?: number };
					message = th.fg("muted", `cost: ${formatCost(costEvent.total || 0)}`);
					break;
				}
				case "checkpoint_saved":
					message = th.fg("muted", "checkpoint saved");
					break;
				case "planner_review_started":
					message = th.fg("muted", "planner reviewing task");
					break;
				case "planner_review_complete":
					message = th.fg("success", "planner review done");
					break;
				default: {
					const unknownEvent = event as { type: string };
					message = th.fg("warning", unknownEvent.type || "??");
				}
			}

			const row = `  ${time} ${source} ${message}`;
			const truncated = truncateToWidth(row, width - 1);
			const paddedRow = truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated) - 1));

			lines.push(th.fg("borderMuted", " \u2502") + paddedRow + th.fg("borderMuted", "\u2502"));
		}

		return lines;
	}

	private renderCostSection(width: number): string[] {
		const th = this.theme;
		const state = this.state!;
		const lines: string[] = [];

		const byPhase = state.costState.byPhase || {};
		const phaseParts: string[] = [];
		for (const phase of PHASE_ORDER) {
			const cost = byPhase[phase];
			if (cost && cost > 0) {
				phaseParts.push(`${phase} ${formatCost(cost)}`);
			}
		}
		const phaseRow = `  ${th.fg("dim", "By Phase:")} ${phaseParts.join(th.fg("dim", " | ")) || th.fg("dim", "--")}`;
		const truncatedPhaseRow = truncateToWidth(phaseRow, width - 1);
		lines.push(th.fg("borderMuted", " \u2502") + truncatedPhaseRow + " ".repeat(Math.max(0, width - visibleWidth(truncatedPhaseRow) - 1)) + th.fg("borderMuted", "\u2502"));

		const byWorker = state.costState.byWorker || {};
		const workerParts: string[] = [];
		for (const [workerId, cost] of Object.entries(byWorker)) {
			if (cost > 0) {
				workerParts.push(`${workerId.slice(0, 4)} ${formatCost(cost)}`);
			}
		}
		const workerRow = `  ${th.fg("dim", "By Worker:")} ${workerParts.slice(0, 6).join(th.fg("dim", " | ")) || th.fg("dim", "--")}`;
		const truncatedWorkerRow = truncateToWidth(workerRow, width - 1);
		lines.push(th.fg("borderMuted", " \u2502") + truncatedWorkerRow + " ".repeat(Math.max(0, width - visibleWidth(truncatedWorkerRow) - 1)) + th.fg("borderMuted", "\u2502"));

		return lines;
	}

	private renderHelpLine(width: number): string[] {
		const th = this.theme;
		const help = [
			`${th.fg("accent", "[j/k]")} select`,
			`${th.fg("accent", "[Enter]")} details`,
			`${th.fg("accent", "[w]")}rap up`,
			`${th.fg("accent", "[R]")}estart`,
			`${th.fg("accent", "[A]")}bort`,
			`${th.fg("accent", "[t]")}asks`,
			`${th.fg("accent", "[q]")}uit`,
		].join("  ");
		const centered = " ".repeat(Math.max(0, Math.floor((width - visibleWidth(help)) / 2))) + help;
		return [centered];
	}

	private renderWorkerDetails(width: number): string[] {
		const th = this.theme;
		const lines: string[] = [];

		if (!this.state) {
			lines.push(th.fg("error", "No data available"));
			return lines;
		}

		const state = this.state;

		if (this.selectedWorkerIndex >= state.workers.length) {
			lines.push(th.fg("error", "No worker selected"));
			return lines;
		}

		const w = state.workers[this.selectedWorkerIndex];
		const innerWidth = width - 4;

		lines.push(this.renderBorder("top", innerWidth, `Worker Details: ${w.shortId || w.id.slice(0, 6)}`));

		const addLine = (content: string) => {
			const truncated = truncateToWidth(content, innerWidth - 3);
			const padded = " " + truncated + " ".repeat(Math.max(0, innerWidth - visibleWidth(truncated) - 2));
			lines.push(th.fg("borderMuted", " \u2502") + padded + th.fg("borderMuted", "\u2502"));
		};

		addLine(`${th.fg("dim", "Identity:")} ${w.identity}`);
		addLine(`${th.fg("dim", "Agent:")} ${w.agent}`);

		let statusColor: "success" | "warning" | "error" | "muted" = "muted";
		if (w.status === "complete") statusColor = "success";
		else if (w.status === "working") statusColor = "warning";
		else if (w.status === "failed") statusColor = "error";
		addLine(`${th.fg("dim", "Status:")} ${th.fg(statusColor, w.status)}`);

		const currentTask = state.tasks.find((t) => t.claimedBy === w.id && t.status === "claimed");
		if (currentTask) {
			addLine(`${th.fg("dim", "Task:")} ${currentTask.id} - ${currentTask.description}`);
		}

		if (w.currentStep !== null && w.currentStep !== undefined) {
			addLine(`${th.fg("dim", "Current Step:")} ${w.currentStep}`);
		}

		addLine("");
		addLine(th.fg("accent", "Stats:"));
		const duration = w.startedAt ? formatDuration(Date.now() - w.startedAt) : "--";
		addLine(`  ${th.fg("dim", "Duration:")} ${duration}`);
		addLine(`  ${th.fg("dim", "Cost:")} ${formatCost(w.usage?.cost || 0)}`);
		addLine(`  ${th.fg("dim", "Turns:")} ${w.usage?.turns || 0}`);

		const totalTokens = (w.usage?.input || 0) + (w.usage?.output || 0) + (w.usage?.cacheRead || 0) + (w.usage?.cacheWrite || 0);
		const cacheTokens = (w.usage?.cacheRead || 0) + (w.usage?.cacheWrite || 0);
		const cacheInfo = cacheTokens > 0 ? ` / cache: ${cacheTokens.toLocaleString()}` : "";
		addLine(`  ${th.fg("dim", "Tokens:")} ${totalTokens.toLocaleString()} (in: ${(w.usage?.input || 0).toLocaleString()} / out: ${(w.usage?.output || 0).toLocaleString()}${cacheInfo})`);

		if (w.filesModified && w.filesModified.length > 0) {
			addLine("");
			addLine(th.fg("accent", "Files Modified:"));
			for (const file of w.filesModified.slice(0, 5)) {
				addLine(`  ${file}`);
			}
			if (w.filesModified.length > 5) {
				addLine(th.fg("dim", `  ... and ${w.filesModified.length - 5} more`));
			}
		}

		if (w.recentTools && w.recentTools.length > 0) {
			addLine("");
			addLine(th.fg("accent", "Recent Tools:"));
			for (const tool of w.recentTools.slice(0, 5)) {
				const elapsed = tool.endMs && w.startedAt ? formatDuration(tool.endMs - w.startedAt) : "--";
				addLine(`  ${th.fg("dim", `+${elapsed}`)} ${tool.tool} ${truncateToWidth(tool.args, 30)}`);
			}
		}

		if (w.lastOutput) {
			addLine("");
			addLine(th.fg("accent", "Last Output:"));
			const outputLines = w.lastOutput.split("\n").slice(0, 3);
			for (const line of outputLines) {
				addLine(`  ${line}`);
			}
		}

		if (w.errorMessage) {
			addLine("");
			addLine(th.fg("error", "Error:"));
			addLine(`  ${w.errorMessage}`);
		}

		// Control section
		if (w.status === "working") {
			addLine("");
			const controls = getControls(w.id);
			if (this.inputMode) {
				addLine(th.fg("accent", "Send message:"));
				const inputLines = this.steerInput.render(innerWidth - 6);
				for (const line of inputLines) {
					addLine(`  ${line}`);
				}
			} else if (this.steerStatus) {
				addLine(th.fg("dim", `Status: ${this.steerStatus}`));
			} else if (controls) {
				// SDK mode - show available controls
				const available: string[] = [];
				if (controls.steer) available.push("[i] steer");
				if (controls.abort) available.push("[x] abort");
				addLine(th.fg("dim", `Controls: ${available.join("  ")}`));
			} else {
				addLine(th.fg("dim", "Controls: not available (subprocess mode)"));
			}
		}

		lines.push(this.renderBorder("bottom", innerWidth, ""));

		// Update help line to include SDK controls when available
		// For SDK workers, hide [R]estart and [A]bort since those use process.exit()
		// which would crash the entire process (coordinator + all workers)
		const controls = w.status === "working" ? getControls(w.id) : null;
		const isSDKWorker = !!controls;
		let helpParts = [`${th.fg("accent", "[Esc]")} close`];
		if (controls?.steer) helpParts.push(`${th.fg("accent", "[i]")} steer`);
		if (controls?.abort) helpParts.push(`${th.fg("accent", "[x]")} abort`);
		helpParts.push(`${th.fg("accent", "[w]")}rap up`);
		if (!isSDKWorker) {
			helpParts.push(`${th.fg("accent", "[R]")}estart`, `${th.fg("accent", "[A]")}bort`);
		}
		const help = helpParts.join("  ");
		const centered = " ".repeat(Math.max(0, Math.floor((width - visibleWidth(help)) / 2))) + help;
		lines.push(centered);

		return lines;
	}

	private renderTaskQueue(width: number): string[] {
		const th = this.theme;
		const lines: string[] = [];

		if (!this.state) {
			lines.push(th.fg("error", "No data available"));
			return lines;
		}

		const state = this.state;
		const innerWidth = width - 4;

		lines.push(this.renderBorder("top", innerWidth, "Task Queue"));

		const addLine = (content: string) => {
			const truncated = truncateToWidth(content, innerWidth - 3);
			const padded = " " + truncated + " ".repeat(Math.max(0, innerWidth - visibleWidth(truncated) - 2));
			lines.push(th.fg("borderMuted", " \u2502") + padded + th.fg("borderMuted", "\u2502"));
		};

		if (state.tasks.length === 0) {
			addLine(th.fg("dim", "No tasks"));
		} else {
			for (const task of state.tasks) {
				let icon: string;
				let color: "success" | "warning" | "error" | "muted";

				switch (task.status) {
					case "complete":
						icon = "\u2713";
						color = "success";
						break;
					case "claimed":
						icon = "\u25cf";
						color = "warning";
						break;
					case "failed":
						icon = "\u2717";
						color = "error";
						break;
					case "blocked":
						icon = "\u25cb";
						color = "error";
						break;
					default:
						icon = "\u25cb";
						color = "muted";
				}

				addLine("");
				addLine(`${th.fg(color, icon)} ${th.fg("accent", task.id)}  ${task.description}`);
				addLine(`  ${th.fg("dim", "Status:")} ${th.fg(color, task.status)}`);

				if (task.claimedBy) {
					addLine(`  ${th.fg("dim", "Worker:")} worker:${task.claimedBy}`);
				}

				if (task.dependsOn && task.dependsOn.length > 0) {
					const depIcons = task.dependsOn.map((dep) => {
						const depTask = state.tasks.find((t) => t.id === dep);
						if (depTask?.status === "complete") return th.fg("success", `${dep} \u2713`);
						if (depTask?.status === "claimed") return th.fg("warning", `${dep} \u25cf`);
						return th.fg("muted", dep);
					});
					addLine(`  ${th.fg("dim", "Dependencies:")} ${depIcons.join(", ")}`);

					const blocking = task.dependsOn.filter((dep) => {
						const depTask = state.tasks.find((t) => t.id === dep);
						return depTask?.status !== "complete";
					});
					if (blocking.length > 0) {
						addLine(`  ${th.fg("dim", "Blocked by:")} ${th.fg("error", blocking.join(", "))}`);
					}
				}
			}
		}

		lines.push(this.renderBorder("bottom", innerWidth, ""));

		const help = `${th.fg("accent", "[Esc]")} close`;
		const centered = " ".repeat(Math.max(0, Math.floor((width - visibleWidth(help)) / 2))) + help;
		lines.push(centered);

		return lines;
	}

	private startPolling(): void {
		this.pollInterval = setInterval(() => {
			if (this.disposed) return;
			this.poll();
			this.tui.requestRender();
		}, POLL_INTERVAL_MS);
	}

	private stopPolling(): void {
		if (this.pollInterval) {
			clearInterval(this.pollInterval);
			this.pollInterval = null;
		}
	}

	private poll(): void {
		try {
			if (!fs.existsSync(this.coordDir)) {
				this.lastPollError = "Coordination directory not found";
				return;
			}

			const workers = readWorkerStatesSync(this.coordDir);
			const events = readJsonlSync<CoordinationEvent>(path.join(this.coordDir, "events.jsonl"));
			const costState = readJsonSync<CostState>(path.join(this.coordDir, "cost.json")) || {
				total: 0,
				byPhase: {} as Record<PipelinePhase, number>,
				byWorker: {},
				limit: 40,
				limitReached: false,
			};
			const taskQueue = readJsonSync<TaskQueue>(path.join(this.coordDir, "tasks.json"));
			const tasks = taskQueue?.tasks || [];

			let pipelineState: PipelineState | null = null;
			let startedAt = Date.now();

			const checkpoint = readLatestCheckpointSync(this.coordDir);
			if (checkpoint?.pipelineState) {
				pipelineState = checkpoint.pipelineState;
				startedAt = pipelineState.startedAt;
			} else {
				const progressContent = fs.existsSync(path.join(this.coordDir, "progress.md"))
					? fs.readFileSync(path.join(this.coordDir, "progress.md"), "utf-8")
					: null;
				if (progressContent) {
					const parsed = parsePipelineFromProgress(progressContent);
					if (parsed.startedAt) startedAt = parsed.startedAt;
					if (parsed.currentPhase) {
						pipelineState = {
							sessionId: "",
							planPath: "",
							planHash: "",
							currentPhase: parsed.currentPhase,
							phases: {} as Record<PipelinePhase, PhaseResult>,
							fixCycle: 0,
							maxFixCycles: 3,
							startedAt,
						};
					}
				}
			}

			this.state = {
				pipelineState,
				costState,
				workers,
				events,
				tasks,
				startedAt,
			};

			if (workers.length === 0) {
				this.selectedWorkerIndex = 0;
			} else if (this.selectedWorkerIndex >= workers.length) {
				this.selectedWorkerIndex = workers.length - 1;
			}

			this.lastPollError = null;
		} catch (err) {
			this.lastPollError = err instanceof Error ? err.message : String(err);
		}
	}

	private selectNext(): void {
		if (this.state && this.state.workers.length > 0) {
			this.selectedWorkerIndex = (this.selectedWorkerIndex + 1) % this.state.workers.length;
		}
	}

	private selectPrev(): void {
		if (this.state && this.state.workers.length > 0) {
			this.selectedWorkerIndex = (this.selectedWorkerIndex - 1 + this.state.workers.length) % this.state.workers.length;
		}
	}

	private async wrapUpWorker(): Promise<void> {
		if (!this.state || this.selectedWorkerIndex >= this.state.workers.length) return;
		const worker = this.state.workers[this.selectedWorkerIndex];
		try {
			await sendNudge(this.coordDir, worker.id, {
				type: "wrap_up",
				message: "User requested wrap up from dashboard",
				timestamp: Date.now(),
			});
		} catch (err) {
			if (this.disposed) return;
			this.lastPollError = `Failed to send wrap_up: ${err instanceof Error ? err.message : String(err)}`;
		}
		if (!this.disposed) this.tui.requestRender();
	}

	private async restartWorker(): Promise<void> {
		if (!this.state || this.selectedWorkerIndex >= this.state.workers.length) return;
		const worker = this.state.workers[this.selectedWorkerIndex];
		try {
			await sendNudge(this.coordDir, worker.id, {
				type: "restart",
				message: "User requested restart from dashboard",
				timestamp: Date.now(),
			});
		} catch (err) {
			if (this.disposed) return;
			this.lastPollError = `Failed to send restart: ${err instanceof Error ? err.message : String(err)}`;
		}
		if (!this.disposed) this.tui.requestRender();
	}

	private async abortWorker(): Promise<void> {
		if (!this.state || this.selectedWorkerIndex >= this.state.workers.length) return;
		const worker = this.state.workers[this.selectedWorkerIndex];
		try {
			await sendNudge(this.coordDir, worker.id, {
				type: "abort",
				message: "User requested abort from dashboard",
				timestamp: Date.now(),
			});
		} catch (err) {
			if (this.disposed) return;
			this.lastPollError = `Failed to send abort: ${err instanceof Error ? err.message : String(err)}`;
		}
		if (!this.disposed) this.tui.requestRender();
	}

	private async handleSteerSubmit(value: string): Promise<void> {
		if (!value.trim()) {
			this.inputMode = false;
			this.tui.requestRender();
			return;
		}

		const w = this.state?.workers[this.selectedWorkerIndex];
		if (!w) {
			this.inputMode = false;
			this.tui.requestRender();
			return;
		}

		const steer = getSteer(w.id);
		if (!steer) {
			this.showSteerStatus("[steering not available]");
			this.inputMode = false;
			this.tui.requestRender();
			return;
		}

		try {
			await steer(value);
			this.showSteerStatus("[sent ✓]");
		} catch (err) {
			this.showSteerStatus(`[error: ${err instanceof Error ? err.message : "unknown"}]`);
		}

		this.inputMode = false;
		this.tui.requestRender();
	}

	private showSteerStatus(status: string): void {
		this.steerStatus = status;
		if (this.steerStatusTimeout) clearTimeout(this.steerStatusTimeout);
		this.steerStatusTimeout = setTimeout(() => {
			this.steerStatus = null;
			this.tui.requestRender();
		}, 3000);
		this.tui.requestRender();
	}
}

export class MiniFooter implements Component {
	private coordDir: string;
	private theme: Theme;

	constructor(coordDir: string, theme: Theme) {
		this.coordDir = coordDir;
		this.theme = theme;
	}

	render(width: number): string[] {
		const state = this.readState();
		if (!state) return [this.theme.fg("dim", "[coord] --")];

		const th = this.theme;
		let statusIcon: string;
		let hint: string;

		if (state.isFailed) {
			statusIcon = th.fg("error", "\u2717");
			hint = th.fg("error", "failed");
		} else if (state.isComplete) {
			statusIcon = th.fg("success", "\u2713");
			hint = th.fg("success", "done");
		} else {
			statusIcon = th.fg("warning", "\u25cf");
			hint = th.fg("muted", "/jobs to open");
		}

		const status = `[coord] ${state.phase} ${statusIcon} ${state.workers}`;
		const cost = formatCost(state.cost);
		const time = th.fg("dim", state.elapsed);

		return [truncateToWidth(`${status} | ${cost} | ${time} | ${hint}`, width)];
	}

	invalidate(): void {}

	private readState(): { phase: string; workers: string; cost: number; elapsed: string; isComplete: boolean; isFailed: boolean } | null {
		try {
			if (!fs.existsSync(this.coordDir)) return null;

			const workers = readWorkerStatesSync(this.coordDir);
			const costState = readJsonSync<CostState>(path.join(this.coordDir, "cost.json"));

			let currentPhase = "unknown";
			let startedAt = Date.now();
			let isComplete = false;
			let isFailed = false;

			const checkpoint = readLatestCheckpointSync(this.coordDir);
			if (checkpoint?.pipelineState) {
				currentPhase = checkpoint.pipelineState.currentPhase;
				startedAt = checkpoint.pipelineState.startedAt;
				isComplete = checkpoint.pipelineState.currentPhase === "complete";
				isFailed = checkpoint.pipelineState.currentPhase === "failed";
			} else {
				const progressPath = path.join(this.coordDir, "progress.md");
				if (fs.existsSync(progressPath)) {
					const content = fs.readFileSync(progressPath, "utf-8");
					const parsed = parsePipelineFromProgress(content);
					if (parsed.currentPhase) currentPhase = parsed.currentPhase;
					if (parsed.startedAt) startedAt = parsed.startedAt;
					isComplete = currentPhase === "complete";
					isFailed = currentPhase === "failed";
				}
			}

			const completed = workers.filter((w) => w.status === "complete").length;
			const total = workers.length;

			return {
				phase: currentPhase,
				workers: `${completed}/${total}`,
				cost: costState?.total || 0,
				elapsed: formatDuration(Date.now() - startedAt),
				isComplete,
				isFailed,
			};
		} catch {
			return null;
		}
	}
}

/**
 * Compact dashboard widget shown above the input.
 * Shows phase progress, task status, worker status, cost/time.
 */
export class MiniDashboard implements Component {
	private coordDir: string;
	private theme: Theme;
	private tui: { requestRender: () => void };
	private pollInterval: NodeJS.Timeout | null = null;
	private disposed = false;
	private cachedLines: string[] = [];
	private cachedWidth = 0;
	private version = 0;
	private cachedVersion = -1;

	constructor(
		coordDir: string,
		tui: { requestRender: () => void },
		theme: Theme,
	) {
		this.coordDir = coordDir;
		this.tui = tui;
		this.theme = theme;
		this.startPolling();
	}

	private startPolling(): void {
		this.pollInterval = setInterval(() => {
			if (this.disposed) return;
			this.version++;
			this.tui.requestRender();
		}, POLL_INTERVAL_MS);
	}

	render(width: number): string[] {
		if (width === this.cachedWidth && this.cachedVersion === this.version) {
			return this.cachedLines;
		}

		const th = this.theme;
		const state = this.readState();
		const lines: string[] = [];
		const innerWidth = width - 4;

		if (!state) {
			lines.push(this.border("top", innerWidth, "Coordination"));
			lines.push(this.boxLine(th.fg("dim", "Loading..."), innerWidth));
			lines.push(this.border("bottom", innerWidth));
			this.cachedLines = lines;
			this.cachedWidth = width;
			this.cachedVersion = this.version;
			return lines;
		}

		// Top border with title
		lines.push(this.border("top", innerWidth, "Coordination"));

		// Phase pipeline
		lines.push(this.boxLine(this.renderPhasePipeline(state, innerWidth - 2), innerWidth));

		// Tasks rows (can be multiple lines for active tasks)
		for (const line of this.renderTasksRow(state, innerWidth - 2)) {
			lines.push(this.boxLine(line, innerWidth));
		}

		// Workers rows (can be multiple lines for active workers)
		for (const line of this.renderWorkersRow(state, innerWidth - 2)) {
			lines.push(this.boxLine(line, innerWidth));
		}

		// Bottom border
		lines.push(this.border("bottom", innerWidth));

		this.cachedLines = lines;
		this.cachedWidth = width;
		this.cachedVersion = this.version;
		return lines;
	}

	private border(type: "top" | "bottom", width: number, title?: string): string {
		const th = this.theme;
		const dim = (s: string) => th.fg("borderMuted", s);

		if (type === "top") {
			const titlePart = title ? ` ${title} ` : "";
			const lineLen = width - titlePart.length;
			return dim(" ╭") + dim("─") + th.fg("accent", titlePart) + dim("─".repeat(Math.max(0, lineLen - 2))) + dim("╮");
		}
		return dim(" ╰") + dim("─".repeat(width - 1)) + dim("╯");
	}

	private boxLine(content: string, width: number): string {
		const th = this.theme;
		const contentWidth = visibleWidth(content);
		const padding = Math.max(0, width - contentWidth - 1);
		return th.fg("borderMuted", " │") + content + " ".repeat(padding) + th.fg("borderMuted", "│");
	}

	private renderPhasePipeline(state: MiniDashboardState, width: number): string {
		const th = this.theme;
		const phases: PipelinePhase[] = ["scout", "planner", "workers", "review", "complete"];
		const parts: string[] = [];

		for (const phase of phases) {
			const isCurrent = phase === state.currentPhase;
			const isPast = this.isPhasePast(phase, state.currentPhase);
			const isFailed = state.currentPhase === "failed";

			let icon: string;
			let name: string;

			if (phase === state.currentPhase && isFailed) {
				icon = th.fg("error", "✗");
				name = th.fg("error", "failed");
			} else if (isPast || phase === "complete" && state.currentPhase === "complete") {
				icon = th.fg("success", "✓");
				name = th.fg("dim", phase);
			} else if (isCurrent) {
				icon = th.fg("warning", "●");
				name = th.fg("accent", phase);
			} else {
				icon = th.fg("dim", "○");
				name = th.fg("dim", phase);
			}

			parts.push(`${icon} ${name}`);
		}

		const pipeline = parts.join(th.fg("dim", " → "));
		const cost = th.fg("muted", formatCost(state.cost));
		const time = th.fg("dim", state.elapsed);
		const right = `${cost} ${th.fg("dim", "│")} ${time}`;

		const leftWidth = visibleWidth(pipeline);
		const rightWidth = visibleWidth(right);
		const gap = Math.max(1, width - leftWidth - rightWidth);

		return pipeline + " ".repeat(gap) + right;
	}

	private renderTasksRow(state: MiniDashboardState, width: number): string[] {
		const th = this.theme;
		const lines: string[] = [];

		// Group tasks by status
		const claimed = state.tasks.filter(t => t.status === "claimed");
		const pending = state.tasks.filter(t => t.status === "pending");
		const blocked = state.tasks.filter(t => t.status === "blocked");
		const complete = state.tasks.filter(t => t.status === "complete");

		const completed = complete.length;
		const total = state.tasks.length;
		const header = `${th.fg("muted", "Tasks:")} ${th.fg("success", String(completed))}${th.fg("dim", "/")}${th.fg("muted", String(total))}`;

		// Summary line with counts
		const summary: string[] = [];
		if (claimed.length > 0) summary.push(th.fg("warning", `${claimed.length} active`));
		if (pending.length > 0) summary.push(th.fg("dim", `${pending.length} pending`));
		if (blocked.length > 0) summary.push(th.fg("dim", `${blocked.length} blocked`));
		if (complete.length > 0) summary.push(th.fg("success", `${complete.length} done`));

		lines.push(`${header} ${th.fg("dim", "│")} ${summary.join(th.fg("dim", ", "))}`);

		// Show active tasks with descriptions
		for (const task of claimed) {
			const icon = th.fg("warning", "●");
			const id = th.fg("accent", task.id);
			const desc = this.truncateDesc(task.description, width - 20);
			lines.push(`  ${icon} ${id} ${th.fg("muted", desc)}`);
		}

		return lines;
	}

	private renderWorkersRow(state: MiniDashboardState, width: number): string[] {
		const th = this.theme;
		const lines: string[] = [];

		const completed = state.workers.filter(w => w.status === "complete").length;
		const active = state.workers.filter(w => w.status === "working").length;
		const total = state.workers.length;
		const header = `${th.fg("muted", "Workers:")} ${th.fg("success", String(completed))}${th.fg("dim", "/")}${th.fg("muted", String(total))}`;

		// Summary
		const summary: string[] = [];
		if (active > 0) summary.push(th.fg("warning", `${active} active`));
		if (completed > 0) summary.push(th.fg("success", `${completed} done`));
		const waiting = state.workers.filter(w => w.status === "waiting").length;
		if (waiting > 0) summary.push(th.fg("dim", `${waiting} waiting`));

		lines.push(`${header} ${th.fg("dim", "│")} ${summary.join(th.fg("dim", ", "))}`);

		// Show active workers with tokens/cost/context/duration
		for (const worker of state.workers.filter(w => w.status === "working")) {
			const icon = th.fg("warning", "●");
			const id = th.fg("accent", worker.id.slice(0, 4));
			const task = worker.taskId ? th.fg("muted", worker.taskId) : th.fg("dim", "—");

			// Format stats: tokens, context %, cost, duration
			const tokens = worker.tokens !== undefined ? this.formatTokens(worker.tokens) : "—";
			const contextPct = worker.contextPct !== undefined ? `${worker.contextPct.toFixed(1)}%` : "—";
			const contextWindow = worker.contextWindow ? this.formatTokens(worker.contextWindow) : "200k";
			const cost = worker.cost !== undefined ? `$${worker.cost.toFixed(2)}` : "—";
			const duration = worker.durationMs ? formatDuration(worker.durationMs) : "—";
			
			// Color context % based on usage
			let contextStr = `${contextPct}/${contextWindow}`;
			if (worker.contextPct !== undefined) {
				if (worker.contextPct > 90) {
					contextStr = th.fg("error", contextStr);
				} else if (worker.contextPct > 70) {
					contextStr = th.fg("warning", contextStr);
				} else {
					contextStr = th.fg("success", contextStr);
				}
			} else {
				contextStr = th.fg("dim", contextStr);
			}

			const stats = `${th.fg("dim", tokens)} ${contextStr} ${th.fg("dim", cost + ", " + duration)}`;

			lines.push(`  ${icon} ${id} ${task} ${stats}`);
		}

		return lines;
	}

	private truncateDesc(desc: string, maxLen: number): string {
		// Take first line only, truncate if needed
		const firstLine = desc.split("\n")[0].trim();
		if (firstLine.length <= maxLen) return firstLine;
		return firstLine.slice(0, maxLen - 1) + "…";
	}

	private formatTokens(tokens: number): string {
		if (tokens < 1000) return String(tokens);
		if (tokens < 10000) return `${(tokens / 1000).toFixed(1)}k`;
		return `${Math.round(tokens / 1000)}k`;
	}

	private isPhasePast(phase: PipelinePhase, currentPhase: string): boolean {
		const order = PHASE_ORDER;
		const phaseIdx = order.indexOf(phase);
		const currentIdx = order.indexOf(currentPhase as PipelinePhase);
		return phaseIdx < currentIdx && phaseIdx !== -1 && currentIdx !== -1;
	}

	invalidate(): void {
		this.cachedWidth = 0;
	}

	dispose(): void {
		this.disposed = true;
		if (this.pollInterval) {
			clearInterval(this.pollInterval);
			this.pollInterval = null;
		}
	}

	private readState(): MiniDashboardState | null {
		try {
			if (!fs.existsSync(this.coordDir)) return null;

			const workers = readWorkerStatesSync(this.coordDir);
			const costState = readJsonSync<CostState>(path.join(this.coordDir, "cost.json"));
			const taskQueue = readJsonSync<TaskQueue>(path.join(this.coordDir, "tasks.json"));
			const tasks = taskQueue?.tasks || [];

			let currentPhase: PipelinePhase = "scout";
			let startedAt = Date.now();

			const checkpoint = readLatestCheckpointSync(this.coordDir);
			if (checkpoint?.pipelineState) {
				currentPhase = checkpoint.pipelineState.currentPhase;
				startedAt = checkpoint.pipelineState.startedAt;
			} else {
				const progressPath = path.join(this.coordDir, "progress.md");
				if (fs.existsSync(progressPath)) {
					const content = fs.readFileSync(progressPath, "utf-8");
					const parsed = parsePipelineFromProgress(content);
					if (parsed.currentPhase) currentPhase = parsed.currentPhase;
					if (parsed.startedAt) startedAt = parsed.startedAt;
				}
			}

			// Find taskId for each worker from the task queue
			const workerTaskMap = new Map<string, string>();
			for (const task of tasks) {
				if (task.claimedBy && task.status === "claimed") {
					workerTaskMap.set(task.claimedBy, task.id);
				}
			}

			// Default context window (Claude Sonnet = 200k)
			const defaultContextWindow = 200000;

			return {
				currentPhase,
				cost: costState?.total || 0,
				elapsed: formatDuration(Date.now() - startedAt),
				workers: workers.map(w => {
					const tokens = w.tokens ?? (w.usage ? w.usage.input + w.usage.output + (w.usage.cacheRead || 0) + (w.usage.cacheWrite || 0) : undefined);
					const contextWindow = defaultContextWindow;
					const contextPct = tokens !== undefined ? (tokens / contextWindow) * 100 : undefined;
					
					return {
						id: w.id,
						status: w.status,
						taskId: workerTaskMap.get(w.id),
						tokens,
						contextPct,
						contextWindow,
						cost: w.usage?.cost,
						durationMs: w.durationMs ?? (w.startedAt ? Date.now() - w.startedAt : undefined),
					};
				}),
				tasks: tasks.map(t => ({
					id: t.id,
					status: t.status,
					description: t.description,
				})),
			};
		} catch {
			return null;
		}
	}
}

interface MiniDashboardState {
	currentPhase: PipelinePhase;
	cost: number;
	elapsed: string;
	workers: { 
		id: string; 
		status: string; 
		taskId?: string; 
		tokens?: number;
		contextPct?: number;
		contextWindow?: number;
		cost?: number; 
		durationMs?: number;
	}[];
	tasks: { id: string; status: string; description: string }[];
}
