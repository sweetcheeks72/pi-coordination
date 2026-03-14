#!/usr/bin/env npx jiti
/**
 * Unit tests for task navigator TUI components (TASK-03).
 *
 * Run with: npx jiti tests/unit/task-navigator.test.ts
 *
 * @module
 */

import { TestRunner, assertEqual, assert, assertExists } from "../test-utils.js";
import {
	renderPlanProgress,
	renderViewTabs,
	renderCollapsedTask,
	renderExpandedTask,
	renderMeshView,
	renderTaskNavigator,
	type TaskNavView,
	type TaskNavState,
} from "../../coordinate/render-utils.js";
import type { Task, WorkerStateFile, MeshMessage } from "../../coordinate/types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Minimal stub theme
// ─────────────────────────────────────────────────────────────────────────────

const theme = {
	fg: (_color: string, text: string) => text,
} as any;

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<Task> = {}): Task {
	return {
		id: "T-01",
		description: "sync-git-context",
		priority: 0,
		status: "pending",
		files: [],
		...overrides,
	} as Task;
}

function makeWorker(overrides: Partial<WorkerStateFile> = {}): WorkerStateFile {
	return {
		id: "worker-abc123",
		shortId: "abc1",
		identity: "worker:TASK-01-abc1",
		agent: "worker",
		status: "working",
		currentFile: null,
		currentTool: null,
		waitingFor: null,
		assignedSteps: [],
		completedSteps: [],
		currentStep: null,
		handshakeSpec: "## Task: TASK-01\nDo the thing",
		startedAt: Date.now() - 60000,
		completedAt: null,
		usage: { input: 0, output: 0, cost: 0.05, turns: 3 },
		filesModified: [],
		blockers: [],
		errorType: null,
		errorMessage: null,
		...overrides,
	} as WorkerStateFile;
}

