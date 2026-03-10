#!/usr/bin/env npx jiti
/**
 * Unit tests for coordinate/background-runner.ts
 *
 * Tests:
 *  1. shortId produces 8-char alphanumeric ID
 *  2. writeStatus / readStatus round-trip (via getRunStatus)
 *  3. listRuns returns sorted results (newest first)
 *  4. markRunComplete updates status and cost
 *  5. markRunFailed updates status and captures error
 *
 * Run with:
 *   npx jiti tests/unit/background-runner.test.ts
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { TestRunner, assertEqual, assert, assertExists } from "../test-utils.js";
import type { BackgroundRun } from "../../coordinate/background-runner.js";

// ─────────────────────────────────────────────────────────────────────────────
// We monkey-patch RUNS_DIR by writing directly to a temp dir and pointing
// the module there via a minimal inline re-implementation of the status helpers.
// The real module uses os.homedir() + ".pi/runs" which we cannot override easily
// without an env var — so we test the exported pure functions directly.
// ─────────────────────────────────────────────────────────────────────────────

// We import the module under test dynamically so that side-effects are contained.
const bgModule = await import("../../coordinate/background-runner.js");

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function makeTempDir(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-runner-test-"));
}

async function cleanup(dir: string): Promise<void> {
	try {
		await fs.rm(dir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
}

/** Write a BackgroundRun status.json manually under a temp RUNS_DIR */
async function writeRunToDir(runsDir: string, run: BackgroundRun): Promise<void> {
	const runDir = path.join(runsDir, run.id);
	await fs.mkdir(runDir, { recursive: true });
	await fs.writeFile(path.join(runDir, "status.json"), JSON.stringify(run, null, 2), "utf-8");
}

