import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { AgentRuntime } from "../subagent/runner.js";
import type {
	PipelinePhase,
	PipelineState,
	PhaseResult,
	CostState,
	CostThresholds,
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
import { runReviewPhase, type ReviewConfig, type ReviewResult } from "./phases/review.js";
import { runFixPhase, type FixConfig } from "./phases/fix.js";
import { ObservabilityContext } from "./observability/index.js";
import type { V2Config, Task } from "./types.js";

export interface PipelineConfig {
	planPath: string;
	planContent: string;
	planDir: string;
	coordDir: string;
	sessionId: string;
	agents: string[];
	maxFixCycles: number;
	sameIssueLimit: number;
	reviewModel?: string;
	checkTests: boolean;
	costThresholds: CostThresholds;
	pauseOnCostThreshold: boolean;
	maxOutput?: OutputLimits;
	v2?: Partial<V2Config>;
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

export function initializeCostState(thresholds?: Partial<CostThresholds>): CostState {
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
		warnings: 0,
		pauseCount: 0,
		thresholds: {
			warn: thresholds?.warn ?? 1.0,
			pause: thresholds?.pause ?? 5.0,
			hard: thresholds?.hard ?? 10.0,
		},
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
		ctx.obs?.events.emit({ type: "phase_started", phase }).catch(() => {});
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
		}).catch(() => {});

		ctx.obs?.events.emit({
			type: "phase_completed",
			phase,
			duration,
			cost,
		}).catch(() => {});
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

export async function checkCostThresholds(
	ctx: PipelineContext,
	config: PipelineConfig,
): Promise<"continue" | "warn" | "pause" | "abort"> {
	const { total } = ctx.costState;
	const { warn, pause, hard } = ctx.costState.thresholds;

	if (total >= hard) {
		await ctx.storage.appendEvent({ type: "cost_pause", total, timestamp: Date.now() });
		await ctx.obs?.events.emit({ type: "cost_threshold_crossed", threshold: "hard", total });
		ctx.pipelineState.exitReason = "cost_abort";
		ctx.abort?.();
		return "abort";
	}

	if (total >= pause && ctx.costState.pauseCount === 0) {
		ctx.costState.pauseCount++;
		await ctx.storage.appendEvent({ type: "cost_pause", total, timestamp: Date.now() });
		await ctx.obs?.events.emit({ type: "cost_threshold_crossed", threshold: "pause", total });

		if (config.pauseOnCostThreshold) {
			// TODO: Implement escalateToUser for blocking pause
		}
		return "pause";
	}

	if (total >= warn && ctx.costState.warnings === 0) {
		ctx.costState.warnings++;
		await ctx.storage.appendEvent({ type: "cost_warning", total, timestamp: Date.now() });
		await ctx.obs?.events.emit({ type: "cost_threshold_crossed", threshold: "warn", total });
		return "warn";
	}

	return "continue";
}

function detectStuckIssues(
	currentIssues: ReviewIssue[],
	reviewHistory: ReviewResult[],
	sameIssueLimit: number,
): boolean {
	if (reviewHistory.length < 2) return false;

	const previousIssues = reviewHistory[reviewHistory.length - 2]?.issues || [];
	if (previousIssues.length === 0) return false;

	const currentDescriptions = new Set(currentIssues.map(i => `${i.file}:${i.description}`));
	const previousDescriptions = new Set(previousIssues.map(i => `${i.file}:${i.description}`));

	let sameCount = 0;
	for (const desc of currentDescriptions) {
		if (previousDescriptions.has(desc)) {
			sameCount++;
		}
	}

	return sameCount >= Math.min(sameIssueLimit, currentIssues.length);
}

export async function runScoutPhaseWrapper(
	ctx: PipelineContext,
	config: PipelineConfig,
): Promise<void> {
	const span = ctx.obs?.spans.startSpan("phase:scout", "phase");
	await ctx.obs?.snapshots.capture("phase_start", "scout");

	updatePhaseStatus("scout", "running", ctx);

	try {
		const scoutConfig: ScoutConfig = {
			depth: "shallow",
			outputDir: path.join(config.coordDir, "scout"),
			maxFileSize: 50000,
			outputLimits: config.maxOutput,
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
	const v2Config = config.v2;
	if (!v2Config?.planner?.enabled) {
		return [];
	}

	const span = ctx.obs?.spans.startSpan("phase:planner", "phase");
	await ctx.obs?.snapshots.capture("phase_start", "planner");

	updatePhaseStatus("planner", "running", ctx);

	try {
		const plannerConfig: PlannerPhaseConfig = {
			humanCheckpoint: v2Config.planner.humanCheckpoint,
			maxSelfReviewCycles: v2Config.planner.maxSelfReviewCycles || 5,
			outputLimits: config.maxOutput,
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
		).catch(() => {});

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
			model: config.reviewModel,
			checkTests: config.checkTests,
			verifyPlanGoals: true,
			outputLimits: config.maxOutput,
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

		await saveProgressDoc(ctx);
		span && ctx.obs?.spans.endSpan(span.id, "ok", { issueCount: result.issues.length }, { cost: result.cost });
		updatePhaseStatus("review", "complete", ctx);

		return result;
	} catch (err) {
		await ctx.obs?.errors.capture(err, {
			category: "system_error",
			severity: "error",
			actor: "code-reviewer",
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

export async function runReviewFixLoop(
	ctx: PipelineContext,
	config: PipelineConfig,
): Promise<void> {
	while (ctx.pipelineState.fixCycle < ctx.pipelineState.maxFixCycles) {
		const costCheck = await checkCostThresholds(ctx, config);
		if (costCheck === "abort") {
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
