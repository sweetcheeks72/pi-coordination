/**
 * Lessons Loader for pi-coordination.
 *
 * Reads lessons mined by the sleep-time consolidation agent from
 * ~/.pi/session-memory/lessons.json and injects relevant lessons
 * into worker task prompts to improve coordination quality over time.
 *
 * Storage: ~/.pi/session-memory/lessons.json (written by consolidate-sessions.sh)
 */

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface Lesson {
	id: string;
	minedAt: string;
	sessionId?: string;
	type: "file_pattern" | "task_pattern" | "cost_pattern" | "qa_failure" | "general";
	/** Glob patterns or exact paths this lesson applies to. Empty = applies to all. */
	files: string[];
	/** Human-readable lesson text to inject into worker prompts. */
	lesson: string;
	/** Optional confidence score [0–1]. Higher = shown to more workers. */
	confidence?: number;
}

interface LessonsStore {
	version: number;
	lessons: Lesson[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Storage helpers
// ─────────────────────────────────────────────────────────────────────────────

function getLessonsPath(): string {
	return (
		process.env.LESSONS_STORE_PATH ||
		path.join(os.homedir(), ".pi", "session-memory", "lessons.json")
	);
}

function readLessonsSync(): LessonsStore {
	const storePath = getLessonsPath();
	try {
		const raw = fsSync.readFileSync(storePath, "utf-8");
		const parsed = JSON.parse(raw) as LessonsStore;
		if (!Array.isArray(parsed.lessons)) {
			return { version: 1, lessons: [] };
		}
		return parsed;
	} catch {
		return { version: 1, lessons: [] };
	}
}

async function readLessons(): Promise<LessonsStore> {
	const storePath = getLessonsPath();
	try {
		const raw = await fs.readFile(storePath, "utf-8");
		const parsed = JSON.parse(raw) as LessonsStore;
		if (!Array.isArray(parsed.lessons)) {
			return { version: 1, lessons: [] };
		}
		return parsed;
	} catch {
		return { version: 1, lessons: [] };
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Relevance matching
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Test whether a lesson applies to any of the given files in scope.
 * A lesson with an empty files array is considered globally relevant.
 */
function isRelevant(lesson: Lesson, filesInScope: string[]): boolean {
	// Global lessons (no file constraint) always match
	if (!lesson.files || lesson.files.length === 0) return true;

	// Skip very low-confidence lessons
	if (lesson.confidence !== undefined && lesson.confidence < 0.2) return false;

	const normalizedScope = filesInScope.map((f) => path.normalize(f));
	const baseNamesScope = new Set(filesInScope.map((f) => path.basename(f)));

	for (const pattern of lesson.files) {
		const normalizedPattern = path.normalize(pattern);

		// Exact match or suffix match
		if (
			normalizedScope.some(
				(f) =>
					f === normalizedPattern ||
					f.endsWith(normalizedPattern) ||
					normalizedPattern.endsWith(f),
			)
		) {
			return true;
		}

		// Basename match
		if (baseNamesScope.has(path.basename(pattern))) {
			return true;
		}

		// Simple glob: leading "**/" prefix match
		if (pattern.startsWith("**/")) {
			const suffix = pattern.slice(3);
			if (filesInScope.some((f) => f.endsWith(suffix))) return true;
		}

		// Directory prefix match (e.g. "src/auth")
		if (normalizedScope.some((f) => f.startsWith(normalizedPattern + path.sep))) {
			return true;
		}
	}

	return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Async version: load lessons relevant to the files in scope.
 *
 * @param filesInScope - List of file paths the current task will touch.
 * @returns Array of lesson strings for injection into worker prompts.
 */
export async function loadRelevantLessons(filesInScope: string[]): Promise<string[]> {
	const store = await readLessons();
	const relevant = store.lessons.filter((l) => isRelevant(l, filesInScope));
	return relevant.map((l) => l.lesson);
}

/**
 * Sync version (for use in synchronous prompt-building paths).
 */
export function loadRelevantLessonsSync(filesInScope: string[]): string[] {
	const store = readLessonsSync();
	const relevant = store.lessons.filter((l) => isRelevant(l, filesInScope));
	return relevant.map((l) => l.lesson);
}

/**
 * Build a markdown "Lessons from Past Sessions" section to inject into worker prompts.
 * Returns an empty string if no lessons are provided.
 */
export function buildLessonsSection(lessons: string[]): string {
	if (lessons.length === 0) return "";

	const lines: string[] = [
		"## 📚 Lessons from Past Sessions",
		"",
		"The following patterns were observed in past coordination sessions.",
		"Use them to avoid repeating known mistakes:",
		"",
	];

	for (const lesson of lessons) {
		lines.push(`- ${lesson}`);
	}

	lines.push("");
	lines.push(
		"Apply these lessons proactively — don't wait for a QA failure to discover them.",
	);
	lines.push("");

	return lines.join("\n");
}

/**
 * Convenience: load relevant lessons for a set of files and return the
 * formatted markdown section in one call.
 */
export async function buildLessonsSectionForFiles(filesInScope: string[]): Promise<string> {
	const lessons = await loadRelevantLessons(filesInScope);
	return buildLessonsSection(lessons);
}

/**
 * Sync convenience wrapper.
 */
export function buildLessonsSectionForFilesSync(filesInScope: string[]): string {
	const lessons = loadRelevantLessonsSync(filesInScope);
	return buildLessonsSection(lessons);
}
