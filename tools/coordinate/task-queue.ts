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

			const available = queue.tasks
				.filter((t) => t.status === "pending")
				.filter((t) => {
					const deps = t.dependsOn || [];
					return deps.every((depId) => completedIds.has(depId));
				})
				.sort((a, b) => a.priority - b.priority);

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

	async addDiscoveredTask(task: Omit<Task, "status">): Promise<Task> {
		return this.withLock(async () => {
			const queue = await this.getQueue();

			const newTask: Task = {
				...task,
				status: "pending_review",
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

			const deps = task.dependsOn || [];
			if (deps.every((depId) => completedIds.has(depId))) {
				task.status = "pending";
			}
		}
	}
}
