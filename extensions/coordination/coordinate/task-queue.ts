import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import type { Task, TaskQueue, TaskStatus } from "./types.js";

export class TaskQueueManager {
	private queuePath: string;

	constructor(private coordDir: string) {
		this.queuePath = path.join(coordDir, "tasks.json");
	}

	private async withLock<T>(fn: () => Promise<T>): Promise<T> {
		const lockPath = path.join(this.coordDir, "tasks.lock");
		const maxRetries = 50;
		const retryDelay = 100;

		for (let i = 0; i < maxRetries; i++) {
			try {
				const fd = fsSync.openSync(lockPath, fsSync.constants.O_CREAT | fsSync.constants.O_EXCL | fsSync.constants.O_RDWR);
				fsSync.closeSync(fd);
				break;
			} catch (err: unknown) {
				if ((err as NodeJS.ErrnoException).code === "EEXIST") {
					await new Promise((r) => setTimeout(r, retryDelay));
					if (i === maxRetries - 1) throw new Error("Failed to acquire tasks.json lock");
				} else {
					throw err;
				}
			}
		}

		try {
			return await fn();
		} finally {
			try {
				fsSync.unlinkSync(lockPath);
			} catch {}
		}
	}

	async createFromPlan(planPath: string, planHash: string, tasks: Task[]): Promise<TaskQueue> {
		const queue: TaskQueue = {
			version: "2.0",
			planPath,
			planHash,
			createdAt: Date.now(),
			tasks: tasks.map((t) => ({
				...t,
				status: t.status || "pending",
			})),
		};

		await fs.writeFile(this.queuePath, JSON.stringify(queue, null, 2));
		return queue;
	}

	async getQueue(): Promise<TaskQueue> {
		const content = await fs.readFile(this.queuePath, "utf-8");
		return JSON.parse(content);
	}

	async getNextTask(): Promise<Task | null> {
		return this.withLock(async () => {
			const queue = await this.getQueue();

			const completedIds = new Set(
				queue.tasks.filter((t) => t.status === "complete").map((t) => t.id)
			);

			// Get blocked parent task IDs (parents waiting for subtasks)
			const blockedParentIds = new Set(
				queue.tasks
					.filter((t) => t.status === "blocked" && t.blockedBy?.length)
					.map((t) => t.id)
			);

			const available = queue.tasks
				.filter((t) => t.status === "pending")
				.filter((t) => {
					// All explicit dependencies must be complete
					const deps = t.dependsOn || [];
					if (!deps.every((depId) => completedIds.has(depId))) return false;

					// For subtasks (TASK-XX.Y): check if parent is blocked waiting for subtasks
					// This is when subtasks become available
					if (t.parentTaskId) {
						// Subtask only runs when parent is blocked waiting for it
						return blockedParentIds.has(t.parentTaskId);
					}

					return true;
				})
				.sort((a, b) => {
					// Sort by priority (P0=0 first, then P1=1, P2=2, P3=3)
					const pa = a.priority ?? 2; // Default to P2
					const pb = b.priority ?? 2;

					if (pa !== pb) return pa - pb;

					// Then by dependency count (fewer deps = more foundational)
					const depsA = a.dependsOn?.length ?? 0;
					const depsB = b.dependsOn?.length ?? 0;

					return depsA - depsB;
				});

			if (available.length === 0) return null;

			return available[0];
		});
	}

	async claimTask(taskId: string, claimedBy: string): Promise<Task | null> {
		return this.withLock(async () => {
			const queue = await this.getQueue();
			const task = queue.tasks.find((t) => t.id === taskId);

			if (!task || task.status !== "pending") return null;

			task.status = "claimed";
			task.claimedBy = claimedBy;
			task.claimedAt = Date.now();

			await fs.writeFile(this.queuePath, JSON.stringify(queue, null, 2));
			return task;
		});
	}

