/**
 * Coordinator Context Persistence
 *
 * Maintains a persistent context file for the coordinator that tracks:
 * - Session configuration and status
 * - Assignment history (which tasks went to which workers)
 * - Worker performance metrics (success rate, avg duration)
 * - Failure patterns (repeated failures, common issues)
 * - Adaptations made during execution
 * - Escalation Q&A history
 * - Conflict resolutions
 * - Strategy decisions
 * - Continuation notes for reference
 *
 * The coordinator can read this file directly via the `read` tool to
 * understand session history and make informed decisions.
 *
 * @module
 */

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Assignment record for tracking task-worker mappings.
 */
export interface AssignmentRecord {
	taskId: string;
	workerId: string;
	workerIdentity: string;
	attempt: number;
	assignedAt: number;
	completedAt?: number;
	outcome: "pending" | "success" | "failed" | "restarted";
	durationMs?: number;
	notes?: string;
}

/**
 * Worker performance metrics.
 */
export interface WorkerPerformance {
	workerId: string;
	identity: string;
	tasksCompleted: number;
	tasksFailed: number;
	totalDurationMs: number;
	avgDurationMs: number;
	successRate: number;
}

/**
 * Failure pattern detection.
 */
export interface FailurePattern {
	taskId: string;
	failureCount: number;
	commonErrors: string[];
	lastFailure: number;
	recommendation?: string;
}

/**
 * Adaptation made during execution.
 */
export interface Adaptation {
	timestamp: number;
	type: "priority_change" | "reassignment" | "skip" | "retry_strategy" | "other";
	description: string;
	reason: string;
	affectedTasks: string[];
}

/**
 * Escalation record.
 */
export interface EscalationRecord {
	id: string;
	timestamp: number;
	question: string;
	options: string[];
	choice: string;
	wasTimeout: boolean;
	context?: string;
}

/**
 * Conflict resolution record.
 */
export interface ConflictRecord {
	timestamp: number;
	type: "file" | "dependency" | "resource";
	parties: string[];
	resolution: string;
	outcome: string;
}

/**
 * Full coordinator context.
 */
export interface CoordinatorContext {
	// Session info
	sessionId: string;
	planPath: string;
	startedAt: number;
	status: "running" | "complete" | "failed" | "aborted";

	// Configuration
	config: {
		maxWorkers?: number;
		costLimit?: number;
		maxFixCycles?: number;
		supervisorEnabled?: boolean;
	};

	// History
	assignments: AssignmentRecord[];
	workerPerformance: Map<string, WorkerPerformance>;
	failurePatterns: FailurePattern[];
	adaptations: Adaptation[];
	escalations: EscalationRecord[];
	conflicts: ConflictRecord[];

	// Current strategy
	strategy: {
		currentPhase: string;
		pendingDecisions: string[];
		blockedTasks: string[];
		notes: string[];
	};

	// Continuation notes
	continuationNotes: string[];

