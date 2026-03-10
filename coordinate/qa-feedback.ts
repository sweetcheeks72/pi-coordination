/**
 * QA Feedback Loop for pi-coordination.
 *
 * Records deployment failures from human QA, staging, or automated tests
 * and feeds them forward to future coordination sessions touching the same files.
 * Workers see "Known QA Issues" in their task prompts and the system auto-resolves
 * failures when a new session successfully fixes the affected files.
 *
 * Storage: ~/.pi/qa-failures.json (simple JSON, no Memgraph dependency)
 */

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface QAFailure {
	id: string;
	sessionId: string;
	reportedAt: string;
	reportedBy: "human-qa" | "automated-test" | "staging";
	severity: "critical" | "major" | "minor";
	title: string;
	description: string;
	filesAffected: string[];
	taskIds: string[];
	resolved: boolean;
	resolvedAt?: string;
	resolvedInSession?: string;
}

interface QAStore {
	failures: QAFailure[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Storage helpers
// ─────────────────────────────────────────────────────────────────────────────

function getQAStorePath(): string {
	return process.env.QA_STORE_PATH || path.join(os.homedir(), ".pi", "qa-failures.json");
}

async function readStore(): Promise<QAStore> {
	const storePath = getQAStorePath();
	try {
		const raw = await fs.readFile(storePath, "utf-8");
		const parsed = JSON.parse(raw) as QAStore;
		if (!Array.isArray(parsed.failures)) {
			return { failures: [] };
		}
		return parsed;
	} catch {
		return { failures: [] };
	}
}

async function writeStore(store: QAStore): Promise<void> {
	const storePath = getQAStorePath();
	await fs.mkdir(path.dirname(storePath), { recursive: true });
	await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Record a new QA failure. Returns the generated UUID for the failure.
 */
export async function recordQAFailure(
	failure: Omit<QAFailure, "id" | "reportedAt" | "resolved">,
): Promise<string> {
	const store = await readStore();
	const id = randomUUID();
	const entry: QAFailure = {
		...failure,
		id,
		reportedAt: new Date().toISOString(),
		resolved: false,
	};
	store.failures.push(entry);
	await writeStore(store);
	return id;
}

/**
 * Get all unresolved QA failures that affect any of the given files.
 * Matching is done on exact path or basename for flexibility.
 */
export async function getFailuresForFiles(files: string[]): Promise<QAFailure[]> {
	if (files.length === 0) return [];
	const store = await readStore();
	const normalizedFiles = new Set(files.map(f => path.normalize(f)));
	const baseNames = new Set(files.map(f => path.basename(f)));

	return store.failures.filter(failure => {
		if (failure.resolved) return false;
		return failure.filesAffected.some(affected => {
			const normalizedAffected = path.normalize(affected);
			return (
				normalizedFiles.has(normalizedAffected) ||
				baseNames.has(path.basename(affected)) ||
				// substring match for partial paths like "components/Button.tsx"
				files.some(f => f.endsWith(affected) || affected.endsWith(f))
			);
		});
	});
}

/**
 * Mark a failure as resolved after a new session fixes it.
 */
export async function resolveFailure(failureId: string, sessionId: string): Promise<void> {
	const store = await readStore();
	const failure = store.failures.find(f => f.id === failureId);
	if (!failure) {
		throw new Error(`QA failure not found: ${failureId}`);
	}
	failure.resolved = true;
	failure.resolvedAt = new Date().toISOString();
	failure.resolvedInSession = sessionId;
	await writeStore(store);
}

/**
 * Build a concise "Known QA Issues" prompt section for workers.
 * Returns an empty string if no failures are provided.
 */
export function buildFailureBrief(failures: QAFailure[]): string {
	if (failures.length === 0) return "";

	const lines: string[] = [
		"## ⚠️ Known QA Issues in Files You're Modifying",
		"",
		"Past deployments of code touching these files failed QA. Avoid repeating these:",
		"",
	];

	for (const failure of failures) {
		const date = new Date(failure.reportedAt).toISOString().slice(0, 10);
		const severity = failure.severity.toUpperCase();
		for (const file of failure.filesAffected) {
			lines.push(`- **${file}** — [${severity}] ${failure.title}: ${failure.description} (reported ${date})`);
		}
	}

	lines.push("");
	lines.push("Verify these are addressed before marking your task complete.");
	lines.push("");

	return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-resolve helpers (used by coordinate/index.ts after session completion)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * After a successful session, resolve any open failures whose files were modified.
 * Returns the IDs of failures that were resolved.
 */
export async function autoResolveFailuresForSession(
	filesModified: string[],
	sessionId: string,
): Promise<string[]> {
	if (filesModified.length === 0) return [];
	const failures = await getFailuresForFiles(filesModified);
	const resolved: string[] = [];
	for (const failure of failures) {
		try {
			await resolveFailure(failure.id, sessionId);
			resolved.push(failure.id);
		} catch {
			// Non-fatal: log and continue
		}
	}
	if (resolved.length > 0) {
		const titles = failures
			.filter(f => resolved.includes(f.id))
			.map(f => f.title.replace(/\s+/g, "-").toLowerCase().slice(0, 30))
			.join(", ");
		console.log(`[qa-loop] Auto-resolved ${resolved.length} failure${resolved.length === 1 ? "" : "s"}: ${titles}`);
	}
	return resolved;
}

/**
 * Enrich a task's description with QA failure brief if relevant files have known failures.
 * Returns the original description if no failures found.
 */
export async function enrichTaskWithQAFailures(
	description: string,
	files: string[],
): Promise<string> {
	if (files.length === 0) return description;
	try {
		const failures = await getFailuresForFiles(files);
		const brief = buildFailureBrief(failures);
		if (!brief) return description;
		return brief + description;
	} catch {
		// Non-fatal: return original description if QA lookup fails
		return description;
	}
}

/**
 * Get a summary of QA loop activity for a set of files (used in recap).
 */
export async function getQALoopSummary(
	files: string[],
	resolvedIds: string[],
): Promise<{
	checkedFiles: number;
	activeFailures: QAFailure[];
	resolvedThisSession: QAFailure[];
}> {
	const store = await readStore();
	const activeFailures = await getFailuresForFiles(files);
	const resolvedThisSession = store.failures.filter(f => resolvedIds.includes(f.id));
	return {
		checkedFiles: files.length,
		activeFailures,
		resolvedThisSession,
	};
}
