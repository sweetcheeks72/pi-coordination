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
	filesModified: string[];
	blockers: string[];
	errorType: string | null;
	errorMessage: string | null;
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
	| { type: "coordinator"; message: string; timestamp: number };

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
}

export interface CoordinationResult {
	summary: string;
	filesModified?: string[];
	deviations?: string[];
}
