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
	await fs.writeFile(nudgePath, JSON.stringify(payload, null, 2));
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
): Promise<NudgePayload | null> {
	const nudgePath = getNudgePath(coordDir, workerId);

	try {
		const content = await fs.readFile(nudgePath, "utf-8");
		const payload: NudgePayload = JSON.parse(content);
		await fs.unlink(nudgePath);
		return payload;
	} catch {
		return null;
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
): NudgePayload | null {
	const nudgePath = getNudgePath(coordDir, workerId);

	try {
		const content = fsSync.readFileSync(nudgePath, "utf-8");
		const payload: NudgePayload = JSON.parse(content);
		fsSync.unlinkSync(nudgePath);
		return payload;
	} catch {
		return null;
	}
}
