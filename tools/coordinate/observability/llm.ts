import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { LlmInteraction } from "./types.js";

export class LlmLogger {
	constructor(
		private coordDir: string,
		private traceId: string,
	) {}

	async log(entry: Omit<LlmInteraction, "traceId" | "id"> & { id?: string }): Promise<LlmInteraction> {
		const record: LlmInteraction = {
			id: entry.id || `llm-${randomUUID().slice(0, 12)}`,
			traceId: this.traceId,
			...entry,
		};

		await this.appendJsonl(path.join(this.coordDir, "traces", "llm.jsonl"), record);
		return record;
	}

	async writePayload(
		spanId: string,
		type: "request" | "response",
		payload: unknown,
	): Promise<string> {
		const dir = path.join(this.coordDir, "traces", "llm", spanId);
		await fs.mkdir(dir, { recursive: true });
		const filePath = path.join(dir, `${type}.json`);
		await fs.writeFile(filePath, JSON.stringify(payload));
		return filePath;
	}

	private async appendJsonl(filePath: string, record: unknown): Promise<void> {
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.appendFile(filePath, JSON.stringify(record) + "\n");
	}
}
