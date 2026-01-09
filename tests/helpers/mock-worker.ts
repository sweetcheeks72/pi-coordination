/**
 * Mock Worker for testing coordination without real subprocess spawning.
 *
 * Simulates:
 * - Worker lifecycle (start, tool calls, complete, crash, timeout)
 * - Observability events (worker_started, tool_call_*, worker_completed/failed)
 * - Context updates
 *
 * @module
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface MockWorkerConfig {
	/** Task ID this worker is assigned to */
	taskId: string;
	/** Worker identity string */
	identity?: string;
	/** Worker UUID */
	workerId?: string;
	/** Simulated tool calls to make */
	toolCalls?: MockToolCall[];
	/** Exit behavior */
	exit?: MockExitBehavior;
	/** Delay before starting (ms) */
	startDelayMs?: number;
	/** Delay between tool calls (ms) */
	toolDelayMs?: number;
}

export interface MockToolCall {
	name: string;
	args: Record<string, unknown>;
	result?: {
		success: boolean;
		output?: string;
		error?: string;
	};
}

export interface MockExitBehavior {
	/** Exit code (0 = success, non-zero = failure) */
	code: number;
	/** Reason for exit */
	reason?: string;
	/** Whether agent_work({ action: 'complete' }) was called before exit */
	calledCompleteTask?: boolean;
	/** Delay before exit (ms) */
	delayMs?: number;
}

export interface WorkerEvent {
	type: string;
	timestamp: number;
	workerId: string;
	taskId: string;
	[key: string]: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock Worker
// ─────────────────────────────────────────────────────────────────────────────

/**
 * MockWorker simulates a coordination worker for testing.
 */
export class MockWorker extends EventEmitter {
	readonly taskId: string;
	readonly workerId: string;
	readonly identity: string;
	
	private config: MockWorkerConfig;
	private started = false;
	private completed = false;
	private exitCode: number | null = null;
	private toolCallIndex = 0;
	private events: WorkerEvent[] = [];

	constructor(config: MockWorkerConfig) {
		super();
		this.config = config;
		this.taskId = config.taskId;
		this.workerId = config.workerId || randomUUID();
		this.identity = config.identity || `worker:${config.taskId}-${this.workerId.slice(0, 4)}`;
	}

	/**
	 * Start the mock worker execution.
	 */
	async start(): Promise<void> {
		if (this.started) {
			throw new Error("Worker already started");
		}
		this.started = true;

		// Start delay
		if (this.config.startDelayMs) {
			await this.delay(this.config.startDelayMs);
		}

		// Emit worker_started
		this.emitEvent({
			type: "worker_started",
			taskId: this.taskId,
			workerId: this.workerId,
			identity: this.identity,
		});

		// Execute tool calls
		for (const toolCall of this.config.toolCalls || []) {
			await this.executeToolCall(toolCall);
		}

		// Exit
		await this.exit();
	}

	/**
	 * Execute a simulated tool call.
	 */
	private async executeToolCall(toolCall: MockToolCall): Promise<void> {
		const toolCallId = `tool-${this.toolCallIndex++}`;

		// Emit tool_call_start
		this.emitEvent({
			type: "tool_call_start",
			toolCallId,
			toolName: toolCall.name,
			args: toolCall.args,
		});

		// Tool delay
		if (this.config.toolDelayMs) {
			await this.delay(this.config.toolDelayMs);
		}

		// Default result
		const result = toolCall.result || { success: true, output: "OK" };

		// Emit tool_call_end
		this.emitEvent({
			type: "tool_call_end",
			toolCallId,
			toolName: toolCall.name,
			success: result.success,
			output: result.output,
			error: result.error,
		});
	}

