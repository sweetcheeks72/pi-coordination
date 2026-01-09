import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import type {
	CoordinationMessage,
	CoordinationState,
	CoordinationEvent,
	WorkerStateFile,
	EscalationRequest,
	EscalationResponse,
	FileReservation,
	CostState,
	PipelinePhase,
	ReviewIssue,
} from "./types.js";

export class FileBasedStorage {
	constructor(private _coordDir: string) {}

	get coordDir(): string {
		return this._coordDir;
	}

	private async withLock<T>(lockName: string, fn: () => Promise<T>): Promise<T> {
		const lockPath = path.join(this._coordDir, `${lockName}.lock`);
		const maxRetries = 50;
		const retryDelay = 100;

		try {
			fsSync.mkdirSync(this._coordDir, { recursive: true });
		} catch {}

		for (let i = 0; i < maxRetries; i++) {
			try {
				const fd = fsSync.openSync(lockPath, fsSync.constants.O_CREAT | fsSync.constants.O_EXCL | fsSync.constants.O_RDWR);
				fsSync.closeSync(fd);
				break;
			} catch (err: unknown) {
				if ((err as NodeJS.ErrnoException).code === "EEXIST") {
					await new Promise((r) => setTimeout(r, retryDelay));
					if (i === maxRetries - 1) throw new Error(`Failed to acquire lock: ${lockName}`);
				} else {
					throw err;
				}
			}
		}

		try {
			return await fn();
		} finally {
			try {
				fsSync.unlinkSync(lockPath);
			} catch {}
		}
	}

	async initialize(): Promise<void> {
		await fs.mkdir(path.join(this._coordDir, "messages"), { recursive: true });
		await fs.mkdir(path.join(this._coordDir, "reservations"), { recursive: true });
		await fs.mkdir(path.join(this._coordDir, "escalation-responses"), { recursive: true });
		await fs.mkdir(path.join(this._coordDir, "inputs"), { recursive: true });
		await fs.mkdir(path.join(this._coordDir, "outputs"), { recursive: true });
		await fs.mkdir(path.join(this._coordDir, "artifacts"), { recursive: true });
		const eventsPath = path.join(this._coordDir, "events.jsonl");
		const escPath = path.join(this._coordDir, "escalations.jsonl");
		try {
			await fs.access(eventsPath);
		} catch {
			await fs.writeFile(eventsPath, "");
		}
		try {
			await fs.access(escPath);
		} catch {
			await fs.writeFile(escPath, "");
		}
	}

	async getState(): Promise<CoordinationState> {
		const content = await fs.readFile(path.join(this._coordDir, "state.json"), "utf-8");
		return JSON.parse(content);
	}

	async setState(state: CoordinationState): Promise<void> {
		await fs.writeFile(path.join(this._coordDir, "state.json"), JSON.stringify(state, null, 2));
	}

	async updateState(updates: Partial<CoordinationState>): Promise<void> {
		await this.withLock("state", async () => {
			const current = await this.getState();
			await fs.writeFile(path.join(this._coordDir, "state.json"), JSON.stringify({ ...current, ...updates }, null, 2));
		});
	}

	async updateContract(
		itemName: string,
		updater: (contract: import("./types.js").Contract | undefined) => import("./types.js").Contract | undefined,
	): Promise<import("./types.js").Contract | undefined> {
		return this.withLock("state", async () => {
			const current = await this.getState();
			const updated = updater(current.contracts[itemName]);
			if (updated) {
				current.contracts[itemName] = updated;
			} else if (current.contracts[itemName]) {
				delete current.contracts[itemName];
			}
			await fs.writeFile(path.join(this._coordDir, "state.json"), JSON.stringify(current, null, 2));
			return updated;
		});
	}

	async readWorkerState(workerId: string): Promise<WorkerStateFile> {
		const filePath = path.join(this._coordDir, `worker-${workerId}.json`);
		const content = await fs.readFile(filePath, "utf-8");
		return JSON.parse(content);
	}

	async writeWorkerState(workerId: string, state: WorkerStateFile): Promise<void> {
		const filePath = path.join(this._coordDir, `worker-${workerId}.json`);
		const tempPath = `${filePath}.tmp`;
		await fs.writeFile(tempPath, JSON.stringify(state, null, 2));
		await fs.rename(tempPath, filePath);
	}

