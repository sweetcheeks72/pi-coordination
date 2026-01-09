/**
 * Observability Assertions for testing coordination events, spans, and decisions.
 *
 * Provides typed helpers for verifying:
 * - Event sequences and types
 * - Span hierarchy
 * - Decision logging
 * - Causal links
 * - Resource tracking
 *
 * @module
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Types (aligned with observability/types.ts)
// ─────────────────────────────────────────────────────────────────────────────

export interface ObservableEvent {
	type: string;
	timestamp: number;
	traceId?: string;
	spanId?: string;
	[key: string]: unknown;
}

export interface Span {
	id: string;
	traceId?: string;
	name: string;
	kind?: "coordination" | "phase" | "worker" | "tool" | "llm" | "io";
	parentId?: string;
	startTime: number;
	endTime?: number;
	duration?: number;
	status?: "running" | "ok" | "error";
	attributes?: Record<string, unknown>;
	usage?: {
		inputTokens?: number;
		outputTokens?: number;
		cost?: number;
	};
	links?: Array<{
		spanId: string;
		relationship: "child_of" | "follows_from" | "caused_by";
	}>;
}

export interface Decision {
	id: string;
	traceId?: string;
	spanId?: string;
	timestamp: number;
	actor: string;
	actorType?: "coordinator" | "worker" | "reviewer" | "system";
	type: string;
	decision: {
		chosen: unknown;
		alternatives?: unknown[];
		reason: string;
	};
	context: {
		inputs: Record<string, unknown>;
		constraints?: string[];
		heuristics?: string[];
	};
	outcome?: {
		success: boolean;
		impact: string;
		wouldChooseDifferently?: boolean;
	};
}

export interface CausalLink {
	id: string;
	traceId?: string;
	timestamp: number;
	cause: { eventId: string; type: string; actor: string };
	effect: { eventId: string; type: string; actor: string };
	relationship: "triggered" | "enabled" | "blocked" | "required";
	latency?: number;
}

export interface ResourceEvent {
	id: string;
	traceId?: string;
	timestamp: number;
	resourceType: string;
	resourceId: string;
	event: "created" | "updated" | "released" | "leaked" | "orphaned";
	data?: Record<string, unknown>;
	owner?: string;
	expectedLifetime?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// File Readers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read events from events.jsonl with proper typing.
 */
export function readTypedEvents(coordDir: string): ObservableEvent[] {
	const filePath = path.join(coordDir, "events.jsonl");
	if (!fs.existsSync(filePath)) return [];

	const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
	const events: ObservableEvent[] = [];

	for (const line of lines) {
		try {
			events.push(JSON.parse(line));
		} catch {
			// Skip malformed lines
		}
	}

	return events;
}

/**
 * Read spans from traces/spans.jsonl.
 */
export function readSpans(coordDir: string): Span[] {
	const filePath = path.join(coordDir, "traces", "spans.jsonl");
	if (!fs.existsSync(filePath)) return [];

	const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
	const spans: Span[] = [];

	for (const line of lines) {
		try {
			spans.push(JSON.parse(line));
		} catch {
			// Skip malformed lines
		}
	}

	return spans;
}

/**
 * Read decisions from decisions.jsonl.
 */
export function readDecisions(coordDir: string): Decision[] {
	const filePath = path.join(coordDir, "decisions.jsonl");
	if (!fs.existsSync(filePath)) return [];

	const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
	const decisions: Decision[] = [];

	for (const line of lines) {
		try {
			decisions.push(JSON.parse(line));
		} catch {
			// Skip malformed lines
		}
	}

	return decisions;
}

/**
 * Read causal links from causality.jsonl.
 */
export function readCausalLinks(coordDir: string): CausalLink[] {
	const filePath = path.join(coordDir, "causality.jsonl");
	if (!fs.existsSync(filePath)) return [];

	const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
	const links: CausalLink[] = [];

	for (const line of lines) {
		try {
			links.push(JSON.parse(line));
		} catch {
			// Skip malformed lines
		}
	}

	return links;
}

