#!/usr/bin/env npx jiti
/**
 * Unit tests for coordinate/hitl-gate.ts
 *
 * Tests:
 *   1. requestApproval — returns true immediately when hitl is 'off'
 *   2. requestApproval — writes approval-request file to correct path
 *   3. requestApproval — returns true when response file has approved: true
 *   4. requestApproval — returns false when response file has approved: false
 *   5. requestApproval — returns false when timeout expires with no response
 *
 * Run: npx jiti tests/unit/hitl-gate.test.ts
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { TestRunner, assertEqual, assert, assertExists } from "../test-utils.js";
import {
	requestApproval,
	scoreTaskRisk,
	type HitlGateOptions,
	type ApprovalResponse,
} from "../../coordinate/hitl-gate.js";

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
	const runner = new TestRunner();

	runner.section("requestApproval");

	// ── Test 1 — hitl 'off' bypasses gate entirely ───────────────────────────
	await runner.test("returns true immediately when hitl is 'off'", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hitl-test-off-"));
		try {
			const result = await requestApproval({
				coordDir: tmpDir,
				taskId: "TASK-off",
				summary: "Should be skipped",
				hitl: "off",
			});

			assertEqual(result, true, "hitl='off' must return true");

			// The hitl/ subdirectory should NOT be created when hitl='off'
			try {
				await fs.access(path.join(tmpDir, "hitl"));
				throw new Error("hitl directory should NOT exist when hitl='off'");
			} catch (err: any) {
				if (err.message.includes("should NOT")) throw err;
				// Expected ENOENT — gate was properly skipped
			}
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	// ── Test 2 — writes approval-request file ────────────────────────────────
	await runner.test("writes approval-request JSON to hitl/<taskId>-approval-request.json", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hitl-test-write-"));
		try {
			// Start the gate with a short timeout so it doesn't hang; don't await yet.
			const approvalPromise = requestApproval({
				coordDir: tmpDir,
				taskId: "TASK-write",
				summary: "Verify file is created",
				hitl: "on",
				timeoutMs: 300,
				pollIntervalMs: 50,
			});

			// Give the async write a moment to complete before we check.
			await new Promise<void>((res) => setTimeout(res, 150));

			const requestPath = path.join(tmpDir, "hitl", "TASK-write-approval-request.json");
			let requestData: any;
			try {
				requestData = JSON.parse(await fs.readFile(requestPath, "utf-8"));
			} catch {
				await approvalPromise; // drain the promise before throwing
				throw new Error(`Expected request file at ${requestPath}`);
			}

			assertEqual(requestData.taskId, "TASK-write", "taskId must be written to file");
			assertEqual(requestData.summary, "Verify file is created", "summary must be written");
			assertExists(requestData.requestedAt, "requestedAt must be set");

			await approvalPromise; // let the timeout expire cleanly
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	// ── Test 3 — approved response ────────────────────────────────────────────
	await runner.test("returns true when response file has approved: true", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hitl-test-approved-"));
		try {
			// Pre-create the hitl dir and response file so the first poll finds it.
			const hitlDir = path.join(tmpDir, "hitl");
			await fs.mkdir(hitlDir, { recursive: true });

			const response: ApprovalResponse = {
				taskId: "TASK-approved",
				approved: true,
				respondedAt: Date.now(),
			};
			await fs.writeFile(
				path.join(hitlDir, "TASK-approved-approval-response.json"),
				JSON.stringify(response),
				"utf-8",
			);

			const result = await requestApproval({
				coordDir: tmpDir,
				taskId: "TASK-approved",
				summary: "Approve this action",
				hitl: "on",
				timeoutMs: 5000,
				pollIntervalMs: 50,
			});

			assertEqual(result, true, "Should return true when approved: true");
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	// ── Test 4 — denied response ──────────────────────────────────────────────
	await runner.test("returns false when response file has approved: false", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hitl-test-denied-"));
		try {
			const hitlDir = path.join(tmpDir, "hitl");
			await fs.mkdir(hitlDir, { recursive: true });

			const response: ApprovalResponse = {
				taskId: "TASK-denied",
				approved: false,
				comment: "Not permitted",
				respondedAt: Date.now(),
			};
			await fs.writeFile(
				path.join(hitlDir, "TASK-denied-approval-response.json"),
				JSON.stringify(response),
				"utf-8",
			);

			const result = await requestApproval({
				coordDir: tmpDir,
				taskId: "TASK-denied",
				summary: "This should be denied",
				hitl: "on",
				timeoutMs: 5000,
				pollIntervalMs: 50,
			});

			assertEqual(result, false, "Should return false when approved: false");
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	// ── Test 5 — timeout with no response ─────────────────────────────────────
	await runner.test("returns false when timeout expires with no response", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hitl-test-timeout-"));
		try {
			const result = await requestApproval({
				coordDir: tmpDir,
				taskId: "TASK-timeout",
				summary: "Nobody will respond to this",
				hitl: "on",
				timeoutMs: 150,
				pollIntervalMs: 50,
			});

			assertEqual(result, false, "Should return false on timeout");
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	// ─────────────────────────────────────────────────────────────────────────
	// scoreTaskRisk — false positive regression tests
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("scoreTaskRisk — false positive regression");

	await runner.test("'Truncate tool output to 4096 chars' is LOW, not HIGH", async () => {
		const risk = scoreTaskRisk("Fix timeout status overwrite, empty finalOutput, tool JSON parse error handling. Truncate tool output to 4096 chars max.");
		assertEqual(risk, "low", "Programming truncate should be low risk");
	});

	await runner.test("'TRUNCATE TABLE users' is still CRITICAL", async () => {
		const risk = scoreTaskRisk("Run TRUNCATE TABLE users to clear test data");
		assertEqual(risk, "critical", "SQL TRUNCATE TABLE should be critical");
	});

	await runner.test("'truncate the data' is still HIGH", async () => {
		const risk = scoreTaskRisk("truncate the data in the staging schema");
		assertEqual(risk, "high", "truncate + data context should be high");
	});

	await runner.test("test description with 'noise/delete' is LOW", async () => {
		const risk = scoreTaskRisk("Add tests for noise/tune, noise/delete, escalate status, concurrent guard. Unit test coverage for review findings.");
		assertEqual(risk, "low", "Test descriptions mentioning delete should be low risk");
	});

	await runner.test("'delete the production database' is still CRITICAL", async () => {
		const risk = scoreTaskRisk("delete the production database");
		assertEqual(risk, "critical", "Deleting production should be critical");
	});

	await runner.test("'delete monitor when noise confidence > 0.8' is LOW (code logic)", async () => {
		const risk = scoreTaskRisk("Review and check delete monitor logic when noise confidence exceeds threshold");
		assertEqual(risk, "low", "Code-level delete logic in review context should be low");
	});

	await runner.test("'truncate tool output' with 'no schema changes' 340 chars apart is LOW", async () => {
		const risk = scoreTaskRisk(
			"## Logic — Fix AgentExecutor State Machine\n" +
			"### ERD\n- **Entities:** AgentSession (status field behavior change)\n- No schema changes\n" +
			"### Backend Mapping\n" +
			"| `src/services/agent/executor.ts` | 1) Guard complete() with timedOut flag. " +
			"2) Capture lastResponseContent fallback. 3) On JSON parse fail, append error as tool result " +
			"instead of empty args. 4) Truncate tool output to 4096 chars |"
		);
		assertEqual(risk, "low", "truncate + schema in distant paragraphs should be low");
	});

	await runner.test("'delete monitor' in code review context is LOW", async () => {
		const risk = scoreTaskRisk(
			"Review and analyze the triage action paths: fix_pr, tune_monitor, delete_monitor, escalate, none. " +
			"Check each branch for correctness."
		);
		assertEqual(risk, "low", "delete_monitor in review context should be low");
	});

	await runner.test("'drop table users in production' is still CRITICAL (proximity)", async () => {
		const risk = scoreTaskRisk("We need to drop table users in production to reset the schema");
		assertEqual(risk, "critical", "drop + production nearby should be critical");
	});

	await runner.test("'delete' far from 'production' in long description is LOW", async () => {
		const risk = scoreTaskRisk(
			"## Task: Add unit tests for delete_monitor path in triage service.\n" +
			"### ERD\n- No schema changes. No production impact.\n" +
			"### Backend Mapping\n" +
			"Review test coverage for all triage action branches."
		);
		assertEqual(risk, "low", "delete in test context + production far away = low");
	});

	await runner.test("'destroy the production database' is CRITICAL (words near each other)", async () => {
		const risk = scoreTaskRisk("destroy the production database and all backups");
		assertEqual(risk, "critical", "destroy + production nearby = critical");
	});

	await runner.test("'truncate data in staging' is HIGH (words near each other)", async () => {
		const risk = scoreTaskRisk("truncate data in the staging environment");
		assertEqual(risk, "high", "truncate + data nearby = high");
	});

	// ─────────────────────────────────────────────────────────────────────────
	const { failed } = runner.summary();
	if (failed > 0) process.exit(1);
}

main().catch((err) => {
	console.error("Unexpected error:", err);
	process.exit(1);
});
