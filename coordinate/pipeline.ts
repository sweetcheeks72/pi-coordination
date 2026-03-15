import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { AgentRuntime } from "../subagent/runner.js";
import type {
	PipelinePhase,
	PipelineState,
	PhaseResult,
	CostState,
	CoordinationState,
	WorkerStateFile,
	ReviewIssue,
} from "./types.js";
import type { OutputLimits } from "../subagent/types.js";
import { FileBasedStorage } from "./state.js";
import { CheckpointManager, PHASE_ORDER } from "./checkpoint.js";
import { generateProgressDoc } from "./progress.js";
import { runScoutPhase, type ScoutConfig } from "./phases/scout.js";
import { runPlannerPhase, createTaskQueueFromPlanner, runPlannerBackgroundReview, type PlannerPhaseConfig } from "./phases/planner.js";
import { runReviewPhase, type ReviewConfig, type ReviewResult, type NewTaskRequest } from "./phases/review.js";
import { runIntegrationReview, type IntegrationReviewConfig, type IntegrationReviewResult } from "./phases/integration.js";
import { TaskQueueManager } from "./task-queue.js";
import { runFixPhase, type FixConfig } from "./phases/fix.js";
import { ObservabilityContext } from "./observability/index.js";
import type { Task, PlannerConfig, SelfReviewConfig, SupervisorConfig } from "./types.js";

export interface PipelineConfig {
	planPath: string;
	planContent: string;
	planDir: string;
	coordDir: string;
	sessionId: string;
	agents: string[];
	maxFixCycles: number;
	sameIssueLimit: number;
	checkTests: boolean;
	costLimit: number;
	maxOutput?: OutputLimits;
	models?: {
		scout?: string;
		planner?: string;
		coordinator?: string;
		worker?: string;
		reviewer?: string;
	};
	skipScout?: boolean; // Two-track: scout phase is now in plan tool, always skipped in coordinate
	planner?: Partial<PlannerConfig>;
	selfReview?: Partial<SelfReviewConfig>;
	supervisor?: Partial<SupervisorConfig & { enabled: boolean }>;
}

export interface PipelineContext {
	runtime: AgentRuntime;
	storage: FileBasedStorage;
	checkpointManager: CheckpointManager;
	pipelineState: PipelineState;
	costState: CostState;
	reviewHistory: ReviewResult[];
	signal?: AbortSignal;
	onUpdate?: (partial: AgentToolResult<unknown>) => void;
	obs?: ObservabilityContext;
	abort?: () => void;
	plannerTasks?: Task[];
	plannerBackgroundAbort?: AbortController;
}

export interface PipelineResult {
	success: boolean;
	exitReason: PipelineState["exitReason"];
	pipelineState: PipelineState;
	costState: CostState;
	reviewHistory: ReviewResult[];
}

export function initializePipelineState(
	sessionId: string,
	planPath: string,
	planHash: string,
	maxFixCycles: number,
): PipelineState {
	const phases: Record<PipelinePhase, PhaseResult> = {} as Record<PipelinePhase, PhaseResult>;
	for (const phase of PHASE_ORDER) {
		phases[phase] = {
			phase,
			status: "pending",
			attempt: 0,
		};
	}
	phases.failed = { phase: "failed", status: "pending", attempt: 0 };

	return {
		sessionId,
		planPath,
		planHash,
		currentPhase: "scout",
		phases,
		fixCycle: 0,
		maxFixCycles,
		startedAt: Date.now(),
	};
}

export function initializeCostState(costLimit: number): CostState {
	return {
		total: 0,
		byPhase: {
			scout: 0,
			planner: 0,
			coordinator: 0,
			workers: 0,
			review: 0,
			fixes: 0,
			complete: 0,
			failed: 0,
		},
		byWorker: {},
		limit: costLimit,
		limitReached: false,
	};
}

