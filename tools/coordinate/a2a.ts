import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { A2AMessage, A2APayload } from "./types.js";

export class A2AManager {
	private messagesDir: string;
	private readMessages = new Set<string>();

	constructor(private coordDir: string) {
		this.messagesDir = path.join(coordDir, "a2a-messages");
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

		const messages: A2AMessage[] = [];

		for (const file of files.sort()) {
			if (!file.endsWith(".json")) continue;

			try {
				const content = await fs.readFile(path.join(this.messagesDir, file), "utf-8");
				const msg: A2AMessage = JSON.parse(content);

				if (since && msg.timestamp < since) continue;

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

	async markRead(messageIds: string[]): Promise<void> {
		for (const id of messageIds) {
			this.readMessages.add(id);
		}
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
