import type { ObservableEvent } from "../observability/types.js";
import type { PipelinePhase } from "../types.js";

export interface StreamingValidatorCallbacks {
	onWarning: (invariant: string, message: string) => void;
	onError: (invariant: string, message: string) => void;
}

interface PendingWorker {
	workerId: string;
	spawnedAt: number;
	startedAt?: number;
}

interface PendingContract {
	contractId: string;
	waitingSince: number;
	waiter: string;
}

interface PhaseState {
	phase: PipelinePhase;
	startedAt: number;
	completedAt?: number;
}

const WORKER_START_TIMEOUT_MS = 30000;
const CONTRACT_WAIT_TIMEOUT_MS = 60000;

export class StreamingValidator {
	private workers = new Map<string, PendingWorker>();
	private contractWaiters = new Map<string, PendingContract>();
	private phases = new Map<PipelinePhase, PhaseState>();
	private timeoutInterval: NodeJS.Timeout | null = null;
	private warningsEmitted = new Set<string>();

	constructor(private callbacks: StreamingValidatorCallbacks) {}

	start(): void {
		this.timeoutInterval = setInterval(() => this.checkTimeouts(), 5000);
	}

	stop(): void {
		if (this.timeoutInterval) {
			clearInterval(this.timeoutInterval);
			this.timeoutInterval = null;
		}
	}

	onEvent(event: ObservableEvent): void {
		switch (event.type) {
			case "worker_spawning":
				this.workers.set(event.workerId, {
					workerId: event.workerId,
					spawnedAt: event.timestamp,
				});
				break;

			case "worker_started":
				const worker = this.workers.get(event.workerId);
				if (worker) {
					worker.startedAt = event.timestamp;
				}
				break;

			case "worker_completed":
			case "worker_failed":
				this.workers.delete(event.workerId);
				break;

			case "contract_waiting":
				const key = `${event.contractId}:${event.waiter}`;
				this.contractWaiters.set(key, {
					contractId: event.contractId,
					waitingSince: event.timestamp,
					waiter: event.waiter,
				});
				break;

			case "contract_received":
				const receiveKey = `${event.contractId}:${event.waiter}`;
				this.contractWaiters.delete(receiveKey);
				break;

			case "phase_started":
				this.checkPhaseOrdering(event.phase);
				this.phases.set(event.phase, {
					phase: event.phase,
					startedAt: event.timestamp,
				});
				break;

			case "phase_completed":
				const phase = this.phases.get(event.phase);
				if (phase) {
					phase.completedAt = event.timestamp;
				}
				break;

			case "cost_threshold_crossed":
				if (event.threshold === "warn") {
					this.emitWarning("Cost", `Cost threshold warning: $${event.total.toFixed(2)}`);
				} else if (event.threshold === "pause") {
					this.emitError("Cost", `Cost threshold pause triggered: $${event.total.toFixed(2)}`);
				}
				break;
		}
	}

	private checkTimeouts(): void {
		const now = Date.now();

		for (const [workerId, worker] of this.workers) {
			if (!worker.startedAt && now - worker.spawnedAt > WORKER_START_TIMEOUT_MS) {
				const elapsed = Math.round((now - worker.spawnedAt) / 1000);
				this.emitWarningOnce(
					"Worker Lifecycle",
					`worker-timeout:${workerId}`,
					`Worker ${workerId} spawned ${elapsed}s ago but never started`,
				);
			}
		}

		for (const [key, waiter] of this.contractWaiters) {
			if (now - waiter.waitingSince > CONTRACT_WAIT_TIMEOUT_MS) {
				const elapsed = Math.round((now - waiter.waitingSince) / 1000);
				this.emitWarningOnce(
					"Contract Fulfillment",
					`contract-timeout:${key}`,
					`${waiter.waiter} waiting for contract ${waiter.contractId} for ${elapsed}s`,
				);
			}
		}
	}

	private checkPhaseOrdering(newPhase: PipelinePhase): void {
		const phaseOrder: PipelinePhase[] = ["scout", "coordinator", "workers", "review", "fixes", "complete"];
		const newPhaseIndex = phaseOrder.indexOf(newPhase);

		if (newPhaseIndex <= 0) return;

		const prevPhase = phaseOrder[newPhaseIndex - 1];
		const prevState = this.phases.get(prevPhase);

		if (prevState && !prevState.completedAt) {
			this.emitError(
				"Phase Ordering",
				`Phase ${newPhase} started before ${prevPhase} completed`,
			);
		}
	}

	private emitWarning(invariant: string, message: string): void {
		const key = `warn:${invariant}:${message}`;
		if (this.warningsEmitted.has(key)) return;
		this.warningsEmitted.add(key);
		this.callbacks.onWarning(invariant, message);
	}

	private emitWarningOnce(invariant: string, dedupeKey: string, message: string): void {
		const key = `warn:${invariant}:${dedupeKey}`;
		if (this.warningsEmitted.has(key)) return;
		this.warningsEmitted.add(key);
		this.callbacks.onWarning(invariant, message);
	}

	private emitError(invariant: string, message: string): void {
		const key = `error:${invariant}:${message}`;
		if (this.warningsEmitted.has(key)) return;
		this.warningsEmitted.add(key);
		this.callbacks.onError(invariant, message);
	}
}

export function createStreamingValidator(
	onWarning: (invariant: string, message: string) => void,
	onError: (invariant: string, message: string) => void,
): StreamingValidator {
	return new StreamingValidator({ onWarning, onError });
}
