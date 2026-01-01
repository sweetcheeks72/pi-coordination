import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type {
	PipelinePhase,
	CoordinationState,
	WorkerStateFile,
	FileReservation,
	CostState,
} from "../types.js";
import { FileBasedStorage } from "../state.js";
import type { SnapshotDiff } from "./types.js";

const execPromise = promisify(exec);

interface StateSnapshot {
	id: string;
	traceId: string;
	timestamp: number;
	trigger: "phase_start" | "phase_end" | "checkpoint" | "error" | "manual";
	phase: PipelinePhase;
	coordinationState: CoordinationState;
	workerStates: WorkerStateFile[];
	reservations: FileReservation[];
	git: {
		branch: string;
		commit: string;
		isDirty: boolean;
		untrackedFiles: string[];
		modifiedFiles: string[];
		stagedFiles: string[];
	};
	files: Array<{
		path: string;
		exists: boolean;
		size?: number;
		hash?: string;
		mtime?: number;
	}>;
	costState: CostState;
	env: {
		nodeVersion: string;
		platform: string;
		cwd: string;
	};
}

export class SnapshotManager {
	constructor(
		private coordDir: string,
		private traceId: string,
		private cwd: string,
	) {}

	async capture(
		trigger: StateSnapshot["trigger"],
		phase: PipelinePhase,
		trackedFiles?: string[],
	): Promise<string> {
		const id = `snapshot-${Date.now()}`;

		const storage = new FileBasedStorage(this.coordDir);

		let coordinationState: CoordinationState;
		try {
			coordinationState = await storage.getState();
		} catch {
			coordinationState = {} as CoordinationState;
		}

		const snapshot: StateSnapshot = {
			id,
			traceId: this.traceId,
			timestamp: Date.now(),
			trigger,
			phase,
			coordinationState,
			workerStates: await storage.listWorkerStates(),
			reservations: await storage.getActiveReservations(),
			git: await this.captureGitState(),
			files: await this.captureFileState(trackedFiles || []),
			costState: await storage.getCostState(),
			env: {
				nodeVersion: process.version,
				platform: process.platform,
				cwd: this.cwd,
			},
		};

		await fs.mkdir(path.join(this.coordDir, "snapshots"), { recursive: true });
		await fs.writeFile(
			path.join(this.coordDir, "snapshots", `${id}.json`),
			JSON.stringify(snapshot, null, 2),
		);

		return id;
	}

	private async captureGitState(): Promise<StateSnapshot["git"]> {
		const run = async (cmd: string): Promise<string> => {
			try {
				const { stdout } = await execPromise(cmd, { cwd: this.cwd });
				return stdout.trim();
			} catch {
				return "";
			}
		};

		return {
			branch: await run("git branch --show-current"),
			commit: await run("git rev-parse HEAD"),
			isDirty: (await run("git status --porcelain")).length > 0,
			untrackedFiles: (await run("git ls-files --others --exclude-standard")).split("\n").filter(Boolean),
			modifiedFiles: (await run("git diff --name-only")).split("\n").filter(Boolean),
			stagedFiles: (await run("git diff --cached --name-only")).split("\n").filter(Boolean),
		};
	}

	private async captureFileState(files: string[]): Promise<StateSnapshot["files"]> {
		const results: StateSnapshot["files"] = [];

		for (const file of files) {
			const fullPath = path.resolve(this.cwd, file);
			try {
				const stat = await fs.stat(fullPath);
				const content = await fs.readFile(fullPath);
				const hash = createHash("sha256").update(content).digest("hex");

				results.push({
					path: file,
					exists: true,
					size: stat.size,
					hash,
					mtime: stat.mtimeMs,
				});
			} catch {
				results.push({ path: file, exists: false });
			}
		}

		return results;
	}

	async diff(snapshotId1: string, snapshotId2: string): Promise<SnapshotDiff> {
		const s1 = JSON.parse(await fs.readFile(
			path.join(this.coordDir, "snapshots", `${snapshotId1}.json`), "utf-8"
		)) as StateSnapshot;
		const s2 = JSON.parse(await fs.readFile(
			path.join(this.coordDir, "snapshots", `${snapshotId2}.json`), "utf-8"
		)) as StateSnapshot;

		const s1Files = new Map(s1.files.map(f => [f.path, f]));
		const s2Files = new Map(s2.files.map(f => [f.path, f]));

		const filesAdded = s2.files.filter(f => f.exists && !s1Files.has(f.path)).map(f => f.path);
		const filesRemoved = s1.files.filter(f => f.exists && !s2Files.get(f.path)?.exists).map(f => f.path);
		const filesModified = s2.files
			.filter(f => {
				const s1f = s1Files.get(f.path);
				return s1f && f.exists && s1f.exists && f.hash !== s1f.hash;
			})
			.map(f => ({
				path: f.path,
				beforeHash: s1Files.get(f.path)!.hash!,
				afterHash: f.hash!,
			}));

		const s1Contracts = new Set(Object.keys(s1.coordinationState.contracts || {}));
		const s2Contracts = new Set(Object.keys(s2.coordinationState.contracts || {}));
		const s1Workers = new Set(s1.workerStates.map(w => w.id));
		const s2Workers = new Set(s2.workerStates.map(w => w.id));

		return {
			filesAdded,
			filesRemoved,
			filesModified,
			gitChanges: {
				newCommits: s1.git.commit !== s2.git.commit ? [s2.git.commit] : [],
				stagedChanges: s2.git.stagedFiles.filter(f => !s1.git.stagedFiles.includes(f)),
			},
			stateChanges: {
				contractsCreated: [...s2Contracts].filter(c => !s1Contracts.has(c)),
				contractsCompleted: Object.entries(s2.coordinationState.contracts || {})
					.filter(([k, v]) => v.status === "ready" && s1.coordinationState.contracts?.[k]?.status !== "ready")
					.map(([k]) => k),
				workersSpawned: [...s2Workers].filter(w => !s1Workers.has(w)),
				workersCompleted: s2.workerStates
					.filter(w => w.status === "complete" && s1.workerStates.find(w1 => w1.id === w.id)?.status !== "complete")
					.map(w => w.id),
			},
		};
	}

	async listSnapshots(): Promise<Array<{ id: string; trigger: string; phase: PipelinePhase; timestamp: number }>> {
		const dir = path.join(this.coordDir, "snapshots");
		try {
			const files = await fs.readdir(dir);
			const snapshots: Array<{ id: string; trigger: string; phase: PipelinePhase; timestamp: number }> = [];

			for (const file of files) {
				if (!file.endsWith(".json")) continue;
				const content = JSON.parse(await fs.readFile(path.join(dir, file), "utf-8")) as StateSnapshot;
				snapshots.push({
					id: content.id,
					trigger: content.trigger,
					phase: content.phase,
					timestamp: content.timestamp,
				});
			}

			return snapshots.sort((a, b) => a.timestamp - b.timestamp);
		} catch {
			return [];
		}
	}
}