export function updatePhaseStatus(
	phase: PipelinePhase,
	status: PhaseResult["status"],
	ctx: PipelineContext,
	error?: string,
): void {
	const now = Date.now();
	const phaseResult = ctx.pipelineState.phases[phase];

	if (status === "running" && phaseResult.status !== "running") {
		phaseResult.startedAt = now;
		phaseResult.attempt++;

		ctx.obs?.events.setPhase(phase);
		ctx.obs?.events.emit({ type: "phase_started", phase }).catch(e => console.debug('[coord:obs]', e?.message ?? 'unknown error'));
	}

	if (status === "complete" || status === "failed") {
		phaseResult.completedAt = now;
	}

	phaseResult.status = status;
	if (error) {
		phaseResult.error = error;
	}

	if (status === "running") {
		ctx.pipelineState.currentPhase = phase;
	}

	if (status === "complete" || status === "failed") {
		const duration = phaseResult.completedAt && phaseResult.startedAt
			? phaseResult.completedAt - phaseResult.startedAt
			: 0;
		const cost = ctx.costState.byPhase[phase];

		ctx.storage.appendEvent({
			type: "phase_complete",
			phase,
			duration,
			cost,
			timestamp: now,
		}).catch(e => console.debug('[coord:obs]', e?.message ?? 'unknown error'));

		ctx.obs?.events.emit({
			type: "phase_completed",
			phase,
			duration,
			cost,
		}).catch(e => console.debug('[coord:obs]', e?.message ?? 'unknown error'));
	}
}

export async function saveProgressDoc(ctx: PipelineContext): Promise<void> {
	const coordState = await ctx.storage.getState();
	const workerStates = await ctx.storage.listWorkerStates();
	const events = await ctx.storage.getEvents();

	const progressContent = generateProgressDoc(
		ctx.pipelineState,
		coordState,
		workerStates,
		events,
		ctx.reviewHistory,
		{ includeDetailedHistory: true, maxHistoryEntries: 50 },
	);

	const progressPath = path.join(ctx.storage.coordDir, "progress.md");
	await fs.writeFile(progressPath, progressContent);
}

export async function checkCostLimit(ctx: PipelineContext): Promise<boolean> {
	const { total, limit, limitReached } = ctx.costState;

	if (total >= limit && !limitReached) {
		ctx.costState.limitReached = true;
		await ctx.storage.appendEvent({ type: "cost_limit_reached", total, limit, timestamp: Date.now() });
		await ctx.obs?.events.emit({ type: "cost_limit_reached", total, limit });
		console.warn(`[COST LIMIT] Reached $${total.toFixed(2)} / $${limit.toFixed(2)} - ending coordination gracefully`);
		ctx.pipelineState.exitReason = "cost_limit";
		return true;
	}

	return false;
}

function countMatchingIssues(
	currentDescriptions: Set<string>,
	candidateIssues: ReviewIssue[],
): number {
	const candidateDescriptions = new Set(candidateIssues.map(i => `${i.file}:${i.description}`));
	let count = 0;
	for (const desc of currentDescriptions) {
		if (candidateDescriptions.has(desc)) {
			count++;
		}
	}
	return count;
}

function detectStuckIssues(
	currentIssues: ReviewIssue[],
	reviewHistory: ReviewResult[],
	sameIssueLimit: number,
): boolean {
	if (reviewHistory.length < 2) return false;
	if (currentIssues.length === 0) return false;

	const currentDescriptions = new Set(currentIssues.map(i => `${i.file}:${i.description}`));
	const threshold = Math.min(sameIssueLimit, currentIssues.length);

	// Check N vs N-1: same issues persist in consecutive reviews
	const previousIssues = reviewHistory[reviewHistory.length - 2]?.issues || [];
	if (previousIssues.length > 0) {
		const sameCount = countMatchingIssues(currentDescriptions, previousIssues);
		if (sameCount >= threshold) return true;
	}

	// Check N vs N-2: A→B→A oscillation — same issues recur after one intermediate cycle
	if (reviewHistory.length >= 3) {
		const twoBackIssues = reviewHistory[reviewHistory.length - 3]?.issues || [];
		if (twoBackIssues.length > 0) {
			const oscillationCount = countMatchingIssues(currentDescriptions, twoBackIssues);
			if (oscillationCount >= threshold) return true;
		}
	}

	return false;
}

