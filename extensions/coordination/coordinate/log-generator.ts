import * as path from "node:path";
import type { CoordinationState, CoordinationEvent, WorkerStateFile, PipelineState, ReviewIssue, CostState } from "./types.js";
import type { SingleResult } from "../subagent/types.js";
import type { ReviewResult } from "./phases/review.js";

interface LogData {
	sessionId: string;
	coordDir: string;
	planPath: string;
	planContent: string;
	state: CoordinationState;
	workerStates: WorkerStateFile[];
	events: CoordinationEvent[];
	coordinatorResult: SingleResult;
	startedAt: number;
	completedAt: number;
	pipelineState?: PipelineState;
	reviewHistory?: ReviewResult[];
	costState?: CostState;
}

function formatDuration(ms: number): string {
	const secs = Math.floor(ms / 1000);
	if (secs < 60) return `${secs}s`;
	const mins = Math.floor(secs / 60);
	const remainingSecs = secs % 60;
	if (mins < 60) return `${mins}m ${remainingSecs}s`;
	const hours = Math.floor(mins / 60);
	const remainingMins = mins % 60;
	return `${hours}h ${remainingMins}m`;
}

function formatTimestamp(ts: number): string {
	return new Date(ts).toISOString().replace("T", " ").replace("Z", "");
}

function formatRelativeTime(ts: number, baseTs: number): string {
	const diff = (ts - baseTs) / 1000;
	return `+${diff.toFixed(1)}s`;
}

