#!/usr/bin/env npx jiti
/**
 * Unit tests for steer.ts (TASK-21).
 * Run with: npx jiti tests/unit/steer.test.ts
 */

import { TestRunner, assertEqual, assert } from "../test-utils.js";
import { registerControls, unregisterControls } from "../../coordinate/worker-control-registry.js";
import { steerWorkers, abortWorker, wrapUpWorker } from "../../coordinate/steer.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

async function main() {
  const runner = new TestRunner("Steer/Abort/Wrap-up (TASK-21)");

  // ── steerWorkers ────────────────────────────────────────────────────────────

  await runner.test("steerWorkers — steers registered workers", async () => {
    let steered = "";
    registerControls("w1", { steer: async (msg) => { steered = msg; } });
    const result = await steerWorkers(["w1"], "focus on auth module");
    assertEqual(result.succeeded.length, 1);
    assertEqual(result.failed.length, 0);
    assertEqual(result.action, "steer");
    assertEqual(steered, "focus on auth module");
    unregisterControls("w1");
  });

  await runner.test("steerWorkers — skips workers without steer control", async () => {
    const result = await steerWorkers(["ghost-worker"], "message");
    assertEqual(result.succeeded.length, 0);
    assertEqual(result.failed.length, 1);
    assertEqual(result.failed[0], "ghost-worker");
  });

  await runner.test("steerWorkers — partial success (some workers found, some not)", async () => {
    registerControls("w2", { steer: async () => {} });
    const result = await steerWorkers(["w2", "no-worker"], "steer all");
    assertEqual(result.succeeded.length, 1);
    assertEqual(result.failed.length, 1);
    unregisterControls("w2");
  });

  await runner.test("steerWorkers — empty worker list returns empty result", async () => {
    const result = await steerWorkers([], "message");
    assertEqual(result.succeeded.length, 0);
    assertEqual(result.failed.length, 0);
  });

  // ── abortWorker ─────────────────────────────────────────────────────────────

  await runner.test("abortWorker — calls abort fn for registered worker", () => {
    let aborted = false;
    registerControls("w3", { abort: () => { aborted = true; } });
    const result = abortWorker("w3");
    assertEqual(result.action, "abort");
    assertEqual(result.succeeded.length, 1);
    assert(aborted, "abort fn should have been called");
    assert(result.message.includes("PARTIAL"), "message should mention PARTIAL");
    unregisterControls("w3");
  });

  await runner.test("abortWorker — graceful for unregistered worker", () => {
    const result = abortWorker("ghost-abort");
    assertEqual(result.succeeded.length, 0);
    assertEqual(result.failed.length, 1);
    assert(result.message.includes("no registered"), "message should explain missing control");
  });

  // ── wrapUpWorker ────────────────────────────────────────────────────────────

  await runner.test("wrapUpWorker — writes nudge file to coordDir", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "steer-test-"));
    await fs.mkdir(path.join(tmpDir, "nudges"), { recursive: true });

    const result = await wrapUpWorker("w4", tmpDir);
    assertEqual(result.action, "wrap-up");
    assertEqual(result.succeeded.length, 1);

    const nudgeFile = path.join(tmpDir, "nudges", "w4.json");
    const exists = await fs.access(nudgeFile).then(() => true).catch(() => false);
    assert(exists, `Nudge file should exist at ${nudgeFile}`);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  await runner.test("wrapUpWorker — fails gracefully if nudge dir missing", async () => {
    const result = await wrapUpWorker("w5", "/nonexistent/path");
    assertEqual(result.failed.length, 1);
    assertEqual(result.succeeded.length, 0);
  });

  const { failed } = runner.summary();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error("Test suite failed:", err);
  process.exit(1);
});
