/**
 * Steer/Abort/Wrap-up controls for coordination sessions (TASK-21).
 *
 * Provides broadcast-to-all-workers steering, graceful abort with ⏳ PARTIAL
 * signal, and soft wrap-up (finish current subtask, exit cleanly).
 *
 * Integrates with the existing worker-control-registry and nudge system.
 */

import * as path from "node:path";
import { getSteer, getAbort, getControls } from "./worker-control-registry.js";
import { sendNudge } from "./nudge.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type SteerAction = "steer" | "abort" | "wrap-up";

export interface SteerResult {
  action: SteerAction;
  targetWorkers: string[];
  succeeded: string[];
  failed: string[];
  message: string;
}

// ── Steer — broadcast message to active workers ───────────────────────────────

/**
 * Broadcast a steering message to all workers that have registered steer controls.
 * Workers receive the message injected as context within 2 turns.
 *
 * @param workerIds — list of worker IDs to steer (or empty for all registered)
 * @param message — guidance to inject into worker context
 */
export async function steerWorkers(
  workerIds: string[],
  message: string,
): Promise<SteerResult> {
  const succeeded: string[] = [];
  const failed: string[] = [];

  for (const id of workerIds) {
    const steerFn = getSteer(id);
    if (steerFn) {
      try {
        await steerFn(message);
        succeeded.push(id);
      } catch {
        failed.push(id);
      }
    } else {
      failed.push(id);
    }
  }

  return {
    action: "steer",
    targetWorkers: workerIds,
    succeeded,
    failed,
    message: `Steered ${succeeded.length}/${workerIds.length} workers`,
  };
}

// ── Abort — graceful task cancellation with ⏳ PARTIAL ───────────────────────

/**
 * Abort a specific worker/task. The worker completes its current tool call,
 * then emits ⏳ PARTIAL with a reason.
 *
 * @param workerId — ID of the worker to abort
 */
export function abortWorker(workerId: string): SteerResult {
  const abortFn = getAbort(workerId);
  const succeeded: string[] = [];
  const failed: string[] = [];

  if (abortFn) {
    abortFn();
    succeeded.push(workerId);
  } else {
    failed.push(workerId);
  }

  return {
    action: "abort",
    targetWorkers: [workerId],
    succeeded,
    failed,
    message: succeeded.length > 0
      ? `⏳ PARTIAL: Worker ${workerId} abort signal sent`
      : `Worker ${workerId} has no registered abort control`,
  };
}

// ── Wrap-up — soft stop via nudge file ───────────────────────────────────────

/**
 * Send wrap-up nudge to a worker via the nudge file system.
 * Worker will finish its current subtask and exit cleanly.
 *
 * @param workerId — ID of the worker to wrap up
 * @param coordDir — coordination directory containing nudge files
 */
export async function wrapUpWorker(
  workerId: string,
  coordDir: string,
): Promise<SteerResult> {
  const succeeded: string[] = [];
  const failed: string[] = [];

  try {
    await sendNudge(coordDir, workerId, {
      type: "wrap_up",
      message: "Wrap up requested — finish current subtask and exit cleanly.",
    });
    succeeded.push(workerId);
  } catch {
    failed.push(workerId);
  }

  return {
    action: "wrap-up",
    targetWorkers: [workerId],
    succeeded,
    failed,
    message: succeeded.length > 0
      ? `Wrap-up signal sent to ${workerId}`
      : `Failed to send wrap-up to ${workerId}`,
  };
}

// ── Broadcast wrap-up to all workers in a coordDir ───────────────────────────

/**
 * Broadcast wrap-up to all registered workers by scanning coordDir/nudges.
 */
export async function wrapUpAllWorkers(
  workerIds: string[],
  coordDir: string,
): Promise<SteerResult> {
  const succeeded: string[] = [];
  const failed: string[] = [];

  for (const id of workerIds) {
    try {
      await sendNudge(coordDir, id, {
        type: "wrap_up",
        message: "Wrap up all — finish current subtask and exit cleanly.",
      });
      succeeded.push(id);
    } catch {
      failed.push(id);
    }
  }

  return {
    action: "wrap-up",
    targetWorkers: workerIds,
    succeeded,
    failed,
    message: `Wrap-up sent to ${succeeded.length}/${workerIds.length} workers`,
  };
}
