import * as fsSync from "node:fs";
import * as path from "node:path";
import type { ChildProcess } from "node:child_process";
import type { SupervisorConfig } from "./types.js";
import type { FileBasedStorage } from "./state.js";
import { sendNudge } from "./nudge.js";
import { TaskQueueManager } from "./task-queue.js";
import type { WorkerHandle } from "./coordinator-tools/index.js";
import type { SDKWorkerHandle } from "./coordinator-tools/sdk-worker.js";

export type SupervisedWorkerHandle = (WorkerHandle | SDKWorkerHandle) & { taskId: string };

interface WorkerTracker {
	handle: SupervisedWorkerHandle;
	lastActivityAt: number;
	nudgedAt?: number;
	restartCount: number;
}

const DEFAULT_CONFIG: SupervisorConfig = {
	nudgeThresholdMs: 180000,
	restartThresholdMs: 300000,
	maxRestarts: 2,
	checkIntervalMs: 30000,
	dynamicSpawnTimeoutMs: 30000,
	staleTaskTimeoutMs: 1800000, // 30 minutes
};

/** Type guard: handle is a process-based worker (has `proc: ChildProcess`). */
function isProcHandle(handle: SupervisedWorkerHandle): handle is WorkerHandle & { taskId: string } {
	return "proc" in handle && (handle as WorkerHandle).proc != null;
}

/** Type guard: handle is an SDK-based worker (has `abort` function, no `proc`). */
function isSDKHandle(handle: SupervisedWorkerHandle): handle is SDKWorkerHandle & { taskId: string } {
	return "abort" in handle && typeof (handle as SDKWorkerHandle).abort === "function";
}

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

	start(handles: SupervisedWorkerHandle[], signal?: AbortSignal): void {
		for (const handle of handles) {
			this.workers.set(handle.workerId, {
				handle,
				lastActivityAt: Date.now(),
				restartCount: 0,
			});
		}

		signal?.addEventListener("abort", () => this.stop());

		// Run cleanup once before the interval loop starts
		void this.cleanupOnStartup();

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

	addWorker(handle: SupervisedWorkerHandle): void {
		this.workers.set(handle.workerId, {
			handle,
			lastActivityAt: Date.now(),
			restartCount: 0,
		});
	}

	removeWorker(workerId: string): void {
		this.workers.delete(workerId);
	}

	/**
	 * Run startup stale-task cleanup once — releases any `claimed` tasks that have
	 * no corresponding active worker handle (e.g. orphaned after a crash).
	 * Called automatically from `start()` and can be called externally during
	 * coordinate/index.ts initialization.
	 */
	async cleanupOnStartup(): Promise<void> {
		await this.cleanupStaleTasks(Date.now());
	}

	private getWorkerStateModTime(workerId: string): number | null {
		try {
			const statePath = path.join(this.coordDir, `worker-${workerId}.json`);
			const stat = fsSync.statSync(statePath);
			return stat.mtimeMs;
		} catch {
			return null;
		}
	}

	/**
	 * Check whether a process-based worker handle is still alive via PID signal.
	 * SDK workers (no `proc`) are skipped — their lifecycle is managed by the
	 * coordinator's promise/abort mechanism.
	 */
	private isHandleAlive(handle: SupervisedWorkerHandle): boolean {
		if (!isProcHandle(handle)) {
			// SDK worker: no proc to check. The coordinator calls removeWorker() when
			// the promise resolves, so the handle still being present means it's alive.
			return true;
		}
		try {
			const { proc } = handle;
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
			// SDK workers always return true from isHandleAlive; only proc handles can
			// be detected as dead here. SDK worker exits are signalled via removeWorker().
			if (!this.isHandleAlive(tracker.handle)) {
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

		// Check for stale claimed tasks (orphaned due to crashes, etc.)
		await this.cleanupStaleTasks(now);

		if (this.workers.size === 0) {
			this.stop();
		}
	}

	private async cleanupStaleTasks(now: number): Promise<void> {
		const staleTimeoutMs = this.config.staleTaskTimeoutMs ?? 1800000;

		try {
			const queue = await this.taskQueue.getQueue();
			const activeWorkerTaskIds = new Set(
				Array.from(this.workers.values()).map(w => w.handle.taskId)
			);

			for (const task of queue.tasks) {
				if (task.status !== "claimed") continue;
				if (!task.claimedAt) continue;

				// Skip if this task is being worked on by an active worker
				if (activeWorkerTaskIds.has(task.id)) continue;

				const claimedDuration = now - task.claimedAt;
				if (claimedDuration >= staleTimeoutMs) {
					// Task is stale - release it back to pending
					await this.taskQueue.releaseTask(task.id);

					await this.storage.appendEvent({
						type: "coordinator",
						message: `Released stale claimed task ${task.id} (claimed ${Math.round(claimedDuration / 60000)}min ago, no active worker)`,
						timestamp: now,
					});
				}
			}
		} catch {
			// Ignore errors in cleanup - non-critical
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
		const { workerId, identity, taskId } = tracker.handle;

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

		if (isProcHandle(tracker.handle)) {
			try { tracker.handle.proc.kill("SIGTERM"); } catch {}
		} else if (isSDKHandle(tracker.handle)) {
			try { tracker.handle.abort(); } catch {}
		}

		await this.taskQueue.releaseTask(taskId);
	}

	private async abandonWorker(tracker: WorkerTracker): Promise<void> {
		const { workerId, identity, taskId } = tracker.handle;

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

		if (isProcHandle(tracker.handle)) {
			try { tracker.handle.proc.kill("SIGKILL"); } catch {}
		} else if (isSDKHandle(tracker.handle)) {
			try { tracker.handle.abort(); } catch {}
		}

		await this.taskQueue.markTaskFailed(
			taskId,
			`Worker abandoned after ${this.config.maxRestarts} restart attempts`,
			this.config.maxRestarts,
		);

		// Also update worker state file so done() doesn't see "working" zombie.
		// Race guard: if the worker completed just before abandonment, preserve "complete" status.
		try {
			await this.storage.updateWorkerState(workerId, (s) => ({
				...s,
				status: s.status === "complete" ? "complete" : "failed",
				completedAt: s.completedAt || Date.now(),
				errorMessage: s.status === "complete" ? s.errorMessage : `Abandoned after max restart attempts`,
			}));
		} catch (_) { /* Non-fatal */ }

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