	async updateWorkerState(
		workerId: string,
		updater: (state: WorkerStateFile) => WorkerStateFile
	): Promise<WorkerStateFile> {
		return this.withLock(`worker-${workerId}`, async () => {
			const current = await this.readWorkerState(workerId);
			const updated = updater(current);
			await this.writeWorkerState(workerId, updated);
			return updated;
		});
	}

	async listWorkerStates(): Promise<WorkerStateFile[]> {
		let files: string[];
		try {
			files = await fs.readdir(this._coordDir);
		} catch {
			return [];
		}

		const workerFiles = files.filter(f => f.startsWith("worker-") && f.endsWith(".json"));
		const states: WorkerStateFile[] = [];

		for (const file of workerFiles) {
			try {
				const content = await fs.readFile(path.join(this._coordDir, file), "utf-8");
				states.push(JSON.parse(content));
			} catch {}
		}

		return states;
	}

	async appendEvent(event: CoordinationEvent): Promise<void> {
		await fs.appendFile(
			path.join(this._coordDir, "events.jsonl"),
			JSON.stringify(event) + "\n"
		);
	}

	async getEvents(): Promise<CoordinationEvent[]> {
		try {
			const content = await fs.readFile(
				path.join(this._coordDir, "events.jsonl"),
				"utf-8"
			);
			return content
				.trim()
				.split("\n")
				.filter(Boolean)
				.map(line => JSON.parse(line));
		} catch {
			return [];
		}
	}

	async appendEscalation(req: EscalationRequest): Promise<void> {
		await fs.appendFile(path.join(this._coordDir, "escalations.jsonl"), JSON.stringify(req) + "\n");
	}

	async getEscalationResponse(id: string): Promise<EscalationResponse | null> {
		try {
			const content = await fs.readFile(path.join(this._coordDir, "escalation-responses", `${id}.json`), "utf-8");
			return JSON.parse(content);
		} catch {
			return null;
		}
	}

	async writeEscalationResponse(response: EscalationResponse): Promise<void> {
		await fs.writeFile(
			path.join(this._coordDir, "escalation-responses", `${response.id}.json`),
			JSON.stringify(response),
		);
	}

	async sendMessage(msg: CoordinationMessage & { expiresAt?: number }): Promise<void> {
		const filename = `${msg.timestamp}-${msg.id}.json`;
		await fs.writeFile(path.join(this._coordDir, "messages", filename), JSON.stringify(msg));
	}

	async getMessages(filter?: { to?: string; since?: number; includeExpired?: boolean }): Promise<CoordinationMessage[]> {
		const dir = path.join(this._coordDir, "messages");
		let files: string[];
		try {
			files = await fs.readdir(dir);
		} catch {
			return [];
		}

		const now = Date.now();
		const messages: CoordinationMessage[] = [];
		for (const file of files.sort()) {
			if (!file.endsWith(".json")) continue;
			const content = await fs.readFile(path.join(dir, file), "utf-8");
			const msg: CoordinationMessage & { expiresAt?: number } = JSON.parse(content);

			// Filter expired messages (TASK-28)
			if (!filter?.includeExpired && msg.expiresAt && msg.expiresAt < now) continue;

			if (filter?.since && msg.timestamp < filter.since) continue;
			if (filter?.to && msg.to !== filter.to && msg.to !== "all") continue;

			messages.push(msg);
		}
		return messages;
	}

	/**
	 * Get unread messages for a worker (TASK-27).
	 * Uses message-read.json to track which messages each worker has seen.
	 */
	async getUnreadMessages(workerId: string, filter?: { to?: string; since?: number }): Promise<CoordinationMessage[]> {
		const readIds = await this.getReadMessageIds(workerId);
		const allMessages = await this.getMessages(filter);

		return allMessages.filter((msg) => !readIds.has(msg.id));
	}

