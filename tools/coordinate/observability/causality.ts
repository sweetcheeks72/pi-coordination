import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CausalLink } from "./types.js";

interface PendingCause {
	eventId: string;
	type: string;
	actor: string;
	timestamp: number;
}

export class CausalityTracker {
	private pendingCauses: Map<string, PendingCause> = new Map();

	constructor(
		private coordDir: string,
		private traceId: string,
	) {}

	registerPotentialCause(key: string, eventId: string, type: string, actor: string): void {
		this.pendingCauses.set(key, {
			eventId,
			type,
			actor,
			timestamp: Date.now(),
		});
	}

	async linkEffect(
		causeKey: string,
		effect: { eventId: string; type: string; actor: string },
		relationship: CausalLink["relationship"],
	): Promise<void> {
		const cause = this.pendingCauses.get(causeKey);
		if (!cause) return;

		const now = Date.now();
		const link: CausalLink = {
			id: `causal-${randomUUID().slice(0, 8)}`,
			traceId: this.traceId,
			timestamp: now,
			cause: {
				eventId: cause.eventId,
				type: cause.type,
				actor: cause.actor,
			},
			effect,
			relationship,
			latency: now - cause.timestamp,
		};

		await fs.appendFile(
			path.join(this.coordDir, "causality.jsonl"),
			JSON.stringify(link) + "\n",
		);
	}

	removeCause(key: string): void {
		this.pendingCauses.delete(key);
	}

	hasCause(key: string): boolean {
		return this.pendingCauses.has(key);
	}
}
