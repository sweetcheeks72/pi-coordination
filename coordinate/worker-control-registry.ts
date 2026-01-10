/**
 * Registry for worker control functions.
 * Allows dashboard to interact with running SDK-based workers.
 */

export type SteerFn = (message: string) => Promise<void>;
export type AbortFn = () => void;

interface WorkerControls {
	steer?: SteerFn; // Send message to worker
	abort?: AbortFn; // Kill entire session
}

const registry = new Map<string, WorkerControls>();

export function registerControls(workerId: string, controls: WorkerControls): void {
	registry.set(workerId, { ...registry.get(workerId), ...controls });
}

export function unregisterControls(workerId: string): void {
	registry.delete(workerId);
}

export function getControls(workerId: string): WorkerControls | undefined {
	return registry.get(workerId);
}

export function hasControls(workerId: string): boolean {
	return registry.has(workerId);
}

// Convenience accessors
export function getSteer(workerId: string): SteerFn | undefined {
	return registry.get(workerId)?.steer;
}

export function getAbort(workerId: string): AbortFn | undefined {
	return registry.get(workerId)?.abort;
}

export function hasSteer(workerId: string): boolean {
	return !!registry.get(workerId)?.steer;
}
