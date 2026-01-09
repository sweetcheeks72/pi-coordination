#!/usr/bin/env npx jiti
/**
 * Unit tests for spec validator.
 *
 * Run with: npx jiti tests/unit/spec-validator.test.ts
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

// Import the spec parser and validator
import { parseSpec } from "../../extensions/coordination/coordinate/spec-parser.js";
import { validateSpec, formatValidationResult } from "../../extensions/coordination/coordinate/spec-validator.js";

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, "..", "fixtures", "specs");

function loadAndParse(name: string) {
	const content = fs.readFileSync(path.join(FIXTURES_DIR, name), "utf-8");
	return parseSpec(content);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
	const runner = new TestRunner();

	// ─────────────────────────────────────────────────────────────────────────
	// Valid Specs
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("validateSpec - Valid Specs");

	await runner.test("validates simple spec", () => {
		const spec = loadAndParse("valid-simple.md");
		const result = validateSpec(spec);

		assertEqual(result.valid, true);
		assertEqual(result.errors.length, 0);
	});

	await runner.test("validates spec with subtasks", () => {
		const spec = loadAndParse("valid-with-subtasks.md");
		const result = validateSpec(spec);

		assertEqual(result.valid, true);
		assertEqual(result.errors.length, 0);
	});

	await runner.test("validates spec with multiple dependencies", () => {
		const spec = loadAndParse("valid-with-deps.md");
		const result = validateSpec(spec);

		assertEqual(result.valid, true);
		assertEqual(result.errors.length, 0);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Circular Dependencies
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("validateSpec - Circular Dependencies");

	await runner.test("detects circular dependencies", () => {
		const spec = loadAndParse("invalid-circular.md");
		const result = validateSpec(spec);

		assertEqual(result.valid, false);
		assert(
			result.errors.some(e => e.code === "CIRCULAR_DEPENDENCY"),
			"Should have CIRCULAR_DEPENDENCY error"
		);
	});

	await runner.test("provides helpful cycle description", () => {
		const spec = loadAndParse("invalid-circular.md");
		const result = validateSpec(spec);

		const cycleError = result.errors.find(e => e.code === "CIRCULAR_DEPENDENCY");
		assertExists(cycleError, "Should have cycle error");
		assert(cycleError!.message.includes("TASK-"), "Error should mention task IDs");
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Missing Dependencies
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("validateSpec - Missing Dependencies");

	await runner.test("detects missing dependency references", () => {
		const spec = parseSpec(`
## TASK-01: First task
Priority: P1
Files: src/a.ts (create)
Depends on: TASK-99
Acceptance: Task is done
`);
		const result = validateSpec(spec);

		assertEqual(result.valid, false);
		assert(
			result.errors.some(e => e.code === "MISSING_DEPENDENCY"),
			"Should have MISSING_DEPENDENCY error"
		);
	});

	await runner.test("provides helpful error for missing dependency", () => {
		const spec = parseSpec(`
## TASK-01: First task
Priority: P1
Files: src/a.ts (create)
Depends on: TASK-99
Acceptance: Task is done
`);
		const result = validateSpec(spec);

		const missingError = result.errors.find(e => e.code === "MISSING_DEPENDENCY");
		assertExists(missingError, "Should have missing dep error");
		assert(missingError!.message.includes("TASK-01") || missingError!.message.includes("TASK-99"), "Error should mention task IDs");
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Entry Point
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("validateSpec - Entry Point");

	await runner.test("requires at least one task with no dependencies", () => {
		const spec = parseSpec(`
## TASK-01: First task
Priority: P1
Files: src/a.ts (create)
Depends on: TASK-02
Acceptance: Task is done

## TASK-02: Second task
Priority: P1
Files: src/b.ts (create)
Depends on: TASK-01
Acceptance: Task is done
`);
		const result = validateSpec(spec);

		assertEqual(result.valid, false);
		assert(
			result.errors.some(e => e.code === "NO_ENTRY_POINT"),
			"Should have NO_ENTRY_POINT error"
		);
	});

	await runner.test("passes when entry point exists", () => {
		const spec = parseSpec(`
## TASK-01: First task
Priority: P1
Files: src/a.ts (create)
Depends on: none
Acceptance: Task is done

## TASK-02: Second task
Priority: P1
Files: src/b.ts (create)
Depends on: TASK-01
Acceptance: Task is done
`);
		const result = validateSpec(spec);

		assertEqual(result.valid, true);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Empty Spec
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("validateSpec - Empty Spec");

	await runner.test("rejects spec with no tasks", () => {
		const spec = parseSpec("# My Project\n\nJust a description.");
		const result = validateSpec(spec);

		assertEqual(result.valid, false);
		assert(
			result.errors.some(e => e.code === "NO_TASKS"),
			"Should have NO_TASKS error"
		);
	});

	await runner.test("provides suggestion for empty spec", () => {
		const spec = parseSpec("# My Project");
		const result = validateSpec(spec);

		assertExists(result.suggestion, "Should have suggestion");
		assert(result.suggestion!.includes("plan"), "Suggestion should mention plan tool");
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Warnings
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("validateSpec - Warnings");

	await runner.test("warns about missing files", () => {
		const spec = loadAndParse("invalid-missing-files.md");
		const result = validateSpec(spec);

		// Should be warning, not error
		assert(
			result.warnings.some(w => w.code === "MISSING_FILES"),
			"Should have MISSING_FILES warning"
		);
	});

	await runner.test("warns about missing acceptance criteria", () => {
		const spec = parseSpec(`
## TASK-01: First task
Priority: P1
Files: src/a.ts (create)
Depends on: none
`);
		const result = validateSpec(spec);

		assert(
			result.warnings.some(w => w.code === "MISSING_ACCEPTANCE"),
			"Should have MISSING_ACCEPTANCE warning"
		);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Duplicate IDs
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("validateSpec - Duplicate IDs");

	await runner.test("detects duplicate task IDs", () => {
		const spec = parseSpec(`
## TASK-01: First task
Priority: P1
Files: src/a.ts (create)
Depends on: none
Acceptance: Task is done

## TASK-01: Duplicate task
Priority: P1
Files: src/b.ts (create)
Depends on: none
Acceptance: Task is done
`);
		const result = validateSpec(spec);

		assertEqual(result.valid, false);
		assert(
			result.errors.some(e => e.code === "DUPLICATE_TASK_ID"),
			"Should have DUPLICATE_TASK_ID error"
		);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// formatValidationResult
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("formatValidationResult");

	await runner.test("formats valid result", () => {
		const spec = loadAndParse("valid-simple.md");
		const result = validateSpec(spec);
		const formatted = formatValidationResult(result);

		assert(formatted.includes("valid") || formatted.includes("Valid") || formatted.includes("✓"), "Should indicate valid");
	});

	await runner.test("formats errors", () => {
		const spec = parseSpec("# Empty");
		const result = validateSpec(spec);
		const formatted = formatValidationResult(result);

		assert(formatted.includes("NO_TASKS") || formatted.includes("Error") || formatted.includes("error"), "Should mention error");
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Integration
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("Integration");

	await runner.test("full roundtrip: parse then validate all valid fixtures", () => {
		const validFixtures = ["valid-simple.md", "valid-with-subtasks.md", "valid-with-deps.md"];
		
		for (const fixture of validFixtures) {
			const content = fs.readFileSync(path.join(FIXTURES_DIR, fixture), "utf-8");
			const spec = parseSpec(content);
			const result = validateSpec(spec);
			
			assert(result.valid, `${fixture} should be valid`);
			assertEqual(result.errors.length, 0, `${fixture} should have no errors`);
		}
	});

	await runner.test("validates subtask parent references", () => {
		const spec = loadAndParse("valid-with-subtasks.md");
		const result = validateSpec(spec);

		// Subtasks should have valid parent references
		const subtasks = spec.tasks.filter(t => t.parentTaskId);
		for (const subtask of subtasks) {
			const parentExists = spec.tasks.some(t => t.id === subtask.parentTaskId);
			assert(parentExists, `Parent ${subtask.parentTaskId} should exist for ${subtask.id}`);
		}

		assertEqual(result.valid, true);
	});

	// Print summary
	const { passed, failed } = runner.summary();
	process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
	console.error("Test suite failed:", err);
	process.exit(1);
});
