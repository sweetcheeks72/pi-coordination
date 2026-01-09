/**
 * Smart Auto-Continue
 *
 * Handles intelligent worker restart logic at the spawn level (not coordinator).
 * When a worker exits non-zero, this module:
 * 1. Loads the task's context.md
 * 2. Analyzes what was done and what failed
 * 3. Builds a continuation prompt with context
 * 4. Spawns a new worker with that prompt
 *
 * This is more efficient than routing restarts through the coordinator,
 * as simple recovery cases don't need coordinator involvement.
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { FileBasedStorage } from "./state.js";
import type { Task, WorkerStateFile } from "./types.js";
import type { TaskQueueManager } from "./task-queue.js";
import type { ObservabilityContext } from "./observability/index.js";
import {
	loadContext,
	inferExitReason,
	type WorkerContext,
} from "./worker-context.js";

/**
 * Result of processing a worker exit.
 */
export type WorkerExitResult =
	| { action: "completed" }
	| { action: "restarted"; newWorkerId: string; newIdentity: string; attemptNumber: number }
	| { action: "failed"; reason: string };

/**
 * Configuration for auto-continue behavior.
 */
export interface AutoContinueConfig {
	/** Maximum restart attempts (default: 2) */
	maxRestarts?: number;
	/** Whether to log decisions (default: true) */
	logDecisions?: boolean;
}

/**
 * Process a worker exit and decide what to do.
 *
 * Returns:
 * - "completed" if worker exited successfully
 * - "restarted" if a new worker was spawned with context
 * - "failed" if max restarts exceeded or unrecoverable error
 */
export async function processWorkerExit(
	coordDir: string,
	taskId: string,
	workerId: string,
	workerIdentity: string,
	exitCode: number,
	storage: FileBasedStorage,
	taskQueue: TaskQueueManager,
	restartCounts: Map<string, number>,
	config: AutoContinueConfig = {},
	obs?: ObservabilityContext,
): Promise<WorkerExitResult> {
	const maxRestarts = config.maxRestarts ?? 2;

	// Success - check if worker actually completed
	if (exitCode === 0) {
		const workerState = await loadWorkerState(storage, workerId);

		// Verify worker called agent_work({ action: 'complete' })
		if (workerState?.status === "complete") {
			await taskQueue.markTaskComplete(taskId, workerIdentity);

			await obs?.events.emit({
				type: "task_completed",
				taskId,
				workerId,
				filesModified: workerState.filesModified || [],
			});

			return { action: "completed" };
		}

		// Exit 0 but didn't complete - treat as needing restart
		// Fall through to restart logic
	}

	// Load context and state
	const context = await loadContext(coordDir, taskId);
	const workerState = await loadWorkerState(storage, workerId);

	// Check restart count
	const restartCount = (restartCounts.get(taskId) || 0) + 1;
	restartCounts.set(taskId, restartCount);

	if (restartCount > maxRestarts) {
		const reason = `Max restarts (${maxRestarts}) exceeded`;
		await taskQueue.markTaskFailed(taskId, reason);

		await logDecision(coordDir, {
			type: "abort",
			taskId,
			previousWorker: workerId,
			attempt: restartCount,
			reason,
		});

		await obs?.events.emit({
			type: "worker_abandoned",
			workerId,
			reason,
		});

		return { action: "failed", reason };
	}

	// Analyze failure and build continuation info
	const failureReason = inferFailureReason(exitCode, workerState, context);

	await logDecision(coordDir, {
		type: "auto_restart",
		taskId,
		previousWorker: workerId,
		attempt: restartCount,
		reason: failureReason,
		reasoning: "Context preserved, error hint added to prompt",
	});

	await obs?.events.emit({
		type: "worker_restarting",
		workerId,
		restartCount,
	});

	// Build the continuation prompt (used by the caller to spawn new worker)
	const newWorkerId = randomUUID();
	const newIdentity = `worker:${taskId}-r${restartCount}`;

	return {
		action: "restarted",
		newWorkerId,
		newIdentity,
		attemptNumber: restartCount + 1,
	};
}

/**
 * Build a continuation prompt for a restarted worker.
 *
 * This prompt includes:
 * - Original task description
 * - Files already modified (don't redo)
 * - Errors from previous attempt
 * - Discoveries made
 * - Continuation notes
 */
