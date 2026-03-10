#!/usr/bin/env npx jiti
/**
 * Unit tests for coordinate/qa-feedback.ts
 *
 * Tests cover:
 *   1. recordQAFailure — creates an entry with generated id and timestamp
 *   2. getFailuresForFiles — returns only unresolved failures matching files
 *   3. getFailuresForFiles — ignores resolved failures
 *   4. resolveFailure — marks failure as resolved with session and timestamp
 *   5. buildFailureBrief — returns empty string for empty failures array
 *   6. buildFailureBrief — formats failure list with severity and date
 *   7. enrichTaskWithQAFailures — prepends brief to task description when failures exist
 *   8. enrichTaskWithQAFailures — returns original description when no failures
 *   9. autoResolveFailuresForSession — resolves failures for modified files
 *  10. getQALoopSummary — returns correct counts
 *
 * Run with: npx jiti tests/unit/qa-feedback.test.ts
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

import { TestRunner, assertEqual, assert, assertExists } from "../test-utils.js";

// We isolate each test by setting process.env.QA_STORE_PATH to a temp file.
// Since jiti caches module imports, qa-feedback.ts lazily reads QA_STORE_PATH
// from process.env each call, making this approach reliable.

async function withTempStore<T>(fn: (storePath: string) => Promise<T>): Promise<T> {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "qa-test-"));
	const storePath = path.join(tmpDir, "qa-failures.json");
	const prevStorePath = process.env.QA_STORE_PATH;
	process.env.QA_STORE_PATH = storePath;
	try {
		return await fn(storePath);
	} finally {
		if (prevStorePath === undefined) {
			delete process.env.QA_STORE_PATH;
		} else {
			process.env.QA_STORE_PATH = prevStorePath;
		}
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
}

// Dynamically import to pick up fresh module state per test block.
// Since ESM modules are cached, we use a workaround: write an explicit store
// file and test via the public API functions which always re-read from disk.
async function importFresh() {
	// jiti doesn't support cache-busting easily, so we import once and rely on
	// the functions re-reading from disk (which they do, by design).
	const mod = await import("../../coordinate/qa-feedback.js");
	return mod;
}

const runner = new TestRunner("qa-feedback");

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: recordQAFailure creates entry with generated ID and timestamp
// ─────────────────────────────────────────────────────────────────────────────
await runner.test("recordQAFailure — creates entry with id and reportedAt", async () => {
	await withTempStore(async (storePath) => {
		const { recordQAFailure, getFailuresForFiles } = await importFresh();

		const id = await recordQAFailure({
			sessionId: "session-abc",
			reportedBy: "human-qa",
			severity: "major",
			title: "Button not accessible",
			description: "Missing aria-label on icon-only buttons",
			filesAffected: ["components/Button.tsx"],
			taskIds: ["TASK-01"],
		});

		assert(typeof id === "string" && id.length > 0, `Expected a UUID, got: ${id}`);

		const raw = await fs.readFile(storePath, "utf-8");
		const store = JSON.parse(raw);
		assertEqual(store.failures.length, 1, "Should have exactly 1 failure");
		assertEqual(store.failures[0].id, id, "Stored ID should match returned ID");
		assertEqual(store.failures[0].resolved, false, "New failure should be unresolved");
		assert(
			typeof store.failures[0].reportedAt === "string" && store.failures[0].reportedAt.includes("T"),
			"reportedAt should be an ISO timestamp",
		);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: getFailuresForFiles returns unresolved failures matching files
// ─────────────────────────────────────────────────────────────────────────────
await runner.test("getFailuresForFiles — returns matching unresolved failures", async () => {
	await withTempStore(async () => {
		const { recordQAFailure, getFailuresForFiles } = await importFresh();

		await recordQAFailure({
			sessionId: "s1",
			reportedBy: "human-qa",
			severity: "critical",
			title: "Auth token not refreshed",
			description: "Should retry once with refreshed token",
			filesAffected: ["lib/auth.ts"],
			taskIds: [],
		});

		await recordQAFailure({
			sessionId: "s2",
			reportedBy: "staging",
			severity: "minor",
			title: "Layout issue",
			description: "Minor spacing problem",
			filesAffected: ["pages/Home.tsx"],
			taskIds: [],
		});

		const results = await getFailuresForFiles(["lib/auth.ts"]);
		assertEqual(results.length, 1, "Should find exactly 1 failure for lib/auth.ts");
		assertEqual(results[0].title, "Auth token not refreshed", "Should return the auth failure");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: getFailuresForFiles ignores resolved failures
// ─────────────────────────────────────────────────────────────────────────────
await runner.test("getFailuresForFiles — ignores resolved failures", async () => {
	await withTempStore(async () => {
		const { recordQAFailure, resolveFailure, getFailuresForFiles } = await importFresh();

		const id = await recordQAFailure({
			sessionId: "s1",
			reportedBy: "human-qa",
			severity: "major",
			title: "Resolved issue",
			description: "Already fixed",
			filesAffected: ["lib/util.ts"],
			taskIds: [],
		});

		await resolveFailure(id, "session-xyz");

		const results = await getFailuresForFiles(["lib/util.ts"]);
		assertEqual(results.length, 0, "Resolved failures should not be returned");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: resolveFailure marks failure with resolvedAt and resolvedInSession
// ─────────────────────────────────────────────────────────────────────────────
await runner.test("resolveFailure — marks failure as resolved with metadata", async () => {
	await withTempStore(async (storePath) => {
		const { recordQAFailure, resolveFailure } = await importFresh();

		const id = await recordQAFailure({
			sessionId: "s1",
			reportedBy: "automated-test",
			severity: "major",
			title: "Broken test",
			description: "Test was failing",
			filesAffected: ["src/broken.ts"],
			taskIds: [],
		});

		await resolveFailure(id, "session-fix");

		const store = JSON.parse(await fs.readFile(storePath, "utf-8"));
		const failure = store.failures[0];

		assertEqual(failure.resolved, true, "Should be marked resolved");
		assertEqual(failure.resolvedInSession, "session-fix", "Should record resolving session");
		assert(
			typeof failure.resolvedAt === "string" && failure.resolvedAt.includes("T"),
			"resolvedAt should be an ISO timestamp",
		);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 5: buildFailureBrief returns empty string for empty array
// ─────────────────────────────────────────────────────────────────────────────
await runner.test("buildFailureBrief — returns empty string for no failures", async () => {
	const { buildFailureBrief } = await importFresh();
	const brief = buildFailureBrief([]);
	assertEqual(brief, "", "Should return empty string for empty failures");
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 6: buildFailureBrief formats with severity and title
// ─────────────────────────────────────────────────────────────────────────────
await runner.test("buildFailureBrief — formats failures with severity and date", async () => {
	const { buildFailureBrief } = await importFresh();

	const failures = [
		{
			id: "test-id",
			sessionId: "s1",
			reportedAt: "2026-03-09T00:00:00.000Z",
			reportedBy: "human-qa" as const,
			severity: "critical" as const,
			title: "Auth token not refreshed",
			description: "Should retry with refreshed token",
			filesAffected: ["lib/auth.ts"],
			taskIds: [],
			resolved: false,
		},
	];

	const brief = buildFailureBrief(failures);

	assert(brief.includes("⚠️ Known QA Issues"), "Brief should have header");
	assert(brief.includes("[CRITICAL]"), "Brief should show severity in uppercase");
	assert(brief.includes("Auth token not refreshed"), "Brief should include failure title");
	assert(brief.includes("lib/auth.ts"), "Brief should include affected file");
	assert(brief.includes("2026-03-09"), "Brief should include report date");
	assert(brief.includes("Verify these are addressed"), "Brief should end with verification note");
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 7: enrichTaskWithQAFailures prepends brief when failures exist
// ─────────────────────────────────────────────────────────────────────────────
await runner.test("enrichTaskWithQAFailures — prepends brief to task description", async () => {
	await withTempStore(async () => {
		const { recordQAFailure, enrichTaskWithQAFailures } = await importFresh();

		await recordQAFailure({
			sessionId: "s1",
			reportedBy: "staging",
			severity: "major",
			title: "Button not accessible",
			description: "Missing aria-label",
			filesAffected: ["components/Button.tsx"],
			taskIds: ["TASK-01"],
		});

		const originalDesc = "## TASK-01: Fix button\n\nFix the button component.";
		const enriched = await enrichTaskWithQAFailures(originalDesc, ["components/Button.tsx"]);

		assert(enriched.includes("⚠️ Known QA Issues"), "Enriched description should have QA brief");
		assert(enriched.includes("Button not accessible"), "Enriched description should include failure title");
		assert(enriched.includes(originalDesc), "Original description should be preserved");
		assert(enriched.indexOf("⚠️") < enriched.indexOf("## TASK-01"), "Brief should precede task description");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 8: enrichTaskWithQAFailures returns original description when no failures
// ─────────────────────────────────────────────────────────────────────────────
await runner.test("enrichTaskWithQAFailures — returns original when no failures", async () => {
	await withTempStore(async () => {
		const { enrichTaskWithQAFailures } = await importFresh();

		const originalDesc = "## TASK-02: Create utility\n\nCreate a utility function.";
		const enriched = await enrichTaskWithQAFailures(originalDesc, ["src/utils/helper.ts"]);

		assertEqual(enriched, originalDesc, "Should return original description unchanged");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 9: autoResolveFailuresForSession resolves matching failures
// ─────────────────────────────────────────────────────────────────────────────
await runner.test("autoResolveFailuresForSession — resolves failures for modified files", async () => {
	await withTempStore(async (storePath) => {
		const { recordQAFailure, autoResolveFailuresForSession } = await importFresh();

		const id1 = await recordQAFailure({
			sessionId: "old-session",
			reportedBy: "human-qa",
			severity: "critical",
			title: "Auth bug",
			description: "Token expired",
			filesAffected: ["lib/auth.ts"],
			taskIds: [],
		});

		const id2 = await recordQAFailure({
			sessionId: "old-session",
			reportedBy: "human-qa",
			severity: "major",
			title: "Button bug",
			description: "Inaccessible button",
			filesAffected: ["components/Button.tsx"],
			taskIds: [],
		});

		// Only pass lib/auth.ts as modified
		const resolvedIds = await autoResolveFailuresForSession(["lib/auth.ts"], "new-session");

		assertEqual(resolvedIds.length, 1, "Should resolve exactly 1 failure");
		assertEqual(resolvedIds[0], id1, "Should resolve the auth failure");

		// Verify on disk
		const store = JSON.parse(await fs.readFile(storePath, "utf-8"));
		const auth = store.failures.find((f: any) => f.id === id1);
		const button = store.failures.find((f: any) => f.id === id2);

		assertEqual(auth.resolved, true, "Auth failure should be resolved");
		assertEqual(auth.resolvedInSession, "new-session", "Should record new session");
		assertEqual(button.resolved, false, "Button failure should remain unresolved");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 10: getQALoopSummary returns correct counts
// ─────────────────────────────────────────────────────────────────────────────
await runner.test("getQALoopSummary — returns correct checked/active/resolved counts", async () => {
	await withTempStore(async () => {
		const { recordQAFailure, resolveFailure, getQALoopSummary } = await importFresh();

		const id1 = await recordQAFailure({
			sessionId: "s1",
			reportedBy: "human-qa",
			severity: "critical",
			title: "Critical issue",
			description: "Very bad",
			filesAffected: ["src/critical.ts"],
			taskIds: [],
		});

		const id2 = await recordQAFailure({
			sessionId: "s1",
			reportedBy: "staging",
			severity: "major",
			title: "Major issue",
			description: "Bad",
			filesAffected: ["src/major.ts"],
			taskIds: [],
		});

		// Pre-resolve id2 to simulate it being resolved in this session
		await resolveFailure(id2, "current-session");

		const files = ["src/critical.ts", "src/major.ts", "src/unrelated.ts"];
		const summary = await getQALoopSummary(files, [id2]);

		assertEqual(summary.checkedFiles, 3, "Should count all checked files");
		assertEqual(summary.activeFailures.length, 1, "Should find 1 active (unresolved) failure");
		assertEqual(summary.activeFailures[0].id, id1, "Active failure should be the critical one");
		assertEqual(summary.resolvedThisSession.length, 1, "Should track 1 resolved this session");
		assertEqual(summary.resolvedThisSession[0].id, id2, "Resolved failure should be id2");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────────────────────────────────────
const result = runner.summary();
process.exit(result.failed > 0 ? 1 : 0);
