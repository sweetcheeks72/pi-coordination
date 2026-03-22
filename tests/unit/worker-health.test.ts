#!/usr/bin/env npx jiti
/**
 * Unit tests for worker-health.ts (TASK-20).
 * Run with: npx jiti tests/unit/worker-health.test.ts
 */

import { TestRunner, assertEqual, assert } from "../test-utils.js";
import {
  getWorkerVisualState,
  renderWorkerCard,
  STALE_THRESHOLD_MS,
  FEYNMAN_MAP,
} from "../../coordinate/worker-health.js";

async function main() {
  const runner = new TestRunner("Worker Health State (TASK-20)");

  await runner.test("working + recent heartbeat → active (cyan ▶)", () => {
    const result = getWorkerVisualState("working", Date.now() - 10_000, Date.now() - 60_000);
    assertEqual(result.state, "active");
    assertEqual(result.icon, "▶");
    assertEqual(result.colorHint, "cyan");
  });

  await runner.test("working + 61s silence → stale (amber ⚠)", () => {
    const now = Date.now();
    const result = getWorkerVisualState("working", now - 61_000, now - 120_000, now);
    assertEqual(result.state, "stale");
    assertEqual(result.icon, "⚠");
    assertEqual(result.colorHint, "amber");
    assert(result.staleSinceMs >= STALE_THRESHOLD_MS, "staleSinceMs should exceed threshold");
  });

  await runner.test("blocked → red ✗", () => {
    const result = getWorkerVisualState("blocked", undefined, Date.now() - 5_000);
    assertEqual(result.state, "blocked");
    assertEqual(result.icon, "✗");
    assertEqual(result.colorHint, "red");
  });

  await runner.test("waiting → red ✗", () => {
    const result = getWorkerVisualState("waiting", undefined, Date.now() - 5_000);
    assertEqual(result.state, "blocked");
    assertEqual(result.colorHint, "red");
  });

  await runner.test("complete → green ✓", () => {
    const result = getWorkerVisualState("complete", Date.now() - 5_000, Date.now() - 30_000);
    assertEqual(result.state, "complete");
    assertEqual(result.icon, "✓");
    assertEqual(result.colorHint, "green");
  });

  await runner.test("failed → red ✗", () => {
    const result = getWorkerVisualState("failed", undefined, Date.now() - 5_000);
    assertEqual(result.state, "failed");
    assertEqual(result.colorHint, "red");
  });

  await runner.test("pending/unknown → dim ○", () => {
    const result = getWorkerVisualState("pending", undefined, undefined);
    assertEqual(result.state, "pending");
    assertEqual(result.icon, "○");
    assertEqual(result.colorHint, "dim");
  });

  await runner.test("working + no heartbeat, uses startedAt as fallback for stale", () => {
    const now = Date.now();
    const result = getWorkerVisualState("working", undefined, now - 90_000, now);
    assertEqual(result.state, "stale");
  });

  await runner.test("FEYNMAN_MAP covers all 7 roles", () => {
    for (const role of ["worker","scout","planner","reviewer","verifier","auditor","researcher"]) {
      assert(FEYNMAN_MAP[role], `Missing Feynman name for ${role}`);
    }
  });

  await runner.test("renders active worker card [Dyson · worker] with ▶ and 50%", () => {
    const card = renderWorkerCard({
      agentType: "worker",
      taskId: "Task-1",
      taskTitle: "auth module",
      completedSteps: 5,
      totalSteps: 10,
      status: "working",
      lastHeartbeatAt: Date.now() - 5_000,
      startedAt: Date.now() - 60_000,
    });
    assert(card.includes("[Dyson · worker]"), `Expected Dyson badge, got: ${card}`);
    assert(card.includes("Task-1"), `Expected task id, got: ${card}`);
    assert(card.includes("50%"), `Expected 50%, got: ${card}`);
    assert(card.includes("▶"), `Expected active icon, got: ${card}`);
  });

  await runner.test("renders stale worker card [Arline · scout] with ⚠", () => {
    const now = Date.now();
    const card = renderWorkerCard({
      agentType: "scout",
      taskId: "Task-2",
      completedSteps: 0,
      totalSteps: 4,
      status: "working",
      lastHeartbeatAt: now - 70_000,
      startedAt: now - 120_000,
      nowMs: now,
    });
    assert(card.includes("[Arline · scout]"), `Expected Arline badge, got: ${card}`);
    assert(card.includes("⚠"), `Expected stale icon, got: ${card}`);
  });

  await runner.test("renders complete worker card [Murray · reviewer] with ✓ 100%", () => {
    const card = renderWorkerCard({
      agentType: "reviewer",
      taskId: "Task-3",
      completedSteps: 4,
      totalSteps: 4,
      status: "complete",
    });
    assert(card.includes("[Murray · reviewer]"), `Expected Murray badge, got: ${card}`);
    assert(card.includes("✓"), `Expected complete icon, got: ${card}`);
    assert(card.includes("100%"), `Expected 100%, got: ${card}`);
  });

  await runner.test("title is optional — card still renders", () => {
    const card = renderWorkerCard({
      agentType: "worker",
      taskId: "T-4",
      completedSteps: 2,
      totalSteps: 4,
      status: "working",
      startedAt: Date.now() - 10_000,
    });
    assert(card.includes("T-4"), `Expected task id, got: ${card}`);
  });

  const { failed } = runner.summary();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error("Test suite failed:", err);
  process.exit(1);
});
