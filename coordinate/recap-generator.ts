/**
 * HTML recap generator for pi-coordination sessions.
 * Produces a dark-themed, inline-styled HTML report: outcome → files → tests → agents → cost → transcript.
 */

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { CoordinationEvent, WorkerStateFile, Task, PipelinePhase } from "./types.js";

const execAsync = promisify(exec);

// ─────────────────────────────────────────────────────────────────────────────
// Types expected by the generator
// ─────────────────────────────────────────────────────────────────────────────

export interface CoordinationConfig {
	coordDir: string;
	planPath?: string;
	costLimit?: number;
}

export interface CoordinationSessionState {
	status: string;
	startedAt: number;
	completedAt?: number;
	exitReason?: string;
}

export interface CostByPhase {
	byPhase?: Record<string, number>;
	total?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatDurationMs(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}m ${seconds}s`;
}

function formatCostNum(cost: number): string {
	return `$${cost.toFixed(4)}`;
}

function esc(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

// ─────────────────────────────────────────────────────────────────────────────
// Git diff analysis
// ─────────────────────────────────────────────────────────────────────────────

interface FileDiff {
	path: string;
	added: number;
	removed: number;
	status: "M" | "A" | "D" | "?";
}

async function getGitDiff(cwd: string): Promise<FileDiff[]> {
	try {
		const { stdout } = await execAsync("git diff --stat HEAD~1 HEAD 2>/dev/null || git diff --stat HEAD 2>/dev/null", { cwd });
		const results: FileDiff[] = [];
		const lines = stdout.split("\n").filter(Boolean);
		for (const line of lines) {
			// Format: " src/foo.ts | 12 ++++-----"
			const match = line.match(/^\s+(.+?)\s+\|\s+\d+\s+([\+\-]*)/);
			if (match) {
				const filePath = match[1].trim();
				const changes = match[2] || "";
				const added = (changes.match(/\+/g) || []).length;
				const removed = (changes.match(/-/g) || []).length;
				results.push({ path: filePath, added, removed, status: "M" });
			}
		}
		return results;
	} catch {
		return [];
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Test result extraction from events
// ─────────────────────────────────────────────────────────────────────────────

interface TestResult {
	tool: string;
	passed?: number;
	failed?: number;
	skipped?: number;
	raw?: string;
}

function extractTestResults(events: CoordinationEvent[]): TestResult[] {
	const results: TestResult[] = [];
	for (const ev of events) {
		if (ev.type !== "tool_result") continue;
		const file = (ev as any).file || "";
		if (!file) continue;
		// Check if this looks like a test run (common test runners)
		if (!/test|jest|pytest|vitest|mocha|spec/i.test(file)) continue;
		results.push({ tool: ev.tool, raw: file });
	}
	return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent activity timeline
// ─────────────────────────────────────────────────────────────────────────────

interface AgentActivity {
	id: string;
	name: string;
	identity: string;
	status: string;
	durationMs: number;
	cost: number;
	filesModified: string[];
	completedTasks: string[];
}

function buildAgentActivity(workers: WorkerStateFile[], tasks: Task[]): AgentActivity[] {
	return workers.map((w) => {
		const durationMs = w.completedAt && w.startedAt ? w.completedAt - w.startedAt : 
			w.startedAt ? Date.now() - w.startedAt : 0;

		// Find tasks claimed/completed by this worker
		const completedTasks = tasks
			.filter(t => t.completedBy === w.identity || t.claimedBy === w.identity)
			.map(t => t.id);

		// Generate memorable name (simple hash)
		let hash = 0;
		for (let i = 0; i < w.identity.length; i++) {
			hash = ((hash << 5) - hash) + w.identity.charCodeAt(i);
			hash = hash & hash;
		}
		const adj = ["swift", "calm", "bold", "keen", "wise", "bright", "quick", "sharp"][Math.abs(hash) % 8];
		const noun = ["fox", "owl", "wolf", "bear", "hawk", "deer", "crow", "seal"][Math.abs(Math.floor(hash / 8)) % 8];
		const name = `${adj}_${noun}`;

		return {
			id: w.id,
			name,
			identity: w.identity,
			status: w.status,
			durationMs,
			cost: w.usage?.cost || 0,
			filesModified: w.filesModified || [],
			completedTasks,
		};
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Cost breakdown per phase
// ─────────────────────────────────────────────────────────────────────────────

function extractCostByPhase(events: CoordinationEvent[]): Record<string, number> {
	const byPhase: Record<string, number> = {};
	for (const ev of events) {
		if (ev.type === "phase_complete") {
			byPhase[ev.phase] = (byPhase[ev.phase] || 0) + ev.cost;
		}
	}
	return byPhase;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML generation
// ─────────────────────────────────────────────────────────────────────────────

const COLORS = {
	bg: "#0d1117",
	text: "#c9d1d9",
	accent: "#58a6ff",
	success: "#7ee787",
	warning: "#e3b341",
	error: "#f85149",
	border: "#30363d",
	bgSecondary: "#161b22",
	bgTertiary: "#21262d",
	textMuted: "#8b949e",
};

function statusBanner(status: string, exitReason?: string): string {
	const isSuccess = status === "complete" && (exitReason === "clean" || !exitReason || exitReason === "max_cycles");
	const isWarning = status === "complete" && (exitReason === "stuck" || exitReason === "cost_limit");
	const isError = status === "failed";

	let icon: string;
	let color: string;
	let label: string;

	if (isError) {
		icon = "❌";
		color = COLORS.error;
		label = "FAILED";
	} else if (isWarning) {
		icon = "⚠️";
		color = COLORS.warning;
		label = exitReason === "cost_limit" ? "COST LIMIT REACHED" : "COMPLETED WITH ISSUES";
	} else {
		icon = "✅";
		color = COLORS.success;
		label = "COMPLETED SUCCESSFULLY";
	}

	return `
	<div style="background:${color}22; border:2px solid ${color}; border-radius:8px; padding:16px 24px; margin-bottom:24px; display:flex; align-items:center; gap:12px;">
		<span style="font-size:2rem;">${icon}</span>
		<span style="font-size:1.4rem; font-weight:bold; color:${color}; font-family:monospace;">${label}</span>
	</div>`;
}

function sectionHeader(title: string): string {
	return `<h2 style="font-family:monospace; color:${COLORS.accent}; border-bottom:1px solid ${COLORS.border}; padding-bottom:8px; margin-top:32px; margin-bottom:16px;">${esc(title)}</h2>`;
}

function card(content: string): string {
	return `<div style="background:${COLORS.bgSecondary}; border:1px solid ${COLORS.border}; border-radius:6px; padding:16px; margin-bottom:12px;">${content}</div>`;
}

function renderOutcomeSection(
	config: CoordinationConfig,
	state: CoordinationSessionState,
	workers: WorkerStateFile[],
	tasks: Task[],
	totalCost: number,
): string {
	const duration = state.completedAt && state.startedAt
		? formatDurationMs(state.completedAt - state.startedAt)
		: "—";
	const planName = config.planPath ? path.basename(config.planPath) : "Unknown Plan";
	const completedTasks = tasks.filter(t => t.status === "complete").length;
	const totalTasks = tasks.length;
	const activeWorkers = workers.length;

	const rows = [
		["Plan", esc(planName)],
		["Status", esc(state.status)],
		["Exit reason", esc(state.exitReason || "—")],
		["Duration", esc(duration)],
		["Total cost", esc(formatCostNum(totalCost))],
		["Tasks", `${completedTasks} / ${totalTasks} completed`],
		["Workers", `${activeWorkers} spawned`],
		["Started", new Date(state.startedAt).toISOString()],
		["Completed", state.completedAt ? new Date(state.completedAt).toISOString() : "—"],
	];

	const tableRows = rows.map(([k, v]) => `
		<tr>
			<td style="color:${COLORS.textMuted}; padding:6px 12px 6px 0; font-family:monospace; white-space:nowrap;">${k}</td>
			<td style="color:${COLORS.text}; padding:6px 0; font-family:monospace;">${v}</td>
		</tr>`).join("");

	return sectionHeader("📋 Outcome") + card(`<table style="border-collapse:collapse; width:100%;">${tableRows}</table>`);
}

function renderFilesSection(diffs: FileDiff[], workers: WorkerStateFile[]): string {
	// Combine git diffs with worker-reported files
	const allFiles = new Set<string>();
	diffs.forEach(d => allFiles.add(d.path));
	workers.forEach(w => (w.filesModified || []).forEach(f => allFiles.add(f)));

	if (allFiles.size === 0) {
		return sectionHeader("📁 Files Changed") + card(`<span style="color:${COLORS.textMuted}; font-family:monospace;">No file changes detected</span>`);
	}

	const diffMap = new Map(diffs.map(d => [d.path, d]));

	const rows = [...allFiles].map(filePath => {
		const diff = diffMap.get(filePath);
		const added = diff?.added ?? 0;
		const removed = diff?.removed ?? 0;
		const addStr = added > 0 ? `<span style="color:${COLORS.success}">+${added}</span>` : "";
		const remStr = removed > 0 ? `<span style="color:${COLORS.error}">-${removed}</span>` : "";
		const diffStr = added > 0 || removed > 0 ? `${addStr}${added && removed ? " " : ""}${remStr}` : "";
		return `
		<tr>
			<td style="font-family:monospace; color:${COLORS.text}; padding:4px 12px 4px 0;">${esc(filePath)}</td>
			<td style="font-family:monospace; padding:4px 0;">${diffStr}</td>
		</tr>`;
	}).join("");

	return sectionHeader("📁 Files Changed") + card(`<table style="border-collapse:collapse; width:100%;">${rows}</table>`);
}

function renderTestsSection(events: CoordinationEvent[]): string {
	// Look for bash tool_result events that likely contain test output
	const testEvents = events.filter(ev => {
		if (ev.type !== "tool_call") return false;
		const file = (ev as any).file || "";
		return /npm.test|pytest|vitest|jest|mocha|yarn.test/i.test(file);
	});

	if (testEvents.length === 0) {
		return sectionHeader("🧪 Test Results") + card(`<span style="color:${COLORS.textMuted}; font-family:monospace;">No test runs detected in event log</span>`);
	}

	const items = testEvents.slice(-5).map(ev => {
		const file = (ev as any).file || "";
		const ts = new Date(ev.timestamp).toISOString().slice(11, 19);
		return `<div style="font-family:monospace; color:${COLORS.text}; padding:4px 0;">[${ts}] ${esc(file)}</div>`;
	}).join("");

	return sectionHeader("🧪 Test Results") + card(items);
}

function renderAgentsSection(activities: AgentActivity[]): string {
	if (activities.length === 0) {
		return sectionHeader("🤖 Agent Activity") + card(`<span style="color:${COLORS.textMuted}; font-family:monospace;">No agent activity recorded</span>`);
	}

	const rows = activities.map(a => {
		const statusColor = a.status === "complete" ? COLORS.success : a.status === "failed" ? COLORS.error : COLORS.warning;
		const filesStr = a.filesModified.length > 0
			? a.filesModified.slice(0, 5).map(f => path.basename(f)).join(", ") + (a.filesModified.length > 5 ? ` +${a.filesModified.length - 5} more` : "")
			: "—";
		const tasksStr = a.completedTasks.length > 0 ? a.completedTasks.join(", ") : "—";
		return `
		<tr style="border-bottom:1px solid ${COLORS.border};">
			<td style="font-family:monospace; color:${COLORS.accent}; padding:8px 12px 8px 0; white-space:nowrap;">${esc(a.name)}</td>
			<td style="font-family:monospace; color:${statusColor}; padding:8px 12px 8px 0;">${esc(a.status)}</td>
			<td style="font-family:monospace; color:${COLORS.text}; padding:8px 12px 8px 0;">${esc(formatDurationMs(a.durationMs))}</td>
			<td style="font-family:monospace; color:${COLORS.warning}; padding:8px 12px 8px 0;">${esc(formatCostNum(a.cost))}</td>
			<td style="font-family:monospace; color:${COLORS.textMuted}; padding:8px 12px 8px 0; font-size:0.85em;">${esc(tasksStr)}</td>
			<td style="font-family:monospace; color:${COLORS.textMuted}; padding:8px 0; font-size:0.85em;">${esc(filesStr)}</td>
		</tr>`;
	}).join("");

	const header = `
	<tr style="border-bottom:2px solid ${COLORS.border};">
		<th style="font-family:monospace; color:${COLORS.textMuted}; padding:6px 12px 6px 0; text-align:left; font-weight:normal;">Agent</th>
		<th style="font-family:monospace; color:${COLORS.textMuted}; padding:6px 12px 6px 0; text-align:left; font-weight:normal;">Status</th>
		<th style="font-family:monospace; color:${COLORS.textMuted}; padding:6px 12px 6px 0; text-align:left; font-weight:normal;">Duration</th>
		<th style="font-family:monospace; color:${COLORS.textMuted}; padding:6px 12px 6px 0; text-align:left; font-weight:normal;">Cost</th>
		<th style="font-family:monospace; color:${COLORS.textMuted}; padding:6px 12px 6px 0; text-align:left; font-weight:normal;">Tasks</th>
		<th style="font-family:monospace; color:${COLORS.textMuted}; padding:6px 0; text-align:left; font-weight:normal;">Files</th>
	</tr>`;

	return sectionHeader("🤖 Agent Activity") + card(`<table style="border-collapse:collapse; width:100%;">${header}${rows}</table>`);
}

function renderCostSection(
	workers: WorkerStateFile[],
	costByPhase: Record<string, number>,
	totalCost: number,
): string {
	const phaseOrder = ["scout", "planner", "coordinator", "workers", "review", "fixes"];
	const phaseRows = phaseOrder
		.filter(p => (costByPhase[p] ?? 0) > 0)
		.map(p => `
		<tr>
			<td style="font-family:monospace; color:${COLORS.textMuted}; padding:4px 12px 4px 0;">${esc(p)}</td>
			<td style="font-family:monospace; color:${COLORS.warning}; padding:4px 0;">${esc(formatCostNum(costByPhase[p]))}</td>
		</tr>`).join("");

	const totalRow = `
	<tr style="border-top:1px solid ${COLORS.border}; margin-top:8px;">
		<td style="font-family:monospace; color:${COLORS.text}; padding:8px 12px 4px 0; font-weight:bold;">Total</td>
		<td style="font-family:monospace; color:${COLORS.warning}; padding:8px 0; font-weight:bold;">${esc(formatCostNum(totalCost))}</td>
	</tr>`;

	// Token breakdown by worker
	const workerTokenRows = workers
		.filter(w => (w.usage?.input || 0) + (w.usage?.output || 0) > 0)
		.map(w => {
			const totalTokens = (w.usage?.input || 0) + (w.usage?.output || 0);
			const cacheRead = w.usage?.cacheRead || 0;
			let hash = 0;
			for (let i = 0; i < w.identity.length; i++) {
				hash = ((hash << 5) - hash) + w.identity.charCodeAt(i);
				hash = hash & hash;
			}
			const adj = ["swift", "calm", "bold", "keen", "wise", "bright", "quick", "sharp"][Math.abs(hash) % 8];
			const noun = ["fox", "owl", "wolf", "bear", "hawk", "deer", "crow", "seal"][Math.abs(Math.floor(hash / 8)) % 8];
			return `
		<tr>
			<td style="font-family:monospace; color:${COLORS.accent}; padding:4px 12px 4px 0;">${esc(`${adj}_${noun}`)}</td>
			<td style="font-family:monospace; color:${COLORS.text}; padding:4px 12px 4px 0;">${totalTokens.toLocaleString()}</td>
			<td style="font-family:monospace; color:${COLORS.textMuted}; padding:4px 12px 4px 0;">${cacheRead > 0 ? cacheRead.toLocaleString() + " cached" : "—"}</td>
			<td style="font-family:monospace; color:${COLORS.warning}; padding:4px 0;">${esc(formatCostNum(w.usage?.cost || 0))}</td>
		</tr>`;
		}).join("");

	const workerHeader = `
	<tr style="border-bottom:1px solid ${COLORS.border};">
		<th style="font-family:monospace; color:${COLORS.textMuted}; padding:6px 12px 6px 0; text-align:left; font-weight:normal;">Worker</th>
		<th style="font-family:monospace; color:${COLORS.textMuted}; padding:6px 12px 6px 0; text-align:left; font-weight:normal;">Tokens</th>
		<th style="font-family:monospace; color:${COLORS.textMuted}; padding:6px 12px 6px 0; text-align:left; font-weight:normal;">Cache</th>
		<th style="font-family:monospace; color:${COLORS.textMuted}; padding:6px 0; text-align:left; font-weight:normal;">Cost</th>
	</tr>`;

	return sectionHeader("💰 Cost & Tokens") + 
		card(`<h3 style="font-family:monospace; color:${COLORS.textMuted}; margin:0 0 12px; font-size:0.9em; text-transform:uppercase; letter-spacing:0.05em;">By Phase</h3><table style="border-collapse:collapse; width:100%;">${phaseRows}${totalRow}</table>`) +
		(workerTokenRows ? card(`<h3 style="font-family:monospace; color:${COLORS.textMuted}; margin:0 0 12px; font-size:0.9em; text-transform:uppercase; letter-spacing:0.05em;">By Worker</h3><table style="border-collapse:collapse; width:100%;">${workerHeader}${workerTokenRows}</table>`) : "");
}

function renderTranscriptSection(coordDir: string): string {
	const eventsPath = path.join(coordDir, "events.jsonl");
	const fileUrl = `file://${eventsPath}`;