	async markTaskComplete(taskId: string, completedBy: string): Promise<void> {
		await this.withLock(async () => {
			const queue = await this.getQueue();
			const task = queue.tasks.find((t) => t.id === taskId);

			if (!task) return;

			task.status = "complete";
			task.completedAt = Date.now();
			task.completedBy = completedBy;

			// Check if this is a subtask - if so, try to unblock parent
			if (task.parentTaskId) {
				const parent = queue.tasks.find((t) => t.id === task.parentTaskId);
				if (parent && parent.status === "blocked") {
					// Check if all subtasks are complete
					const subtasks = queue.tasks.filter(
						(t) => t.parentTaskId === task.parentTaskId
					);
					const allComplete = subtasks.every((t) => t.status === "complete");

					if (allComplete) {
						// Unblock parent
						parent.status = "pending";
						parent.blockedBy = undefined;
					}
				}
			}

			this.updateBlockedTasks(queue);

			await fs.writeFile(this.queuePath, JSON.stringify(queue, null, 2));
		});
	}

	async markTaskFailed(taskId: string, reason: string, maxRestarts = 2): Promise<boolean> {
		return this.withLock(async () => {
			const queue = await this.getQueue();
			const task = queue.tasks.find((t) => t.id === taskId);

			if (!task) return false;

			task.restartCount = (task.restartCount || 0) + 1;

			if (task.restartCount >= maxRestarts) {
				task.status = "failed";
				task.failureReason = reason;
				await fs.writeFile(this.queuePath, JSON.stringify(queue, null, 2));
				return false;
			}

			task.status = "pending";
			task.claimedBy = undefined;
			task.claimedAt = undefined;

			await fs.writeFile(this.queuePath, JSON.stringify(queue, null, 2));
			return true;
		});
	}

	async releaseTask(taskId: string): Promise<void> {
		await this.withLock(async () => {
			const queue = await this.getQueue();
			const task = queue.tasks.find((t) => t.id === taskId);

			if (!task) return;

			task.status = "pending";
			task.claimedBy = undefined;
			task.claimedAt = undefined;

			await fs.writeFile(this.queuePath, JSON.stringify(queue, null, 2));
		});
	}

	async addDiscoveredTask(task: Omit<Task, "status" | "id"> & { id?: string }, status: "pending" | "pending_review" = "pending_review"): Promise<Task> {
		return this.withLock(async () => {
			const queue = await this.getQueue();

			// Auto-generate ID if not provided (atomic within lock)
			let taskId = task.id;
			if (!taskId) {
				const prefix = status === "pending" ? "FIX" : "DISC";
				const existingWithPrefix = queue.tasks.filter(t => t.id.startsWith(prefix));
				taskId = `${prefix}-${(existingWithPrefix.length + 1).toString().padStart(2, "0")}`;
			}

			const newTask: Task = {
				...task,
				id: taskId,
				status,
			};

			queue.tasks.push(newTask);
			await fs.writeFile(this.queuePath, JSON.stringify(queue, null, 2));

			return newTask;
		});
	}

	async getTasksForReview(): Promise<Task[]> {
		const queue = await this.getQueue();
		return queue.tasks
			.filter((t) => t.status === "pending_review")
			.sort((a, b) => a.priority - b.priority);
	}

	/**
	 * Create subtasks for a parent task and block the parent.
	 * Subtasks are TASK-XX.Y format and run in parallel.
	 */
	async createSubtasks(
		parentTaskId: string,
		subtasks: Array<{
			title: string;
			description: string;
			files?: string[];
			priority?: number;
		}>,
		maxSubtasks: number = 5,
	): Promise<{ success: boolean; subtaskIds: string[]; error?: string }> {
		return this.withLock(async () => {
			const queue = await this.getQueue();
			const parent = queue.tasks.find((t) => t.id === parentTaskId);

			if (!parent) {
				return { success: false, subtaskIds: [], error: `Parent task ${parentTaskId} not found` };
			}

			// Count existing subtasks
			const existingSubtasks = queue.tasks.filter(
				(t) => t.parentTaskId === parentTaskId
			);

			if (existingSubtasks.length + subtasks.length > maxSubtasks) {
				return {
					success: false,
					subtaskIds: [],
					error: `Too many subtasks for ${parentTaskId} (max ${maxSubtasks})`,
				};
			}

			const subtaskIds: string[] = [];
			const startNumber = existingSubtasks.length + 1;

			for (let i = 0; i < subtasks.length; i++) {
				const s = subtasks[i];
				const subtaskId = `${parentTaskId}.${startNumber + i}`;

				const newTask: Task = {
					id: subtaskId,
					description: `${s.title}\n\n${s.description}`,
					priority: s.priority ?? parent.priority ?? 2,
					status: "pending",
					files: s.files || [],
					dependsOn: [],
					parentTaskId,
				};

				queue.tasks.push(newTask);
				subtaskIds.push(subtaskId);
			}

			// Block parent until subtasks complete
			parent.status = "blocked";
			parent.blockedBy = subtaskIds;

			await fs.writeFile(this.queuePath, JSON.stringify(queue, null, 2));

			return { success: true, subtaskIds };
		});
	}

