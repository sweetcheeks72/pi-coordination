import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import type { NudgePayload } from "./types.js";

function getNudgeDir(coordDir: string): string {
	return path.join(coordDir, "nudges");
}

function getNudgePath(coordDir: string, workerId: string): string {
	return path.join(getNudgeDir(coordDir), `${workerId}.json`);
}

const STALE_LOCK_THRESHOLD_MS = 30_000;

async function withNudgeLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
	const maxRetries = 50;
	for (let i = 0; i < maxRetries; i++) {
		try {
			const fd = fsSync.openSync(lockPath, fsSync.constants.O_CREAT | fsSync.constants.O_EXCL | fsSync.constants.O_RDWR);
			fsSync.closeSync(fd);
			break;
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code === "EEXIST") {
				try {
					const stat = fsSync.statSync(lockPath);
					if (Date.now() - stat.mtimeMs > STALE_LOCK_THRESHOLD_MS) {
						try { fsSync.unlinkSync(lockPath); } catch {}
					}
				} catch {}
				const delay = Math.min(100 * Math.pow(1.5, i) + Math.random() * 50, 2000);
				await new Promise((r) => setTimeout(r, delay));
				if (i === maxRetries - 1) throw new Error(`Failed to acquire nudge lock: ${lockPath}`);
			} else {
				throw err;
			}
		}
	}
	try {
		return await fn();
	} finally {
		try { fsSync.unlinkSync(lockPath); } catch {}
	}
}

export async function sendNudge(
	coordDir: string,
	workerId: string,
	payload: NudgePayload,
): Promise<void> {
	const nudgeDir = getNudgeDir(coordDir);
	await fs.mkdir(nudgeDir, { recursive: true });

	const nudgePath = getNudgePath(coordDir, workerId);
	const lockPath = `${nudgePath}.lock`;

	// Wrap read-modify-write in a lock to prevent TOCTOU races when multiple
	// callers send nudges to the same worker concurrently.
	await withNudgeLock(lockPath, async () => {
		// Append to existing queue instead of overwriting, so unread nudges are not lost
		let queue: NudgePayload[] = [];
		try {
			const existing = await fs.readFile(nudgePath, "utf-8");
			const parsed: unknown = JSON.parse(existing);
			// Handle both legacy single-nudge format and new array format
			queue = Array.isArray(parsed) ? parsed : [parsed as NudgePayload];
		} catch {
			// File doesn't exist or is invalid — start with empty queue
			queue = [];
		}

		queue.push(payload);
		await fs.writeFile(nudgePath, JSON.stringify(queue, null, 2));
	});
}

export async function checkNudge(
	coordDir: string,
	workerId: string,
): Promise<NudgePayload[]> {
	const nudgePath = getNudgePath(coordDir, workerId);

	try {
		const content = await fs.readFile(nudgePath, "utf-8");
		const parsed: unknown = JSON.parse(content);
		// Handle both legacy single-nudge format and new array format
		return Array.isArray(parsed) ? parsed : [parsed as NudgePayload];
	} catch {
		return [];
	}
}

export async function consumeNudge(
	coordDir: string,
	workerId: string,
): Promise<NudgePayload[]> {
	const nudgePath = getNudgePath(coordDir, workerId);

	try {
		const content = await fs.readFile(nudgePath, "utf-8");
		const parsed: unknown = JSON.parse(content);
		// Handle both legacy single-nudge format and new array format;
		// return all queued nudges so none are silently dropped
		const queue: NudgePayload[] = Array.isArray(parsed) ? parsed : [parsed as NudgePayload];
		await fs.unlink(nudgePath);
		return queue;
	} catch {
		return [];
	}
}

export function checkNudgeSync(
	coordDir: string,
	workerId: string,
): NudgePayload[] {
	const nudgePath = getNudgePath(coordDir, workerId);

	try {
		const content = fsSync.readFileSync(nudgePath, "utf-8");
		const parsed: unknown = JSON.parse(content);
		// Handle both legacy single-nudge format and new array format
		return Array.isArray(parsed) ? parsed : [parsed as NudgePayload];
	} catch {
		return [];
	}
}

export function consumeNudgeSync(
	coordDir: string,
	workerId: string,
): NudgePayload[] {
	const nudgePath = getNudgePath(coordDir, workerId);

	try {
		const content = fsSync.readFileSync(nudgePath, "utf-8");
		const parsed: unknown = JSON.parse(content);
		// Handle both legacy single-nudge format and new array format;
		// return all queued nudges so none are silently dropped
		const queue: NudgePayload[] = Array.isArray(parsed) ? parsed : [parsed as NudgePayload];
		fsSync.unlinkSync(nudgePath);
		return queue;
	} catch {
		return [];
	}
}