	return sectionHeader("📜 Full Transcript") + card(`
		<div style="font-family:monospace; color:${COLORS.text};">
			<p style="margin:0 0 8px; color:${COLORS.textMuted};">Raw event log (JSONL format):</p>
			<a href="${esc(fileUrl)}" style="color:${COLORS.accent}; word-break:break-all;">${esc(eventsPath)}</a>
			<p style="margin:8px 0 0; color:${COLORS.textMuted}; font-size:0.85em;">Open in your editor or use: <code style="background:${COLORS.bgTertiary}; padding:2px 6px; border-radius:3px;">cat ${esc(eventsPath)} | jq .</code></p>
		</div>`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────────────────────────────────────

export async function generateCoordinationRecap(
	config: CoordinationConfig,
	state: CoordinationSessionState,
	workers: WorkerStateFile[],
	tasks: Task[],
	events: CoordinationEvent[],
): Promise<string> {
	// Gather data
	const cwd = config.coordDir.replace(/\/[^/]+$/, "") || process.cwd();
	const diffs = await getGitDiff(cwd).catch(() => []);
	const costByPhase = extractCostByPhase(events);
	const totalCost = workers.reduce((sum, w) => sum + (w.usage?.cost || 0), 0);
	const activities = buildAgentActivity(workers, tasks);

	const planName = config.planPath ? path.basename(config.planPath, path.extname(config.planPath)) : "coordination";
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const outPath = path.join(config.coordDir, `recap-${timestamp}.html`);

	const html = `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>pi-coordination recap — ${esc(planName)}</title>
	<style>
		* { box-sizing: border-box; margin: 0; padding: 0; }
		body {
			background: ${COLORS.bg};
			color: ${COLORS.text};
			font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
			font-size: 14px;
			line-height: 1.6;
			padding: 32px;
			max-width: 1100px;
			margin: 0 auto;
		}
		h1 {
			font-family: monospace;
			font-size: 1.6rem;
			color: ${COLORS.accent};
			margin-bottom: 8px;
		}
		.subtitle {
			color: ${COLORS.textMuted};
			font-family: monospace;
			font-size: 0.9em;
			margin-bottom: 32px;
		}
		a { color: ${COLORS.accent}; }
		code {
			font-family: monospace;
			background: ${COLORS.bgTertiary};
			padding: 2px 6px;
			border-radius: 3px;
			font-size: 0.9em;
		}
	</style>
</head>
<body>
	<h1>🔮 pi-coordination recap</h1>
	<div class="subtitle">Plan: ${esc(planName)} · Generated: ${new Date().toISOString()}</div>

	${statusBanner(state.status, state.exitReason)}
	${renderOutcomeSection(config, state, workers, tasks, totalCost)}
	${renderFilesSection(diffs, workers)}
	${renderTestsSection(events)}
	${renderAgentsSection(activities)}
	${renderCostSection(workers, costByPhase, totalCost)}
	${renderTranscriptSection(config.coordDir)}
</body>
</html>`;

	await fs.writeFile(outPath, html, "utf-8");
	return outPath;
}
