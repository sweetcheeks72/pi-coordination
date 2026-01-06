import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createCoordinateTool } from "../../tools/coordinate/index.js";
import { createCoordOutputTool } from "../../tools/coord-output/index.js";

interface CoordinationResult {
	asyncId: string;
	status: "complete" | "failed";
	summary?: string;
	coordDir?: string;
	durationMs?: number;
	cost?: number;
	isError?: boolean;
}

interface AsyncDetails {
	id: string;
	status: "queued" | "complete" | "failed";
	resultPath: string;
	resultsDir: string;
	coordDir: string;
}

interface AsyncJobState {
	asyncId: string;
	coordDir: string;
	resultPath: string;
	resultsDir: string;
	status: "queued" | "running" | "complete" | "failed";
	startedAt: number;
	phase?: string;
	plan?: string;
	workerCompleted?: number;
	workerTotal?: number;
	cost?: number;
	updatedAt?: number;
}

const WIDGET_KEY = "coordination-async";
const POLL_INTERVAL_MS = 1000;
const MAX_WIDGET_JOBS = 4;

function parseProgressSummary(content: string): Partial<AsyncJobState> {
	const lines = content.split("\n");
	const summary: Partial<AsyncJobState> = {};

	for (const line of lines) {
		if (line.startsWith("# Progress:")) {
			summary.plan = line.replace("# Progress:", "").trim();
		}
		if (line.includes("**Current Phase:**")) {
			const match = line.match(/\*\*Current Phase:\*\*\s*([a-zA-Z_-]+)/);
			if (match) summary.phase = match[1];
		}
		if (line.includes("**Workers:**")) {
			const match = line.match(/\*\*Workers:\*\*\s*(\d+)\s*\/\s*(\d+)/);
			if (match) {
				summary.workerCompleted = Number(match[1]);
				summary.workerTotal = Number(match[2]);
			}
		}
		if (line.includes("**Total Cost:**")) {
			const match = line.match(/\*\*Total Cost:\*\*\s*\$([0-9.]+)/);
			if (match) summary.cost = Number(match[1]);
		}
	}

	return summary;
}

function readProgress(coordDir: string): Partial<AsyncJobState> | null {
	const progressPath = path.join(coordDir, "progress.md");
	if (!fs.existsSync(progressPath)) return null;
	try {
		const content = fs.readFileSync(progressPath, "utf-8");
		return parseProgressSummary(content);
	} catch {
		return null;
	}
}

function readWorkerCounts(coordDir: string): { completed: number; total: number } | null {
	let entries: string[];
	try {
		entries = fs.readdirSync(coordDir);
	} catch {
		return null;
	}
	const workerFiles = entries.filter((f) => f.startsWith("worker-") && f.endsWith(".json"));
	if (workerFiles.length === 0) return null;
	let completed = 0;
	for (const file of workerFiles) {
		try {
			const content = fs.readFileSync(path.join(coordDir, file), "utf-8");
			const state = JSON.parse(content) as { status?: string };
			if (state.status === "complete") completed += 1;
		} catch {}
	}
	return { completed, total: workerFiles.length };
}

function readCost(coordDir: string): number | undefined {
	const costPath = path.join(coordDir, "cost.json");
	if (!fs.existsSync(costPath)) return undefined;
	try {
		const content = fs.readFileSync(costPath, "utf-8");
		const parsed = JSON.parse(content) as { total?: number };
		return typeof parsed.total === "number" ? parsed.total : undefined;
	} catch {
		return undefined;
	}
}

function renderWidget(ctx: ExtensionContext, jobs: AsyncJobState[]): void {
	if (!ctx.hasUI) return;
	if (jobs.length === 0) {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		return;
	}

	const theme = ctx.ui.theme;
	const lines: string[] = [];
	lines.push(theme.fg("accent", "Async coordination"));

	for (const job of jobs.slice(0, MAX_WIDGET_JOBS)) {
		const id = job.asyncId.slice(0, 6);
		const phase = job.phase ?? "unknown";
		const completed = job.workerCompleted ?? 0;
		const total = job.workerTotal ?? "?";
		const cost = typeof job.cost === "number" ? ` $${job.cost.toFixed(2)}` : "";
		const status =
			job.status === "complete"
				? theme.fg("success", "complete")
				: job.status === "failed"
					? theme.fg("error", "failed")
					: theme.fg("warning", "running");

		lines.push(`- ${id} ${status} | ${phase} | ${completed}/${total}${cost}`);
	}

	ctx.ui.setWidget(WIDGET_KEY, lines);
}

