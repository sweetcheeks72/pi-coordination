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

export interface EscalationOption {
	label: string;
	description?: string;
}

export interface EscalationRequest {
	id: string;
	from: string;
	question: string;
	/** Legacy: plain string options */
	options: string[];
	/** Enhanced: options with labels and descriptions */
	richOptions?: EscalationOption[];
	/** Additional context shown in HTML interview context card */
	context?: string;
	/** What the agent assumes if no answer is given */
	agentAssumption?: string;
	/** Agent's confidence in the assumption (0–1) */
	confidence?: number;
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
		cacheRead?: number;
		cacheWrite?: number;
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
	/** Populated while auto-repair is running or after it completes */
	repairState?: {
		status: "running" | "success" | "failed";
		attempt: number;
		maxAttempts: number;
	};
	// Task context fields for coordinate UX
	planIntent?: string;           // What the plan says this task should do
	currentProblem?: string;       // What challenge/deviation the agent is working on
	thinkingStream?: string;       // Last N chars of agent reasoning (rolling buffer)
	assumptions?: Array<{
		text: string;
		status: 'verified' | 'unverified';
		confidence: 'high' | 'med' | 'low';
	}>;
}

export type CoordinationEvent =
	| { type: "tool_call"; workerId: string; tool: string; file?: string; contextTokens?: number; timestamp: number }
	| { type: "tool_result"; workerId: string; tool: string; file?: string; success: boolean; timestamp: number }
	| { type: "waiting"; workerId: string; waitingFor: string; item: string; timestamp: number }
	| { type: "contract_received"; workerId: string; from: string; item: string; timestamp: number }
	| { type: "worker_started"; workerId: string; timestamp: number }
	| { type: "worker_completed"; workerId: string; timestamp: number }
	| { type: "worker_failed"; workerId: string; error: string; timestamp: number }
	| { type: "cost_milestone"; threshold: number; totals: Record<string, number>; aggregate: number; timestamp: number }
	| { type: "coordinator"; message: string; timestamp: number }
	| { type: "phase_complete"; phase: PipelinePhase; duration: number; cost: number; timestamp: number }
	| { type: "cost_limit_reached"; total: number; limit: number; timestamp: number }
	| { type: "worker_output"; workerId: string; workerName: string; preview: string; timestamp: number }
	| { type: "worker_spawning"; workerId: string; config?: { logicalName?: string; handshakeSpec?: string }; timestamp: number }
	| { type: "phase_started"; phase: PipelinePhase; timestamp: number }
	| { type: "phase_completed"; phase: PipelinePhase; timestamp: number }
	| { type: "cost_updated"; total: number; timestamp: number }
	| { type: "checkpoint_saved"; timestamp: number }
	| { type: "planner_review_started"; timestamp: number }
	| { type: "planner_review_complete"; timestamp: number }
	| { type: "session_started"; timestamp: number }
	| { type: "session_completed"; timestamp: number }
	| { type: "review_started"; timestamp: number }
	| { type: "review_complete"; timestamp: number }
	| { type: "review_completed"; timestamp: number }
	| { type: "fix_started"; timestamp: number }
	| { type: "fix_completed"; timestamp: number }
	| { type: "fixes_started"; timestamp: number }
	| { type: "fixes_complete"; timestamp: number }
	| { type: "activity"; phase?: string; contextTokens?: number; timestamp: number }
	| { type: "agent_question"; workerId: string; workerName: string; question: string; options?: string[]; severity: "block" | "clarify"; answered?: boolean; timestamp: number };

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
	| "integration"
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

export type ExitReason = "clean" | "stuck" | "regression" | "max_cycles" | "cost_limit" | "user_abort";

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
	category: "bug" | "logic" | "type" | "style" | "missing" | "regression" | "integration";
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

export interface CostState {
	total: number;
	byPhase: Record<PipelinePhase, number>;
	byWorker: Record<string, number>;
	limit: number;
	limitReached: boolean;
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
	| "rejected"
	| "discovered"; // Runtime discovered task

export type TaskPriority = "P0" | "P1" | "P2" | "P3";

export interface Task {
	id: string;
	description: string;
	priority: number; // Numeric for sorting (0=P0, 1=P1, 2=P2, 3=P3)
	priorityLabel?: TaskPriority; // String label
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
	// Subtask support
	parentTaskId?: string; // For subtasks (TASK-XX.Y) - the parent task ID
	blockedBy?: string[]; // Task IDs blocking this task (e.g., subtasks)
	// Coordinate UX fields
	planDescription?: string;  // Human-readable description from spec parsing
	deviationLog?: Array<{
		timestamp: number;
		what: string;
		why: string;
		decision: string;
		impact: string;
	}>;
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
	dynamicSpawnTimeoutMs?: number;  // Timeout for dynamic spawning deadlock detection (default: 30000)
	staleTaskTimeoutMs?: number;      // Timeout for considering claimed tasks stale (default: 1800000 = 30min)
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

export interface MeshMessage {
	id: string;
	from: string;        // worker shortId or 'coordinator'
	to: string;          // worker shortId, 'coordinator', or 'user'
	message: string;
	timestamp: number;
	taskId?: string;
	type: 'coordination' | 'handoff' | 'deviation' | 'question';
}

export interface Discovery {
	id: string;
	workerId: string;
	workerIdentity: string;
	topic: string;
	content: string;
	importance: "fyi" | "important" | "critical";
	timestamp: number;
}