export async function runScoutPhaseWrapper(
	ctx: PipelineContext,
	config: PipelineConfig,
): Promise<void> {
	// Two-track: scout phase is now in plan tool, always skipped in coordinate
	if (config.skipScout) {
		updatePhaseStatus("scout", "skipped", ctx);
		ctx.pipelineState.scoutContext = ""; // No scout context when skipped
		return;
	}

	const span = ctx.obs?.spans.startSpan("phase:scout", "phase");
	await ctx.obs?.snapshots.capture("phase_start", "scout");

	updatePhaseStatus("scout", "running", ctx);

	try {
		const scoutConfig: ScoutConfig = {
			depth: "shallow",
			outputDir: path.join(config.coordDir, "scout"),
			maxFileSize: 50000,
			outputLimits: config.maxOutput,
			model: config.models?.scout,
			onProgress: (() => {
				let lastToolEndMs = 0; // Dedup: track last emitted tool
				let lastContextTokens = 0; // Track context growth for activity indication
				let lastActivityEmit = 0; // Rate limit activity events
				return (update: { details?: unknown }) => {
					const details = update.details as { results?: Array<{ recentTools?: Array<{ tool: string; args?: string; endMs: number }>; usage?: { contextTokens?: number } }> };
					const result = details?.results?.[0];
					const recentTools = result?.recentTools;
					const contextTokens = result?.usage?.contextTokens || 0;
					
					if (recentTools && recentTools.length > 0) {
						const latest = recentTools[0];
						// Emit if this is a NEW tool (different endMs)
						if (latest.endMs && latest.endMs !== lastToolEndMs) {
							lastToolEndMs = latest.endMs;
							lastActivityEmit = Date.now();
							ctx.storage.appendEvent({
								type: "tool_call",
								tool: latest.tool,
								file: latest.args,
								workerId: "scout",
								contextTokens,
								timestamp: Date.now(),
							}).catch((err) => {
								ctx.obs?.errors.capture(err, {
									category: "telemetry_error",
									severity: "warning",
									actor: "scout",
									phase: "scout",
									recoverable: true,
								}).catch(e => console.debug('[coord:obs]', e?.message ?? 'unknown error'));
							});
						}
					}
					
					// Emit activity event on token growth OR time-based heartbeat
					const now = Date.now();
					const tokenDelta = contextTokens - lastContextTokens;
					const timeSinceLastEmit = now - lastActivityEmit;
					
					// Emit if: tokens grew 2k+ OR 10 seconds passed (heartbeat)
					const shouldEmit = (tokenDelta >= 2000 && timeSinceLastEmit > 1500) || 
					                   (timeSinceLastEmit > 10000 && contextTokens > 0);
					
					if (shouldEmit) {
						lastContextTokens = contextTokens;
						lastActivityEmit = now;
						ctx.storage.appendEvent({
							type: "activity",
							phase: "scout",
							contextTokens,
							timestamp: now,
						}).catch(e => console.debug('[coord:obs]', e?.message ?? 'unknown error'));
					}
				};
			})(),
		};

		const result = await runScoutPhase(
			ctx.runtime,
			config.planPath,
			config.planContent,
			config.coordDir,
			scoutConfig,
			ctx.signal,
		);

		ctx.pipelineState.scoutContext = result.contextDoc;
		ctx.costState.byPhase.scout = result.cost;
		ctx.costState.total += result.cost;

		await ctx.obs?.events.emit({
			type: "cost_updated",
			delta: result.cost,
			total: ctx.costState.total,
			breakdown: { byPhase: ctx.costState.byPhase, byWorker: ctx.costState.byWorker },
		});

		const checkpointId = await ctx.checkpointManager.saveCheckpoint(
			"scout",
			ctx.pipelineState,
			ctx.costState,
			ctx.reviewHistory.map(r => r.issues),
		);
		await ctx.obs?.events.emit({ type: "checkpoint_saved", checkpointId, phase: "scout" });

		await saveProgressDoc(ctx);
		await ctx.obs?.snapshots.capture("phase_end", "scout");
		span && ctx.obs?.spans.endSpan(span.id, "ok", {}, { cost: result.cost });
		updatePhaseStatus("scout", "complete", ctx);
	} catch (err) {
		await ctx.obs?.errors.capture(err, {
			category: "system_error",
			severity: "error",
			actor: "coordinator",
			phase: "scout",
			spanId: span?.id || "root",
			recoverable: false,
		});
		span && ctx.obs?.spans.endSpan(span.id, "error");
		updatePhaseStatus("scout", "failed", ctx, String(err));
		throw err;
	}
}

