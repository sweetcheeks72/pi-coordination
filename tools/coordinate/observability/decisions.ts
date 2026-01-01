import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Decision, ActorType } from "./types.js";

export class DecisionLogger {
	constructor(
		private coordDir: string,
		private traceId: string,
	) {}

	async log(decision: Omit<Decision, "id" | "traceId" | "timestamp">): Promise<string> {
		const id = `decision-${randomUUID().slice(0, 12)}`;

		const full: Decision = {
			id,
			traceId: this.traceId,
			timestamp: Date.now(),
			...decision,
		};

		await fs.appendFile(
			path.join(this.coordDir, "decisions.jsonl"),
			JSON.stringify(full) + "\n",
		);

		return id;
	}

	async recordOutcome(
		decisionId: string,
		outcome: Decision["outcome"],
	): Promise<void> {
		const outcomeRecord = {
			type: "outcome_update",
			decisionId,
			outcome,
			timestamp: Date.now(),
		};

		await fs.appendFile(
			path.join(this.coordDir, "decisions.jsonl"),
			JSON.stringify(outcomeRecord) + "\n",
		);
	}

	async getDecisions(): Promise<Decision[]> {
		const decisionsPath = path.join(this.coordDir, "decisions.jsonl");
		try {
			const content = await fs.readFile(decisionsPath, "utf-8");
			const lines = content.trim().split("\n").filter(Boolean);
			const decisions: Decision[] = [];

			for (const line of lines) {
				const parsed = JSON.parse(line);
				if (parsed.type === "outcome_update") {
					const decision = decisions.find(d => d.id === parsed.decisionId);
					if (decision) {
						decision.outcome = parsed.outcome;
					}
				} else {
					decisions.push(parsed as Decision);
				}
			}

			return decisions;
		} catch {
			return [];
		}
	}
}
