#!/usr/bin/env npx jiti
/**
 * Unit tests for pr-history-loader.ts
 *
 * Run with: npx jiti tests/unit/pr-history-loader.test.ts
 *
 * @module
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { TestRunner, assertEqual, assert } from "../test-utils.js";
import {
	extractLessonsFromPR,
	loadPRLessonsForFiles,
	buildPRLessonsSection,
	type PRLesson,
} from "../../coordinate/pr-history-loader.js";
import { buildCombinedContext } from "../../coordinate/lessons-loader.js";

// ─────────────────────────────────────────────────────────────────────────────
// Mock data helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeMockPR(overrides: Partial<PRLesson> = {}): PRLesson {
	return {
		id: "owner/test-repo#1",
		repo: "owner/test-repo",
		prNumber: 1,
		prTitle: "Test PR",
		closedAt: "2025-06-01T00:00:00Z",
		closeReason: "unknown",
		filesAffected: [],
		reviewComments: [],
		lessons: [],
		ingestedAt: "2025-06-02T00:00:00Z",
		...overrides,
	};
}

function writeTempStore(prs: PRLesson[]): string {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pr-test-"));
	const storePath = path.join(tmp, "pr-lessons.json");
	fs.writeFileSync(
		storePath,
		JSON.stringify({ version: 2, ingestedAt: new Date().toISOString(), prs }),
		"utf-8",
	);
	return storePath;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main test runner (all tests must be inside this async function)
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
	const runner = new TestRunner();

	// ─────────────────────────────────────────────────────────────────────────
	// extractLessonsFromPR
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("extractLessonsFromPR");

	await runner.test("returns lesson for changes-requested close reason", () => {
		const pr = {
			repo: "owner/repo",
			prNumber: 42,
			prTitle: "My PR",
			closeReason: "changes-requested",
			reviewComments: [],
		};
		const lessons = extractLessonsFromPR(pr);
		assert(lessons.length > 0, "Expected at least one lesson");
		assert(
			lessons.some((l) => l.includes("Changes were requested") || l.toLowerCase().includes("changes")),
			`Expected lesson about changes-requested, got: ${lessons.join(", ")}`,
		);
	});

	await runner.test("returns lesson for too-many-commits close reason", () => {
		const pr = {
			repo: "sweetcheeks72/helios-agent",
			prNumber: 3,
			prTitle: "Mixed feature PR",
			closeReason: "too-many-commits",
			reviewComments: [],
		};
		const lessons = extractLessonsFromPR(pr);
		assert(lessons.length > 0, "Expected at least one lesson");
		assert(
			lessons.some(
				(l) => l.includes("focused") || l.includes("unrelated") || l.includes("single concern"),
			),
			`Expected lesson about focused PRs, got: ${lessons.join(", ")}`,
		);
	});

	await runner.test("extracts lesson from review comment about error logging", () => {
		const pr = {
			repo: "Zimopia/talisman",
			prNumber: 1405,
			prTitle: "Quality sweep",
			closeReason: "unknown" as const,
			reviewComments: [
				{
					body: "You removed error logging here — this is important for debugging production issues",
					path: "app/errors/handler.ts",
					author: "reviewer1",
				},
			],
		};
		const lessons = extractLessonsFromPR(pr);
		assert(lessons.length > 0, "Expected at least one lesson");
		assert(
			lessons.some((l) => l.includes("logging") || l.includes("Preserve")),
			`Expected lesson about preserving logging, got: ${lessons.join(", ")}`,
		);
		assert(
			lessons.some((l) => l.includes("1405")),
			`Expected lesson to reference PR number, got: ${lessons.join(", ")}`,
		);
	});

	await runner.test("extracts lesson from review comment about race conditions", () => {
		const pr = {
			repo: "Zimopia/talisman",
			prNumber: 1407,
			prTitle: "Bulk query optimization",
			closeReason: "changes-requested" as const,
			reviewComments: [
				{
					body: "This chunked concurrency implementation will cause race conditions on the bulk query path",
					path: "lib/queries/bulk.ts",
					author: "lead-reviewer",
				},
			],
		};
		const lessons = extractLessonsFromPR(pr);
		assert(
			lessons.some((l) => l.includes("race condition") || l.includes("concurrent")),
			`Expected lesson about race conditions, got: ${lessons.join(", ")}`,
		);
	});

	await runner.test("deduplicates identical lessons from repeated comments", () => {
		const pr = {
			repo: "owner/repo",
			prNumber: 10,
			prTitle: "Test",
			closeReason: "changes-requested" as const,
			reviewComments: [
				{ body: "Please add tests for this feature", path: "src/feature.ts", author: "a" },
				{ body: "Missing tests here as well", path: "src/other.ts", author: "b" },
			],
		};
		const lessons = extractLessonsFromPR(pr);
		// Lessons should be unique (Set-based dedup)
		const uniqueSet = new Set(lessons);
		assertEqual(
			uniqueSet.size,
			lessons.length,
			`Expected deduplicated lessons, got duplicates: ${lessons.join(" | ")}`,
		);
	});

	await runner.test("returns empty array for PR with no comments and unknown reason", () => {
		const pr = {
			repo: "owner/repo",
			prNumber: 99,
			prTitle: "Silent close",
			closeReason: "unknown" as const,
			reviewComments: [],
		};
		const lessons = extractLessonsFromPR(pr);
		// Unknown reason + no comments → empty (doesn't throw)
		assert(Array.isArray(lessons), "Expected array result");
		assertEqual(lessons.length, 0, "Expected 0 lessons for unknown/empty PR");
	});

	// ─────────────────────────────────────────────────────────────────────────
	// loadPRLessonsForFiles
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("loadPRLessonsForFiles");

	await runner.test("returns PRs with overlapping files", () => {
		const pr1 = makeMockPR({
			id: "owner/repo#1",
			filesAffected: ["src/auth/login.ts", "src/auth/session.ts"],
			lessons: ["Check auth patterns"],
		});
		const pr2 = makeMockPR({
			id: "owner/repo#2",
			filesAffected: ["src/payments/checkout.ts"],
			lessons: ["Payment lesson"],
		});

		const storePath = writeTempStore([pr1, pr2]);
		const origEnv = process.env.PR_LESSONS_STORE_PATH;
		process.env.PR_LESSONS_STORE_PATH = storePath;

		try {
			const results = loadPRLessonsForFiles(["src/auth/login.ts"]);
			assert(results.length === 1, `Expected 1 result, got ${results.length}`);
			assertEqual(results[0].id, "owner/repo#1", "Expected pr1 to match");
		} finally {
			if (origEnv === undefined) {
				delete process.env.PR_LESSONS_STORE_PATH;
			} else {
				process.env.PR_LESSONS_STORE_PATH = origEnv;
			}
		}
	});

	await runner.test("returns repo-level PRs (no filesAffected) always", () => {
		const globalPR = makeMockPR({
			id: "owner/repo#5",
			filesAffected: [],
			lessons: ["Global lesson: keep PRs focused"],
		});

		const storePath = writeTempStore([globalPR]);
		const origEnv = process.env.PR_LESSONS_STORE_PATH;
		process.env.PR_LESSONS_STORE_PATH = storePath;

		try {
			const results = loadPRLessonsForFiles(["some/unrelated/file.ts"]);
			assert(results.length === 1, `Expected 1 global result, got ${results.length}`);
			assertEqual(results[0].id, "owner/repo#5", "Expected global PR to match");
		} finally {
			if (origEnv === undefined) {
				delete process.env.PR_LESSONS_STORE_PATH;
			} else {
				process.env.PR_LESSONS_STORE_PATH = origEnv;
			}
		}
	});

	await runner.test("matches by basename when full path differs", () => {
		const pr = makeMockPR({
			id: "owner/repo#7",
			filesAffected: ["app/transactions/bulk.ts"],
			lessons: ["Bulk transaction lesson"],
		});

		const storePath = writeTempStore([pr]);
		const origEnv = process.env.PR_LESSONS_STORE_PATH;
		process.env.PR_LESSONS_STORE_PATH = storePath;

		try {
			// Different prefix, same basename
			const results = loadPRLessonsForFiles(["coordinate/src/bulk.ts"]);
			assert(results.length === 1, `Expected 1 basename match, got ${results.length}`);
		} finally {
			if (origEnv === undefined) {
				delete process.env.PR_LESSONS_STORE_PATH;
			} else {
				process.env.PR_LESSONS_STORE_PATH = origEnv;
			}
		}
	});

	await runner.test("returns empty array when store is missing", () => {
		const origEnv = process.env.PR_LESSONS_STORE_PATH;
		process.env.PR_LESSONS_STORE_PATH = "/nonexistent/path/pr-lessons.json";

		try {
			const results = loadPRLessonsForFiles(["src/auth.ts"]);
			assert(Array.isArray(results), "Expected array");
			assertEqual(results.length, 0, "Expected empty array for missing store");
		} finally {
			if (origEnv === undefined) {
				delete process.env.PR_LESSONS_STORE_PATH;
			} else {
				process.env.PR_LESSONS_STORE_PATH = origEnv;
			}
		}
	});

	// ─────────────────────────────────────────────────────────────────────────
	// buildPRLessonsSection
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("buildPRLessonsSection");

	await runner.test("returns empty string for empty lessons array", () => {
		const result = buildPRLessonsSection([]);
		assertEqual(result, "", "Expected empty string for no lessons");
	});

	await runner.test("includes PR header, repo, number, and lesson text", () => {
		const pr = makeMockPR({
			repo: "Zimopia/talisman",
			prNumber: 1405,
			closeReason: "changes-requested",
			filesAffected: ["app/errors/handler.ts"],
			lessons: ["Preserve error logging"],
		});

		const result = buildPRLessonsSection([pr]);

		assert(result.includes("## 📋 PR Review History"), "Expected section header");
		assert(result.includes("Zimopia/talisman"), "Expected repo name");
		assert(result.includes("1405"), "Expected PR number");
		assert(result.includes("CLOSED: changes-requested"), "Expected close reason");
		assert(result.includes("Preserve error logging"), "Expected lesson text");
	});

	await runner.test("includes files affected in output", () => {
		const pr = makeMockPR({
			repo: "owner/repo",
			prNumber: 42,
			closeReason: "conflicts",
			filesAffected: ["src/auth.ts", "src/session.ts"],
			lessons: ["Keep branch updated"],
		});

		const result = buildPRLessonsSection([pr]);
		assert(result.includes("src/auth.ts"), "Expected file path in output");
	});

	await runner.test("handles multiple PRs and includes all lessons", () => {
		const pr1 = makeMockPR({
			id: "owner/repo#1",
			repo: "owner/repo",
			prNumber: 1,
			closeReason: "changes-requested",
			lessons: ["Lesson from PR 1"],
		});
		const pr2 = makeMockPR({
			id: "owner/repo#2",
			repo: "owner/repo",
			prNumber: 2,
			closeReason: "too-many-commits",
			lessons: ["Lesson from PR 2"],
		});

		const result = buildPRLessonsSection([pr1, pr2]);

		assert(result.includes("PR #1"), "Expected PR 1 reference");
		assert(result.includes("PR #2"), "Expected PR 2 reference");
		assert(result.includes("Lesson from PR 1"), "Expected lesson 1");
		assert(result.includes("Lesson from PR 2"), "Expected lesson 2");
	});

	await runner.test("shows (CLOSED) without reason label for unknown close reason", () => {
		const pr = makeMockPR({
			repo: "owner/repo",
			prNumber: 9,
			closeReason: "unknown",
			lessons: ["A lesson"],
		});

		const result = buildPRLessonsSection([pr]);
		// Should show "(CLOSED)" not "(CLOSED: unknown)"
		assert(
			result.includes("(CLOSED)") && !result.includes("(CLOSED: unknown)"),
			`Expected "(CLOSED)" without reason for unknown, got: ${result.slice(0, 200)}`,
		);
	});

	await runner.test("falls back to on-the-fly extraction when stored lessons is empty", () => {
		const pr = makeMockPR({
			repo: "owner/repo",
			prNumber: 100,
			closeReason: "too-many-commits",
			reviewComments: [],
			lessons: [], // Empty — triggers fallback extraction from closeReason
		});

		const result = buildPRLessonsSection([pr]);
		// Should still produce output (header + fallback lessons from close reason)
		assert(result.includes("## 📋 PR Review History"), "Expected section header");
		// The fallback from too-many-commits should produce a lesson about focus
		assert(
			result.includes("focused") || result.includes("unrelated") || result.includes("single concern"),
			`Expected fallback lesson about focused PRs in result: ${result.slice(0, 300)}`,
		);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// FIX 5: Basename specificity gate — generic filenames should NOT over-match
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("basename specificity gate (FIX 5)");

	await runner.test("specific basename (bulk.ts) matches across different directories", () => {
		const pr = makeMockPR({
			id: "owner/repo#7",
			filesAffected: ["app/transactions/bulk.ts"],
			lessons: ["Bulk transaction lesson"],
		});

		const storePath = writeTempStore([pr]);
		const origEnv = process.env.PR_LESSONS_STORE_PATH;
		process.env.PR_LESSONS_STORE_PATH = storePath;

		try {
			// Different prefix, same specific basename — should still match
			const results = loadPRLessonsForFiles(["coordinate/src/bulk.ts"]);
			assert(results.length === 1, `Expected 1 specific basename match, got ${results.length}`);
		} finally {
			if (origEnv === undefined) delete process.env.PR_LESSONS_STORE_PATH;
			else process.env.PR_LESSONS_STORE_PATH = origEnv;
		}
	});

	await runner.test("generic basename (index.ts) does NOT match when directories differ", () => {
		const pr = makeMockPR({
			id: "owner/repo#8",
			filesAffected: ["app/payments/index.ts"],
			lessons: ["Payment index lesson"],
		});

		const storePath = writeTempStore([pr]);
		const origEnv = process.env.PR_LESSONS_STORE_PATH;
		process.env.PR_LESSONS_STORE_PATH = storePath;

		try {
			// Generic basename, completely different directory — should NOT match
			const results = loadPRLessonsForFiles(["coordinate/workers/index.ts"]);
			assert(
				results.length === 0,
				`Expected 0 results for generic basename with different dir, got ${results.length}`,
			);
		} finally {
			if (origEnv === undefined) delete process.env.PR_LESSONS_STORE_PATH;
			else process.env.PR_LESSONS_STORE_PATH = origEnv;
		}
	});

	await runner.test("generic basename (index.ts) DOES match when last two directory segments overlap", () => {
		const pr = makeMockPR({
			id: "owner/repo#9",
			filesAffected: ["app/payments/index.ts"],
			lessons: ["Payment index lesson"],
		});

		const storePath = writeTempStore([pr]);
		const origEnv = process.env.PR_LESSONS_STORE_PATH;
		process.env.PR_LESSONS_STORE_PATH = storePath;

		try {
			// Generic basename, same last-two-segment directory — should match
			const results = loadPRLessonsForFiles(["src/app/payments/index.ts"]);
			assert(
				results.length === 1,
				`Expected 1 result for generic basename with matching dir, got ${results.length}`,
			);
		} finally {
			if (origEnv === undefined) delete process.env.PR_LESSONS_STORE_PATH;
			else process.env.PR_LESSONS_STORE_PATH = origEnv;
		}
	});

	// ─────────────────────────────────────────────────────────────────────────
	// FIX 10: Integration test for full pipe (buildCombinedContext)
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("buildCombinedContext integration (FIX 10)");

	await runner.test("buildCombinedContext returns PR lesson for specific file match", () => {
		const pr = makeMockPR({
			id: "Zimopia/talisman#200",
			repo: "Zimopia/talisman",
			prNumber: 200,
			prTitle: "Bulk transaction refactor",
			closedAt: "2025-09-01T00:00:00Z",
			closeReason: "changes-requested",
			filesAffected: ["app/transactions/bulk.ts"],
			reviewComments: [
				{
					body: "Race condition risk in the bulk path — concurrency here is problematic",
					path: "app/transactions/bulk.ts",
					author: "reviewer-A",
					isCodeRabbit: false,
					isBot: false,
					type: "inline",
				},
			],
			lessons: ["Watch for race conditions in bulk.ts — flagged in review"],
		});

		const storePath = writeTempStore([pr]);
		const origEnv = process.env.PR_LESSONS_STORE_PATH;
		process.env.PR_LESSONS_STORE_PATH = storePath;

		try {
			const context = buildCombinedContext(["app/transactions/bulk.ts"]);
			assert(context.length > 0, "Expected non-empty context for matching file");
			assert(
				context.includes("bulk.ts") || context.includes("Bulk") || context.includes("talisman"),
				`Expected context to reference PR details, got: ${context.slice(0, 200)}`,
			);
		} finally {
			if (origEnv === undefined) delete process.env.PR_LESSONS_STORE_PATH;
			else process.env.PR_LESSONS_STORE_PATH = origEnv;
		}
	});

	await runner.test("buildCombinedContext does NOT include lessons for unrelated files", () => {
		const pr = makeMockPR({
			id: "owner/repo#300",
			repo: "owner/repo",
			prNumber: 300,
			prTitle: "Payment service fix",
			filesAffected: ["src/payments/checkout.ts"],
			lessons: ["Payment checkout lesson — very specific"],
		});

		const storePath = writeTempStore([pr]);
		const origEnv = process.env.PR_LESSONS_STORE_PATH;
		process.env.PR_LESSONS_STORE_PATH = storePath;

		try {
			// Completely unrelated file — should produce empty context
			const context = buildCombinedContext(["src/auth/login.ts"]);
			assert(
				!context.includes("Payment checkout lesson"),
				`Expected unrelated lesson to be excluded, but got it in context`,
			);
		} finally {
			if (origEnv === undefined) delete process.env.PR_LESSONS_STORE_PATH;
			else process.env.PR_LESSONS_STORE_PATH = origEnv;
		}
	});

	await runner.test("buildCombinedContext does NOT over-match on generic index.ts basename", () => {
		const pr = makeMockPR({
			id: "owner/repo#400",
			repo: "owner/repo",
			prNumber: 400,
			prTitle: "Analytics module refactor",
			filesAffected: ["src/analytics/reporting/index.ts"],
			lessons: ["Analytics-specific lesson that should not leak"],
		});

		const storePath = writeTempStore([pr]);
		const origEnv = process.env.PR_LESSONS_STORE_PATH;
		process.env.PR_LESSONS_STORE_PATH = storePath;

		try {
			// Different module's index.ts — should NOT match due to FIX 5 specificity gate
			const context = buildCombinedContext(["src/auth/session/index.ts"]);
			assert(
				!context.includes("Analytics-specific lesson"),
				`FIX 5 specificity gate failed: generic index.ts over-matched across modules. Got context: ${context.slice(0, 200)}`,
			);
		} finally {
			if (origEnv === undefined) delete process.env.PR_LESSONS_STORE_PATH;
			else process.env.PR_LESSONS_STORE_PATH = origEnv;
		}
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Summary
	// ─────────────────────────────────────────────────────────────────────────

	const { passed, failed } = runner.summary();
	process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
	console.error("Test runner failed:", err);
	process.exit(1);
});