export async function runPlannerPhaseWrapper(
	ctx: PipelineContext,
	config: PipelineConfig,
): Promise<Task[]> {
	if (!config.planner?.enabled) {
		updatePhaseStatus("planner", "skipped", ctx);
		return [];
	}

	const span = ctx.obs?.spans.startSpan("phase:planner", "phase");
	await ctx.obs?.snapshots.capture("phase_start", "planner");

	updatePhaseStatus("planner", "running", ctx);

	try {
		const plannerConfig: PlannerPhaseConfig = {
			humanCheckpoint: config.planner.humanCheckpoint,
			maxSelfReviewCycles: config.planner.maxSelfReviewCycles || 5,
			outputLimits: config.maxOutput,
			model: config.models?.planner,
			onProgress: (() => {
				let lastToolEndMs = 0; // Dedup: track last emitted tool
				return (update: { details?: unknown }) => {
					const details = update.details as { results?: Array<{ recentTools?: Array<{ tool: string; args?: string; endMs: number }>; usage?: { contextTokens?: number } }> };
					const result = details?.results?.[0];
					const recentTools = result?.recentTools;
					if (recentTools && recentTools.length > 0) {
						const latest = recentTools[0];
						// Only emit if this is a NEW tool (different endMs)
						if (latest.endMs && latest.endMs !== lastToolEndMs) {
							lastToolEndMs = latest.endMs;
							ctx.storage.appendEvent({
								type: "tool_call",
								tool: latest.tool,
								file: latest.args,
								workerId: "planner",
								contextTokens: result?.usage?.contextTokens,
								timestamp: Date.now(),
							}).catch((err) => {
								ctx.obs?.errors.capture(err, {
									category: "telemetry_error",
									severity: "warning",
									actor: "planner",
									phase: "planner",
									recoverable: true,
								}).catch(e => console.debug('[coord:obs]', e?.message ?? 'unknown error'));
							});
						}
					}
				};
			})(),
		};

		await ctx.obs?.events.emit({
			type: "planner_review_started",
			tasksToReview: 0,
		});

		const result = await runPlannerPhase(
			ctx.runtime,
			config.planContent,
			ctx.pipelineState.scoutContext || "",
			config.coordDir,
			plannerConfig,
			ctx.signal,
		);

		ctx.plannerTasks = result.tasks;
		ctx.costState.byPhase.planner += result.cost;
		ctx.costState.total += result.cost;

		await createTaskQueueFromPlanner(config.coordDir, config.planPath, result.tasks);

		await ctx.obs?.events.emit({
			type: "planner_review_complete",
			approved: result.tasks.length,
			rejected: 0,
			modified: 0,
		});

		await ctx.obs?.events.emit({
			type: "cost_updated",
			delta: result.cost,
			total: ctx.costState.total,
			breakdown: { byPhase: ctx.costState.byPhase, byWorker: ctx.costState.byWorker },
		});

		ctx.plannerBackgroundAbort = new AbortController();
		runPlannerBackgroundReview(
			ctx.runtime,
			config.coordDir,
			plannerConfig,
			ctx.plannerBackgroundAbort.signal,
		).catch(e => console.debug('[coord:obs]', e?.message ?? 'unknown error'));

		await saveProgressDoc(ctx);
		await ctx.obs?.snapshots.capture("phase_end", "planner");
		span && ctx.obs?.spans.endSpan(span.id, "ok", { taskCount: result.tasks.length }, { cost: result.cost });
		updatePhaseStatus("planner", "complete", ctx);

		return result.tasks;
	} catch (err) {
		await ctx.obs?.errors.capture(err, {
			category: "system_error",
			severity: "error",
			actor: "planner",
			phase: "planner",
			spanId: span?.id || "root",
			recoverable: false,
		});
		updatePhaseStatus("planner", "failed", ctx, String(err));
		span && ctx.obs?.spans.endSpan(span.id, "error");
		throw err;
	}
}

