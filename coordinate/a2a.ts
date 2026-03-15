import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { A2AMessage, A2APayload } from "./types.js";

const STALE_LOCK_THRESHOLD_MS = 30_000;

export class A2AManager {
	private messagesDir: string;
	private readMessagesPath: string;
	private readMessages = new Set<string>();

	constructor(private coordDir: string) {
		this.messagesDir = path.join(coordDir, "a2a-messages");
		this.readMessagesPath = path.join(coordDir, "a2a-read.json");
		this.loadReadMessages();
	}

	private loadReadMessages(): void {
		try {
			if (fsSync.existsSync(this.readMessagesPath)) {
				const data = fsSync.readFileSync(this.readMessagesPath, "utf-8");
				const ids = JSON.parse(data);
				if (Array.isArray(ids)) {
					this.readMessages = new Set(ids);
				}
			}
		} catch {
			// Ignore errors, start with empty set
		}
	}

	private async persistReadMessages(): Promise<void> {
		try {
			await fs.writeFile(
				this.readMessagesPath,
				JSON.stringify([...this.readMessages]),
			);
		} catch {
			// Ignore write errors
		}
	}

	/**
	 * Acquire a file lock for atomic read-state operations.
	 * Uses O_CREAT | O_EXCL to atomically create the lock file.
	 * Retries with exponential backoff; removes stale locks older than threshold.
	 */
	private async withLock<T>(fn: () => Promise<T>): Promise<T> {
		const lockPath = path.join(this.coordDir, "a2a-read.lock");
		const maxRetries = 50;

		try {
			fsSync.mkdirSync(this.coordDir, { recursive: true });
		} catch {}

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
					if (i === maxRetries - 1) throw new Error("Failed to acquire a2a-read lock");
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

	/**
	 * Load read message IDs from disk (used inside lock for fresh state).
	 */
	private loadReadMessagesFromDisk(): Set<string> {
		try {
			if (fsSync.existsSync(this.readMessagesPath)) {
				const data = fsSync.readFileSync(this.readMessagesPath, "utf-8");
				const ids = JSON.parse(data);
				if (Array.isArray(ids)) {
					return new Set(ids);
				}
			}
		} catch {
			// Ignore errors, return empty set
		}
		return new Set<string>();
	}

	async initialize(): Promise<void> {
		await fs.mkdir(this.messagesDir, { recursive: true });
	}

	async sendMessage(
		from: string,
		to: string | "all",
		payload: A2APayload,
		inReplyTo?: string,
	): Promise<string> {
		await this.initialize();

		const id = randomUUID();
		const timestamp = Date.now();

		const message: A2AMessage = {
			id,
			from,
			to,
			timestamp,
			type: payload.type,
			payload,
			inReplyTo,
		};

		const filename = `${timestamp}-${id}.json`;
		await fs.writeFile(
			path.join(this.messagesDir, filename),
			JSON.stringify(message, null, 2),
		);

		return id;
	}

	async checkMessages(agentId: string, since?: number): Promise<A2AMessage[]> {
		let files: string[];
		try {
			files = await fs.readdir(this.messagesDir);
		} catch {
			return [];
		}

		// Read all candidate message files before acquiring the lock
		const candidates: A2AMessage[] = [];
		for (const file of files.sort()) {
			if (!file.endsWith(".json")) continue;
			try {
				const content = await fs.readFile(path.join(this.messagesDir, file), "utf-8");
				const msg: A2AMessage = JSON.parse(content);
				if (since && msg.timestamp < since) continue;
				if (msg.to === agentId || msg.to === "all") {
					candidates.push(msg);
				}
			} catch {
				continue;
			}
		}

		// Atomically: read on-disk read-state → filter unread → mark as read → persist → return
		// The lock ensures no two callers can both see the same message as unread simultaneously.
		return this.withLock(async () => {
			const onDiskRead = this.loadReadMessagesFromDisk();

			const unread = candidates.filter((msg) => !onDiskRead.has(msg.id));

			for (const msg of unread) {
				onDiskRead.add(msg.id);
				this.readMessages.add(msg.id);
			}

			if (unread.length > 0) {
				await fs.writeFile(
					this.readMessagesPath,
					JSON.stringify([...onDiskRead]),
				);
			}

			return unread;
		});
	}

	async markRead(messageIds: string[]): Promise<void> {
		await this.withLock(async () => {
			// Re-read on-disk state inside the lock to avoid clobbering concurrent writers
			const onDiskRead = this.loadReadMessagesFromDisk();
			for (const id of messageIds) {
				this.readMessages.add(id);
				onDiskRead.add(id);
			}
			await fs.writeFile(
				this.readMessagesPath,
				JSON.stringify([...onDiskRead]),
			);
		});
	}

	async getUnreadCount(agentId: string): Promise<number> {
		const messages = await this.checkMessages(agentId);
		return messages.length;
	}

	async findReplies(messageId: string): Promise<A2AMessage[]> {
		let files: string[];
		try {
			files = await fs.readdir(this.messagesDir);
		} catch {
			return [];
		}

		const replies: A2AMessage[] = [];

		for (const file of files) {
			if (!file.endsWith(".json")) continue;

			try {
				const content = await fs.readFile(path.join(this.messagesDir, file), "utf-8");
				const msg: A2AMessage = JSON.parse(content);

				if (msg.inReplyTo === messageId) {
					replies.push(msg);
				}
			} catch {
				continue;
			}
		}

		return replies;
	}

	async requestFileRelease(
		from: string,
		to: string,
		file: string,
		reason: string,
		urgency: "low" | "medium" | "high" = "medium",
	): Promise<string> {
		return this.sendMessage(from, to, {
			type: "file_release_request",
			file,
			reason,
			urgency,
		});
	}

	async respondToFileRequest(
		from: string,
		to: string,
		file: string,
		granted: boolean,
		inReplyTo: string,
		eta?: number,
		reason?: string,
	): Promise<string> {
		return this.sendMessage(
			from,
			to,
			{
				type: "file_release_response",
				file,
				granted,
				eta,
				reason,
			},
			inReplyTo,
		);
	}

	async shareDiscovery(
		from: string,
		topic: string,
		content: string,
		importance: "fyi" | "important" | "critical" = "fyi",
	): Promise<string> {
		return this.sendMessage(from, "all", {
			type: "discovery",
			topic,
			content,
			importance,
		});
	}

	async broadcastCompletion(
		from: string,
		taskId: string,
		filesModified: string[],
	): Promise<string> {
		return this.sendMessage(from, "all", {
			type: "completion_notice",
			taskId,
			filesModified,
		});
	}

	checkMessagesSync(agentId: string): A2AMessage[] {
		let files: string[];
		try {
			files = fsSync.readdirSync(this.messagesDir);
		} catch {
			return [];
		}

		const messages: A2AMessage[] = [];

		for (const file of files.sort()) {
			if (!file.endsWith(".json")) continue;

			try {
				const content = fsSync.readFileSync(path.join(this.messagesDir, file), "utf-8");
				const msg: A2AMessage = JSON.parse(content);

				if (msg.to === agentId || msg.to === "all") {
					if (!this.readMessages.has(msg.id)) {
						messages.push(msg);
					}
				}
			} catch {
				continue;
			}
		}

		return messages;
	}
}
