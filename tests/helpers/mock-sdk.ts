/**
 * Mock SDK helpers for testing coordination without making real API calls.
 *
 * Provides:
 * - MockAgentSession: Simulates agent execution with configurable responses
 * - mockCreateAgentSession: Factory for creating mock sessions
 * - MockEventEmitter: Typed event subscription simulation
 *
 * @module
 */

import type { Message } from "@mariozechner/pi-ai";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface MockSessionConfig {
	/** Messages to return from the mock agent */
	messages?: AgentMessage[];
	/** Events to emit during execution */
	events?: MockEvent[];
	/** Should the agent fail? */
	shouldFail?: boolean;
	/** Error message if shouldFail is true */
	errorMessage?: string;
	/** Delay in ms before responding (simulates API latency) */
	responseDelayMs?: number;
	/** Usage stats to return */
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		cost?: number;
	};
	/** Model name to report */
	model?: string;
}

export interface MockEvent {
	type: string;
	[key: string]: unknown;
}

export type MockEventListener = (event: MockEvent) => void;

// ─────────────────────────────────────────────────────────────────────────────
// Mock Session
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mock AgentSession that simulates agent execution.
 */
export class MockAgentSession {
	private config: MockSessionConfig;
	private listeners: MockEventListener[] = [];
	private aborted = false;
	private promptCalls: string[] = [];
	private toolExecutions: Array<{ name: string; args: any; result: any }> = [];

	constructor(config: MockSessionConfig = {}) {
		this.config = config;
	}

	/**
	 * Subscribe to session events.
	 */
	subscribe(listener: MockEventListener): () => void {
		this.listeners.push(listener);
		return () => {
			const index = this.listeners.indexOf(listener);
			if (index >= 0) {
				this.listeners.splice(index, 1);
			}
		};
	}

	/**
	 * Emit an event to all subscribers.
	 */
	private emit(event: MockEvent): void {
		for (const listener of this.listeners) {
			listener(event);
		}
	}

	/**
	 * Send a prompt to the mock agent.
	 */
	async prompt(text: string): Promise<void> {
		this.promptCalls.push(text);

		if (this.aborted) {
			throw new Error("Session was aborted");
		}

		// Simulate response delay
		if (this.config.responseDelayMs) {
			await new Promise((resolve) => setTimeout(resolve, this.config.responseDelayMs));
		}

		// Check for failure
		if (this.config.shouldFail) {
			throw new Error(this.config.errorMessage || "Mock agent failed");
		}

		// Emit custom events if configured
		if (this.config.events) {
			for (const event of this.config.events) {
				this.emit(event);
			}
		}

		// Build and emit mock assistant message
		const usage = this.config.usage || {};
		const assistantMessage: AgentMessage = {
			role: "assistant",
			content: this.config.messages?.[0]?.content || [{ type: "text", text: "Mock response" }],
			model: this.config.model || "mock-model",
			stopReason: "end_turn",
			usage: {
				input: usage.input || 100,
				output: usage.output || 50,
				cacheRead: usage.cacheRead || 0,
				cacheWrite: usage.cacheWrite || 0,
				totalTokens: (usage.input || 100) + (usage.output || 50),
				cost: { total: usage.cost || 0.001 },
			},
		} as AgentMessage;

		// Emit message lifecycle events
		this.emit({ type: "message_start", message: assistantMessage });
		this.emit({ type: "message_end", message: assistantMessage });
	}

