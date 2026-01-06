import type {
	PipelinePhase,
	Contract,
	ReviewIssue,
	MessageType,
	WorkerDeviation,
} from "../types.js";

export interface SessionSummary {
	status: "complete" | "failed" | "aborted";
	duration: number;
	totalCost: number;
	workersSpawned: number;
	workersCompleted: number;
	workersFailed: number;
	filesModified: string[];
	reviewCycles: number;
	exitReason?: string;
}

export interface WorkerResult {
	filesModified: string[];
	stepsCompleted: number[];
	cost: number;
	turns: number;
}

export interface CostBreakdown {
	byPhase: Record<PipelinePhase, number>;
	byWorker: Record<string, number>;
}

export interface SnapshotDiff {
	filesAdded: string[];
	filesRemoved: string[];
	filesModified: Array<{
		path: string;
		beforeHash: string;
		afterHash: string;
	}>;
	gitChanges: {
		newCommits: string[];
		stagedChanges: string[];
	};
	stateChanges: {
		contractsCreated: string[];
		contractsCompleted: string[];
		workersSpawned: string[];
		workersCompleted: string[];
	};
}

export interface WorkerConfig {
	agent: string;
	logicalName: string;
	steps: number[];
	handshakeSpec: string;
	adjacentWorkers?: string[];
}

export interface StructuredError {
	id: string;
	traceId: string;
	spanId: string;
	timestamp: number;
	category:
		| "worker_crash"
		| "llm_error"
		| "tool_error"
		| "timeout"
		| "contract_timeout"
		| "reservation_conflict"
		| "cost_exceeded"
		| "validation_error"
		| "system_error";
	severity: "fatal" | "error" | "warning";
	message: string;
	code?: string;
	stack?: string;
	actor: string;
	phase: PipelinePhase;
	relatedWorkerId?: string;
	relatedContractId?: string;
	relatedFile?: string;
	recoverable: boolean;
	recoveryAttempted?: boolean;
	recoverySucceeded?: boolean;
	originalError?: unknown;
}

export interface ReviewResultSummary {
	issues: ReviewIssue[];
	allPassing: boolean;
	filesReviewed: string[];
	duration: number;
	cost: number;
}

export interface FixResultSummary {
	issuesFixed: number;
	issuesFailed: number;
	duration: number;
	cost: number;
	exitReason?: string;
}

export type ActorType = "coordinator" | "worker" | "reviewer" | "system";

export interface BaseEvent {
	id: string;
	type: string;
	timestamp: number;
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	causedBy?: string;
	phase: PipelinePhase;
	actor: string;
	actorType: ActorType;
}

