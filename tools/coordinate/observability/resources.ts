import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ResourceType, ResourceEvent } from "./types.js";

export class ResourceTracker {
	private activeResources: Map<string, ResourceEvent> = new Map();

	constructor(
		private coordDir: string,
		private traceId: string,
	) {}

	async trackCreation(
		type: ResourceType,
		resourceId: string,
		owner: string,
		data: Record<string, unknown>,
		expectedLifetime?: number,
	): Promise<void> {
		const event: ResourceEvent = {
			id: `res-${randomUUID().slice(0, 8)}`,
			traceId: this.traceId,
			timestamp: Date.now(),
			resourceType: type,
			resourceId,
			event: "created",
			data,
			owner,
			expectedLifetime,
		};

		this.activeResources.set(resourceId, event);
		await this.flush(event);
	}

	async trackUpdate(
		resourceId: string,
		data: Record<string, unknown>,
	): Promise<void> {
		const created = this.activeResources.get(resourceId);
		if (!created) return;

		const event: ResourceEvent = {
			...created,
			id: `res-${randomUUID().slice(0, 8)}`,
			timestamp: Date.now(),
			event: "updated",
			data: { ...created.data, ...data },
		};

		this.activeResources.set(resourceId, event);
		await this.flush(event);
	}

	async trackRelease(resourceId: string): Promise<void> {
		const created = this.activeResources.get(resourceId);
		if (!created) return;

		const event: ResourceEvent = {
			...created,
			id: `res-${randomUUID().slice(0, 8)}`,
			timestamp: Date.now(),
			event: "released",
		};

		this.activeResources.delete(resourceId);
		await this.flush(event);
	}

	async detectLeaks(): Promise<ResourceEvent[]> {
		const now = Date.now();
		const leaks: ResourceEvent[] = [];

		for (const [id, event] of this.activeResources) {
			if (event.expectedLifetime && now - event.timestamp > event.expectedLifetime) {
				const leak: ResourceEvent = {
					...event,
					id: `res-${randomUUID().slice(0, 8)}`,
					timestamp: now,
					event: "leaked",
				};
				leaks.push(leak);
				await this.flush(leak);
			}
		}

		return leaks;
	}

	getActiveResources(): Map<string, ResourceEvent> {
		return new Map(this.activeResources);
	}

	private async flush(event: ResourceEvent): Promise<void> {
		await fs.appendFile(
			path.join(this.coordDir, "resources.jsonl"),
			JSON.stringify(event) + "\n",
		);
	}
}