	/**
	 * Mark messages as read by a worker.
	 */
	async markMessagesRead(workerId: string, messageIds: string[]): Promise<void> {
		await this.withLock("message-read", async () => {
			const readState = await this.loadMessageReadState();
			const workerReads = readState[workerId] || [];

			for (const id of messageIds) {
				if (!workerReads.includes(id)) {
					workerReads.push(id);
				}
			}

			readState[workerId] = workerReads;
			await this.saveMessageReadState(readState);
		});
	}

	/**
	 * Get read message IDs for a worker.
	 */
	async getReadMessageIds(workerId: string): Promise<Set<string>> {
		const readState = await this.loadMessageReadState();
		return new Set(readState[workerId] || []);
	}

	private async loadMessageReadState(): Promise<Record<string, string[]>> {
		const readPath = path.join(this._coordDir, "message-read.json");
		try {
			const content = await fs.readFile(readPath, "utf-8");
			return JSON.parse(content);
		} catch {
			return {};
		}
	}

	private async saveMessageReadState(state: Record<string, string[]>): Promise<void> {
		const readPath = path.join(this._coordDir, "message-read.json");
		await fs.writeFile(readPath, JSON.stringify(state, null, 2));
	}

	/**
	 * Clean up expired messages from disk.
	 */
	async cleanupExpiredMessages(): Promise<number> {
		const dir = path.join(this._coordDir, "messages");
		let files: string[];
		try {
			files = await fs.readdir(dir);
		} catch {
			return 0;
		}

		const now = Date.now();
		let cleaned = 0;

		for (const file of files) {
			if (!file.endsWith(".json")) continue;
			const filePath = path.join(dir, file);
			try {
				const content = await fs.readFile(filePath, "utf-8");
				const msg: CoordinationMessage & { expiresAt?: number } = JSON.parse(content);

				if (msg.expiresAt && msg.expiresAt < now) {
					await fs.unlink(filePath);
					cleaned++;
				}
			} catch {
				// Skip invalid files
			}
		}

		return cleaned;
	}

	async reserveFiles(
		reservation: FileReservation,
	): Promise<{ success: boolean; conflict?: FileReservation }> {
		return this.withLock("reservations", async () => {
			const active = await this.getActiveReservations();

			for (const existing of active) {
				if (existing.agent === reservation.agent) continue;
				if (!existing.exclusive && !reservation.exclusive) continue;
				if (this.patternsOverlap(existing.patterns, reservation.patterns)) {
					return { success: false, conflict: existing };
				}
			}

			await fs.writeFile(
				path.join(this._coordDir, "reservations", `${reservation.id}.json`),
				JSON.stringify(reservation),
			);

			return { success: true };
		});
	}

	async checkReservation(filePath: string): Promise<FileReservation | null> {
		const active = await this.getActiveReservations();
		for (const res of active) {
			if (this.matchesPatterns(filePath, res.patterns)) {
				return res;
			}
		}
		return null;
	}

	async getActiveReservations(): Promise<FileReservation[]> {
		const dir = path.join(this._coordDir, "reservations");
		let files: string[];
		try {
			files = await fs.readdir(dir);
		} catch {
			return [];
		}

		const now = Date.now();
		const active: FileReservation[] = [];

		for (const file of files) {
			if (!file.endsWith(".json")) continue;
			const content = await fs.readFile(path.join(dir, file), "utf-8");
			const res: FileReservation = JSON.parse(content);
			if (!res.releasedAt && res.expiresAt > now) {
				active.push(res);
			}
		}

		return active;
	}

	async releaseFiles(agentIdentity: string, _patterns: string[]): Promise<void> {
		await this.withLock("reservations", async () => {
			const dir = path.join(this._coordDir, "reservations");
			let files: string[];
			try {
				files = await fs.readdir(dir);
			} catch {
				return;
			}

			for (const file of files) {
				if (!file.endsWith(".json")) continue;
				const filePath = path.join(dir, file);
				const content = await fs.readFile(filePath, "utf-8");
				const res: FileReservation = JSON.parse(content);
				if (res.agent === agentIdentity && !res.releasedAt) {
					res.releasedAt = Date.now();
					await fs.writeFile(filePath, JSON.stringify(res));
				}
			}
		});
	}

	async updateProgress(content: string): Promise<void> {
		await fs.writeFile(path.join(this._coordDir, "PROGRESS.md"), content);
	}

