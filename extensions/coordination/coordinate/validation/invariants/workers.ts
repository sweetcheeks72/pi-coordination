import type { InvariantChecker, InvariantResult, ObservabilityData } from "../types.js";
import { getEventsByType } from "../loader.js";

export const workerLifecycleInvariant: InvariantChecker = {
	name: "Worker Lifecycle",
	category: "hard",

	async check(data: ObservabilityData): Promise<InvariantResult> {
		const spawningEvents = getEventsByType(data.events, "worker_spawning");
		const startedEvents = getEventsByType(data.events, "worker_started");
		const completedEvents = getEventsByType(data.events, "worker_completed");
		const failedEvents = getEventsByType(data.events, "worker_failed");

		const issues: string[] = [];
		const workerIds = new Set<string>();

		for (const event of spawningEvents) {
			if (workerIds.has(event.workerId)) {
				issues.push(`Duplicate worker ID: ${event.workerId}`);
			}
			workerIds.add(event.workerId);
		}

		const startedWorkerIds = new Set(startedEvents.map((e) => e.workerId));
		const completedWorkerIds = new Set(completedEvents.map((e) => e.workerId));
		const failedWorkerIds = new Set(failedEvents.map((e) => e.workerId));

		for (const event of spawningEvents) {
			const { workerId } = event;

			if (!startedWorkerIds.has(workerId)) {
				issues.push(`Worker ${workerId} was spawned but never started`);
				continue;
			}

			const hasCompleted = completedWorkerIds.has(workerId);
			const hasFailed = failedWorkerIds.has(workerId);

			if (!hasCompleted && !hasFailed) {
				issues.push(`Worker ${workerId} started but never completed or failed`);
			}

			if (hasCompleted && hasFailed) {
				issues.push(`Worker ${workerId} has both completed and failed events`);
			}
		}

		for (const workerId of startedWorkerIds) {
			if (!workerIds.has(workerId)) {
				issues.push(`Worker ${workerId} started without spawning event`);
			}
		}

		const totalSpawned = spawningEvents.length;
		const totalCompleted = completedEvents.length;
		const totalFailed = failedEvents.length;

		const passed = issues.length === 0;

		return {
			name: this.name,
			category: this.category,
			passed,
			message: passed
				? `All ${totalSpawned} workers completed lifecycle (${totalCompleted} completed, ${totalFailed} failed)`
				: issues.join("; "),
			details: {
				spawned: totalSpawned,
				started: startedWorkerIds.size,
				completed: totalCompleted,
				failed: totalFailed,
				issues: passed ? undefined : issues,
			},
		};
	},
};
