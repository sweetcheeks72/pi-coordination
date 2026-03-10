#!/usr/bin/env npx jiti
/**
 * Unit tests for the compiler feedback loop (auto-repair).
 *
 * Tests cover:
 *   1. runAutoRepair — skip when no TS files and no tsconfig/package.json
 *   2. runAutoRepair — returns success on first pass (no repair needed)
 *   3. runAutoRepair — calls spawnRepairWorker on failure, returns success after repair
 *   4. runAutoRepair — exhausts maxRetries, returns failure with finalError
 *   5. runAutoRepair — merges filesModified from repair worker output
 *   6. WorkerDisplayState — repairState field propagated by workerStateToDisplay
 *   7. renderWorkersCompact — shows "⟳" icon and "auto-repair N/M" label
 *
 * Run with: npx jiti tests/unit/auto-repair.test.ts
 *
 * @module
 */

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

import {
	TestRunner,
	assertEqual,
	assert,
	assertExists,
} from "../test-utils.js";

import { runAutoRepair, type RepairContext } from "../../coordinate/auto-repair.js";
import { workerStateToDisplay, renderWorkersCompact } from "../../coordinate/render-utils.js";
import type { WorkerStateFile } from "../../coordinate/types.js";
import type { Theme } from "@mariozechner/pi-coding-agent";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function makeTempDir(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "auto-repair-test-"));
}

/** Create a minimal tsconfig.json in a directory to trigger TS verification */
async function writeTsConfig(dir: string): Promise<void> {
	await fs.writeFile(
		path.join(dir, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: { strict: false, noEmit: true },
			include: ["**/*.ts"],
		}),
		"utf-8",
	);
}

/** Create a project that passes verification: package.json with a no-op test script */
async function writePassingProject(dir: string): Promise<void> {
	await fs.writeFile(
		path.join(dir, "package.json"),
		JSON.stringify({ name: "test-project", scripts: { test: "exit 0" } }),
		"utf-8",
	);
}

/**
 * Patch the runVerification function indirectly by providing a project directory
 * with no tsconfig/package.json (so verification is skipped).
 */
function makeNullCtx(overrides: Partial<RepairContext> = {}): RepairContext {
	return {
		taskId: "TASK-01",
		workerOutput: "some output",
		originalHandshakeSpec: "Do the thing",
		filesModified: [],
		coordDir: "/tmp/coord",
		cwd: "/tmp/no-project-here-xyz", // No tsconfig/package.json
		maxRetries: 3,
		spawnRepairWorker: async () => ({ exitCode: 0, filesModified: [] }),
		...overrides,
	};
}

/** Minimal theme for render tests */
const theme: Theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
};

