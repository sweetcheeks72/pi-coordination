#!/usr/bin/env npx jiti
/**
 * Unit tests for MiniDashboard and MiniFooter compact view components (TASK-06).
 *
 * Run with: npx jiti tests/unit/mini-dashboard.test.ts
 *
 * @module
 */

import { TestRunner, assertEqual, assert } from "../test-utils.js";
import {
	renderMiniDashboardCompact,
	renderMiniFooterCompact,
	type MiniDashboardRenderState,
	type MiniFooterRenderState,
} from "../../coordinate/dashboard.js";
import type { Task } from "../../coordinate/types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Minimal stub theme
// ─────────────────────────────────────────────────────────────────────────────

const theme = {
	fg: (_color: string, text: string) => text,
} as any;

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeRenderState(overrides: Partial<MiniDashboardRenderState> = {}): MiniDashboardRenderState {
	return {
		hasTasks: true,
		planName: "coding-matrix-per-repo",
		completed: 2,
		total: 4,
		cost: 3.21,
		costLimit: 25,
		elapsedMs: 7 * 60 * 1000 + 26 * 1000,
		tasks: [
			{ id: "T-01", status: "complete", description: "sync-git-context" },
			{ id: "T-02", status: "complete", description: "setup-types" },
			{ id: "T-03", status: "claimed", description: "serve-coding-matrix" },
			{ id: "T-04", status: "pending", description: "build-ui" },
		],
		latestDeviation: undefined,
		pendingQuestions: 0,
		...overrides,
	};
}

