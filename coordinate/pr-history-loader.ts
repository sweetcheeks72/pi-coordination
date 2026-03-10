/**
 * PR History Loader for pi-coordination.
 *
 * Reads declined/closed PR data mined by ingest-pr-history.sh from
 * ~/.pi/pr-lessons.json and injects relevant PR review history into
 * worker task prompts to prevent repeating known mistakes.
 *
 * Storage: ~/.pi/pr-lessons.json (written by ingest-pr-history.sh)
 *
 * Pattern: mirrors lessons-loader.ts exactly — same relevance matching,
 * same sync/async API, same markdown injection format.
 */

import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface PRLesson {
	/** Unique ID: "{repo}#{prNumber}" */
	id: string;
	/** e.g. "Zimopia/talisman" */
	repo: string;
	prNumber: number;
	prTitle: string;
	closedAt: string;
	/** Why the PR was closed without merging */
	closeReason:
		| "changes-requested"
		| "superseded"
		| "too-many-commits"
		| "conflicts"
		| "stale"
		| "unknown";
	/** File paths touched by this PR */
	filesAffected: string[];
	/** Review comments (inline and general) */
	reviewComments: Array<{
		body: string;
		/** Specific file for inline comments */
		path?: string;
		author: string;
	}>;
	/** Extracted actionable lesson strings for injection */
	lessons: string[];
	/** PR number that fixed the issues from this PR (if found) */
	fixedInPR?: number;
	ingestedAt: string;
}

