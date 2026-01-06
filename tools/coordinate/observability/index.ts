import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { EventEmitter } from "./events.js";
import { SpanTracer } from "./spans.js";
import { SnapshotManager } from "./snapshots.js";
import { DecisionLogger } from "./decisions.js";
import { ResourceTracker } from "./resources.js";
import { ErrorTracker } from "./errors.js";
import { CausalityTracker } from "./causality.js";
import { LlmLogger } from "./llm.js";
import type { ActorType } from "./types.js";

export class ObservabilityContext {
	readonly events: EventEmitter;
	readonly spans: SpanTracer;
	readonly snapshots: SnapshotManager;
	readonly decisions: DecisionLogger;
	readonly resources: ResourceTracker;
	readonly errors: ErrorTracker;
	readonly causality: CausalityTracker;
	readonly llm: LlmLogger;

	private constructor(
		public readonly traceId: string,
		public readonly coordDir: string,
		public readonly cwd: string,
		actor: string,
		actorType: ActorType,
	) {
		this.events = new EventEmitter(coordDir, actor, actorType, traceId);
		this.spans = new SpanTracer(coordDir, traceId);
		this.snapshots = new SnapshotManager(coordDir, traceId, cwd);
		this.decisions = new DecisionLogger(coordDir, traceId);
		this.resources = new ResourceTracker(coordDir, traceId);
		this.errors = new ErrorTracker(coordDir, traceId);
		this.causality = new CausalityTracker(coordDir, traceId);
		this.llm = new LlmLogger(coordDir, traceId);
	}

	static async create(
		coordDir: string,
		cwd: string,
		actor: string,
		actorType: ActorType,
		existingTraceId?: string,
	): Promise<ObservabilityContext> {
		const traceId = existingTraceId || randomUUID();

		await fs.mkdir(path.join(coordDir, "traces"), { recursive: true });
		await fs.mkdir(path.join(coordDir, "snapshots"), { recursive: true });

		return new ObservabilityContext(traceId, coordDir, cwd, actor, actorType);
	}

	getTraceId(): string {
		return this.traceId;
	}

	getEnvVars(): Record<string, string> {
		return {
			PI_TRACE_ID: this.traceId,
			PI_COORDINATION_DIR: this.coordDir,
		};
	}
}

export function createWorkerObservability(
	coordDir?: string,
	traceId?: string,
	identity?: string,
	cwd?: string,
	actorType: ActorType = "worker",
): ObservabilityContext | null {
	const dir = coordDir || process.env.PI_COORDINATION_DIR;
	const trace = traceId || process.env.PI_TRACE_ID;
	const actor = identity || process.env.PI_AGENT_IDENTITY;
	const workingDir = cwd || process.cwd();

	if (!dir || !trace || !actor) return null;

	return new (ObservabilityContext as unknown as {
		new (traceId: string, coordDir: string, cwd: string, actor: string, actorType: ActorType): ObservabilityContext;
	})(trace, dir, workingDir, actor, actorType);
}

export { EventEmitter, type EventListener } from "./events.js";
export { SpanTracer } from "./spans.js";
export { SnapshotManager } from "./snapshots.js";
export { DecisionLogger } from "./decisions.js";
export { ResourceTracker } from "./resources.js";
export { ErrorTracker } from "./errors.js";
export { CausalityTracker } from "./causality.js";
export { LlmLogger } from "./llm.js";
export * from "./types.js";
