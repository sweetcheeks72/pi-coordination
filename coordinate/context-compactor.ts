/**
 * Context Compactor — Anti-Drift Memory for pi-coordination
 *
 * Prevents "stochastic decay" — agents losing the thread as context grows.
 * At phase transitions, distills current session state into a compact
 * SessionDigest. Workers receive this digest instead of full history.
 *
 * Cross-session memory: digests are saved to ~/.pi/session-memory/{specHash}.json
 * so the next coordinate() run on the same spec starts with prior context.
 *
 * @module
 */

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compact representation of a completed task.
 */
export interface CompletedTask {
	taskId: string;
	title: string;
	filesModified: string[];
	summary?: string;
}

/**
 * Compact session digest capturing key decisions, state, and open questions.
 * Injected into worker prompts to prevent context drift across phase boundaries.
 */
export interface SessionDigest {
	sessionId: string;
	createdAt: string;
	phase: string;
	/** Key decisions taken so far (what was chosen and why) */
	decisionsMade: string[];
	/** Things workers MUST NOT do / MUST preserve */
	activeConstraints: string[];
	/** All files touched so far across all workers */
	filesModified: string[];
	/** Per-task summaries for completed work */
	completedTaskSummaries: Array<{
		taskId: string;
		summary: string;
		filesModified: string[];
	}>;
	/** Unresolved HANDRaiser items from the escalation queue */
	openQuestions: string[];
	/** SHA-256 (first 16 chars) of the spec content, for cross-session matching */
	specHash: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Path helpers
// ─────────────────────────────────────────────────────────────────────────────

function digestPath(coordDir: string): string {
	return path.join(coordDir, "session-digest.json");
}

function crossSessionDir(): string {
	return path.join(os.homedir(), ".pi", "session-memory");
}

function crossSessionPath(specHash: string): string {
	return path.join(crossSessionDir(), `${specHash}.json`);
}

function specHashFrom(content: string): string {
	return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// ─────────────────────────────────────────────────────────────────────────────
// Compaction helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Summarise a completed task to a single sentence.
 * Uses the task title and outcome if available, otherwise falls back to the taskId.
 */
function summariseTask(task: CompletedTask): string {
	const title = task.title || task.taskId;
	const files = task.filesModified.length;
	const fileNote = files > 0 ? ` (${files} file${files > 1 ? "s" : ""} modified)` : "";
	return task.summary || `Completed ${title}${fileNote}.`;
}

/**
 * Extract constraint phrases from spec content.
 * Looks for sentences containing "must", "do not", "preserve", "required", "forbidden".
 */
function extractConstraints(specContent: string): string[] {
	const constraints: string[] = [];
	const constraintKeywords = /\b(must|do not|don't|preserve|required|forbidden|never|always|prohibit)\b/i;

	const lines = specContent.split("\n");
	for (const line of lines) {
		const trimmed = line.trim();
		// Only consider lines that look like constraint prose (not headers, not empty)
		if (
			trimmed &&
			!trimmed.startsWith("#") &&
			!trimmed.startsWith("```") &&
			constraintKeywords.test(trimmed)
		) {
			// Clean markdown formatting
			const clean = trimmed.replace(/[*_`[\]()]/g, "").trim();
			if (clean.length > 10 && clean.length < 200) {
				constraints.push(clean);
			}
		}
	}

	// Deduplicate and cap
	return [...new Set(constraints)].slice(0, 10);
}

/**
 * Read open HANDRaiser questions from the escalations queue.
 * Returns unanswered question strings, capped at 5.
 */
async function readOpenQuestions(coordDir: string): Promise<string[]> {
	try {
		const eventsPath = path.join(coordDir, "events.jsonl");
		const raw = await fs.readFile(eventsPath, "utf-8");
		const questions: string[] = [];

		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			try {
				const event = JSON.parse(line);
				if (event.type === "agent_question" && !event.answered && event.question) {
					questions.push(event.question);
				}
			} catch {
				// Ignore malformed JSONL lines
			}
		}

		return [...new Set(questions)].slice(0, 5);
	} catch {
		return [];
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compact current session state into a SessionDigest.
 *
 * Called at phase transitions (e.g., after workers phase, before review).
 * The digest is saved to {coordDir}/session-digest.json and to
 * ~/.pi/session-memory/{specHash}.json for cross-session persistence.
 *
 * @param coordDir  - Coordination session directory
 * @param sessionId - Unique session identifier
 * @param completedTasks - Tasks completed so far
 * @param specContent - Raw spec file content (for constraint extraction + hashing)
 * @param phase - Current pipeline phase name (e.g., "workers")
 */
export async function compactSession(
	coordDir: string,
	sessionId: string,
	completedTasks: CompletedTask[],
	specContent: string,
	phase: string,
): Promise<SessionDigest> {
	const specHash = specHashFrom(specContent);

	// Summarise completed tasks
	const completedTaskSummaries = completedTasks.map((task) => ({
		taskId: task.taskId,
		summary: summariseTask(task),
		filesModified: task.filesModified,
	}));

	// Collect all modified files (deduplicated)
	const filesModified = [
		...new Set(completedTasks.flatMap((t) => t.filesModified)),
	].sort();

	// Extract constraints from spec
	const activeConstraints = extractConstraints(specContent);

	// Load any open HANDRaiser questions from escalations
	const openQuestions = await readOpenQuestions(coordDir);

	// Extract decisions from prior digest if available (preserve continuity)
	const priorDigest = await loadDigest(coordDir);
	const decisionsMade = priorDigest?.decisionsMade ?? [];

	const digest: SessionDigest = {
		sessionId,
		createdAt: new Date().toISOString(),
		phase,
		decisionsMade,
		activeConstraints,
		filesModified,
		completedTaskSummaries,
		openQuestions,
		specHash,
	};

	// Save locally
	await saveDigest(coordDir, digest);

	// Save cross-session memory
	await saveCrossSessionDigest(specHash, digest);

	return digest;
}

/**
 * Build a markdown context header block to prepend to a worker's task prompt.
 *
 * Example output:
 * ```
 * ## Session Context
 * > Phase: workers
 * > Files modified so far: 3
 * > Key decisions: ...
 * ```
 */
export function buildWorkerContextHeader(digest: SessionDigest): string {
	const lines: string[] = ["## Session Context"];

	lines.push(`> **Phase:** ${digest.phase}`);
	lines.push(`> **Session:** ${digest.sessionId}`);
	lines.push(`> **Last updated:** ${digest.createdAt}`);
	lines.push("");

	if (digest.filesModified.length > 0) {
		lines.push(`> **Files modified so far (${digest.filesModified.length}):**`);
		for (const f of digest.filesModified.slice(0, 20)) {
			lines.push(`> - \`${f}\``);
		}
		if (digest.filesModified.length > 20) {
			lines.push(`> - ... and ${digest.filesModified.length - 20} more`);
		}
		lines.push("");
	}

	if (digest.completedTaskSummaries.length > 0) {
		lines.push("> **Completed tasks:**");
		for (const t of digest.completedTaskSummaries) {
			lines.push(`> - **${t.taskId}**: ${t.summary}`);
		}
		lines.push("");
	}

	if (digest.decisionsMade.length > 0) {
		lines.push("> **Key decisions made:**");
		for (const d of digest.decisionsMade) {
			lines.push(`> - ${d}`);
		}
		lines.push("");
	}

	if (digest.activeConstraints.length > 0) {
		lines.push("> **Active constraints (MUST follow):**");
		for (const c of digest.activeConstraints) {
			lines.push(`> - ${c}`);
		}
		lines.push("");
	}

	if (digest.openQuestions.length > 0) {
		lines.push("> **Open questions (unresolved):**");
		for (const q of digest.openQuestions) {
			lines.push(`> - ${q}`);
		}
		lines.push("");
	}

	lines.push("---");
	lines.push("");

	return lines.join("\n");
}

/**
 * Save a digest to {coordDir}/session-digest.json.
 */
export async function saveDigest(
	coordDir: string,
	digest: SessionDigest,
): Promise<void> {
	await fs.mkdir(coordDir, { recursive: true });
	await fs.writeFile(digestPath(coordDir), JSON.stringify(digest, null, 2), "utf-8");
}

/**
 * Load a digest from {coordDir}/session-digest.json.
 * Returns null if the file does not exist or is malformed.
 */
export async function loadDigest(coordDir: string): Promise<SessionDigest | null> {
	try {
		const raw = await fs.readFile(digestPath(coordDir), "utf-8");
		return JSON.parse(raw) as SessionDigest;
	} catch {
		return null;
	}
}

/**
 * Save digest to cross-session memory (~/.pi/session-memory/{specHash}.json).
 */
export async function saveCrossSessionDigest(
	specHash: string,
	digest: SessionDigest,
): Promise<void> {
	try {
		const dir = crossSessionDir();
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(crossSessionPath(specHash), JSON.stringify(digest, null, 2), "utf-8");
	} catch {
		// Non-fatal: cross-session memory is a best-effort feature
	}
}

/**
 * Load a prior session digest from cross-session memory.
 * Returns null if no prior session exists for the given spec hash.
 */
export async function loadCrossSessionDigest(specHash: string): Promise<SessionDigest | null> {
	try {
		const raw = await fs.readFile(crossSessionPath(specHash), "utf-8");
		return JSON.parse(raw) as SessionDigest;
	} catch {
		return null;
	}
}

/**
 * Record a key decision into the digest (appends to decisionsMade list).
 * Useful for coordinator tools to annotate what was decided and why.
 */
export async function recordDecision(
	coordDir: string,
	decision: string,
): Promise<void> {
	const digest = await loadDigest(coordDir);
	if (!digest) return;

	if (!digest.decisionsMade.includes(decision)) {
		digest.decisionsMade.push(decision);
		await saveDigest(coordDir, digest);
		// Also update cross-session memory
		await saveCrossSessionDigest(digest.specHash, digest);
	}
}
