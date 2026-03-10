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

export interface ReviewComment {
	/** Verbatim comment body (truncated at 1500 chars) */
	body: string;
	/** File path for inline comments */
	path?: string | null;
	author: string;
	/** True if the comment is from CodeRabbit AI */
	isCodeRabbit: boolean;
	/** True if the comment is from any bot */
	isBot: boolean;
	/** Comment source type */
	type: "pr-comment" | "review" | "inline";
}

export interface PRLesson {
	/** Unique ID: "{repo}#{prNumber}" */
	id: string;
	/** e.g. "Zimopia/talisman" */
	repo: string;
	prNumber: number;
	prTitle: string;
	closedAt: string;
	/** Why the PR was closed or the nature of its review cycle */
	closeReason:
		| "changes-requested"
		| "merged-after-review"
		| "superseded"
		| "too-many-commits"
		| "conflicts"
		| "stale"
		| "unknown";
	/** File paths touched by this PR */
	filesAffected: string[];
	/** All verbatim review comments (PR-level, review, inline) */
	reviewComments: ReviewComment[];
	/** Extracted actionable lesson strings for injection */
	lessons: string[];
	/** PR number that superseded this one (from comment text detection) */
	supersededByPR?: number | null;
	/** Title of the fix/follow-up PR */
	fixPRTitle?: string | null;
	/** State of the fix/follow-up PR: "merged", "open", "closed", "unknown" */
	fixPRStatus?: string | null;
	/** Unified diff from the fix PR (first 8000 chars) */
	fixDiff?: string | null;
	/** True if this PR went through changes-requested → approved and was merged */
	isMergedWithReview?: boolean;
	/** Signals extracted from CodeRabbit walkthrough comment */
	codeRabbitSignals?: {
		effort?: string;
		filesReviewed?: string;
		concerns?: string;
	} | null;
	/** True if any CodeRabbit comment was present with substantial body (>100 chars) */
	codeRabbitSummaryPresent?: boolean;
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
			return { version: 2, ingestedAt: null, prs: [] };
		}
		return parsed;
	} catch {
		return { version: 2, ingestedAt: null, prs: [] };
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Relevance matching
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generic basenames that are too common to be meaningful for basename-only matching.
 * When a PR file or query file has one of these basenames, we require partial
 * directory overlap before declaring a basename match.
 */
const GENERIC_BASENAMES = new Set([
	'index.ts', 'index.tsx', 'index.js', 'index.jsx',
	'types.ts', 'types.tsx', 'utils.ts', 'utils.tsx',
	'helpers.ts', 'helpers.js', 'handler.ts', 'handler.js',
	'constants.ts', 'constants.js', 'config.ts', 'config.js',
	'hooks.ts', 'hooks.tsx', 'store.ts', 'store.tsx',
	'styles.ts', 'styles.css', 'styles.scss',
	'README.md', 'package.json', 'tsconfig.json',
]);

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

	// PRs with no lessons or comments are not useful
	if (pr.lessons.length === 0 && pr.reviewComments.length === 0) return false;

	const normalizedScope = filesInScope.map((f) => path.normalize(f));
	const baseNamesScope = new Set(filesInScope.map((f) => path.basename(f)));

	for (const affected of pr.filesAffected) {
		const normalizedAffected = path.normalize(affected);

		// Exact match
		if (normalizedScope.includes(normalizedAffected)) return true;

		// Suffix match (e.g. stored as "src/auth.ts", scope has "coordinate/src/auth.ts")
		if (
			normalizedScope.some(
				(f) =>
					f.endsWith(normalizedAffected) || normalizedAffected.endsWith(f),
			)
		) {
			return true;
		}

		// Basename match — but only if the basename is specific enough
		const queryBasename = path.basename(affected);
		const prBasename = queryBasename; // same variable, reuse for clarity
		if (baseNamesScope.has(queryBasename)) {
			if (!GENERIC_BASENAMES.has(queryBasename)) {
				// Specific enough — match on basename alone
				return true;
			}
			// Generic basename — require partial directory match (last 2 path segments)
			const prDir = path.dirname(path.normalize(affected)).split(path.sep).slice(-2).join('/');
			for (const f of normalizedScope) {
				if (path.basename(f) === queryBasename) {
					const qDir = path.dirname(f).split(path.sep).slice(-2).join('/');
					if (prDir && qDir && prDir === qDir) {
						return true;
					}
				}
			}
		}

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

const LESSON_PATTERNS: Array<{
	pattern: RegExp;
	template: (match: string, pr: PRLesson) => string;
}> = [
	{
		pattern: /error.log|logging|log.*remov|remov.*log/i,
		template: (_, pr) =>
			`Preserve error logging — reviewers flagged its removal (${pr.repo}#${pr.prNumber})`,
	},
	{
		pattern: /race condition|concurren|mutex|thread.safe|atomic/i,
		template: (_, pr) =>
			`Watch for race conditions in concurrent code — flagged in ${pr.repo}#${pr.prNumber}`,
	},
	{
		pattern: /unrelated|separate pr|split this|mixed concern|focus.*pr|single concern/i,
		template: (_, pr) =>
			`Keep PRs focused on a single concern — unrelated changes flagged in ${pr.repo}#${pr.prNumber}`,
	},
	{
		pattern: /test.missing|add.*test|no test|untested|coverage/i,
		template: (_, pr) =>
			`Add tests for new behavior — missing tests flagged in ${pr.repo}#${pr.prNumber}`,
	},
	{
		pattern: /rebase|update.*main|behind.*main|out.*date|merge conflict/i,
		template: (_, pr) =>
			`Keep branch up-to-date with main before submitting — ${pr.repo}#${pr.prNumber}`,
	},
	{
		pattern: /performance|slow|n\+1|expensive|query.*loop/i,
		template: (_, pr) =>
			`Performance concern flagged in ${pr.repo}#${pr.prNumber}`,
	},
	{
		pattern: /security|injection|xss|csrf|sanitize|escape/i,
		template: (_, pr) =>
			`Security concern flagged — review carefully (${pr.repo}#${pr.prNumber})`,
	},
	{
		pattern: /breaking change|backward compat|api change|schema change/i,
		template: (_, pr) =>
			`Breaking change flagged in ${pr.repo}#${pr.prNumber} — ensure backward compatibility`,
	},
	{
		pattern: /type.*error|type.*wrong|incorrect.*type/i,
		template: (_, pr) =>
			`TypeScript type errors were flagged in ${pr.repo}#${pr.prNumber}`,
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
	reviewComments: Array<{ body: string; path?: string | null; author: string }>;
}): string[] {
	const lessons = new Set<string>();

	// Derive lessons from close reason
	switch (pr.closeReason) {
		case "changes-requested":
			lessons.add(
				`Changes were requested before this PR could merge — review feedback carefully [${pr.repo}#${pr.prNumber}]`,
			);
			break;
		case "merged-after-review":
			lessons.add(
				`This PR went through changes-requested → approved cycle — study the fix diff to understand what was fixed [${pr.repo}#${pr.prNumber}]`,
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
			lessons.add(
				`PR went stale — ensure work is needed before starting [${pr.repo}#${pr.prNumber}]`,
			);
			break;
	}

	// Derive lessons from review comments
	for (const comment of pr.reviewComments) {
		if (!comment.body || comment.body === "null") continue;

		const lower = comment.body.toLowerCase();
		let matched = false;

		for (const { pattern, template } of LESSON_PATTERNS) {
			if (pattern.test(lower)) {
				const lesson = template(lower, pr as PRLesson);
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
 *
 * Includes:
 * - Human reviewer verbatim quotes (most actionable, up to 3 per PR)
 * - Author close-reason notes (up to 1 per PR)
 * - CodeRabbit effort + concern signals
 * - Fix diff preview (diff lines from follow-up PR or the merged PR itself)
 *
 * Returns an empty string if no lessons are provided.
 */
export function buildPRLessonsSection(lessons: PRLesson[]): string {
	if (lessons.length === 0) return "";

	const lines: string[] = [
		"## 📋 PR Review History",
		"",
		"> Past PRs touching these files have review history. Learn from these:",
		"",
	];

	for (const pr of lessons) {
		const isMerged = pr.isMergedWithReview;
		const closeLabel = isMerged
			? " (MERGED after review cycle)"
			: pr.closeReason !== "unknown"
				? ` (CLOSED: ${pr.closeReason})`
				: " (CLOSED)";

		lines.push(`**${pr.repo} — PR #${pr.prNumber}**${closeLabel}`);
		lines.push(`_"${pr.prTitle}"_`);

		if (pr.filesAffected.length > 0) {
			lines.push(
				`Files: ${pr.filesAffected.slice(0, 4).join(", ")}${pr.filesAffected.length > 4 ? ", ..." : ""}`,
			);
		}

		// Show pre-extracted lessons
		const lessonList =
			pr.lessons.length > 0 ? pr.lessons : extractLessonsFromPR(pr);
		for (const lesson of lessonList.slice(0, 3)) {
			lines.push(`- ${lesson}`);
		}

		// 1. Human reviewer verbatim quotes (most actionable — reviews and inline)
		const humanReviewerComments = pr.reviewComments.filter(
			(c) => !c.isBot && c.body.length > 30 && c.type !== "pr-comment",
		);
		for (const comment of humanReviewerComments.slice(0, 3)) {
			const pathNote = comment.path ? ` \`${comment.path}\`` : "";
			lines.push(
				`  > **${comment.author}**${pathNote}: "${comment.body.slice(0, 350)}"`,
			);
		}

		// 2. Close-reason comments from author (why was it closed)
		const closeComments = pr.reviewComments.filter(
			(c) => !c.isBot && c.type === "pr-comment" && c.body.length > 20,
		);
		for (const comment of closeComments.slice(0, 1)) {
			lines.push(`  > *Author note*: "${comment.body.slice(0, 200)}"`);
		}

		// 3. CodeRabbit effort and concern signals
		if (pr.codeRabbitSignals?.effort) {
			lines.push(
				`  > CodeRabbit effort estimate: ${pr.codeRabbitSignals.effort}`,
			);
		}
		if (pr.codeRabbitSignals?.concerns) {
			lines.push(
				`  > CodeRabbit flagged: ${pr.codeRabbitSignals.concerns.slice(0, 200)}`,
			);
		}

		// 4. Fix diff preview
		if (pr.fixDiff) {
			const fixLabel = pr.isMergedWithReview
				? `Fix (this PR was merged after review)`
				: `Fix in PR #${pr.supersededByPR} [${pr.fixPRStatus}]: ${pr.fixPRTitle || ""}`;
			lines.push(`  > → ${fixLabel}`);
			const diffLines = pr.fixDiff
				.split("\n")
				.filter(
					(l) =>
						l.startsWith("+") || l.startsWith("-") || l.startsWith("@@"),
				)
				.slice(0, 20);
			if (diffLines.length > 0) {
				lines.push("  > ```diff");
				for (const dl of diffLines) lines.push("  > " + dl);
				lines.push("  > ```");
			}
		} else if (pr.supersededByPR) {
			lines.push(`- _(Superseded by PR #${pr.supersededByPR})_`);
		}

		lines.push("");
	}

	lines.push(
		"Apply these lessons proactively — don't repeat the patterns that caused these PRs to be declined or require rework.",
	);
	lines.push("");

	return lines.join("\n");
}