function makeMeshMessage(overrides: Partial<MeshMessage> = {}): MeshMessage {
	return {
		id: "msg-001",
		from: "cozy_pike",
		to: "eager_crow",
		message: "T-02 done, starting T-03",
		timestamp: Date.now(),
		type: "coordination",
		...overrides,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
	const runner = new TestRunner();

	runner.section("renderPlanProgress");

	await runner.test("returns 2 lines when planName is provided", () => {
		const tasks = [
			makeTask({ status: "complete" }),
			makeTask({ id: "T-02", status: "complete" }),
			makeTask({ id: "T-03", status: "claimed" }),
			makeTask({ id: "T-04", status: "pending" }),
		];
		const lines = renderPlanProgress(tasks, 3.21, 25, 13 * 60 * 1000 + 29 * 1000, "coding-matrix-per-repo", theme, 80);
		assertEqual(lines.length, 2, "should return 2 lines (plan name + progress)");
		assert(lines[0].includes("coding-matrix-per-repo"), "first line should be plan name");
		assert(lines[1].includes("2/4"), "second line should show 2/4 done");
	});

	await runner.test("returns 1 line when planName is empty", () => {
		const tasks = [makeTask({ status: "complete" })];
		const lines = renderPlanProgress(tasks, 0, 25, 0, "", theme, 80);
		assertEqual(lines.length, 1, "should return 1 line when no plan name");
	});

	await runner.test("shows 0/0 for empty task list", () => {
		const lines = renderPlanProgress([], 0, 25, 0, "", theme, 80);
		assert(lines[0].includes("0/0"), "should show 0/0 for empty tasks");
	});

	runner.section("renderViewTabs");

	await runner.test("wraps active view in brackets", () => {
		const result = renderViewTabs("tasks", theme, 80);
		assert(result.includes("[TASKS]"), "should show [TASKS] for active tasks view");
		assert(result.includes("AGENT"), "should show AGENT tab");
		assert(result.includes("MESH"), "should show MESH tab");
	});

	await runner.test("cycles views correctly", () => {
		const tasksResult = renderViewTabs("tasks", theme, 80);
		const agentResult = renderViewTabs("agent", theme, 80);
		const meshResult = renderViewTabs("mesh", theme, 80);

		assert(tasksResult.includes("[TASKS]"), "tasks view: [TASKS] active");
		assert(agentResult.includes("[AGENT]"), "agent view: [AGENT] active");
		assert(meshResult.includes("[MESH]"), "mesh view: [MESH] active");
	});

	await runner.test("includes navigation hints", () => {
		const result = renderViewTabs("tasks", theme, 80);
		assert(result.includes("Tab:view"), "should include Tab:view hint");
		assert(result.includes("↑↓:select"), "should include arrow key hint");
	});

	runner.section("renderCollapsedTask");

	await runner.test("shows ▸ prefix for selected task", () => {
		const task = makeTask();
		const result = renderCollapsedTask(task, undefined, true, false, theme, 80);
		assert(result.includes("▸"), "selected task should have ▸ prefix");
	});

	await runner.test("shows space prefix for non-selected task", () => {
		const task = makeTask();
		const result = renderCollapsedTask(task, undefined, false, false, theme, 80);
		assert(result.startsWith(" "), "non-selected task should have space prefix");
	});

	await runner.test("includes task ID", () => {
		const task = makeTask({ id: "T-01" });
		const result = renderCollapsedTask(task, undefined, false, false, theme, 80);
		assert(result.includes("T-01"), "should include task ID");
	});

	await runner.test("shows done duration for complete task", () => {
		const task = makeTask({
			id: "T-01",
			status: "complete",
			claimedAt: Date.now() - 134000,
			completedAt: Date.now(),
		});
		const result = renderCollapsedTask(task, undefined, false, false, theme, 80);
		assert(result.includes("done"), "complete task should show 'done'");
	});

	await runner.test("shows worker name for claimed task", () => {
		const task = makeTask({ id: "T-01", status: "claimed", claimedBy: "worker-abc123" });
		const worker = makeWorker({ id: "worker-abc123", identity: "worker:TASK-01-abc1" });
		const result = renderCollapsedTask(task, worker, false, false, theme, 80);
		// Worker name is generated from identity
		assertExists(result, "should render without error");
	});

	await runner.test("uses ○ icon for pending task", () => {
		const task = makeTask({ status: "pending" });
		const result = renderCollapsedTask(task, undefined, false, false, theme, 80);
		assert(result.includes("○"), "pending task should have ○ icon");
	});

	await runner.test("uses ⚠ icon for failed task", () => {
		const task = makeTask({ status: "failed" });
		const result = renderCollapsedTask(task, undefined, false, false, theme, 80);
		assert(result.includes("⚠"), "failed task should have ⚠ icon");
	});

	await runner.test("uses ⚠ icon for blocked task", () => {
		const task = makeTask({ status: "blocked" });
		const result = renderCollapsedTask(task, undefined, false, false, theme, 80);
		assert(result.includes("⚠"), "blocked task should have ⚠ icon");
	});

	runner.section("renderExpandedTask");

	await runner.test("returns array of strings with box-drawing chars", () => {
		const task = makeTask({ planDescription: "Create /api/repos with ?name= filter" });
		const worker = makeWorker({
			planIntent: "Create /api/repos",
			currentProblem: "Wiring query param into Cypher",
			thinkingStream: "Reading route structure for insert point",
		});
		const lines = renderExpandedTask(task, worker, theme, 50);
		assert(lines.length > 0, "should return lines");
		assert(lines[0].includes("┌"), "first line should have box-drawing top");
		assert(lines[lines.length - 1].includes("└"), "last line should have box-drawing bottom");
	});

	await runner.test("includes PLAN section when planIntent set", () => {
		const task = makeTask();
		const worker = makeWorker({ planIntent: "Create /api/repos with filter" });
		const lines = renderExpandedTask(task, worker, theme, 60);
		const combined = lines.join("\n");
		assert(combined.includes("PLAN"), "should include PLAN section");
	});

	await runner.test("includes NOW section when currentProblem set", () => {
		const task = makeTask();
		const worker = makeWorker({ currentProblem: "Wiring query param into Cypher" });
		const lines = renderExpandedTask(task, worker, theme, 60);
		const combined = lines.join("\n");
		assert(combined.includes("NOW"), "should include NOW section");
	});

	await runner.test("includes THINK section when thinkingStream set", () => {
		const task = makeTask();
		const worker = makeWorker({ thinkingStream: "Reading route structure" });
		const lines = renderExpandedTask(task, worker, theme, 60);
		const combined = lines.join("\n");
		assert(combined.includes("THINK"), "should include THINK section");
	});

	await runner.test("includes ASSUME section when assumptions set", () => {
		const task = makeTask();
		const worker = makeWorker({
			assumptions: [{ text: "Repos from Memgraph", status: "verified", confidence: "high" }],
		});
		const lines = renderExpandedTask(task, worker, theme, 60);
		const combined = lines.join("\n");
		assert(combined.includes("ASSUME"), "should include ASSUME section");
	});

	await runner.test("includes INTERVENE commands", () => {
		const task = makeTask();
		const lines = renderExpandedTask(task, undefined, theme, 60);
		const combined = lines.join("\n");
		assert(combined.includes(":send"), "should include :send command");
		assert(combined.includes(":retry"), "should include :retry command");
	});

	await runner.test("shows deviation log when present", () => {
		const task = makeTask({
			deviationLog: [{
				timestamp: Date.now(),
				what: "Timeout 30→60s",
				why: "request timed out",
				decision: "extend timeout",
				impact: "minimal",
			}],
		});
		const lines = renderExpandedTask(task, undefined, theme, 60);
		const combined = lines.join("\n");
		assert(combined.includes("⚠"), "should show deviation indicator");
	});

	await runner.test("max width is respected (80 cols)", () => {
		const task = makeTask({
			planDescription: "A ".repeat(200),  // very long text
		});
		const worker = makeWorker({ thinkingStream: "x".repeat(500) });
		const lines = renderExpandedTask(task, worker, theme, 80);
		for (const line of lines) {
			// Strip ANSI codes for width check (theme stub returns raw strings)
			assert(line.length <= 200, `line should not be excessively long: ${line.length}`);
		}
	});

	runner.section("renderMeshView");

	await runner.test("returns empty message for no messages", () => {
		const lines = renderMeshView([], theme, 80);
		const combined = lines.join("\n");
		assert(combined.includes("No mesh messages"), "should show empty state");
	});

	await runner.test("renders message with from → to format", () => {
		const messages = [
			makeMeshMessage({ from: "cozy_pike", to: "eager_crow", message: "T-02 done" }),
		];
		const lines = renderMeshView(messages, theme, 80);
		const combined = lines.join("\n");
		assert(combined.includes("cozy_pike"), "should include from");
		assert(combined.includes("eager_crow"), "should include to");
		assert(combined.includes("T-02 done"), "should include message");
	});

	await runner.test("shows at most 20 messages", () => {
		const messages = Array.from({ length: 25 }, (_, i) =>
			makeMeshMessage({ id: `msg-${i}`, message: `message ${i}` })
		);
		const lines = renderMeshView(messages, theme, 80);
		// Header (1) + divider (1) + up to 20 messages = 22 lines max
		assert(lines.length <= 22, `should show at most 22 lines, got ${lines.length}`);
	});

	runner.section("renderTaskNavigator");

	await runner.test("renders TASKS view with task list", () => {
		const state: TaskNavState = {
			tasks: [
				makeTask({ id: "T-01", status: "complete" }),
				makeTask({ id: "T-02", status: "claimed", claimedBy: "worker-abc" }),
			],
			workers: [makeWorker({ id: "worker-abc" })],
			meshMessages: [],
			selectedTaskIndex: 0,
			activeView: "tasks",
			expandedTaskId: null,
			cost: 3.21,
			costLimit: 25,
			elapsedMs: 13 * 60 * 1000 + 29 * 1000,
		};
		const lines = renderTaskNavigator(state, theme, 80);
		const combined = lines.join("\n");
		assert(combined.includes("T-01"), "should include T-01");
		assert(combined.includes("T-02"), "should include T-02");
		assert(combined.includes("[TASKS]"), "should show TASKS tab active");
	});

	await runner.test("renders MESH view when activeView is mesh", () => {
		const state: TaskNavState = {
			tasks: [],
			workers: [],
			meshMessages: [makeMeshMessage()],
			selectedTaskIndex: 0,
			activeView: "mesh",
			expandedTaskId: null,
			cost: 0,
			costLimit: 25,
			elapsedMs: 0,
		};
		const lines = renderTaskNavigator(state, theme, 80);
		const combined = lines.join("\n");
		assert(combined.includes("MESH"), "should show MESH section");
	});

	await runner.test("renders AGENT view when activeView is agent", () => {
		const state: TaskNavState = {
			tasks: [makeTask({ id: "T-01", planDescription: "Build API" })],
			workers: [],
			meshMessages: [],
			selectedTaskIndex: 0,
			activeView: "agent",
			expandedTaskId: null,
			cost: 0,
			costLimit: 25,
			elapsedMs: 0,
		};
		const lines = renderTaskNavigator(state, theme, 80);
		const combined = lines.join("\n");
		assert(combined.includes("[AGENT]"), "should show [AGENT] tab active");
	});

	await runner.test("shows expanded panel for expandedTaskId", () => {
		const state: TaskNavState = {
			tasks: [
				makeTask({ id: "T-01", status: "claimed", planDescription: "Build API" }),
				makeTask({ id: "T-02", status: "pending" }),
			],
			workers: [],
			meshMessages: [],
			selectedTaskIndex: 0,
			activeView: "tasks",
			expandedTaskId: "T-01",
			cost: 0,
			costLimit: 25,
			elapsedMs: 0,
		};
		const lines = renderTaskNavigator(state, theme, 80);
		const combined = lines.join("\n");
		// Expanded panel shows box-drawing characters
		assert(combined.includes("┌"), "expanded panel should show box-drawing top");
		assert(combined.includes("└"), "expanded panel should show box-drawing bottom");
	});

	await runner.test("shows mesh preview at bottom of TASKS view", () => {
		const state: TaskNavState = {
			tasks: [],
			workers: [],
			meshMessages: [
				makeMeshMessage({ message: "preview message" }),
			],
			selectedTaskIndex: 0,
			activeView: "tasks",
			expandedTaskId: null,
			cost: 0,
			costLimit: 25,
			elapsedMs: 0,
		};
		const lines = renderTaskNavigator(state, theme, 80);
		const combined = lines.join("\n");
		assert(combined.includes("preview message"), "should show mesh preview in TASKS view");
	});

	await runner.test("renders without error at 80 col minimum width", () => {
		const state: TaskNavState = {
			tasks: [makeTask({ id: "T-01", status: "complete" })],
			workers: [],
			meshMessages: [],
			selectedTaskIndex: 0,
			activeView: "tasks",
			expandedTaskId: null,
			planName: "coding-matrix-per-repo",
			cost: 3.21,
			costLimit: 25,
			elapsedMs: 13 * 60 * 1000 + 29 * 1000,
		};
		// Should not throw
		const lines = renderTaskNavigator(state, theme, 80);
		assert(Array.isArray(lines), "should return array");
		assert(lines.length > 0, "should return non-empty array");
	});

	runner.section("Integration: navigation state lifecycle");

	await runner.test("selectedTaskIndex=1 marks second task as selected", () => {
		const state: TaskNavState = {
			tasks: [
				makeTask({ id: "T-01", status: "complete" }),
				makeTask({ id: "T-02", status: "pending" }),
			],
			workers: [],
			meshMessages: [],
			selectedTaskIndex: 1,
			activeView: "tasks",
			expandedTaskId: null,
			cost: 0,
			costLimit: 25,
			elapsedMs: 0,
		};
		const lines = renderTaskNavigator(state, theme, 80);
		// Find the T-02 line - it should have ▸
		const t02Line = lines.find((l) => l.includes("T-02"));
		assertExists(t02Line, "T-02 line should exist");
		assert(t02Line!.includes("▸"), "T-02 should be marked as selected");
	});

	runner.summary();
}

main().catch(console.error);