	/**
	 * Simulate worker exit.
	 */
	private async exit(): Promise<void> {
		const exitConfig = this.config.exit || { code: 0, calledCompleteTask: true };

		// Exit delay
		if (exitConfig.delayMs) {
			await this.delay(exitConfig.delayMs);
		}

		this.exitCode = exitConfig.code;
		this.completed = exitConfig.code === 0 && exitConfig.calledCompleteTask !== false;

		// Emit appropriate event
		if (this.completed) {
			this.emitEvent({
				type: "worker_completed",
				exitCode: exitConfig.code,
				calledCompleteTask: exitConfig.calledCompleteTask,
			});
		} else {
			this.emitEvent({
				type: "worker_failed",
				exitCode: exitConfig.code,
				reason: exitConfig.reason || this.inferExitReason(exitConfig.code),
			});
		}

		// Emit exit event
		this.emit("exit", exitConfig.code);
	}

	/**
	 * Force crash the worker (simulates OOM, SIGKILL, etc.)
	 */
	crash(exitCode: number = 1, reason?: string): void {
		if (!this.started || this.exitCode !== null) {
			return;
		}

		this.exitCode = exitCode;
		this.completed = false;

		this.emitEvent({
			type: "worker_failed",
			exitCode,
			reason: reason || this.inferExitReason(exitCode),
		});

		this.emit("exit", exitCode);
	}

	/**
	 * Simulate timeout (worker is stuck).
	 */
	timeout(): void {
		this.crash(124, "Timeout");
	}

	/**
	 * Simulate OOM kill.
	 */
	oom(): void {
		this.crash(137, "Out of memory (killed by OOM)");
	}

	/**
	 * Get all events emitted by this worker.
	 */
	getEvents(): WorkerEvent[] {
		return [...this.events];
	}

	/**
	 * Check if worker completed successfully.
	 */
	isCompleted(): boolean {
		return this.completed;
	}

	/**
	 * Get exit code (null if not exited yet).
	 */
	getExitCode(): number | null {
		return this.exitCode;
	}

	private emitEvent(partial: Omit<WorkerEvent, "timestamp" | "workerId" | "taskId">): void {
		const event: WorkerEvent = {
			...partial,
			timestamp: Date.now(),
			workerId: this.workerId,
			taskId: this.taskId,
		};
		this.events.push(event);
		this.emit("event", event);
	}

	private inferExitReason(code: number): string {
		switch (code) {
			case 0: return "Success";
			case 1: return "Error";
			case 124: return "Timeout";
			case 137: return "Out of memory (killed by OOM)";
			case 143: return "Terminated (SIGTERM)";
			default: return `Unknown (exit code ${code})`;
		}
	}

	private delay(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a mock worker that completes successfully.
 */
export function createSuccessfulWorker(taskId: string, toolCalls?: MockToolCall[]): MockWorker {
	return new MockWorker({
		taskId,
		toolCalls: toolCalls || [
			{ name: "read", args: { path: "src/index.ts" }, result: { success: true, output: "file content" } },
			{ name: "edit", args: { path: "src/index.ts", oldText: "old", newText: "new" }, result: { success: true } },
		],
		exit: { code: 0, calledCompleteTask: true },
	});
}

/**
 * Create a mock worker that fails.
 */
export function createFailingWorker(taskId: string, exitCode: number = 1, reason?: string): MockWorker {
	return new MockWorker({
		taskId,
		toolCalls: [
			{ name: "read", args: { path: "src/index.ts" }, result: { success: true } },
			{ name: "edit", args: { path: "src/index.ts", oldText: "old", newText: "new" }, result: { success: false, error: "Syntax error" } },
		],
		exit: { code: exitCode, reason, calledCompleteTask: false },
	});
}

/**
 * Create a mock worker that times out.
 */
export function createTimingOutWorker(taskId: string): MockWorker {
	return new MockWorker({
		taskId,
		toolCalls: [
			{ name: "read", args: { path: "src/index.ts" }, result: { success: true } },
		],
		exit: { code: 124, reason: "Timeout", calledCompleteTask: false },
	});
}

/**
 * Create a mock worker that requests a restart.
 */
export function createRestartingWorker(taskId: string): MockWorker {
	return new MockWorker({
		taskId,
		toolCalls: [
			{ name: "read", args: { path: "src/index.ts" }, result: { success: true } },
		],
		exit: { code: 42, reason: "Restart requested by worker", calledCompleteTask: false },
	});
}