	// Metadata
	updatedAt: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Context Path Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get the path to coordinator-context.md.
 */
export function getCoordinatorContextPath(coordDir: string): string {
	return path.join(coordDir, "coordinator-context.md");
}

// ─────────────────────────────────────────────────────────────────────────────
// Context Creation and Loading
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a fresh coordinator context.
 */
export function createCoordinatorContext(
	sessionId: string,
	planPath: string,
	config: CoordinatorContext["config"] = {},
): CoordinatorContext {
	return {
		sessionId,
		planPath,
		startedAt: Date.now(),
		status: "running",
		config,
		assignments: [],
		workerPerformance: new Map(),
		failurePatterns: [],
		adaptations: [],
		escalations: [],
		conflicts: [],
		strategy: {
			currentPhase: "initializing",
			pendingDecisions: [],
			blockedTasks: [],
			notes: [],
		},
		continuationNotes: [],
		updatedAt: Date.now(),
	};
}

/**
 * Load coordinator context from disk.
 */
export async function loadCoordinatorContext(
	coordDir: string,
): Promise<CoordinatorContext | null> {
	const contextPath = getCoordinatorContextPath(coordDir);
	const jsonPath = path.join(coordDir, "coordinator-context.json");

	try {
		// Try JSON first (more reliable for parsing)
		const content = await fs.readFile(jsonPath, "utf-8");
		const parsed = JSON.parse(content);
		// Convert workerPerformance back to Map
		parsed.workerPerformance = new Map(
			Object.entries(parsed.workerPerformance || {}),
		);
		return parsed;
	} catch {
		return null;
	}
}

/**
 * Save coordinator context to disk.
 */
export async function saveCoordinatorContext(
	coordDir: string,
	context: CoordinatorContext,
): Promise<void> {
	context.updatedAt = Date.now();

	// Save as JSON for reliable parsing
	const jsonPath = path.join(coordDir, "coordinator-context.json");
	const jsonContent = JSON.stringify(
		{
			...context,
			workerPerformance: Object.fromEntries(context.workerPerformance),
		},
		null,
		2,
	);
	await fs.writeFile(jsonPath, jsonContent, "utf-8");

	// Also save as markdown for human readability
	const mdPath = getCoordinatorContextPath(coordDir);
	await fs.writeFile(mdPath, renderCoordinatorContextMd(context), "utf-8");
}

/**
 * Save coordinator context synchronously.
 */
export function saveCoordinatorContextSync(
	coordDir: string,
	context: CoordinatorContext,
): void {
	context.updatedAt = Date.now();

	const jsonPath = path.join(coordDir, "coordinator-context.json");
	const jsonContent = JSON.stringify(
		{
			...context,
			workerPerformance: Object.fromEntries(context.workerPerformance),
		},
		null,
		2,
	);
	fsSync.writeFileSync(jsonPath, jsonContent, "utf-8");

	const mdPath = getCoordinatorContextPath(coordDir);
	fsSync.writeFileSync(mdPath, renderCoordinatorContextMd(context), "utf-8");
}

// ─────────────────────────────────────────────────────────────────────────────
// Context Updates
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Record a task assignment.
 */
export function recordAssignment(
	context: CoordinatorContext,
	taskId: string,
	workerId: string,
	workerIdentity: string,
	attempt: number,
): void {
	context.assignments.push({
		taskId,
		workerId,
		workerIdentity,
		attempt,
		assignedAt: Date.now(),
		outcome: "pending",
	});
}

/**
 * Update an assignment outcome.
 */
export function updateAssignmentOutcome(
	context: CoordinatorContext,
	taskId: string,
	outcome: "success" | "failed" | "restarted",
	notes?: string,
): void {
	const assignment = context.assignments
		.slice()
		.reverse()
		.find((a) => a.taskId === taskId && a.outcome === "pending");

	if (assignment) {
		assignment.outcome = outcome;
		assignment.completedAt = Date.now();
		assignment.durationMs = Date.now() - assignment.assignedAt;
		if (notes) {
			assignment.notes = notes;
		}

		// Update worker performance
		updateWorkerPerformance(context, assignment);

		// Update failure patterns if failed
		if (outcome === "failed" || outcome === "restarted") {
			updateFailurePattern(context, taskId, notes);
		}
	}
}

/**
 * Update worker performance metrics.
 */
function updateWorkerPerformance(
	context: CoordinatorContext,
	assignment: AssignmentRecord,
): void {
	const key = assignment.workerIdentity;
	let perf = context.workerPerformance.get(key);

	if (!perf) {
		perf = {
			workerId: assignment.workerId,
			identity: assignment.workerIdentity,
			tasksCompleted: 0,
			tasksFailed: 0,
			totalDurationMs: 0,
			avgDurationMs: 0,
			successRate: 0,
		};
		context.workerPerformance.set(key, perf);
	}

	if (assignment.outcome === "success") {
		perf.tasksCompleted++;
	} else if (assignment.outcome === "failed") {
		perf.tasksFailed++;
	}
	// Note: "restarted" doesn't count as completed or failed - it's an intermediate state

	if (assignment.durationMs) {
		perf.totalDurationMs += assignment.durationMs;
	}

	// Calculate averages only when we have completed/failed tasks (avoid division by zero)
	const totalTasks = perf.tasksCompleted + perf.tasksFailed;
	if (totalTasks > 0) {
		perf.avgDurationMs = Math.round(perf.totalDurationMs / totalTasks);
		perf.successRate = perf.tasksCompleted / totalTasks;
	}
}

/**
 * Update failure patterns.
 */
function updateFailurePattern(
	context: CoordinatorContext,
	taskId: string,
	errorNote?: string,
): void {
	let pattern = context.failurePatterns.find((p) => p.taskId === taskId);

	if (!pattern) {
		pattern = {
			taskId,
			failureCount: 0,
			commonErrors: [],
			lastFailure: Date.now(),
		};
		context.failurePatterns.push(pattern);
	}

	pattern.failureCount++;
	pattern.lastFailure = Date.now();

	if (errorNote && !pattern.commonErrors.includes(errorNote)) {
		pattern.commonErrors.push(errorNote);
		if (pattern.commonErrors.length > 5) {
			pattern.commonErrors = pattern.commonErrors.slice(-5);
		}
	}

	// Generate recommendation for repeated failures
	if (pattern.failureCount >= 2) {
		pattern.recommendation = generateFailureRecommendation(pattern);
	}
}

function generateFailureRecommendation(pattern: FailurePattern): string {
	if (pattern.failureCount >= 3) {
		return `Consider breaking down ${pattern.taskId} into smaller subtasks`;
	}
	if (pattern.commonErrors.some((e) => e.includes("timeout"))) {
		return `${pattern.taskId} may need longer timeout or simpler scope`;
	}
	if (pattern.commonErrors.some((e) => e.includes("memory"))) {
		return `${pattern.taskId} may need memory optimization`;
	}
	return `Review ${pattern.taskId} for systematic issues`;
}

/**
 * Record an adaptation.
 */
export function recordAdaptation(
	context: CoordinatorContext,
	type: Adaptation["type"],
	description: string,
	reason: string,
	affectedTasks: string[],
): void {
	context.adaptations.push({
		timestamp: Date.now(),
		type,
		description,
		reason,
		affectedTasks,
	});
}

/**
 * Record an escalation.
 */
export function recordEscalation(
	context: CoordinatorContext,
	id: string,
	question: string,
	options: string[],
	choice: string,
	wasTimeout: boolean,
	contextNote?: string,
): void {
	context.escalations.push({
		id,
		timestamp: Date.now(),
		question,
		options,
		choice,
		wasTimeout,
		context: contextNote,
	});
}

/**
 * Record a conflict resolution.
 */
export function recordConflict(
	context: CoordinatorContext,
	type: ConflictRecord["type"],
	parties: string[],
	resolution: string,
	outcome: string,
): void {
	context.conflicts.push({
		timestamp: Date.now(),
		type,
		parties,
		resolution,
		outcome,
	});
}

/**
 * Update strategy notes.
 */
export function updateStrategy(
	context: CoordinatorContext,
	updates: Partial<CoordinatorContext["strategy"]>,
): void {
	Object.assign(context.strategy, updates);
}

/**
 * Add a continuation note.
 */
export function addContinuationNote(
	context: CoordinatorContext,
	note: string,
): void {
	if (!context.continuationNotes.includes(note)) {
		context.continuationNotes.push(note);
	}
}

/**
 * Generate continuation notes from observed patterns.
 */
export function generateContinuationNotes(
	context: CoordinatorContext,
): string[] {
	const notes: string[] = [];

	// Note failure patterns
	for (const pattern of context.failurePatterns) {
		if (pattern.failureCount >= 2 && pattern.recommendation) {
			notes.push(pattern.recommendation);
		}
	}

	// Note worker performance issues
	for (const [, perf] of context.workerPerformance) {
		if (perf.successRate < 0.5 && perf.tasksCompleted + perf.tasksFailed >= 2) {
			notes.push(
				`Worker ${perf.identity} has low success rate (${(perf.successRate * 100).toFixed(0)}%)`,
			);
		}
	}

	// Note unresolved escalations
	const recentEscalations = context.escalations.filter(
		(e) => Date.now() - e.timestamp < 3600000,
	);
	if (recentEscalations.length > 0) {
		notes.push(
			`${recentEscalations.length} escalation(s) in the last hour - review user feedback`,
		);
	}

	return notes;
}

// ─────────────────────────────────────────────────────────────────────────────
// Markdown Rendering
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render coordinator context to markdown.
 */
export function renderCoordinatorContextMd(context: CoordinatorContext): string {
	const lines: string[] = [];

	// Header
	lines.push("# Coordinator Context");
	lines.push("");
	lines.push(`**Session:** ${context.sessionId}`);
	lines.push(`**Plan:** ${context.planPath}`);
	lines.push(`**Status:** ${context.status}`);
	lines.push(`**Started:** ${new Date(context.startedAt).toISOString()}`);
	lines.push("");

	// Configuration
	if (Object.keys(context.config).length > 0) {
		lines.push("## Configuration");
		for (const [key, value] of Object.entries(context.config)) {
			lines.push(`- **${key}:** ${value}`);
		}
		lines.push("");
	}

	// Current Strategy
	lines.push("## Current Strategy");
	lines.push(`**Phase:** ${context.strategy.currentPhase}`);
	if (context.strategy.blockedTasks.length > 0) {
		lines.push(
			`**Blocked Tasks:** ${context.strategy.blockedTasks.join(", ")}`,
		);
	}
	if (context.strategy.pendingDecisions.length > 0) {
		lines.push("**Pending Decisions:**");
		for (const decision of context.strategy.pendingDecisions) {
			lines.push(`- ${decision}`);
		}
	}
	if (context.strategy.notes.length > 0) {
		lines.push("**Notes:**");
		for (const note of context.strategy.notes) {
			lines.push(`- ${note}`);
		}
	}
	lines.push("");

	// Assignment History (last 10)
	if (context.assignments.length > 0) {
		lines.push("## Recent Assignments");
		lines.push("| Task | Worker | Attempt | Outcome | Duration |");
		lines.push("|------|--------|---------|---------|----------|");
		const recent = context.assignments.slice(-10);
		for (const a of recent) {
			const duration = a.durationMs ? `${(a.durationMs / 1000).toFixed(1)}s` : "-";
			const worker = a.workerIdentity.slice(0, 20);
			lines.push(
				`| ${a.taskId} | ${worker} | ${a.attempt} | ${a.outcome} | ${duration} |`,
			);
		}
		lines.push("");
	}

	// Worker Performance
	if (context.workerPerformance.size > 0) {
		lines.push("## Worker Performance");
		lines.push("| Worker | Completed | Failed | Success Rate | Avg Duration |");
		lines.push("|--------|-----------|--------|--------------|--------------|");
		for (const [, perf] of context.workerPerformance) {
			const rate = `${(perf.successRate * 100).toFixed(0)}%`;
			const avg = `${(perf.avgDurationMs / 1000).toFixed(1)}s`;
			lines.push(
				`| ${perf.identity.slice(0, 20)} | ${perf.tasksCompleted} | ${perf.tasksFailed} | ${rate} | ${avg} |`,
			);
		}
		lines.push("");
	}

	// Failure Patterns
	if (context.failurePatterns.length > 0) {
		lines.push("## Failure Patterns");
		for (const pattern of context.failurePatterns) {
			lines.push(`### ${pattern.taskId} (${pattern.failureCount} failures)`);
			if (pattern.commonErrors.length > 0) {
				lines.push("**Common Errors:**");
				for (const err of pattern.commonErrors.slice(0, 3)) {
					lines.push(`- ${err}`);
				}
			}
			if (pattern.recommendation) {
				lines.push(`**Recommendation:** ${pattern.recommendation}`);
			}
			lines.push("");
		}
	}

	// Adaptations
	if (context.adaptations.length > 0) {
		lines.push("## Adaptations");
		for (const a of context.adaptations.slice(-5)) {
			const time = new Date(a.timestamp).toISOString().slice(11, 19);
			lines.push(`- [${time}] **${a.type}**: ${a.description}`);
			lines.push(`  - Reason: ${a.reason}`);
			if (a.affectedTasks.length > 0) {
				lines.push(`  - Affected: ${a.affectedTasks.join(", ")}`);
			}
		}
		lines.push("");
	}

	// Escalations
	if (context.escalations.length > 0) {
		lines.push("## Escalations");
		for (const e of context.escalations.slice(-5)) {
			const time = new Date(e.timestamp).toISOString().slice(11, 19);
			const timeout = e.wasTimeout ? " (timeout)" : "";
			lines.push(`- [${time}] **Q:** ${e.question}`);
			lines.push(`  - **A:** ${e.choice}${timeout}`);
		}
		lines.push("");
	}

	// Conflicts
	if (context.conflicts.length > 0) {
		lines.push("## Conflicts");
		for (const c of context.conflicts.slice(-5)) {
			const time = new Date(c.timestamp).toISOString().slice(11, 19);
			lines.push(`- [${time}] **${c.type}** between ${c.parties.join(" & ")}`);
			lines.push(`  - Resolution: ${c.resolution}`);
			lines.push(`  - Outcome: ${c.outcome}`);
		}
		lines.push("");
	}

	// Continuation Notes
	if (context.continuationNotes.length > 0) {
		lines.push("## Continuation Notes");
		for (const note of context.continuationNotes) {
			lines.push(`- ${note}`);
		}
		lines.push("");
	}

	lines.push("---");
	lines.push(`*Last updated: ${new Date(context.updatedAt).toISOString()}*`);

	return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-Session Pattern Export/Import
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Portable patterns format for carry-over between sessions.
 */
export interface PortablePatterns {
	version: "1.0";
	exportedAt: number;
	source: {
		sessionId: string;
		planPath: string;
	};
	patterns: {
		workerPerformance: Array<{
			identityPattern: string;
			successRate: number;
			avgDurationMs: number;
			notes: string[];
		}>;
		failurePatterns: Array<{
			taskPattern: string;
			commonErrors: string[];
			recommendations: string[];
		}>;
		adaptations: string[];
		escalationLearnings: string[];
	};
}

/**
 * Export patterns from a session for carry-over.
 */
export function exportPatterns(context: CoordinatorContext): PortablePatterns {
	return {
		version: "1.0",
		exportedAt: Date.now(),
		source: {
			sessionId: context.sessionId,
			planPath: context.planPath,
		},
		patterns: {
			workerPerformance: Array.from(context.workerPerformance.values())
				.filter((p) => p.tasksCompleted + p.tasksFailed >= 2)
				.map((p) => ({
					identityPattern: extractIdentityPattern(p.identity),
					successRate: p.successRate,
					avgDurationMs: p.avgDurationMs,
					notes:
						p.successRate < 0.7
							? [`Low success rate: ${(p.successRate * 100).toFixed(0)}%`]
							: [],
				})),
			failurePatterns: context.failurePatterns
				.filter((p) => p.failureCount >= 2)
				.map((p) => ({
					taskPattern: extractTaskPattern(p.taskId),
					commonErrors: p.commonErrors.slice(0, 3),
					recommendations: p.recommendation ? [p.recommendation] : [],
				})),
			adaptations: context.adaptations.slice(-5).map((a) => a.description),
			escalationLearnings: context.escalations
				.filter((e) => !e.wasTimeout)
				.slice(-5)
				.map((e) => `${e.question} → ${e.choice}`),
		},
	};
}

/**
 * Import patterns from a previous session.
 */
export function importPatterns(
	context: CoordinatorContext,
	patterns: PortablePatterns,
): void {
	// Add continuation notes from imported patterns
	for (const wp of patterns.patterns.workerPerformance) {
		for (const note of wp.notes) {
			addContinuationNote(context, `[Previous] ${note}`);
		}
	}

	for (const fp of patterns.patterns.failurePatterns) {
		for (const rec of fp.recommendations) {
			addContinuationNote(context, `[Previous] ${rec}`);
		}
	}

	for (const adaptation of patterns.patterns.adaptations) {
		addContinuationNote(context, `[Previous adaptation] ${adaptation}`);
	}

	for (const learning of patterns.patterns.escalationLearnings) {
		addContinuationNote(context, `[Previous escalation] ${learning}`);
	}
}

function extractIdentityPattern(identity: string): string {
	// Extract agent type from identity like "worker:auth-a1b2" → "auth"
	const match = identity.match(/worker:([^-]+)/);
	return match ? match[1] : identity;
}

function extractTaskPattern(taskId: string): string {
	// Extract task type from ID like "TASK-01" → "TASK"
	return taskId.replace(/-\d+.*$/, "");
}
