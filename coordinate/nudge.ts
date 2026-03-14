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

export async function sendNudge(
	coordDir: string,
	workerId: string,
	payload: NudgePayload,
): Promise<void> {
	const nudgeDir = getNudgeDir(coordDir);
	await fs.mkdir(nudgeDir, { recursive: true });

	const nudgePath = getNudgePath(coordDir, workerId);

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
}

export async function checkNudge(
	coordDir: string,
	workerId: string,
): Promise<NudgePayload | null> {
	const nudgePath = getNudgePath(coordDir, workerId);

	try {
		const content = await fs.readFile(nudgePath, "utf-8");
		return JSON.parse(content);
	} catch {
		return null;
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
): NudgePayload | null {
	const nudgePath = getNudgePath(coordDir, workerId);

	try {
		const content = fsSync.readFileSync(nudgePath, "utf-8");
		return JSON.parse(content);
	} catch {
		return null;
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
