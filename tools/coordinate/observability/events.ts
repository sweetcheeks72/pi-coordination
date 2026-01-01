import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PipelinePhase } from "../types.js";
import type { ObservableEvent, BaseEvent, ActorType } from "./types.js";

export class EventEmitter {
	private spanStack: string[] = [];
	private eventCount = 0;
	private _currentPhase: PipelinePhase = "coordinator";

	constructor(
		private coordDir: string,
		private actor: string,
		private actorType: ActorType,
		private traceId: string,
	) {}

	setPhase(phase: PipelinePhase): void {
		this._currentPhase = phase;
	}

	get currentPhase(): PipelinePhase {
		return this._currentPhase;
	}

	async emit<T extends ObservableEvent>(
		event: Omit<T, keyof BaseEvent> & { type: T["type"] },
		causedBy?: string,
	): Promise<string> {
		const eventId = `${this.actor.slice(0, 8)}-${++this.eventCount}`;

		const fullEvent: ObservableEvent = {
			id: eventId,
			timestamp: Date.now(),
			traceId: this.traceId,
			spanId: this.currentSpan(),
			parentSpanId: this.parentSpan(),
			causedBy,
			phase: this._currentPhase,
			actor: this.actor,
			actorType: this.actorType,
			...event,
		} as ObservableEvent;

		await fs.appendFile(
			path.join(this.coordDir, "events.jsonl"),
			JSON.stringify(fullEvent) + "\n",
		);

		return eventId;
	}

	pushSpan(name: string): string {
		const spanId = `${name}-${randomUUID().slice(0, 8)}`;
		this.spanStack.push(spanId);
		return spanId;
	}

	popSpan(): void {
		this.spanStack.pop();
	}

	currentSpan(): string {
		return this.spanStack[this.spanStack.length - 1] || "root";
	}

	parentSpan(): string | undefined {
		return this.spanStack[this.spanStack.length - 2];
	}

	getTraceId(): string {
		return this.traceId;
	}
}