/** Build a minimal WorkerStateFile for testing */
function makeWorkerState(overrides: Partial<WorkerStateFile> = {}): WorkerStateFile {
	return {
		id: "abc123",
		shortId: "abc1",
		identity: "worker:TASK-01-abc1",
		agent: "worker",
		status: "complete",
		currentFile: null,
		currentTool: null,
		waitingFor: null,
		assignedSteps: [1],
		completedSteps: [1],
		currentStep: null,
		handshakeSpec: "Create src/index.ts",
		startedAt: Date.now() - 5000,
		completedAt: Date.now(),
		usage: { input: 100, output: 200, cost: 0.01, turns: 5 },
		filesModified: ["src/index.ts"],
		blockers: [],
		errorType: null,
		errorMessage: null,
		...overrides,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

const runner = new TestRunner();

runner.section("runAutoRepair — skip conditions");

runner.test("returns success with 0 attempts when no TS files and no tsconfig/package.json", async () => {
	const ctx = makeNullCtx({
		filesModified: [], // no TS files
		// cwd has no tsconfig/package.json by default in makeNullCtx
	});

	const result = await runAutoRepair(ctx);

	assertEqual(result.success, true, "should succeed");
	assertEqual(result.attempts, 0, "should use 0 attempts (skipped entirely)");
	assert(result.finalError === undefined, "should have no finalError");
});

runner.test("returns success with 0 attempts when TS files exist but no tsconfig/package.json", async () => {
	const ctx = makeNullCtx({
		filesModified: ["src/auth.ts"], // TS file present
		// cwd still has no tsconfig/package.json → skip verification entirely
	});

	const result = await runAutoRepair(ctx);

	assertEqual(result.success, true, "should succeed");
	assertEqual(result.attempts, 0, "no verification — no tsconfig/package.json in cwd");
});

runner.section("runAutoRepair — success path (no repair needed)");

runner.test("returns success on first pass with no spawnRepairWorker calls", async () => {
	const cwd = await makeTempDir();
	try {
		await writePassingProject(cwd); // tsconfig.json exists but no errors

		let spawnCalled = 0;
		const ctx = makeNullCtx({
			cwd,
			filesModified: ["src/index.ts"],
			spawnRepairWorker: async () => {
				spawnCalled++;
				return { exitCode: 0, filesModified: [] };
			},
		});

		const result = await runAutoRepair(ctx);

		assertEqual(result.success, true, "should succeed");
		assertEqual(spawnCalled, 0, "repair worker should NOT be spawned when verification passes");
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

runner.section("runAutoRepair — repair loop");

runner.test("calls spawnRepairWorker once and returns success when repair fixes errors", async () => {
	// Use a mock verifier that fails on first call, passes on second call.
	// Need a cwd with a package.json so the early-return guard is bypassed.
	const cwd = await makeTempDir();
	try {
		await writePassingProject(cwd); // creates package.json

		let verifyCallCount = 0;
		let spawnCalled = 0;
		const ctx = makeNullCtx({
			cwd,
			filesModified: ["src/auth.ts"],
			verify: async () => {
				verifyCallCount++;
				if (verifyCallCount === 1) {
					return { passed: false, output: "error TS2322: Type 'string' is not assignable to type 'number'." };
				}
				return { passed: true, output: "" };
			},
			spawnRepairWorker: async (_prompt: string) => {
				spawnCalled++;
				return { exitCode: 0, filesModified: ["src/auth.ts"] };
			},
		});

		const result = await runAutoRepair(ctx);

		assertEqual(result.success, true, "should succeed after repair");
		assertEqual(spawnCalled, 1, "repair worker should be called exactly once");
		assertEqual(verifyCallCount, 2, "verify called once for initial check, once after repair");
		assert(result.attempts >= 1, "should report at least 1 attempt");
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

runner.test("exhausts maxRetries and returns failure with finalError", async () => {
	const cwd = await makeTempDir();
	try {
		// Persistent error that repair worker never fixes
		await writeTsConfig(cwd);
		await fs.writeFile(path.join(cwd, "bad.ts"), 'const x: number = "still broken";\n', "utf-8");

		let spawnCalled = 0;
		const ctx = makeNullCtx({
			cwd,
			filesModified: ["bad.ts"],
			maxRetries: 3,
			spawnRepairWorker: async () => {
				spawnCalled++;
				// Repair does nothing — error persists
				return { exitCode: 0, filesModified: [] };
			},
		});

		const result = await runAutoRepair(ctx);

		assertEqual(result.success, false, "should fail after exhausting retries");
		assertEqual(result.attempts, 3, "should report 3 attempts");
		assert(typeof result.finalError === "string" && result.finalError.length > 0, "should have finalError");
		// spawnRepairWorker called twice (on attempt 1 and 2, not on last attempt 3)
		assertEqual(spawnCalled, 2, "spawnRepairWorker called for attempts 1 and 2 only");
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

runner.test("merges filesModified from repair worker into context", async () => {
	const cwd = await makeTempDir();
	try {
		await writeTsConfig(cwd);
		await fs.writeFile(path.join(cwd, "bad.ts"), 'const x: number = "broken";\n', "utf-8");

		const ctx = makeNullCtx({
			cwd,
			filesModified: ["bad.ts"],
			maxRetries: 2,
			spawnRepairWorker: async () => {
				// Repair touches an additional file
				await fs.writeFile(path.join(cwd, "bad.ts"), "const x: number = 1;\n", "utf-8");
				return { exitCode: 0, filesModified: ["bad.ts", "src/extra.ts"] };
			},
		});

		await runAutoRepair(ctx);

		assert(ctx.filesModified.includes("src/extra.ts"), "extra.ts should be merged into filesModified");
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

runner.section("WorkerDisplayState — repairState propagation");

runner.test("workerStateToDisplay propagates repairState when present", () => {
	const w = makeWorkerState({
		repairState: { status: "running", attempt: 2, maxAttempts: 3 },
	});

	const display = workerStateToDisplay(w);

	assertExists(display.repairState, "repairState should be present");
	assertEqual(display.repairState!.status, "running", "status should match");
	assertEqual(display.repairState!.attempt, 2, "attempt should match");
	assertEqual(display.repairState!.maxAttempts, 3, "maxAttempts should match");
});

runner.test("workerStateToDisplay repairState is undefined when not set", () => {
	const w = makeWorkerState(); // no repairState
	const display = workerStateToDisplay(w);
	assert(display.repairState === undefined, "repairState should be undefined when absent");
});

runner.section("renderWorkersCompact — repair status display");

runner.test("shows ⟳ icon and auto-repair label for a worker with running repairState", () => {
	const workers = [
		{
			id: "abc1",
			shortId: "abc1",
			name: "swift_fox",
			status: "complete" as const, // status is complete but repair is running
			taskId: "TASK-02",
			taskTitle: "Fix auth middleware",
			tokens: undefined,
			contextPct: undefined,
			cost: 0.09,
			durationMs: 8 * 60 * 1000, // 8 minutes
			currentFile: null,
			currentTool: null,
			lastOutput: undefined,
			repairState: { status: "running" as const, attempt: 2, maxAttempts: 3 },
		},
	];

	const lines = renderWorkersCompact(workers, theme, 80);
	const allText = lines.join("\n");

	// The worker row should contain the repair icon and label
	assert(allText.includes("⟳"), `Expected ⟳ in output, got: ${allText}`);
	assert(allText.includes("auto-repair 2/3"), `Expected 'auto-repair 2/3', got: ${allText}`);
	assert(allText.includes("swift_fox"), `Expected worker name, got: ${allText}`);
});

runner.test("does not show ⟳ for worker without repairState", () => {
	const workers = [
		{
			id: "def2",
			shortId: "def2",
			name: "calm_hawk",
			status: "working" as const,
			taskId: "TASK-03",
			taskTitle: "Scout codebase",
			tokens: undefined,
			contextPct: undefined,
			cost: 0.04,
			durationMs: 4 * 60 * 1000,
			currentFile: null,
			currentTool: null,
			lastOutput: undefined,
			repairState: undefined,
		},
	];

	const lines = renderWorkersCompact(workers, theme, 80);
	const allText = lines.join("\n");

	assert(!allText.includes("⟳"), `Should not contain ⟳, got: ${allText}`);
	assert(!allText.includes("auto-repair"), `Should not contain 'auto-repair', got: ${allText}`);
});

// ─────────────────────────────────────────────────────────────────────────────

runner.summary();