export function buildContinuationPrompt(opts: {
	task: Task;
	context: WorkerContext | null;
	workerState: WorkerStateFile | null;
	exitCode: number;
	attemptNumber: number;
	planContent?: string;
}): string {
	const { task, context, workerState, exitCode, attemptNumber, planContent } = opts;

	const sections: string[] = [];

	// Header
	sections.push(`## Task: ${task.id} (Continuation - Attempt ${attemptNumber})`);
	sections.push("");
	sections.push(task.description);
	sections.push("");

	// Continuation warning
	sections.push(`### ⚠️ CONTINUATION FROM FAILED ATTEMPT`);
	sections.push("");
	sections.push(`This is attempt ${attemptNumber}. Previous attempt exited with code ${exitCode}.`);
	const exitReason = inferExitReason(exitCode);
	sections.push(`Exit reason: ${exitReason}`);
	sections.push("");

	// Previous progress from context
	if (context) {
		// Files already modified
		if (context.filesModified.length > 0) {
			sections.push(`### Files Already Modified (verify before recreating)`);
			for (const f of context.filesModified) {
				const statusIcon =
					f.status === "complete" ? "✓" : f.status === "partial" ? "⚠️" : "✗";
				sections.push(`- ${statusIcon} ${f.file} (${f.action})`);
				if (f.errorMessage) {
					const loc = f.errorLine ? ` at line ${f.errorLine}` : "";
					sections.push(`  - Error${loc}: ${f.errorMessage.slice(0, 100)}`);
				}
			}
			sections.push("");
		}

		// Discoveries
		if (context.discoveries.length > 0) {
			sections.push(`### Discoveries from Previous Attempt`);
			for (const d of context.discoveries) {
				sections.push(`- ${d}`);
			}
			sections.push("");
		}

		// Continuation notes
		if (context.continuationNotes.length > 0) {
			sections.push(`### Continuation Notes`);
			for (const note of context.continuationNotes) {
				sections.push(`- ${note}`);
			}
			sections.push("");
		}

		// Recent actions before failure
		if (context.lastActions.length > 0) {
			sections.push(`### Last Actions Before Failure`);
			const recentActions = context.lastActions.slice(0, 5);
			for (const action of recentActions) {
				const time = new Date(action.timestamp).toISOString().slice(11, 19);
				const status = action.result === "error" ? "✗" : "✓";
				const target = action.target ? `: ${action.target}` : "";
				sections.push(`- [${time}] ${status} ${action.tool}${target}`);
				if (action.errorMessage) {
					sections.push(`  - ${action.errorMessage.slice(0, 100)}`);
				}
			}
			sections.push("");
		}
	}

	// Standard task info
	sections.push(`### Files`);
	sections.push(
		task.files?.map((f) => `- ${f}`).join("\n") || "No specific files assigned",
	);
	sections.push("");

	sections.push(`### Acceptance Criteria`);
	sections.push(
		task.acceptanceCriteria?.map((c) => `- ${c}`).join("\n") ||
			"- Complete the task as described",
	);
	sections.push("");

	// Instructions for continuation
	sections.push(`### Instructions`);
	sections.push(`1. First, verify which files from previous attempt are valid`);
	sections.push(`2. Don't redo work that's already complete`);
	sections.push(`3. Focus on fixing the issue that caused the previous failure`);
	sections.push(`4. Call agent_work({ action: 'complete' }) when done`);
	sections.push("");

	// Include plan if provided
	if (planContent) {
		sections.push(`### Full Plan`);
		sections.push("```markdown");
		sections.push(planContent);
		sections.push("```");
	}

	return sections.join("\n");
}

/**
 * Infer the failure reason from available information.
 */
export function inferFailureReason(
	exitCode: number,
	workerState: WorkerStateFile | null,
	context: WorkerContext | null,
): string {
	// Check for common exit codes
	if (exitCode === 137) return "Out of memory (killed by OOM)";
	if (exitCode === 143) return "Terminated (SIGTERM)";
	if (exitCode === 124) return "Timeout";
	if (exitCode === 42) return "Restart requested by worker";

	// Check last action from context
	const lastAction = context?.lastActions[0];
	if (lastAction?.result === "error") {
		return `Error in ${lastAction.tool}: ${lastAction.errorMessage || "unknown"}`;
	}

	// Check worker state
	if (workerState?.errorMessage) {
		return workerState.errorMessage;
	}
	if (workerState?.errorType) {
		return `Error type: ${workerState.errorType}`;
	}

	return `Unknown (exit code ${exitCode})`;
}

/**
 * Check if an exit code indicates a recoverable failure.
 */
export function isRecoverableExit(exitCode: number): boolean {
	// Non-recoverable: OOM (137), SIGKILL (9)
	// Recoverable: Everything else including SIGTERM (143), timeout (124), restart (42)
	return exitCode !== 137 && exitCode !== 9;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

async function loadWorkerState(
	storage: FileBasedStorage,
	workerId: string,
): Promise<WorkerStateFile | null> {
	try {
		return await storage.readWorkerState(workerId);
	} catch {
		return null;
	}
}

interface AutoContinueDecision {
	type: "auto_restart" | "abort";
	taskId: string;
	previousWorker: string;
	attempt: number;
	reason: string;
	reasoning?: string;
}

async function logDecision(
	coordDir: string,
	decision: AutoContinueDecision,
): Promise<void> {
	const { DecisionLogger } = await import("./observability/decisions.js");
	const logger = new DecisionLogger(coordDir, process.env.PI_TRACE_ID || "");

	await logger.log({
		actor: "auto-continue",
		actorType: "system",
		spanId: "root",
		type: decision.type === "abort" ? "abort" : "retry_strategy",
		decision: {
			chosen: {
				taskId: decision.taskId,
				action: decision.type,
				attempt: decision.attempt,
			},
			reason: decision.reason,
		},
		context: {
			inputs: {
				previousWorker: decision.previousWorker,
				attempt: decision.attempt,
			},
		},
	});
}
