import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Span } from "./types.js";

export class SpanTracer {
	private spans: Map<string, Span> = new Map();

	constructor(
		private coordDir: string,
		private traceId: string,
	) {}

	startSpan(
		name: string,
		kind: Span["kind"],
		parentId?: string,
		attributes?: Record<string, unknown>,
	): Span {
		const span: Span = {
			id: `span-${randomUUID().slice(0, 12)}`,
			traceId: this.traceId,
			parentId,
			name,
			kind,
			startTime: Date.now(),
			status: "running",
			attributes: attributes || {},
		};

		this.spans.set(span.id, span);
		this.flush(span).catch(() => {});
		return span;
	}

	endSpan(
		spanId: string,
		status: "ok" | "error" = "ok",
		attributes?: Record<string, unknown>,
		usage?: Span["usage"],
	): void {
		const span = this.spans.get(spanId);
		if (!span) return;

		span.endTime = Date.now();
		span.duration = span.endTime - span.startTime;
		span.status = status;
		if (attributes) Object.assign(span.attributes, attributes);
		if (usage) span.usage = usage;

		this.flush(span).catch(() => {});
	}

	addLink(
		spanId: string,
		linkedSpanId: string,
		relationship: "child_of" | "follows_from" | "caused_by",
	): void {
		const span = this.spans.get(spanId);
		if (!span) return;

		span.links = span.links || [];
		span.links.push({ spanId: linkedSpanId, relationship });
	}

	getSpan(spanId: string): Span | undefined {
		return this.spans.get(spanId);
	}

	private async flush(span: Span): Promise<void> {
		const tracesDir = path.join(this.coordDir, "traces");
		await fs.mkdir(tracesDir, { recursive: true });
		await fs.appendFile(
			path.join(tracesDir, "spans.jsonl"),
			JSON.stringify(span) + "\n",
		);
	}
}