export type ObservableEvent =
	| (BaseEvent & { type: "session_started"; config: Record<string, unknown> })
	| (BaseEvent & { type: "session_completed"; summary: SessionSummary })
	| (BaseEvent & { type: "phase_started"; phase: PipelinePhase })
	| (BaseEvent & { type: "phase_completed"; phase: PipelinePhase; duration: number; cost: number })
	| (BaseEvent & { type: "worker_spawning"; workerId: string; config: WorkerConfig })
	| (BaseEvent & { type: "worker_started"; workerId: string; pid: number })
	| (BaseEvent & { type: "worker_completed"; workerId: string; result: WorkerResult })
	| (BaseEvent & { type: "worker_failed"; workerId: string; error: StructuredError })
	| (BaseEvent & { type: "tool_call_start"; workerId: string; tool: string; params: unknown })
	| (BaseEvent & { type: "tool_call_end"; workerId: string; tool: string; result: unknown; success: boolean; duration: number })
	| (BaseEvent & { type: "contract_created"; contract: Contract; creator: string })
	| (BaseEvent & { type: "contract_signaled"; contractId: string; provider: string; signature?: string })
	| (BaseEvent & { type: "contract_waiting"; contractId: string; waiter: string })
	| (BaseEvent & { type: "contract_received"; contractId: string; waiter: string; waitDuration: number })
	| (BaseEvent & { type: "reservation_requested"; reservationId: string; patterns: string[]; exclusive: boolean })
	| (BaseEvent & { type: "reservation_granted"; reservationId: string })
	| (BaseEvent & { type: "reservation_denied"; reservationId: string; conflict: { agent: string; patterns: string[] } })
	| (BaseEvent & { type: "reservation_transferred"; reservationId: string; from: string; to: string })
	| (BaseEvent & { type: "reservation_released"; reservationId: string })
	| (BaseEvent & { type: "message_sent"; messageId: string; from: string; to: string; messageType: MessageType })
	| (BaseEvent & { type: "message_received"; messageId: string; by: string })
	| (BaseEvent & { type: "review_started"; cycleNumber: number; filesUnderReview: string[] })
	| (BaseEvent & { type: "review_completed"; cycleNumber: number; result: ReviewResultSummary })
	| (BaseEvent & { type: "fix_started"; cycleNumber: number; issues: ReviewIssue[] })
	| (BaseEvent & { type: "fix_completed"; cycleNumber: number; result: FixResultSummary })
	| (BaseEvent & { type: "cost_updated"; delta: number; total: number; breakdown: CostBreakdown })
	| (BaseEvent & { type: "cost_threshold_crossed"; threshold: "warn" | "pause" | "hard"; total: number })
	| (BaseEvent & { type: "deviation_reported"; workerId: string; deviation: WorkerDeviation; affectsOthers: boolean })
	| (BaseEvent & { type: "deviation_broadcast"; deviation: string; affectedWorkers: string[] })
	| (BaseEvent & { type: "escalation_created"; escalationId: string; question: string; options: string[]; timeout: number })
	| (BaseEvent & { type: "escalation_responded"; escalationId: string; choice: string; wasTimeout: boolean })
	| (BaseEvent & { type: "checkpoint_saved"; checkpointId: string; phase: PipelinePhase })
	| (BaseEvent & { type: "checkpoint_restored"; checkpointId: string })
	| (BaseEvent & { type: "task_claimed"; taskId: string; workerId: string })
	| (BaseEvent & { type: "task_completed"; taskId: string; workerId: string; filesModified: string[] })
	| (BaseEvent & { type: "task_failed"; taskId: string; workerId: string; reason: string })
	| (BaseEvent & { type: "task_deferred"; taskId: string; reason: string })
	| (BaseEvent & { type: "self_review_started"; workerId: string; cycleNumber: number })
	| (BaseEvent & { type: "self_review_passed"; workerId: string; cycleNumber: number })
	| (BaseEvent & { type: "self_review_limit_reached"; workerId: string; maxCycles: number })
	| (BaseEvent & { type: "worker_nudged"; workerId: string; nudgeType: string })
	| (BaseEvent & { type: "worker_restarting"; workerId: string; restartCount: number })
	| (BaseEvent & { type: "worker_abandoned"; workerId: string; reason: string })
	| (BaseEvent & { type: "a2a_message_sent"; messageId: string; from: string; to: string; messageType: string })
	| (BaseEvent & { type: "file_negotiation_started"; requestId: string; file: string; requester: string; holder: string })
	| (BaseEvent & { type: "file_negotiation_resolved"; requestId: string; granted: boolean })
	| (BaseEvent & { type: "discovery_shared"; discoveryId: string; workerId: string; topic: string; importance: string })
	| (BaseEvent & { type: "task_discovered"; taskId: string; discoveredBy: string; discoveredFrom: string })
	| (BaseEvent & { type: "task_reviewed"; taskId: string; result: string; reviewNotes?: string })
	| (BaseEvent & { type: "planner_review_started"; tasksToReview: number })
	| (BaseEvent & { type: "planner_review_complete"; approved: number; rejected: number; modified: number })
	| (BaseEvent & { type: "planner_self_review_started"; cycleNumber: number })
	| (BaseEvent & { type: "planner_self_review_complete"; cycleNumber: number; issuesFound: boolean });

export interface Span {
	id: string;
	traceId: string;
	parentId?: string;
	name: string;
	kind: "coordination" | "phase" | "worker" | "tool" | "llm" | "io";
	startTime: number;
	endTime?: number;
	duration?: number;
	status: "running" | "ok" | "error";
	attributes: Record<string, unknown>;
	usage?: {
		inputTokens?: number;
		outputTokens?: number;
		cost?: number;
	};
	links?: Array<{
		spanId: string;
		relationship: "child_of" | "follows_from" | "caused_by";
	}>;
}

export interface LlmInteraction {
	type: "llm_start" | "llm_end";
	id: string;
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	timestamp: number;
	actor: string;
	actorType: ActorType;
	workerId?: string;
	model: string;
	provider: string;
	api: string;
	requestHash: string;
	requestPath: string;
	responsePath?: string;
	options?: Record<string, unknown>;
	latencyMs?: number;
	cached?: boolean;
	stopReason?: string;
	errorMessage?: string;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		totalTokens?: number;
		cost?: number;
	};
}

export interface CausalLink {
	id: string;
	traceId: string;
	timestamp: number;
	cause: {
		eventId: string;
		type: string;
		actor: string;
	};
	effect: {
		eventId: string;
		type: string;
		actor: string;
	};
	relationship: "triggered" | "enabled" | "blocked" | "required";
	latency: number;
}

export type ResourceType = "process" | "temp_file" | "reservation" | "lock" | "escalation";

export interface ResourceEvent {
	id: string;
	traceId: string;
	timestamp: number;
	resourceType: ResourceType;
	resourceId: string;
	event: "created" | "updated" | "released" | "leaked" | "orphaned";
	data: Record<string, unknown>;
	owner: string;
	expectedLifetime?: number;
}

export interface Decision {
	id: string;
	traceId: string;
	spanId: string;
	timestamp: number;
	actor: string;
	actorType: ActorType;
	type:
		| "file_assignment"
		| "worker_allocation"
		| "contract_creation"
		| "dependency_order"
		| "model_selection"
		| "retry_strategy"
		| "escalation"
		| "fix_assignment"
		| "abort";
	decision: {
		chosen: unknown;
		alternatives?: unknown[];
		reason: string;
	};
	context: {
		inputs: Record<string, unknown>;
		constraints?: string[];
		heuristics?: string[];
	};
	outcome?: {
		success: boolean;
		impact: string;
		wouldChooseDifferently?: boolean;
	};
}
