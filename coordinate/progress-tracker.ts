/**
 * Progress tracker for checkpoint/resume support in coordinate().
 *
 * Manages a `progress.json` file in the coordination directory that records
 * completed and failed tasks so a crashed run can be resumed without restarting
 * all already-completed tasks from scratch.
 *
 * Schema:
 * ```json
 * {
 *   "specHash": "<hash of spec file contents>",
 *   "specPath": "<absolute path>",
 *   "startedAt": "<ISO timestamp>",
 *   "completedTasks": ["TASK-01", "TASK-03"],
 *   "failedTasks": ["TASK-02"],
 *   "phase": "workers",
 *   "lastCheckpointAt": "<ISO timestamp>"
 * }
 * ```
 *
 * @module
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

export const PROGRESS_FILE = "progress.json";

export interface ProgressSnapshot {
	/** Hash of the spec file contents at the time the run started */
	specHash: string;
	/** Absolute path to the spec file */
	specPath: string;
	/** ISO timestamp when the original run started */
	startedAt: string;
	/** Task IDs that completed successfully */
	completedTasks: string[];
	/** Task IDs that failed permanently */
	failedTasks: string[];
	/** Task IDs that were in-progress (claimed) at the last checkpoint — may be partially edited */
	claimedTasks: string[];
	/** Pipeline phase at last checkpoint */
	phase: string;
	/** ISO timestamp of the last update */
	lastCheckpointAt: string;
}

/**
 * Load an existing progress snapshot from a coordination directory.
 * Returns null if the file is missing or if the specHash doesn't match.
 *
 * On load, any tasks recorded in `claimedTasks` that are NOT also in
 * `completedTasks` are treated as failed (they were in-progress when the
 * coordinator crashed and may have left partial file edits).  Each such task
 * is logged and merged into `failedTasks` before the snapshot is returned.
 */
export async function loadProgressSnapshot(
	coordDir: string,
	specHash: string,
): Promise<ProgressSnapshot | null> {
	const progressPath = path.join(coordDir, PROGRESS_FILE);
	try {
		const content = await fs.readFile(progressPath, "utf-8");
		const data = JSON.parse(content) as ProgressSnapshot;
		if (data.specHash !== specHash) {
			console.log(
				`[resume] Spec hash mismatch (checkpoint: ${data.specHash}, current: ${specHash}) — ignoring checkpoint`,
			);
			return null;
		}

		// Merge in-progress tasks from a previous crash into failedTasks so they
		// are re-queued for retry on resume.
		const completedSet = new Set(data.completedTasks ?? []);
		const failedSet = new Set(data.failedTasks ?? []);
		for (const taskId of data.claimedTasks ?? []) {
			if (!completedSet.has(taskId)) {
				console.log(`[checkpoint] ${taskId} was in-progress at crash — re-queuing for retry`);
				failedSet.add(taskId);
			}
		}
		data.failedTasks = Array.from(failedSet);
		// Clear claimedTasks after merging so they don't get re-processed on a
		// second resume from the same snapshot.
		data.claimedTasks = [];

		return data;
	} catch {
		return null;
	}
}

/**
 * Delete the progress snapshot file on successful completion.
 * Silently ignores errors (e.g., file not found).
 */
export async function deleteProgressSnapshot(coordDir: string): Promise<void> {
	try {
		await fs.unlink(path.join(coordDir, PROGRESS_FILE));
	} catch {
		// ignore — file may not exist
	}
}

/**
 * Search the session's coordination subdirectories for one that has a
 * `progress.json` whose specHash matches the supplied hash.
 *
 * Returns the most-recently-created matching coordination directory, or null
 * if none is found.  When resume was requested but no prior run exists, a
 * clear warning is emitted so the caller knows a fresh run is starting.
 */
export async function findResumeCoordDir(
	sessionDir: string,
	specHash: string,
): Promise<string | null> {
	const coordBase = path.join(sessionDir, "coordination");
	try {
		const entries = await fs.readdir(coordBase);
		// Sort descending so we try the most recent entries first
		const sorted = entries.slice().sort((a, b) => b.localeCompare(a));
		for (const entry of sorted) {
			const candidate = path.join(coordBase, entry);
			const progressPath = path.join(candidate, PROGRESS_FILE);
			try {
				const raw = await fs.readFile(progressPath, "utf-8");
				const data = JSON.parse(raw) as ProgressSnapshot;
				if (data.specHash === specHash) {
					return candidate;
				}
			} catch {
				// Not a matching dir — continue
			}
		}
		// coordBase exists but no directory matched the spec hash
		console.warn(
			`[checkpoint] No completed-task checkpoint found for spec hash ${specHash} — starting fresh`,
		);
	} catch {
		// coordBase doesn't exist yet
		console.warn(
			"[checkpoint] Resume requested but no prior run found for this spec — starting fresh",
		);
	}
	return null;
}