export async function runReviewPhaseWrapper(
	ctx: PipelineContext,
	config: PipelineConfig,
): Promise<ReviewResult> {
	const span = ctx.obs?.spans.startSpan("phase:review", "phase");
	const workerStates = await ctx.storage.listWorkerStates();
	const filesUnderReview = [...new Set(workerStates.flatMap(w => w.filesModified))];

	await ctx.obs?.events.emit({
		type: "review_started",
		cycleNumber: ctx.pipelineState.fixCycle,
		filesUnderReview,
	});

	updatePhaseStatus("review", "running", ctx);

	try {
		const reviewConfig: ReviewConfig = {
			model: config.models?.reviewer,
			checkTests: config.checkTests,
			verifyPlanGoals: true,
			outputLimits: config.maxOutput,
			onProgress: (() => {
				let lastToolEndMs = 0;
				return (update: { details?: unknown }) => {
					const details = update.details as { results?: Array<{ recentTools?: Array<{ tool: string; args?: string; endMs: number }>; usage?: { contextTokens?: number } }> };
					const result = details?.results?.[0];
					const recentTools = result?.recentTools;
					if (recentTools && recentTools.length > 0) {
						const latest = recentTools[0];
						if (latest.endMs && latest.endMs !== lastToolEndMs) {
							lastToolEndMs = latest.endMs;
							ctx.storage.appendEvent({
								type: "tool_call",
								tool: latest.tool,
								file: latest.args,
								workerId: "review",
								contextTokens: result?.usage?.contextTokens,
								timestamp: Date.now(),
							}).catch(e => console.debug('[coord:obs]', e?.message ?? 'unknown error'));
						}
					}
				};
			})(),
		};

		const result = await runReviewPhase(
			ctx.runtime,
			config.coordDir,
			config.planContent,
			workerStates,
			reviewConfig,
			ctx.signal,
		);

		ctx.reviewHistory.push(result);
		ctx.pipelineState.reviewIssues = result.issues;
		ctx.costState.byPhase.review += result.cost;
		ctx.costState.total += result.cost;

		await ctx.obs?.events.emit({
			type: "review_completed",
			cycleNumber: ctx.pipelineState.fixCycle,
			result: {
				issues: result.issues,
				allPassing: result.allPassing,
				filesReviewed: result.filesReviewed,
				duration: result.duration,
				cost: result.cost,
			},
		});

		await ctx.obs?.events.emit({
			type: "cost_updated",
			delta: result.cost,
			total: ctx.costState.total,
			breakdown: { byPhase: ctx.costState.byPhase, byWorker: ctx.costState.byWorker },
		});

		const checkpointId = await ctx.checkpointManager.saveCheckpoint(
			"review",
			ctx.pipelineState,
			ctx.costState,
			ctx.reviewHistory.map(r => r.issues),
		);
		await ctx.obs?.events.emit({ type: "checkpoint_saved", checkpointId, phase: "review" });

		// Create tasks from reviewer's newTasks (if any)
		if (result.newTasks && result.newTasks.length > 0) {
			const taskQueue = new TaskQueueManager(config.coordDir);

			for (const req of result.newTasks) {
				// ID auto-generated atomically inside addDiscoveredTask (FIX-XX for pending status)
				const task = await taskQueue.addDiscoveredTask(
					{
						description: req.description,
						priority: req.priority ?? 1,
						files: req.files,
						acceptanceCriteria: [`Reviewer: ${req.reason}`],
					},
					"pending", // Trusted - skip review, generates FIX-XX ID
				);

				await ctx.obs?.events.emit({
					type: "task_discovered",
					taskId: task.id,
					discoveredBy: "reviewer",
					discoveredFrom: "review",
				});
			}
		}

		await saveProgressDoc(ctx);
		span && ctx.obs?.spans.endSpan(span.id, "ok", { issueCount: result.issues.length }, { cost: result.cost });
		updatePhaseStatus("review", "complete", ctx);

		return result;
	} catch (err) {
		await ctx.obs?.errors.capture(err, {
			category: "system_error",
			severity: "error",
			actor: "reviewer",
			phase: "review",
			spanId: span?.id || "root",
			recoverable: false,
		});
		span && ctx.obs?.spans.endSpan(span.id, "error");
		updatePhaseStatus("review", "failed", ctx, String(err));
		throw err;
	}
}

