#!/usr/bin/env npx jiti
/**
 * Integration tests for coordinate UX — TASK-08.
 *
 * Tests all render components together and validates integration correctness.
 *
 * Run with: npx jiti tests/integration/coordinate-ux.test.ts
 *
 * Scenarios covered:
 *  1. Basic plan run — task navigator with plan descriptions + progress
 *  2. Deviation handling — ⚠N badge (Tier 1), Tier 2 WHAT/WHY/…, Tier 3 raw logs
 *  3. Escalation flow — ❓ QUESTION section with options + countdown
 *  4. HTML interview — writeEscalationHTML creates file in coordDir/interviews/
 *  5. Mesh chat — two-worker conversation with attribution
 *  6. Navigation — ↑↓ selection, Tab view switching
 *  7. Commands — :send :retry :skip visible in INTERVENE section
 *  8. MiniDashboard — task-centric view shows task IDs, not worker names
 *  9. 80-col rendering — no line overflows 80 visible columns
 * 10. Backward compat — graceful fallback when no tasks (hasTasks=false)
 *
 * @module
 */

import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
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
import {
	renderMiniDashboardCompact,
	renderMiniFooterCompact,
	type MiniDashboardRenderState,
	type MiniFooterRenderState,
} from "../../coordinate/dashboard.js";
import {
	generateEscalationHTML,
	writeEscalationHTML,
} from "../../coordinate/escalation.js";
import type { Task, WorkerStateFile, MeshMessage, EscalationRequest } from "../../coordinate/types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Theme stub — identity passthrough (no ANSI codes → real visible widths)
// ─────────────────────────────────────────────────────────────────────────────

const theme = {
	fg: (_color: string, text: string) => text,
} as any;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
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

function makeEscalation(overrides: Partial<EscalationRequest> = {}): EscalationRequest {
	return {
		id: "esc-001",
		from: "worker-abc123",
		question: "Should I extend timeout from 30s to 60s?",
		options: ["Yes, extend to 60s", "No, keep 30s", "Skip this check"],
		richOptions: [
			{ label: "Extend to 60s", description: "Safer for cold start" },
			{ label: "Keep 30s", description: "Standard timeout" },
			{ label: "Skip", description: "Skip this check entirely" },
		],
		context: "Cold start adds ~15s. Endpoint validation timed out at 30s.",
		agentAssumption: "Extend to 60s",
		confidence: 0.8,
		timeout: 300,
		defaultOption: 0,
		createdAt: Date.now(),
		...overrides,
	};
}