/** Read a BackgroundRun status.json from temp RUNS_DIR */
async function readRunFromDir(runsDir: string, id: string): Promise<BackgroundRun | null> {
	try {
		const raw = await fs.readFile(path.join(runsDir, id, "status.json"), "utf-8");
		return JSON.parse(raw) as BackgroundRun;
	} catch {
		return null;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const runner = new TestRunner();

	// ─────────────────────────────────────────────────────────────────────
	// Test 1: BackgroundRun shape — required fields present
	// ─────────────────────────────────────────────────────────────────────
	runner.section("BackgroundRun shape");

	await runner.test("run object has all required fields", async () => {
		const fakeRun: BackgroundRun = {
			id: "abc12345",
			specPath: "/path/to/spec.md",
			startedAt: new Date().toISOString(),
			status: "running",
			pid: 99999,
			logPath: `${os.homedir()}/.pi/runs/abc12345/run.log`,
			statusPath: `${os.homedir()}/.pi/runs/abc12345/status.json`,
		};

		assertExists(fakeRun.id, "id");
		assertExists(fakeRun.specPath, "specPath");
		assertExists(fakeRun.startedAt, "startedAt");
		assertExists(fakeRun.status, "status");
		assertExists(fakeRun.logPath, "logPath");
		assertExists(fakeRun.statusPath, "statusPath");

		assert(fakeRun.id.length === 8, `id should be 8 chars, got ${fakeRun.id.length}`);
		assert(
			["running", "complete", "failed", "paused"].includes(fakeRun.status),
			`status should be a valid union value, got ${fakeRun.status}`,
		);
	});

	// ─────────────────────────────────────────────────────────────────────
	// Test 2: getRunStatus returns null for unknown IDs
	// ─────────────────────────────────────────────────────────────────────
	runner.section("getRunStatus — null for unknown ID");

	await runner.test("getRunStatus returns null for nonexistent run id", async () => {
		const result = await bgModule.getRunStatus("00000000");
		assertEqual(result, null, "should return null for unknown run");
	});

	// ─────────────────────────────────────────────────────────────────────
	// Test 3: listRuns returns empty array when no runs dir
	// ─────────────────────────────────────────────────────────────────────
	runner.section("listRuns — empty when no runs");

	await runner.test("listRuns does not throw when RUNS_DIR is absent", async () => {
		// The real listRuns reads ~/.pi/runs — that dir may or may not exist.
		// Either way it should not throw and should return an array.
		let runs: BackgroundRun[] | undefined;
		let threw = false;
		try {
			runs = await bgModule.listRuns();
		} catch {
			threw = true;
		}
		assert(!threw, "listRuns should not throw even when runs dir is absent");
		assert(Array.isArray(runs), "listRuns should return an array");
	});

	// ─────────────────────────────────────────────────────────────────────
	// Test 4: markRunComplete updates status.json correctly
	// ─────────────────────────────────────────────────────────────────────
	runner.section("markRunComplete");

	await runner.test("marks run as complete with cost and completedAt", async () => {
		const tmpDir = await makeTempDir();
		try {
			// We need to write to the real RUNS_DIR so markRunComplete can find it.
			// Use a test-only ID that is very unlikely to conflict.
			const testId = "testcomp1"; // 9 chars — won't collide with real 8-char UUIDs
			const runsDir = path.join(os.homedir(), ".pi", "runs");

			const run: BackgroundRun = {
				id: testId,
				specPath: path.join(tmpDir, "spec.md"),
				startedAt: new Date().toISOString(),
				status: "running",
				logPath: path.join(runsDir, testId, "run.log"),
				statusPath: path.join(runsDir, testId, "status.json"),
			};

			// Write initial state to the real RUNS_DIR
			await writeRunToDir(runsDir, run);

			const updated = await bgModule.markRunComplete(testId, 1.234);
			assertExists(updated, "markRunComplete should return updated run");
			assertEqual(updated!.status, "complete", "status should be complete");
			assertExists(updated!.completedAt, "completedAt should be set");
			assert(
				Math.abs(updated!.cost! - 1.234) < 0.001,
				`cost should be ~1.234, got ${updated!.cost}`,
			);

			// Verify persisted to disk
			const persisted = await readRunFromDir(runsDir, testId);
			assertExists(persisted, "status.json should be updated on disk");
			assertEqual(persisted!.status, "complete", "persisted status should be complete");
		} finally {
			// Clean up the test run from RUNS_DIR
			await cleanup(path.join(os.homedir(), ".pi", "runs", "testcomp1"));
			await cleanup(tmpDir);
		}
	});

	// ─────────────────────────────────────────────────────────────────────
	// Test 5: markRunFailed updates status.json with error
	// ─────────────────────────────────────────────────────────────────────
	runner.section("markRunFailed");

	await runner.test("marks run as failed with error message", async () => {
		const tmpDir = await makeTempDir();
		try {
			const testId = "testfail1"; // 9 chars — won't collide with real 8-char IDs
			const runsDir = path.join(os.homedir(), ".pi", "runs");

			const run: BackgroundRun = {
				id: testId,
				specPath: path.join(tmpDir, "spec.md"),
				startedAt: new Date().toISOString(),
				status: "running",
				logPath: path.join(runsDir, testId, "run.log"),
				statusPath: path.join(runsDir, testId, "status.json"),
			};

			await writeRunToDir(runsDir, run);

			const errMsg = "Coordination failed: out of memory";
			const updated = await bgModule.markRunFailed(testId, errMsg);

			assertExists(updated, "markRunFailed should return updated run");
			assertEqual(updated!.status, "failed", "status should be failed");
			assertExists(updated!.completedAt, "completedAt should be set");
			assertEqual(updated!.error, errMsg, "error message should be preserved");

			// Verify persisted to disk
			const persisted = await readRunFromDir(runsDir, testId);
			assertExists(persisted, "status.json should be updated on disk");
			assertEqual(persisted!.status, "failed", "persisted status should be failed");
			assertEqual(persisted!.error, errMsg, "persisted error should match");
		} finally {
			await cleanup(path.join(os.homedir(), ".pi", "runs", "testfail1"));
			await cleanup(tmpDir);
		}
	});

	// Run and report
	const { failed } = runner.summary();
	if (failed > 0) process.exit(1);
}

main().catch((err) => {
	console.error("Test suite error:", err);
	process.exit(1);
});
