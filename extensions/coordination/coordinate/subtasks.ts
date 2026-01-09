/**
 * Subtask Support Module
 *
 * Handles worker-created subtasks:
 * - Workers can break down complex tasks into smaller pieces (TASK-XX.Y format)
 * - Parent task blocks until all subtasks complete
 * - Subtasks run in parallel (all depend on parent, but not on each other)
 * - Max 5 subtasks per parent task
 *
 * This is different from discovered tasks (FIX-XX format) which are found by
 * the reviewer and go through the TaskQueueManager approval flow.
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import type { Task, TaskStatus } from "./types.js";
import type { TaskQueueManager } from "./task-queue.js";
import { addWaitsForDependency } from "./deps.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Subtask request from a worker.
 */
export interface SubtaskRequest {
	title: string;
	description: string;
	files?: string[];
	priority?: "P0" | "P1" | "P2" | "P3";
	reason: string; // Why this subtask is needed
}

/**
 * Result of worker execution.
 */
export interface WorkerResult {
	taskId: string;
	status: "completed" | "failed" | "needs_subtasks";
	output?: string;
	error?: string;
	subtasks?: SubtaskRequest[];
	filesModified?: string[];
}

/**
 * Configuration for subtask handling.
 */
export interface SubtaskConfig {
	/** Maximum subtasks per parent (default: 5) */
	maxSubtasks?: number;
	/** Allow nested subtasks (default: false) */
	allowNested?: boolean;
}

/**
 * Result of creating subtasks.
 */
