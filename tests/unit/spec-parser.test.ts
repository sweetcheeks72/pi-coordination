#!/usr/bin/env npx jiti
/**
 * Unit tests for spec parser.
 *
 * Run with: npx jiti tests/unit/spec-parser.test.ts
 *
 * @module
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
	TestRunner,
	assertEqual,
	assertExists,
	assert,
} from "../test-utils.js";

// Import the spec parser
import { parseSpec, TASK_ID_PATTERNS } from "../../extensions/coordination/coordinate/spec-parser.js";

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, "..", "fixtures", "specs");

function loadFixture(name: string): string {
	return fs.readFileSync(path.join(FIXTURES_DIR, name), "utf-8");
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
	const runner = new TestRunner();

	// ─────────────────────────────────────────────────────────────────────────
	// TASK_ID_PATTERNS tests
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("TASK_ID_PATTERNS");

	await runner.test("matches main task IDs", () => {
		assert(TASK_ID_PATTERNS.taskMain.test("TASK-01"), "TASK-01 should match");
		assert(TASK_ID_PATTERNS.taskMain.test("TASK-99"), "TASK-99 should match");
		assert(TASK_ID_PATTERNS.taskMain.test("TASK-100"), "TASK-100 should match");
	});

	await runner.test("rejects invalid main task IDs", () => {
		assert(!TASK_ID_PATTERNS.taskMain.test("TASK-1"), "TASK-1 should not match (too short)");
		assert(!TASK_ID_PATTERNS.taskMain.test("TASK-A"), "TASK-A should not match (letters)");
		assert(!TASK_ID_PATTERNS.taskMain.test("task-01"), "task-01 should not match (lowercase)");
	});

	await runner.test("matches subtask IDs", () => {
		assert(TASK_ID_PATTERNS.taskSub.test("TASK-01.1"), "TASK-01.1 should match");
		assert(TASK_ID_PATTERNS.taskSub.test("TASK-01.5"), "TASK-01.5 should match");
		assert(TASK_ID_PATTERNS.taskSub.test("TASK-99.10"), "TASK-99.10 should match");
	});

	await runner.test("rejects invalid subtask IDs", () => {
		assert(!TASK_ID_PATTERNS.taskSub.test("TASK-01"), "TASK-01 should not match (no subtask)");
		assert(!TASK_ID_PATTERNS.taskSub.test("TASK-01."), "TASK-01. should not match (trailing dot)");
		assert(!TASK_ID_PATTERNS.taskSub.test("TASK-1.1"), "TASK-1.1 should not match (short parent)");
	});

	await runner.test("matches discovered and fix task IDs", () => {
		assert(TASK_ID_PATTERNS.any.test("DISC-01"), "DISC-01 should match");
		assert(TASK_ID_PATTERNS.any.test("FIX-01"), "FIX-01 should match");
		assert(TASK_ID_PATTERNS.any.test("DISC-99"), "DISC-99 should match");
	});

	await runner.test("matches task headers", () => {
		assert(TASK_ID_PATTERNS.header.test("## TASK-01: Create auth types"), "Header should match");
		assert(TASK_ID_PATTERNS.header.test("## TASK-01.1: Subtask"), "Subtask header should match");
		assert(TASK_ID_PATTERNS.header.test("## DISC-01: Discovered task"), "DISC header should match");
	});

	// ─────────────────────────────────────────────────────────────────────────
	// parseSpec - Valid Specs
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("parseSpec - Valid Specs");

	await runner.test("parses simple spec", () => {
		const content = loadFixture("valid-simple.md");
		const spec = parseSpec(content);

		assertEqual(spec.title, "Simple Auth Feature");
		assertEqual(spec.tasks.length, 2);

		// Check first task
		assertEqual(spec.tasks[0].id, "TASK-01");
		assertEqual(spec.tasks[0].title, "Create auth types");
		assertEqual(spec.tasks[0].priority, "P1");
		assert(spec.tasks[0].files.some(f => f.path.includes("types.ts")), "Should have types.ts file");
		assertEqual(spec.tasks[0].dependsOn.length, 0);
		assert(spec.tasks[0].acceptance?.includes("User") || spec.tasks[0].acceptance?.includes("Token"), "Should mention User or Token");

		// Check second task
		assertEqual(spec.tasks[1].id, "TASK-02");
		assert(spec.tasks[1].dependsOn.includes("TASK-01"), "Should depend on TASK-01");
	});

	await runner.test("parses spec with subtasks", () => {
		const content = loadFixture("valid-with-subtasks.md");
		const spec = parseSpec(content);

		assertEqual(spec.tasks.length, 5);

		// Check subtasks
		const subtask1 = spec.tasks.find(t => t.id === "TASK-02.1");
		const subtask2 = spec.tasks.find(t => t.id === "TASK-02.2");
		assertExists(subtask1, "TASK-02.1 should exist");
		assertExists(subtask2, "TASK-02.2 should exist");
		assertEqual(subtask1!.parentTaskId, "TASK-02");
		assertEqual(subtask2!.parentTaskId, "TASK-02");
	});

	await runner.test("parses spec with multiple dependencies", () => {
		const content = loadFixture("valid-with-deps.md");
		const spec = parseSpec(content);

		// TASK-06 depends on both TASK-04 and TASK-05
		const task6 = spec.tasks.find(t => t.id === "TASK-06");
		assertExists(task6, "TASK-06 should exist");
		assert(task6!.dependsOn.includes("TASK-04"), "Should depend on TASK-04");
		assert(task6!.dependsOn.includes("TASK-05"), "Should depend on TASK-05");
		assertEqual(task6!.dependsOn.length, 2);
	});

	await runner.test("parses priority field correctly", () => {
		const content = loadFixture("valid-with-deps.md");
		const spec = parseSpec(content);

		const p0Task = spec.tasks.find(t => t.id === "TASK-01");
		const p1Task = spec.tasks.find(t => t.id === "TASK-02");
		const p2Task = spec.tasks.find(t => t.id === "TASK-04");
		const p3Task = spec.tasks.find(t => t.id === "TASK-06");

		assertEqual(p0Task?.priority, "P0");
		assertEqual(p1Task?.priority, "P1");
		assertEqual(p2Task?.priority, "P2");
		assertEqual(p3Task?.priority, "P3");
	});

	await runner.test("parses files with annotations", () => {
		const content = loadFixture("valid-simple.md");
		const spec = parseSpec(content);

		const task1 = spec.tasks.find(t => t.id === "TASK-01");
		const task2 = spec.tasks.find(t => t.id === "TASK-02");

		assert(task1?.files.some(f => f.action === "modify"), "TASK-01 should have modify action");
		assert(task2?.files.some(f => f.action === "create"), "TASK-02 should have create action");
	});

	// ─────────────────────────────────────────────────────────────────────────
	// parseSpec - Edge Cases
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("parseSpec - Edge Cases");

	await runner.test("handles empty spec", () => {
		const spec = parseSpec("");
		assertEqual(spec.title, "");
		assertEqual(spec.tasks.length, 0);
	});

	await runner.test("handles spec with only title", () => {
		const spec = parseSpec("# My Project\n\nSome description.");
		assertEqual(spec.title, "My Project");
		assertEqual(spec.tasks.length, 0);
	});

	await runner.test("handles depends on: none", () => {
		const content = `
## TASK-01: First task
Priority: P1
Files: src/a.ts (create)
Depends on: none
Acceptance: Task is done
`;
		const spec = parseSpec(content);
		assertEqual(spec.tasks[0].dependsOn.length, 0);
	});

	await runner.test("handles multiple files on same line", () => {
		const content = `
## TASK-01: Multi-file task
Priority: P1
Files: src/a.ts (create), src/b.ts (modify), src/c.ts (delete)
Depends on: none
Acceptance: Task is done
`;
		const spec = parseSpec(content);
		assertEqual(spec.tasks[0].files.length, 3);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// parseSpec - Invalid Inputs
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("parseSpec - Invalid Inputs");

	await runner.test("parses spec with circular deps (parser doesn't validate)", () => {
		const content = loadFixture("invalid-circular.md");
		const spec = parseSpec(content);

		// Parser still parses - validation catches circular deps
		assertEqual(spec.tasks.length, 3);
		assert(spec.tasks[0].dependsOn.includes("TASK-03"), "Should have TASK-03 dependency");
	});

	await runner.test("skips invalid task IDs", () => {
		const content = loadFixture("invalid-bad-task-id.md");
		const spec = parseSpec(content);

		// Parser should not match invalid IDs
		const validTasks = spec.tasks.filter(t => TASK_ID_PATTERNS.any.test(t.id));
		assertEqual(validTasks.length, 0, "No tasks should have valid IDs");
	});

	// Print summary
	const { passed, failed } = runner.summary();
	process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
	console.error("Test suite failed:", err);
	process.exit(1);
});
