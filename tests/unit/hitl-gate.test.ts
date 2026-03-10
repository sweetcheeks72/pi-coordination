#!/usr/bin/env npx jiti
/**
 * Unit tests for HITL (Human-in-the-Loop) Permission Gates.
 *
 * Tests:
 *   1. detectHighStakesActions — strict mode detects all patterns
 *   2. detectHighStakesActions — permissive mode detects critical-only
 *   3. detectHighStakesActions — off mode returns empty
 *   4. buildGateQuestion — returns correct structure
 *   5. recordDecision + getDecisions — round-trip append-only log
 *   6. getHITLSummary — correct counts from decisions log
 *
 * Run with: npx jiti tests/unit/hitl-gate.test.ts
 */

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	TestRunner,
	assertEqual,
	assert,
	assertExists,
} from "../test-utils.js";

import {
	detectHighStakesActions,
	buildGateQuestion,
	recordDecision,
	getDecisions,
	getHITLSummary,
	HIGH_STAKES_PATTERNS,
	type HITLDecision,
} from "../../coordinate/hitl-gate.js";

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
	const runner = new TestRunner();

	// ─────────────────────────────────────────────────────────────────────────
	// Test 1 — strict mode detects ALL high-stakes patterns
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("detectHighStakesActions");

	await runner.test("strict mode detects all patterns", () => {
		const content = `
		git push origin main
		DROP TABLE users;
		rm -rf /tmp/data
		curl https://api.example.com -X POST
		npm publish
		run flyway migrate
	`;

		const matches = detectHighStakesActions(content, "strict");

		assert(matches.length >= 5, `Expected ≥5 patterns in strict mode, got ${matches.length}`);

		const labels = matches.map((m) => m.label);
		assert(labels.some((l) => l.includes("Push to protected branch")), "Missing: Push to protected branch");
		assert(labels.some((l) => l.includes("Destructive DB")), "Missing: Destructive DB operation");
		assert(labels.some((l) => l.includes("File deletion")), "Missing: File deletion");
		assert(labels.some((l) => l.includes("External API")), "Missing: External API write");
		assert(labels.some((l) => l.includes("Package publish")), "Missing: Package publish");
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Test 2 — permissive mode detects critical-only patterns (not high-severity)
	// ─────────────────────────────────────────────────────────────────────────

	await runner.test("permissive mode detects only critical patterns", () => {
		// rm -rf is HIGH severity → requiresApproval: ['strict'] only
		// git push main is CRITICAL → requiresApproval: ['strict', 'permissive']
		const contentWithHighAndCritical = `
		rm -rf /tmp/data
		git push origin production
	`;

		const matches = detectHighStakesActions(contentWithHighAndCritical, "permissive");
		const labels = matches.map((m) => m.label);

		// Should detect critical (Push to protected branch)
		assert(labels.some((l) => l.includes("Push to protected branch")), "Permissive should detect 'Push to protected branch' (critical)");

		// Should NOT detect high-only (File deletion is strict-only)
		assert(!labels.some((l) => l.includes("File deletion")), "Permissive should NOT flag file deletion (high-severity, strict-only)");
		assert(!labels.some((l) => l.includes("External API")), "Permissive should NOT flag external API write (high-severity, strict-only)");
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Test 3 — off mode returns empty regardless of content
	// ─────────────────────────────────────────────────────────────────────────

	await runner.test("off mode returns empty array", () => {
		const dangerousContent = `
		git push origin main
		DROP TABLE users;
		rm -rf /
		npm publish
	`;

		const matches = detectHighStakesActions(dangerousContent, "off");
		assertEqual(matches.length, 0, "off mode must return empty array");
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Test 4 — buildGateQuestion returns correct interview-compatible structure
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("buildGateQuestion");

	await runner.test("returns correct interview-compatible structure", () => {
		const pattern = HIGH_STAKES_PATTERNS.find((p) => p.label === "Push to protected branch")!;
		assertExists(pattern, "Pattern 'Push to protected branch' must exist in catalogue");

		const question = buildGateQuestion(
			pattern,
			"TASK-01",
			"worker-abc",
			"git push origin main",
		) as any;

		assertEqual(question.taskId, "TASK-01", "taskId must match");
		assertEqual(question.agentId, "worker-abc", "agentId must match");
		assertEqual(question.pattern.label, "Push to protected branch");
		assertEqual(question.pattern.severity, "critical");
		assertExists(question.createdAt, "createdAt must be set");
		assertExists(question.question, "question object must be present");

		// Interview-compatible: must have id, type, and options
		assertExists(question.question.id, "question.id must be set");
		assertEqual(question.question.type, "single", "question type must be 'single'");
		assert(
			Array.isArray(question.question.options) && question.question.options.length >= 2,
			"options must be an array with ≥2 entries",
		);

		// Must contain approve + reject options
		const optionValues = question.question.options.map((o: any) => o.value);
		assert(optionValues.includes("approved"), "options must include 'approved'");
		assert(optionValues.includes("rejected"), "options must include 'rejected'");
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Test 5 — recordDecision + getDecisions round-trip
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("recordDecision + getDecisions");

	await runner.test("append-only round-trip", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hitl-test-"));

		try {
			// Initially empty
			const emptyDecisions = await getDecisions(tmpDir);
			assertEqual(emptyDecisions.length, 0, "Empty coordDir must return []");

			const decision1: HITLDecision = {
				action: "git push origin main",
				pattern: "Push to protected branch",
				severity: "critical",
				taskId: "TASK-01",
				agentId: "worker-001",
				decision: "approved",
				decidedAt: new Date().toISOString(),
				decidedBy: "human",
			};

			const decision2: HITLDecision = {
				action: "npm publish",
				pattern: "Package publish",
				severity: "critical",
				taskId: "TASK-02",
				agentId: "worker-002",
				decision: "rejected",
				decidedAt: new Date().toISOString(),
				decidedBy: "human",
			};

			await recordDecision(tmpDir, decision1);
			await recordDecision(tmpDir, decision2);

			const decisions = await getDecisions(tmpDir);
			assertEqual(decisions.length, 2, "Should have 2 decisions after 2 appends");
			assertEqual(decisions[0].taskId, "TASK-01");
			assertEqual(decisions[0].decision, "approved");
			assertEqual(decisions[1].taskId, "TASK-02");
			assertEqual(decisions[1].decision, "rejected");

			// Verify file path convention
			const logPath = path.join(tmpDir, "audit", "hitl-decisions.jsonl");
			assert(fsSync.existsSync(logPath), "Log file must exist at audit/hitl-decisions.jsonl");
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
		return {};
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Test 6 — getHITLSummary returns correct counts
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("getHITLSummary");

	await runner.test("correct counts from decisions log", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hitl-summary-test-"));

		try {
			const decisions: HITLDecision[] = [
				{
					action: "git push origin main",
					pattern: "Push to protected branch",
					severity: "critical",
					taskId: "TASK-01",
					agentId: "worker-001",
					decision: "approved",
					decidedAt: new Date().toISOString(),
					decidedBy: "human",
				},
				{
					action: "npm publish",
					pattern: "Package publish",
					severity: "critical",
					taskId: "TASK-02",
					agentId: "worker-001",
					decision: "rejected",
					decidedAt: new Date().toISOString(),
					decidedBy: "human",
				},
				{
					action: "DROP TABLE sessions",
					pattern: "Destructive DB operation",
					severity: "critical",
					taskId: "TASK-03",
					agentId: "worker-002",
					decision: "modified",
					modifiedAction: "TRUNCATE TABLE sessions",
					decidedAt: new Date().toISOString(),
					decidedBy: "human",
				},
			];

			for (const d of decisions) {
				await recordDecision(tmpDir, d);
			}

			const summary = await getHITLSummary(tmpDir, "permissive");

			assertEqual(summary.mode, "permissive", "mode must match");
			assertEqual(summary.approved, 1, "approved count must be 1");
			assertEqual(summary.rejected, 1, "rejected count must be 1");
			assertEqual(summary.modified, 1, "modified count must be 1");
			assertEqual(summary.pending, 0, "pending count must be 0 (no gate files)");
			assert(summary.gatesTriggered >= 3, `gatesTriggered must be ≥3, got ${summary.gatesTriggered}`);
			assert(summary.logPath.endsWith("hitl-decisions.jsonl"), "logPath must point to decisions file");
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
		return {};
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Print summary
	// ─────────────────────────────────────────────────────────────────────────

	const { failed } = runner.summary();
	if (failed > 0) {
		process.exit(1);
	}
}

main().catch((err) => {
	console.error("Unexpected error:", err);
	process.exit(1);
});
