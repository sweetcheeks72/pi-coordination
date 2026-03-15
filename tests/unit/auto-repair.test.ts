#!/usr/bin/env npx jiti
/**
 * Unit tests for coordinate/auto-repair.ts
 *
 * Tests:
 *   1. detectTestFailures — returns empty for all-passing test output
 *   2. detectTestFailures — detects Jest FAIL line as definitive
 *   3. detectTestFailures — detects "Tests: N failed" with correct failureCount
 *   4. detectTestFailures — detects Mocha "N failing" style
 *   5. detectTestFailures — detects tap "not ok N" as definitive
 *   6. detectTestFailures — ignores prose (false positive guard)
 *   7. shouldAutoRepair — returns true for definitive failure output
 *   8. shouldAutoRepair — returns true for counted failures only
 *   9. shouldAutoRepair — returns false for all-passing output
 *  10. shouldAutoRepair — returns false for empty string
 *  11. TEST_RESULT_REGEX — matches known Jest/Vitest summary patterns
 *  12. TEST_RESULT_REGEX — matches Mocha passing/failing patterns
 *  13. TEST_RESULT_REGEX — matches tap "not ok N" pattern
 *
 * Run: npx jiti tests/unit/auto-repair.test.ts
 */

import { TestRunner, assertEqual, assert, assertExists } from "../test-utils.js";
import {
	detectTestFailures,
	shouldAutoRepair,
	TEST_RESULT_REGEX,
	type RepairCandidate,
} from "../../coordinate/auto-repair.js";

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
	const runner = new TestRunner();

	// ── detectTestFailures ────────────────────────────────────────────────────
	runner.section("detectTestFailures");

	// Test 1 — clean passing output produces no candidates
	await runner.test("returns empty array for all-passing test output", () => {
		const output = [
			"PASS src/auth.test.ts",
			"PASS src/utils.test.ts",
			"Tests: 12 passed, 12 total",
			"Test Suites: 2 passed, 2 total",
		].join("\n");

		const candidates = detectTestFailures(output);
		assertEqual(candidates.length, 0, `Expected 0 candidates, got ${candidates.length}`);
	});

	// Test 2 — Jest FAIL line is definitive
	await runner.test("detects Jest FAIL line as definitive", () => {
		const output = "FAIL src/auth.test.ts\n  ● Auth › should reject invalid tokens";

		const candidates = detectTestFailures(output);
		assert(candidates.length >= 1, `Expected ≥1 candidate, got ${candidates.length}`);

		const fail = candidates.find((c) => c.rawOutput.startsWith("FAIL"));
		assertExists(fail, "Expected a FAIL candidate");
		assertEqual(fail!.definitive, true, "FAIL line must be definitive");
	});

	// Test 3 — "Tests: N failed" summary line
	await runner.test("detects 'Tests: 3 failed' summary with correct failureCount", () => {
		const output = "Tests: 3 failed, 9 passed, 12 total\nTest Suites: 1 failed, 1 total";

		const candidates = detectTestFailures(output);
		assert(candidates.length >= 1, `Expected ≥1 candidate, got ${candidates.length}`);

		const threeFailed = candidates.find((c) => c.failureCount === 3);
		assertExists(threeFailed, `Expected candidate with failureCount=3, got: ${JSON.stringify(candidates)}`);
	});

	// Test 4 — Mocha "N failing" style (no leading spaces, no runner prefix)
	await runner.test("detects Mocha '3 failing' output with correct failureCount", () => {
		// Mocha summary lines without leading spaces so the anchored regex matches
		const output = "12 passing (1s)\n3 failing\n\n1) Auth should reject:";

		const candidates = detectTestFailures(output);
		assert(candidates.length >= 1, `Expected ≥1 Mocha candidate, got ${candidates.length}`);

		const failing = candidates.find((c) => c.failureCount === 3);
		assertExists(failing, `Expected candidate with failureCount=3, got: ${JSON.stringify(candidates)}`);
	});

	// Test 5 — tap "not ok N" is definitive
	await runner.test("detects tap 'not ok N' as definitive", () => {
		const output = "ok 1 - first test\nnot ok 2 - second test failed\nok 3 - third test";

		const candidates = detectTestFailures(output);
		assert(candidates.length >= 1, `Expected ≥1 tap candidate, got ${candidates.length}`);

		const notOk = candidates.find((c) => /^not\s+ok\b/i.test(c.rawOutput));
		assertExists(notOk, "Expected a 'not ok' candidate");
		assertEqual(notOk!.definitive, true, "not ok must be definitive");
		assert(notOk!.failureCount >= 1, `failureCount should be ≥1, got ${notOk!.failureCount}`);
	});

	// Test 6 — prose false-positive guard
	await runner.test("does not flag prose that mentions 'failing' without a runner prefix", () => {
		const prose = [
			"I found that the failing tests in the auth module need attention.",
			"The worker failed to connect but that is expected behavior.",
			"Note: some tests might fail if the DB is unreachable.",
			"The 3 failing scenarios are documented in the README.",
		].join("\n");

		const candidates = detectTestFailures(prose);
		assertEqual(
			candidates.length,
			0,
			`Prose should produce 0 candidates, got ${candidates.length}: ${JSON.stringify(candidates)}`,
		);
	});

	// ── shouldAutoRepair ──────────────────────────────────────────────────────
	runner.section("shouldAutoRepair");

	// Test 7 — definitive FAIL triggers repair
	await runner.test("returns true for output containing a definitive FAIL line", () => {
		const output = "FAIL src/auth.test.ts\nTests: 2 failed, 8 passed";
		assertEqual(shouldAutoRepair(output), true, "Should return true for FAIL output");
	});

	// Test 8 — counted failures (non-definitive) also trigger repair
	await runner.test("returns true for output with a failure count (no FAIL prefix)", () => {
		const output = "Tests: 1 failed, 5 passed, 6 total";
		assertEqual(shouldAutoRepair(output), true, "Should return true when failureCount > 0");
	});

	// Test 9 — all-passing output
	await runner.test("returns false for all-passing test output", () => {
		const output = "Tests: 12 passed, 12 total\nTest Suites: 3 passed, 3 total";
		assertEqual(shouldAutoRepair(output), false, "Should return false for passing output");
	});

	// Test 10 — empty string
	await runner.test("returns false for empty string", () => {
		assertEqual(shouldAutoRepair(""), false, "Should return false for empty output");
	});

	// ── TEST_RESULT_REGEX ────────────────────────────────────────────────────
	runner.section("TEST_RESULT_REGEX");

	// Test 11 — Jest/Vitest patterns
	await runner.test("matches known Jest/Vitest summary patterns", () => {
		const patterns = [
			"PASS src/foo.test.ts",
			"FAIL src/bar.test.ts",
			"Tests: 3 failed, 12 passed",
			"Test Suites: 1 failed, 1 total",
			"Suites: 2 passed, 2 total",
		];
		for (const p of patterns) {
			assert(TEST_RESULT_REGEX.test(p), `Expected TEST_RESULT_REGEX to match: "${p}"`);
		}
	});

	// Test 12 — Mocha patterns
	await runner.test("matches Mocha passing/failing summary patterns", () => {
		const patterns = ["12 passing (1s)", "3 failing"];
		for (const p of patterns) {
			assert(TEST_RESULT_REGEX.test(p), `Expected TEST_RESULT_REGEX to match: "${p}"`);
		}
	});

	// Test 13 — tap pattern
	await runner.test("matches tap 'not ok N' pattern", () => {
		assert(TEST_RESULT_REGEX.test("not ok 1 - test failed"), "Should match 'not ok N'");
	});

	// ─────────────────────────────────────────────────────────────────────────
	const { failed } = runner.summary();
	if (failed > 0) process.exit(1);
}

main().catch((err) => {
	console.error("Unexpected error:", err);
	process.exit(1);
});
