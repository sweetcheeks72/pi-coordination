export interface CoordinationEnv {
	PI_COORDINATION_DIR: string;
	PI_AGENT_IDENTITY: string;
	PI_WORKER_ID: string;
}

export interface CoordinationAgent {
	role: string;
	name: string;
	identity: string;
	model: string;
	tools: string[];
	systemPrompt: string;
	pid?: number;
}

export type MessageType = "handover" | "clarification" | "response" | "status" | "conflict";

export interface CoordinationMessage {
	id: string;
	from: string;
	to: string | "all" | "coordinator";
	type: MessageType;
	content: string;
	timestamp: number;
	inReplyTo?: string;
}

export interface EscalationRequest {
	id: string;
	from: string;
	question: string;
	options: string[];
	timeout: number;
	defaultOption?: number;
	createdAt: number;
}

export interface EscalationResponse {
	id: string;
	choice: string;
	wasTimeout: boolean;
	respondedAt: number;
}

export interface FileReservation {
	id: string;
	agent: string;
	patterns: string[];
	exclusive: boolean;
	reason: string;
	createdAt: number;
	expiresAt: number;
	releasedAt?: number;
}

export type ContractType = "type" | "function" | "file";
export type ContractStatus = "pending" | "in-progress" | "ready" | "modified";

export interface Contract {
	id: string;
	item: string;
	type: ContractType;
	provider: string;
	status: ContractStatus;
	waiters: string[];
	expectedSignature?: string;
	actualSignature?: string;
	file?: string;
	completedAt?: number;
}

export type WorkerStatus = "pending" | "working" | "waiting" | "blocked" | "complete" | "failed";

export interface WorkerStateFile {
	id: string;
	shortId: string;
	identity: string;
	agent: string;
	status: WorkerStatus;
	currentFile: string | null;
	currentTool: string | null;
	waitingFor: {
		identity: string;
		item: string;
	} | null;
	assignedSteps: number[];
	completedSteps: number[];
	currentStep: number | null;
	handshakeSpec: string;
	startedAt: number;
	completedAt: number | null;
	usage: {
		input: number;
		output: number;
		cost: number;
		turns: number;
	};
	toolCount?: number;
	tokens?: number;
	durationMs?: number;
	recentTools?: Array<{ tool: string; args: string; endMs: number }>;
	lastOutput?: string;
	artifactsDir?: string;
	filesModified: string[];
	blockers: string[];
	errorType: string | null;
	errorMessage: string | null;
	deviations?: WorkerDeviation[];
}

export type CoordinationEvent =
	| { type: "tool_call"; workerId: string; tool: string; file?: string; timestamp: number }
	| { type: "tool_result"; workerId: string; tool: string; file?: string; success: boolean; timestamp: number }
	| { type: "waiting"; workerId: string; waitingFor: string; item: string; timestamp: number }
	| { type: "contract_received"; workerId: string; from: string; item: string; timestamp: number }
	| { type: "worker_started"; workerId: string; timestamp: number }
	| { type: "worker_completed"; workerId: string; timestamp: number }
	| { type: "worker_failed"; workerId: string; error: string; timestamp: number }
	| { type: "cost_milestone"; threshold: number; totals: Record<string, number>; aggregate: number; timestamp: number }
	| { type: "coordinator"; message: string; timestamp: number }
	| { type: "phase_complete"; phase: PipelinePhase; duration: number; cost: number; timestamp: number }
	| { type: "cost_warning"; total: number; timestamp: number }
	| { type: "cost_pause"; total: number; timestamp: number };

export type CoordinationStatus = "analyzing" | "executing" | "reviewing" | "complete" | "failed";

export interface Deviation {
	type: string;
	description: string;
	timestamp: number;
}

export interface CoordinationState {
	sessionId: string;
	planPath: string;
	planHash: string;
	status: CoordinationStatus;
	contracts: Record<string, Contract>;
	deviations: Deviation[];
	startedAt: number;
	completedAt?: number;
	preAssignments?: Record<string, PreAssignment>;
}

export interface CoordinationResult {
	summary: string;
	filesModified?: string[];
	deviations?: string[];
}

export type PipelinePhase =
	| "scout"
	| "planner"
	| "coordinator"
	| "workers"
	| "review"
	| "fixes"
	| "complete"
	| "failed";

export interface PhaseResult {
	phase: PipelinePhase;
	status: "pending" | "running" | "complete" | "failed" | "skipped";
	startedAt?: number;
	completedAt?: number;
	error?: string;
	attempt: number;
}

export type ExitReason = "clean" | "stuck" | "regression" | "max_cycles" | "cost_abort" | "user_abort";

export interface PipelineState {
	sessionId: string;
	planPath: string;
	planHash: string;
	currentPhase: PipelinePhase;
	phases: Record<PipelinePhase, PhaseResult>;
	scoutContext?: string;
	reviewIssues?: ReviewIssue[];
	fixCycle: number;
	maxFixCycles: number;
	exitReason?: ExitReason;
	startedAt: number;
	completedAt?: number;
}

