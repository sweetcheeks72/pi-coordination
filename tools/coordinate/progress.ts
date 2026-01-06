import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import type {
	PipelineState,
	CoordinationState,
	WorkerStateFile,
	CoordinationEvent,
	Discovery,
} from "./types.js";
import type { ReviewResult } from "./phases/review.js";

export interface ProgressConfig {
	includeDetailedHistory: boolean;
	maxHistoryEntries: number;
}

export function generateProgressDoc(
	pipelineState: PipelineState,
	coordinationState: CoordinationState,
	workerStates: WorkerStateFile[],
	events: CoordinationEvent[],
	reviewHistory?: ReviewResult[],
	config: ProgressConfig = { includeDetailedHistory: true, maxHistoryEntries: 50 },
): string {
	const lines: string[] = [];

	lines.push(`# Progress: ${path.basename(pipelineState.planPath)}`);
	lines.push(``);
	lines.push(`## Summary`);
	lines.push(`- **Current Phase:** ${pipelineState.currentPhase}`);
	lines.push(`- **Status:** ${pipelineState.phases[pipelineState.currentPhase]?.status || "unknown"}`);
	lines.push(`- **Workers:** ${workerStates.filter(w => w.status === "complete").length}/${workerStates.length}`);
	lines.push(`- **Review Cycles:** ${pipelineState.fixCycle}`);

	const totalCost = workerStates.reduce((sum, w) => sum + w.usage.cost, 0);
	lines.push(`- **Total Cost:** $${totalCost.toFixed(4)}`);
	lines.push(``);

	const openIssues = pipelineState.reviewIssues?.filter(i => i.fixAttempts === 0) || [];
	if (openIssues.length > 0) {
		lines.push(`## Current Issues`);
		for (const issue of openIssues) {
			lines.push(`- **${issue.file}:${issue.line || "?"}** - ${issue.description}`);
		}
		lines.push(``);
	}

	lines.push(`## Completed Work`);
	for (const w of workerStates.filter(ws => ws.status === "complete")) {
		lines.push(`- ${w.identity}: ${w.filesModified.join(", ")}`);
	}
	lines.push(``);

	if (config.includeDetailedHistory) {
		lines.push(`---`);
		lines.push(``);
		lines.push(`## Full History`);
		lines.push(``);

		for (const [phase, result] of Object.entries(pipelineState.phases)) {
			if (result.status === "pending") continue;
			lines.push(`### Phase: ${phase}`);
			lines.push(`- Status: ${result.status}`);
			if (result.startedAt) lines.push(`- Started: ${new Date(result.startedAt).toISOString()}`);
			if (result.completedAt) lines.push(`- Completed: ${new Date(result.completedAt).toISOString()}`);
			if (result.error) lines.push(`- Error: ${result.error}`);
			lines.push(``);
		}

		if (reviewHistory && reviewHistory.length > 0) {
			lines.push(`## Review History`);
			const historyToShow = reviewHistory.slice(-config.maxHistoryEntries);
			for (let i = 0; i < historyToShow.length; i++) {
				const review = historyToShow[i];
				const cycleNum = reviewHistory.length - historyToShow.length + i + 1;
				lines.push(`### Review Cycle ${cycleNum}`);
				lines.push(`- **All Passing:** ${review.allPassing}`);
				lines.push(`- **Summary:** ${review.summary}`);
				lines.push(`- **Issues Found:** ${review.issues.length}`);
				lines.push(`- **Duration:** ${(review.duration / 1000).toFixed(1)}s`);
				lines.push(`- **Cost:** $${review.cost.toFixed(4)}`);
				lines.push(``);
			}
		}
	}

	if (events.length > 0) {
		lines.push(`## Recent Events`);
		const recentEvents = events.slice(-config.maxHistoryEntries);
		for (const ev of recentEvents) {
			const time = new Date(ev.timestamp).toISOString().slice(11, 19);
			let desc = "";
			switch (ev.type) {
				case "worker_started":
					desc = `Worker ${ev.workerId.slice(0, 4)} started`;
					break;
				case "worker_completed":
					desc = `Worker ${ev.workerId.slice(0, 4)} completed`;
					break;
				case "worker_failed":
					desc = `Worker ${ev.workerId.slice(0, 4)} failed: ${ev.error}`;
					break;
				case "phase_complete":
					desc = `Phase ${ev.phase} complete ($${ev.cost.toFixed(2)})`;
					break;
				case "cost_limit_reached":
					desc = `Cost limit reached: $${ev.total.toFixed(2)}`;
					break;
				default:
					desc = ev.type;
			}
			lines.push(`- [${time}] ${desc}`);
		}
		lines.push(``);
	}

	return lines.join("\n");
}