/**
 * Read resource events from resources.jsonl.
 */
export function readResources(coordDir: string): ResourceEvent[] {
	const filePath = path.join(coordDir, "resources.jsonl");
	if (!fs.existsSync(filePath)) return [];

	const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
	const resources: ResourceEvent[] = [];

	for (const line of lines) {
		try {
			resources.push(JSON.parse(line));
		} catch {
			// Skip malformed lines
		}
	}

	return resources;
}

// ─────────────────────────────────────────────────────────────────────────────
// Event Finders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find an event by type, returning properly typed result.
 */
export function findEvent<T extends ObservableEvent>(
	events: ObservableEvent[],
	type: string
): T | undefined {
	return events.find(e => e.type === type) as T | undefined;
}

/**
 * Find all events of a specific type.
 */
export function findAllEvents<T extends ObservableEvent>(
	events: ObservableEvent[],
	type: string
): T[] {
	return events.filter(e => e.type === type) as T[];
}

/**
 * Find events matching a predicate.
 */
export function findEventsWhere<T extends ObservableEvent>(
	events: ObservableEvent[],
	predicate: (event: ObservableEvent) => boolean
): T[] {
	return events.filter(predicate) as T[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Assertions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Assert that events occur in a specific sequence.
 */
export function assertEventSequence(
	events: ObservableEvent[],
	expectedTypes: string[],
	options: { strict?: boolean } = {}
): void {
	const { strict = false } = options;
	const actualTypes = events.map(e => e.type);

	if (strict) {
		// Strict: exact sequence match
		if (actualTypes.length !== expectedTypes.length) {
			throw new Error(
				`Event count mismatch: expected ${expectedTypes.length}, got ${actualTypes.length}\n` +
				`Expected: ${expectedTypes.join(" → ")}\n` +
				`Actual: ${actualTypes.join(" → ")}`
			);
		}

		for (let i = 0; i < expectedTypes.length; i++) {
			if (actualTypes[i] !== expectedTypes[i]) {
				throw new Error(
					`Event mismatch at position ${i}: expected "${expectedTypes[i]}", got "${actualTypes[i]}"\n` +
					`Expected: ${expectedTypes.join(" → ")}\n` +
					`Actual: ${actualTypes.join(" → ")}`
				);
			}
		}
	} else {
		// Non-strict: subsequence match (events in order, but other events allowed between)
		let expectedIndex = 0;

		for (const actual of actualTypes) {
			if (expectedIndex < expectedTypes.length && actual === expectedTypes[expectedIndex]) {
				expectedIndex++;
			}
		}

		if (expectedIndex !== expectedTypes.length) {
			throw new Error(
				`Event sequence not found. Expected: ${expectedTypes.join(" → ")}\n` +
				`Actual events: ${actualTypes.join(" → ")}\n` +
				`Missing from position ${expectedIndex}: ${expectedTypes.slice(expectedIndex).join(" → ")}`
			);
		}
	}
}

/**
 * Assert that an event exists with specific properties.
 */
export function assertEventExists(
	events: ObservableEvent[],
	type: string,
	properties?: Partial<ObservableEvent>
): void {
	const matches = events.filter(e => {
		if (e.type !== type) return false;
		if (!properties) return true;

		for (const [key, value] of Object.entries(properties)) {
			if (e[key] !== value) return false;
		}
		return true;
	});

	if (matches.length === 0) {
		const propsStr = properties ? ` with ${JSON.stringify(properties)}` : "";
		throw new Error(
			`No event of type "${type}"${propsStr} found.\n` +
			`Available events: ${events.map(e => e.type).join(", ")}`
		);
	}
}

/**
 * Assert that no event of a type exists.
 */
export function assertNoEvent(events: ObservableEvent[], type: string): void {
	const found = events.find(e => e.type === type);
	if (found) {
		throw new Error(`Unexpected event of type "${type}" found: ${JSON.stringify(found)}`);
	}
}

/**
 * Assert span hierarchy is correct.
 */
export function assertSpanHierarchy(spans: Span[], expectedHierarchy: {
	root: string;
	children?: Record<string, { children?: Record<string, unknown> }>;
}): void {
	// Find root span
	const rootSpan = spans.find(s => s.name === expectedHierarchy.root && !s.parentId);
	if (!rootSpan) {
		throw new Error(`Root span "${expectedHierarchy.root}" not found`);
	}

	// Verify children
	if (expectedHierarchy.children) {
		for (const childName of Object.keys(expectedHierarchy.children)) {
			const childSpan = spans.find(s => s.name === childName && s.parentId === rootSpan.id);
			if (!childSpan) {
				throw new Error(`Child span "${childName}" under "${expectedHierarchy.root}" not found`);
			}
		}
	}
}

/**
 * Assert that a decision was logged.
 */
export function assertDecisionLogged(
	decisions: Decision[],
	type: string,
	properties?: Partial<Decision>
): void {
	const matches = decisions.filter(d => {
		if (d.type !== type) return false;
		if (!properties) return true;

		for (const [key, value] of Object.entries(properties)) {
			if (key === "context") {
				// Deep compare context
				const contextMatch = Object.entries(value as Record<string, unknown>).every(
					([k, v]) => (d.context as Record<string, unknown>)[k] === v
				);
				if (!contextMatch) return false;
			} else if ((d as any)[key] !== value) {
				return false;
			}
		}
		return true;
	});

	if (matches.length === 0) {
		throw new Error(
			`No decision of type "${type}" found.\n` +
			`Available decisions: ${decisions.map(d => d.type).join(", ")}`
		);
	}
}

/**
 * Assert no resource leaks (all created resources were released).
 */
export function assertNoResourceLeaks(resources: ResourceEvent[]): void {
	const created = new Map<string, ResourceEvent>();

	for (const event of resources) {
		const key = `${event.resourceType}:${event.resourceId}`;
		
		if (event.event === "created") {
			created.set(key, event);
		} else if (event.event === "released") {
			created.delete(key);
		} else if (event.event === "leaked" || event.event === "orphaned") {
			// Explicitly marked as leaked - keep in set
		}
	}

	if (created.size > 0) {
		const leaks = Array.from(created.values()).map(
			r => `${r.resourceType}:${r.resourceId} (owner: ${r.owner || "unknown"})`
		);
		throw new Error(`Resource leaks detected:\n${leaks.join("\n")}`);
	}
}

/**
 * Assert causal link exists between events.
 */
export function assertCausalLink(
	links: CausalLink[],
	causeType: string,
	effectType: string,
	relationship?: string
): void {
	const match = links.find(l => 
		l.cause.type === causeType &&
		l.effect.type === effectType &&
		(!relationship || l.relationship === relationship)
	);

	if (!match) {
		throw new Error(
			`No causal link from "${causeType}" to "${effectType}"` +
			(relationship ? ` with relationship "${relationship}"` : "") +
			` found.`
		);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get events between two timestamps.
 */
export function getEventsBetween(
	events: ObservableEvent[],
	startTime: number,
	endTime: number
): ObservableEvent[] {
	return events.filter(e => e.timestamp >= startTime && e.timestamp <= endTime);
}

/**
 * Get the duration between first and last event.
 */
export function getTotalDuration(events: ObservableEvent[]): number {
	if (events.length < 2) return 0;
	
	const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
	return sorted[sorted.length - 1].timestamp - sorted[0].timestamp;
}

/**
 * Count events by type.
 */
export function countEventsByType(events: ObservableEvent[]): Record<string, number> {
	const counts: Record<string, number> = {};
	
	for (const event of events) {
		counts[event.type] = (counts[event.type] || 0) + 1;
	}
	
	return counts;
}

/**
 * Get all worker events for a specific worker.
 */
export function getWorkerEvents(events: ObservableEvent[], workerId: string): ObservableEvent[] {
	return events.filter(e => e.workerId === workerId);
}

/**
 * Get all task events for a specific task.
 */
export function getTaskEvents(events: ObservableEvent[], taskId: string): ObservableEvent[] {
	return events.filter(e => e.taskId === taskId);
}