	async getProgress(): Promise<string | null> {
		try {
			return await fs.readFile(path.join(this._coordDir, "PROGRESS.md"), "utf-8");
		} catch {
			return null;
		}
	}

	async transferReservation(reservationId: string, newAgent: string): Promise<void> {
		return this.withLock("reservations", async () => {
			const filePath = path.join(this._coordDir, "reservations", `${reservationId}.json`);
			try {
				const content = await fs.readFile(filePath, "utf-8");
				const reservation: FileReservation = JSON.parse(content);
				reservation.agent = newAgent;
				await fs.writeFile(filePath, JSON.stringify(reservation, null, 2));
			} catch {}
		});
	}

	async appendDeviation(deviation: import("./types.js").Deviation): Promise<void> {
		await this.withLock("state", async () => {
			const state = await this.getState();
			state.deviations = [...(state.deviations || []), deviation];
			await this.setState(state);
		});
	}

	async updatePhaseCost(phase: PipelinePhase, amount: number): Promise<void> {
		await this.withLock("cost", async () => {
			const costPath = path.join(this._coordDir, "cost.json");
			let costState: CostState;
			try {
				costState = JSON.parse(await fs.readFile(costPath, "utf-8"));
			} catch {
				costState = {
					total: 0,
					byPhase: {} as Record<PipelinePhase, number>,
					byWorker: {},
					limit: 40,
					limitReached: false,
				};
			}

			costState.byPhase[phase] = (costState.byPhase[phase] || 0) + amount;
			costState.total += amount;

			await fs.writeFile(costPath, JSON.stringify(costState, null, 2));
		});
	}

	async getCostState(): Promise<CostState> {
		const costPath = path.join(this._coordDir, "cost.json");
		try {
			return JSON.parse(await fs.readFile(costPath, "utf-8"));
		} catch {
			return {
				total: 0,
				byPhase: {} as Record<PipelinePhase, number>,
				byWorker: {},
				limit: 40,
				limitReached: false,
			};
		}
	}

	async trackIssue(issue: ReviewIssue): Promise<void> {
		await this.withLock("issues", async () => {
			const historyPath = path.join(this._coordDir, "issue-history.json");
			let history: Record<string, { cycle: number; status: string }[]> = {};
			try {
				history = JSON.parse(await fs.readFile(historyPath, "utf-8"));
			} catch {}

			history[issue.id] = history[issue.id] || [];
			history[issue.id].push({ cycle: issue.fixAttempts, status: "found" });

			await fs.writeFile(historyPath, JSON.stringify(history, null, 2));
		});
	}

	async isIssuePersistent(issueId: string, threshold: number): Promise<boolean> {
		const historyPath = path.join(this._coordDir, "issue-history.json");
		try {
			const history = JSON.parse(await fs.readFile(historyPath, "utf-8"));
			return (history[issueId]?.length || 0) >= threshold;
		} catch {
			return false;
		}
	}

	private patternsOverlap(a: string[], b: string[]): boolean {
		for (const pa of a) {
			for (const pb of b) {
				if (pa === pb) return true;
				if (this.simpleMatch(pa, pb) || this.simpleMatch(pb, pa)) return true;
			}
		}
		return false;
	}

	private matchesPatterns(filePath: string, patterns: string[]): boolean {
		for (const pattern of patterns) {
			if (this.simpleMatch(filePath, pattern)) return true;
		}
		return false;
	}

	private simpleMatch(str: string, pattern: string): boolean {
		if (str === pattern) return true;

		if (pattern.endsWith("/**")) {
			const base = pattern.slice(0, -3);
			return str === base || str.startsWith(base + "/");
		}

		if (pattern.endsWith("/*")) {
			const base = pattern.slice(0, -2);
			if (!str.startsWith(base + "/")) return false;
			const rest = str.slice(base.length + 1);
			return !rest.includes("/");
		}

		if (pattern.includes("*")) {
			const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
			const regex = new RegExp("^" + escaped.replace(/\\\*/g, ".*") + "$");
			return regex.test(str);
		}

		return str.startsWith(pattern + "/") || pattern.startsWith(str + "/");
	}
}
