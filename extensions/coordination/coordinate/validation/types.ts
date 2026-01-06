import type {
	ObservableEvent,
	Span,
	CausalLink,
	StructuredError,
	ResourceEvent,
	Decision,
} from "../observability/types.js";
import type { WorkerStateFile, Contract, PipelineState } from "../types.js";

export type ValidationMode = "post-hoc" | "integrated" | "standalone";
export type ValidationStrictness = "fatal-all" | "warn-soft-fatal-hard" | "advisory";
export type ValidationStatus = "pass" | "fail" | "incomplete" | "error";

export interface ValidationConfig {
	coordDir: string;
	planPath?: string;
	planContent?: string;
	mode: ValidationMode;
	strictness: ValidationStrictness;
	checkContent: boolean;
	askUser?: (question: string, options: string[]) => Promise<string | null>;
}

export interface ObservabilityData {
	events: ObservableEvent[];
	spans: Span[];
	causalLinks: CausalLink[];
	errors: StructuredError[];
	resources: ResourceEvent[];
	decisions: Decision[];
	workerStates: WorkerStateFile[];
	contracts: Record<string, Contract>;
	pipelineState?: PipelineState;
	fileOutputs: FileOutput[];
}

export interface FileOutput {
	path: string;
	exists: boolean;
	isNew: boolean;
	size?: number;
	hash?: string;
}

export type InvariantCategory = "hard" | "soft";

export interface InvariantResult {
	name: string;
	category: InvariantCategory;
	passed: boolean;
	message: string;
	details?: unknown;
}

export interface InvariantChecker {
	name: string;
	category: InvariantCategory;
	check(data: ObservabilityData): Promise<InvariantResult>;
}

export type JudgmentConfidence = "high" | "medium" | "low";

export interface JudgmentResult {
	passed: boolean;
	reasoning: string;
	confidence: JudgmentConfidence;
	suggestedFixes?: string[];
	userQuestionAsked?: {
		question: string;
		answer: string | null;
	};
}

export interface ValidationResult {
	status: ValidationStatus;
	passed: boolean;
	invariants: InvariantResult[];
	judgment?: JudgmentResult;
	summary: string;
	reportPath?: string;
	duration: number;
	timestamp: number;
}

export interface StreamingValidationCallback {
	onWarning: (invariant: string, message: string) => void;
	onError: (invariant: string, message: string) => void;
}
