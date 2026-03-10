#!/usr/bin/env npx jiti
/**
 * Unit tests for the immutable audit log.
 *
 * Run with: npx jiti tests/unit/audit-log.test.ts
 *
 * @module
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { TestRunner, assertEqual, assert } from "../test-utils.js";
import { AuditLog, verifyAuditLog } from "../../coordinate/audit-log.js";
import type { AuditEvent } from "../../coordinate/audit-log.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-audit-test-"));
}

function readLines(logPath: string): AuditEvent[] {
	if (!fs.existsSync(logPath)) return [];
	const raw = fs.readFileSync(logPath, "utf8").trim();
	if (!raw) return [];
	return raw.split("\n").filter(Boolean).map(l => JSON.parse(l) as AuditEvent);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
	const runner = new TestRunner();

	// ─────────────────────────────────────────────────────────────────────────
	// Test 1: Basic append and JSONL output
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("AuditLog — basic append");

	await runner.test("creates audit directory and JSONL file on first append", () => {
		const coordDir = makeTempDir();
		const sessionId = "test-session-001";
		const log = new AuditLog(coordDir, sessionId);

		log.append({ type: "session.start", sessionId, agentRole: "coordinator" });

		const logPath = log.getLogPath();
		assert(fs.existsSync(logPath), `Log file should exist at ${logPath}`);
		assert(logPath.endsWith(`audit/${sessionId}.jsonl`), "Log path should be under audit/");

		const lines = readLines(logPath);
		assertEqual(lines.length, 1, "Should have 1 line after one append");
		assertEqual(lines[0].type, "session.start", "Event type should be session.start");
		assertEqual(lines[0].sessionId, sessionId, "Session ID should match");
		assertEqual(lines[0].seq, 1, "First event seq should be 1");
		assert(typeof lines[0].ts === "string" && lines[0].ts.length > 0, "ts should be a non-empty ISO string");
		assert(typeof lines[0].hash === "string" && lines[0].hash.length === 64, "hash should be 64-char hex");
	});

	await runner.test("monotonic sequence numbers across multiple appends", () => {
		const coordDir = makeTempDir();
		const sessionId = "test-session-002";
		const log = new AuditLog(coordDir, sessionId);

		log.append({ type: "session.start", sessionId });
		log.append({ type: "task.start", sessionId, taskId: "TASK-01", agentRole: "worker" });
		log.append({ type: "task.complete", sessionId, taskId: "TASK-01", agentRole: "worker", costUsd: 0.001 });
		log.append({ type: "session.complete", sessionId, costUsd: 0.005 });

		const lines = readLines(log.getLogPath());
		assertEqual(lines.length, 4, "Should have 4 events");
		assertEqual(lines[0].seq, 1, "First seq = 1");
		assertEqual(lines[1].seq, 2, "Second seq = 2");
		assertEqual(lines[2].seq, 3, "Third seq = 3");
		assertEqual(lines[3].seq, 4, "Fourth seq = 4");
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Test 2: Hash chain integrity
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("AuditLog — hash chain integrity");

	await runner.test("hash chain links each entry to the previous one", () => {
		const coordDir = makeTempDir();
		const sessionId = "test-session-003";
		const log = new AuditLog(coordDir, sessionId);

		log.append({ type: "session.start", sessionId });
		log.append({ type: "worker.dispatch", sessionId, agentRole: "worker", model: "claude-sonnet" });
		log.append({ type: "session.complete", sessionId, costUsd: 0.01 });

		const lines = readLines(log.getLogPath());

		// Verify the chain manually
		let prevHash = "0".repeat(64);
		for (const entry of lines) {
			const { hash, ...rest } = entry;
			const content = JSON.stringify(rest);
			const expected = createHash("sha256").update(prevHash + content).digest("hex");
			assertEqual(hash, expected, `Hash for seq ${entry.seq} should be sha256(prevHash + content)`);
			prevHash = hash;
		}
	});

	await runner.test("verify() returns { valid: true } for intact log", () => {
		const coordDir = makeTempDir();
		const sessionId = "test-session-004";
		const log = new AuditLog(coordDir, sessionId);

		log.append({ type: "session.start", sessionId });
		log.append({ type: "task.complete", sessionId, taskId: "TASK-01", agentRole: "worker" });
		log.append({ type: "session.complete", sessionId });

		const result = log.verify();
		assert(result.valid === true, "verify() should return valid: true for intact log");
		assert(result.invalidAt === undefined, "invalidAt should be undefined when valid");
	});

	await runner.test("verify() detects tampering and returns invalidAt", () => {
		const coordDir = makeTempDir();
		const sessionId = "test-session-005";
		const log = new AuditLog(coordDir, sessionId);

		log.append({ type: "session.start", sessionId });
		log.append({ type: "task.complete", sessionId, taskId: "TASK-01" });
		log.append({ type: "session.complete", sessionId });

		const logPath = log.getLogPath();
		const original = fs.readFileSync(logPath, "utf8");
		const lines = original.trim().split("\n");

		// Tamper with the second line: change the taskId
		const secondEntry = JSON.parse(lines[1]) as AuditEvent;
		secondEntry.taskId = "TASK-99"; // tampering
		lines[1] = JSON.stringify(secondEntry);
		fs.writeFileSync(logPath, lines.join("\n") + "\n");

		const result = log.verify();
		assert(result.valid === false, "verify() should return valid: false after tampering");
		assertEqual(result.invalidAt, 2, "invalidAt should point to the tampered seq (2)");
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Test 3: Edge cases
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("AuditLog — edge cases");

	await runner.test("verify() returns valid for empty log (no file)", () => {
		const coordDir = makeTempDir();
		const sessionId = "test-session-006";
		const log = new AuditLog(coordDir, sessionId);

		// Do NOT append anything
		const result = log.verify();
		assert(result.valid === true, "empty log should be valid");
	});

	await runner.test("count() returns correct event count", () => {
		const coordDir = makeTempDir();
		const sessionId = "test-session-007";
		const log = new AuditLog(coordDir, sessionId);

		assertEqual(log.count(), 0, "count() should be 0 for empty log");
		log.append({ type: "session.start", sessionId });
		assertEqual(log.count(), 1, "count() should be 1 after one append");
		log.append({ type: "session.complete", sessionId });
		assertEqual(log.count(), 2, "count() should be 2 after two appends");
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Test 4: verifyAuditLog helper
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("verifyAuditLog — exported async helper");

	await runner.test("verifyAuditLog returns true for intact log", async () => {
		const coordDir = makeTempDir();
		const sessionId = "test-session-008";
		const log = new AuditLog(coordDir, sessionId);

		log.append({ type: "session.start", sessionId });
		log.append({ type: "session.complete", sessionId });

		const result = await verifyAuditLog(coordDir, sessionId);
		assert(result === true, "verifyAuditLog should return true for intact log");
	});

	await runner.test("verifyAuditLog returns false for tampered log", async () => {
		const coordDir = makeTempDir();
		const sessionId = "test-session-009";
		const log = new AuditLog(coordDir, sessionId);

		log.append({ type: "session.start", sessionId });
		log.append({ type: "session.complete", sessionId, costUsd: 0.01 });

		// Tamper with the cost
		const logPath = log.getLogPath();
		const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
		const second = JSON.parse(lines[1]) as AuditEvent;
		second.costUsd = 0.0; // alter cost
		lines[1] = JSON.stringify(second);
		fs.writeFileSync(logPath, lines.join("\n") + "\n");

		const result = await verifyAuditLog(coordDir, sessionId);
		assert(result === false, "verifyAuditLog should return false for tampered log");
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Summary
	// ─────────────────────────────────────────────────────────────────────────

	runner.summary();
}

main().catch(err => {
	console.error("Test runner failed:", err);
	process.exit(1);
});
