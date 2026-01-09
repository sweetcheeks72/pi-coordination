#!/usr/bin/env npx jiti
/**
 * Observability Integration Tests
 * 
 * Run with: npx jiti tests/observability.test.ts
 * 
 * These tests validate observability data readers and event parsing.
 * 
 * For full E2E tests with actual LLM calls, use:
 *   pi "coordinate({ plan: 'tests/fixtures/spec.md', costLimit: 0.50 })"
 * Then inspect the coordination directory.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
	TestRunner,
	readExecutionInfo,
	readEvents,
	getPhaseEvents,
	getCostFromEvents,
	cleanupOldTestDirs,
	createTestCoordDir,
	assertEqual,
	assertExists,
	assertContains,
	Keys,
} from "./test-utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Create a mock execution-info.json for testing observability readers
 */
function createMockExecutionInfo(coordDir: string, info: Partial<ReturnType<typeof readExecutionInfo>>): void {
	const fullInfo = {
		mode: "spec" as const,
		skipScout: true,
		skipPlanner: true,
		taskCount: 2,
		timestamp: Date.now(),
		...info,
	};
	fs.writeFileSync(path.join(coordDir, "execution-info.json"), JSON.stringify(fullInfo, null, 2));
}

/**
 * Create mock events.jsonl for testing observability readers
 */
function createMockEvents(coordDir: string, events: Array<Record<string, unknown>>): void {
	const lines = events.map(e => JSON.stringify({ timestamp: Date.now(), ...e }));
	fs.writeFileSync(path.join(coordDir, "events.jsonl"), lines.join("\n"));
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
	const runner = new TestRunner();
	
	// Cleanup old test dirs first
	console.log("Cleaning up old test directories...");
	const cleanup = cleanupOldTestDirs();
	if (cleanup.deleted.length > 0) {
		console.log(`  Deleted ${cleanup.deleted.length} old directories`);
	}
	console.log(`  Kept ${cleanup.kept.length} recent directories\n`);
	
	// ─────────────────────────────────────────────────────────────────────────
	// Observability readers
	// ─────────────────────────────────────────────────────────────────────────
	
	runner.section("Observability Readers");
	
	await runner.test("readExecutionInfo parses valid JSON", () => {
		const coordDir = createTestCoordDir("execution-reader");
		createMockExecutionInfo(coordDir, {
			mode: "spec",
			skipScout: true,
			skipPlanner: true,
			taskCount: 5,
		});
		
		const info = readExecutionInfo(coordDir);
		assertExists(info, "Should read execution info");
		assertEqual(info!.mode, "spec");
		assertEqual(info!.skipScout, true);
		assertEqual(info!.skipPlanner, true);
		assertEqual(info!.taskCount, 5);
		
		return { coordDir };
	});
	
	await runner.test("readExecutionInfo returns null for missing file", () => {
		const coordDir = createTestCoordDir("execution-missing");
		const info = readExecutionInfo(coordDir);
		assertEqual(info, null);
		return { coordDir };
	});
	
	await runner.test("readEvents parses JSONL", () => {
		const coordDir = createTestCoordDir("events-reader");
		createMockEvents(coordDir, [
			{ type: "phase_started", phase: "coordinator" },
			{ type: "phase_completed", phase: "coordinator" },
			{ type: "phase_started", phase: "review" },
		]);
		
		const events = readEvents(coordDir);
		assertEqual(events.length, 3);
		assertEqual(events[0].type, "phase_started");
		assertEqual(events[0].phase, "coordinator");
		
		return { coordDir };
	});
	
	await runner.test("readEvents handles malformed lines", () => {
		const coordDir = createTestCoordDir("events-malformed");
		fs.mkdirSync(coordDir, { recursive: true });
		fs.writeFileSync(path.join(coordDir, "events.jsonl"), 
			'{"type": "valid"}\n' +
			'not json\n' +
			'{"type": "also_valid"}\n'
		);
		
		const events = readEvents(coordDir);
		assertEqual(events.length, 2); // Skips malformed line
		
		return { coordDir };
	});
	
	await runner.test("getPhaseEvents categorizes correctly", () => {
		const coordDir = createTestCoordDir("phase-events");
		createMockEvents(coordDir, [
			{ type: "phase_started", phase: "coordinator" },
			{ type: "phase_completed", phase: "coordinator" },
			{ type: "phase_skipped", phase: "scout" },
			{ type: "phase_started", phase: "review" },
		]);
		
		const phases = getPhaseEvents(coordDir);
		assertContains(phases.started, "coordinator");
		assertContains(phases.started, "review");
		assertContains(phases.completed, "coordinator");
		assertContains(phases.skipped, "scout");
		
		return { coordDir };
	});
	
	await runner.test("getCostFromEvents finds latest cost", () => {
		const coordDir = createTestCoordDir("cost-events");
		createMockEvents(coordDir, [
			{ type: "cost_updated", total: 0.10 },
			{ type: "other_event" },
			{ type: "cost_updated", total: 0.25 },
			{ type: "cost_updated", total: 0.42 },
		]);
		
		const cost = getCostFromEvents(coordDir);
		assertEqual(cost, 0.42);
		
		return { coordDir };
	});
	
	// ─────────────────────────────────────────────────────────────────────────
	// Mock stdin tests (TUI behavior)
	// ─────────────────────────────────────────────────────────────────────────
	
	runner.section("Mock Stdin");
	
	await runner.test("Keys constants are correct", () => {
		assertEqual(Keys.ENTER, "\r");
		assertEqual(Keys.ESC, "\x1b");
		assertEqual(Keys.UP, "\x1b[A");
		assertEqual(Keys.DOWN, "\x1b[B");
		assertEqual(Keys.TAB, "\t");
	});
	
	// Print summary
	const { passed, failed } = runner.summary();
	
	// Instructions for full E2E tests
	console.log(`
─────────────────────────────────────────────────────────────
  Full E2E Testing (manual, uses LLM)
─────────────────────────────────────────────────────────────
  Run these commands to test actual coordination:

  # Test with a valid spec
  pi "coordinate({ plan: 'tests/fixtures/spec.md', costLimit: 0.50 })"

  Then inspect the coordination directory for execution-info.json and events.jsonl
`);
	
	process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
	console.error("Test suite failed:", err);
	process.exit(1);
});
