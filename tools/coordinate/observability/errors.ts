import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PipelinePhase } from "../types.js";
import type { StructuredError } from "./types.js";

export class ErrorTracker {
	constructor(
		private coordDir: string,
		private traceId: string,
	) {}

	async capture(
		error: Error | unknown,
		context: {
			category: StructuredError["category"];
			severity: StructuredError["severity"];
			actor: string;
			phase: PipelinePhase;
			spanId: string;
			recoverable?: boolean;
			relatedWorkerId?: string;
			relatedContractId?: string;
			relatedFile?: string;
		},
	): Promise<string> {
		const id = `error-${randomUUID().slice(0, 12)}`;

		const structured: StructuredError = {
			id,
			traceId: this.traceId,
			spanId: context.spanId,
			timestamp: Date.now(),
			category: context.category,
			severity: context.severity,
			message: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
			actor: context.actor,
			phase: context.phase,
			recoverable: context.recoverable ?? false,
			relatedWorkerId: context.relatedWorkerId,
			relatedContractId: context.relatedContractId,
			relatedFile: context.relatedFile,
			originalError: error,
		};

		await fs.appendFile(
			path.join(this.coordDir, "errors.jsonl"),
			JSON.stringify(structured) + "\n",
		);

		return id;
	}

	async markRecovery(
		errorId: string,
		success: boolean,
	): Promise<void> {
		const recoveryRecord = {
			type: "recovery_update",
			errorId,
			recoveryAttempted: true,
			recoverySucceeded: success,
			timestamp: Date.now(),
		};

		await fs.appendFile(
			path.join(this.coordDir, "errors.jsonl"),
			JSON.stringify(recoveryRecord) + "\n",
		);
	}
}
