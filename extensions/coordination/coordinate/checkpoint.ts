import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PipelinePhase, PipelineState, Checkpoint, CostState, ReviewIssue } from "./types.js";
import { FileBasedStorage } from "./state.js";

export const PHASE_ORDER: PipelinePhase[] = ["scout", "planner", "coordinator", "workers", "review", "fixes", "complete"];

export function getNextPhase(currentPhase: PipelinePhase): PipelinePhase {
	const idx = PHASE_ORDER.indexOf(currentPhase);
	if (idx === -1 || idx >= PHASE_ORDER.length - 1) return "complete";
	return PHASE_ORDER[idx + 1];
}

export class CheckpointManager {
	constructor(private coordDir: string) {}

	async saveCheckpoint(
		phase: PipelinePhase,
		pipelineState: PipelineState,
		costState?: CostState,
		reviewHistory?: ReviewIssue[][],
	): Promise<string> {
		const storage = new FileBasedStorage(this.coordDir);
		const coordState = await storage.getState();
		const workerStates = await storage.listWorkerStates();

		const checkpoint: Checkpoint = {
			sessionId: pipelineState.sessionId,
			phase,
			timestamp: Date.now(),
			pipelineState,
			coordinationState: coordState,
			workerStates,
			costState,
			reviewHistory,
		};

		const checkpointId = `${phase}-${Date.now()}`;
		const checkpointPath = path.join(this.coordDir, "checkpoints", `${checkpointId}.json`);
		await fs.mkdir(path.dirname(checkpointPath), { recursive: true });
		await fs.writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2));

		return checkpointId;
	}

	async loadCheckpoint(checkpointId: string): Promise<Checkpoint> {
		const checkpointPath = path.join(this.coordDir, "checkpoints", `${checkpointId}.json`);
		return JSON.parse(await fs.readFile(checkpointPath, "utf-8"));
	}

	async listCheckpoints(): Promise<{ id: string; phase: PipelinePhase; timestamp: number }[]> {
		const dir = path.join(this.coordDir, "checkpoints");
		try {
			const files = await fs.readdir(dir);
			const checkpoints: { id: string; phase: PipelinePhase; timestamp: number }[] = [];
			for (const f of files) {
				if (!f.endsWith(".json")) continue;
				const content = JSON.parse(await fs.readFile(path.join(dir, f), "utf-8"));
				checkpoints.push({ id: f.replace(".json", ""), phase: content.phase, timestamp: content.timestamp });
			}
			return checkpoints.sort((a, b) => b.timestamp - a.timestamp);
		} catch {
			return [];
		}
	}

	async getLatestCheckpoint(): Promise<Checkpoint | null> {
		const list = await this.listCheckpoints();
		if (list.length === 0) return null;
		return this.loadCheckpoint(list[0].id);
	}

	async restoreFromCheckpoint(
		checkpointId: string,
		storage: FileBasedStorage,
	): Promise<{
		pipelineState: PipelineState;
		nextPhase: PipelinePhase;
		costState?: CostState;
		reviewHistory?: ReviewIssue[][];
	}> {
		const checkpoint = await this.loadCheckpoint(checkpointId);

		await storage.setState(checkpoint.coordinationState);
		for (const ws of checkpoint.workerStates) {
			await storage.writeWorkerState(ws.id, ws);
		}

		const nextPhase = getNextPhase(checkpoint.phase);
		const pipelineState = {
			...checkpoint.pipelineState,
			currentPhase: nextPhase,
		};

		return {
			pipelineState,
			nextPhase,
			costState: checkpoint.costState,
			reviewHistory: checkpoint.reviewHistory,
		};
	}
}
