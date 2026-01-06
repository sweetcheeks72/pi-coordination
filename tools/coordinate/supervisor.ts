import * as fsSync from "node:fs";
import * as path from "node:path";
import type { ChildProcess } from "node:child_process";
import type { SupervisorConfig } from "./types.js";
import type { FileBasedStorage } from "./state.js";
import { sendNudge } from "./nudge.js";
import { TaskQueueManager } from "./task-queue.js";

export interface WorkerHandle {
	workerId: string;
	identity: string;
	pid: number;
	proc: ChildProcess;
	promise: Promise<number>;
	taskId: string;
}

interface WorkerTracker {
	handle: WorkerHandle;
	lastActivityAt: number;
	nudgedAt?: number;
	restartCount: number;
}

const DEFAULT_CONFIG: SupervisorConfig = {
	nudgeThresholdMs: 180000,
	restartThresholdMs: 300000,
	maxRestarts: 2,
	checkIntervalMs: 30000,
};

export class SupervisorLoop {
	private workers = new Map<string, WorkerTracker>();
	private intervalId: NodeJS.Timeout | null = null;
	private config: SupervisorConfig;
	private aborted = false;

	constructor(
		private coordDir: string,
		private storage: FileBasedStorage,
		private taskQueue: TaskQueueManager,
		config?: Partial<SupervisorConfig>,
	) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	start(handles: WorkerHandle[], signal?: AbortSignal): void {
		for (const handle of handles) {
			this.workers.set(handle.workerId, {
				handle,
				lastActivityAt: Date.now(),
				restartCount: 0,
			});
		}

		signal?.addEventListener("abort", () => this.stop());

		this.intervalId = setInterval(() => this.checkAllWorkers(), this.config.checkIntervalMs);
	}

	stop(): void {
		this.aborted = true;
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}

	updateActivity(workerId: string): void {
		const tracker = this.workers.get(workerId);
		if (tracker) {
			tracker.lastActivityAt = Date.now();
		}
	}

	addWorker(handle: WorkerHandle): void {
		this.workers.set(handle.workerId, {
			handle,
			lastActivityAt: Date.now(),
			restartCount: 0,
		});
	}

	removeWorker(workerId: string): void {
		this.workers.delete(workerId);
	}

	private getWorkerStateModTime(workerId: string): number | null {
		try {
			const statePath = path.join(this.coordDir, "workers", `${workerId}.json`);
			const stat = fsSync.statSync(statePath);
			return stat.mtimeMs;
		} catch {
			return null;
		}
	}

	private isProcessAlive(proc: ChildProcess): boolean {
		try {
			if (proc.exitCode !== null) return false;
			if (proc.killed) return false;
			process.kill(proc.pid!, 0);
			return true;
		} catch {
			return false;
		}
	}

	private async checkAllWorkers(): Promise<void> {
		if (this.aborted) return;

		const now = Date.now();

		for (const [workerId, tracker] of this.workers.entries()) {
			if (!this.isProcessAlive(tracker.handle.proc)) {
				this.workers.delete(workerId);
				continue;
			}

			const stateModTime = this.getWorkerStateModTime(workerId);
			if (stateModTime && stateModTime > tracker.lastActivityAt) {
				tracker.lastActivityAt = stateModTime;
				tracker.nudgedAt = undefined;
			}

			const inactiveMs = now - tracker.lastActivityAt;

			if (inactiveMs >= this.config.restartThresholdMs) {
				await this.handleStuckWorker(tracker);
				continue;
			}

			if (inactiveMs >= this.config.nudgeThresholdMs && !tracker.nudgedAt) {
				await this.nudgeWorker(tracker);
			}
		}

		if (this.workers.size === 0) {
			this.stop();
		}
	}

	private async nudgeWorker(tracker: WorkerTracker): Promise<void> {
		const { workerId, identity } = tracker.handle;

		await sendNudge(this.coordDir, workerId, {
			type: "wrap_up",
			message: "You have been inactive for a while. Please wrap up your current task or report status.",
			timestamp: Date.now(),
		});

		tracker.nudgedAt = Date.now();

		await this.storage.appendEvent({
			type: "coordinator",
			message: `Nudged worker ${identity} after inactivity`,
			timestamp: Date.now(),
		});
	}

	private async handleStuckWorker(tracker: WorkerTracker): Promise<void> {
		const { workerId, identity, taskId, proc } = tracker.handle;

		tracker.restartCount++;

		if (tracker.restartCount > this.config.maxRestarts) {
			await this.abandonWorker(tracker);
			return;
		}

		await sendNudge(this.coordDir, workerId, {
			type: "restart",
			message: "Worker has been stuck. Requesting restart.",
			timestamp: Date.now(),
		});

		await this.storage.appendEvent({
			type: "coordinator",
			message: `Requesting restart for stuck worker ${identity} (attempt ${tracker.restartCount}/${this.config.maxRestarts})`,
			timestamp: Date.now(),
		});

		try {
			proc.kill("SIGTERM");
		} catch {}

		await this.taskQueue.releaseTask(taskId);
	}

	private async abandonWorker(tracker: WorkerTracker): Promise<void> {
		const { workerId, identity, taskId, proc } = tracker.handle;

		await sendNudge(this.coordDir, workerId, {
			type: "abort",
			message: "Worker abandoned after max restart attempts.",
			timestamp: Date.now(),
		});

		await this.storage.appendEvent({
			type: "worker_failed",
			workerId,
			error: `Abandoned after ${this.config.maxRestarts} restart attempts`,
			timestamp: Date.now(),
		});

		try {
			proc.kill("SIGKILL");
		} catch {}

		await this.taskQueue.markTaskFailed(
			taskId,
			`Worker abandoned after ${this.config.maxRestarts} restart attempts`,
			this.config.maxRestarts,
		);

		this.workers.delete(workerId);
	}

	getActiveWorkerCount(): number {
		return this.workers.size;
	}

	getWorkerStatus(): Array<{ workerId: string; inactiveMs: number; nudged: boolean; restartCount: number }> {
		const now = Date.now();
		return Array.from(this.workers.entries()).map(([workerId, tracker]) => ({
			workerId,
			inactiveMs: now - tracker.lastActivityAt,
			nudged: !!tracker.nudgedAt,
			restartCount: tracker.restartCount,
		}));
	}
}