export function generateCoordinationLog(data: LogData): string {
	const {
		sessionId,
		coordDir,
		planPath,
		planContent,
		state,
		workerStates,
		events,
		coordinatorResult,
		startedAt,
		completedAt,
		pipelineState,
		reviewHistory,
		costState,
	} = data;

	const duration = completedAt - startedAt;
	const totalCost = workerStates.reduce((sum, w) => sum + w.usage.cost, 0);
	const totalTurns = workerStates.reduce((sum, w) => sum + w.usage.turns, 0);
	const successCount = workerStates.filter(w => w.status === "complete").length;
	const failedCount = workerStates.filter(w => w.status === "failed").length;

	const lines: string[] = [];

	lines.push(`# Coordination Log`);
	lines.push(``);

	const reviewCycles = pipelineState?.fixCycle || 0;
	const outcomeText = failedCount > 0 
		? `${failedCount} worker(s) failed` 
		: state.status === "complete" 
			? "all tasks completed successfully" 
			: `ended with status: ${state.status}`;
	lines.push(`## Executive Summary`);
	lines.push(``);
	lines.push(`This coordination session executed the **${path.basename(planPath)}** plan in ${formatDuration(duration)}. ${successCount} workers completed ${workerStates.reduce((sum, w) => sum + w.completedSteps.length, 0)} tasks${reviewCycles > 0 ? ` with ${reviewCycles} review cycle(s)` : ""}. Total cost: $${totalCost.toFixed(4)}. Outcome: ${outcomeText}.`);
	lines.push(``);

	lines.push(`**Session ID:** \`${sessionId}\``);
	lines.push(`**Status:** ${state.status === "complete" ? "Completed" : state.status}`);
	lines.push(`**Started:** ${formatTimestamp(startedAt)}`);
	lines.push(`**Duration:** ${formatDuration(duration)}`);
	lines.push(`**Total Cost:** $${totalCost.toFixed(4)}`);
	lines.push(`**Workers:** ${successCount}/${workerStates.length} succeeded${failedCount > 0 ? `, ${failedCount} failed` : ""}`);
	lines.push(``);

	if (pipelineState) {
		lines.push(`## Phase Timeline`);
		lines.push(``);
		lines.push(`| Phase       | Status   | Duration | Cost   | Notes                    |`);
		lines.push(`|-------------|----------|----------|--------|--------------------------|`);

		const phases = ["scout", "coordinator", "workers", "review", "fixes", "complete"] as const;
		for (const phase of phases) {
			const result = pipelineState.phases[phase];
			if (!result || result.status === "pending") continue;
			
			const phaseDuration = result.startedAt && result.completedAt 
				? formatDuration(result.completedAt - result.startedAt)
				: "--";
			const phaseCost = costState?.byPhase[phase] 
				? `$${costState.byPhase[phase].toFixed(2)}`
				: "--";
			const notes = result.error || "";
			
			lines.push(`| ${phase.padEnd(11)} | ${result.status.padEnd(8)} | ${phaseDuration.padEnd(8)} | ${phaseCost.padEnd(6)} | ${notes.slice(0, 24).padEnd(24)} |`);
		}
		lines.push(``);
	}

	lines.push(`## Plan`);
	lines.push(``);
	lines.push(`**File:** \`${planPath}\``);
	lines.push(``);
	lines.push(`<details>`);
	lines.push(`<summary>Plan Content</summary>`);
	lines.push(``);
	lines.push("```markdown");
	lines.push(planContent);
	lines.push("```");
	lines.push(``);
	lines.push(`</details>`);
	lines.push(``);

	lines.push(`## Workers Summary`);
	lines.push(``);
	lines.push(`| Worker | Status | Duration | Cost | Turns | Files Modified |`);
	lines.push(`|--------|--------|----------|------|-------|----------------|`);

	for (const w of workerStates) {
		const wDuration = w.completedAt && w.startedAt
			? formatDuration(w.completedAt - w.startedAt)
			: "--";
		const statusIcon = w.status === "complete" ? "ok" : w.status === "failed" ? "FAILED" : w.status;
		const files = w.filesModified.length > 0
			? w.filesModified.map(f => `\`${path.basename(f)}\``).join(", ")
			: "--";
		
		lines.push(`| ${w.identity} | ${statusIcon} | ${wDuration} | $${w.usage.cost.toFixed(4)} | ${w.usage.turns} | ${files} |`);
	}
	lines.push(``);

	if (Object.keys(state.contracts).length > 0) {
		lines.push(`## Contracts`);
		lines.push(``);
		lines.push(`| Item | Type | Provider | Waiters | Status |`);
		lines.push(`|------|------|----------|---------|--------|`);

		for (const [item, contract] of Object.entries(state.contracts)) {
			const waiters = contract.waiters.join(", ") || "--";
			lines.push(`| ${item} | ${contract.type} | ${contract.provider} | ${waiters} | ${contract.status} |`);
		}
		lines.push(``);
	}

	lines.push(`## Event Timeline`);
	lines.push(``);

	const sortedEvents = [...events].sort((a, b) => a.timestamp - b.timestamp);
	const baseTs = sortedEvents[0]?.timestamp || startedAt;

	for (const ev of sortedEvents) {
		const relTime = formatRelativeTime(ev.timestamp, baseTs);
		let line = `- \`${relTime}\` `;

		switch (ev.type) {
			case "worker_started":
				line += `**[${ev.workerId.slice(0, 8)}]** Worker started`;
				break;
			case "worker_completed":
				line += `**[${ev.workerId.slice(0, 8)}]** Worker completed`;
				break;
			case "worker_failed":
				line += `**[${ev.workerId.slice(0, 8)}]** Worker FAILED: ${ev.error}`;
				break;
			case "tool_call":
				line += `[${ev.workerId.slice(0, 8)}] ${ev.tool}${ev.file ? ` (${path.basename(ev.file)})` : ""}`;
				break;
			case "tool_result":
				line += `[${ev.workerId.slice(0, 8)}] ${ev.tool} ${ev.success ? "ok" : "ERROR"}`;
				break;
			case "waiting":
				line += `[${ev.workerId.slice(0, 8)}] Waiting for "${ev.item}" from ${ev.waitingFor}`;
				break;
			case "contract_received":
				line += `[${ev.workerId.slice(0, 8)}] Received "${ev.item}" from ${ev.from}`;
				break;
			case "cost_milestone":
				line += `**Cost milestone:** $${ev.aggregate.toFixed(2)}`;
				break;
			case "coordinator":
				line += `[coordinator] ${ev.message}`;
				break;
			case "phase_complete":
				line += `**Phase ${ev.phase} complete** (${formatDuration(ev.duration)}, $${ev.cost.toFixed(2)})`;
				break;
			case "cost_limit_reached":
				line += `**Cost limit reached:** $${ev.total.toFixed(2)}`;
				break;
		}

		lines.push(line);
	}
	lines.push(``);

	lines.push(`## Worker Details`);
	lines.push(``);

	for (const w of workerStates) {
		lines.push(`### ${w.identity}`);
		lines.push(``);
		lines.push(`- **Agent:** ${w.agent}`);
		lines.push(`- **Status:** ${w.status}`);
		lines.push(`- **Assigned Steps:** ${w.assignedSteps.join(", ") || "none"}`);
		lines.push(`- **Completed Steps:** ${w.completedSteps.join(", ") || "none"}`);
		
		if (w.blockers.length > 0) {
			lines.push(`- **Blockers:** ${w.blockers.join("; ")}`);
		}
		
		if (w.errorMessage) {
			lines.push(`- **Error:** ${w.errorMessage}`);
		}

		lines.push(``);
		lines.push(`<details>`);
		lines.push(`<summary>Handshake Spec</summary>`);
		lines.push(``);
		lines.push("```");
		lines.push(w.handshakeSpec);
		lines.push("```");
		lines.push(``);
		lines.push(`</details>`);
		lines.push(``);

		if (w.filesModified.length > 0) {
			lines.push(`**Files Modified:**`);
			for (const f of w.filesModified) {
				lines.push(`- \`${f}\``);
			}
			lines.push(``);
		}
	}

	if (reviewHistory && reviewHistory.length > 0) {
		lines.push(`## Review Cycles`);
		lines.push(``);

		for (let i = 0; i < reviewHistory.length; i++) {
			const review = reviewHistory[i];
			lines.push(`### Review Cycle ${i + 1}`);
			lines.push(``);
			lines.push(`- **All Passing:** ${review.allPassing ? "Yes" : "No"}`);
			lines.push(`- **Summary:** ${review.summary}`);
			lines.push(`- **Duration:** ${formatDuration(review.duration)}`);
			lines.push(`- **Cost:** $${review.cost.toFixed(4)}`);
			lines.push(``);

			if (review.issues.length > 0) {
				lines.push(`**Issues Found:**`);
				lines.push(``);
				for (const issue of review.issues) {
					lines.push(`- **${issue.file}:${issue.line || "?"}** (${issue.severity}/${issue.category}): ${issue.description}`);
					if (issue.suggestedFix) {
						lines.push(`  - Suggested: ${issue.suggestedFix}`);
					}
				}
				lines.push(``);
			}
		}
	}

	if (state.deviations.length > 0) {
		lines.push(`## Deviations`);
		lines.push(``);
		for (const d of state.deviations) {
			lines.push(`- **${d.type}:** ${d.description}`);
		}
		lines.push(``);
	}

	if (costState) {
		lines.push(`## Cost Breakdown`);
		lines.push(``);
		lines.push(`**Total:** $${costState.total.toFixed(4)}`);
		lines.push(``);

		if (Object.keys(costState.byPhase).length > 0) {
			lines.push(`**By Phase:**`);
			for (const [phase, cost] of Object.entries(costState.byPhase)) {
				if (cost > 0) {
					lines.push(`- ${phase}: $${cost.toFixed(4)}`);
				}
			}
			lines.push(``);
		}

		if (Object.keys(costState.byWorker).length > 0) {
			lines.push(`**By Worker:**`);
			for (const [workerId, cost] of Object.entries(costState.byWorker)) {
				if (cost > 0) {
					lines.push(`- ${workerId.slice(0, 8)}: $${cost.toFixed(4)}`);
				}
			}
			lines.push(``);
		}

		lines.push(`**Limit:** $${costState.limit.toFixed(2)}${costState.limitReached ? " (reached)" : ""}`);
		lines.push(``);
	}

	lines.push(`## Metadata`);
	lines.push(``);
	lines.push(`- **Coordination Directory:** \`${coordDir}\``);
	lines.push(`- **Plan Hash:** \`${state.planHash}\``);
	lines.push(`- **Total Input Tokens:** ${workerStates.reduce((sum, w) => sum + w.usage.input, 0)}`);
	lines.push(`- **Total Output Tokens:** ${workerStates.reduce((sum, w) => sum + w.usage.output, 0)}`);
	lines.push(`- **Total Turns:** ${totalTurns}`);
	lines.push(``);

	return lines.join("\n");
}