	/**
	 * Abort the session.
	 */
	abort(): void {
		this.aborted = true;
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Test helpers
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Get all prompts that were sent to this session.
	 */
	getPromptCalls(): string[] {
		return [...this.promptCalls];
	}

	/**
	 * Check if a specific prompt was sent.
	 */
	wasPromptedWith(text: string): boolean {
		return this.promptCalls.some((p) => p.includes(text));
	}

	/**
	 * Get the number of prompts sent.
	 */
	getPromptCount(): number {
		return this.promptCalls.length;
	}

	/**
	 * Check if the session was aborted.
	 */
	wasAborted(): boolean {
		return this.aborted;
	}

	/**
	 * Simulate a tool execution.
	 */
	simulateToolExecution(name: string, args: any, result: any): void {
		this.toolExecutions.push({ name, args, result });
		this.emit({
			type: "tool_execution_start",
			toolCallId: `mock-${Date.now()}`,
			toolName: name,
			args,
		});
		this.emit({
			type: "tool_execution_end",
			toolCallId: `mock-${Date.now()}`,
			toolName: name,
			result,
			isError: false,
		});
	}

	/**
	 * Get all tool executions that were simulated.
	 */
	getToolExecutions(): Array<{ name: string; args: any; result: any }> {
		return [...this.toolExecutions];
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock Session Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a mock version of createAgentSession that returns a MockAgentSession.
 *
 * Usage:
 * ```typescript
 * vi.mock("@mariozechner/pi-coding-agent", () => ({
 *   createAgentSession: mockCreateAgentSession({
 *     messages: [{ role: "assistant", content: [{ type: "text", text: "Done!" }] }]
 *   }),
 *   SessionManager: { inMemory: () => ({}) },
 * }));
 * ```
 */
export function mockCreateAgentSession(config: MockSessionConfig = {}): () => Promise<{ session: MockAgentSession }> {
	return async () => ({
		session: new MockAgentSession(config),
		extensionsResult: { extensions: [], errors: [], runtime: {} },
	});
}

/**
 * Create a mock SessionManager.
 */
export function mockSessionManager() {
	return {
		inMemory: (_cwd?: string) => ({
			getSessionId: () => "mock-session-id",
			buildSessionContext: () => ({ messages: [], model: null, thinkingLevel: "off" }),
			appendModelChange: () => {},
			appendThinkingLevelChange: () => {},
		}),
		create: (_cwd?: string) => ({
			getSessionId: () => "mock-session-id",
			buildSessionContext: () => ({ messages: [], model: null, thinkingLevel: "off" }),
			appendModelChange: () => {},
			appendThinkingLevelChange: () => {},
		}),
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock Tool Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a mock tool definition.
 */
export function createMockTool(name: string, result: string = "success"): any {
	return {
		name,
		label: name,
		description: `Mock ${name} tool`,
		parameters: { type: "object", properties: {} },
		execute: async () => ({
			content: [{ type: "text", text: result }],
			details: {},
		}),
	};
}

/**
 * Create mock built-in tools.
 */
export function createMockBuiltinTools(cwd: string): Record<string, any> {
	return {
		read: createMockTool("read", "file contents"),
		bash: createMockTool("bash", "command output"),
		edit: createMockTool("edit", "file edited"),
		write: createMockTool("write", "file written"),
		grep: createMockTool("grep", "grep results"),
		find: createMockTool("find", "find results"),
		ls: createMockTool("ls", "directory listing"),
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker Simulation
// ─────────────────────────────────────────────────────────────────────────────

export interface MockWorkerConfig {
	/** Task ID this worker is executing */
	taskId: string;
	/** Simulated duration in ms */
	durationMs?: number;
	/** Should the worker fail? */
	shouldFail?: boolean;
	/** Exit code (default: 0 for success, 1 for failure) */
	exitCode?: number;
	/** Files to report as modified */
	filesModified?: string[];
	/** Tools to simulate calling */
	toolCalls?: Array<{ name: string; args: any }>;
	/** Output text */
	output?: string;
}

/**
 * Simulate a worker execution with configurable behavior.
 */
export class MockWorker {
	private config: MockWorkerConfig;
	private events: MockEvent[] = [];
	private started = false;
	private completed = false;

	constructor(config: MockWorkerConfig) {
		this.config = config;
	}

	/**
	 * Start the mock worker and return a promise that resolves when done.
	 */
	async run(): Promise<{
		exitCode: number;
		filesModified: string[];
		output: string;
		events: MockEvent[];
	}> {
		this.started = true;

		// Emit start event
		this.events.push({
			type: "worker_started",
			workerId: `mock-${this.config.taskId}`,
			taskId: this.config.taskId,
			timestamp: Date.now(),
		});

		// Simulate tool calls
		if (this.config.toolCalls) {
			for (const call of this.config.toolCalls) {
				this.events.push({
					type: "tool_execution_start",
					toolName: call.name,
					args: call.args,
					timestamp: Date.now(),
				});
				await new Promise((r) => setTimeout(r, 10));
				this.events.push({
					type: "tool_execution_end",
					toolName: call.name,
					isError: false,
					timestamp: Date.now(),
				});
			}
		}

		// Simulate duration
		if (this.config.durationMs) {
			await new Promise((r) => setTimeout(r, this.config.durationMs));
		}

		this.completed = true;
		const exitCode = this.config.exitCode ?? (this.config.shouldFail ? 1 : 0);

		// Emit completion event
		this.events.push({
			type: exitCode === 0 ? "worker_completed" : "worker_failed",
			workerId: `mock-${this.config.taskId}`,
			taskId: this.config.taskId,
			exitCode,
			filesModified: this.config.filesModified || [],
			timestamp: Date.now(),
		});

		return {
			exitCode,
			filesModified: this.config.filesModified || [],
			output: this.config.output || "Mock worker output",
			events: this.events,
		};
	}

	/**
	 * Get all events emitted by this worker.
	 */
	getEvents(): MockEvent[] {
		return [...this.events];
	}

	/**
	 * Check if the worker has started.
	 */
	hasStarted(): boolean {
		return this.started;
	}

	/**
	 * Check if the worker has completed.
	 */
	hasCompleted(): boolean {
		return this.completed;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM Response Simulation
// ─────────────────────────────────────────────────────────────────────────────

export interface MockLLMConfig {
	/** Map of prompt patterns to responses */
	responses: Array<{
		pattern: string | RegExp;
		response: string;
		/** Optional tool calls to include */
		toolCalls?: Array<{ name: string; args: any }>;
	}>;
	/** Default response if no pattern matches */
	defaultResponse?: string;
}

/**
 * Mock LLM that returns deterministic responses based on prompt patterns.
 */
export class MockLLM {
	private config: MockLLMConfig;
	private callHistory: Array<{ prompt: string; response: string }> = [];

	constructor(config: MockLLMConfig) {
		this.config = config;
	}

	/**
	 * Get a response for a prompt.
	 */
	respond(prompt: string): string {
		for (const { pattern, response } of this.config.responses) {
			const regex = typeof pattern === "string" ? new RegExp(pattern) : pattern;
			if (regex.test(prompt)) {
				this.callHistory.push({ prompt, response });
				return response;
			}
		}

		const defaultResponse = this.config.defaultResponse || "Mock LLM response";
		this.callHistory.push({ prompt, response: defaultResponse });
		return defaultResponse;
	}

	/**
	 * Get the call history.
	 */
	getCallHistory(): Array<{ prompt: string; response: string }> {
		return [...this.callHistory];
	}

	/**
	 * Clear the call history.
	 */
	clearHistory(): void {
		this.callHistory = [];
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports for vi.mock usage
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get a complete mock module for @mariozechner/pi-coding-agent.
 *
 * Usage:
 * ```typescript
 * vi.mock("@mariozechner/pi-coding-agent", () => getMockSDKModule({
 *   messages: [{ role: "assistant", content: [{ type: "text", text: "Done!" }] }]
 * }));
 * ```
 */
export function getMockSDKModule(config: MockSessionConfig = {}) {
	return {
		createAgentSession: mockCreateAgentSession(config),
		SessionManager: mockSessionManager(),
		createReadTool: () => createMockTool("read"),
		createBashTool: () => createMockTool("bash"),
		createEditTool: () => createMockTool("edit"),
		createWriteTool: () => createMockTool("write"),
		createGrepTool: () => createMockTool("grep"),
		createFindTool: () => createMockTool("find"),
		createLsTool: () => createMockTool("ls"),
	};
}