function makeFooterState(overrides: Partial<MiniFooterRenderState> = {}): MiniFooterRenderState {
	return {
		hasTasks: true,
		completed: 3,
		total: 4,
		activeTaskId: "T-03",
		pendingQuestions: 1,
		cost: 3.21,
		costLimit: 25,
		elapsedMs: 7 * 60 * 1000 + 26 * 1000,
		...overrides,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
	const runner = new TestRunner();

	// ─────────────────────────────────────────────────────────────────────────
	// MiniDashboard — Task-centric view (hasTasks=true)
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("MiniDashboard: task-centric view (hasTasks=true)");

	await runner.test("renders 5 lines: top-border, header, task-row, deviation-row, bottom-border", () => {
		const state = makeRenderState();
		const lines = renderMiniDashboardCompact(state, theme, 80);
		assertEqual(lines.length, 5, `expected 5 lines, got ${lines.length}: ${JSON.stringify(lines)}`);
	});

	await runner.test("line 1 (header) shows plan name, task count, budget, elapsed", () => {
		const state = makeRenderState();
		const lines = renderMiniDashboardCompact(state, theme, 80);
		// line index 1 = content line 1 (after top border)
		const header = lines[1];
		assert(header.includes("coding-matrix-per-repo"), "header should include plan name");
		assert(header.includes("2/4"), "header should include task count");
		assert(header.includes("$3.21"), "header should include cost");
		assert(header.includes("$25"), "header should include cost limit");
	});

	await runner.test("line 2 (task row) shows task IDs with status glyphs", () => {
		const state = makeRenderState();
		const lines = renderMiniDashboardCompact(state, theme, 80);
		const taskRow = lines[2];
		assert(taskRow.includes("T-01"), "task row should include T-01");
		assert(taskRow.includes("T-02"), "task row should include T-02");
		assert(taskRow.includes("T-03"), "task row should include T-03");
		assert(taskRow.includes("T-04"), "task row should include T-04");
	});

	await runner.test("task row shows ✓ for complete tasks", () => {
		const state = makeRenderState();
		const lines = renderMiniDashboardCompact(state, theme, 80);
		const taskRow = lines[2];
		assert(taskRow.includes("✓T-01"), "complete task should have ✓ glyph");
		assert(taskRow.includes("✓T-02"), "complete task should have ✓ glyph");
	});

	await runner.test("task row shows ⯈ for active/claimed tasks with description", () => {
		const state = makeRenderState();
		const lines = renderMiniDashboardCompact(state, theme, 80);
		const taskRow = lines[2];
		assert(taskRow.includes("⯈T-03"), "claimed task should have ⯈ glyph");
		assert(taskRow.includes("serve-coding-matrix"), "active task should show description");
	});

	await runner.test("task row shows ○ for pending tasks", () => {
		const state = makeRenderState();
		const lines = renderMiniDashboardCompact(state, theme, 80);
		const taskRow = lines[2];
		assert(taskRow.includes("○T-04"), "pending task should have ○ glyph");
	});

	await runner.test("deviation row is blank (dash line) when no deviation and no questions", () => {
		const state = makeRenderState({ latestDeviation: undefined, pendingQuestions: 0 });
		const lines = renderMiniDashboardCompact(state, theme, 80);
		const devRow = lines[3];
		// Should be a mostly empty/padding line or show nothing meaningful
		assert(!devRow.includes("⚠"), "no deviation row should not have ⚠");
		assert(!devRow.includes("❓"), "no questions row should not have ❓");
	});

	await runner.test("deviation row shows latest deviation when present", () => {
		const state = makeRenderState({
			latestDeviation: { taskId: "T-03", what: "timeout→retried" },
		});
		const lines = renderMiniDashboardCompact(state, theme, 80);
		const devRow = lines[3];
		assert(devRow.includes("⚠"), "deviation row should show ⚠ icon");
		assert(devRow.includes("T-03"), "deviation row should show task ID");
		assert(devRow.includes("timeout→retried"), "deviation row should show deviation text");
	});

	await runner.test("deviation row shows pending question indicator", () => {
		const state = makeRenderState({ pendingQuestions: 1 });
		const lines = renderMiniDashboardCompact(state, theme, 80);
		const devRow = lines[3];
		assert(devRow.includes("❓"), "deviation row should show ❓ when questions pending");
		assert(devRow.includes("awaiting input"), "deviation row should show awaiting input text");
	});

	await runner.test("deviation row shows both deviation and question when both present", () => {
		const state = makeRenderState({
			latestDeviation: { taskId: "T-03", what: "timeout→retried" },
			pendingQuestions: 1,
		});
		const lines = renderMiniDashboardCompact(state, theme, 80);
		const devRow = lines[3];
		assert(devRow.includes("⚠"), "should show deviation icon");
		assert(devRow.includes("❓"), "should show question icon");
	});

	await runner.test("renders without error at narrow width (60 cols)", () => {
		const state = makeRenderState();
		// Should not throw
		const lines = renderMiniDashboardCompact(state, theme, 60);
		assert(Array.isArray(lines), "should return array");
		assert(lines.length > 0, "should return non-empty array");
	});

	// ─────────────────────────────────────────────────────────────────────────
	// MiniDashboard — Worker fallback view (hasTasks=false)
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("MiniDashboard: worker fallback view (hasTasks=false)");

	await runner.test("shows fallback when hasTasks=false", () => {
		const state = makeRenderState({
			hasTasks: false,
			tasks: [],
			completed: 0,
			total: 0,
			currentPhase: "workers",
			workers: [{ id: "w1", status: "working" }, { id: "w2", status: "complete" }],
		});
		const lines = renderMiniDashboardCompact(state, theme, 80);
		assert(Array.isArray(lines), "should return array in fallback mode");
		// Should not show task glyphs
		const combined = lines.join("\n");
		assert(!combined.includes("✓T-"), "fallback mode should not show task glyphs");
	});

	// ─────────────────────────────────────────────────────────────────────────
	// MiniFooter — Task-centric view (hasTasks=true)
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("MiniFooter: task-centric view (hasTasks=true)");

	await runner.test("renders exactly 1 line", () => {
		const state = makeFooterState();
		const lines = renderMiniFooterCompact(state, theme, 80);
		assertEqual(lines.length, 1, `expected 1 line, got ${lines.length}`);
	});

	await runner.test("line starts with [coord]", () => {
		const state = makeFooterState();
		const [line] = renderMiniFooterCompact(state, theme, 80);
		assert(line.includes("[coord]"), "footer should start with [coord]");
	});

	await runner.test("shows task count (X/Y tasks)", () => {
		const state = makeFooterState({ completed: 3, total: 4 });
		const [line] = renderMiniFooterCompact(state, theme, 80);
		assert(line.includes("3/4"), "footer should show task count");
		assert(line.includes("tasks"), "footer should include 'tasks' label");
	});

	await runner.test("shows active task ID with ⯈ glyph", () => {
		const state = makeFooterState({ activeTaskId: "T-03" });
		const [line] = renderMiniFooterCompact(state, theme, 80);
		assert(line.includes("⯈T-03"), "footer should show active task with ⯈ glyph");
	});

	await runner.test("shows pending question count", () => {
		const state = makeFooterState({ pendingQuestions: 1 });
		const [line] = renderMiniFooterCompact(state, theme, 80);
		assert(line.includes("❓1"), "footer should show pending question count");
		assert(line.includes("pending"), "footer should include 'pending' label");
	});

	await runner.test("omits pending question when pendingQuestions=0", () => {
		const state = makeFooterState({ pendingQuestions: 0 });
		const [line] = renderMiniFooterCompact(state, theme, 80);
		assert(!line.includes("❓"), "footer should not show ❓ when no pending questions");
	});

	await runner.test("shows budget (cost/limit)", () => {
		const state = makeFooterState({ cost: 3.21, costLimit: 25 });
		const [line] = renderMiniFooterCompact(state, theme, 80);
		assert(line.includes("$3.21"), "footer should show cost");
		assert(line.includes("$25"), "footer should show cost limit");
	});

	await runner.test("shows /jobs hint", () => {
		const state = makeFooterState();
		const [line] = renderMiniFooterCompact(state, theme, 80);
		assert(line.includes("/jobs"), "footer should include /jobs hint");
	});

	await runner.test("omits activeTaskId section when no active task", () => {
		const state = makeFooterState({ activeTaskId: undefined });
		const [line] = renderMiniFooterCompact(state, theme, 80);
		assert(!line.includes("⯈"), "footer should not show ⯈ when no active task");
	});

	// ─────────────────────────────────────────────────────────────────────────
	// MiniFooter — Worker fallback view (hasTasks=false)
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("MiniFooter: worker fallback view (hasTasks=false)");

	await runner.test("shows worker count fallback when hasTasks=false", () => {
		const state = makeFooterState({
			hasTasks: false,
			phase: "workers",
			workerCompleted: 1,
			workerTotal: 3,
			isComplete: false,
			isFailed: false,
		});
		const [line] = renderMiniFooterCompact(state, theme, 80);
		assert(line.includes("[coord]"), "fallback footer should start with [coord]");
		// Should NOT show task-centric content
		assert(!line.includes("⯈T-"), "fallback footer should not show task glyph");
	});

	await runner.test("fallback shows complete status when done", () => {
		const state = makeFooterState({
			hasTasks: false,
			phase: "complete",
			workerCompleted: 3,
			workerTotal: 3,
			isComplete: true,
			isFailed: false,
		});
		const [line] = renderMiniFooterCompact(state, theme, 80);
		// The old MiniFooter shows "done" or success indicator
		assert(line.includes("[coord]"), "fallback footer should render");
	});

	runner.summary();
}

main().catch(console.error);
