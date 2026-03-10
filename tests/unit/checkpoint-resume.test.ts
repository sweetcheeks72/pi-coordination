#!/usr/bin/env npx jiti
/**
 * Unit tests for checkpoint/resume support in coordinate().
 *
 * Coverage:
 *   1. progress-tracker helpers (load, delete, findResumeCoordDir)
 *   2. TaskQueueManager writes progress.json on markTaskComplete / markTaskFailed
 *   3. progress.json schema shape
 *   4. specHash mismatch → null returned
 *   5. deleteProgressSnapshot removes the file
 *
 * Run with: npx jiti tests/unit/checkpoint-resume.test.ts
 *
 * @module
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { TestRunner, assertEqual, assert, assertExists } from "../test-utils.js";
import { TaskQueueManager } from "../../coordinate/task-queue.js";
import {
	loadProgressSnapshot,
	deleteProgressSnapshot,
	findResumeCoordDir,
	type ProgressSnapshot,
} from "../../coordinate/progress-tracker.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function makeTempDir(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "pi-coord-checkpoint-test-"));
}

async function cleanup(dir: string): Promise<void> {
	try {
		await fs.rm(dir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
}

/** Seed a tasks.json with two TASK-XX entries. */
async function seedTaskQueue(dir: string, planHash = "abc123"): Promise<TaskQueueManager> {
	const manager = new TaskQueueManager(dir);
	await manager.createFromPlan("/fake/plan.md", planHash, [
		{
			id: "TASK-01",
			description: "First task",
			priority: 1,
			status: "pending",
			files: [],
			dependsOn: [],
			acceptanceCriteria: [],
		},
		{
			id: "TASK-02",
			description: "Second task",
			priority: 2,
			status: "pending",
			files: [],
			dependsOn: ["TASK-01"],
			acceptanceCriteria: [],
		},
		{
			id: "TASK-03",
			description: "Third task",
			priority: 2,
			status: "pending",
			files: [],
			dependsOn: [],
			acceptanceCriteria: [],
		},
	]);
	return manager;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
	const runner = new TestRunner();

	// ─────────────────────────────────────────────────────────────────────────
	// Section 1: TaskQueueManager writes progress.json on markTaskComplete
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("TaskQueueManager — progress.json on markTaskComplete");

	await runner.test("progress.json is created after first task completes", async () => {
		const dir = await makeTempDir();
		try {
			const manager = await seedTaskQueue(dir, "hash001");

			// Claim and complete TASK-01
			await manager.claimTask("TASK-01", "worker-1");
			await manager.markTaskComplete("TASK-01", "worker-1");

			const progressPath = path.join(dir, "progress.json");
			const raw = await fs.readFile(progressPath, "utf-8");
			const snapshot = JSON.parse(raw) as ProgressSnapshot;

			// Schema shape
			assertExists(snapshot.specHash, "specHash present");
			assertExists(snapshot.specPath, "specPath present");
			assertExists(snapshot.startedAt, "startedAt present");
			assertExists(snapshot.lastCheckpointAt, "lastCheckpointAt present");
			assertEqual(snapshot.phase, "workers", "phase = workers");

			// Content
			assert(snapshot.completedTasks.includes("TASK-01"), "TASK-01 in completedTasks");
			assertEqual(snapshot.completedTasks.length, 1, "only one completed task");
			assertEqual(snapshot.failedTasks.length, 0, "no failed tasks");
		} finally {
			await cleanup(dir);
		}
	});

	await runner.test("progress.json accumulates completions across multiple tasks", async () => {
		const dir = await makeTempDir();
		try {
			const manager = await seedTaskQueue(dir, "hash002");

			await manager.claimTask("TASK-01", "worker-1");
			await manager.markTaskComplete("TASK-01", "worker-1");

			await manager.claimTask("TASK-03", "worker-2");
			await manager.markTaskComplete("TASK-03", "worker-2");

			const snapshot = JSON.parse(
				await fs.readFile(path.join(dir, "progress.json"), "utf-8"),
			) as ProgressSnapshot;

			assert(snapshot.completedTasks.includes("TASK-01"), "TASK-01 completed");
			assert(snapshot.completedTasks.includes("TASK-03"), "TASK-03 completed");
			assertEqual(snapshot.completedTasks.length, 2, "two completed tasks");
		} finally {
			await cleanup(dir);
		}
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Section 2: TaskQueueManager writes progress.json on markTaskFailed
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("TaskQueueManager — progress.json on markTaskFailed (permanent)");

	await runner.test("failed task appears in failedTasks after exhausting restarts", async () => {
		const dir = await makeTempDir();
		try {
			const manager = await seedTaskQueue(dir, "hash003");

			// maxRestarts = 1 so first failure is permanent
			await manager.claimTask("TASK-01", "worker-1");
			const willRetry = await manager.markTaskFailed("TASK-01", "test failure", 1);

			assert(!willRetry, "should not retry (maxRestarts=1)");

			const snapshot = JSON.parse(
				await fs.readFile(path.join(dir, "progress.json"), "utf-8"),
			) as ProgressSnapshot;

			assert(snapshot.failedTasks.includes("TASK-01"), "TASK-01 in failedTasks");
			assertEqual(snapshot.completedTasks.length, 0, "no completed tasks");
		} finally {
			await cleanup(dir);
		}
	});

	await runner.test("retriable failure does NOT add the task to failedTasks in progress.json", async () => {
		const dir = await makeTempDir();
		try {
			const manager = await seedTaskQueue(dir, "hash004");

			// First failure is retriable (default maxRestarts=2)
			await manager.claimTask("TASK-01", "worker-1");
			const willRetry = await manager.markTaskFailed("TASK-01", "transient error");

			assert(willRetry, "should retry");

			// progress.json is written at claim time (to record claimedTasks).
			// After a retriable failure the task returns to pending, so it should
			// NOT appear in failedTasks — only in claimedTasks (which will be
			// treated as retry-eligible on resume).
			const progressPath = path.join(dir, "progress.json");
			let snapshot: ProgressSnapshot | null = null;
			try {
				snapshot = JSON.parse(await fs.readFile(progressPath, "utf-8")) as ProgressSnapshot;
			} catch {
				// file may not exist — that's also acceptable
			}

			if (snapshot) {
				assertEqual(
					snapshot.failedTasks.length,
					0,
					"retriable failure should NOT appear in failedTasks",
				);
			}
		} finally {
			await cleanup(dir);
		}
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Section 3: loadProgressSnapshot
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("loadProgressSnapshot");

	await runner.test("returns null when progress.json does not exist", async () => {
		const dir = await makeTempDir();
		try {
			const result = await loadProgressSnapshot(dir, "anyHash");
			assertEqual(result, null, "should be null when file missing");
		} finally {
			await cleanup(dir);
		}
	});

	await runner.test("returns null on specHash mismatch", async () => {
		const dir = await makeTempDir();
		try {
			const manager = await seedTaskQueue(dir, "originalHash");
			await manager.claimTask("TASK-01", "worker-1");
			await manager.markTaskComplete("TASK-01", "worker-1");

			// progress.json now has specHash = "originalHash"
			const result = await loadProgressSnapshot(dir, "differentHash");
			assertEqual(result, null, "should return null on hash mismatch");
		} finally {
			await cleanup(dir);
		}
	});

	await runner.test("returns snapshot when specHash matches", async () => {
		const dir = await makeTempDir();
		try {
			const specHash = "matchingHash";
			const manager = await seedTaskQueue(dir, specHash);
			await manager.claimTask("TASK-01", "worker-1");
			await manager.markTaskComplete("TASK-01", "worker-1");

			const result = await loadProgressSnapshot(dir, specHash);
			assertExists(result, "should return snapshot on hash match");
			assert(result!.completedTasks.includes("TASK-01"), "TASK-01 in completedTasks");
		} finally {
			await cleanup(dir);
		}
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Section 4: deleteProgressSnapshot
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("deleteProgressSnapshot");

	await runner.test("removes progress.json and does not throw if missing", async () => {
		const dir = await makeTempDir();
		try {
			const manager = await seedTaskQueue(dir, "delHash");
			await manager.claimTask("TASK-01", "worker-1");
			await manager.markTaskComplete("TASK-01", "worker-1");

			// Confirm the file exists
			await fs.access(path.join(dir, "progress.json"));

			// Delete it
			await deleteProgressSnapshot(dir);

			// File should be gone
			let stillExists = false;
			try {
				await fs.access(path.join(dir, "progress.json"));
				stillExists = true;
			} catch {
				// expected
			}
			assert(!stillExists, "progress.json should be deleted");

			// Calling again (file missing) should not throw
			await deleteProgressSnapshot(dir);
		} finally {
			await cleanup(dir);
		}
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Section 5: findResumeCoordDir
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("findResumeCoordDir");

	await runner.test("returns null when no matching coordination dir exists", async () => {
		const sessionDir = await makeTempDir();
		try {
			await fs.mkdir(path.join(sessionDir, "coordination"), { recursive: true });
			const result = await findResumeCoordDir(sessionDir, "nonExistentHash");
			assertEqual(result, null, "should return null when no match");
		} finally {
			await cleanup(sessionDir);
		}
	});

	await runner.test("returns matching coordination dir path", async () => {
		const sessionDir = await makeTempDir();
		try {
			// Simulate a previous run's coordination dir
			const coordDir = path.join(sessionDir, "coordination", "run-abc123");
			await fs.mkdir(coordDir, { recursive: true });

			// Create a tasks.json so the TaskQueueManager has state
			const manager = new TaskQueueManager(coordDir);
			await manager.createFromPlan("/fake/plan.md", "targetHash", [
				{
					id: "TASK-01",
					description: "Test",
					priority: 1,
					status: "pending",
					files: [],
					dependsOn: [],
					acceptanceCriteria: [],
				},
			]);
			await manager.claimTask("TASK-01", "worker-1");
			await manager.markTaskComplete("TASK-01", "worker-1");

			// Patch the specHash in progress.json to match what we'll search for
			const progressPath = path.join(coordDir, "progress.json");
			const snapshot = JSON.parse(await fs.readFile(progressPath, "utf-8")) as ProgressSnapshot;
			snapshot.specHash = "targetHash";
			await fs.writeFile(progressPath, JSON.stringify(snapshot, null, 2));

			const found = await findResumeCoordDir(sessionDir, "targetHash");
			assertEqual(found, coordDir, "should return the matching coordination dir");
		} finally {
			await cleanup(sessionDir);
		}
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Section 6: NEW — claimedTasks persisted at claim time (Fix 2)
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("claimedTasks — persisted at claim time (Fix 2)");

	await runner.test("claimTask writes taskId to claimedTasks in progress.json", async () => {
		const dir = await makeTempDir();
		try {
			const manager = await seedTaskQueue(dir, "claimHash");

			// Claim TASK-01 — no complete/fail yet, just claimed
			const claimed = await manager.claimTask("TASK-01", "worker-1");
			assertExists(claimed, "claimTask should return the task");

			const progressPath = path.join(dir, "progress.json");
			const snapshot = JSON.parse(await fs.readFile(progressPath, "utf-8")) as ProgressSnapshot;

			assert(
				Array.isArray(snapshot.claimedTasks),
				"claimedTasks should be an array",
			);
			assert(
				snapshot.claimedTasks.includes("TASK-01"),
				"TASK-01 should appear in claimedTasks immediately after being claimed",
			);
			assertEqual(snapshot.completedTasks.length, 0, "no completedTasks yet");
		} finally {
			await cleanup(dir);
		}
	});

	await runner.test("after markTaskComplete, claimedTasks is empty and task moves to completedTasks", async () => {
		const dir = await makeTempDir();
		try {
			const manager = await seedTaskQueue(dir, "claimCompleteHash");

			await manager.claimTask("TASK-01", "worker-1");
			await manager.markTaskComplete("TASK-01", "worker-1");

			const progressPath = path.join(dir, "progress.json");
			const snapshot = JSON.parse(await fs.readFile(progressPath, "utf-8")) as ProgressSnapshot;

			assertEqual(
				snapshot.claimedTasks.length,
				0,
				"claimedTasks should be empty once the task is complete",
			);
			assert(snapshot.completedTasks.includes("TASK-01"), "TASK-01 in completedTasks");
		} finally {
			await cleanup(dir);
		}
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Section 7: NEW — loadProgressSnapshot merges claimedTasks on resume (Fix 2)
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("loadProgressSnapshot — claimed tasks re-queued on resume (Fix 2)");

	await runner.test("claimed (but not completed) task is merged into failedTasks on load", async () => {
		const dir = await makeTempDir();
		try {
			// Simulate a crashed run: write a progress.json that has a claimedTask
			// but NOT in completedTasks.
			const crashSnapshot: ProgressSnapshot = {
				specHash: "crashHash",
				specPath: "/fake/plan.md",
				startedAt: new Date().toISOString(),
				completedTasks: ["TASK-01"],
				failedTasks: [],
				claimedTasks: ["TASK-02"], // was in-progress when crash happened
				phase: "workers",
				lastCheckpointAt: new Date().toISOString(),
			};
			await fs.writeFile(
				path.join(dir, "progress.json"),
				JSON.stringify(crashSnapshot, null, 2),
			);

			const logs: string[] = [];
			const origLog = console.log;
			console.log = (...args: unknown[]) => logs.push(args.join(" "));

			let result: ProgressSnapshot | null = null;
			try {
				result = await loadProgressSnapshot(dir, "crashHash");
			} finally {
				console.log = origLog;
			}

			assertExists(result, "snapshot should be returned");
			assert(
				result!.failedTasks.includes("TASK-02"),
				"TASK-02 should be moved into failedTasks",
			);
			assert(
				!result!.failedTasks.includes("TASK-01"),
				"TASK-01 should NOT appear in failedTasks (it completed)",
			);
			assertEqual(result!.claimedTasks.length, 0, "claimedTasks cleared after merge");
			assert(
				logs.some((l) => l.includes("TASK-02") && l.includes("re-queuing")),
				"should log a re-queuing message for TASK-02",
			);
		} finally {
			await cleanup(dir);
		}
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Section 8: NEW — findResumeCoordDir warnings (Fix 1)
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("findResumeCoordDir — warnings on missing prior run (Fix 1)");

	await runner.test("warns when coordBase dir does not exist at all", async () => {
		const sessionDir = await makeTempDir();
		try {
			// Do NOT create sessionDir/coordination — simulates a brand-new session
			const warnings: string[] = [];
			const origWarn = console.warn;
			console.warn = (...args: unknown[]) => warnings.push(args.join(" "));

			let result: string | null = "sentinel";
			try {
				result = await findResumeCoordDir(sessionDir, "anyHash");
			} finally {
				console.warn = origWarn;
			}

			assertEqual(result, null, "should return null");
			assert(
				warnings.some((w) => w.includes("no prior run") || w.includes("starting fresh")),
				"should warn about no prior run",
			);
		} finally {
			await cleanup(sessionDir);
		}
	});

	await runner.test("warns when coordBase exists but no matching spec hash", async () => {
		const sessionDir = await makeTempDir();
		try {
			// Create an empty coordination dir — no subdirs with matching hash
			await fs.mkdir(path.join(sessionDir, "coordination"), { recursive: true });

			const warnings: string[] = [];
			const origWarn = console.warn;
			console.warn = (...args: unknown[]) => warnings.push(args.join(" "));

			let result: string | null = "sentinel";
			try {
				result = await findResumeCoordDir(sessionDir, "missingHash");
			} finally {
				console.warn = origWarn;
			}

			assertEqual(result, null, "should return null");
			assert(
				warnings.some((w) => w.includes("missingHash") || w.includes("starting fresh")),
				"should warn about no matching spec hash",
			);
		} finally {
			await cleanup(sessionDir);
		}
	});

	runner.summary();
}

main().catch((err) => {
	console.error("Test runner failed:", err);
	process.exit(1);
});