export default function registerCoordinationExtension(pi: ExtensionAPI): void {
	pi.registerTool(createCoordinateTool(pi.events));
	pi.registerTool(createCoordOutputTool());

	const asyncJobs = new Map<string, AsyncJobState>();
	let lastUiContext: ExtensionContext | null = null;
	let poller: NodeJS.Timeout | null = null;

	const ensurePoller = () => {
		if (poller) return;
		poller = setInterval(() => {
			if (!lastUiContext || !lastUiContext.hasUI) return;
			if (asyncJobs.size === 0) {
				renderWidget(lastUiContext, []);
				clearInterval(poller);
				poller = null;
				return;
			}

			for (const job of asyncJobs.values()) {
				if (!fs.existsSync(job.coordDir)) continue;
				const progress = readProgress(job.coordDir);
				if (progress) {
					job.phase = progress.phase ?? job.phase;
					job.plan = progress.plan ?? job.plan;
					job.workerCompleted = progress.workerCompleted ?? job.workerCompleted;
					job.workerTotal = progress.workerTotal ?? job.workerTotal;
					job.cost = progress.cost ?? job.cost;
				} else {
					const counts = readWorkerCounts(job.coordDir);
					if (counts) {
						job.workerCompleted = counts.completed;
						job.workerTotal = counts.total;
					}
					const cost = readCost(job.coordDir);
					if (typeof cost === "number") job.cost = cost;
				}
				job.status = job.status === "queued" ? "running" : job.status;
				job.updatedAt = Date.now();
			}

			renderWidget(lastUiContext, Array.from(asyncJobs.values()));
		}, POLL_INTERVAL_MS);
	};

	pi.events.on("coordination:complete", (data) => {
		const result = data as CoordinationResult;
		const job = asyncJobs.get(result.asyncId);
		if (job) {
			job.status = result.status;
		}
		if (lastUiContext) {
			renderWidget(lastUiContext, Array.from(asyncJobs.values()));
		}
		setTimeout(() => {
			asyncJobs.delete(result.asyncId);
			if (lastUiContext) renderWidget(lastUiContext, Array.from(asyncJobs.values()));
		}, 10000);

		const status = result.status === "failed" ? "FAILED" : "COMPLETE";
		const summary = result.summary || "(no summary)";
		const coordDir = result.coordDir ? `\nCoordDir: ${result.coordDir}` : "";
		const cost = typeof result.cost === "number" ? `\nCost: $${result.cost.toFixed(2)}` : "";
		const duration = typeof result.durationMs === "number" ? `\nDuration: ${(result.durationMs / 1000).toFixed(1)}s` : "";

		pi.sendMessage(
			{
				customType: "coordination-notify",
				content: `Async coordination ${status} [${result.asyncId}]\n${summary}${coordDir}${cost}${duration}`,
				display: true,
			},
			{ triggerTurn: true },
		);
	});

	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "coordinate") return;
		const details = (event as { details?: unknown }).details as { async?: AsyncDetails } | undefined;
		const asyncInfo = details?.async;
		if (!asyncInfo || asyncInfo.status !== "queued") return;
		if (!ctx.hasUI) return;

		lastUiContext = ctx;
		asyncJobs.set(asyncInfo.id, {
			asyncId: asyncInfo.id,
			coordDir: asyncInfo.coordDir,
			resultPath: asyncInfo.resultPath,
			resultsDir: asyncInfo.resultsDir,
			status: "queued",
			startedAt: Date.now(),
		});
		renderWidget(ctx, Array.from(asyncJobs.values()));
		ensurePoller();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (poller) clearInterval(poller);
		poller = null;
		asyncJobs.clear();
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	});
}
