import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import type { AgentScope } from "./agents.js";

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface OutputLimits {
	bytes?: number;
	lines?: number;
}

export interface OutputMeta {
	byteCount: number;
	lineCount: number;
	charCount: number;
}

export interface ArtifactPaths {
	dir: string;
	inputPath: string;
	outputPath: string;
	jsonlPath: string;
	metadataPath: string;
}

export interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	output?: string;
	truncated?: boolean;
	outputMeta?: OutputMeta;
	artifactPaths?: ArtifactPaths;
	jsonlEvents?: string[];
	durationMs?: number;
	tokens?: number;
	toolCount?: number;
	currentTool?: string | null;
	currentToolArgs?: string | null;
	recentTools?: Array<{ tool: string; args: string; endMs: number }>;
}

export interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
	asyncId?: string;
	totalTasks?: number;
}

export interface ChainStepResult {
	agent: string;
	output: string;
	success: boolean;
}

export interface SubagentAsyncResult {
	id: string | null;
	agent: string | null;
	success: boolean;
	summary: string;
	exitCode: number;
	timestamp: number;
	results?: ChainStepResult[];
	taskIndex?: number;
	totalTasks?: number;
}

export type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, unknown> };

export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;