export interface PreAssignment {
	files: string[];
	reservationId: string;
}

export interface ReviewIssue {
	id: string;
	file: string;
	line?: number;
	severity: "error" | "warning" | "suggestion";
	category: "bug" | "logic" | "type" | "style" | "missing" | "regression";
	description: string;
	suggestedFix?: string;
	originalWorker?: string;
	fixAttempts: number;
}

export interface WorkerAssignment {
	workerId: string;
	identity: string;
	logicalName: string;
	assignedFiles: string[];
	contracts: {
		waitFor: string[];
		provides: string[];
	};
	handshakeSpec: string;
	adjacentWorkers: string[];
}

export interface IdentityMapping {
	logical: string;
	actual: string;
}

export interface WorkerDeviation {
	description: string;
	reason: string;
	timestamp: number;
}

export interface CostThresholds {
	warn: number;
	pause: number;
	hard: number;
}

export interface CostState {
	total: number;
	byPhase: Record<PipelinePhase, number>;
	byWorker: Record<string, number>;
	warnings: number;
	pauseCount: number;
	thresholds: CostThresholds;
}

export interface Checkpoint {
	sessionId: string;
	phase: PipelinePhase;
	timestamp: number;
	pipelineState: PipelineState;
	coordinationState: CoordinationState;
	workerStates: WorkerStateFile[];
	costState?: CostState;
	reviewHistory?: ReviewIssue[][];
}

export interface ModelConfig {
	scout?: string;
	coordinator?: string;
	worker?: string;
	reviewer?: string;
	planner?: string;
}

export type TaskStatus =
	| "pending_review"
	| "pending"
	| "blocked"
	| "claimed"
	| "complete"
	| "failed"
	| "rejected";

export interface Task {
	id: string;
	description: string;
	priority: number;
	status: TaskStatus;
	files?: string[];
	creates?: string[];
	dependsOn?: string[];
	acceptanceCriteria?: string[];
	claimedBy?: string;
	claimedAt?: number;
	completedAt?: number;
	completedBy?: string;
	restartCount?: number;
	failureReason?: string;
	discoveredFrom?: string;
	reviewed?: boolean;
	reviewedAt?: number;
	reviewResult?: "ok" | "modified" | "rejected";
	reviewNotes?: string;
}

export interface TaskQueue {
	version: "2.0";
	planPath: string;
	planHash: string;
	createdAt: number;
	tasks: Task[];
}

export type A2AMessageType =
	| "file_release_request"
	| "file_release_response"
	| "discovery"
	| "task_handoff"
	| "help_request"
	| "status_update"
	| "completion_notice";

export interface A2AMessage {
	id: string;
	from: string;
	to: string | "all";
	timestamp: number;
	type: A2AMessageType;
	payload: A2APayload;
	inReplyTo?: string;
}

export type A2APayload =
	| { type: "file_release_request"; file: string; reason: string; urgency: "low" | "medium" | "high" }
	| { type: "file_release_response"; file: string; granted: boolean; eta?: number; reason?: string }
	| { type: "discovery"; topic: string; content: string; importance: "fyi" | "important" | "critical" }
	| { type: "task_handoff"; taskId: string; reason: string; context: string }
	| { type: "help_request"; taskId: string; blocker: string; needsFrom?: string }
	| { type: "status_update"; taskId: string; progress: number; eta?: number }
	| { type: "completion_notice"; taskId: string; filesModified: string[] };

export type NudgeType = "wrap_up" | "restart" | "abort";

export interface NudgePayload {
	type: NudgeType;
	message: string;
	timestamp: number;
}

export interface SupervisorConfig {
	nudgeThresholdMs: number;
	restartThresholdMs: number;
	maxRestarts: number;
	checkIntervalMs: number;
}

export interface PlannerReviewResult {
	taskId: string;
	approved: boolean;
	modified: boolean;
	modifications?: Partial<Task>;
	reason?: string;
}

export interface PlannerConfig {
	enabled: boolean;
	humanCheckpoint: boolean;
	maxSelfReviewCycles: number;
}

export interface SelfReviewConfig {
	enabled: boolean;
	maxCycles: number;
}

export interface V2Config {
	selfReview: SelfReviewConfig;
	supervisor: SupervisorConfig & { enabled: boolean };
	planner: PlannerConfig;
}

export type V2PipelinePhase =
	| "scout"
	| "planner"
	| "coordinator"
	| "workers"
	| "review"
	| "fixes"
	| "complete"
	| "failed";

export interface Discovery {
	id: string;
	workerId: string;
	workerIdentity: string;
	topic: string;
	content: string;
	importance: "fyi" | "important" | "critical";
	timestamp: number;
}