interface PRLessonsStore {
	version: number;
	ingestedAt: string | null;
	prs: PRLesson[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Storage helpers
// ─────────────────────────────────────────────────────────────────────────────

function getPRLessonsPath(): string {
	return (
		process.env.PR_LESSONS_STORE_PATH ||
		path.join(os.homedir(), ".pi", "pr-lessons.json")
	);
}

function readPRLessonsSync(): PRLessonsStore {
	const storePath = getPRLessonsPath();
	try {
		const raw = fsSync.readFileSync(storePath, "utf-8");
		const parsed = JSON.parse(raw) as PRLessonsStore;
		if (!Array.isArray(parsed.prs)) {
			return { version: 1, ingestedAt: null, prs: [] };
		}
		return parsed;
	} catch {
		return { version: 1, ingestedAt: null, prs: [] };
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Relevance matching
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Determine whether a PR lesson is relevant to any of the files in scope.
 *
 * Matching rules (same logic as lessons-loader.ts isRelevant):
 * - PRs with no filesAffected → always relevant (repo-level lessons)
 * - Exact path match
 * - Suffix/prefix path overlap
 * - Directory prefix match
 * - Basename match
 */
function isPRRelevant(pr: PRLesson, filesInScope: string[]): boolean {
	// Repo-level lessons (no file constraint) always match
	if (!pr.filesAffected || pr.filesAffected.length === 0) return true;

	// PRs with no lessons are not useful
	if (pr.lessons.length === 0 && pr.reviewComments.length === 0) return false;

	const normalizedScope = filesInScope.map((f) => path.normalize(f));
	const baseNamesScope = new Set(filesInScope.map((f) => path.basename(f)));

	for (const affected of pr.filesAffected) {
		const normalizedAffected = path.normalize(affected);

		// Exact match
		if (normalizedScope.includes(normalizedAffected)) return true;

		// Suffix match (e.g. stored as "src/auth.ts", scope has "coordinate/src/auth.ts")
		if (normalizedScope.some((f) => f.endsWith(normalizedAffected) || normalizedAffected.endsWith(f))) {
			return true;
		}

		// Basename match
		if (baseNamesScope.has(path.basename(affected))) return true;

		// Directory prefix match (e.g. PR touched "app/transactions/" and scope has files in it)
		const dir = normalizedAffected.endsWith(path.sep)
			? normalizedAffected
			: normalizedAffected + path.sep;
		if (normalizedScope.some((f) => f.startsWith(dir))) return true;

		// Reverse: scope file is parent directory of PR file
		for (const f of normalizedScope) {
			const fDir = f.endsWith(path.sep) ? f : f + path.sep;
			if (normalizedAffected.startsWith(fDir)) return true;
		}
	}

	return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lesson extraction
// ─────────────────────────────────────────────────────────────────────────────

const LESSON_PATTERNS: Array<{ pattern: RegExp; template: (match: string, pr: any) => string }> = [
	{
		pattern: /error.log|logging|log.*remov|remov.*log/i,
		template: (_, pr) => `Preserve error logging — reviewers flagged its removal (${pr.repo}#${pr.prNumber})`,
	},
	{
		pattern: /race condition|concurren|mutex|thread.safe|atomic/i,
		template: (_, pr) => `Watch for race conditions in concurrent code — flagged in ${pr.repo}#${pr.prNumber}`,
	},
	{
		pattern: /unrelated|separate pr|split this|mixed concern|focus.*pr|single concern/i,
		template: (_, pr) => `Keep PRs focused on a single concern — unrelated changes flagged in ${pr.repo}#${pr.prNumber}`,
	},
	{
		pattern: /test.missing|add.*test|no test|untested|coverage/i,
		template: (_, pr) => `Add tests for new behavior — missing tests flagged in ${pr.repo}#${pr.prNumber}`,
	},
	{
		pattern: /rebase|update.*main|behind.*main|out.*date|merge conflict/i,
		template: (_, pr) => `Keep branch up-to-date with main before submitting — ${pr.repo}#${pr.prNumber}`,
	},
	{
		pattern: /performance|slow|n\+1|expensive|query.*loop/i,
		template: (_, pr) => `Performance concern flagged in ${pr.repo}#${pr.prNumber}`,
	},
	{
		pattern: /security|injection|xss|csrf|sanitize|escape/i,
		template: (_, pr) => `Security concern flagged — review carefully (${pr.repo}#${pr.prNumber})`,
	},
	{
		pattern: /breaking change|backward compat|api change|schema change/i,
		template: (_, pr) => `Breaking change flagged in ${pr.repo}#${pr.prNumber} — ensure backward compatibility`,
	},
	{
		pattern: /type.*error|type.*wrong|incorrect.*type/i,
		template: (_, pr) => `TypeScript type errors were flagged in ${pr.repo}#${pr.prNumber}`,
	},
];

/**
 * Parse review comments and close reason into actionable lesson strings.
 * Called by the ingestion script (shell) and available for reuse in TypeScript.
 */
export function extractLessonsFromPR(pr: {
	repo: string;
	prNumber: number;
	prTitle: string;
	closeReason: string;
	reviewComments: Array<{ body: string; path?: string; author: string }>;
}): string[] {
	const lessons = new Set<string>();

	// Derive lessons from close reason
	switch (pr.closeReason) {
		case "changes-requested":
			lessons.add(
				`Changes were requested before this PR could merge — review feedback carefully [${pr.repo}#${pr.prNumber}]`,
			);
			break;
		case "superseded":
			lessons.add(
				`This PR was superseded/replaced — check for a follow-up PR [${pr.repo}#${pr.prNumber}]`,
			);
			break;
		case "too-many-commits":
			lessons.add(
				`PR "${pr.prTitle}" had too many unrelated commits — keep PRs focused on a single concern [${pr.repo}#${pr.prNumber}]`,
			);
			break;
		case "conflicts":
			lessons.add(
				`PR had merge conflicts — rebase and keep branch current before submitting [${pr.repo}#${pr.prNumber}]`,
			);
			break;
		case "stale":
			lessons.add(`PR went stale — ensure work is needed before starting [${pr.repo}#${pr.prNumber}]`);
			break;
	}

	// Derive lessons from review comments
	for (const comment of pr.reviewComments) {
		if (!comment.body || comment.body === "null") continue;

		const lower = comment.body.toLowerCase();
		let matched = false;

		for (const { pattern, template } of LESSON_PATTERNS) {
			if (pattern.test(lower)) {
				const lesson = template(lower, pr);
				lessons.add(lesson);
				matched = true;
				break; // One lesson per comment
			}
		}

		// Fallback: use first meaningful sentence (capped at 120 chars)
		if (!matched) {
			const firstLine = comment.body.split(/\n|\. /)[0]?.trim();
			if (firstLine && firstLine.length > 15) {
				const truncated =
					firstLine.length > 120 ? firstLine.slice(0, 117) + "..." : firstLine;
				lessons.add(`${truncated} [${pr.repo}#${pr.prNumber}]`);
			}
		}
	}

	return Array.from(lessons);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load PR lessons relevant to the given files in scope.
 *
 * "Relevant" means:
 * - filesAffected has path overlap with filesInScope (exact, suffix, basename, dir)
 * - OR pr has no filesAffected (repo-level lesson, always relevant)
 *
 * @param filesInScope - List of file paths the current task will touch.
 * @returns Array of PRLesson objects with pre-extracted lessons.
 */
export function loadPRLessonsForFiles(filesInScope: string[]): PRLesson[] {
	const store = readPRLessonsSync();
	return store.prs.filter((pr) => isPRRelevant(pr, filesInScope));
}

/**
 * Build a markdown "PR Review History" section for injection into worker prompts.
 * Returns an empty string if no lessons are provided.
 */
export function buildPRLessonsSection(lessons: PRLesson[]): string {
	if (lessons.length === 0) return "";

	const lines: string[] = [
		"## 📋 PR Review History",
		"",
		"> Past PRs touching these files were declined. Learn from these:",
		"",
	];

	for (const pr of lessons) {
		const closeLabel = pr.closeReason !== "unknown" ? ` (CLOSED: ${pr.closeReason})` : " (CLOSED)";
		lines.push(`**${pr.repo} — PR #${pr.prNumber}**${closeLabel}`);

		if (pr.filesAffected.length > 0) {
			lines.push(`Files: ${pr.filesAffected.slice(0, 4).join(", ")}${pr.filesAffected.length > 4 ? ", ..." : ""}`);
		}

		// Show pre-extracted lessons
		const lessonList =
			pr.lessons.length > 0
				? pr.lessons
				: extractLessonsFromPR(pr); // Fallback: re-extract on the fly

		for (const lesson of lessonList.slice(0, 3)) {
			lines.push(`- ${lesson}`);
		}

		if (pr.fixedInPR) {
			lines.push(`- _(Fixed in PR #${pr.fixedInPR})_`);
		}

		lines.push("");
	}

	lines.push(
		"Apply these lessons proactively — don't repeat the patterns that caused these PRs to be declined.",
	);
	lines.push("");

	return lines.join("\n");
}

/**
 * Convenience: load relevant PR lessons for a set of files and return the
 * formatted markdown section in one call.
 */
export function buildPRLessonsSectionForFiles(filesInScope: string[]): string {
	const lessons = loadPRLessonsForFiles(filesInScope);
	return buildPRLessonsSection(lessons);
}