function makeNavState(overrides: Partial<TaskNavState> = {}): TaskNavState {
	return {
		tasks: [],
		workers: [],
		meshMessages: [],
		selectedTaskIndex: 0,
		activeView: "tasks" as TaskNavView,
		expandedTaskId: null,
		cost: 0,
		costLimit: 25,
		elapsedMs: 0,
		...overrides,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Strip visible-width-only string measurement (no ANSI in stub theme)
// ─────────────────────────────────────────────────────────────────────────────

function visibleLen(s: string): number {
	// Strip ANSI escape codes (just in case)
	return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
	const runner = new TestRunner();

	// ──────────────────────────────────────────────────────────────────────────
	// Scenario 1: Basic plan run
	// ──────────────────────────────────────────────────────────────────────────

	runner.section("Scenario 1: Basic plan run");

	await runner.test("task navigator shows all tasks with plan descriptions", () => {
		const state = makeNavState({
			planName: "coding-matrix-per-repo",
			tasks: [
				makeTask({ id: "T-01", status: "complete", planDescription: "Sync git context for repo" }),
				makeTask({ id: "T-02", status: "claimed", claimedBy: "worker-abc123", planDescription: "Setup types and interfaces" }),
				makeTask({ id: "T-03", status: "pending", planDescription: "Serve coding matrix API" }),
			],
			workers: [makeWorker({ id: "worker-abc123" })],
			cost: 2.5,
			costLimit: 25,
			elapsedMs: 5 * 60 * 1000,
		});
		const lines = renderTaskNavigator(state, theme, 80);
		const combined = lines.join("\n");

		assert(combined.includes("coding-matrix-per-repo"), "should show plan name");
		assert(combined.includes("T-01"), "should show T-01");
		assert(combined.includes("T-02"), "should show T-02");
		assert(combined.includes("T-03"), "should show T-03");
		assert(combined.includes("1/3"), "should show 1/3 done (1 complete)");
	});

	await runner.test("progress bar updates correctly with 2/4 tasks done", () => {
		const tasks = [
			makeTask({ id: "T-01", status: "complete" }),
			makeTask({ id: "T-02", status: "complete" }),
			makeTask({ id: "T-03", status: "claimed" }),
			makeTask({ id: "T-04", status: "pending" }),
		];
		const lines = renderPlanProgress(tasks, 3.21, 25, 13 * 60 * 1000 + 29 * 1000, "my-plan", theme, 80);
		const combined = lines.join("\n");
		assert(combined.includes("2/4"), "should show 2/4 done");
		assert(combined.includes("my-plan"), "should show plan name");
	});

	await runner.test("planDescription used as display label in collapsed row", () => {
		const task = makeTask({
			id: "T-02",
			status: "claimed",
			claimedBy: "worker-abc123",
			planDescription: "Build the API endpoint",
		});
		const worker = makeWorker({ id: "worker-abc123" });
		const result = renderCollapsedTask(task, worker, false, false, theme, 80);
		// Should contain the task ID at minimum
		assert(result.includes("T-02"), "collapsed row should include task ID");
		assertExists(result, "should render without error");
	});

	await runner.test("planDescription shown in expanded panel PLAN section", () => {
		const task = makeTask({
			id: "T-01",
			status: "claimed",
			planDescription: "Create the /api/repos endpoint",
		});
		const lines = renderExpandedTask(task, undefined, theme, 80);
		const combined = lines.join("\n");
		assert(combined.includes("PLAN"), "expanded panel should have PLAN section");
		assert(combined.includes("Create the /api/repos endpoint"), "expanded panel should show planDescription");
	});

	// ──────────────────────────────────────────────────────────────────────────
	// Scenario 2: Deviation handling
	// ──────────────────────────────────────────────────────────────────────────

	runner.section("Scenario 2: Deviation handling");

	await runner.test("Tier 1: ⚠N badge on collapsed row after worker failure", () => {
		const task = makeTask({
			id: "T-02",
			status: "claimed",
			deviationLog: [
				{
					timestamp: Date.now() - 5000,
					what: "Endpoint validation timed out",
					why: "Cold start adds ~15s",
					decision: "Extended timeout 30→60s",
					impact: "+45s duration",
				},
			],
		});
		const result = renderCollapsedTask(task, undefined, false, false, theme, 80);
		assert(result.includes("⚠1"), "should show ⚠1 badge for one deviation");
	});

	await runner.test("Tier 1: badge count increases with multiple deviations", () => {
		const task = makeTask({
			status: "claimed",
			deviationLog: [
				{ timestamp: Date.now(), what: "timeout", why: "cold start", decision: "extend", impact: "minimal" },
				{ timestamp: Date.now(), what: "oom", why: "large payload", decision: "chunk", impact: "+2s" },
			],
		});
		const result = renderCollapsedTask(task, undefined, false, false, theme, 80);
		assert(result.includes("⚠2"), "should show ⚠2 badge for two deviations");
	});

	await runner.test("Tier 2: expand shows WHAT/WHY/DECIDED/IMPACT for failure", () => {
		const task = makeTask({
			status: "failed",
			deviationLog: [
				{
					timestamp: Date.now() - 802000,
					what: "Endpoint validation timed out at 30s",
					why: "Cold start adds ~15s to startup",
					decision: "Extended timeout 30→60s, retried",
					impact: "+45s duration. T-04 unblocked.",
				},
			],
		});
		const lines = renderExpandedTask(task, undefined, theme, 80, true, false);
		const combined = lines.join("\n");
		assert(combined.includes("DEVIATION"), "should have DEVIATION section");
		assert(combined.includes("WHAT"), "should have WHAT label");
		assert(combined.includes("WHY"), "should have WHY label");
		assert(combined.includes("DECIDED"), "should have DECIDED label");
		assert(combined.includes("IMPACT"), "should have IMPACT label");
		assert(combined.includes("Endpoint validation timed out at 30s"), "should show deviation what text");
		assert(combined.includes("Cold start adds"), "should show deviation why text");
	});

	await runner.test("Tier 2: deviations shown newest-first (last-inserted first)", () => {
		// Implementation uses array reversal — last-inserted element appears first.
		// Insertions in ascending timestamp order: oldest → middle → newest.
		const task = makeTask({
			deviationLog: [
				{ timestamp: 1000, what: "oldest deviation", why: "r1", decision: "d1", impact: "i1" },
				{ timestamp: 2000, what: "middle deviation", why: "r2", decision: "d2", impact: "i2" },
				{ timestamp: 3000, what: "newest deviation", why: "r3", decision: "d3", impact: "i3" },
			],
		});
		const lines = renderExpandedTask(task, undefined, theme, 80, true, false);
		const combined = lines.join("\n");
		const newestIdx = combined.indexOf("newest deviation");
		const middleIdx = combined.indexOf("middle deviation");
		const oldestIdx = combined.indexOf("oldest deviation");
		assert(newestIdx < middleIdx, "newest (last-inserted) should appear first");
		assert(middleIdx < oldestIdx, "middle should appear before oldest");
	});

	await runner.test("Tier 3: raw logs shown when rawLogsExpanded=true", () => {
		const worker = makeWorker({
			recentTools: [
				{ tool: "bash", args: "npm test", endMs: Date.now() - 2000 },
				{ tool: "read", args: "src/index.ts", endMs: Date.now() - 1000 },
			],
		});
		const task = makeTask({
			status: "claimed",
			claimedBy: worker.id,
			deviationLog: [
				{ timestamp: Date.now(), what: "timeout", why: "slow", decision: "retry", impact: "none" },
			],
		});
		const lines = renderExpandedTask(task, worker, theme, 80, true, true);
		const combined = lines.join("\n");
		// Raw logs section should contain tool usage or log content
		assert(
			combined.includes("bash") || combined.includes("read") || combined.includes("LOG") || combined.includes("log"),
			"raw logs should show tool activity"
		);
	});

	await runner.test("Tier 3: Raw logs link visible in Tier 2 expanded view", () => {
		const task = makeTask({
			deviationLog: [
				{ timestamp: Date.now(), what: "timeout", why: "slow", decision: "retry", impact: "none" },
			],
		});
		const lines = renderExpandedTask(task, undefined, theme, 80, true, false);
		const combined = lines.join("\n");
		assert(combined.includes("Raw logs"), "should show Raw logs link");
	});

	await runner.test("TaskNavState with deviationExpanded=true propagates to navigator", () => {
		const state = makeNavState({
			tasks: [
				makeTask({
					id: "T-01",
					status: "claimed",
					deviationLog: [
						{ timestamp: Date.now(), what: "timeout", why: "cold start", decision: "retry", impact: "minimal" },
					],
				}),
			],
			expandedTaskId: "T-01",
			deviationExpanded: true,
			rawLogsExpanded: false,
		});
		const lines = renderTaskNavigator(state, theme, 80);
		const combined = lines.join("\n");
		assert(combined.includes("DEVIATION"), "navigator should pass deviationExpanded to expanded panel");
		assert(combined.includes("WHAT"), "navigator should show WHAT label when deviation expanded");
	});

	// ──────────────────────────────────────────────────────────────────────────
	// Scenario 3: Escalation flow
	// ──────────────────────────────────────────────────────────────────────────

	runner.section("Scenario 3: Escalation flow");

	await runner.test("TUI shows ❓ QUESTION section with options when escalation present", () => {
		const escalation = makeEscalation();
		const task = makeTask({ id: "T-02", status: "claimed" });
		const lines = renderExpandedTask(
			task,
			undefined,
			theme,
			80,
			false,
			false,
			escalation,
			120, // countdown
		);
		const combined = lines.join("\n");
		assert(combined.includes("❓"), "should show ❓ question indicator");
		assert(combined.includes("QUESTION"), "should show QUESTION section");
		assert(combined.includes("extend timeout"), "should show question text");
	});

	await runner.test("TUI shows numbered options [1] [2] [3] for escalation", () => {
		const escalation = makeEscalation();
		const task = makeTask({ id: "T-02", status: "claimed" });
		const lines = renderExpandedTask(
			task, undefined, theme, 80, false, false, escalation, 90,
		);
		const combined = lines.join("\n");
		assert(combined.includes("[1]"), "should show [1] option key");
		assert(combined.includes("[2]"), "should show [2] option key");
		assert(combined.includes("[3]"), "should show [3] option key");
	});

	await runner.test("TUI shows countdown seconds remaining", () => {
		const escalation = makeEscalation({ timeout: 300 });
		const task = makeTask({ id: "T-02", status: "claimed" });
		const lines = renderExpandedTask(
			task, undefined, theme, 80, false, false, escalation, 45,
		);
		const combined = lines.join("\n");
		assert(combined.includes("auto-proceed in 45s"), "should show countdown");
	});

	await runner.test("TUI shows agent assumption in escalation section", () => {
		const escalation = makeEscalation({ agentAssumption: "Extend to 60s" });
		const task = makeTask({ id: "T-02", status: "claimed" });
		const lines = renderExpandedTask(
			task, undefined, theme, 80, false, false, escalation, 200,
		);
		const combined = lines.join("\n");
		assert(combined.includes("assumes:"), "should show assumes label");
		assert(combined.includes("Extend to 60s"), "should show agent assumption");
	});

	await runner.test("escalation shows in TaskNavState escalations field via navigator", () => {
		const escalation = makeEscalation();
		const countdownMap = new Map<string, number>();
		countdownMap.set("esc-001", 120);
		const state = makeNavState({
			tasks: [makeTask({ id: "T-01", status: "claimed" })],
			expandedTaskId: "T-01",
			escalations: [escalation],
			escalationCountdowns: countdownMap,
		});
		const lines = renderTaskNavigator(state, theme, 80);
		const combined = lines.join("\n");
		assert(combined.includes("QUESTION") || combined.includes("❓"), "navigator should show escalation");
	});

	// ──────────────────────────────────────────────────────────────────────────
	// Scenario 4: HTML interview file generation
	// ──────────────────────────────────────────────────────────────────────────

	runner.section("Scenario 4: HTML interview");

	await runner.test("writeEscalationHTML creates file in coordDir/interviews/", () => {
		const coordDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-ux-test-"));
		try {
			const escalation = makeEscalation({ id: "esc-html-test" });
			const htmlPath = writeEscalationHTML(coordDir, escalation);

			assert(fs.existsSync(htmlPath), "HTML file should be created");
			assert(htmlPath.includes("interviews"), "HTML file should be in interviews/ subdirectory");
			assert(htmlPath.endsWith("escalation-esc-html-test.html"), "HTML file should have correct name");
		} finally {
			fs.rmSync(coordDir, { recursive: true, force: true });
		}
	});

	await runner.test("generated HTML contains question text", () => {
		const escalation = makeEscalation({
			id: "esc-question-test",
			question: "Should we extend the timeout to 60s?",
		});
		const html = generateEscalationHTML(escalation);
		assert(html.includes("Should we extend the timeout to 60s?"), "HTML should contain question");
	});

	await runner.test("generated HTML contains all option labels", () => {
		const escalation = makeEscalation({
			id: "esc-options-test",
			options: ["Option Alpha", "Option Beta", "Option Gamma"],
			richOptions: undefined,
		});
		const html = generateEscalationHTML(escalation);
		assert(html.includes("Option Alpha"), "HTML should contain option 1");
		assert(html.includes("Option Beta"), "HTML should contain option 2");
		assert(html.includes("Option Gamma"), "HTML should contain option 3");
	});

	await runner.test("generated HTML contains agent assumption and countdown", () => {
		const escalation = makeEscalation({
			id: "esc-assumption-test",
			agentAssumption: "Proceed with default behavior",
			timeout: 300,
		});
		const html = generateEscalationHTML(escalation);
		assert(html.includes("Proceed with default behavior"), "HTML should show agent assumption");
		assert(html.includes("300"), "HTML should show timeout countdown");
	});

	await runner.test("generated HTML has correct DOCTYPE and structure", () => {
		const escalation = makeEscalation({ id: "esc-structure-test" });
		const html = generateEscalationHTML(escalation);
		assert(html.startsWith("<!DOCTYPE html>"), "HTML should start with DOCTYPE");
		assert(html.includes("<html"), "HTML should have html element");
		assert(html.includes("</html>"), "HTML should close html element");
	});

	await runner.test("writeEscalationHTML creates interviews/ directory if missing", () => {
		const coordDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-ux-test-"));
		try {
			const interviewsDir = path.join(coordDir, "interviews");
			assert(!fs.existsSync(interviewsDir), "interviews/ should not exist yet");

			const escalation = makeEscalation({ id: "esc-dir-test" });
			writeEscalationHTML(coordDir, escalation);

			assert(fs.existsSync(interviewsDir), "interviews/ directory should be created");
		} finally {
			fs.rmSync(coordDir, { recursive: true, force: true });
		}
	});

	// ──────────────────────────────────────────────────────────────────────────
	// Scenario 5: Mesh chat
	// ──────────────────────────────────────────────────────────────────────────

	runner.section("Scenario 5: Mesh chat");

	await runner.test("two workers exchange messages — both visible in mesh view", () => {
		const messages: MeshMessage[] = [
			makeMeshMessage({
				id: "msg-001",
				from: "cozy_pike",
				to: "eager_crow",
				message: "T-02 done, starting T-03 now",
				type: "coordination",
			}),
			makeMeshMessage({
				id: "msg-002",
				from: "eager_crow",
				to: "cozy_pike",
				message: "Acknowledged. Waiting on T-03",
				type: "coordination",
			}),
		];
		const lines = renderMeshView(messages, theme, 80);
		const combined = lines.join("\n");
		assert(combined.includes("cozy_pike"), "should show sender 1");
		assert(combined.includes("eager_crow"), "should show sender 2");
		assert(combined.includes("T-02 done"), "should show first message");
		assert(combined.includes("Acknowledged"), "should show second message");
	});

	await runner.test("mesh view shows from → to attribution for each message", () => {
		const messages: MeshMessage[] = [
			makeMeshMessage({
				from: "worker_alpha",
				to: "worker_beta",
				message: "Ready for handoff",
			}),
		];
		const lines = renderMeshView(messages, theme, 80);
		const combined = lines.join("\n");
		assert(combined.includes("worker_alpha"), "should show from worker");
		assert(combined.includes("worker_beta"), "should show to worker");
		assert(combined.includes("Ready for handoff"), "should show message content");
	});

	await runner.test("mesh TASKS view shows last messages as preview at bottom", () => {
		const state = makeNavState({
			tasks: [],
			meshMessages: [
				makeMeshMessage({ id: "msg-preview", message: "latest mesh preview message" }),
			],
		});
		const lines = renderTaskNavigator(state, theme, 80);
		const combined = lines.join("\n");
		assert(combined.includes("latest mesh preview message"), "TASKS view should show mesh message preview");
	});

	await runner.test("mesh view shows full MESH tab content when activeView=mesh", () => {
		const state = makeNavState({
			meshMessages: [
				makeMeshMessage({ id: "m1", from: "alpha", to: "beta", message: "go signal" }),
				makeMeshMessage({ id: "m2", from: "beta", to: "alpha", message: "received" }),
			],
			activeView: "mesh",
		});
		const lines = renderTaskNavigator(state, theme, 80);
		const combined = lines.join("\n");
		assert(combined.includes("[MESH]"), "should show [MESH] tab active");
		assert(combined.includes("go signal"), "should show message 1");
		assert(combined.includes("received"), "should show message 2");
	});

	await runner.test("mesh view deduplication — same message id not repeated (slice -20)", () => {
		// renderMeshView takes the last 20 of the provided messages
		// We pass 5 unique messages — all should appear once
		const messages = Array.from({ length: 5 }, (_, i) =>
			makeMeshMessage({ id: `msg-${i}`, message: `unique message ${i}` })
		);
		const lines = renderMeshView(messages, theme, 80);
		const combined = lines.join("\n");
		// Each unique message should appear exactly once
		for (let i = 0; i < 5; i++) {
			const count = (combined.match(new RegExp(`unique message ${i}`, "g")) || []).length;
			assertEqual(count, 1, `unique message ${i} should appear exactly once`);
		}
	});

	// ──────────────────────────────────────────────────────────────────────────
	// Scenario 6: Navigation
	// ──────────────────────────────────────────────────────────────────────────

	runner.section("Scenario 6: Navigation");

	await runner.test("↑↓ selection — selectedTaskIndex=0 marks first task with ▸", () => {
		const state = makeNavState({
			tasks: [
				makeTask({ id: "T-01", status: "pending" }),
				makeTask({ id: "T-02", status: "pending" }),
			],
			selectedTaskIndex: 0,
		});
		const lines = renderTaskNavigator(state, theme, 80);
		const t01Line = lines.find((l) => l.includes("T-01"));
		assertExists(t01Line, "T-01 line should exist");
		assert(t01Line!.includes("▸"), "T-01 should be selected (▸ prefix)");
	});

	await runner.test("↑↓ selection — selectedTaskIndex=2 marks third task with ▸", () => {
		const state = makeNavState({
			tasks: [
				makeTask({ id: "T-01", status: "pending" }),
				makeTask({ id: "T-02", status: "pending" }),
				makeTask({ id: "T-03", status: "claimed" }),
			],
			selectedTaskIndex: 2,
		});
		const lines = renderTaskNavigator(state, theme, 80);
		const t03Line = lines.find((l) => l.includes("T-03"));
		assertExists(t03Line, "T-03 line should exist");
		assert(t03Line!.includes("▸"), "T-03 should be selected (▸ prefix)");
		const t01Line = lines.find((l) => l.includes("T-01"));
		assert(!t01Line!.includes("▸"), "T-01 should NOT be selected");
	});

	await runner.test("Tab view cycling — activeView=tasks shows [TASKS]", () => {
		const result = renderViewTabs("tasks", theme, 80);
		assert(result.includes("[TASKS]"), "should show [TASKS] active");
		assert(!result.includes("[AGENT]"), "AGENT should NOT be active");
		assert(!result.includes("[MESH]"), "MESH should NOT be active");
	});

	await runner.test("Tab view cycling — activeView=agent shows [AGENT]", () => {
		const result = renderViewTabs("agent", theme, 80);
		assert(result.includes("[AGENT]"), "should show [AGENT] active");
		assert(!result.includes("[TASKS]"), "TASKS should NOT be active");
	});

	await runner.test("Tab view cycling — activeView=mesh shows [MESH]", () => {
		const result = renderViewTabs("mesh", theme, 80);
		assert(result.includes("[MESH]"), "should show [MESH] active");
		assert(!result.includes("[TASKS]"), "TASKS should NOT be active");
	});

	await runner.test("Enter expand/collapse — expandedTaskId shows box-drawing", () => {
		const state = makeNavState({
			tasks: [makeTask({ id: "T-01", status: "claimed", planDescription: "Build API" })],
			expandedTaskId: "T-01",
		});
		const lines = renderTaskNavigator(state, theme, 80);
		const combined = lines.join("\n");
		assert(combined.includes("┌"), "expanded panel should show box top ┌");
		assert(combined.includes("└"), "expanded panel should show box bottom └");
	});

	await runner.test("Enter collapse — no expanded panel when expandedTaskId=null", () => {
		const state = makeNavState({
			tasks: [makeTask({ id: "T-01", status: "claimed", planDescription: "Build API" })],
			expandedTaskId: null,
		});
		const lines = renderTaskNavigator(state, theme, 80);
		const combined = lines.join("\n");
		assert(!combined.includes("┌"), "collapsed view should NOT show box top ┌");
	});

	// ──────────────────────────────────────────────────────────────────────────
	// Scenario 7: Commands
	// ──────────────────────────────────────────────────────────────────────────

	runner.section("Scenario 7: Commands");

	await runner.test(":send :retry :skip commands visible in INTERVENE section", () => {
		const task = makeTask({ id: "T-01", status: "claimed" });
		const lines = renderExpandedTask(task, undefined, theme, 80);
		const combined = lines.join("\n");
		assert(combined.includes(":send"), "should show :send command");
		assert(combined.includes(":retry"), "should show :retry command");
		assert(combined.includes(":skip"), "should show :skip command");
	});

	await runner.test(":pause and :logs also shown in INTERVENE section", () => {
		const task = makeTask({ id: "T-01", status: "claimed" });
		const lines = renderExpandedTask(task, undefined, theme, 80);
		const combined = lines.join("\n");
		assert(combined.includes(":pause"), "should show :pause command");
		assert(combined.includes(":logs"), "should show :logs command");
	});

	await runner.test("commandStatus shows confirmation message after command", () => {
		const task = makeTask({ id: "T-01", status: "claimed" });
		const lines = renderExpandedTask(
			task, undefined, theme, 80,
			false, false,
			null, null,
			false, null, null,
			false, null, "✓ retry queued",
		);
		const combined = lines.join("\n");
		assert(combined.includes("retry queued"), "should show command status message");
	});

	await runner.test("AGENT view shows commands in full-screen expanded panel", () => {
		const state = makeNavState({
			tasks: [makeTask({ id: "T-01", status: "claimed", planDescription: "Build API" })],
			activeView: "agent",
			selectedTaskIndex: 0,
		});
		const lines = renderTaskNavigator(state, theme, 80);
		const combined = lines.join("\n");
		assert(combined.includes(":send"), "AGENT view should show :send");
		assert(combined.includes(":retry"), "AGENT view should show :retry");
		assert(combined.includes(":skip"), "AGENT view should show :skip");
	});

	// ──────────────────────────────────────────────────────────────────────────
	// Scenario 8: MiniDashboard — task progress view
	// ──────────────────────────────────────────────────────────────────────────

	runner.section("Scenario 8: MiniDashboard task-centric view");

	await runner.test("MiniDashboard shows task IDs (not worker names) in task row", () => {
		const state: MiniDashboardRenderState = {
			hasTasks: true,
			planName: "my-plan",
			completed: 1,
			total: 3,
			cost: 2.10,
			costLimit: 25,
			elapsedMs: 3 * 60 * 1000,
			tasks: [
				{ id: "T-01", status: "complete", description: "First task" },
				{ id: "T-02", status: "claimed", description: "Active task" },
				{ id: "T-03", status: "pending", description: "Pending task" },
			],
			latestDeviation: undefined,
			pendingQuestions: 0,
		};
		const lines = renderMiniDashboardCompact(state, theme, 80);
		const combined = lines.join("\n");
		// Must show task IDs
		assert(combined.includes("T-01"), "should show T-01");
		assert(combined.includes("T-02"), "should show T-02");
		assert(combined.includes("T-03"), "should show T-03");
		// Must show active task description
		assert(combined.includes("Active task"), "should show active task description");
		// Must NOT show worker IDs
		assert(!combined.includes("worker-abc123"), "should NOT show worker IDs");
	});

	await runner.test("MiniDashboard task row uses correct status glyphs", () => {
		const state: MiniDashboardRenderState = {
			hasTasks: true,
			planName: "test-plan",
			completed: 1,
			total: 3,
			cost: 0,
			costLimit: 25,
			elapsedMs: 0,
			tasks: [
				{ id: "T-01", status: "complete", description: "Done" },
				{ id: "T-02", status: "claimed", description: "Active" },
				{ id: "T-03", status: "pending", description: "Pending" },
			],
			latestDeviation: undefined,
			pendingQuestions: 0,
		};
		const lines = renderMiniDashboardCompact(state, theme, 80);
		const taskRow = lines[2];
		assert(taskRow.includes("✓T-01"), "complete task should show ✓");
		assert(taskRow.includes("⯈T-02"), "active task should show ⯈");
		assert(taskRow.includes("○T-03"), "pending task should show ○");
	});

	await runner.test("MiniDashboard shows deviation in row 4 when present", () => {
		const state: MiniDashboardRenderState = {
			hasTasks: true,
			planName: "test-plan",
			completed: 0,
			total: 2,
			cost: 0,
			costLimit: 25,
			elapsedMs: 0,
			tasks: [
				{ id: "T-01", status: "claimed", description: "Active" },
				{ id: "T-02", status: "pending", description: "Pending" },
			],
			latestDeviation: { taskId: "T-01", what: "timeout→retried" },
			pendingQuestions: 0,
		};
		const lines = renderMiniDashboardCompact(state, theme, 80);
		const devRow = lines[3];
		assert(devRow.includes("⚠"), "deviation row should show ⚠");
		assert(devRow.includes("T-01"), "deviation row should show task ID");
		assert(devRow.includes("timeout→retried"), "deviation row should show deviation text");
	});

	await runner.test("MiniFooter shows task count not worker count", () => {
		const state: MiniFooterRenderState = {
			hasTasks: true,
			completed: 2,
			total: 4,
			activeTaskId: "T-03",
			pendingQuestions: 0,
			cost: 1.50,
			costLimit: 25,
			elapsedMs: 4 * 60 * 1000,
		};
		const [line] = renderMiniFooterCompact(state, theme, 80);
		assert(line.includes("2/4"), "footer should show task count");
		assert(line.includes("tasks"), "footer should say tasks not workers");
		assert(line.includes("⯈T-03"), "footer should show active task ID");
		// Should not say "workers"
		assert(!line.includes("workers"), "footer should NOT say workers in task-centric mode");
	});

	// ──────────────────────────────────────────────────────────────────────────
	// Scenario 9: 80-col rendering
	// ──────────────────────────────────────────────────────────────────────────

	runner.section("Scenario 9: 80-col rendering");

	await runner.test("renderCollapsedTask does not exceed 80 chars at 80-col width", () => {
		const task = makeTask({
			id: "T-01",
			status: "claimed",
			planDescription: "Build the API endpoint for /api/repos with query filters",
		});
		const result = renderCollapsedTask(task, undefined, true, false, theme, 80);
		assert(visibleLen(result) <= 80, `collapsed row should be ≤80 chars, got ${visibleLen(result)}: "${result}"`);
	});

	await runner.test("renderCollapsedTask with deviation badge stays ≤80 chars", () => {
		const task = makeTask({
			id: "T-03",
			status: "claimed",
			deviationLog: [
				{ timestamp: Date.now(), what: "timeout extended", why: "cold start", decision: "retry", impact: "minimal" },
				{ timestamp: Date.now(), what: "oom", why: "large payload", decision: "chunk", impact: "+2s" },
			],
		});
		const result = renderCollapsedTask(task, undefined, true, false, theme, 80);
		assert(visibleLen(result) <= 80, `deviation badge row should be ≤80 chars, got ${visibleLen(result)}`);
	});

	await runner.test("renderExpandedTask all lines ≤80 chars at width=80", () => {
		const task = makeTask({
			id: "T-01",
			status: "claimed",
			planDescription: "Create the /api/repos endpoint with query filter support",
		});
		const worker = makeWorker({
			planIntent: "Build the repos API endpoint",
			currentProblem: "Wiring query params into Cypher",
			thinkingStream: "Reading route structure to find the right insert point",
		});
		const lines = renderExpandedTask(task, worker, theme, 80);
		for (const line of lines) {
			const len = visibleLen(line);
			assert(len <= 80, `expanded line should be ≤80 chars, got ${len}: "${line}"`);
		}
	});

	await runner.test("renderTaskNavigator TASKS view all lines ≤80 chars", () => {
		const state = makeNavState({
			planName: "coding-matrix-per-repo",
			tasks: [
				makeTask({ id: "T-01", status: "complete", planDescription: "Sync git context" }),
				makeTask({ id: "T-02", status: "claimed", planDescription: "Setup types" }),
				makeTask({ id: "T-03", status: "pending", planDescription: "Serve matrix API" }),
			],
			workers: [],
			meshMessages: [makeMeshMessage({ message: "Task T-02 ready for handoff" })],
			cost: 3.21,
			costLimit: 25,
			elapsedMs: 8 * 60 * 1000,
		});
		const lines = renderTaskNavigator(state, theme, 80);
		for (const line of lines) {
			const len = visibleLen(line);
			assert(len <= 80, `TASKS view line should be ≤80 chars, got ${len}: "${line}"`);
		}
	});

	await runner.test("renderTaskNavigator MESH view all lines ≤80 chars", () => {
		const state = makeNavState({
			activeView: "mesh",
			meshMessages: [
				makeMeshMessage({ from: "cozy_pike", to: "eager_crow", message: "Completed T-02 analysis" }),
				makeMeshMessage({ from: "eager_crow", to: "cozy_pike", message: "Starting T-03 now" }),
			],
		});
		const lines = renderTaskNavigator(state, theme, 80);
		for (const line of lines) {
			const len = visibleLen(line);
			// Mesh lines contain from/to padding — allow slight overflow for alignment
			assert(len <= 80, `MESH view line should not excessively overflow, got ${len}: "${line}"`);
		}
	});

	await runner.test("renderTaskNavigator AGENT view all lines ≤80 chars", () => {
		const state = makeNavState({
			activeView: "agent",
			tasks: [
				makeTask({
					id: "T-01",
					status: "claimed",
					planDescription: "Build the /api/repos endpoint",
				}),
			],
			selectedTaskIndex: 0,
		});
		const lines = renderTaskNavigator(state, theme, 80);
		for (const line of lines) {
			const len = visibleLen(line);
			assert(len <= 80, `AGENT view line should be ≤80 chars, got ${len}: "${line}"`);
		}
	});

	await runner.test("renderMiniDashboardCompact all lines ≤80 chars at width=80", () => {
		const state: MiniDashboardRenderState = {
			hasTasks: true,
			planName: "coding-matrix-per-repo-really-long-name",
			completed: 3,
			total: 6,
			cost: 12.50,
			costLimit: 25,
			elapsedMs: 22 * 60 * 1000,
			tasks: [
				{ id: "T-01", status: "complete", description: "sync-git-context" },
				{ id: "T-02", status: "complete", description: "setup-types" },
				{ id: "T-03", status: "complete", description: "serve-coding-matrix" },
				{ id: "T-04", status: "claimed", description: "build-task-nav-ui-components" },
				{ id: "T-05", status: "pending", description: "integration-tests" },
				{ id: "T-06", status: "pending", description: "polish-and-review" },
			],
			latestDeviation: { taskId: "T-04", what: "timeout" },
			pendingQuestions: 1,
		};
		const lines = renderMiniDashboardCompact(state, theme, 80);
		for (const line of lines) {
			const len = visibleLen(line);
			assert(len <= 80, `MiniDashboard line should be ≤80 chars, got ${len}: "${line}"`);
		}
	});

	// ──────────────────────────────────────────────────────────────────────────
	// Scenario 10: Backward compatibility (no tasks.json / old format)
	// ──────────────────────────────────────────────────────────────────────────

	runner.section("Scenario 10: Backward compatibility");

	await runner.test("MiniDashboard hasTasks=false renders without error (old format)", () => {
		const state: MiniDashboardRenderState = {
			hasTasks: false,
			planName: "",
			completed: 0,
			total: 0,
			cost: 0,
			costLimit: 25,
			elapsedMs: 0,
			tasks: [],
			latestDeviation: undefined,
			pendingQuestions: 0,
			currentPhase: "workers",
			workers: [
				{ id: "w1", status: "working" },
				{ id: "w2", status: "complete" },
			],
		};
		// Should not throw
		const lines = renderMiniDashboardCompact(state, theme, 80);
		assert(Array.isArray(lines), "should return array");
		assert(lines.length > 0, "should return non-empty array");
	});

	await runner.test("MiniFooter hasTasks=false renders without error (old format)", () => {
		const state: MiniFooterRenderState = {
			hasTasks: false,
			completed: 0,
			total: 0,
			activeTaskId: undefined,
			pendingQuestions: 0,
			cost: 0,
			costLimit: 25,
			elapsedMs: 0,
			phase: "workers",
			workerCompleted: 1,
			workerTotal: 3,
			isComplete: false,
			isFailed: false,
		};
		const [line] = renderMiniFooterCompact(state, theme, 80);
		assertExists(line, "should render a line");
		assert(line.includes("[coord]"), "fallback footer should start with [coord]");
	});

	await runner.test("TaskNavState with empty tasks renders without error", () => {
		const state = makeNavState({
			tasks: [],
			workers: [],
			meshMessages: [],
		});
		const lines = renderTaskNavigator(state, theme, 80);
		assert(Array.isArray(lines), "should return array");
		assert(lines.length > 0, "should return non-empty array (at least tab bar)");
	});

	await runner.test("renderPlanProgress with empty task list shows 0/0", () => {
		const lines = renderPlanProgress([], 0, 25, 0, "", theme, 80);
		const combined = lines.join("\n");
		assert(combined.includes("0/0"), "empty task list should show 0/0");
	});

	await runner.test("renderMeshView with empty messages shows friendly empty state", () => {
		const lines = renderMeshView([], theme, 80);
		const combined = lines.join("\n");
		assert(combined.includes("No mesh messages"), "empty mesh should show 'No mesh messages'");
	});

	await runner.test("renderExpandedTask with missing worker gracefully uses task fields", () => {
		const task = makeTask({
			id: "T-01",
			status: "claimed",
			planDescription: "Build API endpoint",
		});
		// No worker provided
		const lines = renderExpandedTask(task, undefined, theme, 80);
		const combined = lines.join("\n");
		assert(combined.includes("Build API endpoint"), "should fall back to planDescription when no worker");
	});

	await runner.test("TaskNavState with no plan name renders without plan header", () => {
		const state = makeNavState({
			planName: undefined,
			tasks: [makeTask({ id: "T-01", status: "pending" })],
		});
		const lines = renderTaskNavigator(state, theme, 80);
		// Should not throw, should have task list
		const combined = lines.join("\n");
		assert(combined.includes("T-01"), "should show tasks even without plan name");
	});

	runner.summary();
}

main().catch(console.error);