	/**
	 * Get a task by ID.
	 */
	async getTask(taskId: string): Promise<Task | null> {
		const queue = await this.getQueue();
		return queue.tasks.find((t) => t.id === taskId) || null;
	}

	/**
	 * Update a task.
	 */
	async updateTask(taskId: string, updates: Partial<Task>): Promise<void> {
		await this.withLock(async () => {
			const queue = await this.getQueue();
			const task = queue.tasks.find((t) => t.id === taskId);

			if (!task) return;

			Object.assign(task, updates);

			await fs.writeFile(this.queuePath, JSON.stringify(queue, null, 2));
		});
	}

	async approveTask(taskId: string, modifications?: Partial<Task>): Promise<void> {
		await this.withLock(async () => {
			const queue = await this.getQueue();
			const task = queue.tasks.find((t) => t.id === taskId);

			if (!task || task.status !== "pending_review") return;

			if (modifications) {
				Object.assign(task, modifications);
			}

			task.status = "pending";
			task.reviewed = true;
			task.reviewedAt = Date.now();
			task.reviewResult = modifications ? "modified" : "ok";

			this.updateBlockedTasks(queue);

			await fs.writeFile(this.queuePath, JSON.stringify(queue, null, 2));
		});
	}

	async rejectTask(taskId: string, reason: string): Promise<void> {
		await this.withLock(async () => {
			const queue = await this.getQueue();
			const task = queue.tasks.find((t) => t.id === taskId);

			if (!task || task.status !== "pending_review") return;

			task.status = "rejected";
			task.reviewed = true;
			task.reviewedAt = Date.now();
			task.reviewResult = "rejected";
			task.reviewNotes = reason;

			await fs.writeFile(this.queuePath, JSON.stringify(queue, null, 2));
		});
	}

	async getAllTasks(): Promise<Task[]> {
		const queue = await this.getQueue();
		return queue.tasks;
	}

	async isComplete(): Promise<boolean> {
		const queue = await this.getQueue();
		return queue.tasks.every(
			(t) => t.status === "complete" || t.status === "failed" || t.status === "rejected"
		);
	}

	async getPendingCount(): Promise<number> {
		const queue = await this.getQueue();
		return queue.tasks.filter((t) => t.status === "pending" || t.status === "claimed").length;
	}

	private updateBlockedTasks(queue: TaskQueue): void {
		const completedIds = new Set(
			queue.tasks.filter((t) => t.status === "complete").map((t) => t.id)
		);

		for (const task of queue.tasks) {
			if (task.status !== "blocked") continue;

			// Check explicit dependencies
			const deps = task.dependsOn || [];
			const depsComplete = deps.every((depId) => completedIds.has(depId));

			// Check blockedBy (for parent tasks waiting on subtasks)
			const blockedBy = task.blockedBy || [];
			const blockedByComplete = blockedBy.every((id) => completedIds.has(id));

			// Only unblock if both explicit deps and blockedBy are complete
			if (depsComplete && (blockedBy.length === 0 || blockedByComplete)) {
				task.status = "pending";
				task.blockedBy = undefined;
			}
		}
	}
}
