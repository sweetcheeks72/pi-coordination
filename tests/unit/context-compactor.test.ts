#!/usr/bin/env npx jiti
/**
 * Unit tests for the Context Compactor (anti-drift session memory).
 *
 * Run with: npx jiti tests/unit/context-compactor.test.ts
 *
 * @module
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { TestRunner, assertEqual, assert } from "../test-utils.js";
import {
	compactSession,
	buildWorkerContextHeader,
	saveDigest,
	loadDigest,
	loadCrossSessionDigest,
	saveCrossSessionDigest,
	recordDecision,
	type CompletedTask,
	type SessionDigest,
} from "../../coordinate/context-compactor.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-compactor-test-"));
}

function makeTask(overrides: Partial<CompletedTask> = {}): CompletedTask {
	return {
		taskId: "TASK-01",
		title: "Set up auth module",
		filesModified: ["src/auth/index.ts", "src/auth/types.ts"],
		summary: undefined,
		...overrides,
	};
}

const SPEC_CONTENT = `## TASK-01: Auth module
Priority: P1
Files: src/auth/index.ts (create)
Depends on: none
Acceptance: Auth must work correctly

Note: You must not expose private keys. All tokens are required.
Never log sensitive data.
`;

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
	const runner = new TestRunner();

	// ─────────────────────────────────────────────────────────────────────────
	// Test 1: compactSession creates a valid digest
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("compactSession — basic digest creation");

	await runner.test("creates a SessionDigest with all required fields", async () => {
		const coordDir = makeTempDir();
		const tasks: CompletedTask[] = [
			makeTask({ taskId: "TASK-01", filesModified: ["src/auth/index.ts"] }),
			makeTask({ taskId: "TASK-02", title: "DB schema", filesModified: ["db/schema.sql"] }),
		];

		const digest = await compactSession(
			coordDir,
			"test-session-001",
			tasks,
			SPEC_CONTENT,
			"workers",
		);

		assertEqual(digest.sessionId, "test-session-001", "sessionId should match");
		assertEqual(digest.phase, "workers", "phase should be 'workers'");
		assert(typeof digest.createdAt === "string", "createdAt should be a string");
		assert(typeof digest.specHash === "string" && digest.specHash.length === 16, "specHash should be 16 chars");
		assert(Array.isArray(digest.decisionsMade), "decisionsMade should be an array");
		assert(Array.isArray(digest.activeConstraints), "activeConstraints should be an array");
		assert(Array.isArray(digest.filesModified), "filesModified should be an array");
		assert(Array.isArray(digest.completedTaskSummaries), "completedTaskSummaries should be an array");
		assert(Array.isArray(digest.openQuestions), "openQuestions should be an array");
	});

	await runner.test("deduplicates and sorts filesModified across tasks", async () => {
		const coordDir = makeTempDir();
		const tasks: CompletedTask[] = [
			makeTask({ taskId: "TASK-01", filesModified: ["src/b.ts", "src/a.ts"] }),
			makeTask({ taskId: "TASK-02", filesModified: ["src/a.ts", "src/c.ts"] }),
		];

		const digest = await compactSession(coordDir, "sess-dedup", tasks, SPEC_CONTENT, "workers");

		assertEqual(digest.filesModified.length, 3, "Should have 3 unique files");
		assertEqual(digest.filesModified[0], "src/a.ts", "First file should be src/a.ts (sorted)");
	});

	await runner.test("extracts constraints from spec content", async () => {
		const coordDir = makeTempDir();
		const digest = await compactSession(
			coordDir,
			"sess-constraints",
			[],
			SPEC_CONTENT,
			"workers",
		);

		assert(digest.activeConstraints.length > 0, "Should extract at least one constraint");
		const hasConstraint = digest.activeConstraints.some(c =>
			/must|required|never/i.test(c)
		);
		assert(hasConstraint, "Constraints should include must/required/never phrases");
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Test 2: saveDigest / loadDigest round-trip
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("saveDigest / loadDigest — persistence round-trip");

	await runner.test("saves digest to session-digest.json and loads it back", async () => {
		const coordDir = makeTempDir();
		const digest: SessionDigest = {
			sessionId: "round-trip-001",
			createdAt: new Date().toISOString(),
			phase: "workers",
			decisionsMade: ["Use TypeScript strict mode"],
			activeConstraints: ["Must preserve existing API surface"],
			filesModified: ["src/foo.ts"],
			completedTaskSummaries: [{ taskId: "TASK-01", summary: "Completed setup.", filesModified: ["src/foo.ts"] }],
			openQuestions: [],
			specHash: "abc123456789abcd",
		};

		await saveDigest(coordDir, digest);

		const digestPath = path.join(coordDir, "session-digest.json");
		assert(fs.existsSync(digestPath), "session-digest.json should exist");

		const loaded = await loadDigest(coordDir);
		assert(loaded !== null, "Loaded digest should not be null");
		assertEqual(loaded!.sessionId, "round-trip-001", "sessionId should round-trip");
		assertEqual(loaded!.decisionsMade[0], "Use TypeScript strict mode", "decisionsMade should round-trip");
		assertEqual(loaded!.completedTaskSummaries.length, 1, "completedTaskSummaries should round-trip");
	});

	await runner.test("loadDigest returns null when file does not exist", async () => {
		const coordDir = makeTempDir();
		const result = await loadDigest(coordDir);
		assertEqual(result, null, "Should return null for missing digest");
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Test 3: buildWorkerContextHeader generates valid markdown
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("buildWorkerContextHeader — markdown output");

	await runner.test("generates a markdown header with all sections", async () => {
		const digest: SessionDigest = {
			sessionId: "ctx-header-001",
			createdAt: "2026-03-10T00:00:00.000Z",
			phase: "workers",
			decisionsMade: ["Use zod for validation"],
			activeConstraints: ["Must not break existing tests"],
			filesModified: ["src/foo.ts", "src/bar.ts"],
			completedTaskSummaries: [
				{ taskId: "TASK-01", summary: "Created auth module (2 files modified).", filesModified: ["src/foo.ts"] },
			],
			openQuestions: ["Should we use ESM or CJS?"],
			specHash: "abc123456789abcd",
		};

		const header = buildWorkerContextHeader(digest);

		assert(header.includes("## Session Context"), "Should include h2 heading");
		assert(header.includes("workers"), "Should include phase value");
		assert(header.includes("src/foo.ts"), "Should include modified files");
		assert(header.includes("TASK-01"), "Should include task summary");
		assert(header.includes("zod"), "Should include decisions");
		assert(header.includes("Must not break"), "Should include constraints");
		assert(header.includes("ESM or CJS"), "Should include open questions");
		assert(header.includes("---"), "Should end with horizontal rule");
	});

	await runner.test("handles empty digest gracefully (no optional sections)", async () => {
		const digest: SessionDigest = {
			sessionId: "empty-001",
			createdAt: "2026-03-10T00:00:00.000Z",
			phase: "workers",
			decisionsMade: [],
			activeConstraints: [],
			filesModified: [],
			completedTaskSummaries: [],
			openQuestions: [],
			specHash: "abc123456789abcd",
		};

		const header = buildWorkerContextHeader(digest);

		assert(header.includes("## Session Context"), "Should still have heading");
		assert(!header.includes("**Files modified so far"), "Should not show empty files section");
		assert(!header.includes("**Completed tasks:**"), "Should not show empty tasks section");
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Test 4: Cross-session memory
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("Cross-session memory — save/load by specHash");

	await runner.test("saveCrossSessionDigest and loadCrossSessionDigest round-trip", async () => {
		const specHash = `test-${Date.now().toString(36)}`;
		const digest: SessionDigest = {
			sessionId: "cross-001",
			createdAt: new Date().toISOString(),
			phase: "workers",
			decisionsMade: [],
			activeConstraints: [],
			filesModified: ["src/x.ts"],
			completedTaskSummaries: [],
			openQuestions: [],
			specHash,
		};

		await saveCrossSessionDigest(specHash, digest);
		const loaded = await loadCrossSessionDigest(specHash);

		assert(loaded !== null, "Cross-session digest should be loadable");
		assertEqual(loaded!.sessionId, "cross-001", "sessionId should match");
		assertEqual(loaded!.filesModified[0], "src/x.ts", "filesModified should match");

		// Cleanup
		const crossDir = path.join(os.homedir(), ".pi", "session-memory");
		const testFile = path.join(crossDir, `${specHash}.json`);
		try { fs.unlinkSync(testFile); } catch {}
	});

	await runner.test("loadCrossSessionDigest returns null for unknown specHash", async () => {
		const result = await loadCrossSessionDigest("nonexistent-hash-xyz");
		assertEqual(result, null, "Should return null for unknown spec hash");
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Test 5: recordDecision appends without duplication
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("recordDecision — append without duplication");

	await runner.test("appends a decision to an existing digest", async () => {
		const coordDir = makeTempDir();
		const digest: SessionDigest = {
			sessionId: "decision-001",
			createdAt: new Date().toISOString(),
			phase: "workers",
			decisionsMade: [],
			activeConstraints: [],
			filesModified: [],
			completedTaskSummaries: [],
			openQuestions: [],
			specHash: "abc123456789abcd",
		};
		await saveDigest(coordDir, digest);

		await recordDecision(coordDir, "Use strict TypeScript");
		const loaded = await loadDigest(coordDir);

		assertEqual(loaded!.decisionsMade.length, 1, "Should have 1 decision");
		assertEqual(loaded!.decisionsMade[0], "Use strict TypeScript", "Decision should match");
	});

	await runner.test("does not duplicate an existing decision", async () => {
		const coordDir = makeTempDir();
		const digest: SessionDigest = {
			sessionId: "dedup-decision-001",
			createdAt: new Date().toISOString(),
			phase: "workers",
			decisionsMade: ["Use strict TypeScript"],
			activeConstraints: [],
			filesModified: [],
			completedTaskSummaries: [],
			openQuestions: [],
			specHash: "abc123456789abcd",
		};
		await saveDigest(coordDir, digest);

		await recordDecision(coordDir, "Use strict TypeScript");
		await recordDecision(coordDir, "Use strict TypeScript");
		const loaded = await loadDigest(coordDir);

		assertEqual(loaded!.decisionsMade.length, 1, "Should still have only 1 decision (no duplication)");
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Run all tests
	// ─────────────────────────────────────────────────────────────────────────

	const { failed } = runner.summary();
	if (failed > 0) process.exit(1);
}

main().catch(err => {
	console.error("Test suite failed:", err);
	process.exit(1);
});