export interface CreateSubtasksResult {
	success: boolean;
	subtasks: Task[];
	error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_MAX_SUBTASKS = 5;

// ─────────────────────────────────────────────────────────────────────────────
// Subtask ID Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if a task ID is a subtask (TASK-XX.Y format).
 */
export function isSubtaskId(taskId: string): boolean {
	return /^TASK-\d+\.\d+$/.test(taskId);
}

/**
 * Extract parent task ID from a subtask ID.
 */
export function getParentTaskId(subtaskId: string): string | null {
	const match = subtaskId.match(/^(TASK-\d+)\.\d+$/);
	return match ? match[1] : null;
}

/**
 * Generate subtask ID for a parent.
 */
export function generateSubtaskId(parentId: string, subtaskNumber: number): string {
	return `${parentId}.${subtaskNumber}`;
}

/**
 * Get subtask number from ID.
 */
export function getSubtaskNumber(subtaskId: string): number | null {
	const match = subtaskId.match(/^TASK-\d+\.(\d+)$/);
	return match ? parseInt(match[1], 10) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Subtask Creation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create subtasks for a parent task.
 *
 * This is called when a worker returns with status: "needs_subtasks".
 * The parent task is blocked until all subtasks complete.
 */
export async function createSubtasks(
	coordDir: string,
	taskQueue: TaskQueueManager,
	parentTask: Task,
	requests: SubtaskRequest[],
	config: SubtaskConfig = {},
): Promise<CreateSubtasksResult> {
	const maxSubtasks = config.maxSubtasks ?? DEFAULT_MAX_SUBTASKS;
	const allowNested = config.allowNested ?? false;

	// Validate: Don't allow subtasks of subtasks (unless explicitly enabled)
	if (!allowNested && isSubtaskId(parentTask.id)) {
		return {
			success: false,
			subtasks: [],
			error: `Cannot create subtasks for ${parentTask.id} - nested subtasks not allowed`,
		};
	}

	// Get existing subtasks for this parent
	const allTasks = await taskQueue.getAllTasks();
	const existingSubtasks = allTasks.filter(
		(t) => getParentTaskId(t.id) === parentTask.id,
	);

	// Validate: Check max subtasks limit
	if (existingSubtasks.length + requests.length > maxSubtasks) {
		return {
			success: false,
			subtasks: [],
			error: `Too many subtasks for ${parentTask.id} (max ${maxSubtasks}, existing ${existingSubtasks.length}, requested ${requests.length})`,
		};
	}

	// Create subtasks
	const createdSubtasks: Task[] = [];
	const startNumber = existingSubtasks.length + 1;

	for (let i = 0; i < requests.length; i++) {
		const req = requests[i];
		const subtaskNumber = startNumber + i;
		const subtaskId = generateSubtaskId(parentTask.id, subtaskNumber);

		// Map priority string to number
		const priorityMap: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
		const priority =
			req.priority !== undefined
				? priorityMap[req.priority]
				: (parentTask.priority ?? 2);

		const subtask: Task = {
			id: subtaskId,
			description: `${req.title}\n\n${req.description}\n\n**Reason:** ${req.reason}`,
			priority,
			status: "pending" as TaskStatus,
			files: req.files || [],
			dependsOn: [], // Subtasks have implicit parent dependency, not explicit
			acceptanceCriteria: [`Subtask complete: ${req.title}`],
		};

		// Add to queue
		const added = await taskQueue.addDiscoveredTask(
			{
				...subtask,
				id: subtaskId, // Force the specific ID
			},
			"pending", // Subtasks are immediately pending (no review needed)
		);

		createdSubtasks.push(added);
	}

	// Add waits-for dependencies to the graph
	await addWaitsForDependency(
		coordDir,
		parentTask.id,
		createdSubtasks.map((s) => s.id),
		`worker:${parentTask.id}`,
	);

	return {
		success: true,
		subtasks: createdSubtasks,
	};
}

/**
 * Block a parent task until its subtasks complete.
 *
 * Called after subtasks are created. Updates the parent's status to "blocked"
 * and records which subtasks it's waiting for.
 */
export async function blockParentTask(
	taskQueue: TaskQueueManager,
	parentTaskId: string,
	subtaskIds: string[],
): Promise<void> {
	// Use updateTask to properly persist the blocked status
	await taskQueue.updateTask(parentTaskId, {
		status: "blocked",
		blockedBy: subtaskIds,
		claimedBy: undefined,
		claimedAt: undefined,
	});
}

/**
 * Check if all subtasks for a parent are complete.
 */
export async function checkSubtasksComplete(
	taskQueue: TaskQueueManager,
	parentTaskId: string,
): Promise<boolean> {
	const allTasks = await taskQueue.getAllTasks();

	// Find all subtasks for this parent
	const subtasks = allTasks.filter(
		(t) => getParentTaskId(t.id) === parentTaskId,
	);

	// No subtasks means nothing to wait for
	if (subtasks.length === 0) return true;

	// All subtasks must be complete
	return subtasks.every((t) => t.status === "complete");
}

/**
 * Unblock a parent task if all its subtasks are complete.
 *
 * Returns true if the parent was unblocked.
 */
export async function tryUnblockParent(
	taskQueue: TaskQueueManager,
	parentTaskId: string,
): Promise<boolean> {
	const allTasks = await taskQueue.getAllTasks();
	const parent = allTasks.find((t) => t.id === parentTaskId);

	if (!parent || parent.status !== "blocked") return false;

	const subtasksComplete = await checkSubtasksComplete(taskQueue, parentTaskId);
	if (!subtasksComplete) return false;

	// Unblock by setting status to pending and clearing blockedBy
	await taskQueue.updateTask(parentTaskId, {
		status: "pending",
		blockedBy: undefined,
		claimedBy: undefined,
		claimedAt: undefined,
	});
	return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker Result Handling
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handle a worker result that may request subtasks.
 *
 * Returns the created subtasks if any, or null if no subtasks needed.
 */
export async function handleWorkerResult(
	coordDir: string,
	taskQueue: TaskQueueManager,
	result: WorkerResult,
	config: SubtaskConfig = {},
): Promise<CreateSubtasksResult | null> {
	if (result.status !== "needs_subtasks" || !result.subtasks?.length) {
		return null;
	}

	// Get the parent task
	const allTasks = await taskQueue.getAllTasks();
	const parentTask = allTasks.find((t) => t.id === result.taskId);

	if (!parentTask) {
		return {
			success: false,
			subtasks: [],
			error: `Parent task ${result.taskId} not found`,
		};
	}

	// Create subtasks
	const createResult = await createSubtasks(
		coordDir,
		taskQueue,
		parentTask,
		result.subtasks,
		config,
	);

	if (createResult.success) {
		// Block the parent task
		await blockParentTask(
			taskQueue,
			parentTask.id,
			createResult.subtasks.map((s) => s.id),
		);
	}

	return createResult;
}

// ─────────────────────────────────────────────────────────────────────────────
// Subtask Completion Handling
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handle subtask completion.
 *
 * When a subtask completes, check if its parent can be unblocked.
 */
export async function handleSubtaskComplete(
	taskQueue: TaskQueueManager,
	subtaskId: string,
): Promise<{ parentUnblocked: boolean; parentId: string | null }> {
	const parentId = getParentTaskId(subtaskId);

	if (!parentId) {
		return { parentUnblocked: false, parentId: null };
	}

	const unblocked = await tryUnblockParent(taskQueue, parentId);

	return { parentUnblocked: unblocked, parentId };
}

/**
 * Get summary of subtask status for a parent.
 */
export async function getSubtaskSummary(
	taskQueue: TaskQueueManager,
	parentTaskId: string,
): Promise<{
	total: number;
	completed: number;
	pending: number;
	failed: number;
	blocked: number;
}> {
	const allTasks = await taskQueue.getAllTasks();
	const subtasks = allTasks.filter(
		(t) => getParentTaskId(t.id) === parentTaskId,
	);

	return {
		total: subtasks.length,
		completed: subtasks.filter((t) => t.status === "complete").length,
		pending: subtasks.filter(
			(t) => t.status === "pending" || t.status === "claimed",
		).length,
		failed: subtasks.filter((t) => t.status === "failed").length,
		blocked: subtasks.filter((t) => t.status === "blocked").length,
	};
}