export async function runFixPhaseWrapper(
	ctx: PipelineContext,
	config: PipelineConfig,
	issues: ReviewIssue[],
): Promise<void> {
	const span = ctx.obs?.spans.startSpan("phase:fixes", "phase");

	await ctx.obs?.events.emit({
		type: "fix_started",
		cycleNumber: ctx.pipelineState.fixCycle,
		issues,
	});

	updatePhaseStatus("fixes", "running", ctx);

	try {
		const workerStates = await ctx.storage.listWorkerStates();
		const fixConfig: FixConfig = {
			maxCycles: config.maxFixCycles,
			sameIssueLimit: config.sameIssueLimit,
		};

		const result = await runFixPhase(
			ctx.runtime,
			config.coordDir,
			issues,
			workerStates,
			fixConfig,
			ctx.pipelineState.fixCycle,
			ctx.signal,
			ctx.obs,
		);

		ctx.costState.byPhase.fixes += result.cost;
		ctx.costState.total += result.cost;

		if (result.exitReason === "max_cycles") {
			ctx.pipelineState.exitReason = "max_cycles";
		}

		await ctx.obs?.events.emit({
			type: "fix_completed",
			cycleNumber: ctx.pipelineState.fixCycle,
			result: {
				issuesFixed: result.issuesFixed,
				issuesFailed: issues.length - result.issuesFixed,
				duration: result.duration,
				cost: result.cost,
				exitReason: result.exitReason,
			},
		});

		await ctx.obs?.events.emit({
			type: "cost_updated",
			delta: result.cost,
			total: ctx.costState.total,
			breakdown: { byPhase: ctx.costState.byPhase, byWorker: ctx.costState.byWorker },
		});

		const checkpointId = await ctx.checkpointManager.saveCheckpoint(
			"fixes",
			ctx.pipelineState,
			ctx.costState,
			ctx.reviewHistory.map(r => r.issues),
		);
		await ctx.obs?.events.emit({ type: "checkpoint_saved", checkpointId, phase: "fixes" });

		await saveProgressDoc(ctx);
		span && ctx.obs?.spans.endSpan(span.id, "ok", { issuesFixed: result.issuesFixed }, { cost: result.cost });
		updatePhaseStatus("fixes", "complete", ctx);
	} catch (err) {
		await ctx.obs?.errors.capture(err, {
			category: "system_error",
			severity: "error",
			actor: "worker",
			phase: "fixes",
			spanId: span?.id || "root",
			recoverable: false,
		});
		span && ctx.obs?.spans.endSpan(span.id, "error");
		updatePhaseStatus("fixes", "failed", ctx, String(err));
		throw err;
	}
}