export async function appendDiscovery(coordDir: string, discovery: Discovery): Promise<void> {
	const lockPath = path.join(coordDir, "discoveries.lock");
	const discoveriesPath = path.join(coordDir, "discoveries.json");

	const maxRetries = 50;
	const retryDelay = 100;

	for (let i = 0; i < maxRetries; i++) {
		try {
			const fd = fsSync.openSync(lockPath, fsSync.constants.O_CREAT | fsSync.constants.O_EXCL | fsSync.constants.O_RDWR);
			fsSync.closeSync(fd);
			break;
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code === "EEXIST") {
				await new Promise((r) => setTimeout(r, retryDelay));
				if (i === maxRetries - 1) throw new Error("Failed to acquire discoveries.json lock");
			} else {
				throw err;
			}
		}
	}

	try {
		let discoveries: Discovery[] = [];
		try {
			const content = await fs.readFile(discoveriesPath, "utf-8");
			discoveries = JSON.parse(content);
		} catch {}

		discoveries.push(discovery);
		await fs.writeFile(discoveriesPath, JSON.stringify(discoveries, null, 2));

		const progressPath = path.join(coordDir, "PROGRESS.md");
		let progressContent = "";
		try {
			progressContent = await fs.readFile(progressPath, "utf-8");
		} catch {}

		const discoveriesSection = generateDiscoveriesSection(discoveries);

		if (progressContent.includes("## Discoveries (Shared Knowledge)")) {
			progressContent = progressContent.replace(
				/## Discoveries \(Shared Knowledge\)[\s\S]*?(?=\n## |$)/,
				discoveriesSection,
			);
		} else {
			progressContent = progressContent + "\n" + discoveriesSection;
		}

		await fs.writeFile(progressPath, progressContent);
	} finally {
		try {
			fsSync.unlinkSync(lockPath);
		} catch {}
	}
}

function generateDiscoveriesSection(discoveries: Discovery[]): string {
	const lines: string[] = [];
	lines.push(`## Discoveries (Shared Knowledge)`);
	lines.push(``);

	const sorted = [...discoveries].sort((a, b) => {
		const importanceOrder = { critical: 0, important: 1, fyi: 2 };
		return importanceOrder[a.importance] - importanceOrder[b.importance];
	});

	for (const d of sorted) {
		const time = new Date(d.timestamp).toISOString().slice(11, 19);
		const tag = d.importance === "critical" ? "[CRITICAL]" : d.importance === "important" ? "[IMPORTANT]" : "[FYI]";
		lines.push(`### ${tag} ${d.topic}`);
		lines.push(`- **From:** ${d.workerIdentity} at ${time}`);
		lines.push(`- ${d.content}`);
		lines.push(``);
	}

	return lines.join("\n");
}

export async function getDiscoveries(coordDir: string): Promise<Discovery[]> {
	const discoveriesPath = path.join(coordDir, "discoveries.json");
	try {
		const content = await fs.readFile(discoveriesPath, "utf-8");
		return JSON.parse(content);
	} catch {
		return [];
	}
}
