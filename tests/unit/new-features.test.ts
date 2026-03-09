#!/usr/bin/env npx jiti
/**
 * Unit tests for the three highest-risk new features:
 *   1. task-queue addDiscoveredTask ENOENT fallback
 *   2. HANDRaiser question buffer filter (max-4, unanswered-only)
 *   3. renderQuestionBuffer output (box-drawing chars, [A]/[B] option chips)
 *
 * Run with: npx jiti tests/unit/new-features.test.ts
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

import { TaskQueueManager } from "../../coordinate/task-queue.js";
import { renderQuestionBuffer } from "../../coordinate/render-utils.js";
import type { Theme } from "@mariozechner/pi-coding-agent";

// ─────────────────────────────────────────────────────────────────────────────
// Theme mock — strips ANSI; returns plain text for assertions
// ─────────────────────────────────────────────────────────────────────────────

const mockTheme: Theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	dim: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	strikethrough: (text: string) => text,
} as unknown as Theme;

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

async function makeTempDir(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "pi-coord-test-"));
}

async function cleanup(dir: string): Promise<void> {
	try {
		await fs.rm(dir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
	const runner = new TestRunner();

	// ─────────────────────────────────────────────────────────────────────────
	// Test 1: task-queue addDiscoveredTask ENOENT fallback
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("task-queue addDiscoveredTask — ENOENT fallback");

	await runner.test("does not throw when tasks.json does not exist", async () => {
		const dir = await makeTempDir();
		try {
			const manager = new TaskQueueManager(dir);
			const tasksPath = path.join(dir, "tasks.json");

			// Confirm tasks.json does NOT exist yet (this is the RED scenario we're guarding)
			assert(
				!fsSync.existsSync(tasksPath),
				"Precondition: tasks.json must not exist before addDiscoveredTask",
			);

			// Call addDiscoveredTask — must NOT throw ENOENT
			const task = await manager.addDiscoveredTask({
				description: "Discovered test task",
				priority: 2,
				files: [],
				dependsOn: [],
			});

			// tasks.json should now be created
			assert(
				fsSync.existsSync(tasksPath),
				"tasks.json should have been created by addDiscoveredTask",
			);

			// The returned task should have an auto-generated ID
			assertExists(task.id, "Returned task should have an id");
			assert(task.id.startsWith("DISC-"), `Task id should start with DISC-, got: ${task.id}`);
			assertEqual(task.status, "pending_review", "Default status should be pending_review");

			// The file should contain exactly our task
			const raw = fsSync.readFileSync(tasksPath, "utf-8");
			const queue = JSON.parse(raw);
			assertEqual(queue.tasks.length, 1, "Queue should contain exactly 1 task");
			assertEqual(queue.tasks[0].id, task.id, "Persisted task id should match returned id");
		} finally {
			await cleanup(dir);
		}
	});

	await runner.test("creates second task with sequential ID", async () => {
		const dir = await makeTempDir();
		try {
			const manager = new TaskQueueManager(dir);

			const t1 = await manager.addDiscoveredTask({
				description: "First discovered task",
				priority: 2,
				files: [],
				dependsOn: [],
			});
			const t2 = await manager.addDiscoveredTask({
				description: "Second discovered task",
				priority: 1,
				files: [],
				dependsOn: [],
			});

			assertEqual(t1.id, "DISC-01", `First task id should be DISC-01, got: ${t1.id}`);
			assertEqual(t2.id, "DISC-02", `Second task id should be DISC-02, got: ${t2.id}`);

			const raw = fsSync.readFileSync(path.join(dir, "tasks.json"), "utf-8");
			const queue = JSON.parse(raw);
			assertEqual(queue.tasks.length, 2, "Queue should have 2 tasks");
		} finally {
			await cleanup(dir);
		}
	});

	await runner.test("uses existing queue when tasks.json already exists", async () => {
		const dir = await makeTempDir();
		try {
			const manager = new TaskQueueManager(dir);

			// Pre-populate the queue via createFromPlan
			await manager.createFromPlan("/fake/plan.md", "hash123", [
				{
					id: "TASK-01",
					description: "Pre-existing task",
					priority: 2,
					status: "pending",
					files: [],
					dependsOn: [],
				},
			]);

			// addDiscoveredTask should append, not overwrite
			const discovered = await manager.addDiscoveredTask({
				description: "Appended discovered task",
				priority: 3,
				files: [],
				dependsOn: [],
			});

			const raw = fsSync.readFileSync(path.join(dir, "tasks.json"), "utf-8");
			const queue = JSON.parse(raw);
			assertEqual(queue.tasks.length, 2, "Queue should have 2 tasks after append");
			assertEqual(queue.tasks[0].id, "TASK-01", "Pre-existing task should still be there");
			assertEqual(queue.tasks[1].id, discovered.id, "Discovered task should be appended");
		} finally {
			await cleanup(dir);
		}
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Test 2: HANDRaiser question buffer filter
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("HANDRaiser — question buffer filter");

	/**
	 * Mirror of the filter logic used in the question-buffering pattern:
	 *   events.filter(e => e.type === 'agent_question' && !e.answered)
	 * capped at max 4.
	 */
	interface MockEvent {
		type: string;
		question?: string;
		workerName?: string;
		answered?: boolean;
	}

	function filterQuestions(events: MockEvent[], maxCount = 4): MockEvent[] {
		return events
			.filter((e) => e.type === "agent_question" && !e.answered)
			.slice(0, maxCount);
	}

	await runner.test("filters to only agent_question events", () => {
		const events: MockEvent[] = [
			{ type: "phase_started", question: undefined },
			{ type: "agent_question", question: "Which approach?", workerName: "swift_fox", answered: false },
			{ type: "tool_call" },
			{ type: "agent_question", question: "What is the priority?", workerName: "calm_hawk", answered: false },
			{ type: "worker_completed" },
		];

		const filtered = filterQuestions(events);

		assertEqual(filtered.length, 2, "Should return exactly 2 agent_question events");
		assert(
			filtered.every((e) => e.type === "agent_question"),
			"All returned events should be agent_question type",
		);
	});

	await runner.test("excludes already-answered questions", () => {
		const events: MockEvent[] = [
			{ type: "agent_question", question: "Already answered?", workerName: "swift_fox", answered: true },
			{ type: "agent_question", question: "Still pending?", workerName: "calm_hawk", answered: false },
		];

		const filtered = filterQuestions(events);

		assertEqual(filtered.length, 1, "Should return 1 unanswered question");
		assertEqual(filtered[0].question, "Still pending?", "Should return the unanswered one");
	});

	await runner.test("caps at max 4 questions", () => {
		const events: MockEvent[] = Array.from({ length: 7 }, (_, i) => ({
			type: "agent_question",
			question: `Question ${i + 1}`,
			workerName: `worker_${i}`,
			answered: false,
		}));

		const filtered = filterQuestions(events, 4);

		assertEqual(filtered.length, 4, "Should cap at 4 questions");
		assertEqual(filtered[0].question, "Question 1", "First question should be preserved");
		assertEqual(filtered[3].question, "Question 4", "Fourth question should be the last");
	});

	await runner.test("returns empty array when no agent_question events", () => {
		const events: MockEvent[] = [
			{ type: "phase_started" },
			{ type: "tool_call" },
			{ type: "worker_completed" },
		];

		const filtered = filterQuestions(events);
		assertEqual(filtered.length, 0, "Should return empty array when no questions");
	});

	await runner.test("returns empty array when all questions are answered", () => {
		const events: MockEvent[] = [
			{ type: "agent_question", question: "Q1", answered: true },
			{ type: "agent_question", question: "Q2", answered: true },
		];

		const filtered = filterQuestions(events);
		assertEqual(filtered.length, 0, "Should return empty array when all answered");
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Test 3: renderQuestionBuffer output
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("renderQuestionBuffer — output format");

	await runner.test("returns empty array for zero questions", () => {
		const lines = renderQuestionBuffer([], mockTheme, 80);
		assertEqual(lines.length, 0, "Should return no lines for empty input");
	});

	await runner.test("renders bordered block with box-drawing characters", () => {
		const questions = [
			{
				workerName: "swift_fox",
				question: "Should we use approach A or B?",
				options: ["approach A", "approach B"],
			},
		];

		const lines = renderQuestionBuffer(questions, mockTheme, 80);

		// Should produce at least 3 border lines + 1 question line + 1 option chip line
		assert(lines.length >= 5, `Expected ≥5 lines, got ${lines.length}`);

		// Validate box-drawing chars
		const boxText = lines.join("\n");
		assert(boxText.includes("╔"), "Output must contain ╔ (top-left corner)");
		assert(boxText.includes("╗"), "Output must contain ╗ (top-right corner)");
		assert(boxText.includes("╚"), "Output must contain ╚ (bottom-left corner)");
		assert(boxText.includes("╝"), "Output must contain ╝ (bottom-right corner)");
		assert(boxText.includes("═"), "Output must contain ═ (horizontal border)");
		assert(boxText.includes("║"), "Output must contain ║ (vertical border)");
	});

	await runner.test("renders [A] and [B] option chips", () => {
		const questions = [
			{
				workerName: "calm_hawk",
				question: "Which database?",
				options: ["PostgreSQL", "SQLite", "DynamoDB"],
			},
		];

		const lines = renderQuestionBuffer(questions, mockTheme, 80);
		const joined = lines.join("\n");

		assert(joined.includes("[A]"), "Output must contain [A] chip");
		assert(joined.includes("[B]"), "Output must contain [B] chip");
		assert(joined.includes("[C]"), "Output must contain [C] chip for third option");
		assert(joined.includes("PostgreSQL"), "Output must contain first option text");
		assert(joined.includes("SQLite"), "Output must contain second option text");
		assert(joined.includes("DynamoDB"), "Output must contain third option text");
	});

	await runner.test("caps at 4 questions even when more provided", () => {
		const questions = Array.from({ length: 7 }, (_, i) => ({
			workerName: `worker_${i}`,
			question: `Question ${i + 1}`,
			options: [`opt A${i}`, `opt B${i}`],
		}));

		const lines = renderQuestionBuffer(questions, mockTheme, 80);

		// Count how many times "Question N" appears in output
		const joined = lines.join("\n");
		let questionCount = 0;
		for (let i = 1; i <= 7; i++) {
			if (joined.includes(`Question ${i}`)) questionCount++;
		}

		assert(questionCount <= 4, `Should render at most 4 questions, rendered ${questionCount}`);
	});

	await runner.test("renders two questions with correct question text", () => {
		const questions = [
			{ workerName: "swift_fox", question: "Use TypeScript strict mode?", options: ["yes", "no"] },
			{ workerName: "calm_hawk", question: "Which test framework?", options: ["vitest", "jest"] },
		];

		const lines = renderQuestionBuffer(questions, mockTheme, 80);
		const joined = lines.join("\n");

		assert(joined.includes("Use TypeScript strict mode?"), "First question text should appear");
		assert(joined.includes("Which test framework?"), "Second question text should appear");
		assert(joined.includes("swift_fox"), "First worker name should appear");
		assert(joined.includes("calm_hawk"), "Second worker name should appear");
	});

	await runner.test("renders ✋ header with question count", () => {
		const questions = [
			{ workerName: "swift_fox", question: "Approach A or B?", options: ["A", "B"] },
			{ workerName: "calm_hawk", question: "Priority 1 or 2?", options: ["1", "2"] },
		];

		const lines = renderQuestionBuffer(questions, mockTheme, 80);
		const joined = lines.join("\n");

		assert(joined.includes("✋"), "Header must contain ✋ symbol");
		assert(joined.includes("question"), "Header must mention 'question'");
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