export async function runIntegrationReviewWrapper(
	ctx: PipelineContext,
	config: PipelineConfig,
): Promise<IntegrationReviewResult> {
	const span = ctx.obs?.spans.startSpan("phase:integration", "phase");

	await ctx.obs?.events.emit({
		type: "phase_started",
		phase: "integration",
	});

	updatePhaseStatus("integration", "running", ctx);

	try {
		const workerStates = await ctx.storage.listWorkerStates();
		const integrationConfig: IntegrationReviewConfig = {
			model: config.models?.reviewer,
			outputLimits: config.maxOutput,
			onProgress: ctx.onUpdate,
		};

		const result = await runIntegrationReview(
			ctx.runtime,
			config.coordDir,
			config.planContent,
			workerStates,
			integrationConfig,
			ctx.signal,
		);

		// Track integration cost under review phase
		ctx.costState.byPhase.review = (ctx.costState.byPhase.review || 0) + result.cost;
		ctx.costState.total += result.cost;

		await ctx.obs?.events.emit({
			type: "phase_completed",
			phase: "integration",
			result: {
				issueCount: result.issues.length,
				allPassing: result.allPassing,
				duration: result.duration,
				cost: result.cost,
			},
		});

		await saveProgressDoc(ctx);
		span && ctx.obs?.spans.endSpan(span.id, "ok", { issueCount: result.issues.length }, { cost: result.cost });
		updatePhaseStatus("integration", "complete", ctx);

		return result;
	} catch (err) {
		await ctx.obs?.errors.capture(err, {
			category: "system_error",
			severity: "error",
			actor: "reviewer",
			phase: "integration",
			spanId: span?.id || "root",
			recoverable: false,
		});
		span && ctx.obs?.spans.endSpan(span.id, "error");
		updatePhaseStatus("integration", "failed", ctx, String(err));
		throw err;
	}
}

export async function runReviewFixLoop(
	ctx: PipelineContext,
	config: PipelineConfig,
): Promise<void> {
	// Check cost limit before starting review loop
	if (await checkCostLimit(ctx)) {
		return;
	}

	// Run integration review first (catches cross-component issues)
	const integrationResult = await runIntegrationReviewWrapper(ctx, config);
	
	// If integration found issues, fix them before the regular review-fix loop
	if (!integrationResult.allPassing && integrationResult.issues.length > 0) {
		// Track integration issues in history
		ctx.reviewHistory.push({
			issues: integrationResult.issues,
			summary: integrationResult.summary,
			allPassing: false,
			filesReviewed: [],
			duration: integrationResult.duration,
			cost: integrationResult.cost,
		});

		// Fix integration issues first — use a separate counter so we don't burn
		// from the regular review-fix budget (fixes the off-by-one in cycle budget).
		// Cap at 3 iterations to prevent infinite loops on persistent integration failures.
		const maxIntegrationFixes = 3;
		let integrationFixCycle = 0;
		integrationFixCycle++;
		if (integrationFixCycle <= maxIntegrationFixes) {
			await runFixPhaseWrapper(ctx, config, integrationResult.issues);
			if (ctx.pipelineState.exitReason === "max_cycles") {
				return;
			}
		}
	}

	while (ctx.pipelineState.fixCycle < ctx.pipelineState.maxFixCycles) {
		if (await checkCostLimit(ctx)) {
			return;
		}

		const review = await runReviewPhaseWrapper(ctx, config);

		if (review.allPassing) {
			ctx.pipelineState.exitReason = "clean";
			return;
		}

		if (detectStuckIssues(review.issues, ctx.reviewHistory, config.sameIssueLimit)) {
			ctx.pipelineState.exitReason = "stuck";
			return;
		}

		ctx.pipelineState.fixCycle++;

		await runFixPhaseWrapper(ctx, config, review.issues);

		if (ctx.pipelineState.exitReason === "max_cycles") {
			return;
		}
	}

	ctx.pipelineState.exitReason = "max_cycles";
}
